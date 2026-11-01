// Estimator for the dismissal-calibration refit (V4-DISMISSREFITSTATS-001).
//
// watch.js WATCH_SUPPRESS_DAYS is a judgment constant (a "not yet" tap silences a planting for N days).
// This module fits it instead: the 25th percentile of `first_pick_date - observed_on`. Nothing calls it
// from a request path; it runs offline and a human writes the result into WATCH_SUPPRESS_DAYS with its
// provenance.
//
// The three method corrections are refusals in code, so whoever runs the refit cannot skip them:
//   (1) REPEATED MEASURES. One planting yields several dismissals that share ONE pick date, so they are
//       not independent samples. reduceToPlantingUnits collapses each planting to ONE unit; every n here
//       is PLANTINGS, never taps.
//   (2) RIGHT-CENSORING. A dismissed planting that never fruits has no interval. Dropping those units
//       deletes the long intervals and biases the percentile SHORT (the app nags). Censored units are
//       KEPT (event=false) and the quantile comes from a Kaplan-Meier curve; above
//       REFIT_CENSORING_CEILING the fit is REFUSED.
//   (3) GATE AT HABIT LEVEL. A per-crop n>=20 almost never fires, so the primary partition is
//       harvest_habit, with a per-crop fit only where that crop alone clears the same bar.
//
// model_version is a guard, not a fourth correction: numerator and denominator join within one model
// generation (watch_impression's table COMMENT states this), so a sample set spanning two versions is
// refused rather than pooled.
//
// PURE: no sql, no clock, no env. Every input, including the censoring date, arrives in `samples`, so a
// fit is reproducible from the row set that produced it.

// A quarter of dismissed plantings would already have been picked by this many days after the
// observation. Deliberately early: a late return is a lost fruit, an early return costs one glance.
export const REFIT_QUANTILE = 0.25;

// Minimum PLANTINGS (not taps) in a partition before it may be fitted.
export const REFIT_MIN_UNITS = 20;

// Refuse above ~30% censoring: Kaplan-Meier tolerates censoring but past about a third the p25 rests
// more on the curve's shape than on observed picks. A high fraction also means the watch list is firing on
// plantings that will never fruit, which is an anchor problem, not a suppression one.
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
// One unit per planting. The representative tap is the EARLIEST dismissal: every later one exists only
// because the current WATCH_SUPPRESS_DAYS brought the row back, so its interval is bounded by the very
// constant being replaced. The first tap is the one observation not selected by the suppression policy.
// Sample shape (one per dismissal row, joined to its planting's first pick):
//   { plant_id, observed_on, first_pick_date|null, censored_on|null,
//     harvest_habit|null, crop_type_slug|null, model_version|null, undone_at|null,
//     id?, merge_retired? }
// opts.asOf: fallback censoring date for units with no censored_on. A censored unit with neither is
// DROPPED, not guessed: a guessed horizon would invent the quantity correction 2 exists to respect.
//
// A planting merge RETIRES a loser's duplicate dismissal by setting undone_at (BUG-MERGEHARDDELETE-001).
// That is not a human retraction, so it counts as `merge_retired`, not `retracted`. Either marker
// identifies one: `s.merge_retired === true`, or `s.id` in opts.mergeRetiredIds. Both stay out of the fit.
export function reduceToPlantingUnits(samples, opts = {}) {
  const asOf = toYmd(opts.asOf);
  const mergeRetired = new Set(opts.mergeRetiredIds ?? []);
  const dropped = {};
  const firstByPlant = new Map();

  for (const s of samples ?? []) {
    const plantId = s?.plant_id;
    const observedOn = toYmd(s?.observed_on);
    if (plantId == null) { bump(dropped, 'no_plant_id'); continue; }
    if (observedOn == null) { bump(dropped, 'no_observed_on'); continue; }
    // A retracted dismissal is not a label; it must never reach the fit even if the extract forgot the filter.
    if (s?.undone_at != null) {
      const byMerge = s?.merge_retired === true || (s?.id != null && mergeRetired.has(s.id));
      bump(dropped, byMerge ? 'merge_retired' : 'retracted');
      continue;
    }

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
      // A pick BEFORE the "not yet" is a different event (the tap followed the harvest) and says nothing about time-to-ready.
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
    // true = picked (interval observed). false = right-censored (interval is AT LEAST this long).
    event,
    taps: rep.taps,
    harvest_habit: rep.harvest_habit ?? null,
    crop_type_slug: rep.crop_type_slug ?? null,
    model_version: rep.model_version ?? null,
  };
}

// ── Correction 2: a censoring-aware quantile ─────────────────────────────────────────────────────
//
// Kaplan-Meier product-limit estimate of S(t) = P(still unpicked at t); the p-quantile is the smallest
// event time where S(t) <= 1 - p. Censored units stay in the risk set for every day they were observed.
// Tie convention: a censoring on the same day as an event counts as after it (`days >= t`).
//
// Returns { reached, days, survival, points }. reached=false means the curve never fell to 1 - p: the
// quantile is undefined on this sample, NOT zero and NOT the largest observation.
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
    // `<=` with an epsilon: S accumulates binary error, and an exact-boundary curve (0.75 for p=0.25) must count as reached.
    if (survival <= target + 1e-12) return { reached: true, days: t, survival, points };
  }
  return { reached: false, days: null, survival, points };
}

// ── Correction 3: the partition gate, plus the fit itself ────────────────────────────────────────

// Fit ONE partition. Every refusal returns fitted:false with a named reason and the numbers behind it.
export function fitPartition(units, opts = {}) {
  const minUnits = opts.minUnits ?? REFIT_MIN_UNITS;
  const ceiling = opts.censoringCeiling ?? REFIT_CENSORING_CEILING;
  const quantile = opts.quantile ?? REFIT_QUANTILE;

  const nUnits = units.length;
  const nTaps = units.reduce((a, u) => a + (u.taps ?? 1), 0);
  const censored = units.filter((u) => !u.event).length;
  // Reported on EVERY outcome including refusals, so the fraction is never absent from a result someone might act on.
  const censoringFraction = nUnits === 0 ? null : censored / nUnits;
  const base = {
    n_units: nUnits, n_taps: nTaps, n_censored: censored, censoring_fraction: censoringFraction, quantile,
  };

  // Correction 1's teeth: the bar is read against PLANTINGS. 8 plantings dismissed 30 times is n=8 and refused.
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

// The whole refit. Habit partitions are the primary output; crop partitions are emitted ONLY where that
// crop alone clears REFIT_MIN_UNITS plantings.
// Returns { ok, reason?, quantile, model_version, habits, crops, dropped, n_units, n_taps }.
// ok=false is a whole-fit refusal (nothing may be read from it); a partition-level refusal lives in its
// own entry and does not stop the others.
export function fitSuppressionDays(samples, opts = {}) {
  const { units, dropped } = reduceToPlantingUnits(samples, opts);
  const quantile = opts.quantile ?? REFIT_QUANTILE;

  // Guard: one model generation per fit. Pooling across a resolver change would fit a mixture of two models' errors.
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
