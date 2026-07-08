// V4-CRITTERSORT-001 — pure sort helper tests.
import { describe, it, expect } from 'vitest'
import { sortCritters, CRITTER_SORT_MODES, CRITTER_SORT_LABELS } from '../lib/critterSort.js'

const ENTRIES = [
  { id: 'a', name: 'Zebra Swallowtail' },
  { id: 'b', name: 'Aphid' },
  { id: 'c', name: 'Monarch' },
]
// collected Map: b seen recently, c seen earlier, a never seen.
const collected = new Map([
  ['b', { firstSeenAt: '2026-07-05T00:00:00Z' }],
  ['c', { firstSeenAt: '2026-06-01T00:00:00Z' }],
])

describe('sortCritters', () => {
  it('dex (default/unknown) preserves canonical order and does not mutate input', () => {
    const before = ENTRIES.map(e => e.id)
    expect(sortCritters(ENTRIES, 'dex', collected).map(e => e.id)).toEqual(['a', 'b', 'c'])
    expect(sortCritters(ENTRIES, 'whatever', collected).map(e => e.id)).toEqual(['a', 'b', 'c'])
    expect(ENTRIES.map(e => e.id)).toEqual(before)  // input untouched
  })

  it('alpha sorts by name, case-insensitive', () => {
    expect(sortCritters(ENTRIES, 'alpha', collected).map(e => e.name))
      .toEqual(['Aphid', 'Monarch', 'Zebra Swallowtail'])
  })

  it('recent puts newest-seen first, unseen last (unseen keep dex order)', () => {
    expect(sortCritters(ENTRIES, 'recent', collected).map(e => e.id)).toEqual(['b', 'c', 'a'])
  })

  it('recent with none collected keeps dex order', () => {
    expect(sortCritters(ENTRIES, 'recent', new Map()).map(e => e.id)).toEqual(['a', 'b', 'c'])
  })

  it('handles empty / non-array input', () => {
    expect(sortCritters([], 'alpha', collected)).toEqual([])
    expect(sortCritters(undefined, 'alpha', collected)).toEqual([])
  })

  it('exposes modes and labels in sync', () => {
    expect(CRITTER_SORT_MODES).toEqual(['dex', 'alpha', 'recent'])
    CRITTER_SORT_MODES.forEach(m => expect(typeof CRITTER_SORT_LABELS[m]).toBe('string'))
  })
})
