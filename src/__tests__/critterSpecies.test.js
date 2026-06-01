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
  it('has 0 baselines + 8 earned-pool species (V101 retired baselines)', () => {
    expect(BASELINE_RESIDENTS).toHaveLength(0)
    expect(EARNED_POOL).toHaveLength(8)
    expect(EARNED_POOL.map(s => s.species_id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
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
  it('earned-pool base_weights sum to 140 (V101: +robin+honeybee @20)', () => {
    const sum = EARNED_POOL.reduce((a, s) => a + s.base_weight, 0)
    expect(sum).toBe(140)
  })
  it('tier base_weights 100/30/10 (V101: common now 5×20)', () => {
    const byTier = (t) => EARNED_POOL.filter(s => s.tier === t).reduce((a, s) => a + s.base_weight, 0)
    expect(byTier('common')).toBe(100)
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
  it('returns a species_id in [1, 8] or null (V101: all 8 earnable; null = variable-ratio no-award)', () => {
    for (let i = 0; i < 200; i++) {
      const id = pickSpecies(`seed-${i}-${Math.random()}`)
      if (id === null) continue
      expect(id).toBeGreaterThanOrEqual(1)
      expect(id).toBeLessThanOrEqual(8)
    }
  })
  it('throws on empty or non-string seed', () => {
    expect(() => pickSpecies('')).toThrow()
    expect(() => pickSpecies(null)).toThrow()
    expect(() => pickSpecies(123)).toThrow()
  })
  it('user prefs modulate distribution — loved species dominates when others suppressed', () => {
    // Suppress ALL other species (incl. robin/honeybee 1,2 — now earnable per V101) to 0.001; species 3 loved.
    const lovedOnlyPrefs = { 1: 0.001, 2: 0.001, 3: 1, 4: 0.001, 5: 0.001, 6: 0.001, 7: 0.001, 8: 0.001 }
    const counts = {}
    let awarded = 0
    for (let i = 0; i < 1000; i++) {
      const id = pickSpecies(`seed-${i}`, lovedOnlyPrefs)
      if (id === null) continue
      awarded++
      counts[id] = (counts[id] ?? 0) + 1
    }
    // Of awarded draws, species 3 should be the overwhelming majority.
    expect(awarded).toBeGreaterThan(0)
    expect(counts[3]).toBeGreaterThan(awarded * 0.9)
  })
  it('award distribution matches base probabilities over many draws (V101: ~74/21/5 of awards)', () => {
    // pickSpecies returns null ~52.5% (variable-ratio gate); measure tier split AMONG awards.
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
    expect(pct(counts.common)).toBeGreaterThan(68)
    expect(pct(counts.common)).toBeLessThan(80)
    expect(pct(counts.uncommon)).toBeGreaterThan(15)
    expect(pct(counts.uncommon)).toBeLessThan(27)
    expect(pct(counts.rare)).toBeGreaterThan(2)
    expect(pct(counts.rare)).toBeLessThan(10)
  })
  it('ignores garbage prefs gracefully (non-finite, negative, NaN)', () => {
    const garbage = { 3: NaN, 4: -1, 5: Infinity, 6: 'foo', 7: null, 8: undefined }
    const id = pickSpecies('garbage-seed', garbage)
    if (id !== null) {
      expect(id).toBeGreaterThanOrEqual(1)
      expect(id).toBeLessThanOrEqual(8)
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
