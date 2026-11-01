// Site calibration for the from-transplant DTM window.
//
// WHY THIS EXISTS
// The DTM anchor is basis-aware, and measuring it against live harvest events showed the residual
// error is NOT global: it is almost entirely a from-transplant phenomenon, and it is total
// (err = observed - catalogue dtmMin):
//
//   basis             n    mean err   median   sd     inside catalogue window
//   from-transplant  35   -18.0      -15.0    11.8   0 / 35      <- never right, not once
//   from-sow         15   -12.1      -15.0    20.9   4 / 15
//   uncurated (null)  3   -27.3      -15.0    22.2   0 / 3
//
// The catalogue figure runs ~1.33x this site's actual transplant-to-first-harvest time (observed =
// 0.75x catalogue). A window that is wrong 100% of the time is worse than no window: it tells the
// grower to wait two to three weeks past the day the crop is actually ready. Showing the raw catalogue
// DTM instead was measured and is no answer (right 1 of 41, against 35 of 41 calibrated).
//
// FIRST HARVEST = FIRST REAL PICK, NOT FIRST EVENT
// A first harvest defined as bare min(event_date) lets one taste-pick or dropped fruit set a
// spuriously early anchor and biases the factor DOWN. It is the earliest harvest event that is not a
// PROBE, where a probe is:
//
//   weight_basis = 'measured'  AND  (weight_grams / quantity)  <  (1/3) * reference unit weight
//
// with reference = the median measured unit weight of that cultivar's OTHER picks (leave-one-out,
// whole harvest corpus), falling back to the cultivar's catalogue plant_varieties.unit_weights[unit]
// and then crop_types when nothing else of it was weighed. Grams, not `quantity > 1`: quantity is
// scale-blind, so it calls a single 122 g slicer a probe and a handful of 6 g cherries a harvest,
// exactly backwards. Only measured picks can be judged: an estimated weight is quantity x a
// per-cultivar constant, so its unit weight carries no information about THIS pick and is presumed real.
//
// The leave-one-out reference is load-bearing, not fussiness. cultivar_weight_derived is built FROM
// these picks, so testing a pick against it scores 1.00 by construction on every single-sample
// cultivar and the rule cannot fire. And the reference must be measured weights where they exist: over
// the 14 cultivars with >=3 measured picks, median(measured) / catalogue = 0.55, so the catalogue
// overstates fruit weight about 2x, the same direction it overstates DTM. Against the raw catalogue a
// 1/3 threshold means "under 2/3 of a real fruit" and wrongly flags the first picks of big-fruited
// tomatoes. The threshold is insensitive across 0.25-0.40 (identical n=35 and factor 0.7504
// throughout), so 1/3 sits mid-plateau rather than on a cliff.
//
// The probe rule removes 4 single-event plants whose one "harvest" is 2-20% of a fruit. It buys
// precision, not centre: residual rms 12.75 -> 10.78 d and ratio sd 0.165 -> 0.145; almost all of the
// move in the factor itself came from a doubled sample.
//
// MODEL: MULTIPLICATIVE, POOLED, RANGE-ONLY
// Measured on the n=35 cohort (see ACQUIRED_MATURE_FIELD below for the exclusions):
//   additive offset      residual rms 11.59 d   (centre -18.0 d)
//   multiplicative       residual rms 10.78 d   (centre  0.7504)   <- better, and scale-correct
// It stays multiplicative because the cohort spans a 55-100 day DTM range and a fixed day offset
// cannot fit both ends. Cross-check: least squares through the origin gives 0.7410, within 0.01 of the
// mean of ratios.
//
// POOLED, NOT PER-CROP. The test says pool: tomato 0.788 (n=17, sd 0.114) vs pepper 0.745 (n=14,
// sd 0.157), difference 0.043 +/- 0.050, well inside noise. Splitting does not pay either: tomato's
// own refit (0.79) scores 16/17, identical to pooled 0.75, and pepper's own refit IS 0.75. The other
// four crops in the cohort are n=1 apiece. One pooled basis-level factor is the only calibration this
// dataset supports.
//
// RANGE, NOT A POINT. Residual rms ~10.8 d, so a single calibrated date would claim precision the data
// does not have. HALF_WIDTH_DAYS = 14 (~1.3 sd) was chosen against the alternatives:
//
//   band                       in-window (n=35, probes cut)
//   catalogue min..max          0 / 35
//   0.75*dtm +/-10             26 / 35
//   0.75*dtm +/-14             31 / 35      <- chosen
//   0.75*dtm +/-18             34 / 35
//   0.75*dtm +/-21             34 / 35
//
// Leave-one-out (factor refit without each row) also gives 31/35, with the refit factor stable across
// 0.7435-0.7598, so the 89% is not an in-sample artifact. +/-18 would buy 3 rows for a 36-day-wide
// window on a single-valued DTM; that is not a harvest window, it is a shrug.
//
// The band is scaled off dtmMin, so raising the factor raises the floor as well as the ceiling; the
// residual misses are rounding (1-3 days), except Yellow Onions below.
//
// LARGEST SURVIVING RESIDUAL: Yellow Onions, first pull day 43 of a 100-120 d DTM (ratio 0.430), 18
// days below the window floor. Not an acquired-mature case (ordinary provenance) and not a probe
// (weight is an estimate, so unjudgable): it is a bulb crop pulled young as scallions, a harvest that
// is real but is not the DTM event. No column separates "pulled young on purpose" from "matured early".
// Left in the fit. DO NOT SET acquired_mature ON IT: the flag means "arrived already grown", and
// flagging a plant sown here would use the column to hide a residual, fitting the exclusion to the
// answer, which is the failure the column was built to stop. Its mechanism needs its own fix.
//
// SCOPE: from-transplant ONLY. from-sow crops are the only group that ever lands in the catalogue
// window, and their residual (sd 20.9) is nearly twice the from-transplant residual, indistinguishable
// from noise. Calibrating them would be fitting weather. Uncurated (null basis) is likewise untouched.
//
// PROVENANCE: live prod Neon, read-only. Cohort = every live garden_node with a transplanted_at, a
// crop_types.dtm_basis of 'from-transplant' (hyphen — 'from_transplant' silently matches nothing), a
// plant_varieties.days_to_maturity_min, and at least one non-probe harvest event; harvest events are
// event_log event_type IN ('harvest','first_harvest') with deleted_at IS NULL, scoped to plant_id
// (sibling-plantings rule), joined to harvest_log for weights. 41 plantings qualify, minus 2
// acquired-mature outliers and 4 probe-only plants = 35. It is ONE season of data, so this is a
// SITE+season factor that conflates site effect with that year's weather: re-derive after another
// season before trusting it as a pure site constant.

export const CALIBRATION_BASIS = 'from-transplant'

// Observed time-to-first-harvest ~= FACTOR * catalogue DTM, for from-transplant crops at this site.
// Fitted centre 0.7504 (mean of observed/dtmMin over n=35); rounded to the 2 dp the window's own
// round() resolution can carry.
export const SITE_FACTOR = 0.75

// Half-width of the presented window, in days, added on each side AFTER scaling.
export const HALF_WIDTH_DAYS = 14

// Sample the factor was fitted on. Surfaced so the UI/report can state its own evidence base.
export const CALIBRATION_SAMPLE = Object.freeze({
  n: 35,
  factorSe: 0.025,
  residualRmsDays: 10.78,
  inWindow: 31,
  season: 2026,
  derivedOn: '2026-08-16',
})

// THE EXCLUSION is a PREDICATE OVER A COLUMN, not a list of names: `plants.acquired_mature` (nullable
// boolean, no default; migrations/v4-acqmature-001, exposed on public.garden_node by the same
// migration).
//
// WHAT IS EXCLUDED: plants ACQUIRED AS ESTABLISHED, whose transplanted_at records the day they arrived
// in the garden rather than a set-out from a seedling. Their observed time-to-first-harvest measures a
// nursery, not this site. Including them inflates the ratio sd from 0.145 to 0.212 and the residual rms
// from 10.8 to 17.9 d, and moves the factor by 0.035 (n=37: 0.7158; n=35 with them excluded: 0.7504).
//
// WHY A COLUMN AND NOT A LIST: a name list excludes only rows it has been TOLD about. A planting
// acquired mature next season is not on it, nobody adds it, and the factor quietly rots as the garden
// grows; a renamed planting stops matching at all. A column is answered when the planting is entered,
// so the exclusion is complete by construction instead of by vigilance.
//
// No existing column separates this class, so do not infer it from `source_type` (27 of the 41 cohort
// rows are 'nursery_transplant', including well-behaved ones, and it is ANTI-correlated: nursery
// transplants average 0.763 against a cohort mean of 0.717), from a missing sow date (21 of 41 lack
// one), or from a short sow-to-transplant gap (gap <= 3 days catches 5 plantings, three of them among
// the best-behaved rows). The decisive case is a pair nothing can separate: King Richard (leek, 0.707)
// and Shallots (0.122) share source_type, source_ref, a NULL sown_at, container and empty notes.
export const ACQUIRED_MATURE_FIELD = 'acquired_mature'

// STRICTLY `=== true`. The column is a TRI-STATE and its NULL is load-bearing: NULL means nobody has
// been asked, false means asked and told no. A truthy test would read `undefined` (what every planting
// fetched before the column shipped carries) as false: the right answer for the wrong reason.
// Explicitly true, or it is not an exclusion.
export function isAcquiredMature(planting) {
  return planting?.[ACQUIRED_MATURE_FIELD] === true
}

// The predicate a re-fit filters its cohort on. Exported as text because the fit is a SQL query run by
// hand against live Neon, not app code; keeping it here means the next re-fit reads the exclusion off
// the same file that states the factor instead of reconstructing it from a report.
//
// `IS NOT TRUE`, not `= false` and not `IS NULL OR = false`: the cohort keeps every planting that
// has not been flagged, including the ones nobody has been asked about, which is exactly what the
// name list did. Only an explicit true is excluded.
export const CALIBRATION_COHORT_EXCLUSION_SQL = 'gn.acquired_mature IS NOT TRUE'

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
