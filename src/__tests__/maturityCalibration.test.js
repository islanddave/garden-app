import { describe, it, expect } from 'vitest'
import {
  calibrateFromTransplant, SITE_FACTOR, HALF_WIDTH_DAYS, CALIBRATION_BASIS,
} from '../lib/maturityCalibration.js'
import { computeMaturity } from '../lib/plantingMaturity.js'

describe('calibrateFromTransplant', () => {
  it('scales both catalogue ends by the site factor and widens by the half-width', () => {
    // 70/80 DTM -> round(49)-14 = 35 .. round(56)+14 = 70
    expect(calibrateFromTransplant('from-transplant', 70, 80)).toEqual({ loDays: 35, hiDays: 70 })
  })

  it('applies ONLY to from-transplant — from-sow and uncurated are untouched', () => {
    expect(calibrateFromTransplant('from-sow', 70, 80)).toBeNull()
    expect(calibrateFromTransplant(null, 70, 80)).toBeNull()
    expect(calibrateFromTransplant(undefined, 70, 80)).toBeNull()
  })

  it('falls back to the single populated end when min or max is missing', () => {
    expect(calibrateFromTransplant(CALIBRATION_BASIS, 60, null)).toEqual({ loDays: 28, hiDays: 56 })
    expect(calibrateFromTransplant(CALIBRATION_BASIS, null, 60)).toEqual({ loDays: 28, hiDays: 56 })
  })

  it('returns null when there is no DTM at all', () => {
    expect(calibrateFromTransplant(CALIBRATION_BASIS, null, null)).toBeNull()
  })

  it('never opens the window on or before the transplant date itself', () => {
    // 0.70*10 - 14 would be negative; floored at 1.
    expect(calibrateFromTransplant(CALIBRATION_BASIS, 10, 10).loDays).toBe(1)
  })

  it('holds the constants the derivation was validated against', () => {
    expect(SITE_FACTOR).toBe(0.70)
    expect(HALF_WIDTH_DAYS).toBe(14)
  })
})

describe('computeMaturity — Slice D site calibration', () => {
  const transplantCrop = (dtmMin, dtmMax) => ({
    transplanted_at: '2026-06-01',
    variety_ref: { dtm_basis: 'from-transplant', days_to_maturity_min: dtmMin, days_to_maturity_max: dtmMax },
  })

  it('calibrates a from-transplant window and flags it', () => {
    const m = computeMaturity(transplantCrop(70, 80), new Date('2026-06-02T00:00:00'))
    expect(m.calibrated).toBe(true)
    expect(m.calibrationFactor).toBe(0.70)
    // anchor 2026-06-01 + 35d = 2026-07-06 ; + 70d = 2026-08-10
    expect(m.maturityMinDate.toISOString().slice(0, 10)).toBe('2026-07-06')
    expect(m.maturityMaxDate.toISOString().slice(0, 10)).toBe('2026-08-10')
  })

  it('labels a calibrated window as visibly distinct from a catalogue one', () => {
    const m = computeMaturity(transplantCrop(70, 80), new Date('2026-06-02T00:00:00'))
    expect(m.harvestWindowLabel).toContain('site-calibrated')
    expect(m.harvestWindowLabel).toContain('Est. harvest')
  })

  it('leaves from-sow windows on the raw catalogue dates, unlabelled', () => {
    const m = computeMaturity(
      { sown_at: '2026-06-01', variety_ref: { dtm_basis: 'from-sow', days_to_maturity_min: 70, days_to_maturity_max: 80 } },
      new Date('2026-06-02T00:00:00'),
    )
    expect(m.calibrated).toBe(false)
    expect(m.harvestWindowLabel).not.toContain('site-calibrated')
    // 2026-06-01 + 70d = 2026-08-10 — the untouched catalogue value.
    expect(m.maturityMinDate.toISOString().slice(0, 10)).toBe('2026-08-10')
  })

  it('leaves an uncurated (null basis) planting exactly as before — the Slice A no-op holds', () => {
    const m = computeMaturity(
      { sown_at: '2026-06-01', variety_ref: { dtm_basis: null, days_to_maturity_min: 70, days_to_maturity_max: 80 } },
      new Date('2026-06-02T00:00:00'),
    )
    expect(m.calibrated).toBe(false)
    expect(m.maturityMinDate.toISOString().slice(0, 10)).toBe('2026-08-10')
  })

  it('drives isMature and pctToMaturity off the CALIBRATED opening, not the catalogue one', () => {
    // 2026-07-10 is after the calibrated open (07-06) but well before the catalogue open (08-10).
    const m = computeMaturity(transplantCrop(70, 80), new Date('2026-07-10T00:00:00'))
    expect(m.isMature).toBe(true)
    expect(m.pctToMaturity).toBe(1)
    // An OPEN calibrated window keeps its closing date — collapsing to a bare "Maturity window
    // reached" would discard the +/-14d uncertainty and read as more confident than the catalogue
    // label it replaced.
    expect(m.harvestWindowLabel).toBe('Harvest window open — through Aug 10, 2026 · site-calibrated')
  })

  it('an OPEN uncalibrated (from-sow) window keeps the original wording untouched', () => {
    const m = computeMaturity(
      { sown_at: '2026-06-01', variety_ref: { dtm_basis: 'from-sow', days_to_maturity_min: 10, days_to_maturity_max: 20 } },
      new Date('2026-07-10T00:00:00'),
    )
    expect(m.isMature).toBe(true)
    expect(m.harvestWindowLabel).toBe('Maturity window reached')
  })

  it('still suppresses the window for a from-transplant crop with no transplant date (D3)', () => {
    const m = computeMaturity(
      { sown_at: '2026-04-01', variety_ref: { dtm_basis: 'from-transplant', days_to_maturity_min: 70, days_to_maturity_max: 80 } },
      new Date('2026-06-02T00:00:00'),
    )
    expect(m.awaitingTransplant).toBe(true)
    expect(m.calibrated).toBe(false)
    expect(m.harvestWindowLabel).toBe('Est. harvest — set at transplant')
  })

  it('calibration does not disturb the AGE anchor', () => {
    const m = computeMaturity(transplantCrop(70, 80), new Date('2026-06-11T00:00:00'))
    expect(m.anchorLabel).toBe('transplanted')
    expect(m.ageDays).toBe(10)
  })
})
