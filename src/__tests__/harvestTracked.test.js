// V4-CONSUMABLECLASS-001 (BD-042) — the harvest-tracked gate, and the SYNC GUARD that is the only
// thing making a copied slug list safe.
//
// lib/harvestTracked.js duplicates `not_harvest_tracked.slugs` out of the 29KB
// src/data/harvest-attributes-v1.json so the client bundle does not swallow the whole dataset to
// read one array. A copy with no guard is a copy that drifts — and the drift would be silent and
// one-directional: a slug added to the JSON (as three were on 2026-08-17 and one on 2026-08-20)
// would simply not take effect, and the plant would go on projecting a harvest nobody wanted.
import { describe, it, expect } from 'vitest'
import { isHarvestTracked, plantingIsHarvestTracked, NOT_HARVEST_TRACKED_SLUGS } from '../lib/harvestTracked.js'
import attrs from '../data/harvest-attributes-v1.json'

describe('harvestTracked — sync with the source of truth', () => {
  it('the copied slug list is exactly the JSON list, as a set', () => {
    const source = attrs.not_harvest_tracked.slugs
    expect([...NOT_HARVEST_TRACKED_SLUGS].sort()).toEqual([...source].sort())
  })

  it('the copy has no duplicates — a Set would hide them and the count claim would drift', () => {
    expect(new Set(NOT_HARVEST_TRACKED_SLUGS).size).toBe(NOT_HARVEST_TRACKED_SLUGS.length)
  })

  it('a crop that GRADUATED off the list is tracked again (bee_balm, 2026-08-18)', () => {
    // The contested register carries pre-authored flip conditions, and this one fired: bee_balm was
    // removed from not_harvest_tracked and seeded into by_crop_type. Pinned because it is the
    // living proof the list is revisable rather than a permanent property of a plant.
    expect(NOT_HARVEST_TRACKED_SLUGS).not.toContain('bee_balm')
    expect(isHarvestTracked('bee_balm')).toBe(true)
  })
})

describe('harvestTracked — the gate', () => {
  it('suppresses for the crops Dave named, incl. his live defect case', () => {
    expect(isHarvestTracked('cobaea')).toBe(false)   // the rescued violet on his planting tab
    expect(isHarvestTracked('sedum')).toBe(false)    // "he will never harvest the golden sedum"
    expect(isHarvestTracked('marigold')).toBe(false)
    expect(isHarvestTracked('sunflower')).toBe(false) // class 3, currently NOT tracked
  })

  it('leaves food crops alone', () => {
    for (const slug of ['tomato', 'pepper', 'basil', 'kale', 'potato', 'tomatillo', 'thyme', 'dill']) {
      expect(isHarvestTracked(slug), slug).toBe(true)
    }
  })

  it('DEFAULTS TO TRACKED for unknown, missing or malformed slugs', () => {
    // The direction is the safety property: this gate can only ever REMOVE a harvest claim from a
    // plant somebody positively listed. It must never withhold harvest info from a food crop
    // because a slug was new, absent, or the wrong type.
    expect(isHarvestTracked('newly_minted_crop')).toBe(true)
    expect(isHarvestTracked('')).toBe(true)
    expect(isHarvestTracked(null)).toBe(true)
    expect(isHarvestTracked(undefined)).toBe(true)
    expect(isHarvestTracked(42)).toBe(true)
    expect(isHarvestTracked({})).toBe(true)
  })

  it('reads the slug off a planting, and a bare record is tracked', () => {
    expect(plantingIsHarvestTracked({ variety_ref: { crop_type_slug: 'cobaea' } })).toBe(false)
    expect(plantingIsHarvestTracked({ variety_ref: { crop_type_slug: 'tomato' } })).toBe(true)
    expect(plantingIsHarvestTracked({ variety_ref: null })).toBe(true)
    expect(plantingIsHarvestTracked({})).toBe(true)
    expect(plantingIsHarvestTracked(null)).toBe(true)
  })

  it('is case- and shape-sensitive rather than fuzzy — slugs are exact keys', () => {
    // crop_type_slug is a DB key, not free text. A fuzzy match here would be a second, weaker
    // classifier sitting beside the exact one, and the two would disagree on exactly the rows
    // nobody checks.
    expect(isHarvestTracked('Cobaea')).toBe(true)
    expect(isHarvestTracked(' cobaea')).toBe(true)
  })
})
