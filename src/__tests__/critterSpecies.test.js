import { describe, it, expect } from 'vitest'
import {
  SPECIES_POOL, BASELINE_RESIDENTS, EARNED_POOL, BY_ID,
  SMOKE_SENTINEL_SPECIES_ID, pickSpecies, pickCopyVariant,
} from '../lib/critterSpecies.js'

describe('SPECIES_POOL', () => {
  it('contains exactly 8 species with IDs 1-8', () => {
    expect(SPECIES_POOL).toHaveLength(8)
    expect(SPECIES_POOL.map(s => s.species_id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })
  it('has 2 baselines + 6 earned-pool species', () => {
    expect(BASELINE_RESIDENTS).toHaveLength(2)
    expect(BASELINE_RESIDENTS.map(s => s.species_id)).toEqual([1, 2])
    expect(EARNED_POOL).toHaveLength(6)
    expect(EARNED_POOL.map(s => s.species_id)).toEqual([3, 4, 5, 6, 7, 8])
  })
  it('frozen — cannot be mutated', () => {
    expect(Object.isFrozen(SPECIES_POOL)).toBe(true)
    expect(Object.isFrozen(SPECIES_POOL[0])).toBe(true)
  })
  it('BY_ID covers every species', () => {
    expect(Object.keys(BY_ID).length).toBe(8)
    expect(BY_ID[3].name).toBe('Blue jay')
    expect(BY_ID[8].tier).toBe('rare')
  })
  it('earned-pool base_weights sum to 100', () => {
    const sum = EARNED_POOL.reduce((a, s) => a + s.base_weight, 0)
    expect(sum).toBe(100)
  })
  it('tier distribution 60/30/10 per revision §4', () => {
    const byTier = (t) => EARNED_POOL.filter(s => s.tier === t).reduce((a, s) => a + s.base_weight, 0)
    expect(byTier('common')).toBe(60)
    expect(byTier('uncommon')).toBe(30)
    expect(byTier('rare')).toBe(10)
  })
  it('smoke sentinel is 255 (out of pool range)', () => {
    expect(SMOKE_SENTINEL_SPECIES_ID).toBe(255)
    expect(BY_ID[255]).toBeUndefined()
  })
  it('every sprite filename starts with C and ends with .svg', () => {
    for (const s of SPECIES_POOL) {
      expect(s.sprite_filename).toMatch(/^C\d{3}-[a-z-]+\.svg$/)
    }
  })
})

describe('pickSpecies — deterministic + plant-only earned pool', () => {
  it('returns same species for same seed (determinism)', () => {
    const s1 = pickSpecies('event-uuid-a|2026-05-28T12:00:00Z|user-abc')
    const s2 = pickSpecies('event-uuid-a|2026-05-28T12:00:00Z|user-abc')
    expect(s1).toBe(s2)
  })
  it('always returns a species_id in [3, 8] (earned pool only — no baseline)', () => {
    for (let i = 0; i < 200; i++) {
      const id = pickSpecies(`seed-${i}-${Math.random()}`)
      expect(id).toBeGreaterThanOrEqual(3)
      expect(id).toBeLessThanOrEqual(8)
    }
  })
  it('throws on empty or non-string seed', () => {
    expect(() => pickSpecies('')).toThrow()
    expect(() => pickSpecies(null)).toThrow()
    expect(() => pickSpecies(123)).toThrow()
  })
  it('user prefs modulate distribution — loved species ×2, meh species ÷2', () => {
    // With ALL non-loved species set to 0.001 weight, the loved one should dominate.
    const lovedOnlyPrefs = { 3: 1, 4: 0.001, 5: 0.001, 6: 0.001, 7: 0.001, 8: 0.001 }
    const counts = { 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0 }
    for (let i = 0; i < 500; i++) {
      counts[pickSpecies(`seed-${i}`, lovedOnlyPrefs)]++
    }
    expect(counts[3]).toBeGreaterThan(400) // dominant
    // others rare
    const others = counts[4] + counts[5] + counts[6] + counts[7] + counts[8]
    expect(others).toBeLessThan(100)
  })
  it('distribution roughly matches base weights over many draws (60/30/10 ±5)', () => {
    const counts = { common: 0, uncommon: 0, rare: 0 }
    const N = 5000
    for (let i = 0; i < N; i++) {
      const id = pickSpecies(`uniform-seed-${i}`)
      counts[BY_ID[id].tier]++
    }
    const pct = (n) => (n / N) * 100
    expect(pct(counts.common)).toBeGreaterThan(55)
    expect(pct(counts.common)).toBeLessThan(65)
    expect(pct(counts.uncommon)).toBeGreaterThan(25)
    expect(pct(counts.uncommon)).toBeLessThan(35)
    expect(pct(counts.rare)).toBeGreaterThan(5)
    expect(pct(counts.rare)).toBeLessThan(15)
  })
  it('ignores garbage prefs gracefully (non-finite, negative, NaN)', () => {
    const garbage = { 3: NaN, 4: -1, 5: Infinity, 6: 'foo', 7: null, 8: undefined }
    const id = pickSpecies('garbage-seed', garbage)
    expect(id).toBeGreaterThanOrEqual(3)
    expect(id).toBeLessThanOrEqual(8)
  })
})

describe('pickCopyVariant — deterministic, decorrelated from pickSpecies', () => {
  it('returns same variant for same seed', () => {
    expect(pickCopyVariant('seed-x')).toBe(pickCopyVariant('seed-x'))
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
