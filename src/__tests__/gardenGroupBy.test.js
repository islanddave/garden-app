// src/lib/gardenGroupBy.js — Garden's group-by options (BUG-GARDENGROUPBYRESET-001 extraction).
import { describe, it, expect } from 'vitest'
import { buildGardenFacetOptions, GARDEN_TAG_FACETS } from '../lib/gardenGroupBy.js'

const tagged = (...facets) => ({ p1: { direct: facets.slice(0, 1).map(facet => ({ facet })), projected: facets.slice(1).map(facet => ({ facet })) } })
const values = (opts) => opts.map(o => o.value)

describe('buildGardenFacetOptions — the options Garden\'s group-by control offers', () => {
  it('projects hidden, no tags: Type, Location, Lifecycle — the structural head only', () => {
    expect(buildGardenFacetOptions({}, true)).toEqual([
      { value: 'crop_type', label: 'Type' },
      { value: 'location', label: 'Location' },
      { value: 'status', label: 'Lifecycle' },
    ])
  })
  it('projects shown, no tags: Projects, Location, Lifecycle', () => {
    expect(values(buildGardenFacetOptions(null, false))).toEqual(['none', 'location', 'status'])
  })
  it('tag facets follow the head, in GARDEN_TAG_FACETS order, from direct AND projected tags', () => {
    const opts = buildGardenFacetOptions(tagged('bean_use', 'heat', 'lifecycle', 'freeform'), true)
    expect(values(opts)).toEqual(['crop_type', 'location', 'status', 'lifecycle', 'heat', 'bean_use', 'freeform'])
    expect(opts.find(o => o.value === 'lifecycle').label).toBe('Lifespan')   // the TAG facet; 'status' is "Lifecycle"
  })
  it('the tag "type" facet is replaced by crop_type when projects are hidden, and leads after Projects when shown', () => {
    expect(values(buildGardenFacetOptions(tagged('type'), true))).toEqual(['crop_type', 'location', 'status'])
    expect(values(buildGardenFacetOptions(tagged('type'), false))).toEqual(['none', 'type', 'location', 'status'])
  })
  it('a location-facet tag never duplicates the structural Location option', () => {
    expect(values(buildGardenFacetOptions(tagged('location'), true))).toEqual(['crop_type', 'location', 'status'])
  })
  it('every tag facet present: each listed once, labelled', () => {
    const everyFacet = { p1: { direct: GARDEN_TAG_FACETS.map(facet => ({ facet })) } }
    for (const hidden of [true, false]) {
      const opts = buildGardenFacetOptions(everyFacet, hidden)
      expect(new Set(values(opts)).size).toBe(opts.length)
      expect(opts.every(o => typeof o.label === 'string' && o.label.length > 0)).toBe(true)
      // 11 tag facets (13 less 'type' and 'location', which sit in the head) + the head.
      expect(opts.length).toBe(hidden ? 3 + 11 : 4 + 11)
    }
  })
})
