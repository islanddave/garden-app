// CAL-1 per-variety weight math — reference-oracle tests (V4-CAL1HARV-001, crucible V100).
// Locks the EXACT math the SQL view + read-path rework must reproduce. No jest-dom (pure functions).
import { describe, it, expect } from 'vitest'
import {
  measuredGrams,
  pooledGramsPerUnit,
  dispersionCV,
  confidenceTier,
  distinctRatios,
  independentN,
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

// ── V4-CAL1INDEP-001 ────────────────────────────────────────────────────────────────────────────
// The defect: cv and COUNT(*) cannot see whether rows describe different observations, so repetition
// bought the top tier. These lock the guard that separates "more rows" from "more evidence".
describe('cal1Weights — independence counting', () => {
  const DAY1 = '2026-08-05T12:00:00Z'
  const DAY2 = '2026-08-06T12:00:00Z'

  it('distinctRatios sees through count-weighting: 3/2 and 9/6 are one answer', () => {
    expect(distinctRatios([{ total_grams: 3, unit_count: 2 }, { total_grams: 9, unit_count: 6 }])).toBe(1)
    expect(distinctRatios([{ total_grams: 3, unit_count: 2 }, { total_grams: 10, unit_count: 6 }])).toBe(2)
  })

  it('same instant + same ratio is ONE observation however many rows recorded it', () => {
    const dup = [
      { total_grams: 50, unit_count: 5, sampled_at: DAY1 },
      { total_grams: 50, unit_count: 5, sampled_at: DAY1 },
    ]
    expect(dup.length).toBe(2)
    expect(independentN(dup)).toBe(1)
  })

  it('same ratio on DIFFERENT days is two observations', () => {
    expect(independentN([
      { total_grams: 3, unit_count: 2, sampled_at: DAY1 },
      { total_grams: 9, unit_count: 6, sampled_at: DAY2 },
    ])).toBe(2)
  })

  it('a cross-unit twin cannot corroborate its own group (fail closed)', () => {
    expect(independentN([{ total_grams: 30, unit_count: 2, sampled_at: DAY1, crossunit_twin: true }])).toBe(0)
  })

  // This is the reference oracle for a view over user data: bad input must degrade, not throw.
  it('an unparseable sampled_at degrades instead of crashing', () => {
    expect(() => independentN([{ total_grams: 10, unit_count: 1, sampled_at: 'not-a-date' }])).not.toThrow()
    // distinct junk timestamps stay distinct rather than all collapsing together
    expect(independentN([
      { total_grams: 10, unit_count: 1, sampled_at: 'junk-a' },
      { total_grams: 10, unit_count: 1, sampled_at: 'junk-b' },
    ])).toBe(2)
  })

  // Equal instants expressed differently must still collapse — a key built from the raw string
  // would treat these as two observations and let the duplicate through.
  it('normalises timestamp representation before comparing', () => {
    expect(independentN([
      { total_grams: 50, unit_count: 5, sampled_at: '2026-08-05T12:00:00Z' },
      { total_grams: 50, unit_count: 5, sampled_at: '2026-08-05T08:00:00-04:00' },
    ])).toBe(1)
  })
})

describe('cal1Weights — confidence is no longer bought by repetition', () => {
  const DAY1 = '2026-08-05T12:00:00Z'
  const DAY2 = '2026-08-06T12:00:00Z'

  // THE DEFECT, as a test. Pre-guard this pair gave cv=0 -> 'high'.
  it('one weighing written twice is provisional, not high', () => {
    const dup = [
      { total_grams: 50, unit_count: 5, sampled_at: DAY1 },
      { total_grams: 50, unit_count: 5, sampled_at: DAY1 },
    ]
    expect(dispersionCV(dup)).toBeCloseTo(0, 6) // cv still says "perfectly tight"...
    expect(confidenceTier(dup)).toBe('provisional') // ...and is no longer believed
  })

  it('five duplicate rows do not reach the n>=5 accumulation hatch', () => {
    const five = Array.from({ length: 5 }, () => ({ total_grams: 20, unit_count: 4, sampled_at: DAY1 }))
    const d = deriveCultivarWeight(five)
    expect(d.sample_n).toBe(5)
    expect(d.independent_n).toBe(1)
    expect(d.confidence).toBe('provisional')
    expect(d.usable_for_comparison).toBe(false)
  })

  // The live Pineapple Tomatillo shape: genuinely separate weighings that agree exactly.
  it('independent weighings with an identical ratio are capped at medium, never high', () => {
    const d = deriveCultivarWeight([
      { total_grams: 3, unit_count: 2, sampled_at: DAY1 },
      { total_grams: 9, unit_count: 6, sampled_at: DAY2 },
    ])
    expect(d.independent_n).toBe(2)
    expect(d.distinct_ratios).toBe(1)
    expect(d.cv).toBeCloseTo(0, 6)
    expect(d.confidence).toBe('medium')
    // still corroborated: two real weighings of the right cultivar keep their promotion
    expect(d.usable_for_comparison).toBe(true)
  })

  it('the cv ladder above the guard is untouched', () => {
    const tight = [
      { total_grams: 100, unit_count: 10, sampled_at: DAY1 },
      { total_grams: 102, unit_count: 10, sampled_at: DAY2 },
    ]
    expect(confidenceTier(tight)).toBe('high')
    const wide = [
      { total_grams: 100, unit_count: 10, sampled_at: DAY1 },
      { total_grams: 300, unit_count: 10, sampled_at: DAY2 },
    ]
    expect(confidenceTier(wide)).toBe('low')
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
    expect(d.independent_n).toBe(2)
    expect(d.distinct_ratios).toBe(2)
  })
})

describe('cal1Weights — resolveEstimatedWeight (resolution order; NULL beats a guess)', () => {
  // 10 g/unit pooled, usable. Two DIFFERENT ratios (9 and 11) on purpose: the original fixture used two
  // identical rows, which post-V4-CAL1INDEP-001 is one observation, not a usable n=2 — it was testing
  // the resolution order through a sample set that no longer qualifies to be resolved.
  const usable = deriveCultivarWeight([
    { total_grams: 90, unit_count: 10, sampled_at: '2026-08-05T12:00:00Z' },
    { total_grams: 110, unit_count: 10, sampled_at: '2026-08-06T12:00:00Z' },
  ])
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
