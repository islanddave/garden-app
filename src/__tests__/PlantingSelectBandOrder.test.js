// PlantingSelectBandOrder.test.js — V4-CROPLISTORDER-001 (BD-010), spec §5 tests 1-8.
//
// bandOrder is a pure exported function (the computePlacement discipline): the whole ordering
// contract is the mapping from (options, pins, rank, counts) to a sequence, so it is pinned
// directly, with no component render in the way. Tests 4-5 go through the REAL ledger
// (localStorage) because the properties they pin — batch skew impossible by write shape, the
// 60d window — live in the ledger/reader pair, not in the comparator.
import { describe, it, expect, beforeEach } from 'vitest'
import { bandOrder } from '../components/forms/PlantingSelect.jsx'
import { recordCropLog, readCropRank } from '../lib/cropLogLedger.js'

const o = (value, label) => ({ value, label: label ?? value[0].toUpperCase() + value.slice(1) })
const values = (arr) => arr.map(x => x.value)
const NOW = new Date('2026-08-13T12:00:00-04:00')
const day = (n) => new Date(NOW.getTime() - n * 86400000).toISOString().slice(0, 10)

beforeEach(() => { localStorage.clear() })

describe('bandOrder — V4-CROPLISTORDER-001', () => {
  // Test 1. Cold start: no ledger data at all → pins (in the given order) + alphabetical tail.
  // This is the contract for a brand-new device and for broken storage — already better than
  // the count-desc order it replaces.
  it('cold-start contract: pins first in given order, then an alphabetical-by-label tail', () => {
    const out = bandOrder({
      options: [o('squash'), o('tomato'), o('kale'), o('pepper'), o('basil')],
      pinned: ['tomato', 'pepper'],
      rank: null,
      counts: new Map([['tomato', 4], ['pepper', 3], ['squash', 2], ['kale', 1], ['basil', 1]]),
    })
    expect(values(out)).toEqual(['tomato', 'pepper', 'basil', 'kale', 'squash'])
  })

  // Test 2. A pin that is ALSO top-ranked appears once — in the pin band, never again in band 2.
  it('never lists a pinned crop twice, even when it is also the top-ranked crop', () => {
    const rank = new Map([['tomato', { days: 9, last: day(0) }], ['kale', { days: 1, last: day(2) }]])
    const out = bandOrder({
      options: [o('tomato'), o('kale'), o('squash'), o('pepper')],
      pinned: ['tomato', 'pepper'],
      rank,
      counts: new Map(),
    })
    expect(values(out)).toEqual(['tomato', 'pepper', 'kale', 'squash'])
    expect(values(out).filter(v => v === 'tomato')).toHaveLength(1)
  })

  // Test 3. Band 2 caps at bandN; rank overflow falls into the alphabetical tail rather than
  // making the recents band unboundedly long (the band exists to be SHORT).
  it('caps the recents band at N and sends the overflow to the alphabetical tail', () => {
    const opts = ['f', 'e', 'd', 'c', 'b', 'a'].map(s => o(s, s.toUpperCase()))
    // All six ranked, days OPPOSED to alpha (f most active) so band order ≠ tail order and the
    // assertion can tell them apart.
    const rank = new Map([['a', 2], ['b', 3], ['c', 4], ['d', 5], ['e', 6], ['f', 7]]
      .map(([s, n]) => [s, { days: n, last: day(0) }]))
    const out = bandOrder({ options: opts, pinned: [], rank, counts: new Map(), bandN: 3 })
    // Band 2 = top-3 by days (f, e, d); overflow (c, b, a) lands ALPHABETICAL — a rank-ordered
    // tail would read c, b, a.
    expect(values(out)).toEqual(['f', 'e', 'd', 'a', 'b', 'c'])
  })

  // Test 4. THE ANTI-BATCH-SKEW INVARIANT, BY NAME, through the real ledger: the write shape
  // (idempotent per slug+day) makes distinct-days the only representable statistic, so raw
  // event volume cannot buy rank.
  it('30 events on 2 days ranks BELOW 5 events on 5 days (anti-batch-skew invariant)', () => {
    for (let i = 0; i < 15; i++) recordCropLog('zinnia', day(1), NOW) // 15 events, day -1
    for (let i = 0; i < 15; i++) recordCropLog('zinnia', day(2), NOW) // 15 events, day -2
    for (let n = 1; n <= 5; n++) recordCropLog('basil', day(n), NOW)  // 5 events, 5 days
    const rank = readCropRank({ windowDays: 60, now: NOW })
    expect(rank.get('zinnia').days).toBe(2)
    expect(rank.get('basil').days).toBe(5)
    const out = bandOrder({ options: [o('zinnia'), o('basil')], pinned: [], rank, counts: new Map() })
    expect(values(out)).toEqual(['basil', 'zinnia'])
  })

  // Test 5. The 60-day trailing window: day 59 is in, day 61 is out — a crop whose only
  // activity is out-of-window is unranked and sorts as tail, not as a stale recent.
  it('excludes a log day 61 days old from the 60d window (59 days old stays in)', () => {
    recordCropLog('leek', day(61), NOW)
    recordCropLog('okra', day(59), NOW)
    const rank = readCropRank({ windowDays: 60, now: NOW })
    expect(rank.has('leek')).toBe(false)
    expect(rank.get('okra')).toEqual({ days: 1, last: day(59) })
    const out = bandOrder({ options: [o('leek'), o('okra'), o('corn')], pinned: [], rank, counts: new Map() })
    expect(values(out)).toEqual(['okra', 'corn', 'leek'])
  })

  // Test 6. The full tie-chain, one comparator level at a time:
  // days DESC → mostRecentLogDay DESC → livePlantingCount DESC → PIN_TIE_PREF ASC → label ASC.
  it('applies the total tie-chain: days, then last day, then live count, then pin-pref, then label', () => {
    const counts = new Map([['carrot', 5], ['dill', 1], ['pepper', 2], ['arugula', 2]])
    const rank = new Map([
      ['beet',    { days: 3, last: day(5) }],  // days wins over everything below
      ['carrot',  { days: 2, last: day(1) }],  // equal days: later last wins over dill
      ['dill',    { days: 2, last: day(4) }],
      ['fennel',  { days: 1, last: day(2) }],  // equal days+last vs carrot? no — next tier:
      ['pepper',  { days: 1, last: day(2) }],  //   fennel/pepper/arugula all days=1,last=day(2)
      ['arugula', { days: 1, last: day(2) }],  //   counts: pepper 2 = arugula 2 > fennel 0
    ])                                          //   pepper beats arugula on PIN_TIE_PREF
    const out = bandOrder({
      options: ['arugula', 'beet', 'carrot', 'dill', 'fennel', 'pepper'].map(s => o(s)),
      pinned: [], rank, counts,
    })
    expect(values(out)).toEqual([
      'beet',              // 3 days
      'carrot', 'dill',    // 2 days each; carrot's last (day 1) is more recent than dill's (day 4)
      'pepper', 'arugula', // 1 day, same last; count 2 ties; pepper is in PIN_TIE_PREF
      'fennel',            // 1 day, same last; count 0 loses to count 2
    ])
  })

  // Test 7. Terminal determinism: identical on every upstream key, the display label decides —
  // and the same inputs give the same sequence on every call (no hidden state, no randomness).
  it('is terminally deterministic: label ASC decides the final tie, repeatably', () => {
    const rank = new Map([
      ['slug-b', { days: 2, last: day(3) }],
      ['slug-a', { days: 2, last: day(3) }],
    ])
    const counts = new Map([['slug-b', 1], ['slug-a', 1]])
    const opts = [o('slug-b', 'Zinnia'), o('slug-a', 'Aster')]
    const first = values(bandOrder({ options: opts, pinned: [], rank, counts }))
    expect(first).toEqual(['slug-a', 'slug-b']) // Aster < Zinnia — label, not input order
    for (let i = 0; i < 3; i++) {
      expect(values(bandOrder({ options: opts, pinned: [], rank, counts }))).toEqual(first)
    }
  })

  // Test 8. Band 3 sorts on the DISPLAY LABEL, not the slug — the user scans rendered text.
  // Slug order and label order are deliberately opposed here so the wrong key cannot pass.
  it('sorts the tail by display label, not by slug', () => {
    const out = bandOrder({
      options: [o('apple-gourd', 'Zucchini Gourd'), o('zesty-mix', 'Arugula Mix')],
      pinned: [], rank: new Map(), counts: new Map(),
    })
    expect(out.map(x => x.label)).toEqual(['Arugula Mix', 'Zucchini Gourd'])
  })
})
