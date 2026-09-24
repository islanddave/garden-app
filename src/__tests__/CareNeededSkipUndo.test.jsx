// BUG-TODAYSKIPNOUNDO-001 — Skip on the Today care row gets the visible undo logging always had.
// No jest-dom (L-182): role/attr/text + toBe/toBeTruthy/toBeNull only.
//
// Same mock seam as CareNeeded.test.jsx EXCEPT the toast layer: this file renders the REAL
// ToastProvider, because the claim under test is that an Undo a person can see and tap appears, and
// that tapping it runs the handler — a mocked showUndo proves only that a function was called.
import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

const { fetchMock, getTokenMock, prefsMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
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
// readTodaySkipped stays real — the date rule is part of what the merge cases below exercise.
vi.mock('../lib/notificationPrefsClient.js', async (orig) => ({
  ...(await orig()),
  fetchNotificationPrefs: prefsMock.fetchNotificationPrefs,
  saveTodaySkipped: prefsMock.saveTodaySkipped,
}))

import CareNeeded from '../components/today/CareNeeded.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

const plan = () => ({
  hydrology: { tomorrow_precip_in: 0.05, tomorrow_pop: 10 },
  rain_skipped: [],
  water_due: [
    { id: 'p1', name: 'Bhut Jolokia', crop: 'pepper', project: 'Peppers', project_id: 'prP', overdue_by: 3, in_ground: false },
    { id: 'p2', name: 'Habanero',     crop: 'pepper', project: 'Peppers', project_id: 'prP', overdue_by: 1, in_ground: false },
  ],
  no_history: [], fertilize: [], pest: [], cold: [], dormant: [],
})

const todayISO = () => {
  const d = new Date()
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}
const stored = () => JSON.parse(localStorage.getItem('today-skipped:' + todayISO()) || '[]').sort()
const skip = (name) => fireEvent.click(screen.getByRole('button', { name: new RegExp('Skip ' + name + ' today', 'i') }))
const undo = () => fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
// The toast itself — NOT getByText: CareNeeded's sr-only live region announces the same sentence, so
// a bare text query matches twice, and matching the live region alone would pass with no toast at all.
const toastText = () => screen.getByRole('button', { name: 'Undo' }).closest('[role="status"]').textContent
const serverHas = (...keys) => prefsMock.fetchNotificationPrefs.mockResolvedValue({ today_skipped: { date: todayISO(), keys } })

// The toast layer is the app ROOT; the list is one route under it. Unmounting the list while the
// provider stays up is exactly what tapping into a planting does in the app.
function Host({ p }) {
  const [shown, setShown] = useState(true)
  return (
    <ToastProvider>
      {shown && <CareNeeded plan={p} />}
      <button type="button" onClick={() => setShown(s => !s)}>toggle list</button>
    </ToastProvider>
  )
}
const mountHost = async (p = plan()) => { await act(async () => { render(<Host p={p} />) }) }
const toggleList = async () => { await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'toggle list' })) }) }

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation((path) =>
    (path === '/api/plants' || path === '/api/locations/with-path') ? Promise.resolve([]) : Promise.resolve({ id: 'ev-new' }))
  prefsMock.fetchNotificationPrefs.mockReset(); prefsMock.fetchNotificationPrefs.mockResolvedValue(null)
  prefsMock.saveTodaySkipped.mockReset(); prefsMock.saveTodaySkipped.mockResolvedValue(null)
  localStorage.clear(); sessionStorage.clear()
})

describe('BUG-TODAYSKIPNOUNDO-001 — Skip has a visible undo', () => {
  // Mutation: delete the toast.showUndo call from skipRow — red here (no toast text, no Undo button),
  // which is the state dev shipped in: the only feedback was an sr-only live region.
  it('a skip puts an Undo on screen that names the plant', async () => {
    await mountHost()
    skip('Habanero')
    expect(screen.queryByText('Habanero')).toBeNull()
    expect(toastText()).toContain('Skipped Habanero for today')
  })

  it('Undo brings the row back and takes it out of the stored set', async () => {
    await mountHost()
    skip('Habanero')
    expect(stored()).toEqual(['p2:water_due'])
    undo()
    expect(screen.getByText('Habanero')).toBeTruthy()
    expect(stored()).toEqual([])
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()   // the toast cleared
  })

  // The column is a snapshot, so the undo must send what is LEFT, not the key it removed.
  // Mutations: send `keys: [row.key]` (a delta) -> last sync is ['p1:water_due'], red; drop the sync ->
  // last sync is the skip's two-key set, red.
  it('Undo re-syncs the whole remaining set to the server', async () => {
    await mountHost()
    skip('Habanero')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))   // a separate toast for the next skip
    skip('Bhut Jolokia')
    undo()
    expect(screen.getByText('Bhut Jolokia')).toBeTruthy()
    expect(screen.queryByText('Habanero')).toBeNull()
    expect(stored()).toEqual(['p2:water_due'])
    const last = prefsMock.saveTodaySkipped.mock.calls.at(-1)[0]
    expect(last.keys).toEqual(['p2:water_due'])
    expect(last.date).toBe(todayISO())
  })

  // Mutation: drop `group` from the skip toast -> two toasts, no "2 plants" line, red.
  it('a run of skips coalesces into one toast whose Undo restores every plant', async () => {
    await mountHost()
    skip('Habanero')
    skip('Bhut Jolokia')
    expect(screen.getAllByRole('button', { name: 'Undo' }).length).toBe(1)
    expect(toastText()).toContain('Skipped 2 plants for today')
    undo()
    expect(screen.getByText('Habanero')).toBeTruthy()
    expect(screen.getByText('Bhut Jolokia')).toBeTruthy()
    expect(stored()).toEqual([])
  })

  // The toast outlives the list: skip, tap into a planting, tap Undo. Mutation: do the local write
  // inside the setSkipped updater instead of directly (the skipRow shape) — the updater never runs on
  // an unmounted component, the key stays stored, and the row is still hidden on return: red.
  it('Undo still lands after the list has unmounted', async () => {
    await mountHost()
    skip('Habanero')
    await toggleList()                                  // list gone, toast still up
    expect(screen.queryByText('Bhut Jolokia')).toBeNull()
    undo()
    expect(stored()).toEqual([])
    await toggleList()                                  // back to Today
    expect(screen.getByText('Habanero')).toBeTruthy()
  })
})

describe('BUG-TODAYSKIPNOUNDO-001 — the server merge after an Undo', () => {
  // The case the old union-merge note warned about. The server still holds the skip (the Undo's sync
  // failed, lost a race, or has not landed) and Today remounts: the union must NOT re-hide the plant.
  // Mutation: remove the readUnskipped() veto from the merge -> Habanero vanishes again, red.
  it('a stale server snapshot cannot re-hide a plant Dave brought back', async () => {
    await mountHost()
    skip('Habanero')
    undo()
    await toggleList()
    serverHas('p2:water_due')
    await toggleList()
    expect(prefsMock.fetchNotificationPrefs).toHaveBeenCalled()
    expect(screen.getByText('Habanero')).toBeTruthy()
    expect(stored()).toEqual([])
  })

  // Non-vacuity partner for the case above: the veto must be scoped to keys undone HERE. A skip made
  // on another device and never undone on this one still has to arrive. Mutation: veto every remote
  // key (or drop the union) -> Habanero stays visible, red.
  it('a server skip never undone on this device still hides the row', async () => {
    serverHas('p2:water_due')
    await mountHost()
    expect(screen.queryByText('Habanero')).toBeNull()
    expect(screen.getByText('Bhut Jolokia')).toBeTruthy()
    expect(stored()).toEqual(['p2:water_due'])
  })

  // Skip -> Undo -> Skip again is a fresh decision, so the veto must lift. Modelled by losing the
  // local set while the server keeps it (storage eviction, or the household lens's second list
  // writing its own set over this one) and remounting. Mutation: drop the veto lift in skipRow ->
  // the stale veto wins and the plant Dave re-skipped comes back, red.
  it('skipping again after an Undo is honoured by the merge', async () => {
    await mountHost()
    skip('Habanero')
    undo()
    skip('Habanero')
    await toggleList()
    localStorage.removeItem('today-skipped:' + todayISO())
    serverHas('p2:water_due')
    await toggleList()
    expect(screen.queryByText('Habanero')).toBeNull()
    expect(screen.getByText('Bhut Jolokia')).toBeTruthy()
  })
})

describe('BUG-TODAYSKIPNOUNDO-001 — the Skip target', () => {
  // jsdom cannot lay anything out, so this pins the declared box only; the rendered geometry at
  // Dave's 426px viewport is measured in real Chrome (tests/harness/careskip.*, lane report).
  // Mutation: width back to 42 or the margin removed -> red.
  it('is 48px wide with 8px of dead space before the next control', async () => {
    await mountHost()
    const btn = screen.getByRole('button', { name: /Skip Habanero today/i })
    expect(btn.style.width).toBe('48px')
    expect(btn.style.marginRight).toBe('8px')
    expect(btn.style.minHeight).toBe('48px')
  })
})
