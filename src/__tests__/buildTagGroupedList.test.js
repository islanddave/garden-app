import { describe, it, expect } from 'vitest'
import { buildTagGroupedList, tagsForPlanting, UNSORTED_SLUG } from '../lib/projectTree.js'

const tag = (facet, slug, label) => ({ id: `${facet}-${slug}`, facet, slug, label: label || slug, source: 'derived' })
const P = (id, name, extra = {}) => ({ id, name, ...extra })

// tagMap shape mirrors GET /api/entity-tags?entity_type=plant -> { entities: {...} }.entities
const map = {
  p1: { direct: [tag('group', 'herbs', 'Herbs')], projected: [tag('type', 'basil', 'Basil'), tag('lifecycle', 'annual', 'Annual')] },
  p2: { direct: [], projected: [tag('type', 'pepper', 'Pepper')] },
  p3: { direct: [tag('group', 'herbs', 'Herbs'), tag('group', 'shade', 'Shade')], projected: [] },
  // p4 intentionally absent from the map -> untagged
}
const plants = [P('p1', 'Basil'), P('p2', 'Aji'), P('p3', 'Mint'), P('p4', 'Mystery')]

describe('buildTagGroupedList', () => {
  it('returns null when facet is falsy (caller uses the legacy tree)', () => {
    expect(buildTagGroupedList(plants, map, null)).toBeNull()
    expect(buildTagGroupedList(plants, map, '')).toBeNull()
  })

  it('groups by the active facet, alpha by label, Unsorted last', () => {
    const out = buildTagGroupedList(plants, map, 'type')
    expect(out.map(g => g.label)).toEqual(['Basil', 'Pepper', 'Unsorted'])
    expect(out.at(-1).slug).toBe(UNSORTED_SLUG)
    expect(out[0].plantings.map(p => p.id)).toEqual(['p1'])
    // p3 and p4 have no `type` tag -> Unsorted
    expect(out.at(-1).plantings.map(p => p.id).sort()).toEqual(['p3', 'p4'])
    expect(out.at(-1).count).toBe(2)
  })

  it('multi-membership: a planting with two facet tags appears in both groups', () => {
    const out = buildTagGroupedList(plants, map, 'group')
    const byLabel = Object.fromEntries(out.map(g => [g.label, g.plantings.map(p => p.id)]))
    expect(byLabel.Herbs.sort()).toEqual(['p1', 'p3'])
    expect(byLabel.Shade).toEqual(['p3'])
    // p2 + p4 have no group tag -> Unsorted
    expect(byLabel.Unsorted.sort()).toEqual(['p2', 'p4'])
  })

  it('excludes archived plantings', () => {
    const withArchived = [...plants, P('p5', 'Gone', { archived_at: '2026-01-01', })]
    const m2 = { ...map, p5: { direct: [tag('type', 'basil', 'Basil')], projected: [] } }
    const out = buildTagGroupedList(withArchived, m2, 'type')
    expect(out.find(g => g.label === 'Basil').plantings.map(p => p.id)).toEqual(['p1'])
  })

  it('sorts plantings within a group alpha when order=alpha', () => {
    const m3 = { a: { direct: [tag('group', 'x', 'X')], projected: [] }, b: { direct: [tag('group', 'x', 'X')], projected: [] } }
    const out = buildTagGroupedList([P('a', 'Zucchini'), P('b', 'Arugula')], m3, 'group', 'alpha')
    expect(out[0].plantings.map(p => p.name)).toEqual(['Arugula', 'Zucchini'])
  })
})

// V4-HEATSORT-001 / V4-DETSORT-001 / V4-DAYLEN-001 — classification facets sort by canonical order.
describe('buildTagGroupedList — canonical facet ordering', () => {
  // helper: one planting per facet value, added in a deliberately-scrambled order
  const build = (facet, vals) => {
    const m = {}, pl = []
    vals.forEach(([slug, label], i) => {
      const id = `p${i}`
      m[id] = { direct: [tag(facet, slug, label)], projected: [] }
      pl.push(P(id, `Plant ${i}`))
    })
    return buildTagGroupedList(pl, m, facet).map(g => g.slug)
  }

  it('heat: SHU-ascending, not alphabetical', () => {
    // scrambled input -> canonical sweet..superhot
    expect(build('heat', [['hot', 'Hot'], ['sweet', 'Sweet'], ['superhot', 'Superhot'], ['mild', 'Mild'], ['very_hot', 'Very Hot'], ['medium', 'Medium']]))
      .toEqual(['sweet', 'mild', 'medium', 'hot', 'very_hot', 'superhot'])
  })

  it('determinacy: compact -> sprawling', () => {
    expect(build('determinacy', [['indeterminate', 'Indeterminate'], ['dwarf', 'Dwarf'], ['semi_determinate', 'Semi-Determinate'], ['determinate', 'Determinate']]))
      .toEqual(['dwarf', 'determinate', 'semi_determinate', 'indeterminate'])
  })

  it('day_length: photoperiod continuum, day-neutral off-axis last', () => {
    expect(build('day_length', [['long_day', 'Long-Day'], ['day_neutral', 'Day-Neutral'], ['short_day', 'Short-Day'], ['intermediate', 'Intermediate']]))
      .toEqual(['short_day', 'intermediate', 'long_day', 'day_neutral'])
  })

  it('unknown/future slug in an ordered facet sorts AFTER known values (alpha among unknowns), Unsorted still last', () => {
    const m = {
      a: { direct: [tag('heat', 'medium', 'Medium')], projected: [] },
      b: { direct: [tag('heat', 'zzz_future', 'Zzz')], projected: [] },
      c: { direct: [tag('heat', 'aaa_future', 'Aaa')], projected: [] },
      d: { direct: [tag('heat', 'sweet', 'Sweet')], projected: [] },
      // e untagged -> Unsorted
    }
    const out = buildTagGroupedList([P('a'), P('b'), P('c'), P('d'), P('e')], m, 'heat')
    expect(out.map(g => g.slug)).toEqual(['sweet', 'medium', 'aaa_future', 'zzz_future', UNSORTED_SLUG])
  })

  it('facets without a canonical order (e.g. type) keep the alpha default', () => {
    expect(build('type', [['pepper', 'Pepper'], ['basil', 'Basil'], ['tomato', 'Tomato']]))
      .toEqual(['basil', 'pepper', 'tomato'])
  })
})

describe('tagsForPlanting', () => {
  it('flattens direct + projected; empty for unknown id', () => {
    expect(tagsForPlanting(map, 'p1').map(t => `${t.facet}:${t.slug}`)).toEqual(['group:herbs', 'type:basil', 'lifecycle:annual'])
    expect(tagsForPlanting(map, 'nope')).toEqual([])
    expect(tagsForPlanting(null, 'p1')).toEqual([])
  })
})

// V4-GARDENLOCFILTER-001 — structural location grouping (no tags involved).
// Hierarchy mirrors prod: Pasture(zone) > Bag Area/In-Ground(area), Stable(zone) > Indoor Rack > Shelf 4.
const LOCS = [
  { id: 'pasture', name: 'Pasture', parent_id: null, sort_order: 30 },
  { id: 'bagarea', name: 'Bag Area', parent_id: 'pasture', sort_order: 10 },
  { id: 'inground', name: 'In-Ground', parent_id: 'pasture', sort_order: 11 },
  { id: 'stable', name: 'Stable', parent_id: null, sort_order: 10 },
  { id: 'rack', name: 'Indoor Rack', parent_id: 'stable', sort_order: 1 },
  { id: 'shelf4', name: 'Shelf 4', parent_id: 'rack', sort_order: 4 },
  { id: 'shelf5', name: 'Shelf 5', parent_id: 'rack', sort_order: 5 },
]
const LP = [
  P('l1', 'Zucchini', { location_id: 'bagarea' }),
  P('l2', 'Aji', { location_id: 'bagarea' }),
  P('l3', 'Garlic', { location_id: 'inground' }),
  P('l4', 'Basil', { location_id: 'shelf4' }),
  P('l5', 'Hay', { location_id: 'stable' }),   // a parent zone holds its OWN plantings too
  P('l6', 'Homeless', {}),                      // no location_id -> Unsorted
  P('l7', 'Ghost', { location_id: 'deleted-loc' }), // unknown id -> Unsorted, never dropped
]

describe('buildTagGroupedList — location facet', () => {
  it('emits depth-first parent-then-children in sort_order, with depth for indentation', () => {
    const out = buildTagGroupedList(LP, {}, 'location', undefined, LOCS)
    expect(out.map(g => `${'-'.repeat(g.depth)}${g.label}`)).toEqual([
      'Stable', '-Indoor Rack', '--Shelf 4', '--Shelf 5',
      'Pasture', '-Bag Area', '-In-Ground',
      'Unsorted',
    ])
  })

  it('gives a parent only its OWN direct plantings, not its descendants', () => {
    const out = buildTagGroupedList(LP, {}, 'location', undefined, LOCS)
    const by = Object.fromEntries(out.map(g => [g.label, g]))
    expect(by['Stable'].plantings.map(p => p.id)).toEqual(['l5'])
    expect(by['Indoor Rack'].count).toBe(0)
    expect(by['Shelf 4'].plantings.map(p => p.id)).toEqual(['l4'])
    expect(by['Bag Area'].plantings.map(p => p.id)).toEqual(['l2', 'l1']) // alpha: Aji, Zucchini
  })

  it('emits EMPTY locations (Dave 2026-08-05) rather than hiding them', () => {
    const out = buildTagGroupedList(LP, {}, 'location', undefined, LOCS)
    const shelf5 = out.find(g => g.label === 'Shelf 5')
    expect(shelf5).toBeDefined()
    expect(shelf5.count).toBe(0)
    expect(shelf5.plantings).toEqual([])
  })

  it('routes both no-location AND unknown-location plantings to Unsorted, losing none', () => {
    const out = buildTagGroupedList(LP, {}, 'location', undefined, LOCS)
    const last = out.at(-1)
    expect(last.slug).toBe(UNSORTED_SLUG)
    expect(last.isUnsorted).toBe(true)
    expect(last.plantings.map(p => p.id).sort()).toEqual(['l6', 'l7'])
    // Nothing may vanish: every input planting appears exactly once across all groups.
    const seen = out.flatMap(g => g.plantings.map(p => p.id))
    expect(seen.sort()).toEqual(['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7'])
  })

  it('promotes an orphaned location to a root instead of dropping it', () => {
    const orphaned = [...LOCS, { id: 'lost', name: 'Lost Corner', parent_id: 'nonexistent', sort_order: 0 }]
    const out = buildTagGroupedList([P('x', 'Weed', { location_id: 'lost' })], {}, 'location', undefined, orphaned)
    const lost = out.find(g => g.label === 'Lost Corner')
    expect(lost).toBeDefined()
    expect(lost.depth).toBe(0)
    expect(lost.plantings.map(p => p.id)).toEqual(['x'])
  })

  it('survives a parent cycle without infinite recursion', () => {
    const cyclic = [
      { id: 'a', name: 'A', parent_id: 'b', sort_order: 0 },
      { id: 'b', name: 'B', parent_id: 'a', sort_order: 0 },
    ]
    const out = buildTagGroupedList([], {}, 'location', undefined, cyclic)
    expect(out.map(g => g.label).sort()).toEqual(['A', 'B'])
  })

  it('degrades to a single Unsorted group when locations are unavailable (fetch failed)', () => {
    const out = buildTagGroupedList(LP, {}, 'location', undefined, [])
    expect(out).toHaveLength(1)
    expect(out[0].slug).toBe(UNSORTED_SLUG)
    expect(out[0].count).toBe(7)
  })

  it('excludes archived plantings, like every other facet', () => {
    const out = buildTagGroupedList(
      [...LP, P('l8', 'Old', { location_id: 'bagarea', archived_at: '2026-01-01' })], {}, 'location', undefined, LOCS)
    expect(out.find(g => g.label === 'Bag Area').count).toBe(2)
  })
})
