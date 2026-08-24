// BUG-TODAYCAREREORDER-001 (BD-036) — COMPONENT-level guard. The pure-function tests in
// careNeededPinnedOrder.test.js prove groupRows honours a pinned order; they do NOT prove CareNeeded
// passes one. Verified by mutation: deleting `pinnedOrder` from the component's groupRows call left
// all 67 of those tests green. This file is the one that fails, so it must stay behavioural — assert
// on rendered group headers, never on the component's internals.
//
// No jest-dom (L-182): role/attr/text + toBe/toBeTruthy/toBeNull only.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

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

// Drive Rows: 4 rows @ overdue 1 => severity 8, leads and auto-expands.
// Bag Area:   5 rows @ overdue 0 => severity 5.
// Logging 3 Drive rows drops it to 2, so an unpinned sort puts Bag Area first — the exact motion
// Dave hit: he is tapping inside the lead group, and the lead group is the one that moves.
const w = (id, name, project, projectId, overdue) => ({
  id, name, crop: 'pepper', project, project_id: projectId, overdue_by: overdue, in_ground: false,
})
const plan = () => ({
  hydrology: { tomorrow_precip_in: 0.05, tomorrow_pop: 10 },
  rain_skipped: [],
  water_due: [
    w('d1', 'Drive One', 'Drive Rows', 'prD', 1),
    w('d2', 'Drive Two', 'Drive Rows', 'prD', 1),
    w('d3', 'Drive Three', 'Drive Rows', 'prD', 1),
    w('d4', 'Drive Four', 'Drive Rows', 'prD', 1),
    w('b1', 'Bag One', 'Bag Area', 'prB', 0),
    w('b2', 'Bag Two', 'Bag Area', 'prB', 0),
    w('b3', 'Bag Three', 'Bag Area', 'prB', 0),
    w('b4', 'Bag Four', 'Bag Area', 'prB', 0),
    w('b5', 'Bag Five', 'Bag Area', 'prB', 0),
  ],
  no_history: [], fertilize: [], pest: [], cold: [], dormant: [],
})

// Group headers are the only buttons carrying aria-expanded. Their first span is the label.
// queryAll, not getAll: getAll throws on zero matches, and "every row logged" legitimately renders
// the all-caught-up empty state with no headers at all.
const headerLabels = () =>
  screen.queryAllByRole('button')
    .filter(b => b.getAttribute('aria-expanded') !== null)
    .map(b => b.querySelector('span').textContent)

beforeEach(() => {
  fetchMock.mockReset(); toastMock.show.mockReset(); toastMock.showUndo.mockReset()
  fetchMock.mockImplementation((path) =>
    (path === '/api/plants' || path === '/api/locations/with-path')
      ? Promise.resolve([])
      : Promise.resolve({ id: 'ev-new' }))
  sessionStorage.clear()
  localStorage.clear()
})
afterEach(cleanup)

describe('BD-036 — CareNeeded group order survives logging', () => {
  it('fixture is valid: Drive Rows leads on arrival', async () => {
    render(<CareNeeded plan={plan()} />)
    await waitFor(() => expect(headerLabels().length).toBe(2))
    expect(headerLabels()).toEqual(['Drive Rows', 'Bag Area'])
  })

  it('logging three rows out of the lead group does NOT reorder the page', async () => {
    render(<CareNeeded plan={plan()} />)
    await waitFor(() => expect(headerLabels().length).toBe(2))
    const before = headerLabels()

    for (const name of ['Drive One', 'Drive Two', 'Drive Three']) {
      fireEvent.click(screen.getByRole('button', { name: new RegExp('Log Water for ' + name, 'i') }))
      await waitFor(() => expect(screen.queryByText(name)).toBeNull())
      // Assert after EVERY tap, not just at the end: the mis-tap happens on the next tap, so an
      // order that is only correct once the drain finishes would still have moved under his finger.
      expect(headerLabels()).toEqual(before)
    }

    expect(headerLabels()).toEqual(['Drive Rows', 'Bag Area'])
    // And the group genuinely drained — otherwise the order held because nothing changed.
    expect(screen.queryByText('Drive Four')).toBeTruthy()
    expect(screen.queryByText('Drive One')).toBeNull()
  })

  it('a bulk log of every watering row does not reorder the surviving groups', async () => {
    render(<CareNeeded plan={plan()} />)
    await waitFor(() => expect(headerLabels().length).toBe(2))
    fireEvent.click(screen.getByRole('button', { name: /^Log all watering \(9\)$/i }))
    await waitFor(() => expect(fetchMock.mock.calls.filter(c => c[0] === '/api/events').length).toBe(9))
    await waitFor(() => expect(screen.queryByText('Drive One')).toBeNull())
    expect(headerLabels()).toEqual([])
  })

  it('switching group mode DOES re-sort — the pin freezes logging, not the user', async () => {
    render(<CareNeeded plan={plan()} />)
    await waitFor(() => expect(headerLabels().length).toBe(2))
    fireEvent.click(screen.getByRole('button', { name: /By type/i }))
    await waitFor(() => expect(headerLabels()).toEqual(['Water']))
  })
})
