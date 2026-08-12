// watch.js — V4-HARVSURFACE-001 slice 1. DB-free PURE candidate logic for the Today "Worth checking
// this week" watch list (harvest-two-section-design-V100-20260811.md §3). Imports NOTHING runtime
// (no neon/clerk/aws) so it unit-tests under the root vitest config, same split as ./aggregate.js.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS MODULE EXISTS: the categorical blind spot it fixes
//
// The shipped readiness surface (GET /api/events/harvest-ready + src/lib/harvestReadiness.js) can
// NEVER show a large class of Dave's garden, because it gates twice:
//   (a) SERVER — lambda/events/index.js joins `last_pick` INNER, so a planting with ZERO recorded
//       picks is structurally absent from the payload. That route's own header calls this
//       deliberate ("Evidence only ... nothing here is a prediction of first harvest"), and for an
//       OVERDUE band that is right. It is exactly wrong for a FIRST-harvest watch list.
//   (b) CLIENT — isReadyToPick() returns false unless harvest_habit ∈ {repeat, cut_and_come_again},
//       so `single` is rejected even when it does reach the client.
//
// Measured against live prod 2026-08-12 (read-only, garden_ro), household = Dave (Jen has zero live
// plantings, so every figure here is Dave's, not a household average):
//   * 30 live plantings carry harvest_habit='single'; 23 of them have ZERO recorded picks.
//   * Those 23 include actively FRUITING Charentais + Green Flesh melons, a Tender Sweet Orange
//     watermelon, Yukon Gold potato, and a cabbage — crops in the ground, setting fruit, invisible.
//   * The other 7 single-habit plantings DO have picks and so clear gate (a), only to be dropped by
//     gate (b). Neither gate alone explains the hole; both must go.
//   * Live plantings with harvest_habit IS NULL (51, of which 50 have zero picks) are NOT part of
//     this blind spot — every one is an ornamental (geranium, coleus, succulent, pothos, hosta...).
//     They are correctly excluded and must STAY excluded. Do not "fix" that number.
//
// So this module admits `single` habit and requires no prior harvest. It anchors on what the
// planting actually has: an observed signal, a sibling's pick, or its own sow/transplant date.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// GRAMMAR CONTRACT (design §3.1, unanimous panel ruling — enforced by naming, not by copy)
//
// This module produces a WATCH LIST, never a verdict. Nothing here decides "ready"; it decides
// "worth walking over to look at". Field names say so on purpose (`check_from`, `days_watching`,
// `confidence`) so a client cannot render a prediction in an observation's grammar without first
// renaming a field. At 11.8% calibration with a 22-day median error, a row asserting "your window
// opened" is wrong most of the time and costs trust in the whole surface.

// ── Constants, each with its provenance stated ───────────────────────────────────────────────────

// Bumped whenever the anchoring math changes. FROZEN onto every dismissal row so a later model
// revision cannot silently re-interpret negative samples that an older model produced. Without
// this, the calibration set quietly mixes incompatible labels the first time a constant moves.
export const WATCH_MODEL_VERSION = 'watch-v1';

// MEASURED, not invented. The harvest-window crucible V100 measured calibration at 11.8% with a
// -22d median error: 30 of 34 picks happened BEFORE the model's predicted window opened. The model
// runs LATE by about three weeks, so a watch list anchored on nominal DTM would open its row about
// three weeks after Dave already picked the crop. The lead cancels that measured bias.
export const WATCH_LEAD_DAYS = 22;

// JUDGMENT BOUND, and labelled as one — this is the only constant here with no measurement behind
// it. It caps the lead at a quarter of the predicted interval so a short-interval crop cannot have
// its watch opened before the crop could plausibly be anywhere near picking (a 42-day fruit-set
// interval minus a flat 22 would start checking on day 20). Tighten it if watch rows read as noise.
export const WATCH_LEAD_MAX_FRACTION = 0.25;

// MEASURED from Dave's own plantings, live prod 2026-08-12: median (transplanted_at - sown_at) = 31
// days over the 39 plantings carrying both dates (range 0-64). Used ONLY for the basis-shift case
// below. The live route recomputes this per household and passes it in, so this value is the
// documented fallback when a household has too little data to compute its own.
export const NURSERY_OFFSET_DAYS_FALLBACK = 31;

// A single-habit crop is the POINT of this module (see the blind-spot note above). Repeating habits
// are admitted too: their FIRST harvest of the season is a watch-list event even though every
// subsequent one belongs to the overdue band. NULL habit is excluded — on live prod that set is
// entirely ornamental.
export const WATCHED_HABITS = new Set(['single', 'repeat', 'cut_and_come_again']);

// ── Pure YYYY-MM-DD date math ────────────────────────────────────────────────────────────────────
// String in, string out, UTC-anchored internally. NO `new Date()` without arguments anywhere in this
// file: every time input arrives as an argument (et_today is computed server-side in HARVEST_TZ), so
// jsdom tests cannot flake across a midnight boundary and the reporting zone stays the Lambda's.

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

// ── Anchor selection (design §3.4 hierarchy) ─────────────────────────────────────────────────────
//
// A watch row must REST on something. In descending strength:
//   1. `observed` — a signal Dave himself logged. Today the only such signal with a usable interval
//      is a `fruit_set` event paired with crop_types.set_to_first_pick_days (populated for melon=42
//      and watermelon=45 on live prod; 51 fruit_set events exist). Still a prediction FROM an
//      observation, so it takes the lead like any other prediction.
//   2. `sibling` — a sibling planting in the SAME project already picked this season. Same genetics,
//      same bed, same weather. The design calls this "the strongest anchor available in the data and
//      it is currently unused", and it is the anchor that rescues the exact crops Dave named:
//      Charentais and Tender Sweet Orange have NO sown_at at all, but each sits in a project whose
//      sibling (Minnesota Mini, Sugar Baby) first picked days ago.
//      This anchor takes NO lead: the sibling's pick date is an OBSERVATION that the crop is picking
//      in that bed right now, not a prediction to be de-biased. check_from IS that date.
//   3. `calendar` — sow/transplant/planted-out plus catalogue DTM, admitted only with its basis
//      carried on the wire so the client can state it ("sown 118d ago; catalogue 95d from sow").
//
// BASIS SHIFT — the defect that would otherwise sink tier 3 for the named crops. dtm_basis says
// which event the catalogue DTM counts from, and the planting frequently lacks THAT date but has
// another. Direction matters and the two directions are not symmetric:
//   * basis 'from-sow', only transplanted_at known: the transplant date is LATER than the true sow
//     date, so elapsed time is UNDERSTATED and the watch opens LATE — the failure mode that hides a
//     fruiting melon. Corrected by subtracting the measured nursery offset from the anchor date.
//   * basis 'from-transplant', only sown_at known: sowing PRECEDES transplant, so elapsed time is
//     OVERSTATED and the watch opens EARLY. Left uncorrected on purpose — early is the safe error
//     for a surface whose whole job is "go look", and inventing a second offset to fix a
//     conservative bias would be unjustified precision.
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

// Pick the calendar anchor for a row, honouring dtm_basis and reporting any basis shift.
export function calendarAnchor(row, nurseryOffsetDays) {
  const basis = row?.dtm_basis ?? null;
  const order = BASIS_PREFERENCE[basis] ?? DEFAULT_PREFERENCE;
  const preferred = order[0];
  for (const field of order) {
    const date = toYmd(row?.[field]);
    if (date == null) continue;
    const shifted = field !== preferred;
    // Only the from-sow-measured-from-transplant direction is corrected; see the note above.
    const needsOffset = basis === 'from-sow' && (field === 'transplanted_at' || field === 'planted_out_at');
    const offset = needsOffset
      ? Math.max(0, Math.trunc(Number(nurseryOffsetDays ?? NURSERY_OFFSET_DAYS_FALLBACK)) || 0)
      : 0;
    return {
      kind: 'calendar',
      date: offset > 0 ? addDays(date, -offset) : date,
      observed_date: date,
      basis,
      basis_field: field,
      basis_shifted: shifted,
      nursery_offset_applied: offset,
    };
  }
  return null;
}

// expected_days = the EARLIEST defensible maturity figure (design §3.5: "enters when its earliest
// defensible anchor fires"). days_to_maturity_min first, max only as a fallback.
export function expectedDaysFor(row) {
  const min = Number(row?.days_to_maturity_min);
  if (Number.isFinite(min) && min > 0) return min;
  const max = Number(row?.days_to_maturity_max);
  if (Number.isFinite(max) && max > 0) return max;
  return null;
}

// Resolve the single strongest anchor and the date the watch opens on. Returns null when the
// planting rests on nothing — a row with no anchor is NOT shown (design §3.4: "what a window row
// must rest on to be shown at all"), rather than shown with a shrug.
export function resolveWatchAnchor(row, opts = {}) {
  const nurseryOffsetDays = opts.nurseryOffsetDays ?? NURSERY_OFFSET_DAYS_FALLBACK;

  // Tier 1 — observed signal (fruit_set + set_to_first_pick_days).
  const fruitSet = toYmd(row?.fruit_set_date);
  const setToPick = Number(row?.set_to_first_pick_days);
  if (fruitSet != null && Number.isFinite(setToPick) && setToPick > 0) {
    const lead = leadDaysFor(setToPick);
    return {
      kind: 'observed',
      anchor_date: fruitSet,
      basis: 'from-fruit-set',
      basis_shifted: false,
      basis_field: 'fruit_set_date',
      expected_days: setToPick,
      lead_days: lead,
      nursery_offset_applied: 0,
      check_from: addDays(fruitSet, setToPick - lead),
      source_plant_id: null,
    };
  }

  // Tier 2 — a sibling in the same project already picked. No lead: this is an observation.
  const sibling = toYmd(row?.sibling_first_pick_date);
  if (sibling != null) {
    return {
      kind: 'sibling',
      anchor_date: sibling,
      basis: 'sibling-first-pick',
      basis_shifted: false,
      basis_field: 'sibling_first_pick_date',
      expected_days: null,
      lead_days: 0,
      nursery_offset_applied: 0,
      check_from: sibling,
      source_plant_id: row?.sibling_plant_id ?? null,
    };
  }

  // Tier 3 — calendar, basis stated.
  const expected = expectedDaysFor(row);
  const cal = calendarAnchor(row, nurseryOffsetDays);
  if (cal != null && expected != null) {
    const lead = leadDaysFor(expected);
    return {
      kind: 'calendar',
      anchor_date: cal.date,
      observed_anchor_date: cal.observed_date,
      basis: cal.basis,
      basis_shifted: cal.basis_shifted,
      basis_field: cal.basis_field,
      expected_days: expected,
      lead_days: lead,
      nursery_offset_applied: cal.nursery_offset_applied,
      check_from: addDays(cal.date, expected - lead),
      source_plant_id: null,
    };
  }

  return null;
}

// ── Candidate classification ─────────────────────────────────────────────────────────────────────
//
// Returns a discriminated result for EVERY row, eligible or not, so the route can report why a
// planting is absent instead of collapsing three different silences into one empty list (the
// `return null` failure the band already has). `reason` is diagnostic, never user copy.

export function classifyWatchCandidate(row, etToday, opts = {}) {
  const today = toYmd(etToday);
  if (!row || today == null) return { eligible: false, reason: 'no_today' };

  // The habit gate this module exists to widen. `single` is IN.
  if (!WATCHED_HABITS.has(row.harvest_habit)) {
    return { eligible: false, reason: 'habit_not_watched' };
  }

  // Queue exit 1 — Dave logged a first harvest. The planting graduates to the overdue band's world.
  if (Number(row.prior_harvest_count ?? 0) > 0) {
    return { eligible: false, reason: 'already_harvested' };
  }

  // Queue exit 2 — an active "not yet" dismissal. Suppression is a JOIN condition on the live route
  // as well; repeated here so the pure function tells the whole truth on its own.
  if (row.dismissed_active === true) {
    return { eligible: false, reason: 'dismissed' };
  }

  const anchor = resolveWatchAnchor(row, opts);
  if (anchor == null) return { eligible: false, reason: 'no_anchor' };
  if (anchor.check_from == null) return { eligible: false, reason: 'no_anchor' };

  const daysWatching = daysBetween(anchor.check_from, today);
  if (daysWatching == null) return { eligible: false, reason: 'no_anchor' };
  if (daysWatching < 0) return { eligible: false, reason: 'not_yet_open', check_from: anchor.check_from };

  return { eligible: true, reason: 'watching', anchor, check_from: anchor.check_from, days_watching: daysWatching };
}

// Wire projection. Field names carry the grammar contract (see the header) — `check_from` and
// `days_watching`, never `ready_at` or `days_overdue`.
export function projectWatchRow(row, verdict) {
  const a = verdict.anchor;
  return {
    plant_id: row.plant_id,
    project_id: row.project_id,
    planting_name: row.planting_name ?? null,
    location_id: row.location_id ?? null,
    location_name: row.location_name ?? null,
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
    },
    check_from: verdict.check_from,
    days_watching: verdict.days_watching,
  };
}

// Newest first (design §3.5: "Newest first"), i.e. most-recently-opened watch at the top — a row
// that has been watched for 40 days is the one Dave has already looked past. plant_id breaks ties so
// the order is total and the payload is stable across identical requests.
export function rankWatchCandidates(rows) {
  return [...rows].sort((x, y) => {
    if (x.days_watching !== y.days_watching) return x.days_watching - y.days_watching;
    return String(x.plant_id).localeCompare(String(y.plant_id));
  });
}

// Full pipeline over raw SQL rows. Returns the ranked list PLUS a reason census, so a zero-length
// list is explainable at the API boundary instead of being an unreadable silence.
export function buildWatchList(rows, etToday, opts = {}) {
  const candidates = [];
  const excluded = {};
  for (const row of rows ?? []) {
    const verdict = classifyWatchCandidate(row, etToday, opts);
    if (verdict.eligible) candidates.push(projectWatchRow(row, verdict));
    else excluded[verdict.reason] = (excluded[verdict.reason] ?? 0) + 1;
  }
  return { candidates: rankWatchCandidates(candidates), excluded };
}

// ── Dismissal snapshot ───────────────────────────────────────────────────────────────────────────
//
// WHY THE SERVER FREEZES THIS, AND WHY IT IS NOT JUST A UI HIDE.
//
// The harvest dataset has never held a single negative-class sample: every label in it is "Dave
// picked on date D". You cannot calibrate a ripeness model from positives alone — that is precisely
// why the estimate sits at 11.8% with a 22-day median error and has no mechanism to improve.
//
// A "not yet" tap is the first negative label the system can ever collect: at a KNOWN instant, on a
// KNOWN planting, a human LOOKED and reported not-ready. To be usable as a training sample it must
// carry the model's claim AS IT STOOD AT THAT MOMENT, which is what this function freezes:
//   * Recomputing the features later would LEAK THE ANSWER (the eventual harvest date is by then in
//     the data) and would drift anyway — crop_types.days_to_maturity and dtm_basis are edited, and
//     the anchor dates themselves get corrected. A sample whose features move is not a sample.
//   * `model_version` partitions the set, so a constant change here does not silently mix labels
//     produced by incompatible models.
//   * `observed_on` is separate from `dismissed_at` because it follows the harvest-date convention
//     this codebase already enforces — the OBSERVATION date is the truth, the write timestamp is
//     bookkeeping (30% of harvests are backdated; the same will be true of dismissals).
//
// The resulting pair is a supervised sample: features frozen here, and the label supplied later by
// the planting's eventual first-harvest date (already in event_log — no new capture needed). The
// target is `days_from_observation_to_first_pick`, which is > 0 by construction for every dismissal.
// A dismissal on a planting that NEVER gets harvested is not waste either: it is a right-censored
// observation, which survival-style calibration consumes directly.
//
// Built server-side from the server's own candidate row, never from client-supplied fields — a
// client that could post its own model snapshot could poison the calibration set, and a stale PWA
// bundle would post an old model's numbers under the current version string.
export function buildDismissalSnapshot(candidate, observedOn) {
  if (!candidate) return null;
  const a = candidate.anchor ?? {};
  return {
    plant_id: candidate.plant_id,
    project_id: candidate.project_id ?? null,
    observed_on: toYmd(observedOn),
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
