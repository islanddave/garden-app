import { describe, it, expect } from 'vitest'
import {
  SPECIES_POOL, BASELINE_RESIDENTS, EARNED_POOL, BY_ID,
  SMOKE_SENTINEL_SPECIES_ID, pickSpecies, pickCopyVariant,
} from '../lib/critterSpecies.js'

// V102 (2026-06-01, L-102 owner-override): the full ~168-critter roster is earnable.
// One unified pool, integer species_id 1..168. MVP ids 1-8 PRESERVE their original critters.
// Light tiers by roster group: wild=common (w3), legacy=uncommon (w2), cryptid=rare (w1).
// Variable-ratio kept: pickSpecies returns null for ~52.5% of seeds (overall award rate ≈ 0.475).

describe('SPECIES_POOL — full earnable catalog (V102)', () => {
  it('contains exactly 168 species with contiguous IDs 1..168', () => {
    expect(SPECIES_POOL).toHaveLength(168)
    const ids = SPECIES_POOL.map(s => s.species_id).sort((a, b) => a - b)
    expect(ids[0]).toBe(1)
    expect(ids[ids.length - 1]).toBe(168)
    expect(new Set(ids).size).toBe(168) // unique
  })
  it('has 0 baselines + all 168 in the earned pool', () => {
    expect(BASELINE_RESIDENTS).toHaveLength(0)
    expect(EARNED_POOL).toHaveLength(168)
  })
  it('frozen — cannot be mutated', () => {
    expect(Object.isFrozen(SPECIES_POOL)).toBe(true)
    expect(Object.isFrozen(SPECIES_POOL[0])).toBe(true)
  })
  it('preserves the original MVP ids 1-8 (existing collections do not scramble)', () => {
    expect(BY_ID[1].sprite_filename).toBe('C013-american-robin.svg')
    expect(BY_ID[2].sprite_filename).toBe('C001-honeybee.svg')
    expect(BY_ID[3].sprite_filename).toBe('C050-blue-jay.svg')
    expect(BY_ID[8].sprite_filename).toBe('C007-ruby-throated-hummingbird.svg')
  })
  it('BY_ID covers every species (168 keys) and excludes the sentinel', () => {
    expect(Object.keys(BY_ID).length).toBe(168)
    expect(BY_ID[168]).toBeTruthy()
    expect(BY_ID[255]).toBeUndefined()
  })
  it('smoke sentinel is 255 (out of pool range)', () => {
    expect(SMOKE_SENTINEL_SPECIES_ID).toBe(255)
  })
  it('tier follows roster group: wild=common, legacy=uncommon, cryptid=rare', () => {
    const expectedTier = { wild: 'common', legacy: 'uncommon', cryptid: 'rare' }
    for (const s of SPECIES_POOL) {
      expect(s.tier, `${s.sprite_filename}`).toBe(expectedTier[s.group])
    }
  })
  it('tier counts match the roster (common 144 / uncommon 13 / rare 11)', () => {
    const c = { common: 0, uncommon: 0, rare: 0 }
    for (const s of SPECIES_POOL) c[s.tier]++
    expect(c).toEqual({ common: 144, uncommon: 13, rare: 11 })
  })
  it('base_weights are 3/2/1 by tier and sum to 469', () => {
    const sum = EARNED_POOL.reduce((a, s) => a + s.base_weight, 0)
    expect(sum).toBe(469)
    const byTier = (t) => EARNED_POOL.filter(s => s.tier === t).reduce((a, s) => a + s.base_weight, 0)
    expect(byTier('common')).toBe(432)   // 144 * 3
    expect(byTier('uncommon')).toBe(26)  // 13 * 2
    expect(byTier('rare')).toBe(11)      // 11 * 1
  })
  it('overall award probability (sum of base_probability) ≈ 0.475', () => {
    const total = EARNED_POOL.reduce((a, s) => a + s.base_probability, 0)
    expect(total).toBeGreaterThan(0.47)
    expect(total).toBeLessThan(0.48)
  })
  it('every sprite filename is a wild/legacy/cryptid roster sprite', () => {
    for (const s of SPECIES_POOL) {
      expect(s.sprite_filename).toMatch(/^[CLY]\d{3}-[a-z0-9-]+\.svg$/)
    }
  })
})

describe('pickSpecies — deterministic + full-pool draw', () => {
  it('returns same species for same seed (determinism)', () => {
    const s1 = pickSpecies('event-uuid-a|2026-05-28T12:00:00Z|user-abc')
    const s2 = pickSpecies('event-uuid-a|2026-05-28T12:00:00Z|user-abc')
    expect(s1).toBe(s2)
  })
  it('returns a species_id in [1, 168] or null (variable-ratio no-award)', () => {
    for (let i = 0; i < 500; i++) {
      const id = pickSpecies(`seed-${i}-x`)
      if (id === null) continue
      expect(id).toBeGreaterThanOrEqual(1)
      expect(id).toBeLessThanOrEqual(168)
    }
  })
  it('every one of the 168 species is reachable over many draws', () => {
    const seen = new Set()
    for (let i = 0; i < 40000; i++) {
      const id = pickSpecies(`reach-${i}`)
      if (id != null) seen.add(id)
    }
    expect(seen.size).toBe(168)
  })
  it('throws on empty or non-string seed', () => {
    expect(() => pickSpecies('')).toThrow()
    expect(() => pickSpecies(null)).toThrow()
    expect(() => pickSpecies(123)).toThrow()
  })
  it('user prefs modulate distribution — a loved species dominates when others suppressed', () => {
    const prefs = {}
    for (let i = 1; i <= 168; i++) prefs[i] = 0.001
    prefs[3] = 10
    const counts = {}
    let awarded = 0
    for (let i = 0; i < 5000; i++) {
      const id = pickSpecies(`loved-seed-${i}`, prefs)
      if (id === null) continue
      awarded++
      counts[id] = (counts[id] ?? 0) + 1
    }
    expect(awarded).toBeGreaterThan(0)
    expect(counts[3]).toBeGreaterThan(awarded * 0.85)
  })
  it('award distribution follows light tiers (~92/5.5/2.3 of awards: common/uncommon/rare)', () => {
    const counts = { common: 0, uncommon: 0, rare: 0 }
    let awarded = 0
    const N = 20000
    for (let i = 0; i < N; i++) {
      const id = pickSpecies(`uniform-seed-${i}`)
      if (id === null) continue
      awarded++
      counts[BY_ID[id].tier]++
    }
    const pct = (n) => (n / awarded) * 100
    expect(awarded).toBeGreaterThan(0)
    expect(pct(counts.common)).toBeGreaterThan(86)
    expect(pct(counts.common)).toBeLessThan(97)
    expect(pct(counts.uncommon)).toBeGreaterThan(2)
    expect(pct(counts.uncommon)).toBeLessThan(10)
    expect(pct(counts.rare)).toBeGreaterThan(1)
    expect(pct(counts.rare)).toBeLessThan(6)
  })
  it('roughly half of events award no critter (variable-ratio ≈ 47.5% award rate)', () => {
    let awarded = 0
    const N = 20000
    for (let i = 0; i < N; i++) {
      if (pickSpecies(`rate-seed-${i}`) != null) awarded++
    }
    const rate = awarded / N
    expect(rate).toBeGreaterThan(0.42)
    expect(rate).toBeLessThan(0.53)
  })
  it('ignores garbage prefs gracefully (non-finite, negative, NaN)', () => {
    const garbage = { 3: NaN, 4: -1, 5: Infinity, 6: 'foo', 7: null, 8: undefined }
    const id = pickSpecies('garbage-seed', garbage)
    if (id !== null) {
      expect(id).toBeGreaterThanOrEqual(1)
      expect(id).toBeLessThanOrEqual(168)
    }
  })
})

describe('pickCopyVariant — deterministic, decorrelated from pickSpecies', () => {
  it('returns same variant for same seed', () => {
    expect(pickCopyVariant('seed-x', 10)).toBe(pickCopyVariant('seed-x', 10))
  })
  it('returns integer in [0, poolSize)', () => {
    for (let i = 0; i < 100; i++) {
      const v = pickCopyVariant(`s-${i}`, 10)
      expect(Number.isInteger(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(10)
    }
  })
  it('respects custom poolSize', () => {
    const v = pickCopyVariant('seed-z', 3)
    expect(v).toBeLessThan(3)
  })
})
