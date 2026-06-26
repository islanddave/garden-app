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

describe('tagsForPlanting', () => {
  it('flattens direct + projected; empty for unknown id', () => {
    expect(tagsForPlanting(map, 'p1').map(t => `${t.facet}:${t.slug}`)).toEqual(['group:herbs', 'type:basil', 'lifecycle:annual'])
    expect(tagsForPlanting(map, 'nope')).toEqual([])
    expect(tagsForPlanting(null, 'p1')).toEqual([])
  })
})
