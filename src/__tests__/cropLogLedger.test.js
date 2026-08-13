// cropLogLedger.test.js — V4-CROPLISTORDER-001 (BD-010), spec §5 tests 9-13.
//
// The ledger is the ranking SOURCE for the picker's crop chips, written on the app's
// highest-frequency save path — so the failure contract matters as much as the counting
// contract: a throwing localStorage must cost ranking only (silent empty), never the save.
// `now` is injected everywhere (the harvestSummary discipline) so nothing here goes flaky
// at midnight or across the ET boundary.
import { describe, it, expect, beforeEach } from 'vitest'
import { recordCropLog, recordCropLogs, readCropRank } from '../lib/cropLogLedger.js'

const KEY = 'croprank.v1'
// Fixed "now": noon ET is unambiguous in both EST and EDT projections.
const NOW = new Date('2026-08-13T12:00:00-04:00')
const day = (n) => { // n days before NOW, as YYYY-MM-DD
  const d = new Date(NOW.getTime() - n * 86400000)
  return d.toISOString().slice(0, 10)
}
const store = () => JSON.parse(localStorage.getItem(KEY))

beforeEach(() => { localStorage.clear() })

describe('cropLogLedger — write contract', () => {
  // Test 9. Idempotence per (slug, day) is what makes distinct-log-days the ONLY representable
  // statistic — the anti-batch-skew property lives HERE, in the write shape, not in the reader.
  it('is idempotent per (slug, day): the same day recorded twice counts once', () => {
    recordCropLog('tomato', day(0), NOW)
    recordCropLog('tomato', day(0), NOW)
    recordCropLog('tomato', day(0), NOW)
    expect(store().days.tomato).toEqual([day(0)])
    expect(readCropRank({ windowDays: 60, now: NOW }).get('tomato')).toEqual({ days: 1, last: day(0) })
  })

  // Test 10. recordCropLogs marks each DISTINCT slug once — a duplicate in the input is one mark.
  it('records one mark per distinct slug in a multi-slug write', () => {
    recordCropLogs(['tomato', 'pepper', 'tomato', null, ''], day(1), NOW)
    expect(store().days.tomato).toEqual([day(1)])
    expect(store().days.pepper).toEqual([day(1)])
    expect(Object.keys(store().days).sort()).toEqual(['pepper', 'tomato'])
  })

  // Test 11. Retention: ≤20 day-keys per slug (newest kept) and a >90d prune that sweeps the
  // WHOLE store on every write — the two bounds that keep worst case ~17KB.
  it('caps each slug at 20 newest days and prunes >90d-old days storewide on write', () => {
    for (let n = 24; n >= 1; n--) recordCropLog('tomato', day(n), NOW)
    expect(store().days.tomato).toHaveLength(20)
    expect(store().days.tomato[0]).toBe(day(1))       // newest first…
    expect(store().days.tomato[19]).toBe(day(20))     // …oldest kept is the 20th newest
    // A slug whose days age past the horizon vanishes on the NEXT write — ANY slug's write, the
    // sweep is storewide. day(80) survives now (80 < 90) but is 95 days old two weeks later.
    recordCropLog('squash', day(80), NOW)
    expect(store().days.squash).toEqual([day(80)])
    const LATER = new Date(NOW.getTime() + 15 * 86400000)
    recordCropLog('pepper', day(0), LATER)
    expect(store().days.squash).toBeUndefined()       // swept by the storewide prune
    expect(store().days.pepper).toEqual([day(0)])
  })

  // Test 12. Broken storage — the save path must never pay for ranking.
  it('degrades silently to an empty rank when localStorage throws', () => {
    const orig = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    const throwing = {
      getItem() { throw new Error('denied') },
      setItem() { throw new Error('denied') },
      removeItem() { throw new Error('denied') },
      clear() { throw new Error('denied') },
      key() { throw new Error('denied') },
      get length() { return 0 },
    }
    Object.defineProperty(globalThis, 'localStorage', { value: throwing, configurable: true, writable: true })
    try {
      expect(() => recordCropLog('tomato', day(0), NOW)).not.toThrow()
      const rank = readCropRank({ windowDays: 60, now: NOW })
      expect(rank.size).toBe(0)
    } finally {
      if (orig) Object.defineProperty(globalThis, 'localStorage', orig)
    }
  })

  // Test 13. A corrupt or wrong-version store is discarded wholesale, never half-trusted:
  // reads are empty, and the next write starts a fresh v1 store.
  it('discards a corrupt store on read and starts fresh on the next write', () => {
    for (const junk of ['not json{', JSON.stringify({ v: 99, days: {} }), JSON.stringify({ v: 1, days: [1, 2] }), JSON.stringify(null)]) {
      localStorage.setItem(KEY, junk)
      expect(readCropRank({ windowDays: 60, now: NOW }).size).toBe(0)
    }
    localStorage.setItem(KEY, 'not json{')
    recordCropLog('tomato', day(0), NOW)
    expect(store()).toEqual({ v: 1, days: { tomato: [day(0)] } })
  })

  it('no-ops on an unresolvable day key and normalizes datetime-locals through etDay', () => {
    recordCropLog('tomato', 'garbage', NOW)
    recordCropLog('tomato', null, NOW)
    expect(localStorage.getItem(KEY)).toBeNull()
    // EventNew's event_date is datetime-local shaped before the .split('T')[0]; the ledger
    // normalizes either form to the same day key.
    recordCropLog('tomato', `${day(0)}T14:30`, NOW)
    expect(store().days.tomato).toEqual([day(0)])
  })
})
