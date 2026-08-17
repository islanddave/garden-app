import { describe, it, expect } from 'vitest'
import {
  calibrateFromTransplant, SITE_FACTOR, HALF_WIDTH_DAYS, CALIBRATION_BASIS,
  CALIBRATION_SAMPLE, ACQUIRED_MATURE_FIELD, isAcquiredMature,
  CALIBRATION_COHORT_EXCLUSION_SQL,
} from '../lib/maturityCalibration.js'
import * as calibration from '../lib/maturityCalibration.js'
import { computeMaturity } from '../lib/plantingMaturity.js'

describe('calibrateFromTransplant', () => {
  it('scales both catalogue ends by the site factor and widens by the half-width', () => {
    // 70/80 DTM -> round(52.5)-14 = 39 .. round(60)+14 = 74
    expect(calibrateFromTransplant('from-transplant', 70, 80)).toEqual({ loDays: 39, hiDays: 74 })
  })

  it('applies ONLY to from-transplant — from-sow and uncurated are untouched', () => {
    expect(calibrateFromTransplant('from-sow', 70, 80)).toBeNull()
    expect(calibrateFromTransplant(null, 70, 80)).toBeNull()
    expect(calibrateFromTransplant(undefined, 70, 80)).toBeNull()
  })

  it('falls back to the single populated end when min or max is missing', () => {
    expect(calibrateFromTransplant(CALIBRATION_BASIS, 60, null)).toEqual({ loDays: 31, hiDays: 59 })
    expect(calibrateFromTransplant(CALIBRATION_BASIS, null, 60)).toEqual({ loDays: 31, hiDays: 59 })
  })

  it('returns null when there is no DTM at all', () => {
    expect(calibrateFromTransplant(CALIBRATION_BASIS, null, null)).toBeNull()
  })

  it('never opens the window on or before the transplant date itself', () => {
    // 0.75*10 - 14 would be negative; floored at 1.
    expect(calibrateFromTransplant(CALIBRATION_BASIS, 10, 10).loDays).toBe(1)
  })

  it('holds the constants the derivation was validated against', () => {
    expect(SITE_FACTOR).toBe(0.75)
    expect(HALF_WIDTH_DAYS).toBe(14)
  })
})

// V4-DROPCALIB-001 — the re-fit of 2026-08-16. The header of maturityCalibration.js states a
// derivation; these tests make the load-bearing parts of it EXECUTABLE, so a future edit that moves
// the factor without redoing the measurement fails here instead of shipping.
describe('site factor re-fit (V4-DROPCALIB-001)', () => {
  it('pins the fitted factor and the sample it was fitted on', () => {
    expect(SITE_FACTOR).toBe(0.75)
    expect(CALIBRATION_SAMPLE).toEqual({
      n: 35, factorSe: 0.025, residualRmsDays: 10.78, inWindow: 31,
      season: 2026, derivedOn: '2026-08-16',
    })
    // The fitted centre is 0.7504 with SE 0.0246, so the shipped 2 dp value must sit inside one SE
    // of it. This is the guard that catches a factor edited to a round number by hand.
    expect(Math.abs(SITE_FACTOR - 0.7504)).toBeLessThan(CALIBRATION_SAMPLE.factorSe)
  })

  // The n=35 cohort itself, read read-only from live prod Neon 2026-08-16: every live
  // from-transplant planting with a transplant anchor, a catalogue DTM and at least one non-probe
  // harvest, minus the 2 structural outliers and the 4 probe-only plants. [name, dtmMin, dtmMax,
  // observed days from transplant to first non-probe harvest].
  const COHORT = [
    ['1884', 78, 85, 60],
    ['Anaheim', 75, 90, 54],
    ['Armageddon', 75, 95, 74],
    ['Big Boy Slicer Tomato', 78, 80, 43],
    ['Black Cherry', 64, 65, 58],
    ['Capeliente', 70, 85, 37],
    ['Cayenne Blend', 68, 68, 40],
    ['Celebrity Slicer Tomato', 70, 75, 44],
    ['Cherokee Green', 75, 85, 67],
    ['Cherry Hot', 75, 80, 44],
    ['Cherry Stuffer', 73, 73, 66],
    ['Cubanelle', 62, 80, 36],
    ['Del Tonet', 75, 75, 68],
    ['Delicious Slicer', 77, 77, 56],
    ["Gatherer's Gold", 70, 100, 55],
    ['Granadero', 73, 73, 64],
    ['Green Magic', 57, 60, 29],
    ['Jet Star', 72, 72, 63],
    ['King Richard', 75, 80, 53],
    ['Kori Sitakame', 80, 90, 44],
    ['Manitoba', 58, 65, 53],
    ['Oregon Spring', 58, 68, 43],
    ['Piri Piri', 60, 90, 47],
    ['Purple Blush Tomatillo', 70, 75, 55],
    ['Red Mini Bell', 60, 75, 56],
    ['Ristra Cayenne II', 75, 90, 68],
    ['Rosso Sicilian', 75, 85, 61],
    ['Serranos', 75, 85, 55],
    ['Speckled Roman', 78, 85, 71],
    ['Sub Arctic Plenty', 55, 60, 46],
    ['Sunray', 72, 80, 50],
    ['Super Sweet 100', 65, 70, 45],
    ['Tatli Kil Sivri', 70, 80, 59],
    ['Ukrainian Purple', 75, 80, 50],
    ['Yellow Onions', 100, 120, 43],
  ]
  const hits = (rows, predicate) => rows.filter(predicate).length
  const inCalibrated = ([, dmin, dmax, obs]) => {
    const { loDays, hiDays } = calibrateFromTransplant(CALIBRATION_BASIS, dmin, dmax)
    return obs >= loDays && obs <= hiDays
  }

  it('the cohort is the one CALIBRATION_SAMPLE claims', () => {
    expect(COHORT).toHaveLength(CALIBRATION_SAMPLE.n)
  })

  it('the shipped window contains the observed first harvest 31 times in 35', () => {
    expect(hits(COHORT, inCalibrated)).toBe(CALIBRATION_SAMPLE.inWindow)
  })

  // The claim that matters for V4-DROPCALIB-001: dropping calibration for the raw catalogue window
  // is not a neutral simplification, it is a collapse. Same cohort, same question.
  it('the RAW catalogue window contains it zero times — this is why calibration is not dropped', () => {
    expect(hits(COHORT, ([, dmin, dmax, obs]) => obs >= dmin && obs <= dmax)).toBe(0)
  })

  // Every one of the 4 misses is at the FLOOR, and three of them by 1-2 days. The band is not
  // failing in the direction (weeks early) that filed V4-HARVWINDOW-001.
  it('every miss is an early pick, and only one misses by more than 2 days', () => {
    const misses = COHORT.filter(r => !inCalibrated(r)).map(([name, dmin, dmax, obs]) => {
      const { loDays, hiDays } = calibrateFromTransplant(CALIBRATION_BASIS, dmin, dmax)
      return { name, under: loDays - obs, over: obs - hiDays }
    })
    expect(misses).toHaveLength(4)
    expect(misses.every(m => m.under > 0 && m.over < 0)).toBe(true)
    expect(misses.filter(m => m.under > 2).map(m => m.name)).toEqual(['Yellow Onions'])
  })

})

// V4-ACQMATURE-001 — the exclusion mechanism, now a predicate over plants.acquired_mature instead
// of a hand-maintained array of display names. These tests assert the PREDICATE, not the names:
// pinning ['Ghost','Shallots'] was the old test's actual defect, because it went green whether or
// not the mechanism could ever catch a THIRD such planting, and it stayed green through a rename
// that had already stopped the list matching one of its own entries.
describe('acquired-mature exclusion (V4-ACQMATURE-001)', () => {
  it('the hand-maintained STRUCTURAL_OUTLIERS list is gone, not merely unused', () => {
    expect(calibration.STRUCTURAL_OUTLIERS).toBeUndefined()
    expect(Object.keys(calibration)).not.toContain('STRUCTURAL_OUTLIERS')
  })

  it('excludes only an explicit true — NULL and undefined are "never asked", not "no"', () => {
    expect(isAcquiredMature({ acquired_mature: true })).toBe(true)
    expect(isAcquiredMature({ acquired_mature: false })).toBe(false)
    expect(isAcquiredMature({ acquired_mature: null })).toBe(false)
    // A planting object fetched before the column existed carries neither key nor value. It must
    // stay IN the cohort, exactly as it was under the name list.
    expect(isAcquiredMature({})).toBe(false)
    expect(isAcquiredMature(undefined)).toBe(false)
    expect(isAcquiredMature(null)).toBe(false)
  })

  it('does not coerce — a truthy look-alike is not a verdict', () => {
    for (const v of ['true', 1, 'yes', {}, []]) {
      expect(isAcquiredMature({ acquired_mature: v }), `${JSON.stringify(v)} must not exclude`).toBe(false)
    }
  })

  it('names the column the migration actually ships', () => {
    expect(ACQUIRED_MATURE_FIELD).toBe('acquired_mature')
    // IS NOT TRUE, so an un-asked planting stays in the cohort. `= false` would silently shrink the
    // cohort to only the plantings Dave has explicitly cleared — 2 of 261 today.
    expect(CALIBRATION_COHORT_EXCLUSION_SQL).toBe('gn.acquired_mature IS NOT TRUE')
    expect(CALIBRATION_COHORT_EXCLUSION_SQL).not.toMatch(/=\s*false/)
  })

  // THE REGRESSION THIS WHOLE CHANGE HAS TO SURVIVE: swapping the mechanism must not move the
  // number. Measured against live prod 2026-08-17 on the same cohort query, only the exclusion
  // changed: by name n=35 factor 0.7504 sd 0.1453; by flag n=35 factor 0.7504 sd 0.1453; with no
  // structural exclusion at all n=37 factor 0.7158. The two rows the flag is backfilled onto are
  // the two the list named, so the fit is byte-identical on day one.
  it('the shipped factor still sits inside one SE of the fitted centre after the swap', () => {
    expect(SITE_FACTOR).toBe(0.75)
    expect(CALIBRATION_SAMPLE.n).toBe(35)
    expect(Math.abs(SITE_FACTOR - 0.7504)).toBeLessThan(CALIBRATION_SAMPLE.factorSe)
  })

  // The excluded pair applied to the predicate: both are far below the cohort they were removed
  // from (next-lowest survivor 0.430), so this is a different population, not a tail. Expressed as
  // planting-shaped records because that is what the predicate consumes now.
  it('the two backfilled rows are excluded, and the cohort floor is not', () => {
    const ghost = { name: 'Ghost', acquired_mature: true, observedDays: 10, dtm: 100 }
    const shallots = { name: 'Shallots', acquired_mature: true, observedDays: 11, dtm: 90 }
    const onions = { name: 'Yellow Onions', acquired_mature: null, observedDays: 43, dtm: 100 }
    for (const r of [ghost, shallots]) {
      expect(isAcquiredMature(r)).toBe(true)
      expect(r.observedDays / r.dtm).toBeLessThan(0.2)
    }
    // Yellow Onions is the largest surviving residual and is deliberately NOT this class — a bulb
    // crop pulled young, sown on site. Flagging it would be fitting the exclusion to the answer,
    // and the describe above still counts it as one of the 35 and as the one miss over 2 days.
    expect(isAcquiredMature(onions)).toBe(false)
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
    expect(m.calibrationFactor).toBe(0.75)
    // anchor 2026-06-01 + 39d = 2026-07-10 ; + 74d = 2026-08-14
    expect(m.maturityMinDate.toISOString().slice(0, 10)).toBe('2026-07-10')
    expect(m.maturityMaxDate.toISOString().slice(0, 10)).toBe('2026-08-14')
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
    // 2026-07-20 is after the calibrated open (07-10) but well before the catalogue open (08-10).
    const m = computeMaturity(transplantCrop(70, 80), new Date('2026-07-20T00:00:00'))
    expect(m.isMature).toBe(true)
    expect(m.pctToMaturity).toBe(1)
    // An OPEN calibrated window keeps its closing date — collapsing to a bare "Maturity window
    // reached" would discard the +/-14d uncertainty and read as more confident than the catalogue
    // label it replaced.
    expect(m.harvestWindowLabel).toBe('Harvest window open — through Aug 14, 2026 · site-calibrated')
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
