// CAL-1 per-variety weight math — reference-oracle tests (V4-CAL1HARV-001, crucible V100).
// Locks the EXACT math the SQL view + read-path rework must reproduce. No jest-dom (pure functions).
import { describe, it, expect } from 'vitest'
import {
  measuredGrams,
  pooledGramsPerUnit,
  dispersionCV,
  confidenceTier,
  deriveCultivarWeight,
  resolveEstimatedWeight,
} from '../lib/cal1Weights.js'

describe('cal1Weights — measuredGrams (measured path)', () => {
  it('converts weight units', () => {
    expect(measuredGrams('g', 100)).toBe(100)
    expect(measuredGrams('kg', 2)).toBe(2000)
    expect(measuredGrams('lb', 1)).toBeCloseTo(453.592, 3)
    expect(measuredGrams('oz', 4)).toBeCloseTo(113.398, 2)
  })
  it('null for non-weight units and bad qty', () => {
    expect(measuredGrams('count', 5)).toBeNull()
    expect(measuredGrams('cup', 1)).toBeNull()
    expect(measuredGrams('g', -1)).toBeNull()
    expect(measuredGrams('g', NaN)).toBeNull()
  })
})

describe('cal1Weights — pooledGramsPerUnit (count-weighted, NOT mean-of-ratios)', () => {
  it('null when no usable samples', () => {
    expect(pooledGramsPerUnit([])).toBeNull()
    expect(pooledGramsPerUnit(null)).toBeNull()
    expect(pooledGramsPerUnit([{ total_grams: 0, unit_count: 5 }])).toBeNull()
  })
  it('single sample = its ratio', () => {
    expect(pooledGramsPerUnit([{ total_grams: 220, unit_count: 12 }])).toBeCloseTo(18.333, 3)
  })
  it('count-weights (weights the larger-count sample more)', () => {
    const s = [{ total_grams: 220, unit_count: 12 }, { total_grams: 300, unit_count: 15 }]
    expect(pooledGramsPerUnit(s)).toBeCloseTo(520 / 27, 5) // 19.259, NOT the mean-of-ratios 19.167
    expect(pooledGramsPerUnit(s)).not.toBeCloseTo((220 / 12 + 300 / 15) / 2, 3)
  })
  it('skips invalid rows (<=0, non-numeric)', () => {
    const s = [{ total_grams: 220, unit_count: 12 }, { total_grams: -5, unit_count: 2 }, { total_grams: 100, unit_count: 'x' }]
    expect(pooledGramsPerUnit(s)).toBeCloseTo(18.333, 3)
  })
})

describe('cal1Weights — dispersionCV', () => {
  it('null for n < 2', () => {
    expect(dispersionCV([{ total_grams: 220, unit_count: 12 }])).toBeNull()
    expect(dispersionCV([])).toBeNull()
  })
  it('0 for identical ratios', () => {
    expect(dispersionCV([{ total_grams: 100, unit_count: 10 }, { total_grams: 200, unit_count: 20 }])).toBeCloseTo(0, 6)
  })
  it('> 0 for varying ratios', () => {
    expect(dispersionCV([{ total_grams: 100, unit_count: 10 }, { total_grams: 300, unit_count: 10 }])).toBeGreaterThan(0)
  })
})

describe('cal1Weights — confidenceTier (dispersion + min-n)', () => {
  it('provisional below min-n', () => {
    expect(confidenceTier([{ total_grams: 100, unit_count: 10 }])).toBe('provisional')
  })
  it('high for tight spread', () => {
    expect(confidenceTier([{ total_grams: 100, unit_count: 10 }, { total_grams: 102, unit_count: 10 }])).toBe('high')
  })
  it('low for wide spread', () => {
    expect(confidenceTier([{ total_grams: 100, unit_count: 10 }, { total_grams: 300, unit_count: 10 }])).toBe('low')
  })
  it('respects a custom minN', () => {
    expect(confidenceTier([{ total_grams: 100, unit_count: 10 }, { total_grams: 102, unit_count: 10 }], { minN: 3 })).toBe('provisional')
  })
})

describe('cal1Weights — deriveCultivarWeight (mirrors the view row)', () => {
  it('null when no usable samples', () => {
    expect(deriveCultivarWeight([])).toBeNull()
    expect(deriveCultivarWeight([{ total_grams: 0, unit_count: 1 }])).toBeNull()
  })
  it('n=1 provisional, not usable for comparison', () => {
    const d = deriveCultivarWeight([{ total_grams: 220, unit_count: 12 }])
    expect(d.sample_n).toBe(1)
    expect(d.usable_for_comparison).toBe(false)
    expect(d.confidence).toBe('provisional')
    expect(d.grams_per_unit).toBeCloseTo(18.333, 3)
    expect(d.cv).toBeNull()
  })
  it('n>=2 tight -> usable, high', () => {
    const d = deriveCultivarWeight([{ total_grams: 100, unit_count: 10 }, { total_grams: 102, unit_count: 10 }])
    expect(d.usable_for_comparison).toBe(true)
    expect(d.confidence).toBe('high')
    expect(d.total_units).toBe(20)
  })
})

describe('cal1Weights — resolveEstimatedWeight (resolution order; NULL beats a guess)', () => {
  const usable = deriveCultivarWeight([{ total_grams: 100, unit_count: 10 }, { total_grams: 100, unit_count: 10 }]) // 10 g/unit, usable
  it('cultivar basis when a usable derived value is present', () => {
    expect(resolveEstimatedWeight({ quantity: 5, derived: usable })).toEqual({ grams: 50, basis: 'cultivar' })
  })
  it('high-variance (required) + no usable derived -> NULL, never crop-type', () => {
    expect(resolveEstimatedWeight({ quantity: 5, derived: null, cropTypeGramsPerUnit: 150, varietyGramsRequired: true }))
      .toEqual({ grams: null, basis: null })
  })
  it('n=1 provisional derived does not qualify -> falls through', () => {
    const prov = deriveCultivarWeight([{ total_grams: 220, unit_count: 12 }])
    expect(resolveEstimatedWeight({ quantity: 5, derived: prov, varietyGramsRequired: true }))
      .toEqual({ grams: null, basis: null })
  })
  it('low-variance (not required) + no usable derived -> crop-type fallback', () => {
    expect(resolveEstimatedWeight({ quantity: 4, derived: null, cropTypeGramsPerUnit: 145, varietyGramsRequired: false }))
      .toEqual({ grams: 580, basis: 'crop_type' })
  })
  it('no derived + no crop-type -> NULL', () => {
    expect(resolveEstimatedWeight({ quantity: 4, derived: null, cropTypeGramsPerUnit: null, varietyGramsRequired: false }))
      .toEqual({ grams: null, basis: null })
  })
  it('negative quantity -> NULL', () => {
    expect(resolveEstimatedWeight({ quantity: -1, derived: usable })).toEqual({ grams: null, basis: null })
  })
})
