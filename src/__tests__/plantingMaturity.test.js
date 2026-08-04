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
  // BETWEEN the two old extremes, which is the whole point:
  //   sow-anchored (the original bug)   2026-06-29   far too early
  //   calibrated   (Slice D)            2026-07-28   <- 16/18 of observed harvests land in-window
  //   raw catalogue from transplant     2026-09-01   0/21 — too late, told Dave to wait 3 weeks
  it("'from-transplant' calibrates the window between the sow-anchored and raw-catalogue extremes", () => {
    const m = computeMaturity({ ...caseA, variety_ref: { ...DTM, dtm_basis: 'from-transplant' } }, TODAY)
    // anchor 2026-06-23; lo = round(0.70*70)-14 = 35d, hi = round(0.70*80)+14 = 70d
    expect(ymd(m.maturityMinDate)).toBe('2026-07-28')
    expect(ymd(m.maturityMaxDate)).toBe('2026-09-01')
    expect(m.dtmAnchorField).toBe('transplanted_at')
    expect(m.dtmAnchorLabel).toBe('transplant')
    expect(m.calibrated).toBe(true)

    const nul = computeMaturity({ ...caseA, variety_ref: { ...DTM, dtm_basis: null } }, TODAY)
    // Still strictly later than the sow-anchored window this whole change exists to push back...
    expect(m.maturityMinDate > nul.maturityMinDate).toBe(true)
    expect((m.maturityMinDate - nul.maturityMinDate) / 86400000).toBe(29)
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
    // Slice D: calibrated off the planted_out_at anchor (2026-06-23 + 35d), not the raw 70d.
    expect(ymd(m.maturityMinDate)).toBe('2026-07-28')
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
    // both ends scale off the one populated value: 2026-06-23 + 35d .. + 63d
    expect(ymd(m.maturityMinDate)).toBe('2026-07-28')
    expect(ymd(m.maturityMaxDate)).toBe('2026-08-25')
    expect(m.calibrated).toBe(true)
  })
})
