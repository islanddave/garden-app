// anchorDerive.js — V4-ANCHORBASE-001 (BD-001a + BD0806-27). PURE derivation of a missing planting
// anchor. Imports NOTHING runtime (no neon/clerk/aws), same split as ./watch.js and ./aggregate.js.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS IS FOR
//
// A planting with no sown_at, no transplanted_at and no planted_out_at cannot support a calendar
// anchor, so the harvest watch list (lambda/harvests/watch.js) drops it with reason `no_anchor`.
// Dave's ask, verbatim from the 2026-08-04 braindump: "Anything we sow, we should have. Anything
// that we've kind of noted a transplant or what have you, that's great" — i.e. derive the missing
// anchor from a sow event first, a transplant event second. BD0806-27 adds the floor: "assume
// transplant happened within a week of the date the planting was added to the app inventory" ->
// baseline = add-date + 7 days, which he estimated right ~98% of the time.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHAT LIVE PROD SAYS ABOUT THAT PRECEDENCE (read-only, garden_ro, 2026-08-12; household = Dave,
// Jen has zero live plantings, so every figure here is DAVE'S, not a household average)
//
// Universe = the 247 live plantings the watch route itself scans. 64 of them (25.9%) carry no date
// anchor of any kind. Running the tiers over those 64 — measured by executing THIS MODULE over live
// rows via scripts/measure-anchor-coverage.{sql,mjs}, not by hand-derived SQL:
//
//   tier 1  sow event        ->  0 recovered (0.0%).  `sowing` and `seed_soak` are defined in
//                                src/lib/eventTypes.js but event_log holds ZERO rows of either type
//                                against any planting. The tier is correct and it is empty.
//   tier 2  transplant event ->  0 recovered (0.0%).  110 plantings carry a `transplant` event and
//                                ALL 110 already have transplanted_at set (89 of them exactly equal
//                                to the event date). The app writes the column when the event is
//                                logged, so a transplant event can never rescue an anchorless
//                                planting. This tier is not merely empty today — it is STRUCTURALLY
//                                empty until that write path changes.
//   tier 2b nursery proxy    ->  7 recovered (10.9%). potting_up / hardening_off / brought_outside.
//                                NOT a transplant; an observation that the planting physically
//                                existed and was being handled on that date. Kept separate from
//                                tier 2 for exactly that reason — see the confidence note below.
//   tier 3  add-date+offset  -> 57 recovered (89.1%), i.e. 100% of what tiers 1+2b leave.
//   residual unanchored      ->  0.
//
// TIER 3 DOMINATES — 89.1% of everything the derivation recovers — AND THE BASELINE IS NOT THE ~98%
// DAVE ESTIMATED. Measured over the 112 non-deleted plantings that carry both an add-date and a
// transplant date: median (transplanted_at - add_date) = +9 days, p25 +2, p75 +22, range -17..+48,
// and only 53 of 112 (47.3%) fall within +/-7 days of the add-date. (Restricted to the 105 LIVE
// such plantings the picture is the same: median +5, 49.5% within a week.) The central tendency is
// in the right area; the SPREAD is not. A baseline anchor is right about half the time to within a
// week, and a quarter of the time it is off by more than three weeks. That is a guess wearing a
// date's clothing, which is why it is labelled at three separate layers (storage / wire / copy) and
// why nothing consumes it until Dave says so.
//
// NOTE THE SHAPE OF THAT RESIDUAL: zero. The add-date floor NEVER fails, because every planting has
// a created_at. So "anchor coverage" goes to 100% the moment tier 3 is switched on, and coverage
// therefore stops being a quality signal entirely — it measures only that the floor exists. The
// number worth watching is the baseline SHARE, which is why summarizeDerivations reports it.
//
// The one place the add-date IS excellent: sown_at - add_date has median 0 and 99 of 111 within a
// week (89% are exactly 0) — when Dave sows, he logs it same day. That accuracy belongs to a date he
// ALREADY RECORDED, though; it does not transfer to plantings that have no sow record at all.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE MARKING RULE (the load-bearing invariant of this module)
//
// A derived date must NEVER be indistinguishable from an observed one. The calibration work depends
// on knowing which is which: a model fitted on anchors it invented is fitting its own assumption.
// Enforced at three layers, each independently tested:
//
//   1. STORAGE  — the backfill (migrations/v4-anchorbase-001/) writes derived_anchor_date /
//      _source / _confidence / _model_version / _at, NEVER sown_at / transplanted_at /
//      planted_out_at. The observed columns stay observed. This also makes the backfill trivially
//      reversible: one UPDATE to NULL, no lost user data.
//   2. WIRE     — every object this module returns carries `derived: true` plus `source`,
//      `confidence` and `model_version`. deriveAnchor() returns null for any planting that already
//      has a real date, so derivation can never overwrite an observation even by accident.
//   3. COPY     — the watch row's `basis` string for a derived anchor always opens with `est.`
//      (see describeDerivation and watch.js's describeBasis). A derived anchor also ranks BELOW
//      every real anchor, so it is never the provenance a row cites when anything better has fired.
//
// `plants.*_approx` is deliberately NOT reused for this. `sown_at_approx` (88 live rows) means Dave
// entered a date he was unsure of; derived means the system invented one he never entered. Folding
// the second into the first would destroy the distinction the calibration set needs, and would
// silently reclassify 88 of Dave's own entries as machine output.

import { toYmd, addDays, daysBetween } from './watch.js';

// Bumped whenever the derivation changes. Frozen onto every derived row so a later revision cannot
// silently re-interpret anchors an older model produced — same contract as WATCH_MODEL_VERSION.
export const ANCHOR_DERIVE_MODEL_VERSION = 'anchor-derive-v1';

// DAVE'S STATED BASELINE (BD0806-27), honoured as specified and not quietly "corrected" to the
// measured median — it is his call to make. The measurement sits beside it so the gap is visible.
export const ADD_DATE_OFFSET_DAYS = 7;

// MEASURED on live prod 2026-08-12 over the 112 non-deleted plantings holding both an add-date and
// a transplant date — the same population the backfill computes its household median from. Reported
// on the wire so a consumer sees the uncertainty, not just the point estimate.
export const ADD_DATE_OFFSET_MEASURED = Object.freeze({
  median_days: 9, p25_days: 2, p75_days: 22, min_days: -17, max_days: 48,
  sample_n: 112, within_7d: 53, within_7d_rate: 0.473,
});

// Minimum dual-dated plantings before a household's own median is trusted over the constant. Same
// threshold and rationale as watch.js's nursery offset.
export const OFFSET_MIN_SAMPLE = 5;

// Event types that ESTABLISH a sow date. `sowing` is the real one; `seed_soak` immediately precedes
// sowing and is the only other event that can only happen to seed. Both are zero-row on prod today.
export const SOW_EVENT_TYPES = Object.freeze(['sowing', 'seed_soak']);

// Event types that ESTABLISH a transplant. Exactly one, and it already writes the column.
export const TRANSPLANT_EVENT_TYPES = Object.freeze(['transplant']);

// Events that do NOT establish a transplant but DO prove the planting physically existed and was
// being handled on that date. Ranked below a real transplant and given its own `confidence` so a
// consumer can exclude them; calling a potting-up a transplant would be a fabrication, whereas
// "this plant existed by then" is simply true and is strictly better than the add-date floor.
export const NURSERY_PROXY_EVENT_TYPES = Object.freeze(['potting_up', 'hardening_off', 'brought_outside']);

// Ordered. First tier whose evidence is present wins — this IS the precedence Dave specified.
export const DERIVATION_TIERS = Object.freeze([
  Object.freeze({ tier: 1, source: 'sow_event', field: 'sown_at', confidence: 'event' }),
  Object.freeze({ tier: 2, source: 'transplant_event', field: 'transplanted_at', confidence: 'event' }),
  Object.freeze({ tier: 2.5, source: 'nursery_proxy_event', field: 'transplanted_at', confidence: 'proxy' }),
  Object.freeze({ tier: 3, source: 'add_date_baseline', field: 'transplanted_at', confidence: 'baseline' }),
]);

const TIER_BY_SOURCE = Object.freeze(Object.fromEntries(DERIVATION_TIERS.map((t) => [t.source, t])));

// The observed columns. A planting holding ANY of these is off limits to derivation — layer 2 of the
// marking rule. Note this is a property of the ROW, not of the caller: there is no opts flag that
// enables overwriting, because the module that can overwrite an observation is one bug away from
// laundering a guess into a record.
export const OBSERVED_ANCHOR_FIELDS = Object.freeze(['sown_at', 'transplanted_at', 'planted_out_at']);

export function observedAnchorOf(row) {
  for (const field of OBSERVED_ANCHOR_FIELDS) {
    const date = toYmd(row?.[field]);
    if (date != null) return { field, date };
  }
  return null;
}

// Median of a numeric array. Even-length takes the lower-middle rather than the mean, so the result
// is always a whole number of days that some real planting actually exhibited.
export function medianDays(values) {
  const nums = (values ?? []).map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  return nums[Math.floor((nums.length - 1) / 2)];
}

// Resolve the add-date offset for a household. Its own dual-dated plantings if it has enough of
// them, otherwise Dave's stated constant. Returns the source too — a thin sample must be visible on
// the wire rather than silently trusted.
export function resolveAddDateOffset(samples) {
  const median = medianDays(samples);
  if (median == null || (samples?.length ?? 0) < OFFSET_MIN_SAMPLE) {
    return { days: ADD_DATE_OFFSET_DAYS, source: 'stated_baseline', sample_n: samples?.length ?? 0 };
  }
  return { days: median, source: 'household_median', sample_n: samples.length };
}

function firstEventDate(events, types) {
  let best = null;
  for (const ev of events ?? []) {
    if (!types.includes(ev?.event_type)) continue;
    const date = toYmd(ev?.event_date);
    if (date == null) continue;
    if (best == null || date < best) best = date;
  }
  return best;
}

// Derive the anchor a planting is missing.
//
// Returns null — never a partial or an unmarked object — when the planting already has an observed
// anchor, when there is no evidence at all, or when the row is unusable. A caller therefore cannot
// receive a derived date without the `derived: true` marking attached to it.
//
// opts:
//   etToday       required for the tier-3 future clamp; also stamps `derived_on`.
//   offset        { days, source, sample_n } from resolveAddDateOffset. Defaults to the constant.
export function deriveAnchor(row, opts = {}) {
  if (!row) return null;

  // Layer 2 of the marking rule: an observed date is never touched, never overwritten, never
  // "improved". If one exists the answer is null and the planting keeps what Dave entered.
  if (observedAnchorOf(row) != null) return null;

  const events = row.events ?? [];
  const offset = opts.offset ?? { days: ADD_DATE_OFFSET_DAYS, source: 'stated_baseline', sample_n: 0 };
  const etToday = toYmd(opts.etToday);

  const sow = firstEventDate(events, SOW_EVENT_TYPES);
  if (sow != null) return mark(TIER_BY_SOURCE.sow_event, sow, sow, 0, { etToday, offset, row });

  const transplant = firstEventDate(events, TRANSPLANT_EVENT_TYPES);
  if (transplant != null) {
    return mark(TIER_BY_SOURCE.transplant_event, transplant, transplant, 0, { etToday, offset, row });
  }

  const proxy = firstEventDate(events, NURSERY_PROXY_EVENT_TYPES);
  if (proxy != null) {
    return mark(TIER_BY_SOURCE.nursery_proxy_event, proxy, proxy, 0, { etToday, offset, row });
  }

  // Tier 3 — the floor. Needs the add-date and nothing else, which is why it catches everything the
  // tiers above leave and why its label matters more than its value.
  const addDate = toYmd(row.add_date ?? row.created_at);
  if (addDate == null) return null;
  const baseline = addDays(addDate, offset.days);
  if (baseline == null) return null;
  return mark(TIER_BY_SOURCE.add_date_baseline, baseline, addDate, offset.days, { etToday, offset, row });
}

// Build the marked result. EVERY exit from deriveAnchor goes through here, so `derived: true` and
// the provenance fields cannot be omitted by adding a new tier and forgetting them.
function mark(spec, date, evidenceDate, offsetApplied, ctx) {
  const { etToday, offset } = ctx;

  // A derived anchor dated in the future is not an anchor — it says the planting has not started.
  // Happens whenever a planting is added within `offset` days of today (live prod has one: Speckled
  // Roman Rescue, added 2026-08-12). Clamped to today and MARKED, rather than dropped, because the
  // clamp is information: it says "no elapsed time yet", which a maturity calculation should see.
  let anchorDate = date;
  let clamped = false;
  if (etToday != null && anchorDate > etToday) {
    anchorDate = etToday;
    clamped = true;
  }

  return {
    // ── the marking. Layer 2. ──
    derived: true,
    model_version: ANCHOR_DERIVE_MODEL_VERSION,
    source: spec.source,
    tier: spec.tier,
    confidence: spec.confidence,

    // ── the value and how it was reached ──
    field: spec.field,
    date: anchorDate,
    evidence_date: evidenceDate,
    offset_days: offsetApplied,
    offset_source: offsetApplied > 0 ? offset.source : null,
    offset_sample_n: offsetApplied > 0 ? (offset.sample_n ?? 0) : null,
    clamped_to_today: clamped,
    derived_on: etToday,

    // ── the uncertainty, carried rather than dropped ──
    // Only the baseline has a measured spread; an event date has none, it is a date something
    // happened on. A null here means "no spread to report", never "spread of zero unknown".
    spread_days: spec.source === 'add_date_baseline' ? ADD_DATE_OFFSET_MEASURED : null,
  };
}

// Layer 3 of the marking rule: the copy. Every derived basis opens with `est.` so a derived anchor
// cannot be read as a record in any surface that prints this string. Short, because the watch row is
// compact — the same constraint watch.js's describeBasis works under.
const SOURCE_PHRASE = {
  sow_event: 'sow event',
  transplant_event: 'transplant event',
  nursery_proxy_event: 'nursery event',
  add_date_baseline: 'add-date',
};

export function describeDerivation(derived, etToday) {
  if (!derived?.derived) return null;
  const phrase = SOURCE_PHRASE[derived.source] ?? derived.source;
  const age = daysBetween(derived.date, etToday);
  const agePart = age == null ? '' : ` ${age}d`;
  return `est.${agePart} from ${phrase}`;
}

// Census over a set of rows: what each tier recovers, and what is left unrecovered. This is the
// measurement the backfill reports before it writes anything, and the shape the lane's report table
// is built from. Deliberately counts the ALREADY-ANCHORED rows too, so a recovery percentage always
// has an honest denominator.
export function summarizeDerivations(rows, opts = {}) {
  const summary = {
    total: 0,
    already_anchored: 0,
    derivable: 0,
    unrecoverable: 0,
    by_source: { sow_event: 0, transplant_event: 0, nursery_proxy_event: 0, add_date_baseline: 0 },
    by_confidence: { event: 0, proxy: 0, baseline: 0 },
    clamped: 0,
  };
  for (const row of rows ?? []) {
    summary.total += 1;
    if (observedAnchorOf(row) != null) { summary.already_anchored += 1; continue; }
    const d = deriveAnchor(row, opts);
    if (d == null) { summary.unrecoverable += 1; continue; }
    summary.derivable += 1;
    summary.by_source[d.source] += 1;
    summary.by_confidence[d.confidence] += 1;
    if (d.clamped_to_today) summary.clamped += 1;
  }
  // The number that has to be said out loud rather than inferred: what fraction of everything this
  // recovers rests on the baseline guess.
  summary.baseline_share = summary.derivable === 0
    ? 0
    : summary.by_source.add_date_baseline / summary.derivable;
  return summary;
}
