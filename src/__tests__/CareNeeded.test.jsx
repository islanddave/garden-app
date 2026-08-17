// Slice 7 (V4-THEME-001) CareNeeded interaction tests. No jest-dom (L-182): role/attr/text +
// toBe/toBeTruthy/toBeNull only. Mocks: react-router Link, useApiFetch, ToastContext.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

const { fetchMock, toastMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  toastMock: { show: vi.fn(), showUndo: vi.fn(), dismiss: vi.fn() },
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock }) }))
vi.mock('../context/ToastContext.jsx', () => ({ useOptionalToast: () => toastMock }))

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

beforeEach(() => {
  fetchMock.mockReset(); toastMock.show.mockReset(); toastMock.showUndo.mockReset()
  // V4-TODAYLOC-001: enrichment endpoints (mount) return [] so grouping stays project-proxy;
  // event writes return a created id.
  fetchMock.mockImplementation((path) =>
    (path === '/api/plants' || path === '/api/locations/with-path')
      ? Promise.resolve([])
      : Promise.resolve({ id: 'ev-new' }))
  sessionStorage.clear()
})

describe('CareNeeded — Slice 7', () => {
  it('renders location-grouped need rows with a dominant Log target (default By location)', () => {
    render(<CareNeeded plan={plan()} />)
    expect(screen.getByText('Needs care today')).toBeTruthy()
    expect(screen.getByText('Bhut Jolokia')).toBeTruthy()
    expect(screen.getByRole('group', { name: /Group by/i })).toBeTruthy()
    const logBtns = screen.getAllByRole('button', { name: /^Log Water for/i })
    expect(logBtns.length).toBe(2)
  })

  it('one-tap log POSTs the mapped event, drops the row, and offers undo', async () => {
    render(<CareNeeded plan={plan()} />)
    fireEvent.click(screen.getByRole('button', { name: /Log Water for Bhut Jolokia/i }))
    await waitFor(() => expect(screen.queryByText('Bhut Jolokia')).toBeNull())
    const [path, opts] = fetchMock.mock.calls.find(c => c[0] === '/api/events')
    expect(path).toBe('/api/events')
    expect(opts.method).toBe('POST')
    const body = JSON.parse(opts.body)
    expect(body.event_type).toBe('watering')
    expect(body.plant_id).toBe('p1')
    expect(body.project_id).toBe('prP')
    expect(toastMock.showUndo).toHaveBeenCalledTimes(1)
  })

  it('on write failure the row stays and an error toast shows (no fade-and-forget)', async () => {
    // Fail the WRITE specifically. This used to be a bare mockRejectedValueOnce, which relied on the
    // mount-time enrichment fetches being deferred by a microtask so the events POST was the first
    // call to land; the plants read now goes through useCachedFetch, whose no-sub PLAIN branch calls
    // fetch synchronously, and the once-rejection was being spent on /api/plants instead.
    fetchMock.mockImplementation((path) =>
      path === '/api/events' ? Promise.reject(new Error('boom')) : Promise.resolve([]))
    render(<CareNeeded plan={plan()} />)
    fireEvent.click(screen.getByRole('button', { name: /Log Water for Bhut Jolokia/i }))
    await waitFor(() => expect(toastMock.show).toHaveBeenCalledTimes(1))
    expect(screen.getByText('Bhut Jolokia')).toBeTruthy()
  })

  it('skip suppresses a row for today without writing an event', () => {
    render(<CareNeeded plan={plan()} />)
    fireEvent.click(screen.getByRole('button', { name: /Skip Habanero today/i }))
    expect(screen.queryByText('Habanero')).toBeNull()
    // Assert the named behaviour — no EVENT is written. A blanket not.toHaveBeenCalled() also
    // asserted that no mount-time enrichment read had fired yet, which was only ever true because
    // those reads were microtask-deferred; that is timing, not the contract this test is about.
    expect(fetchMock.mock.calls.some(c => c[0] === '/api/events')).toBe(false)
  })

  it('shows the all-clear empty state when nothing needs care', () => {
    render(<CareNeeded plan={{ water_due: [], no_history: [], fertilize: [], pest: [], cold: [], dormant: [], rain_skipped: [] }} />)
    expect(screen.getByText(/All caught up/i)).toBeTruthy()
  })

  it('primary bulk chip tap fans out one POST per row directly — no confirm sheet — with aggregate undo', async () => {
    render(<CareNeeded plan={plan()} />)
    fireEvent.click(screen.getByRole('button', { name: /^Log all watering \(2\)$/i }))
    // Fires immediately: no dialog is opened by the primary tap.
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(fetchMock.mock.calls.filter(c => c[0] === '/api/events').length).toBe(2))
    await waitFor(() => expect(screen.queryByText('Bhut Jolokia')).toBeNull())
    await waitFor(() => expect(toastMock.showUndo).toHaveBeenCalled())
  })

  it('secondary "choose" control still opens the scoped sheet and logs only the checked subset', async () => {
    render(<CareNeeded plan={plan()} />)
    fireEvent.click(screen.getByRole('button', { name: /Choose which watering to log/i }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toBeTruthy()
    // Deselect one of the two pre-checked rows, then log the subset.
    const checkboxes = screen.getAllByRole('checkbox')
    expect(checkboxes.length).toBe(2)
    fireEvent.click(checkboxes[0])
    fireEvent.click(screen.getByRole('button', { name: /^Log all \(1\)/i }))
    await waitFor(() => expect(fetchMock.mock.calls.filter(c => c[0] === '/api/events').length).toBe(1))
    await waitFor(() => expect(toastMock.showUndo).toHaveBeenCalled())
  })

  // ── WS-A5: undo must await the DELETE; a failed undo keeps the row hidden (no phantom re-log) ──
  it('single undo awaits the DELETE then re-surfaces the row', async () => {
    render(<CareNeeded plan={plan()} />)
    fireEvent.click(screen.getByRole('button', { name: /Log Water for Bhut Jolokia/i }))
    await waitFor(() => expect(screen.queryByText('Bhut Jolokia')).toBeNull())
    const { onUndo } = toastMock.showUndo.mock.calls[0][0]
    await act(async () => { await onUndo() })
    expect(fetchMock.mock.calls.some(c => c[0] === '/api/events/ev-new' && c[1]?.method === 'DELETE')).toBe(true)
    await waitFor(() => expect(screen.getByText('Bhut Jolokia')).toBeTruthy())
  })

  it('single undo failure keeps the row hidden + error toast (no re-surface -> no duplicate)', async () => {
    render(<CareNeeded plan={plan()} />)
    fireEvent.click(screen.getByRole('button', { name: /Log Water for Bhut Jolokia/i }))
    await waitFor(() => expect(screen.queryByText('Bhut Jolokia')).toBeNull())
    const { onUndo } = toastMock.showUndo.mock.calls[0][0]
    toastMock.show.mockClear()
    fetchMock.mockImplementationOnce(() => Promise.reject(Object.assign(new Error('down'), { status: 500 })))
    await act(async () => { await onUndo() })
    expect(toastMock.show).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Bhut Jolokia')).toBeNull()
  })

  it('bulk undo awaits all DELETEs then re-surfaces the rows', async () => {
    let n = 0
    fetchMock.mockImplementation((path) => {
      if (path === '/api/plants' || path === '/api/locations/with-path') return Promise.resolve([])
      if (path === '/api/events') return Promise.resolve({ id: 'ev-' + (++n) })
      return Promise.resolve({ undone: true })
    })
    render(<CareNeeded plan={plan()} />)
    fireEvent.click(screen.getByRole('button', { name: /^Log all watering \(2\)$/i }))
    await waitFor(() => expect(screen.queryByText('Bhut Jolokia')).toBeNull())
    const { onUndo } = toastMock.showUndo.mock.calls[0][0]
    await act(async () => { await onUndo() })
    const deletes = fetchMock.mock.calls.filter(c => c[0].startsWith('/api/events/') && c[1]?.method === 'DELETE')
    expect(deletes.length).toBe(2)
    await waitFor(() => expect(screen.getByText('Bhut Jolokia')).toBeTruthy())
  })

  it('bulk undo failure keeps rows hidden + error toast', async () => {
    let n = 0
    fetchMock.mockImplementation((path, opts) => {
      if (path === '/api/plants' || path === '/api/locations/with-path') return Promise.resolve([])
      if (path === '/api/events' && (!opts || opts.method === 'POST')) return Promise.resolve({ id: 'ev-' + (++n) })
      return Promise.reject(Object.assign(new Error('down'), { status: 500 }))
    })
    render(<CareNeeded plan={plan()} />)
    fireEvent.click(screen.getByRole('button', { name: /^Log all watering \(2\)$/i }))
    await waitFor(() => expect(screen.queryByText('Bhut Jolokia')).toBeNull())
    toastMock.show.mockClear()
    const { onUndo } = toastMock.showUndo.mock.calls[0][0]
    await act(async () => { await onUndo() })
    expect(toastMock.show).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Bhut Jolokia')).toBeNull()
  })
})
