// BUG-TODAYHOUSEHOLDSKIPCLOBBER-001 — Today mounts TWO CareNeeded lists (Dave's own + the rest of the
// household, V4-ASSIGNLENS-001). Both write the one `today-skipped:<date>` key and the one per-user
// server snapshot, and each list used to write the set as ITS OWN React state held it — so a skip in
// one list erased the other list's skips from storage and from the server, and the erased plant came
// back on the next visit. These cases mount both lists together, the way Today does.
// No jest-dom (L-182): role/attr/text + toBe/toBeTruthy/toBeNull only.
//
// Same mock seam as CareNeededSkipUndo.test.jsx: the REAL ToastProvider, because several cases below
// tap a real Undo, and a mocked showUndo would only prove a function was called.
import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, within } from '@testing-library/react'

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
// readTodaySkipped stays real — the mount merge below runs through its date rule.
vi.mock('../lib/notificationPrefsClient.js', async (orig) => ({
  ...(await orig()),
  fetchNotificationPrefs: prefsMock.fetchNotificationPrefs,
  saveTodaySkipped: prefsMock.saveTodaySkipped,
}))

import CareNeeded from '../components/today/CareNeeded.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import { clearClientPrefs } from '../lib/clientPrefs.js'

// Names are chosen so no needle is a substring of another row's name in EITHER list, so every
// positive text assertion can only be satisfied by the row it names.
const ownPlan = () => ({
  hydrology: { tomorrow_precip_in: 0.05, tomorrow_pop: 10 },
  rain_skipped: [],
  water_due: [
    { id: 'p1', name: 'Bhut Jolokia', crop: 'pepper', project: 'Peppers', project_id: 'prP', overdue_by: 3, in_ground: false },
    { id: 'p2', name: 'Habanero',     crop: 'pepper', project: 'Peppers', project_id: 'prP', overdue_by: 1, in_ground: false },
  ],
  no_history: [], fertilize: [], pest: [], cold: [], dormant: [],
})
// The rest of the household: a different caretaker's plan, so different plantings (the engine gives
// each planting to one caretaker — engine.js ownerFor).
const householdPlan = () => ({
  hydrology: { tomorrow_precip_in: 0.05, tomorrow_pop: 10 },
  rain_skipped: [],
  water_due: [
    { id: 'j1', name: 'Sungold',   crop: 'tomato', project: 'Tomatoes', project_id: 'prT', overdue_by: 2, in_ground: false },
    { id: 'j2', name: 'Tigerella', crop: 'tomato', project: 'Tomatoes', project_id: 'prT', overdue_by: 1, in_ground: false },
  ],
  no_history: [], fertilize: [], pest: [], cold: [], dormant: [],
})

const todayISO = () => {
  const d = new Date()
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}
const stored = () => JSON.parse(localStorage.getItem('today-skipped:' + todayISO()) || '[]').sort()
const lastSync = () => [...prefsMock.saveTodaySkipped.mock.calls.at(-1)[0].keys].sort()
const own = () => within(screen.getByTestId('list-own'))
const household = () => within(screen.getByTestId('list-household'))
const skipIn = (list, name) => fireEvent.click(list.getByRole('button', { name: new RegExp('Skip ' + name + ' today', 'i') }))
const undo = async () => { await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Undo' })) }) }
const tap = async (label) => { await act(async () => { fireEvent.click(screen.getByRole('button', { name: label })) }) }
const serverHas = (...keys) => ({ today_skipped: { date: todayISO(), keys } })

// Today's shape: one toast layer at the app root, the own list, and the household list under its own
// toggle. Either list can be unmounted and remounted while the toast layer stays up — tapping into a
// planting does that to the own list; the household toggle does it to the other one.
function Host({ own: ownP, household: hhP, startHousehold = true }) {
  const [ownShown, setOwnShown] = useState(true)
  const [hhShown, setHhShown] = useState(startHousehold)
  return (
    <ToastProvider>
      <section data-testid="list-own">{ownShown && <CareNeeded plan={ownP} />}</section>
      <section data-testid="list-household">{hhShown && <CareNeeded plan={hhP} />}</section>
      <button type="button" onClick={() => setOwnShown(s => !s)}>toggle own</button>
      <button type="button" onClick={() => setHhShown(s => !s)}>toggle household</button>
    </ToastProvider>
  )
}
const mount = async (opts = {}) => {
  await act(async () => { render(<Host own={opts.own || ownPlan()} household={opts.household || householdPlan()} startHousehold={opts.startHousehold !== false} />) })
}

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation((path) =>
    (path === '/api/plants' || path === '/api/locations/with-path') ? Promise.resolve([]) : Promise.resolve({ id: 'ev-new' }))
  prefsMock.fetchNotificationPrefs.mockReset(); prefsMock.fetchNotificationPrefs.mockResolvedValue(null)
  prefsMock.saveTodaySkipped.mockReset(); prefsMock.saveTodaySkipped.mockResolvedValue(null)
  localStorage.clear(); sessionStorage.clear()
})

describe('BUG-TODAYHOUSEHOLDSKIPCLOBBER-001 — one skip set for both lists', () => {
  // The ledger row's own sequence. Mutation: write the list's own state instead of the shared set
  // (the pre-fix skipRow) -> stored is ['j1:water_due'] only, red.
  it('a skip in each list: the stored set keeps BOTH', async () => {
    await mount()
    skipIn(own(), 'Habanero')
    skipIn(household(), 'Sungold')
    expect(stored()).toEqual(['j1:water_due', 'p2:water_due'])
  })

  // The server column is a whole-set snapshot, so the LAST write is what the other device gets.
  // Same mutation -> the last sync carries ['j1:water_due'] only, red.
  it('the server snapshot after the second skip carries both', async () => {
    await mount()
    skipIn(own(), 'Habanero')
    skipIn(household(), 'Sungold')
    expect(lastSync()).toEqual(['j1:water_due', 'p2:water_due'])
    expect(prefsMock.saveTodaySkipped.mock.calls.at(-1)[0].date).toBe(todayISO())
  })

  // Reverse order, so the fix is not an accident of which list mounted first.
  it('the other order: household first, then own', async () => {
    await mount()
    skipIn(household(), 'Tigerella')
    skipIn(own(), 'Bhut Jolokia')
    expect(stored()).toEqual(['j2:water_due', 'p1:water_due'])
    expect(lastSync()).toEqual(['j2:water_due', 'p1:water_due'])
  })

  // What Dave actually saw: the plant he skipped came back. Unmount BOTH lists (leaving Today), then
  // come back. Mutation as above -> Habanero is back on screen, red. The two controls prove the
  // lists rendered, so the absences are not vacuous.
  it('after leaving Today and coming back, neither skipped plant is back', async () => {
    await mount()
    skipIn(own(), 'Habanero')
    skipIn(household(), 'Sungold')
    await tap('toggle own'); await tap('toggle household')
    await tap('toggle own'); await tap('toggle household')
    expect(own().getByText('Bhut Jolokia')).toBeTruthy()
    expect(household().getByText('Tigerella')).toBeTruthy()
    expect(own().queryByText('Habanero')).toBeNull()
    expect(household().queryByText('Sungold')).toBeNull()
  })

  // The household list is opt-in and mounts later, reading the set as it stood then. It must not keep
  // a private copy that goes stale. Mutation (pre-fix shape: each list merges into its own copy) ->
  // the own list's second skip writes ['p2:water_due','p1:water_due'] over the household's Sungold, red.
  it('a list mounted later (household toggle) and then both skipping', async () => {
    await mount({ startHousehold: false })
    skipIn(own(), 'Habanero')
    await tap('toggle household')
    skipIn(household(), 'Sungold')
    skipIn(own(), 'Bhut Jolokia')
    expect(stored()).toEqual(['j1:water_due', 'p1:water_due', 'p2:water_due'])
    expect(lastSync()).toEqual(['j1:water_due', 'p1:water_due', 'p2:water_due'])
  })
})

describe('BUG-TODAYHOUSEHOLDSKIPCLOBBER-001 — Undo (v4.147.0) with two lists', () => {
  // The Undo variant: the household list mounted while Habanero was skipped, so a private copy of the
  // set would still hold it after Dave undid the skip — and the household list's next skip would
  // write Habanero back into storage and to the server, re-hiding a plant he brought back.
  // Mutation (pre-fix) -> stored/sync include 'p2:water_due', and Habanero is hidden after the
  // remount, red.
  it('an Undo sticks: the other list cannot re-publish the undone skip', async () => {
    await mount({ startHousehold: false })
    skipIn(own(), 'Habanero')
    await tap('toggle household')
    await undo()
    expect(own().getByText('Habanero')).toBeTruthy()
    skipIn(household(), 'Sungold')
    expect(stored()).toEqual(['j1:water_due'])
    expect(lastSync()).toEqual(['j1:water_due'])
    await tap('toggle own'); await tap('toggle own')
    expect(own().getByText('Habanero')).toBeTruthy()
  })

  // Undo removes only that plant's skip (the v4.147.0 contract), including a skip made in the OTHER
  // list inside the same coalesced toast window. Mutation: unskip by replacing the stored set with
  // the undoing list's own view -> Sungold's skip survives or Habanero's does, red.
  it("a coalesced Undo across both lists removes exactly the two plants' skips", async () => {
    await mount()
    skipIn(own(), 'Bhut Jolokia')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))   // stays skipped
    skipIn(own(), 'Habanero')
    skipIn(household(), 'Sungold')
    expect(screen.getAllByRole('button', { name: 'Undo' }).length).toBe(1)
    const before = prefsMock.saveTodaySkipped.mock.calls.length
    await undo()
    expect(stored()).toEqual(['p1:water_due'])
    expect(own().getByText('Habanero')).toBeTruthy()
    expect(household().getByText('Sungold')).toBeTruthy()
    expect(own().queryByText('Bhut Jolokia')).toBeNull()
    const sent = prefsMock.saveTodaySkipped.mock.calls.slice(before).map(c => [...c[0].keys].sort())
    expect(sent).toEqual([['p1:water_due']])
  })

  // The toast outlives the list. Skip, leave and come back (the list remounts while the toast is still
  // up), then Undo: the list now on screen must show the plant at once — the toast says it is back.
  // Mutation (pre-fix: Undo repaints only the list instance that raised the toast, which is gone) ->
  // storage is right but Habanero stays hidden on screen, red.
  it('an Undo tapped after the list remounted brings the row back on screen at once', async () => {
    await mount()
    skipIn(own(), 'Habanero')
    await tap('toggle own'); await tap('toggle own')
    expect(own().queryByText('Habanero')).toBeNull()
    await undo()
    expect(stored()).toEqual([])
    expect(own().getByText('Habanero')).toBeTruthy()
  })
})

describe('BUG-TODAYHOUSEHOLDSKIPCLOBBER-001 — the lists agree on screen', () => {
  // A planting can sit in both lists when the two caretakers' plan snapshots disagree about who owns
  // it (each is its own daily_plan row). Before the fix, skipping it hid it in one list and left it in
  // the other until the next visit — which then hid it in both. Now both at once, and an Undo brings
  // it back in both. Mutation (pre-fix per-list state) -> still visible in the household list, red.
  it('a plant in both lists is hidden in both by one skip, and back in both after Undo', async () => {
    const shared = { id: 's1', name: 'Shishito', crop: 'pepper', project: 'Peppers', project_id: 'prP', overdue_by: 2, in_ground: false }
    const o = ownPlan(); o.water_due.push(shared)
    const h = householdPlan(); h.water_due.push(shared)
    await mount({ own: o, household: h })
    expect(own().getByText('Shishito')).toBeTruthy()
    expect(household().getByText('Shishito')).toBeTruthy()
    skipIn(own(), 'Shishito')
    expect(own().queryByText('Shishito')).toBeNull()
    expect(household().queryByText('Shishito')).toBeNull()
    expect(household().getByText('Sungold')).toBeTruthy()
    await undo()
    expect(own().getByText('Shishito')).toBeTruthy()
    expect(household().getByText('Shishito')).toBeTruthy()
  })
})

describe('BUG-TODAYHOUSEHOLDSKIPCLOBBER-001 — when localStorage refuses the write', () => {
  // Quota or blocked storage. The old per-list state still hid the row; the shared set must too, for
  // both lists, and the server must still get the union. Mutation: drop the refused-write branch in
  // writeSkipped (keep the new JSON as `raw`) -> the snapshot re-reads empty storage, Habanero is back
  // on screen and the second sync carries only Sungold, red.
  // Replaces the GLOBAL, not Storage.prototype — the clientPrefs.test.jsx pattern: setup.ts swaps in a
  // plain-object storage shim on Node versions where jsdom's Storage is missing, and a prototype spy
  // silently misses it. Everything but today-skipped writes passes through. Returns the restore.
  const refuseSkipWrites = () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    const real = globalThis.localStorage
    const refusing = {
      get length() { return real.length },
      key: (i) => real.key(i),
      getItem: (k) => real.getItem(k),
      setItem: (k, v) => {
        if (String(k).startsWith('today-skipped:')) throw new DOMException('full', 'QuotaExceededError')
        real.setItem(k, v)
      },
      removeItem: (k) => real.removeItem(k),
      clear: () => real.clear(),
    }
    Object.defineProperty(globalThis, 'localStorage', { value: refusing, writable: true, configurable: true })
    return () => { if (original) Object.defineProperty(globalThis, 'localStorage', original) }
  }

  it('the skip still hides the row in both lists and still reaches the server', async () => {
    const restore = refuseSkipWrites()
    try {
      await mount()
      skipIn(own(), 'Habanero')
      skipIn(household(), 'Sungold')
      expect(localStorage.getItem('today-skipped:' + todayISO())).toBeNull()   // the refusal is real
      expect(own().queryByText('Habanero')).toBeNull()
      expect(household().queryByText('Sungold')).toBeNull()
      expect(own().getByText('Bhut Jolokia')).toBeTruthy()
      expect(lastSync()).toEqual(['j1:water_due', 'p2:water_due'])
    } finally { restore() }
  })

  // The in-memory copy of a refused write must not outlive the lists: sign-out clears the stored keys
  // (clearClientPrefs) and may not reload the page, so a copy that survived would hide the NEXT
  // person's rows. Mutation: drop the reset when the last list unsubscribes -> Habanero stays hidden
  // after the remount, red.
  it('a refused write is forgotten once every list has unmounted', async () => {
    const restore = refuseSkipWrites()
    try {
      await mount()
      skipIn(own(), 'Habanero')
      expect(own().queryByText('Habanero')).toBeNull()
      await tap('toggle own'); await tap('toggle household')    // every list gone
    } finally { restore() }
    clearClientPrefs()
    await tap('toggle own'); await tap('toggle household')
    expect(own().getByText('Habanero')).toBeTruthy()
    expect(household().getByText('Sungold')).toBeTruthy()
  })

  // ...but only the LAST one. The memory copy belongs to the page, and the household toggle unmounts
  // one list while the other stays up. Ported from the v4.150.0 QA seat's probe P-K2 (review-v4150-qa
  // M3). Mutation K2 (reset on ANY unmount) -> Habanero is back in the own list, red.
  // BOTH toggles are load-bearing: the reset runs in the unmounting list's effect cleanup, after the own
  // list has already rendered for that tap, so a check after the first toggle passes on K2 too (the
  // seat's first probe did). Turning the household list back on is what re-renders the own list.
  it('the household list going off and on does not forget a skip the own list still shows', async () => {
    const restore = refuseSkipWrites()
    try {
      await mount()
      skipIn(own(), 'Habanero')
      expect(own().queryByText('Habanero')).toBeNull()
      await tap('toggle household')    // one list unmounts; the own list stays mounted
      await tap('toggle household')    // and back: the own list re-renders from the snapshot
      expect(household().getByText('Sungold')).toBeTruthy()
      expect(own().getByText('Bhut Jolokia')).toBeTruthy()
      expect(own().queryByText('Habanero')).toBeNull()
    } finally { restore() }
  })
})

describe('BUG-TODAYHOUSEHOLDSKIPCLOBBER-001 — a change to the stored key from outside', () => {
  // Storage is the truth; the memory copy only stands in for a write storage REFUSED. Sign-out's
  // clearClientPrefs removes the key while Today is still mounted (AuthContext.signOut clears BEFORE
  // Clerk's signOut). Nothing notifies the lists of that, so they follow it on their NEXT render — the
  // toggle below is that render. Ported from the v4.150.0 QA seat's probe P-K5 (review-v4150-qa M3).
  // Mutation K5 (snapshot keyed on the day only, blind to the stored string) -> both rows stay hidden,
  // red.
  it('sign-out clearing the key brings the rows back on the next render', async () => {
    await mount()
    skipIn(own(), 'Habanero')
    skipIn(household(), 'Sungold')
    expect(own().queryByText('Habanero')).toBeNull()
    clearClientPrefs()
    expect(stored()).toEqual([])      // the precondition: the clear really took the key
    await tap('toggle household'); await tap('toggle household')
    expect(own().getByText('Habanero')).toBeTruthy()
    expect(household().getByText('Sungold')).toBeTruthy()
  })
})

describe('BUG-TODAYHOUSEHOLDSKIPCLOBBER-001 — the day boundary', () => {
  // Side effect of reading the set by today's key on every render, pinned so it stays a decision: a
  // list left open across midnight used to carry yesterday's skips in its state into the new day's
  // key and the server (readTodaySkipped's comment calls that the dangerous silent failure). Mutation:
  // hydrate the set once and serve it without re-reading today's key -> today's key and the sync
  // carry 'p2:water_due', red.
  it("a skip after midnight writes only the new day's set", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date(2026, 8, 24, 23, 58))
      await mount()
      skipIn(own(), 'Habanero')
      vi.setSystemTime(new Date(2026, 8, 25, 0, 2))
      skipIn(own(), 'Bhut Jolokia')
      expect(JSON.parse(localStorage.getItem('today-skipped:2026-09-25'))).toEqual(['p1:water_due'])
      expect(JSON.parse(localStorage.getItem('today-skipped:2026-09-24'))).toEqual(['p2:water_due'])
      const last = prefsMock.saveTodaySkipped.mock.calls.at(-1)[0]
      expect(last.date).toBe('2026-09-25')
      expect(last.keys).toEqual(['p1:water_due'])
    } finally { vi.useRealTimers() }
  })
})

describe('BUG-TODAYHOUSEHOLDSKIPCLOBBER-001 — the mount-time server merge', () => {
  // Each list pulls the server set on mount and merges it in. The two responses can land in either
  // order; a merge that writes (its own copy + server) back over storage erases a skip the OTHER list
  // made while this list's response was in flight. Mutation (pre-fix merge into the list's own state)
  // -> the own list's late merge writes ['p1:water_due'] and Sungold's skip is gone, red.
  it("a late server merge in one list keeps the other list's fresh skip", async () => {
    let releaseOwn
    const ownPending = new Promise(r => { releaseOwn = r })
    prefsMock.fetchNotificationPrefs
      .mockImplementationOnce(() => ownPending)                               // own list, mounts first
      .mockImplementationOnce(async () => serverHas('p1:water_due'))          // household list
    await mount()
    skipIn(household(), 'Sungold')
    await act(async () => { releaseOwn(serverHas('p1:water_due')) })
    expect(stored()).toEqual(['j1:water_due', 'p1:water_due'])
    expect(own().queryByText('Bhut Jolokia')).toBeNull()
    expect(household().queryByText('Sungold')).toBeNull()
    expect(own().getByText('Habanero')).toBeTruthy()
  })
})
