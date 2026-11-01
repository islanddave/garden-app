// DB-free PURE candidate logic for the Today "Worth checking this week" watch list (V4-HARVSURFACE-001).
// Imports NOTHING runtime (no neon/clerk/aws) so it unit-tests under the root vitest config, same split
// as ./aggregate.js.
//
// WHY THIS MODULE EXISTS. The shipped readiness surface (GET /api/events/harvest-ready +
// src/lib/harvestReadiness.js) cannot show a first-harvest candidate because it gates twice:
//   (a) SERVER: lambda/events/index.js joins `last_pick` INNER, so a planting with ZERO recorded picks is
//       absent from the payload. Right for an OVERDUE band, wrong for a FIRST-harvest watch list.
//   (b) CLIENT: isReadyToPick() returns false unless harvest_habit is repeat or cut_and_come_again, so
//       `single` is rejected even when it reaches the client.
// This module admits `single` habit, requires no prior harvest, and anchors on what the planting has: an
// observed signal, a sibling's pick, or its own sow/transplant date. Plantings with harvest_habit NULL
// are ornamentals and must STAY excluded.
//
// GRAMMAR CONTRACT (enforced by naming, not by copy): this module produces a WATCH LIST, never a
// verdict. Nothing here decides "ready"; it decides "worth walking over to look at". Field names
// (`check_from`, `days_watching`, `confidence`) say so on purpose, so a client cannot render a prediction
// in an observation's grammar without first renaming a field.

// ── Constants ────────────────────────────────────────────────────────────────────────────────────

// Bumped whenever the anchoring math changes. FROZEN onto every dismissal row so a later revision cannot
// re-interpret negative samples an older model produced; without it the calibration set quietly mixes
// incompatible labels the first time a constant moves.
export const WATCH_MODEL_VERSION = 'watch-v1';

// MEASURED, not invented: the model's calibration was 11.8% with a -22d median error (30 of 34 picks
// happened BEFORE the predicted window opened), so a watch list anchored on nominal DTM would open about
// three weeks after the crop was already picked. The lead cancels that measured bias.
export const WATCH_LEAD_DAYS = 22;

// JUDGMENT BOUND, the only constant here with no measurement behind it. It caps the lead at a quarter
// of the predicted interval so a short-interval crop cannot open before it could plausibly be picked
// (a 42-day interval minus a flat 22 would start checking on day 20). Tighten it if watch rows read as noise.
export const WATCH_LEAD_MAX_FRACTION = 0.25;

// MEASURED from the owner's plantings: median (transplanted_at - sown_at) = 31 days over 39 plantings
// carrying both dates. Used ONLY for the basis-shift case below. The live route recomputes this per
// household and passes it in; this is the fallback when a household has too little data.
export const NURSERY_OFFSET_DAYS_FALLBACK = 31;

// MEASURED from the owner's history: the interval from the first status_change to `fruiting` to the
// first harvest event on the same planting is a median of 18 days over 39 plantings (p25 12, p75 23).
// Tomato, pepper and tomatillo sit within 3 days of each other. crop_types.set_to_first_pick_days is a
// FRUIT-SET interval, so the observed fruit_set anchor alone cannot serve crops that lack it. As with the
// nursery offset, the live route recomputes this per household and passes it in; this is the fallback.
// Tighter than the derived tier it sits beside: an IQR of 11 around a date the user entered, against 20
// around a date the system invented (anchorDerive.js ADD_DATE_OFFSET_MEASURED).
export const FRUITING_TO_PICK_DAYS_FALLBACK = 18;

// JUDGMENT BOUND. A "not yet" tap silences a planting for this many days, then the row RETURNS:
// dismissal is a snooze, not a queue exit. Season-long suppression would yield ONE negative-class label
// per planting per season (starving the calibration set); 3 days yields duplicates-in-substance against
// observables that move on a multi-day scale. Deliberately UNIFORM, no crop-class clamp: the obvious
// column, crop_types.loss_horizon_hours, measures POST-HARVEST shelf life, not on-plant velocity, and
// would clamp exactly the wrong crops.
//
// THE REFIT THAT REPLACES THIS VALUE IS dismissalRefit.js. Do not hand-compute a percentile here. It
// builds in three method corrections as REFUSALS (repeated dismissals are a correlated series,
// right-censoring, n>=20-per-crop gate), so a fit that should not run returns a named reason instead of
// a number. When it produces one, replace this constant WITH its provenance: n in PLANTINGS, the
// censoring fraction and the partition, the way maturityCalibration.js records its own.
export const WATCH_SUPPRESS_DAYS = 10;

// Whether the `derived` anchor tier may open a watch row: a backfilled anchor
// (public.plant_anchor_derivation, migrations/v4-anchorbase-001/) for plantings with NO date of their
// own. watch-route.js JOINs that table on every request, so this flag governs only the tier, not the
// join. The tier can only ADD rows (queue entry takes the EARLIEST anchor). About 89% of what it
// contributes is the add-date baseline, a guess accurate to within a week only about half the time
// (anchorDerive.js ADD_DATE_OFFSET_MEASURED), so a surface that opens a row on it asserts a date the
// user never entered; the suppression rules below narrow it. Setting this false is a tier kill switch.
export const DERIVED_ANCHOR_ENABLED = true;

// ── The derived tier's suppression rules ────────────────────────────────────────────────────────
//
// Each rule narrows the derived tier and NONE touches any other anchor kind. They remove the noise
// class, and the one error class a horticulture review called non-negotiable.

// `cut_and_come_again` is DROPPED from the derived tier. The habit is still watched (WATCHED_HABITS) and
// admitted on every OTHER anchor, but for a crop harvested continuously "the catalogue says day 45"
// answers a question nobody asked: the plant is big enough to cut or it is not, and looking is cheap
// and conclusive.
export const DERIVED_ANCHOR_HABITS = new Set(['single', 'repeat']);

// A planting whose OWN logged status already says `flowering` or `fruiting` does not get a derived row.
// The status is a signal the user entered; the derivation is a guess about the same question, and a
// guess must never speak over a record (the ordering TIER_RANK encodes).
export const DERIVED_STATUS_SUPPRESSED = new Set(['flowering', 'fruiting']);

// Frost-window suppression. A derived row that opens near the end of the plant's season is wrong in a
// way looking at the plant cannot fix: the window it points at does not exist because the plant will be
// dead. Suppression applies at `check_from >= watchHorizonFor(...) - DERIVED_FROST_WINDOW_DAYS`, which
// covers the +-10d window and everything past it (a row opening 30 days AFTER the horizon is more wrong
// than one opening 5 days after).
//
// The horizon is per crop, and both arms read a MEASURED quantity:
//   * TENDER (default): the measured first-fall-frost median, DERIVED_OBSERVED_FIRST_FALL_FROST_MMDD.
//     The sowing-safety margin ('09-28', FROST_ANCHORS.firstFallFrost in sowEngine.js) is NOT a claim
//     about when frost arrives. Against this site's 11-season station record it put the cutoff at 09-18,
//     before a frost that had not yet arrived in 10 of 11 seasons, suppressing most of the tender
//     derived tier. 2020 (first frost 09-21) is the residual risk, bounded by the median being a median.
//     It is deliberately NOT mirrored here; do not re-add it.
//   * FALL-HARDY (DERIVED_FROST_HARDY_SLUGS): the growth-stop wall, DERIVED_HARDY_GROWTH_STOP_MMDD. First
//     frost is not a hardy crop's terminal event; short days are. Giving both arms the frost median
//     would collapse them onto one value and make the discriminator dead code that looks alive.
// No new constant is invented: both arms read a value already decided and pinned against sowEngine.js.
//
// FAIL-SAFE DIRECTION, asserted by the suite: unknown or absent slugs take the TENDER arm, the EARLIER
// horizon and so the more suppressed one (frostClass's UNKNOWN_BAND='tender'). Wrongly calling a crop
// hardy invites a walk to a dead plant; wrongly calling it tender only hides a row.
//
// WHY crop_type_slug IS THE VECTOR. The frostClass band lives in lambda/daily-plan/ and cannot be
// imported: deploy-lambda.yml zips each function from its own directory, so a cross-directory import
// resolves under vitest and then 502s at module load in the deployed function. crop_types has no
// hardiness column. `row.crop_type_slug` is already on every row (watch-route.js `live` CTE selects it
// and the final SELECT is `l.*`), so the set is mirrored here.
//
// SINGLE SOURCE OF TRUTH: src/lib/sowEngine.js (FROST_ANCHORS.windowClosingDays,
// OBSERVED_FIRST_FALL_FROST.medianMonthDay, HARDY_GROWTH_STOP_MONTH_DAY, FALL_HARDY_CROPS). This Lambda
// cannot import them, so all four are RESTATED below and pinned in lockstep by anchorDerive.test.js,
// which imports BOTH modules and fails if they diverge. Change them in sowEngine.js; this copy follows.
// FALL_HARDY_CROPS is in turn pinned as a subset of frostClass.js's `hardy` band by sowEngine.test.js.
export const DERIVED_FROST_WINDOW_DAYS = 10;          // = FROST_ANCHORS.windowClosingDays
// = OBSERVED_FIRST_FALL_FROST.medianMonthDay. A MEASURED central estimate (11 seasons, 3-station GHCN
// composite near this site), not a margin; read the two-anchor note at sowEngine.js FROST_ANCHORS before
// touching it. ERA5 reanalysis runs warm on sub-32F minima here and reads a frost median a fortnight
// late, so do not use it. This cutoff ADMITS rows, so the rows it admits must be about plants that were
// alive; the residual risk is a season where frost beats the median.
export const DERIVED_OBSERVED_FIRST_FALL_FROST_MMDD = '10-15';
// = HARDY_GROWTH_STOP_MONTH_DAY. The 10-hour daylength wall below which cool-season growth effectively
// stops. NOT a frost date: a fall-hardy crop is "unharmed or improved by frost", so first frost cannot
// end its watch. Mirrors sowEngine.js's hardy-branch anchor.
export const DERIVED_HARDY_GROWTH_STOP_MMDD = '11-07';
// = FALL_HARDY_CROPS. The edible subset of frostClass's hardy band: the harvested organ keeps
// standing, or improves, through repeated fall frost, so the window this tier points at DOES exist past
// the margin.
export const DERIVED_FROST_HARDY_SLUGS = new Set([
  'arugula', 'beet', 'bok_choy', 'broccoli', 'brussels_sprouts', 'bunching_onion', 'cabbage',
  'carrot', 'celery', 'chard', 'chervil', 'chives', 'cilantro', 'claytonia', 'collard', 'endive',
  'garlic', 'kale', 'kohlrabi', 'leek', 'lettuce', 'mache', 'mizuna', 'mustard', 'parsley',
  'parsnip', 'radicchio', 'radish', 'spinach', 'tatsoi', 'turnip',
]);

// The date this crop's watch season ENDS: the last date before which a derived row still points at
// something that can be picked, for the grow year `ymd` sits in. The grow year runs Nov 1 - Oct 31 (the
// boundary watch-route.js's `bounds` CTE uses), so from November the next horizon belongs to the
// following calendar year.
//
// Named for the question it answers, not "first fall frost": a quantity consumed for a question it does
// not answer because its NAME said it did is the BUG-FROSTANCHOR* failure.
//
// `cropTypeSlug` selects WHICH horizon: a fall-hardy slug gets the growth-stop wall (11-07), because
// short days end that crop, not frost; everything else, including null/unknown, gets the measured
// first-frost median (10-15), the earlier and so more suppressed horizon. Optional so the function is
// callable without a row.
export function watchHorizonFor(ymd, cropTypeSlug = null) {
  const s = toYmd(ymd);
  if (s == null) return null;
  const year = Number(s.slice(0, 4));
  const month = Number(s.slice(5, 7));
  const mmdd = DERIVED_FROST_HARDY_SLUGS.has(cropTypeSlug)
    ? DERIVED_HARDY_GROWTH_STOP_MMDD
    : DERIVED_OBSERVED_FIRST_FALL_FROST_MMDD;
  return `${month >= 11 ? year + 1 : year}-${mmdd}`;
}

// A single-habit crop is the POINT of this module. Repeating habits are admitted too: their FIRST
// harvest of the season is a watch-list event even though every later one belongs to the overdue band.
// NULL habit is excluded (entirely ornamental).
export const WATCHED_HABITS = new Set(['single', 'repeat', 'cut_and_come_again']);

// The sibling anchor is restricted to `single`-habit crops because the sibling CTE matches on
// `crop_type_slug` (the crop), not the cultivar, so "same genetics" does not hold. In the largest
// projects a "sibling" is a different cultivar for most plantings, with a 33 to 43 day maturity spread:
// borrowing a first-pick date across that is a coin flip with a date attached, and one big project could
// contribute dozens of near-identical rows against a display cap of 5.
//
// Why `single` and not a cultivar match: matching on cultivar would collapse the anchor to almost
// nothing, since the owner grows one or two plants of most varieties. For a `single` crop "the first
// fruit in this bed came off on date D" is a real dated observation about a one-shot harvest. For a
// `repeat` crop it is the wrong question: a pepper picked in July says nothing about when a different
// variety beside it starts.
//
// Rows that lose the sibling anchor mostly keep their OWN calendar anchor and stop borrowing one; a few
// fall out of sight (no_anchor), which is why this is paired with the derived tier rather than shipped alone.
export const SIBLING_ANCHOR_HABITS = new Set(['single']);

// ── Pure YYYY-MM-DD date math ────────────────────────────────────────────────────────────────────
// String in, string out, UTC-anchored internally. NO `new Date()` without arguments anywhere in this
// file: every time input arrives as an argument (et_today is computed server-side in HARVEST_TZ), so
// tests cannot flake across a midnight boundary.

export function toYmd(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function ymdToUtc(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function addDays(ymd, n) {
  const s = toYmd(ymd);
  if (s == null || !Number.isFinite(Number(n))) return null;
  return new Date(ymdToUtc(s) + Math.trunc(Number(n)) * 86400000).toISOString().slice(0, 10);
}

// Whole days from `a` to `b`. Negative when b precedes a.
export function daysBetween(a, b) {
  const x = toYmd(a); const y = toYmd(b);
  if (x == null || y == null) return null;
  return Math.round((ymdToUtc(y) - ymdToUtc(x)) / 86400000);
}

// ── Anchor selection ─────────────────────────────────────────────────────────────────────────────
//
// A watch row must REST on something. In descending strength:
//   1. `observed`: a signal the user logged. A `fruit_set` event paired with
//      crop_types.set_to_first_pick_days, or a status_change to `fruiting` paired with the household's
//      fruiting-to-pick interval. Still a prediction FROM an observation, so it takes the lead.
//   2. `sibling`: a sibling planting in the SAME project already picked this season. This anchor takes
//      NO lead: the sibling's pick date is an OBSERVATION that the crop is picking in that bed now, not a
//      prediction to be de-biased. check_from IS that date.
//   3. `calendar`: sow/transplant/planted-out plus catalogue DTM, admitted only with its basis carried
//      on the wire so the client can state it ("sown 118d ago; catalogue 95d from sow").
//
// BASIS SHIFT. dtm_basis says which event the catalogue DTM counts from, and the planting often lacks
// THAT date but has another. The two directions are not symmetric:
//   * basis 'from-sow', only transplanted_at known: the transplant date is LATER than the true sow date,
//     so elapsed time is UNDERSTATED and the watch opens LATE, which hides a fruiting melon. Corrected by
//     subtracting the measured nursery offset from the anchor date.
//   * basis 'from-transplant', only sown_at known: elapsed time is OVERSTATED and the watch opens EARLY.
//     Left uncorrected on purpose: early is the safe error for a "go look" surface, and a second offset
//     would be unjustified precision.
// Either way `basis_shifted` rides the wire so the row can say what it actually rested on.

const BASIS_PREFERENCE = {
  'from-sow': ['sown_at', 'transplanted_at', 'planted_out_at'],
  'from-transplant': ['transplanted_at', 'planted_out_at', 'sown_at'],
};
const DEFAULT_PREFERENCE = ['transplanted_at', 'planted_out_at', 'sown_at'];

// Cap the lead so it can never exceed WATCH_LEAD_MAX_FRACTION of the interval it is de-biasing.
export function leadDaysFor(expectedDays) {
  const n = Number(expectedDays);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(WATCH_LEAD_DAYS, Math.round(n * WATCH_LEAD_MAX_FRACTION));
}

// The basis correction, EXTRACTED from calendarAnchor so the derived tier runs the identical arithmetic
// rather than a parallel copy. Without sharing, the same date arriving through the two paths produced a
// `check_from` a month apart with no way to tell from the payload which correction a row got;
// anchorDerive.test.js pins the parity by driving both paths off one date.
//
// `field` is the column the date STANDS FOR: the real column for a calendar anchor, and
// plant_anchor_derivation.anchor_field for a derived one. NULL means the source did not say, so nothing is
// shifted or corrected (an unlabelled date cannot be re-based without inventing which end of the nursery
// gap it sits on).
export function applyBasisCorrection(basis, field, date, nurseryOffsetDays) {
  const order = BASIS_PREFERENCE[basis] ?? DEFAULT_PREFERENCE;
  const shifted = field != null && field !== order[0];
  // Only the from-sow-measured-from-transplant direction is corrected; see "BASIS SHIFT" above.
  const needsOffset = basis === 'from-sow' && (field === 'transplanted_at' || field === 'planted_out_at');
  const offset = needsOffset
    ? Math.max(0, Math.trunc(Number(nurseryOffsetDays ?? NURSERY_OFFSET_DAYS_FALLBACK)) || 0)
    : 0;
  return {
    date: offset > 0 ? addDays(date, -offset) : date,
    observed_date: date,
    basis_shifted: shifted,
    nursery_offset_applied: offset,
  };
}

// Pick the calendar anchor for a row, honouring dtm_basis and reporting any basis shift.
export function calendarAnchor(row, nurseryOffsetDays) {
  const basis = row?.dtm_basis ?? null;
  const order = BASIS_PREFERENCE[basis] ?? DEFAULT_PREFERENCE;
  for (const field of order) {
    const date = toYmd(row?.[field]);
    if (date == null) continue;
    const c = applyBasisCorrection(basis, field, date, nurseryOffsetDays);
    return {
      kind: 'calendar',
      date: c.date,
      observed_date: c.observed_date,
      basis,
      basis_field: field,
      basis_shifted: c.basis_shifted,
      nursery_offset_applied: c.nursery_offset_applied,
    };
  }
  return null;
}

// expected_days = the EARLIEST defensible maturity figure: days_to_maturity_min first, max only as a fallback.
export function expectedDaysFor(row) {
  const min = Number(row?.days_to_maturity_min);
  if (Number.isFinite(min) && min > 0) return min;
  const max = Number(row?.days_to_maturity_max);
  if (Number.isFinite(max) && max > 0) return max;
  return null;
}

// Tier rank, used ONLY to break a tie between anchors that open on the same day. It is NOT a precedence
// order; see resolveWatchAnchor, which is the opposite.
// EXPORTED so the ordering can be pinned directly. The derived-vs-calendar pair is unobservable through
// behaviour (availableAnchors refuses to build a derived anchor when a calendar one exists), so a
// mutation swapping their ranks passes every behavioural test; it is asserted as an invariant instead,
// because it becomes load-bearing the moment that coexistence guard is relaxed.
// `derived` ranks LAST on purpose (marking-rule layer 2): a date the system invented must never be the
// provenance a row cites when a date the user entered is available. Since rank governs only the CITATION
// and never queue entry, a derived anchor can still open a watch early; it just never claims credit.
export const TIER_RANK = Object.freeze({ observed: 0, sibling: 1, calendar: 2, derived: 3 });

// Build every anchor this row can support. Selection happens in resolveWatchAnchor.
//
// `siblingHabits` is injectable rather than read from the constant so the measurement harness
// (scripts/measure-anchor-coverage.mjs) can price the restriction against live rows in both directions.
// `etToday` rides along ONLY for the frost window: it selects which grow year's horizon applies. When
// absent it falls back to the derived date's own year, so this function stays callable without a clock.
function availableAnchors(row, nurseryOffsetDays, siblingHabits = SIBLING_ANCHOR_HABITS,
  derivedEnabled = DERIVED_ANCHOR_ENABLED, etToday = null,
  fruitingIntervalDays = FRUITING_TO_PICK_DAYS_FALLBACK) {
  const out = [];

  // Observed: a fruit_set event the user logged, plus the crop's fruit-set-to-first-pick interval. A
  // fruit_set with no interval predicts nothing and produces no anchor. Re-measure which crops carry the
  // interval before quoting coverage; it is far wider than melon and watermelon.
  const fruitSet = toYmd(row?.fruit_set_date);
  const setToPick = Number(row?.set_to_first_pick_days);
  if (fruitSet != null && Number.isFinite(setToPick) && setToPick > 0) {
    const lead = leadDaysFor(setToPick);
    out.push({
      kind: 'observed', anchor_date: fruitSet, basis: 'from-fruit-set', basis_shifted: false,
      basis_field: 'fruit_set_date', expected_days: setToPick, lead_days: lead,
      nursery_offset_applied: 0, check_from: addDays(fruitSet, setToPick - lead), source_plant_id: null,
    });
  }

  // Observed: the user's own logged status_change to `fruiting`, plus the household's measured
  // fruiting-to-first-pick interval. `observed` and not a new kind: the date is one the user entered about
  // THIS planting, strictly better evidence than anything the derived tier produces. It sits second so
  // fruit_set keeps citation priority when a planting has both (the narrower, crop-calibrated
  // observation); a TIER_RANK tie is broken by check_from, as resolveWatchAnchor already wants.
  //
  // NO FROST GATE, unlike the derived tier: that gate exists because a derived row invites a look for a
  // window that cannot happen. This anchor rests on the plant ALREADY FRUITING, and picking it green
  // ahead of frost is a real, useful reminder. NOR a habit gate: `fruiting` on a cut-and-come-again crop
  // is still the user saying they saw fruit, and the household median governs it. WATCHED_HABITS still
  // applies upstream.
  //
  // SCOPE: NOT widened to the fruit_set event. A planting whose status auto-advanced from a fruit_set
  // event writes no status_change event, and the crops involved (peppers, tomatoes) are already served by
  // the crop-calibrated observed anchor above. The remaining fruit_set-without-interval cases (broccoli,
  // cabbage) are ones where "fruit set" is not the harvested product, so the median measured on
  // tomato/pepper/tomatillo predicts nothing about them. This tier reads the status logged, and nothing else.
  const fruitingDays = Number(fruitingIntervalDays);
  const fruitingOn = toYmd(row?.fruiting_status_date);
  if (fruitingOn != null && Number.isFinite(fruitingDays) && fruitingDays > 0) {
    const lead = leadDaysFor(fruitingDays);
    out.push({
      kind: 'observed', anchor_date: fruitingOn, basis: 'from-fruiting-status', basis_shifted: false,
      basis_field: 'fruiting_status_date', expected_days: fruitingDays, lead_days: lead,
      nursery_offset_applied: 0, check_from: addDays(fruitingOn, fruitingDays - lead),
      source_plant_id: null,
    });
  }

  // Sibling: a planting of the same crop in the same project already picked. NO lead: it is an
  // observation that the bed is producing, not a prediction. Gated on habit (see SIBLING_ANCHOR_HABITS).
  const sibling = toYmd(row?.sibling_first_pick_date);
  if (sibling != null && siblingHabits.has(row?.harvest_habit)) {
    out.push({
      kind: 'sibling', anchor_date: sibling, basis: 'sibling-first-pick', basis_shifted: false,
      basis_field: 'sibling_first_pick_date', expected_days: null, lead_days: 0,
      nursery_offset_applied: 0, check_from: sibling, source_plant_id: row?.sibling_plant_id ?? null,
    });
  }

  // Calendar — sow/transplant plus catalogue DTM, basis carried on the wire.
  const expected = expectedDaysFor(row);
  const cal = calendarAnchor(row, nurseryOffsetDays);
  if (cal != null && expected != null) {
    const lead = leadDaysFor(expected);
    out.push({
      kind: 'calendar', anchor_date: cal.date, observed_anchor_date: cal.observed_date,
      basis: cal.basis, basis_shifted: cal.basis_shifted, basis_field: cal.basis_field,
      expected_days: expected, lead_days: lead, nursery_offset_applied: cal.nursery_offset_applied,
      check_from: addDays(cal.date, expected - lead), source_plant_id: null,
    });
  }

  // Derived: a backfilled anchor for a planting that has NO date of its own (V4-ANCHORBASE-001). Read
  // from the persisted derived_anchor_* columns rather than derived here, so the value used is the value
  // recorded, labelled and revertible. Guarded by BOTH the flag and the presence of the column, and
  // skipped outright whenever `cal` produced anything, because a planting with a real date must never
  // also carry a derived one. Three further suppressions apply, each stated where its constant is
  // declared: the habit gate, the contradicting-status gate and the frost window. All narrow ONLY this
  // tier; with the flag off this block is dead code.
  if (derivedEnabled && cal == null && expected != null
      && DERIVED_ANCHOR_HABITS.has(row?.harvest_habit)
      && !DERIVED_STATUS_SUPPRESSED.has(row?.status)) {
    const derivedDate = toYmd(row?.derived_anchor_date);
    if (derivedDate != null) {
      // The derived date is re-based exactly as a calendar date would be, using the column the
      // derivation says it STANDS FOR (plant_anchor_derivation.anchor_field). Without this, a from-sow
      // crop whose derived anchor stands for `transplanted_at` opened its watch a nursery gap (~31d)
      // later through this path than through the calendar path.
      const basisField = row?.derived_anchor_field ?? null;
      const c = applyBasisCorrection(row?.dtm_basis ?? null, basisField, derivedDate, nurseryOffsetDays);
      const lead = leadDaysFor(expected);
      const checkFrom = addDays(c.date, expected - lead);

      // The season-end window. Suppression compares the date the watch would OPEN against the crop's
      // horizon, not the anchor date: a row is useless when the thing it invites a look for cannot happen
      // before the plant's season ends. The horizon is per crop (a fall-hardy plant does not die at first
      // frost) and measured on both arms; an absent or unknown slug takes the tender arm, the earlier and
      // more suppressed horizon. See the constants above.
      const horizon = watchHorizonFor(etToday ?? derivedDate, row?.crop_type_slug ?? null);
      const frostCutoff = horizon == null ? null : addDays(horizon, -DERIVED_FROST_WINDOW_DAYS);
      const frostSuppressed = checkFrom != null && frostCutoff != null && checkFrom >= frostCutoff;

      if (!frostSuppressed) {
        out.push({
          kind: 'derived', anchor_date: c.date, observed_anchor_date: c.observed_date,
          basis: 'derived-anchor', basis_shifted: c.basis_shifted,
          basis_field: 'derived_anchor_date', expected_days: expected, lead_days: lead,
          nursery_offset_applied: c.nursery_offset_applied, check_from: checkFrom,
          source_plant_id: null,
          derived_source: row?.derived_anchor_source ?? null,
          derived_confidence: row?.derived_anchor_confidence ?? null,
          // The column the derived date stands in for, so an audit can see WHICH correction was applied.
          // `basis_field` stays 'derived_anchor_date' because that is where the date literally came from.
          derived_anchor_field: basisField,
        });
      }
    }
  }

  return out.filter((a) => a.check_from != null);
}

// Resolve the anchor a row rests on. Returns null when the planting rests on nothing: a row with no
// anchor is NOT shown rather than shown with a shrug.
//
// TWO SEPARATE QUESTIONS, TWO SEPARATE ANSWERS. Collapsing them hid real rows on live data, and both
// halves are load-bearing:
//
//   1. WHEN DOES THE WATCH OPEN?  ->  the EARLIEST check_from across every available anchor. The queue
//      admits a planting "when its EARLIEST defensible anchor fires", and this makes it IMPOSSIBLE for
//      one anchor to suppress another. This date is `check_from` / `watching_since`.
//
//   2. WHAT DOES THE ROW SAY IT RESTS ON?  ->  the STRONGEST anchor that has ALREADY FIRED. Provenance
//      should cite the best evidence in hand: a completed sibling pick beats a catalogue DTM measured off
//      an estimated sow date that merely fires earlier. `basis` and `confidence` come from here.
//
// Strict tier precedence (always prefer observed, then sibling, then calendar) failed: a fruit_set run
// through a catalogue interval is still a PREDICTION, and letting it outrank a completed sibling pick
// pushed check_from out and made rows read `not_yet_open` when the bed was already picking. Fixture
// tests missed it because no fixture carried both a fruit_set and a sibling; the fixtures now do.
export function resolveWatchAnchor(row, opts = {}) {
  const nurseryOffsetDays = opts.nurseryOffsetDays ?? NURSERY_OFFSET_DAYS_FALLBACK;
  const anchors = availableAnchors(row, nurseryOffsetDays, opts.siblingHabits ?? SIBLING_ANCHOR_HABITS,
    opts.derivedEnabled ?? DERIVED_ANCHOR_ENABLED, toYmd(opts.etToday),
    opts.fruitingIntervalDays ?? FRUITING_TO_PICK_DAYS_FALLBACK);
  if (anchors.length === 0) return null;

  const byDate = [...anchors].sort((a, b) => (
    a.check_from < b.check_from ? -1 : a.check_from > b.check_from ? 1
      : TIER_RANK[a.kind] - TIER_RANK[b.kind]
  ));
  const earliestAll = byDate[0];

  // Strongest anchor already in hand. Before ANY anchor has fired the row is not eligible anyway, so
  // fall back to the earliest, the one whose firing will admit it.
  const today = toYmd(opts.etToday);
  const fired = today == null ? [] : anchors.filter((a) => a.check_from <= today);
  const pool = fired.length > 0 ? fired : [earliestAll];
  const strongest = [...pool].sort((a, b) => (
    TIER_RANK[a.kind] - TIER_RANK[b.kind] || (a.check_from < b.check_from ? -1 : 1)
  ))[0];

  // THE UNCITED-DERIVED-DATE LEAK: the one place the two-question split needed narrowing. Queue entry
  // takes the earliest anchor and the citation takes the strongest FIRED one. For the three real kinds
  // that is right. But a DERIVED anchor is a date the system made up, and TIER_RANK forbids citing it
  // while a real date exists, so a row's `watching_since` could come from the invented date while its
  // `basis` cited something else ("sibling picked Aug 8"), and `days_watching` inflated by the gap.
  //
  // THE RULE: a derived anchor may set `watching_since` only when it is also what the row CITES. Whenever
  // the citation is real, queue entry is computed over the real anchors alone, so the displayed date and
  // the stated basis come from the same resolved anchor. Non-circular (`strongest` is computed first), and
  // a strict no-op when there is no derived anchor.
  const entryPool = strongest.kind === 'derived' ? byDate : byDate.filter((a) => a.kind !== 'derived');
  const earliest = entryPool[0] ?? earliestAll;

  return {
    ...strongest,
    // Queue entry: always the earliest, whatever the row cites as provenance.
    check_from: earliest.check_from,
    opened_by: earliest.kind,
    // Every anchor not cited, so a row is auditable and a tuning pass can see which anchors disagreed.
    alternates: byDate.filter((a) => a !== strongest).map((a) => ({ kind: a.kind, check_from: a.check_from })),
  };
}

// ── Short provenance string (`basis` on the wire) ────────────────────────────────────────────────
//
// A derivation must be LABELLED, but the watch row is compact and a long field turns the list back into
// the inventory it replaces. So: short, and honest about the weakest link. A basis-shifted calendar
// anchor gets the "(est. sow)" qualifier because that row rests on a date this module INFERRED (the
// DTM counts from sowing, no sow date exists, and the anchor was reconstructed by subtracting the
// household's nursery gap from the transplant date). Printing it as a plain sow date would launder an
// estimate into a record.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function shortDate(ymd) {
  const s = toYmd(ymd);
  if (s == null) return null;
  const [, m, d] = s.split('-');
  return `${MONTHS[Number(m) - 1]} ${Number(d)}`;
}

const FIELD_VERB = { sown_at: 'sown', transplanted_at: 'transplanted', planted_out_at: 'planted out' };

// A borrowed anchor must LOOK borrowed. `sibling picked Aug 10` never says WHICH sibling, so a row
// would present a neighbouring planting's date as evidence about itself, possibly a different variety
// with a different maturity. Naming it makes the borrow checkable at a glance. Truncated to keep the
// ~40-char basis budget that keeps the watch row a row.
const SIBLING_NAME_MAX = 18;

export function siblingLabel(name) {
  const s = typeof name === 'string' ? name.trim() : '';
  if (s === '') return null;
  return s.length <= SIBLING_NAME_MAX ? s : `${s.slice(0, SIBLING_NAME_MAX - 1).trimEnd()}…`;
}

// The sibling's planting-date offset: a 3-week succession breaks the shared-clock premise even for
// `single` crops. Compared on the first field BOTH plantings carry, so like dates are compared.
// Positive = this planting went in AFTER the sibling (the borrowed pick date overstates its progress).
export function siblingPlantingOffsetDays(row) {
  for (const f of ['sown_at', 'transplanted_at', 'planted_out_at']) {
    const own = toYmd(row?.[f]);
    const sib = toYmd(row?.[`sibling_${f}`]);
    if (own != null && sib != null) return daysBetween(sib, own);
  }
  return null;
}

export function describeBasis(anchor, etToday, row = null) {
  if (!anchor) return null;
  if (anchor.kind === 'sibling') {
    const who = siblingLabel(row?.sibling_planting_name ?? anchor.source_planting_name);
    // Falls back to the unnamed form rather than printing an empty slot or dropping the provenance.
    const core = who == null
      ? `sibling picked ${shortDate(anchor.anchor_date)}`
      : `sibling ${who} picked ${shortDate(anchor.anchor_date)}`;
    // The offset makes the borrow's weakest premise visible. Zero offset says nothing and is omitted.
    const off = siblingPlantingOffsetDays(row);
    if (off == null || off === 0) return core;
    return `${core} · planted ${Math.abs(off)}d ${off > 0 ? 'earlier' : 'later'}`;
  }
  // Two observed anchors share this kind and must NOT share copy: printing "fruit set" for a row
  // resting on a status_change would cite an event never logged. Branch on the field the anchor came from.
  if (anchor.kind === 'observed') {
    return anchor.basis_field === 'fruiting_status_date'
      ? `fruiting ${shortDate(anchor.anchor_date)}`
      : `fruit set ${shortDate(anchor.anchor_date)}`;
  }

  // Marking-rule layer 3: a derived anchor's copy leads with `est.`, ALWAYS and before any date or number,
  // because the row rests on a date the user never entered. Printing it as `planted 62d` would launder an
  // assumption into a record.
  if (anchor.kind === 'derived') {
    const from = anchor.derived_source === 'add_date_baseline' ? 'est. from add-date'
      : anchor.derived_source === 'nursery_proxy_event' ? 'est. from nursery event'
        : anchor.derived_source === 'sow_event' ? 'est. from sow event'
          : anchor.derived_source === 'transplant_event' ? 'est. from transplant event'
            : 'est. anchor';
    const days = daysBetween(anchor.anchor_date, etToday);
    const dtm = anchor.expected_days == null ? null : `catalogue ${anchor.expected_days}d`;
    const core = days == null ? from : `${from} ${days}d`;
    return dtm ? `${core} · ${dtm}` : core;
  }

  // The age is measured from anchor_date, the date the DTM math ACTUALLY used, never from the raw field.
  // When the nursery offset was applied those differ by a month, and printing the raw transplant age
  // beside a catalogue figure computed from the estimated sow date gives two numbers that cannot both be
  // true. The verb follows the FIELD, not the basis: a from-transplant crop anchored on sown_at must not
  // print "transplanted" over a sow-date age.
  const offset = Number(anchor.nursery_offset_applied ?? 0);
  const verb = offset > 0 ? 'sown' : (FIELD_VERB[anchor.basis_field] ?? 'planted');
  const age = daysBetween(anchor.anchor_date, etToday);
  const agePart = age == null ? verb : `${verb} ${age}d`;
  const dtm = anchor.expected_days == null ? null : `catalogue ${anchor.expected_days}d`;
  const core = dtm ? `${agePart} · ${dtm}` : agePart;

  // Short provenance qualifier: `(est. sow)` marks a sow date this module RECONSTRUCTED; `(est.)` marks the
  // uncorrected shift, where the DTM basis and the available date simply disagree.
  if (offset > 0) return `${core} (est. sow)`;
  return anchor.basis_shifted ? `${core} (est.)` : core;
}

// ── Bounded-suppression guard ────────────────────────────────────────────────────────────────────
//
// A returning row must carry NEW content: if its basis string is byte-identical to the dismissed
// instance's, suppress another cycle rather than show it, because an identical row is the app ignoring
// the user. The dismissed basis is reconstructed from the FROZEN snapshot columns rendered as of the
// observation day. In practice it only matches for age-free anchor kinds (sibling, observed); a calendar
// basis embeds an age ("sown 93d") that moves daily, which is the fresh basis that makes a return legitimate.

export function reconstructDismissedBasis(row) {
  const kind = row?.dismissal_anchor_kind;
  if (!kind) return null;
  const frozen = {
    kind,
    anchor_date: toYmd(row.dismissal_anchor_date),
    basis: row.dismissal_anchor_basis ?? null,
    basis_shifted: !!row.dismissal_anchor_basis_shifted,
    basis_field: null,
    expected_days: row.dismissal_expected_days == null ? null : Number(row.dismissal_expected_days),
    lead_days: row.dismissal_lead_days == null ? null : Number(row.dismissal_lead_days),
    nursery_offset_applied: 0,
  };
  return describeBasis(frozen, toYmd(row.dismissal_observed_on), row);
}

// Returns the extended return date when the guard suppresses, else null. Bounded to ONE extra cycle:
// past dismissal_suppressed_until + WATCH_SUPPRESS_DAYS the row shows even if still identical, so the
// guard can never quietly become season-long.
export function basisUnchangedUntil(row, anchor, today) {
  const until = toYmd(row?.dismissal_suppressed_until);
  if (until == null || until > today) return null; // no bounded dismissal, or it is still active
  const extra = addDays(until, WATCH_SUPPRESS_DAYS);
  if (today >= extra) return null;
  const frozen = reconstructDismissedBasis(row);
  if (frozen == null) return null;
  return describeBasis(anchor, today, row) === frozen ? extra : null;
}

// ── Candidate classification ─────────────────────────────────────────────────────────────────────
//
// Returns a discriminated result for EVERY row, eligible or not, so the route can report why a planting
// is absent instead of collapsing different silences into one empty list. `reason` is diagnostic, never user copy.

export function classifyWatchCandidate(row, etToday, opts = {}) {
  const today = toYmd(etToday);
  if (!row || today == null) return { eligible: false, reason: 'no_today' };

  // The habit gate this module exists to widen. `single` is IN.
  if (!WATCHED_HABITS.has(row.harvest_habit)) {
    return { eligible: false, reason: 'habit_not_watched' };
  }

  // Queue exit 1: a first harvest was logged. The planting graduates to the overdue band's world.
  if (Number(row.prior_harvest_count ?? 0) > 0) {
    return { eligible: false, reason: 'already_harvested' };
  }

  // Queue SNOOZE: an active "not yet" dismissal. Also a JOIN condition on the live route; repeated here
  // so the pure function tells the whole truth. suppressed_until rides the verdict so the route can print the return date.
  if (row.dismissed_active === true) {
    return {
      eligible: false, reason: 'dismissed',
      suppressed_until: toYmd(row.dismissal_suppressed_until),
    };
  }

  const anchor = resolveWatchAnchor(row, { ...opts, etToday: today });
  if (anchor == null) return { eligible: false, reason: 'no_anchor' };
  if (anchor.check_from == null) return { eligible: false, reason: 'no_anchor' };

  const daysWatching = daysBetween(anchor.check_from, today);
  if (daysWatching == null) return { eligible: false, reason: 'no_anchor' };
  if (daysWatching < 0) return { eligible: false, reason: 'not_yet_open', check_from: anchor.check_from };

  // Byte-identical-basis guard: a row returning from suppression with the basis it was dismissed under is suppressed one more cycle.
  const guardUntil = basisUnchangedUntil(row, anchor, today);
  if (guardUntil != null) {
    return { eligible: false, reason: 'basis_unchanged', suppressed_until: guardUntil };
  }

  return { eligible: true, reason: 'watching', anchor, check_from: anchor.check_from, days_watching: daysWatching };
}

// Wire projection.
//
// FIELD NAMES ARE A CROSS-LANE CONTRACT. `name`, `variety_ref`, `watching_since` and `basis` match the
// shape the UI committed and tested against; renaming them silently breaks UI tests. The grammar contract
// also binds: `watching_since` and `basis`, never `ready_at` or `days_overdue`.
//
// `check_from` / `days_watching` / `crop_type_slug` are kept as ADDITIVE aliases: the dismissal snapshot
// is built from this same object, and the calibration columns are named for the model, not the row.
export function projectWatchRow(row, verdict, etToday) {
  const a = verdict.anchor;
  return {
    plant_id: row.plant_id,
    project_id: row.project_id,

    // ── UI contract ──────────────────────────────────────────────────────────────────────────────
    name: row.planting_name ?? null,
    location_name: row.location_name ?? null,
    variety_ref: {
      name: row.variety_name ?? null,
      crop_type_slug: row.crop_type_slug ?? null,
    },
    watching_since: verdict.check_from,
    basis: describeBasis(a, etToday, row),

    // ── Additive: everything the UI does not render but the server/audit path needs ───────────────
    location_id: row.location_id ?? null,
    crop_type_slug: row.crop_type_slug ?? null,
    crop_display_name: row.crop_display_name ?? null,
    variety_id: row.variety_id ?? null,
    harvest_habit: row.harvest_habit ?? null,
    status: row.status ?? null,
    prior_harvest_count: Number(row.prior_harvest_count ?? 0),
    // `confidence` is the anchor tier, named for what the client must SAY about the row, not a score.
    confidence: a.kind,
    anchor: {
      kind: a.kind,
      date: a.anchor_date,
      observed_date: a.observed_anchor_date ?? a.anchor_date,
      basis: a.basis,
      basis_field: a.basis_field,
      basis_shifted: !!a.basis_shifted,
      expected_days: a.expected_days,
      lead_days: a.lead_days,
      nursery_offset_applied: a.nursery_offset_applied,
      source_plant_id: a.source_plant_id ?? null,
      source_planting_name: a.kind === 'sibling' ? (row.sibling_planting_name ?? null) : null,
      // The marking rides the wire, not just the copy: `derived` is a boolean a consumer can filter on
      // without parsing prose, so a calibration query cannot silently train on invented anchors.
      derived: a.kind === 'derived',
      derived_source: a.derived_source ?? null,
      derived_confidence: a.derived_confidence ?? null,
      // The column the derived date stands in for. With basis_shifted / nursery_offset_applied this makes
      // the basis correction AUDITABLE on the wire; the ~40-char basis string has no room to say it.
      derived_anchor_field: a.derived_anchor_field ?? null,
      alternates: a.alternates ?? [],
    },
    check_from: verdict.check_from,
    days_watching: verdict.days_watching,
  };
}

// Newest first (most-recently-opened watch at the top): a row watched for 40 days is the one the user has
// already looked past. plant_id breaks ties so the order is total and the payload stable.
export function rankWatchCandidates(rows) {
  return [...rows].sort((x, y) => {
    if (x.days_watching !== y.days_watching) return x.days_watching - y.days_watching;
    return String(x.plant_id).localeCompare(String(y.plant_id));
  });
}

// Cross-lane contract: the exact keys the UI committed against. Asserted in the suite so a rename fails HERE
// rather than as a blank row in the client.
export const UI_CONTRACT_FIELDS = Object.freeze([
  'plant_id', 'project_id', 'name', 'location_name', 'variety_ref', 'watching_since', 'basis',
]);

// Snoozed wire projection: everything the tail's "Snoozed" subgroup needs to print a row and its return
// date. suppressed_until NULL = a legacy season-long row; the shape must not lie about them.
export function projectSnoozedRow(row, verdict) {
  return {
    plant_id: row.plant_id,
    project_id: row.project_id ?? null,
    name: row.planting_name ?? null,
    location_name: row.location_name ?? null,
    crop_display_name: row.crop_display_name ?? null,
    suppressed_until: verdict.suppressed_until ?? null,
    reason: verdict.reason,
  };
}

// Full pipeline over raw SQL rows. Returns the ranked list PLUS a reason census, so a zero-length list is
// explainable at the API boundary, and the snoozed rows themselves so the tail can print each with its
// return date.
//
// `excludedRows` is the SAME verdicts as the `excluded` census at row grain. The census goes on the wire;
// excludedRows is what gets PERSISTED, because a count cannot be joined to event_log to ask whether the
// model was right to decline a particular planting. Both come from one pass, so they cannot disagree.
//
// RANKING: a returning row must not come back at the top. No code is needed and none should be added:
// rankWatchCandidates orders by days_watching ascending and suppression never touches check_from, so a
// returning row re-enters where its watch age puts it. Pinned in the suite.
export function buildWatchList(rows, etToday, opts = {}) {
  const candidates = [];
  const excluded = {};
  const excludedRows = [];
  const snoozed = [];
  for (const row of rows ?? []) {
    const verdict = classifyWatchCandidate(row, etToday, opts);
    if (verdict.eligible) candidates.push(projectWatchRow(row, verdict, etToday));
    else {
      excluded[verdict.reason] = (excluded[verdict.reason] ?? 0) + 1;
      // plant_id may be absent on a malformed row; it cannot be persisted (NOT NULL, FK'd) but MUST still
      // count in the census, which is why the guard is here and not above.
      if (row?.plant_id != null) excludedRows.push({ plant_id: row.plant_id, reason: verdict.reason });
      if (verdict.reason === 'dismissed' || verdict.reason === 'basis_unchanged') {
        snoozed.push(projectSnoozedRow(row, verdict));
      }
    }
  }
  // Soonest-returning first; name then plant_id break ties so the payload is stable.
  snoozed.sort((a, b) => String(a.suppressed_until ?? '9999').localeCompare(String(b.suppressed_until ?? '9999'))
    || String(a.name ?? '').localeCompare(String(b.name ?? ''))
    || String(a.plant_id).localeCompare(String(b.plant_id)));
  return { candidates: rankWatchCandidates(candidates), excluded, excludedRows, snoozed };
}

// ── Dismissal snapshot ───────────────────────────────────────────────────────────────────────────
//
// WHY THE SERVER FREEZES THIS, AND WHY IT IS NOT JUST A UI HIDE. The harvest dataset has never held a
// negative-class sample, and a ripeness model cannot be calibrated from positives alone. A "not yet" tap
// is the first negative label: at a KNOWN instant, on a KNOWN planting, a human LOOKED and reported
// not-ready. To be usable it must carry the model's claim AS IT STOOD THEN:
//   * Recomputing features later would LEAK THE ANSWER (the eventual harvest date is by then in the
//     data) and would drift anyway, since DTM, dtm_basis and anchor dates get edited.
//   * `model_version` partitions the set, so a constant change does not mix labels from incompatible models.
//   * `observed_on` is separate from `dismissed_at`: the OBSERVATION date is the truth, the write
//     timestamp is bookkeeping (dismissals can be backdated, like harvests).
// The label is supplied later by the planting's eventual first-harvest date (already in event_log). A
// dismissal on a planting that NEVER gets harvested is a right-censored observation, which survival-style
// calibration consumes directly (see dismissalRefit.js).
//
// Built server-side from the server's own candidate row, never from client-supplied fields: a client that
// could post its own snapshot could poison the calibration set.
export function buildDismissalSnapshot(candidate, observedOn) {
  if (!candidate) return null;
  const a = candidate.anchor ?? {};
  return {
    plant_id: candidate.plant_id,
    project_id: candidate.project_id ?? null,
    observed_on: toYmd(observedOn),
    // Bounded suppression: the row returns this many days after the OBSERVATION date, not the write timestamp.
    suppressed_until: addDays(toYmd(observedOn), WATCH_SUPPRESS_DAYS),
    model_version: WATCH_MODEL_VERSION,
    crop_type_slug: candidate.crop_type_slug ?? null,
    variety_id: candidate.variety_id ?? null,
    anchor_kind: a.kind ?? null,
    anchor_date: toYmd(a.date),
    anchor_basis: a.basis ?? null,
    anchor_basis_shifted: !!a.basis_shifted,
    expected_days: a.expected_days ?? null,
    lead_days: a.lead_days ?? null,
    check_from: toYmd(candidate.check_from),
    days_watching: candidate.days_watching ?? null,
  };
}
