import { describe, it, expect } from 'vitest'
import { computeMaturity } from '../lib/plantingMaturity.js'

describe('computeMaturity', () => {
  it('returns all-null for a planting with no dates', () => {
    const m = computeMaturity({ variety_ref: null }, new Date('2026-06-26'))
    expect(m.ageDays).toBeNull()
    expect(m.harvestWindowLabel).toBeNull()
    expect(m.isMature).toBeNull()
  })

  it('is null-safe for null planting', () => {
    expect(computeMaturity(null).ageDays).toBeNull()
  })

  it('ages from the most-advanced lifecycle date (transplanted over sown)', () => {
    const m = computeMaturity({ sown_at: '2026-02-01', transplanted_at: '2026-04-15' }, new Date('2026-04-25T00:00:00Z'))
    expect(m.anchorLabel).toBe('transplanted')
    expect(m.ageDays).toBe(10)
  })

  it('falls back to sown when no later date exists', () => {
    const m = computeMaturity({ sown_at: '2026-06-01' }, new Date('2026-06-11T00:00:00Z'))
    expect(m.anchorLabel).toBe('sown')
    expect(m.ageDays).toBe(10)
  })

  it('computes a harvest window from days_to_maturity (counted from sow)', () => {
    const m = computeMaturity(
      { sown_at: '2026-03-01', variety_ref: { days_to_maturity_min: 60, days_to_maturity_max: 70 } },
      new Date('2026-03-15T00:00:00Z'),
    )
    expect(m.isMature).toBe(false)
    expect(m.harvestWindowLabel).toMatch(/Est\. harvest/)
    expect(m.pctToMaturity).toBeGreaterThan(0)
    expect(m.pctToMaturity).toBeLessThan(1)
  })

  it('flags maturity reached once past the min window', () => {
    const m = computeMaturity(
      { sown_at: '2026-01-01', variety_ref: { days_to_maturity_min: 60, days_to_maturity_max: 70 } },
      new Date('2026-06-01T00:00:00Z'),
    )
    expect(m.isMature).toBe(true)
    expect(m.harvestWindowLabel).toBe('Maturity window reached')
    expect(m.pctToMaturity).toBe(1)
  })
})
