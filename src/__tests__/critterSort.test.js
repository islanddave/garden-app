// V4-CRITTERSORT-001 — pure sort helper tests.
import { describe, it, expect } from 'vitest'
import { sortCritters, CRITTER_SORT_MODES, CRITTER_SORT_LABELS, CRITTER_TYPE_ORDER, CRITTER_TYPE_LABELS } from '../lib/critterSort.js'

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
    expect(CRITTER_SORT_MODES).toEqual(['dex', 'alpha', 'recent', 'type'])
    CRITTER_SORT_MODES.forEach(m => expect(typeof CRITTER_SORT_LABELS[m]).toBe('string'))
  })

  // ── 'type' mode (V4-CRITTERSORT-001 by-type) ──────────────────────────────────
  // dex order = input order: g(bird), h(mammal), i(bird), j(insect), k(no type), l('zzz' unknown)
  const TYPED = [
    { id: 'g', name: 'Robin', type: 'bird' },
    { id: 'h', name: 'Fox', type: 'mammal' },
    { id: 'i', name: 'Jay', type: 'bird' },
    { id: 'j', name: 'Bee', type: 'insect' },
    { id: 'k', name: 'Mystery' },              // no type field
    { id: 'l', name: 'Blob', type: 'zzz' },     // unknown slug
  ]

  it('type clusters by CRITTER_TYPE_ORDER rank, dex order within a type', () => {
    // birds (g,i) first in input order, then mammal (h), then insect (j), then the two
    // unknown/missing (k,l) last in dex order.
    expect(sortCritters(TYPED, 'type', collected).map(e => e.id)).toEqual(['g', 'i', 'h', 'j', 'k', 'l'])
  })

  it('type sinks missing/unknown types to the end in dex order (never throws)', () => {
    const onlyUnknown = [
      { id: 'k', name: 'Mystery' },
      { id: 'l', name: 'Blob', type: 'zzz' },
      { id: 'm', name: 'Ghost', type: '' },
    ]
    expect(sortCritters(onlyUnknown, 'type', collected).map(e => e.id)).toEqual(['k', 'l', 'm'])
  })

  it('type on a roster with no type field at all is identity (graceful degradation)', () => {
    // ENTRIES have no `type` — must return canonical order, unchanged, no throw.
    expect(sortCritters(ENTRIES, 'type', collected).map(e => e.id)).toEqual(['a', 'b', 'c'])
  })

  it('type is deterministic and stable across repeated sorts', () => {
    const once = sortCritters(TYPED, 'type', collected).map(e => e.id)
    const twice = sortCritters(sortCritters(TYPED, 'type', collected), 'type', collected).map(e => e.id)
    expect(twice).toEqual(once)
  })

  it('type does not mutate the input array', () => {
    const before = TYPED.map(e => e.id)
    sortCritters(TYPED, 'type', collected)
    expect(TYPED.map(e => e.id)).toEqual(before)
  })

  it('type vocabulary: every ordered slug has a label', () => {
    CRITTER_TYPE_ORDER.forEach(t => expect(typeof CRITTER_TYPE_LABELS[t]).toBe('string'))
  })
})
