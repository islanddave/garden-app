// BUG-RUNBULKPARTIALUNDO-001 — the Today bulk buttons ("Log all watering (n)", "Water all n in X").
// No jest-dom (L-182): role/attr/text + toBe/toBeTruthy/toBeNull only. Same mock seam as
// CareNeeded.test.jsx — react-router Link, useApiFetch, ToastContext, notificationPrefsClient.
//
// Scope, stated because the ticket named more: the bulk still fans out single POST /api/events. The
// batch endpoint was examined and NOT adopted (see the WHY NOT note above candidatesFor in
// CareNeeded.jsx). What this file pins is the part that did not need it: a partial failure keeps
// the undo for what landed, and a same-batch double fire runs the fan-out once.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

const { fetchMock, toastMock, getTokenMock, prefsMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  toastMock: { show: vi.fn(), showUndo: vi.fn(), dismiss: vi.fn() },
  getTokenMock: vi.fn(async () => 'tok'),
  prefsMock: {
    fetchNotificationPrefs: vi.fn(async () => null),
    saveTodaySkipped: vi.fn(async () => null),
  },
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock, getToken: getTokenMock }) }))
vi.mock('../context/ToastContext.jsx', () => ({ useOptionalToast: () => toastMock }))
vi.mock('../lib/notificationPrefsClient.js', async (orig) => ({
  ...(await orig()),
  fetchNotificationPrefs: prefsMock.fetchNotificationPrefs,
  saveTodaySkipped: prefsMock.saveTodaySkipped,
}))

import CareNeeded from '../components/today/CareNeeded.jsx'

const plan = () => ({
  hydrology: { tomorrow_precip_in: 0.05, tomorrow_pop: 10 },
  rain_skipped: [],
  water_due: [
    { id: 'p1', name: 'Bhut Jolokia', crop: 'pepper', project: 'Peppers', project_id: 'prP', overdue_by: 3, in_ground: false },
    { id: 'p2', name: 'Habanero',     crop: 'pepper', project: 'Peppers', project_id: 'prP', overdue_by: 1, in_ground: false },
  ],
  no_history: [], fertilize: [], pest: [], cold: [], dormant: [],
})

const posts = () => fetchMock.mock.calls.filter(c => c[0] === '/api/events' && c[1]?.method === 'POST')
const deletes = () => fetchMock.mock.calls.filter(c => String(c[0]).startsWith('/api/events/') && c[1]?.method === 'DELETE')
// POSTs for the named plant ids reject; every other write succeeds with a fresh id.
const failPostsFor = (...ids) => {
  let n = 0
  fetchMock.mockImplementation((path, opts) => {
    if (path === '/api/plants' || path === '/api/locations/with-path') return Promise.resolve([])
    if (path === '/api/events' && opts?.method === 'POST') {
      return ids.includes(JSON.parse(opts.body).plant_id)
        ? Promise.reject(Object.assign(new Error('down'), { status: 503 }))
        : Promise.resolve({ id: 'ev-' + (++n) })
    }
    return Promise.resolve({ undone: true })
  })
}

beforeEach(() => {
  fetchMock.mockReset(); toastMock.show.mockReset(); toastMock.showUndo.mockReset()
  failPostsFor()
  sessionStorage.clear(); localStorage.clear()
})

describe('BUG-RUNBULKPARTIALUNDO-001 — a partial failure keeps the undo', () => {
  // The defect: `if (failures) toast.show(error) else toast.showUndo(...)`. One failed row and the
  // rows that DID log had no way back. Mutation: restore that branch -> showUndo never called, red.
  it('offers undo for the rows that landed, and keeps the failed row on the list to retry', async () => {
    failPostsFor('p2')
    render(<CareNeeded plan={plan()} />)
    fireEvent.click(screen.getByRole('button', { name: /^Log all watering \(2\)$/i }))
    await waitFor(() => expect(toastMock.showUndo).toHaveBeenCalledTimes(1))
    expect(toastMock.showUndo.mock.calls[0][0].message).toBe('Logged 1 — 1 failed')
    expect(toastMock.show).not.toHaveBeenCalled()
    expect(screen.queryByText('Bhut Jolokia')).toBeNull()      // landed -> gone
    expect(screen.getByText('Habanero')).toBeTruthy()          // failed -> still there to retry
    await act(async () => { await toastMock.showUndo.mock.calls[0][0].onUndo() })
    expect(deletes().map(c => c[0])).toEqual(['/api/events/ev-1'])   // only the one that exists
    expect(screen.getByText('Bhut Jolokia')).toBeTruthy()
  })

  // Nothing landed = nothing to undo; an Undo button that does nothing would be a false promise.
  // Mutation: offer the undo unconditionally -> showUndo called with an empty run, red.
  it('a run where nothing landed keeps the plain error toast and offers no undo', async () => {
    failPostsFor('p1', 'p2')
    render(<CareNeeded plan={plan()} />)
    fireEvent.click(screen.getByRole('button', { name: /^Log all watering \(2\)$/i }))
    await waitFor(() => expect(toastMock.show).toHaveBeenCalledTimes(1))
    expect(toastMock.show.mock.calls[0][0]).toEqual({ message: 'Logged 0 — 2 failed', tone: 'error' })
    expect(toastMock.showUndo).not.toHaveBeenCalled()
    expect(screen.getByText('Bhut Jolokia')).toBeTruthy()
    expect(screen.getByText('Habanero')).toBeTruthy()
  })
})

describe('BUG-RUNBULKPARTIALUNDO-001 — one fan-out at a time', () => {
  // Both taps go inside ONE act() on purpose (same reasoning as CareNeededMoistureCheck's guard test):
  // React has not flushed, so `disabled` is not on either button yet and jsdom delivers both clicks.
  // The obvious version — tap, await, tap the now-disabled button — passes with no guard at all.
  // Mutation: delete the bulkInFlightRef early return -> 4 POSTs (each row twice), red.
  it('the pill and a section header tapped in one React batch log each row once', async () => {
    render(<CareNeeded plan={plan()} />)
    const pill = screen.getByRole('button', { name: /^Log all watering \(2\)$/i })
    const section = screen.getByRole('button', { name: /^Water all 2 in /i })
    expect(pill.disabled).toBe(false)
    expect(section.disabled).toBe(false)
    await act(async () => { pill.click(); section.click() })
    await waitFor(() => expect(toastMock.showUndo).toHaveBeenCalledTimes(1))
    expect(posts().length).toBe(2)
    expect(posts().map(c => JSON.parse(c[1].body).plant_id).sort()).toEqual(['p1', 'p2'])
  })

  // The guard must release: a second, separate bulk after the first finished still runs.
  // Mutation: never reset the ref (drop the finally) -> the second run posts nothing, red.
  it('releases after the run, so the next bulk still works', async () => {
    const p = plan()
    p.fertilize = [{ id: 'p3', name: 'Sungold', crop: 'tomato', project: 'Peppers', project_id: 'prP', item: 'MG', apply: 'half strength' }]
    render(<CareNeeded plan={p} />)
    fireEvent.click(screen.getByRole('button', { name: /^Log all watering \(2\)$/i }))
    await waitFor(() => expect(toastMock.showUndo).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: /^Log all feeding \(1\)$/i }))
    await waitFor(() => expect(toastMock.showUndo).toHaveBeenCalledTimes(2))
    expect(posts().length).toBe(3)
    expect(JSON.parse(posts()[2][1].body).event_type).toBe('fertilizing')
  })
})
