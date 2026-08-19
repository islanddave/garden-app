// lambda/harvests/dismissalRefit.js
// V4-DISMISSREFITSTATS-001 — the estimator for the dismissal-calibration refit, with the three
// method corrections the panel owed it BUILT IN rather than written down.
//
// Canon: harvest-panel-decisions-20260812.md Q3 ("Three fixes to §4.4's refit plan, which is not
// sound as written") over harvest-surface-design-V101-20260812.md §4.4 (the plan itself).
//
// WHAT THE REFIT IS. watch.js WATCH_SUPPRESS_DAYS = 10 is a judgment constant: a "not yet" tap
// silences a planting for 10 days. §4.4's plan replaces it with a fitted value — the 25th percentile
// of `first_pick_date - observed_on`, the point by which a quarter of dismissed plantings would
// already have been picked. This module IS that fit. Nothing calls it from a request path; it is run
// offline against the accumulated tables and its output is a number a human then writes into
// WATCH_SUPPRESS_DAYS with its provenance, the way maturityCalibration.js records its own.
//
// WHY IT IS CODE AND NOT A PARAGRAPH. §4.4 as written produces a number that looks fitted and is
// biased. The corrections only protect the constant if they cannot be skipped by whoever runs the
// refit, so each one is a refusal here rather than a caveat in a document:
//
//   (1) REPEATED MEASURES. Under 10-day suppression one planting yields several dismissals across a
//       season. Their intervals share ONE pick date, so they are a correlated repeated-measures
//       series, not independent samples. Counting taps inflates n and over-weights whichever
//       plantings were dismissed most. reduceToPlantingUnits collapses each planting to ONE unit
//       before anything is fitted, and every n this module reports is PLANTINGS, never taps.
//
//   (2) RIGHT-CENSORING. `first_pick_date - observed_on` is undefined for a dismissed planting that
//       never fruits, and 166 of 253 live plantings have zero picks. Dropping those units is not
//       neutral — it deletes exactly the long intervals, so a naive percentile is biased SHORT, in
//       the direction that makes the app nag. Censored units are KEPT here with event=false and the
//       quantile comes from a Kaplan-Meier survival curve; above REFIT_CENSORING_CEILING the fit is
//       REFUSED outright, because past that point the curve is mostly assumption.
//
//   (3) GATE AT HABIT LEVEL. §4.4's `n>=20 per crop` will essentially never fire — tomato (27) and
//       pepper (21) are the only crops that have EVER reached n>=20 first-picked plantings in the
//       whole database, and panel Q2's sibling-anchor restriction to `single` habit removed both
//       from the watch list. So the primary partition is harvest_habit, with a per-crop fit emitted
//       only where that crop alone clears the same bar.
//
// A GUARD, NOT A FOURTH CORRECTION: model_version. Numerator and denominator join within one model
// generation and never across (watch_impression's table COMMENT states this as contract). A sample
// set spanning two versions is refused rather than pooled.
//
// PURE BY CONSTRUCTION — no sql, no clock, no env. Every input arrives in `samples`, including the
// censoring date, so a fit is reproducible from the row set that produced it.

// The quantile §4.4 specifies. A quarter of dismissed plantings would already have been picked by
// this many days after the observation — deliberately early, because a late return is a lost fruit
// and an early return costs one glance (panel Q3's cost asymmetry).
export const REFIT_QUANTILE = 0.25;

// Minimum PLANTINGS (correction 1: not taps) in a partition before it may be fitted. Carried over
// from §4.4's n>=20, re-pointed at the habit partition by correction 3.
export const REFIT_MIN_UNITS = 20;

// Refuse above ~30% censoring — panel Q3's own bound. Kaplan-Meier tolerates censoring, it does not
// manufacture information: past roughly a third censored the p25 rests more on the curve's shape
// assumption than on observed picks, and a suppression constant is not worth that. The panel's third
// measure ("dismissals on plantings that never produce at all") reads this number directly: a high
// censoring fraction is not a suppression problem, it means the watch list is firing on plantings
// that were never going to fruit and the fix belongs upstream in the anchor.
export const REFIT_CENSORING_CEILING = 0.30;

const DAY_MS = 86400000;

function toYmd(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  return null;
}

// Whole-day difference between two ymd strings, UTC-anchored on both sides so no zone can shift it.
function daysBetween(fromYmd, toYmdStr) {
  const a = Date.parse(`${fromYmd}T00:00:00Z`);
  const b = Date.parse(`${toYmdStr}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / DAY_MS);
}

function bump(counter, key) { counter[key] = (counter[key] ?? 0) + 1; }

// ── Correction 1: repeated measures ──────────────────────────────────────────────────────────────
//
// One unit per planting. The representative tap is the EARLIEST dismissal on that planting, and the
// choice is not cosmetic: every LATER dismissal exists only because the current WATCH_SUPPRESS_DAYS
// brought the row back, so its interval is structurally bounded by the very constant the refit is
// replacing. Fitting on those re-derives the old value and calls it evidence. The first tap on a
// planting is the one observation not selected by the suppression policy.
//
// Sample shape (one per dismissal row, joined to its planting's first pick):
//   { plant_id, observed_on, first_pick_date|null, censored_on|null,
//     harvest_habit|null, crop_type_slug|null, model_version|null, undone_at|null }
// opts.asOf: fallback censoring date for units with no censored_on (normally "today" at extract
// time). A censored unit with neither is DROPPED, not silently placed — guessing its horizon would
// invent the exact quantity correction 2 exists to respect.
export function reduceToPlantingUnits(samples, opts = {}) {
  const asOf = toYmd(opts.asOf);
  const dropped = {};
  const firstByPlant = new Map();

  for (const s of samples ?? []) {
    const plantId = s?.plant_id;
    const observedOn = toYmd(s?.observed_on);
    if (plantId == null) { bump(dropped, 'no_plant_id'); continue; }
    if (observedOn == null) { bump(dropped, 'no_observed_on'); continue; }
    // A retracted dismissal is not a label — the human took the observation back. It must never
    // reach the fit even if the extraction query forgot the filter.
    if (s?.undone_at != null) { bump(dropped, 'retracted'); continue; }

    const prior = firstByPlant.get(plantId);
    if (prior == null || observedOn < prior.observed_on) {
      firstByPlant.set(plantId, { ...s, plant_id: plantId, observed_on: observedOn, taps: (prior?.taps ?? 0) + 1 });
    } else {
      firstByPlant.set(plantId, { ...prior, taps: prior.taps + 1 });
    }
  }

  const units = [];
  for (const rep of firstByPlant.values()) {
    const pick = toYmd(rep.first_pick_date);
    if (pick != null) {
      const days = daysBetween(rep.observed_on, pick);
      // A pick BEFORE the "not yet" is not a short interval, it is a different event — the tap
      // followed the harvest. Its interval carries no information about time-to-ready.
      if (days == null || days < 0) { bump(dropped, 'pick_before_observation'); continue; }
      units.push(unitOf(rep, days, true));
      continue;
    }
    const censorOn = toYmd(rep.censored_on) ?? asOf;
    if (censorOn == null) { bump(dropped, 'no_censor_date'); continue; }
    const days = daysBetween(rep.observed_on, censorOn);
    if (days == null || days < 0) { bump(dropped, 'censor_before_observation'); continue; }
    units.push(unitOf(rep, days, false));
  }

  units.sort((a, b) => a.days - b.days || String(a.plant_id).localeCompare(String(b.plant_id)));
  return { units, dropped };
}

function unitOf(rep, days, event) {
  return {
    plant_id: rep.plant_id,
    days,
    // true = picked (the interval is observed). false = right-censored (the interval is only known
    // to be AT LEAST this long).
    event,
    taps: rep.taps,
    harvest_habit: rep.harvest_habit ?? null,
    crop_type_slug: rep.crop_type_slug ?? null,
    model_version: rep.model_version ?? null,
  };
}

// ── Correction 2: a censoring-aware quantile ─────────────────────────────────────────────────────
//
// Kaplan-Meier product-limit estimate of S(t) = P(still unpicked at t), then the p-quantile is the
// smallest observed event time where S(t) <= 1 - p. Censored units contribute to the risk set for
// every day they were actually observed and then leave without an event, which is precisely the
// information a naive percentile throws away.
//
// Tie convention is the standard one: a censoring on the same day as an event is treated as
// occurring after it, so it stays in that day's risk set (`days >= t`).
//
// Returns { reached, days, survival, points }. reached=false means the curve never fell to 1 - p —
// the quantile is genuinely undefined on this sample, NOT zero and NOT the largest observation.
export function kaplanMeierQuantile(units, p = REFIT_QUANTILE) {
  const target = 1 - p;
  const sorted = [...(units ?? [])].sort((a, b) => a.days - b.days);
  const eventTimes = [...new Set(sorted.filter((u) => u.event).map((u) => u.days))].sort((a, b) => a - b);

  let survival = 1;
  const points = [];
  for (const t of eventTimes) {
    const atRisk = sorted.filter((u) => u.days >= t).length;
    if (atRisk === 0) break;
    const events = sorted.filter((u) => u.days === t && u.event).length;
    survival *= 1 - events / atRisk;
    points.push({ days: t, at_risk: atRisk, events, survival });
    // `<=` with a float epsilon: S is a product of exact rationals but accumulates binary error, and
    // an exact-boundary curve (S lands on 0.75 for p=0.25) must count as reached.
    if (survival <= target + 1e-12) return { reached: true, days: t, survival, points };
  }
  return { reached: false, days: null, survival, points };
}

// ── Correction 3: the partition gate, plus the fit itself ────────────────────────────────────────

// Fit ONE partition. Every refusal path returns fitted:false with a named reason and the numbers
// that produced it, so a refusal is as inspectable as a fit — "we could not fit this" with no
// censoring fraction attached is how §4.4's plan would have failed silently.
export function fitPartition(units, opts = {}) {
  const minUnits = opts.minUnits ?? REFIT_MIN_UNITS;
  const ceiling = opts.censoringCeiling ?? REFIT_CENSORING_CEILING;
  const quantile = opts.quantile ?? REFIT_QUANTILE;

  const nUnits = units.length;
  const nTaps = units.reduce((a, u) => a + (u.taps ?? 1), 0);
  const censored = units.filter((u) => !u.event).length;
  // Reported on EVERY outcome including the refusals — panel Q3 offers "a censoring-aware quantile,
  // OR report the censoring fraction and refuse above ~30%". This does both, so the fraction is
  // never absent from a result someone might act on.
  const censoringFraction = nUnits === 0 ? null : censored / nUnits;
  const base = {
    n_units: nUnits, n_taps: nTaps, n_censored: censored, censoring_fraction: censoringFraction, quantile,
  };

  // Correction 1's teeth: the bar is read against PLANTINGS. A partition of 8 plantings dismissed 30
  // times is n=8 here and is refused, where §4.4's tap count would have called it n=30 and fitted.
  if (nUnits < minUnits) return { ...base, fitted: false, days: null, reason: 'insufficient_units' };
  if (censoringFraction > ceiling) {
    return { ...base, fitted: false, days: null, reason: 'censoring_above_ceiling' };
  }

  const km = kaplanMeierQuantile(units, quantile);
  if (!km.reached) return { ...base, fitted: false, days: null, reason: 'quantile_not_reached' };
  return { ...base, fitted: true, days: km.days, reason: 'fitted', survival_at_days: km.survival };
}

function groupBy(units, key) {
  const out = new Map();
  for (const u of units) {
    const k = u[key];
    if (k == null) continue; // an unlabelled unit belongs to no partition and must not pool into one
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(u);
  }
  return out;
}

// The whole refit. Habit partitions are the primary output (correction 3); crop partitions are
// emitted ONLY where that crop alone clears REFIT_MIN_UNITS plantings, which is what "crop-level
// override only where n permits" means in practice.
//
// Returns { ok, reason?, quantile, model_version, habits, crops, dropped, n_units, n_taps }.
// ok=false is a whole-fit refusal (nothing may be read from it); a partition-level refusal lives in
// its own entry and does not stop the others.
export function fitSuppressionDays(samples, opts = {}) {
  const { units, dropped } = reduceToPlantingUnits(samples, opts);
  const quantile = opts.quantile ?? REFIT_QUANTILE;

  // Guard: one model generation per fit. Pooling across a resolver change fits a mixture of two
  // different models' errors and attributes the result to whichever version happens to be current.
  const versions = [...new Set(units.map((u) => u.model_version).filter((v) => v != null))];
  if (versions.length > 1) {
    return {
      ok: false, reason: 'mixed_model_version', model_versions: versions.sort(),
      quantile, habits: {}, crops: {}, dropped, n_units: units.length, n_taps: 0,
    };
  }

  const habits = {};
  for (const [habit, group] of groupBy(units, 'harvest_habit')) habits[habit] = fitPartition(group, opts);
  const crops = {};
  for (const [crop, group] of groupBy(units, 'crop_type_slug')) crops[crop] = fitPartition(group, opts);

  return {
    ok: true,
    reason: 'fitted',
    quantile,
    model_version: versions[0] ?? null,
    habits,
    crops,
    dropped,
    n_units: units.length,
    n_taps: units.reduce((a, u) => a + (u.taps ?? 1), 0),
  };
}
