// V4-MATURITYBASIS-001 (Slice D) — site calibration for the from-transplant DTM window.
//
// WHY THIS EXISTS
// Slice A made the DTM anchor basis-aware. Measuring the result against live harvest events
// (2026-08-04) showed the residual error is NOT global — it is almost entirely a from-transplant
// phenomenon, and it is total:
//
//   basis            n    mean err   median   sd     inside catalogue window
//   from-transplant  21   -30.9      -25.0    25.5   0 / 21      <- never right, not once
//   from-sow         11   -13.5      -16.0    23.8   3 / 11
//
// Catalogue DTM overstates THIS SITE's transplant-to-first-harvest time by ~30%. A window that is
// wrong 100% of the time is worse than no window: it tells Dave to pick three weeks early.
//
// MODEL: MULTIPLICATIVE, POOLED, RANGE-ONLY
// Measured on the n=18 cohort (see STRUCTURAL_OUTLIERS below for the 3 exclusions):
//   additive offset      residual rms 12.81 d   (centre -21.9 d)
//   multiplicative       residual rms 10.66 d   (centre  0.7009)   <- better, and scale-correct
// Multiplicative wins because the cohort spans a 55-100 day DTM range; a fixed day offset cannot
// fit both ends.
//
// POOLED, NOT PER-CROP. n=18 pooled has SE 0.034 on the factor and 18/18 consistent sign. Per-crop,
// only tomato (n=10, sd 9.8) clears the bar; pepper (n=4) does not, basil's sd of 26 is noise. At
// ~34 scoreable first-harvests per season over 13 crops, per-crop needs 2-3 more seasons. One
// pooled basis-level factor is the only calibration this dataset actually supports today.
//
// RANGE, NOT A POINT. Residual rms ~10.7 d, so a single corrected date would claim precision the
// data does not have. HALF_WIDTH_DAYS = 14 (~1.3 sd) was validated, not guessed:
//
//   band                       in-window (n=21)   in-window (n=18, outliers excluded)
//   catalogue min..max          0 / 21             0 / 18
//   0.70*dtm +/-10             12 / 21            12 / 18
//   0.70*dtm +/-14             16 / 21            16 / 18      <- chosen
//   0.70*dtm +/-21             17 / 21             -
//
// Leave-one-out (factor refit without each row) also gives 16/18, with the refit factor stable
// across 0.6884-0.7169 — so the 89% is not an in-sample artifact.
//
// SCOPE: from-transplant ONLY. from-sow crops are the only group that ever lands in the catalogue
// window, and their residual (sd 23.8) is indistinguishable from noise. Calibrating them would be
// fitting weather. Uncurated (null basis) is likewise untouched, preserving the Slice A no-op.
//
// PROVENANCE: live prod Neon, 2026-08-04. first harvest = min(event_date) over event_log
// event_type IN ('harvest','first_harvest'), deleted_at IS NULL, scoped to plant_id (sibling-
// plantings rule). One season of data (events begin 2026-04-30), so this is a SITE+2026 factor and
// conflates site effect with 2026 weather. Re-derive after the 2027 season before trusting it as a
// pure site constant.

export const CALIBRATION_BASIS = 'from-transplant'

// Observed time-to-first-harvest ~= FACTOR * catalogue DTM, for from-transplant crops at this site.
export const SITE_FACTOR = 0.70

// Half-width of the presented window, in days, added on each side AFTER scaling.
export const HALF_WIDTH_DAYS = 14

// Sample the factor was fitted on. Surfaced so the UI/report can state its own evidence base.
export const CALIBRATION_SAMPLE = Object.freeze({
  n: 18,
  factorSe: 0.034,
  residualRmsDays: 10.66,
  inWindow: 16,
  season: 2026,
  derivedOn: '2026-08-04',
})

// The 3 rows excluded from the fit. All are plants ACQUIRED AS ESTABLISHED, whose transplanted_at
// records the day they arrived in Dave's garden, not a true set-out from a seedling. They are a
// data problem, not a model problem: including them inflates sd from 13.2 to 25.5.
//
// NOTE FOR WHOEVER FIXES THE DATA: `source_type` does NOT separate them. 12 of the 21 cohort rows
// are 'nursery_transplant', including well-behaved ones (Ukrainian Purple, ratio 0.667). `sown_at
// IS NULL` does not separate them either (14 of 21 lack a sow date). No existing column identifies
// this class -- it needs a new explicit flag. Do not try to infer it from source_type.
export const STRUCTURAL_OUTLIERS = Object.freeze([
  { name: 'Beefsteak Rescue 1', sourceType: 'plant_swap', observedDays: -4, dtm: 80 },
  { name: 'Ghost', sourceType: 'rescued', observedDays: 10, dtm: 100 },
  { name: 'Shallots', sourceType: 'nursery_transplant', observedDays: 11, dtm: 90 },
])

// Returns { loDays, hiDays } day-offsets from the transplant anchor, or null when calibration does
// not apply. Pure; null-tolerant.
//
//   loDays = round(FACTOR * dtmMin) - HALF_WIDTH
//   hiDays = round(FACTOR * dtmMax) + HALF_WIDTH
//
// This is exactly the band that was validated above -- scale each catalogue end, then widen. loDays
// is floored at 1 so a very short DTM can never produce a window opening on or before the
// transplant date itself.
export function calibrateFromTransplant(basis, dtmMin, dtmMax) {
  if (basis !== CALIBRATION_BASIS) return null
  const lo = Number.isFinite(dtmMin) ? dtmMin : (Number.isFinite(dtmMax) ? dtmMax : null)
  const hi = Number.isFinite(dtmMax) ? dtmMax : lo
  if (lo == null) return null
  return {
    loDays: Math.max(1, Math.round(SITE_FACTOR * lo) - HALF_WIDTH_DAYS),
    hiDays: Math.round(SITE_FACTOR * hi) + HALF_WIDTH_DAYS,
  }
}
