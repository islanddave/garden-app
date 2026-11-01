// PURE derivation of a missing planting anchor (V4-ANCHORBASE-001). Imports nothing runtime (no
// neon/clerk/aws), same split as ./watch.js and ./aggregate.js.
//
// A planting with no sown_at, no transplanted_at and no planted_out_at cannot support a calendar anchor,
// so the harvest watch list (watch.js) drops it with reason `no_anchor`. This derives the missing anchor:
// a sow event first, a transplant event second, a nursery-handling event third, then the floor of
// add-date + ADD_DATE_OFFSET_DAYS.
//
// TIER 3 DOMINATES AND IS A GUESS. The add-date floor never fails (every planting has a created_at), so
// coverage reaches 100% once it is on and stops being a quality signal. Measured spread is in
// ADD_DATE_OFFSET_MEASURED: only about half of plantings fall within a week of the add-date. That is why
// a derived anchor is labelled at three layers and why summarizeDerivations reports the baseline SHARE.
// Tiers 1 and 2 are empty or structurally empty today: the app writes transplanted_at when it logs the
// transplant event, so an event can never rescue an anchorless planting.
//
// THE MARKING RULE (the load-bearing invariant): a derived date must NEVER be indistinguishable from an
// observed one, or a model fitted on anchors it invented is fitting its own assumption. Three layers,
// each independently tested:
//   1. STORAGE. The backfill (migrations/v4-anchorbase-001/) writes derived_anchor_date / _source /
//      _confidence / _model_version / _at, NEVER sown_at / transplanted_at / planted_out_at. That also
//      makes it reversible with one UPDATE to NULL.
//   2. WIRE. Every object returned carries `derived: true` plus `source`, `confidence` and
//      `model_version`. deriveAnchor() returns null for a planting that already has a real date, so
//      derivation can never overwrite an observation.
//   3. COPY. The watch row's `basis` string for a derived anchor always opens with `est.` (see
//      describeDerivation and watch.js's describeBasis), and a derived anchor ranks BELOW every real one.
//
// `plants.*_approx` is deliberately NOT reused: `sown_at_approx` means the user entered an unsure date,
// derived means the system invented one. Folding them together would reclassify user entries as machine output.

import { toYmd, addDays, daysBetween } from './watch.js';

// Bumped whenever the derivation changes. Frozen onto every derived row so a later revision cannot
// re-interpret anchors an older model produced (same contract as WATCH_MODEL_VERSION).
export const ANCHOR_DERIVE_MODEL_VERSION = 'anchor-derive-v1';

// The stated baseline (BD0806-27), kept as specified and not "corrected" to the measured median.
// The measurement sits beside it so the gap is visible.
export const ADD_DATE_OFFSET_DAYS = 7;

// Measured on live prod over the non-deleted plantings holding both an add-date and a transplant date,
// the population the backfill computes its household median from. Sent on the wire so a consumer sees
// the uncertainty, not just the point estimate.
export const ADD_DATE_OFFSET_MEASURED = Object.freeze({
  median_days: 9, p25_days: 2, p75_days: 22, min_days: -17, max_days: 48,
  sample_n: 112, within_7d: 53, within_7d_rate: 0.473,
});

// Minimum dual-dated plantings before a household's own median is trusted over the constant (same as
// watch.js's nursery offset).
export const OFFSET_MIN_SAMPLE = 5;

// Event types that ESTABLISH a sow date: `sowing`, and `seed_soak`, which only happens to seed.
export const SOW_EVENT_TYPES = Object.freeze(['sowing', 'seed_soak']);

// Event types that ESTABLISH a transplant. Exactly one, and it already writes the column.
export const TRANSPLANT_EVENT_TYPES = Object.freeze(['transplant']);

// Events that prove the planting existed and was being handled on that date but are NOT a transplant.
// Ranked below a real transplant with their own `confidence` so a consumer can exclude them.
export const NURSERY_PROXY_EVENT_TYPES = Object.freeze(['potting_up', 'hardening_off', 'brought_outside']);

// Ordered. The first tier whose evidence is present wins.
export const DERIVATION_TIERS = Object.freeze([
  Object.freeze({ tier: 1, source: 'sow_event', field: 'sown_at', confidence: 'event' }),
  Object.freeze({ tier: 2, source: 'transplant_event', field: 'transplanted_at', confidence: 'event' }),
  Object.freeze({ tier: 2.5, source: 'nursery_proxy_event', field: 'transplanted_at', confidence: 'proxy' }),
  Object.freeze({ tier: 3, source: 'add_date_baseline', field: 'transplanted_at', confidence: 'baseline' }),
]);

const TIER_BY_SOURCE = Object.freeze(Object.fromEntries(DERIVATION_TIERS.map((t) => [t.source, t])));

// The observed columns. A planting holding ANY of these is off limits to derivation (marking-rule layer 2).
// A property of the ROW, not the caller: there is deliberately no opts flag that enables overwriting.
export const OBSERVED_ANCHOR_FIELDS = Object.freeze(['sown_at', 'transplanted_at', 'planted_out_at']);

export function observedAnchorOf(row) {
  for (const field of OBSERVED_ANCHOR_FIELDS) {
    const date = toYmd(row?.[field]);
    if (date != null) return { field, date };
  }
  return null;
}

// Median of a numeric array. Even length takes the lower-middle, so the result is always a whole number of days.
export function medianDays(values) {
  const nums = (values ?? []).map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  return nums[Math.floor((nums.length - 1) / 2)];
}

// Resolve the add-date offset for a household: its own dual-dated plantings if there are enough,
// otherwise the stated constant. Returns the source too, so a thin sample is visible on the wire.
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

// Derive the anchor a planting is missing. Returns null, never a partial or unmarked object, when the
// planting already has an observed anchor, there is no evidence, or the row is unusable.
//
// opts:
//   etToday       required for the tier-3 future clamp; also stamps `derived_on`.
//   offset        { days, source, sample_n } from resolveAddDateOffset. Defaults to the constant.
export function deriveAnchor(row, opts = {}) {
  if (!row) return null;

  // Marking-rule layer 2: an observed date is never touched, so the planting keeps what the user entered.
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

  // Tier 3, the floor: needs only the add-date, so it catches everything above and its label matters more than its value.
  const addDate = toYmd(row.add_date ?? row.created_at);
  if (addDate == null) return null;
  const baseline = addDays(addDate, offset.days);
  if (baseline == null) return null;
  return mark(TIER_BY_SOURCE.add_date_baseline, baseline, addDate, offset.days, { etToday, offset, row });
}

// Build the marked result. EVERY exit from deriveAnchor goes through here, so `derived: true` and the
// provenance fields cannot be omitted by adding a tier and forgetting them.
function mark(spec, date, evidenceDate, offsetApplied, ctx) {
  const { etToday, offset } = ctx;

  // A derived anchor dated in the future says the planting has not started (it happens when a planting
  // is added within `offset` days of today). Clamped to today and MARKED rather than dropped, because
  // "no elapsed time yet" is information a maturity calculation should see.
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
    // Only the baseline has a measured spread. null means "no spread to report", not "spread of zero".
    spread_days: spec.source === 'add_date_baseline' ? ADD_DATE_OFFSET_MEASURED : null,
  };
}

// Marking-rule layer 3: every derived basis opens with `est.` so it cannot be read as a record. Short,
// like watch.js's describeBasis, because the watch row is compact.
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

// Census over a set of rows: what each tier recovers and what is left. Counts the ALREADY-ANCHORED rows
// too, so a recovery percentage has an honest denominator.
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
  // What fraction of everything recovered rests on the baseline guess.
  summary.baseline_share = summary.derivable === 0
    ? 0
    : summary.by_source.add_date_baseline / summary.derivable;
  return summary;
}
