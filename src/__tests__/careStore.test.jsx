// V5-TODAYREDESIGN-001 S1 — the Today care store (careStore.js) and the per-list hook over it
// (useCareActions.js), lifted out of CareNeeded.jsx so the V2 Today and the household list share them.
// CareNeededSharedSkips / CareNeededSkipUndo pin the same contract through the rendered V1 list; this
// file pins it at the seam the V2 page will consume, where no CareNeeded is mounted to carry it:
//   · two instances share ONE set (BUG-TODAYHOUSEHOLDSKIPCLOBBER-001),
//   · the Undo veto: a key undone on this device is never re-added by the server merge today, and a
//     fresh skip lifts it (BUG-TODAYSKIPNOUNDO-001),
//   · ONE server sync per Undo, however many keys a coalesced Undo carries — and one write + one sync
//     per skipMany, which is what plan-v2's "Not today" leans on.
// No jest-dom (L-182): toBe/toEqual/toBeTruthy/toBeNull only.
import React, { useSyncExternalStore } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, renderHook } from '@testing-library/react'

const { prefsMock } = vi.hoisted(() => ({
  prefsMock: {
    fetchNotificationPrefs: vi.fn(async () => null),
    saveTodaySkipped: vi.fn(async () => null),
  },
}))
// readTodaySkipped stays real — the merge runs through its date rule.
vi.mock('../lib/notificationPrefsClient.js', async (orig) => ({
  ...(await orig()),
  fetchNotificationPrefs: prefsMock.fetchNotificationPrefs,
  saveTodaySkipped: prefsMock.saveTodaySkipped,
}))

import {
  todayLocalISO, skipKeyName, unskipKeyName, skippedSnapshot, subscribeSkipped, readSkipped, readUnskipped,
  skipMany, unskipMany,
} from '../components/today/careStore.js'
import { useCareActions } from '../components/today/useCareActions.js'
import { buildCareNeeded } from '../lib/careNeeded.js'

const getToken = async () => 'tok'
const stored = () => JSON.parse(localStorage.getItem(skipKeyName()) || '[]').sort()
const vetoed = () => JSON.parse(localStorage.getItem(unskipKeyName()) || '[]').sort()
const flushMicrotasks = () => act(async () => { await Promise.resolve() })

// A consumer the way a list consumes the set: through useSyncExternalStore, nothing else.
function SkipProbe({ id }) {
  const set = useSyncExternalStore(subscribeSkipped, skippedSnapshot)
  return <output data-testid={id}>{[...set].sort().join(',')}</output>
}

const plan = (ids) => ({
  hydrology: { tomorrow_precip_in: 0.05, tomorrow_pop: 10 },
  rain_skipped: [],
  water_due: ids.map((id, i) => ({ id, name: 'Plant ' + id, crop: 'pepper', project: 'P', project_id: 'prP', overdue_by: 2 - i, in_ground: false })),
  no_history: [], fertilize: [], pest: [], cold: [], dormant: [],
})
const deps = () => ({
  bedWait: false, planDate: todayLocalISO(), fetch: vi.fn(async () => ({ id: 'ev-1' })), getToken,
  toast: { showUndo: vi.fn(), show: vi.fn() }, announce: vi.fn(),
})
const keysOf = (rows) => rows.map(r => r.key).sort()

let unsubs = []
beforeEach(() => {
  prefsMock.fetchNotificationPrefs.mockReset(); prefsMock.fetchNotificationPrefs.mockResolvedValue(null)
  prefsMock.saveTodaySkipped.mockReset(); prefsMock.saveTodaySkipped.mockResolvedValue(null)
  localStorage.clear(); sessionStorage.clear()
})
afterEach(() => { for (const u of unsubs) u(); unsubs = [] })

describe('careStore — two instances share one set', () => {
  it('a skip written through the store shows in BOTH subscribed consumers, and an unskip leaves both', async () => {
    render(<><SkipProbe id="a" /><SkipProbe id="b" /></>)
    act(() => { skipMany(['p1:water_due'], getToken) })
    expect(screen.getByTestId('a').textContent).toBe('p1:water_due')
    expect(screen.getByTestId('b').textContent).toBe('p1:water_due')
    act(() => { unskipMany(['p1:water_due'], getToken) })
    expect(screen.getByTestId('a').textContent).toBe('')
    expect(screen.getByTestId('b').textContent).toBe('')
    await flushMicrotasks()
  })

  it("two useCareActions lists: a skip in one hides the plant in the other's rows, and keeps the other's skips", async () => {
    const own = buildCareNeeded(plan(['p1', 'p2']))
    const both = buildCareNeeded(plan(['p1', 'j1']))    // p1 is on both lists
    const a = renderHook(() => useCareActions({ allRows: own, ...deps() }))
    const b = renderHook(() => useCareActions({ allRows: both, ...deps() }))
    await flushMicrotasks()
    act(() => { b.result.current.skipRow(both.find(r => r.plantingId === 'j1')) })
    act(() => { a.result.current.skipRow(own.find(r => r.plantingId === 'p1')) })
    // The clobber this store exists for: the second list's skip must not erase the first's.
    expect(stored()).toEqual(['j1:water_due', 'p1:water_due'])
    expect(keysOf(a.result.current.rows)).toEqual(['p2:water_due'])
    expect(b.result.current.rows).toEqual([])
    expect([...a.result.current.skipped].sort()).toEqual([...b.result.current.skipped].sort())
    // And the server snapshot after the second skip carries both.
    expect([...prefsMock.saveTodaySkipped.mock.calls.at(-1)[0].keys].sort()).toEqual(['j1:water_due', 'p1:water_due'])
    // Undo from the first list's toast brings p1 back on BOTH lists.
    act(() => { a.result.current.unskipRow(own.find(r => r.plantingId === 'p1')) })
    expect(keysOf(a.result.current.rows)).toEqual(['p1:water_due', 'p2:water_due'])
    expect(keysOf(b.result.current.rows)).toEqual(['p1:water_due'])
    await flushMicrotasks()
    a.unmount(); b.unmount()
  })
})

describe('careStore — the Undo veto', () => {
  it("an undone key is vetoed: the mount-time server merge adds the server's other keys but not that one", async () => {
    const rows = buildCareNeeded(plan(['p1', 'p2', 'p3']))
    act(() => { skipMany(['p1:water_due'], getToken) })
    act(() => { unskipMany(['p1:water_due'], getToken) })
    await flushMicrotasks()
    expect(vetoed()).toEqual(['p1:water_due'])
    // A stale server snapshot still holds p1, plus a skip made on another device (p2).
    prefsMock.fetchNotificationPrefs.mockResolvedValue({ today_skipped: { date: todayLocalISO(), keys: ['p1:water_due', 'p2:water_due'] } })
    const h = renderHook(() => useCareActions({ allRows: rows, ...deps() }))
    await flushMicrotasks(); await flushMicrotasks()
    expect(stored()).toEqual(['p2:water_due'])
    expect(keysOf(h.result.current.rows)).toEqual(['p1:water_due', 'p3:water_due'])
    h.unmount()
  })

  it('skipping the key again lifts the veto, so a later merge may carry it', async () => {
    act(() => { skipMany(['p1:water_due', 'p2:water_due'], getToken) })
    act(() => { unskipMany(['p1:water_due', 'p2:water_due'], getToken) })
    await flushMicrotasks()
    expect(vetoed()).toEqual(['p1:water_due', 'p2:water_due'])
    act(() => { skipMany(['p1:water_due'], getToken) })
    expect(vetoed()).toEqual(['p2:water_due'])
    expect(readUnskipped().has('p1:water_due')).toBe(false)
  })

  it('a server snapshot dated another day merges nothing', async () => {
    prefsMock.fetchNotificationPrefs.mockResolvedValue({ today_skipped: { date: '2000-01-01', keys: ['p1:water_due'] } })
    const h = renderHook(() => useCareActions({ allRows: buildCareNeeded(plan(['p1'])), ...deps() }))
    await flushMicrotasks(); await flushMicrotasks()
    expect(stored()).toEqual([])
    expect(h.result.current.rows.length).toBe(1)
    h.unmount()
  })
})

describe('careStore — one sync per Undo', () => {
  it("a coalesced Undo's handlers, run in one synchronous loop, send ONE whole-set sync after the last", async () => {
    act(() => { for (const k of ['a', 'b', 'c', 'd']) skipMany([k], getToken) })
    expect(prefsMock.saveTodaySkipped).toHaveBeenCalledTimes(4)   // one per Skip tap, as before
    prefsMock.saveTodaySkipped.mockClear()
    // ToastContext's onUndo runs every accumulated handler in one loop — this is that loop.
    act(() => { for (const k of ['a', 'b', 'c']) unskipMany([k], getToken) })
    expect(prefsMock.saveTodaySkipped).toHaveBeenCalledTimes(0)    // queued, not yet sent
    await flushMicrotasks()
    expect(prefsMock.saveTodaySkipped).toHaveBeenCalledTimes(1)
    const sent = prefsMock.saveTodaySkipped.mock.calls[0][0]
    expect(sent.keys).toEqual(['d'])                              // the set as it stands after the LAST handler
    expect(sent.date).toBe(todayLocalISO())
    expect(sent.getToken).toBe(getToken)
  })

  it('unskipMany of three keys is one local write and one sync', async () => {
    act(() => { skipMany(['a', 'b', 'c'], getToken) })
    let writes = 0
    unsubs.push(subscribeSkipped(() => { writes++ }))
    prefsMock.saveTodaySkipped.mockClear()
    act(() => { unskipMany(['a', 'b', 'c'], getToken) })
    await flushMicrotasks()
    expect(writes).toBe(1)
    expect(prefsMock.saveTodaySkipped).toHaveBeenCalledTimes(1)
    expect(prefsMock.saveTodaySkipped.mock.calls[0][0].keys).toEqual([])
  })

  it('skipMany of three keys is one local write and one sync carrying all three', () => {
    let writes = 0
    unsubs.push(subscribeSkipped(() => { writes++ }))
    act(() => { skipMany(new Set(['a', 'b', 'c']), getToken) })
    expect(writes).toBe(1)
    expect(prefsMock.saveTodaySkipped).toHaveBeenCalledTimes(1)
    expect([...prefsMock.saveTodaySkipped.mock.calls[0][0].keys].sort()).toEqual(['a', 'b', 'c'])
    expect([...readSkipped()].sort()).toEqual(['a', 'b', 'c'])
  })

  it('nothing to skip or unskip: nothing written, nothing sent', async () => {
    let writes = 0
    unsubs.push(subscribeSkipped(() => { writes++ }))
    act(() => { skipMany([], getToken); unskipMany([], getToken) })
    await flushMicrotasks()
    expect(writes).toBe(0)
    expect(prefsMock.saveTodaySkipped).toHaveBeenCalledTimes(0)
    expect(localStorage.getItem(skipKeyName())).toBeNull()
    expect(localStorage.getItem(unskipKeyName())).toBeNull()
  })
})
