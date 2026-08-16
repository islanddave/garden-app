// V4-MATURITYBASIS-001 (Slice D) — site calibration for the from-transplant DTM window.
// V4-DROPCALIB-001 (2026-08-16) — factor RE-FITTED 0.70 -> 0.75 on a cleaned first-harvest
// definition. The row asked whether to DROP calibration and show raw catalogue DTM; that was
// measured and refuted (raw is right 1/41, calibrated 35/41), so what shipped is the re-fit the
// measurement actually supported. Full decision record: project-state/dropcalib-decision-V100-
// 20260816.md; re-fit workings: _lane_reports/calibrefit-20260816.md.
//
// WHY THIS EXISTS
// Slice A made the DTM anchor basis-aware. Measuring the result against live harvest events showed
// the residual error is NOT global — it is almost entirely a from-transplant phenomenon, and it is
// total. Re-measured 2026-08-16 on the current corpus (err = observed - catalogue dtmMin):
//
//   basis             n    mean err   median   sd     inside catalogue window
//   from-transplant  35   -18.0      -15.0    11.8   0 / 35      <- never right, not once
//   from-sow         15   -12.1      -15.0    20.9   4 / 15
//   uncurated (null)  3   -27.3      -15.0    22.2   0 / 3
//
// The catalogue figure runs ~1.33x this site's actual transplant-to-first-harvest time (observed =
// 0.75x catalogue). A window that is wrong 100% of the time is worse than no window: it tells Dave
// to wait two to three weeks past the day the crop is actually ready.
//
// FIRST HARVEST = FIRST REAL PICK, NOT FIRST EVENT (changed 2026-08-16)
// The 2026-08-04 fit defined first harvest as bare min(event_date), which lets one taste-pick or
// dropped fruit set a spuriously early anchor and biases the factor DOWN. It is now the earliest
// harvest event that is not a PROBE, where a probe is:
//
//   weight_basis = 'measured'  AND  (weight_grams / quantity)  <  (1/3) * reference unit weight
//
// with reference = the median measured unit weight of that cultivar's OTHER picks (leave-one-out,
// whole harvest corpus), falling back to the cultivar's catalogue plant_varieties.unit_weights[unit]
// and then crop_types when Dave has weighed nothing else of it. Grams, not `quantity > 1` (the
// decision brief's proxy): quantity is scale-blind, so it calls a single 122 g slicer a probe and a
// handful of 6 g cherries a harvest, exactly backwards. Only measured picks can be judged — an
// estimated weight is quantity x a per-cultivar constant, so its unit weight carries no information
// about THIS pick and is presumed real.
//
// The leave-one-out reference is load-bearing, not fussiness. cultivar_weight_derived is built FROM
// these picks, so testing a pick against it scores 1.00 by construction on every single-sample
// cultivar and the rule cannot fire. And the reference must be Dave's own measurements where they
// exist: over the 14 cultivars with >=3 measured picks, median(measured) / catalogue = 0.55 — the
// catalogue overstates fruit weight about 2x, the same direction it overstates DTM. Against the raw
// catalogue a 1/3 threshold means "under 2/3 of a real fruit" and wrongly flags the first picks of
// three big-fruited tomatoes. The threshold is insensitive across 0.25-0.40 (identical n=35 and
// factor 0.7504 throughout), so 1/3 sits mid-plateau rather than on a cliff.
//
// It removes 4 plants and moves no anchors: Pumpkin Jalapeno (0.5 g/fruit vs 25), Scotch Bonnet
// (0.5 vs 10), Habanero (2 vs 10), Ancho (12 vs 60) — each a single-event plant whose one "harvest"
// is 2-20% of a fruit. HONEST DECOMPOSITION of 0.70 -> 0.75, because it is not what the brief
// predicted: on today's data the same-exclusions cohort already fits 0.7483 (n=39), and the probe
// rule moves that to 0.7504 (n=35). Almost all of the +0.05 is a doubled sample (n 18 -> 35), not
// the cleaned definition. What the probe rule buys is precision, not centre — residual rms 12.75 ->
// 10.78 d and ratio sd 0.165 -> 0.145.
//
// MODEL: MULTIPLICATIVE, POOLED, RANGE-ONLY
// Measured on the n=35 cohort (see STRUCTURAL_OUTLIERS below for the 2 exclusions):
//   additive offset      residual rms 11.59 d   (centre -18.0 d)
//   multiplicative       residual rms 10.78 d   (centre  0.7504)   <- better, and scale-correct
// Multiplicative still wins, though by less than at n=18 (12.81 vs 10.66 then). It stays the model
// because the cohort spans a 55-100 day DTM range and a fixed day offset cannot fit both ends.
// Cross-check: least squares through the origin gives 0.7410, within 0.01 of the mean of ratios.
//
// POOLED, NOT PER-CROP. Pepper is no longer too thin to test (n=4 then, n=14 now), and the test
// says pool: tomato 0.788 (n=17, sd 0.114) vs pepper 0.745 (n=14, sd 0.157), difference
// 0.043 +/- 0.050 — well inside noise. Nor does splitting pay: tomato's own refit (0.79) scores
// 16/17, identical to pooled 0.75, and pepper's own refit IS 0.75. The other four crops in the
// cohort are n=1 apiece. One pooled basis-level factor remains the only calibration this dataset
// supports.
//
// RANGE, NOT A POINT. Residual rms ~10.8 d, so a single corrected date would claim precision the
// data does not have. HALF_WIDTH_DAYS = 14 (~1.3 sd) was re-validated, not inherited:
//
//   band                       in-window (n=39, every first pick)   in-window (n=35, probes cut)
//   catalogue min..max          1 / 39                               0 / 35
//   0.75*dtm +/-10             29 / 39                              26 / 35
//   0.75*dtm +/-14             34 / 39                              31 / 35      <- chosen
//   0.75*dtm +/-18             37 / 39                              34 / 35
//   0.75*dtm +/-21             37 / 39                              34 / 35
//
// Leave-one-out (factor refit without each row) also gives 31/35, with the refit factor stable
// across 0.7435-0.7598 — a much tighter spread than the n=18 fit's 0.6884-0.7169, and the 89% is
// not an in-sample artifact. +/-18 would buy 3 rows for a 36-day-wide window on a single-valued
// DTM; that is not a harvest window, it is a shrug.
//
// WHAT MOVING 0.70 -> 0.75 COSTS, stated plainly: on the same n=35 the OLD factor scores 32/35
// in-window and the new one 31/35. The new factor is better on the thing it estimates (residual rms
// 10.78 vs 11.15) and one row worse on the thing it is scored by, because the band is scaled off
// dtmMin so raising the factor raises the floor as well as the ceiling. It swaps which rows fall
// out: 0.70 missed 2 rows over the CEILING by 1 and 3 days, 0.75 misses 3 under the FLOOR by 1, 1
// and 2. Both are rounding, neither is the 22-day median-early failure that filed
// V4-HARVWINDOW-001, and only Yellow Onions (below) misses either band by more than 3 days. 0.70
// now sits 2.0 SE below the fitted centre; it is a marginally-rejected value, not the estimate.
//
// LARGEST SURVIVING RESIDUAL: Yellow Onions, first pull day 43 of a 100-120 d DTM (ratio 0.430),
// 18 days below the window floor and the only miss over 2 days. Not an acquired-mature case (22-day
// sow-to-transplant gap, ordinary provenance) and not a probe (weight is an estimate, so unjudgable)
// — it is a bulb crop pulled young as scallions, a harvest that is real but is not the DTM event.
// No column separates "pulled young on purpose" from "matured early" either. Left in the fit.
//
// SCOPE: from-transplant ONLY. from-sow crops are the only group that ever lands in the catalogue
// window, and their residual (sd 20.9) is nearly twice the from-transplant residual — indistin-
// guishable from noise. Calibrating them would be fitting weather. Uncurated (null basis) is
// likewise untouched, preserving the Slice A no-op.
//
// PROVENANCE: live prod Neon, read-only, 2026-08-16 (supersedes the 2026-08-04 derivation).
// Cohort = every live garden_node with a transplanted_at, a crop_types.dtm_basis of
// 'from-transplant' (hyphen — 'from_transplant' silently matches nothing), a
// plant_varieties.days_to_maturity_min, and at least one non-probe harvest event; harvest events
// are event_log event_type IN ('harvest','first_harvest') with deleted_at IS NULL, scoped to
// plant_id (sibling-plantings rule), joined to harvest_log for weights. 41 plantings qualify, minus
// 2 structural outliers and 4 probe-only plants = 35. Still ONE season of data (events begin
// 2026-04-30), so this remains a SITE+2026 factor and conflates site effect with 2026 weather.
// Re-derive after the 2027 season before trusting it as a pure site constant. The transplant anchor
// is materially more stable than it was at the 2026-08-04 fit: V4-TRANSPLANTANCHOR-001 made
// transplanted_at set-once-from-event_date in v4.28.0, after that fit.

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

// The 2 rows excluded from the fit. Both are plants ACQUIRED AS ESTABLISHED, whose transplanted_at
// records the day they arrived in Dave's garden, not a true set-out from a seedling. They are a
// data problem, not a model problem: including them inflates the ratio sd from 0.145 to 0.212 and
// the residual rms from 10.8 to 17.9 d.
//
// Was 3. `Beefsteak Rescue 1` is gone — the planting is now `Cherry Rescue 1` and its cultivar
// carries no days_to_maturity at all, so the cohort's DTM filter drops it before this list is ever
// consulted. Nothing was un-excluded; the row stopped being reachable. Ghost and Shallots were
// re-checked on the n=41 cohort and are still the right two: ratios 0.100 and 0.122 against a
// next-lowest survivor of 0.430.
//
// NOTE FOR WHOEVER FIXES THE DATA: no column separates this class, and 2026-08-16 added a second
// measured negative to the first. `source_type` does not — 21 of the 41 cohort rows are
// 'nursery_transplant', including well-behaved ones (Ukrainian Purple, ratio 0.667) and including
// Shallots. `sown_at IS NULL` does not — 21 of 41 lack a sow date. And a short sow-to-transplant
// gap, which looks like the giveaway (a purchased plant has no seedling phase to record), does not
// either: gap <= 3 days catches 5 plantings whose ratios are 0.529, 0.581, 0.877, 0.910 and 1.000 —
// three of them among the best-behaved rows in the cohort. It needs a new explicit flag. Do not try
// to infer it from source_type, from a missing sow date, or from the sow-to-transplant gap.
export const STRUCTURAL_OUTLIERS = Object.freeze([
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
