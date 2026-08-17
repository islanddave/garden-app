import { describe, it, expect } from 'vitest'
import { computeMaturity, CONTINUOUS_HARVEST_HABITS } from '../lib/plantingMaturity.js'

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

  // NOTE: the lifecycle anchors below are date-only strings, which computeMaturity
  // parses as LOCAL midnight. `today` must be in the same (local) frame or the day
  // diff shifts by the UTC offset (10 days in UTC/CI, 9 in a UTC-negative TZ like
  // EDT). Pass `today` WITHOUT the trailing Z so both are local-midnight → exact
  // 10-day gap in any timezone. (Wave 0 / WS-B M2: fixes a TZ-fragile assertion.)
  it('ages from the most-advanced lifecycle date (transplanted over sown)', () => {
    const m = computeMaturity({ sown_at: '2026-02-01', transplanted_at: '2026-04-15' }, new Date('2026-04-25T00:00:00'))
    expect(m.anchorLabel).toBe('transplanted')
    expect(m.ageDays).toBe(10)
  })

  it('falls back to sown when no later date exists', () => {
    const m = computeMaturity({ sown_at: '2026-06-01' }, new Date('2026-06-11T00:00:00'))
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

// V4-MATURITYBASIS-001 Slice A. The load-bearing property of this slice is that it is a NO-OP
// until crop_types.dtm_basis is curated: with dtm_basis absent or null, every output field must be
// byte-identical to the pre-basis engine. The Case-A planting below is the real prod shape (7
// peppers sown 2026-04-20, transplanted 2026-06-23 -> a 64-day nursery gap).
describe('computeMaturity — DTM basis (V4-MATURITYBASIS-001)', () => {
  const DTM = { days_to_maturity_min: 70, days_to_maturity_max: 80 }
  const caseA = { sown_at: '2026-04-20', transplanted_at: '2026-06-23' }
  const TODAY = new Date('2026-08-04T00:00:00')

  // maturity dates are LOCAL-midnight + N days; format in the same (local) frame so the
  // assertion cannot shift a day under a positive UTC offset.
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

  const OUTPUT_KEYS = [
    'ageDays', 'anchorField', 'anchorDate', 'anchorLabel',
    'dtmMin', 'dtmMax', 'maturityMinDate', 'maturityMaxDate',
    'harvestWindowLabel', 'isMature', 'pctToMaturity',
  ]
  const legacyShape = (m) => Object.fromEntries(OUTPUT_KEYS.map(k => [k, m[k]]))

  it('NULL basis is byte-identical to no basis field at all', () => {
    const withNull = computeMaturity({ ...caseA, variety_ref: { ...DTM, dtm_basis: null } }, TODAY)
    const without = computeMaturity({ ...caseA, variety_ref: { ...DTM } }, TODAY)
    expect(legacyShape(withNull)).toEqual(legacyShape(without))
    expect(withNull.dtmBasis).toBeNull()
    expect(withNull.basisResolved).toBe(false)
  })

  it('NULL basis anchors DTM on the sow date (today’s behaviour, preserved)', () => {
    const m = computeMaturity({ ...caseA, variety_ref: { ...DTM, dtm_basis: null } }, TODAY)
    // 2026-04-20 + 70d = 2026-06-29
    expect(ymd(m.maturityMinDate)).toBe('2026-06-29')
    expect(ymd(m.maturityMaxDate)).toBe('2026-07-09')
    expect(m.dtmAnchorField).toBe('sown_at')
    expect(m.isMature).toBe(true)
    expect(m.harvestWindowLabel).toBe('Maturity window reached')
  })

  it("'from-sow' is identical to NULL basis", () => {
    const sow = computeMaturity({ ...caseA, variety_ref: { ...DTM, dtm_basis: 'from-sow' } }, TODAY)
    const nul = computeMaturity({ ...caseA, variety_ref: { ...DTM, dtm_basis: null } }, TODAY)
    expect(legacyShape(sow)).toEqual(legacyShape(nul))
    expect(sow.dtmBasis).toBe('from-sow')
    expect(sow.basisResolved).toBe(true)
  })

  // SLICE D UPDATE: this test asserted the RAW catalogue window (2026-09-01 .. 09-11). Slice D
  // calibrates from-transplant windows by the measured site factor, because the raw catalogue
  // window was measured to contain the actual first harvest 0 times out of 21. The window now sits
  // BETWEEN the two old extremes, which is the whole point. Dates re-stated for the 2026-08-16
  // re-fit (V4-DROPCALIB-001, factor 0.70 -> 0.75); the raw-catalogue rate re-measured to 0/35:
  //   sow-anchored (the original bug)   2026-06-29   far too early
  //   calibrated   (re-fit)             2026-08-01   <- 31/35 of observed harvests land in-window
  //   raw catalogue from transplant     2026-09-01   0/35 — too late, told Dave to wait 4 weeks
  it("'from-transplant' calibrates the window between the sow-anchored and raw-catalogue extremes", () => {
    const m = computeMaturity({ ...caseA, variety_ref: { ...DTM, dtm_basis: 'from-transplant' } }, TODAY)
    // anchor 2026-06-23; lo = round(0.75*70)-14 = 39d, hi = round(0.75*80)+14 = 74d
    expect(ymd(m.maturityMinDate)).toBe('2026-08-01')
    expect(ymd(m.maturityMaxDate)).toBe('2026-09-05')
    expect(m.dtmAnchorField).toBe('transplanted_at')
    expect(m.dtmAnchorLabel).toBe('transplant')
    expect(m.calibrated).toBe(true)

    const nul = computeMaturity({ ...caseA, variety_ref: { ...DTM, dtm_basis: null } }, TODAY)
    // Still strictly later than the sow-anchored window this whole change exists to push back...
    expect(m.maturityMinDate > nul.maturityMinDate).toBe(true)
    expect((m.maturityMinDate - nul.maturityMinDate) / 86400000).toBe(33)
    // ...and the calibrated window is strictly wider than the 10-day catalogue span it replaces.
    const span = (m.maturityMaxDate - m.maturityMinDate) / 86400000
    expect(span).toBe(35)
  })

  it("'from-transplant' falls back to planted_out_at when there is no transplant date", () => {
    const m = computeMaturity(
      { sown_at: '2026-04-20', planted_out_at: '2026-06-23', variety_ref: { ...DTM, dtm_basis: 'from-transplant' } },
      TODAY,
    )
    expect(m.dtmAnchorField).toBe('planted_out_at')
    // Slice D: calibrated off the planted_out_at anchor (2026-06-23 + 39d), not the raw 70d.
    expect(ymd(m.maturityMinDate)).toBe('2026-08-01')
    expect(m.calibrated).toBe(true)
  })

  it('D3: from-transplant with NO transplant date suppresses the date instead of guessing', () => {
    const m = computeMaturity({ sown_at: '2026-04-20', variety_ref: { ...DTM, dtm_basis: 'from-transplant' } }, TODAY)
    expect(m.awaitingTransplant).toBe(true)
    expect(m.harvestWindowLabel).toBe('Est. harvest — set at transplant')
    expect(m.maturityMinDate).toBeNull()
    expect(m.maturityMaxDate).toBeNull()
    expect(m.isMature).toBeNull()
    expect(m.pctToMaturity).toBeNull()
    // the AGE band must survive the suppression
    expect(m.anchorLabel).toBe('sown')
    expect(m.ageDays).toBe(106)
  })

  it('the AGE anchor is untouched by basis', () => {
    for (const b of [null, 'from-sow', 'from-transplant']) {
      const m = computeMaturity({ ...caseA, variety_ref: { ...DTM, dtm_basis: b } }, TODAY)
      expect(m.anchorField).toBe('transplanted_at')
      expect(m.anchorLabel).toBe('transplanted')
      expect(m.ageDays).toBe(42)
    }
  })

  it('an unrecognised basis value degrades to from-sow rather than breaking', () => {
    const m = computeMaturity({ ...caseA, variety_ref: { ...DTM, dtm_basis: 'from-moonrise' } }, TODAY)
    const nul = computeMaturity({ ...caseA, variety_ref: { ...DTM, dtm_basis: null } }, TODAY)
    expect(legacyShape(m)).toEqual(legacyShape(nul))
    expect(m.dtmBasis).toBeNull()
    expect(m.basisResolved).toBe(false)
  })

  it('basis is inert when the cultivar carries no DTM at all', () => {
    const m = computeMaturity({ ...caseA, variety_ref: { dtm_basis: 'from-transplant' } }, TODAY)
    expect(m.harvestWindowLabel).toBeNull()
    expect(m.awaitingTransplant).toBe(false)
    expect(m.ageDays).toBe(42)
  })

  // SLICE D UPDATE: a single-sided DTM used to collapse to a point estimate ("Est. harvest ~date").
  // Calibration deliberately turns it into a real range: the +/-14d residual uncertainty exists
  // whether or not the catalogue happened to quote a max, and a point date would claim precision
  // the data does not have.
  it('from-transplant widens a single-sided DTM into a real range rather than a point date', () => {
    const m = computeMaturity(
      { ...caseA, variety_ref: { days_to_maturity_min: 70, dtm_basis: 'from-transplant' } },
      TODAY,
    )
    // both ends scale off the one populated value: 2026-06-23 + 39d .. + 67d
    expect(ymd(m.maturityMinDate)).toBe('2026-08-01')
    expect(ymd(m.maturityMaxDate)).toBe('2026-08-29')
    expect(m.calibrated).toBe(true)
  })
})

// V4-MATURITYREPEAT-001 (BD-024). A DTM-derived window must not CLOSE on a crop that keeps
// producing. The dates themselves are unchanged and deliberately so — BUG-MATURITYMODELMIX-001
// closed no-change after verifying the math end to end. What changes is the CLAIM the label makes
// about them.
describe('computeMaturity — continuous-harvest habits (V4-MATURITYREPEAT-001)', () => {
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

  // THE REAL PROD ROW this item was filed against, read read-only from live Neon 2026-08-16:
  // plant 90fbbdac-99c2-4cff-9b97-3143a9821b3a "Armageddon", cultivar Armageddon F1, status
  // `fruiting`, transplanted_at 2026-05-23, DTM 75-95, crop_types.pepper -> dtm_basis
  // from-transplant, harvest_habit repeat, repeat_interval_days 7. One logged harvest, 2026-08-05.
  const ARMAGEDDON = {
    transplanted_at: '2026-05-23',
    variety_ref: {
      days_to_maturity_min: 75, days_to_maturity_max: 95,
      dtm_basis: 'from-transplant', harvest_habit: 'repeat',
    },
  }
  // The day the row was filed. At the 0.70 factor in force that day the close printed Aug 12, four
  // days in the past; V4-DROPCALIB-001 re-fitted to 0.75 the same day, moving the close to Aug 16 —
  // exactly the filing date. The defect is identical either way (a pepper with ~6 weeks of season
  // left is told it has finished); the re-fit only shrank the margin the row was noticed by.
  const TODAY = new Date('2026-08-16T00:00:00')

  it('reproduces the filed numbers exactly (premise check, not just a fixture)', () => {
    const m = computeMaturity(ARMAGEDDON, TODAY)
    // lo = max(1, round(.75*75) - 14) = 56 - 14 = 42d;  hi = round(.75*95) + 14 = 71 + 14 = 85d
    expect(ymd(m.maturityMinDate)).toBe('2026-07-04')
    expect(ymd(m.maturityMaxDate)).toBe('2026-08-16') // "day 85 of a 95-day catalogue max"
    expect(m.calibrated).toBe(true)
    expect(m.isMature).toBe(true)
    expect(m.continuousHarvest).toBe(true)
  })

  it('no longer tells Dave a pepper he is picking has finished', () => {
    const m = computeMaturity(ARMAGEDDON, TODAY)
    // BEFORE: 'Harvest window open — through Aug 16, 2026'
    expect(m.harvestWindowLabel).toBe('Harvest window open — picking from Jul 4, 2026')
    // The close is gone as a CLAIM, not merely reworded around: no closing date may appear at all.
    expect(m.harvestWindowLabel).not.toMatch(/through/)
    expect(m.harvestWindowLabel).not.toContain('Aug 16')
  })

  it('names the pre-open range as a FIRST-harvest estimate, with the dates untouched', () => {
    const before = new Date('2026-06-01T00:00:00') // still short of the 2026-07-04 opening
    const m = computeMaturity(ARMAGEDDON, before)
    expect(m.isMature).toBe(false)
    expect(m.harvestWindowLabel).toBe('Est. first harvest Jul 4, 2026 – Aug 16, 2026')
    // identical arithmetic to the `single` reading of the same row — only the wording differs
    const asSingle = computeMaturity(
      { ...ARMAGEDDON, variety_ref: { ...ARMAGEDDON.variety_ref, harvest_habit: 'single' } },
      before,
    )
    expect(+m.maturityMinDate).toBe(+asSingle.maturityMinDate)
    expect(+m.maturityMaxDate).toBe(+asSingle.maturityMaxDate)
  })

  it('cut_and_come_again is treated as continuous too', () => {
    const m = computeMaturity(
      { ...ARMAGEDDON, variety_ref: { ...ARMAGEDDON.variety_ref, harvest_habit: 'cut_and_come_again' } },
      TODAY,
    )
    expect(m.continuousHarvest).toBe(true)
    expect(m.harvestWindowLabel).toBe('Harvest window open — picking from Jul 4, 2026')
  })

  it('the habit set is exactly the two continuous habits', () => {
    expect([...CONTINUOUS_HARVEST_HABITS].sort()).toEqual(['cut_and_come_again', 'repeat'])
  })

  // NON-REGRESSION. A `single` crop has one terminal harvest and a real deadline (storage onion,
  // garlic, winter squash), so its closing date must survive untouched.
  it("'single' keeps its closing date", () => {
    const m = computeMaturity(
      { ...ARMAGEDDON, variety_ref: { ...ARMAGEDDON.variety_ref, harvest_habit: 'single' } },
      TODAY,
    )
    expect(m.continuousHarvest).toBe(false)
    expect(m.harvestWindowLabel).toBe('Harvest window open — through Aug 16, 2026')
  })

  it("'single' keeps the plain 'Est. harvest' lead before the window opens", () => {
    const m = computeMaturity(
      { ...ARMAGEDDON, variety_ref: { ...ARMAGEDDON.variety_ref, harvest_habit: 'single' } },
      new Date('2026-06-01T00:00:00'),
    )
    expect(m.harvestWindowLabel).toBe('Est. harvest Jul 4, 2026 – Aug 16, 2026')
  })

  // The NULL/absent habit is 54 live plantings, every one an ornamental. It must be byte-identical
  // to the pre-change engine — the same no-op property Slice A was built around.
  it('an absent or unrecognised habit is byte-identical to a single-habit read', () => {
    const single = computeMaturity(
      { ...ARMAGEDDON, variety_ref: { ...ARMAGEDDON.variety_ref, harvest_habit: 'single' } }, TODAY)
    for (const habit of [null, undefined, 'perpetual']) {
      const m = computeMaturity(
        { ...ARMAGEDDON, variety_ref: { ...ARMAGEDDON.variety_ref, harvest_habit: habit } }, TODAY)
      expect(m.continuousHarvest, `habit ${habit} must not be continuous`).toBe(false)
      expect(m.harvestWindowLabel).toBe(single.harvestWindowLabel)
    }
    // and with no harvest_habit key at all
    const bare = { ...ARMAGEDDON.variety_ref }
    delete bare.harvest_habit
    expect(computeMaturity({ ...ARMAGEDDON, variety_ref: bare }, TODAY).harvestWindowLabel)
      .toBe(single.harvestWindowLabel)
  })

  // BOUNDARY the design introduces: the open-ended label replaces the closed one exactly at
  // maturityMinDate, because that is where isMature flips. One day either side.
  it('switches wording on the opening date, not on the (now absent) closing date', () => {
    const dayBefore = computeMaturity(ARMAGEDDON, new Date('2026-07-03T12:00:00'))
    const openingDay = computeMaturity(ARMAGEDDON, new Date('2026-07-04T00:00:00'))
    expect(dayBefore.isMature).toBe(false)
    expect(dayBefore.harvestWindowLabel).toMatch(/^Est\. first harvest /)
    expect(openingDay.isMature).toBe(true)
    expect(openingDay.harvestWindowLabel).toMatch(/^Harvest window open — picking from /)
    // and it does NOT change again when the old close date passes — that date no longer means
    // anything to a continuous crop, which is the entire point.
    expect(computeMaturity(ARMAGEDDON, new Date('2026-08-15T00:00:00')).harvestWindowLabel)
      .toBe(computeMaturity(ARMAGEDDON, new Date('2026-08-17T00:00:00')).harvestWindowLabel)
  })

  // The uncalibrated (from-sow / null-basis) open branch says nothing about a close in any habit,
  // so it is deliberately left alone. Basil is the live example: cut_and_come_again, from-sow.
  it('leaves the uncalibrated open label alone for a continuous crop', () => {
    const m = computeMaturity(
      { sown_at: '2026-03-01', variety_ref: { days_to_maturity_min: 60, days_to_maturity_max: 70, dtm_basis: 'from-sow', harvest_habit: 'cut_and_come_again' } },
      TODAY,
    )
    expect(m.calibrated).toBe(false)
    expect(m.continuousHarvest).toBe(true)
    expect(m.harvestWindowLabel).toBe('Maturity window reached')
  })

  // ...but its PRE-open range is still a first-harvest estimate and is named as one, calibrated or
  // not: the "harvest happens between these dates" misreading does not depend on the basis.
  it('names the uncalibrated pre-open range as a first-harvest estimate', () => {
    const m = computeMaturity(
      { sown_at: '2026-07-01', variety_ref: { days_to_maturity_min: 60, days_to_maturity_max: 70, dtm_basis: 'from-sow', harvest_habit: 'repeat' } },
      TODAY,
    )
    expect(m.calibrated).toBe(false)
    expect(m.harvestWindowLabel).toBe('Est. first harvest Aug 30, 2026 – Sep 9, 2026')
  })

  it('a habit alone never conjures a window where there is no DTM', () => {
    const m = computeMaturity(
      { transplanted_at: '2026-05-23', variety_ref: { dtm_basis: 'from-transplant', harvest_habit: 'repeat' } },
      TODAY,
    )
    expect(m.harvestWindowLabel).toBeNull()
    expect(m.awaitingTransplant).toBe(false)
    expect(m.continuousHarvest).toBe(true)
  })
})
