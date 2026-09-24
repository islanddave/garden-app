// BUG-TODAYSKIPNOUNDO-001 — Skip on the Today care row gets the visible undo logging always had.
// No jest-dom (L-182): role/attr/text + toBe/toBeTruthy/toBeNull only.
//
// Same mock seam as CareNeeded.test.jsx EXCEPT the toast layer: this file renders the REAL
// ToastProvider, because the claim under test is that an Undo a person can see and tap appears, and
// that tapping it runs the handler — a mocked showUndo proves only that a function was called.
import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

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
// Async: Undo's server sync is queued to a microtask (one per tap), so a test that reads the sync
// has to let that microtask run.
const undo = async () => { await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Undo' })) }) }
const tap = async (label) => { await act(async () => { fireEvent.click(screen.getByRole('button', { name: label })) }) }
// The toast itself — NOT getByText: CareNeeded's sr-only live region announces the same sentence, so
// a bare text query matches twice, and matching the live region alone would pass with no toast at all.
const toastText = () => screen.getByRole('button', { name: 'Undo' }).closest('[role="status"]').textContent
// Every undo toast on screen, oldest first (the stack's DOM order), by its message line.
const toastMessages = () => screen.queryAllByRole('button', { name: 'Undo' })
  .map(b => b.closest('[role="status"]').querySelector('span span').textContent)
// saveTodaySkipped calls made after `from` (a mock.calls.length taken earlier), as their arguments.
const syncsSince = (from) => prefsMock.saveTodaySkipped.mock.calls.slice(from).map(c => c[0])
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
    await undo()
    expect(screen.getByText('Habanero')).toBeTruthy()
    expect(stored()).toEqual([])
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()   // the toast cleared
  })

  // The column is a snapshot, so the undo must send what is LEFT, not the key it removed.
  // Mutations: send `keys: [row.key]` (a delta) -> the sync is ['p1:water_due'], red; drop the sync ->
  // no sync after the tap, red.
  it('Undo re-syncs the whole remaining set to the server', async () => {
    await mountHost()
    skip('Habanero')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))   // a separate toast for the next skip
    skip('Bhut Jolokia')
    const before = prefsMock.saveTodaySkipped.mock.calls.length
    await undo()
    expect(screen.getByText('Bhut Jolokia')).toBeTruthy()
    expect(screen.queryByText('Habanero')).toBeNull()
    expect(stored()).toEqual(['p2:water_due'])
    const sent = syncsSince(before)
    expect(sent.length).toBe(1)
    expect(sent[0].keys).toEqual(['p2:water_due'])
    expect(sent[0].date).toBe(todayISO())
  })

  // Mutation: drop `group` from the skip toast -> two toasts, no "2 plants" line, red.
  it('a run of skips coalesces into one toast whose Undo restores every plant', async () => {
    await mountHost()
    skip('Habanero')
    skip('Bhut Jolokia')
    expect(screen.getAllByRole('button', { name: 'Undo' }).length).toBe(1)
    expect(toastText()).toContain('Skipped 2 plants for today')
    await undo()
    expect(screen.getByText('Habanero')).toBeTruthy()
    expect(screen.getByText('Bhut Jolokia')).toBeTruthy()
    expect(stored()).toEqual([])
  })

  // The toast outlives the list: skip, tap into a planting, tap Undo. Two coalesced skips, so this is
  // also the one-sync-per-tap rule with Today unmounted. Mutations: do the local write inside the
  // setSkipped updater (the skipRow shape) — it never runs on an unmounted component, the keys stay
  // stored and the rows stay hidden: red; queue the sync through component state/effects instead of
  // module scope — nothing is sent with the list gone: red.
  it('Undo still lands after the list has unmounted, with one sync of the final set', async () => {
    await mountHost()
    skip('Habanero')
    skip('Bhut Jolokia')
    await toggleList()                                  // list gone, toast still up
    expect(screen.queryByText('Bhut Jolokia')).toBeNull()
    const before = prefsMock.saveTodaySkipped.mock.calls.length
    await undo()
    expect(stored()).toEqual([])
    expect(syncsSince(before).map(a => a.keys)).toEqual([[]])
    await toggleList()                                  // back to Today
    expect(screen.getByText('Habanero')).toBeTruthy()
    expect(screen.getByText('Bhut Jolokia')).toBeTruthy()
  })
})

// Review fix (review-v4147-regression MINOR / review-v4147-qa MINOR, 2026-09-24): a coalesced Undo
// used to run one whole-set PATCH per handler — concurrent, fire-and-forget, keepalive — so arrival
// order decided the server snapshot and the one carrying the correct final set was the likeliest to
// be refused by the keepalive quota. The criterion: after an Undo tap the server is sent exactly ONE
// snapshot, and it is the post-undo set.
describe('BUG-TODAYSKIPNOUNDO-001 — one server sync per Undo tap', () => {
  const plan3 = () => {
    const p = plan()
    p.water_due.push({ id: 'p3', name: 'Sungold', crop: 'tomato', project: 'Peppers', project_id: 'prP', overdue_by: 1, in_ground: false })
    return p
  }

  // Mutations: sync per handler again -> 2 syncs, red; read the set when the FIRST handler queues the
  // sync instead of when it is sent -> ['p1:water_due','p3:water_due'], red.
  it('a coalesced Undo of 2 skips sends exactly one sync, carrying the final set', async () => {
    await mountHost(plan3())
    skip('Sungold')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))   // stays skipped: the final set is not empty
    skip('Habanero')
    skip('Bhut Jolokia')
    expect(toastText()).toContain('Skipped 2 plants for today')
    const before = prefsMock.saveTodaySkipped.mock.calls.length
    await undo()
    const sent = syncsSince(before)
    expect(sent.length).toBe(1)
    expect(sent[0].keys).toEqual(['p3:water_due'])
    expect(sent[0].date).toBe(todayISO())
    expect(stored()).toEqual(['p3:water_due'])
  })

  // One per TAP, not one ever. Mutation: never clear the queued flag -> the second tap sends nothing, red.
  it('two separate Undo taps send two syncs, each with the set as it then stood', async () => {
    await mountHost(plan3())
    skip('Habanero')
    const first = prefsMock.saveTodaySkipped.mock.calls.length
    await undo()
    expect(syncsSince(first).map(a => a.keys)).toEqual([[]])
    skip('Sungold')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    skip('Bhut Jolokia')
    const second = prefsMock.saveTodaySkipped.mock.calls.length
    await undo()
    expect(syncsSince(second).map(a => a.keys)).toEqual([['p3:water_due']])
  })
})

// Review fix (review-v4147-qa MINOR): the skip toast's comment promised it "never merges into a
// watering count" and nothing pinned it — the mutant below survived all 44 Today undo tests.
describe('BUG-TODAYSKIPNOUNDO-001 — a skip is never counted as a log', () => {
  // The skip's own toast group must never absorb (or be absorbed by) a log group: a merge would count
  // a skip as a watering. Mutation (review-v4147-qa's surviving one): group 'care-skip' ->
  // 'care-log-watering' -> one toast reading "Logged Water for 2 plants", red.
  it('a skip inside the watering toast window stays its own toast', async () => {
    await mountHost()
    await tap('Log Water for Bhut Jolokia')
    await waitFor(() => expect(toastMessages()).toEqual(['Logged Water for Bhut Jolokia']))
    skip('Habanero')
    expect(toastMessages()).toEqual(['Logged Water for Bhut Jolokia', 'Skipped Habanero for today'])
  })
})

describe('BUG-TODAYSKIPNOUNDO-001 — the server merge after an Undo', () => {
  // The case the old union-merge note warned about. The server still holds the skip (the Undo's sync
  // failed, lost a race, or has not landed) and Today remounts: the union must NOT re-hide the plant.
  // Mutation: remove the readUnskipped() veto from the merge -> Habanero vanishes again, red.
  it('a stale server snapshot cannot re-hide a plant Dave brought back', async () => {
    await mountHost()
    skip('Habanero')
    await undo()
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
    await undo()
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
