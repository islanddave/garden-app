// lambda/plants/validate.js — pure request-body validators for the plants Lambda.
// Mirrors lambda/varieties/validate.js in shape and contract. Bundled with index.js (whole-dir
// zip), so the relative import resolves at runtime. No side effects, no I/O.
//
// DELIBERATELY A TEXTUAL MIRROR, NOT AN IMPORT. Each Lambda zips from its own directory, so
// `import ... from '../varieties/validate.js'` resolves under vitest (which inlines and dedupes)
// and then 502s at module load in the deployed function. The house precedent for this is the
// authz-parents copies-sync test.

// BUG-COALESCECLEAR-001 — the columns a PUT may explicitly set back to NULL via `body.clear`.
//
// This list is TIER 1 of a three-tier triage against live prod schema + the care engine. It is not
// "every nullable column", and the exclusions below are the actual risk control — a blanket
// allowlist would be a worse bug than the one being fixed.
export const CLEARABLE_FIELDS = [
  // free text / json — no consumer branches on them
  'notes', 'metadata', 'lineage_note',
  // lifecycle dates + their approx flags. sown_at and germinated_at are safe because nothing
  // coalesces them into a care-engine basis; transplanted_at / planted_out_at are NOT (see below).
  'sown_at', 'sown_at_approx', 'germinated_at', 'germinated_at_approx',
  'transplanted_at_approx', 'planted_out_at_approx',
  // attrition / provenance. qty_initial and qty_current have no arithmetic consumer anywhere in
  // the repo (format.js renders '' for null); source_type's only consumer is a DENY-list, so NULL
  // falls through by design.
  'qty_initial', 'qty_current', 'loss_cause',
  'source_type', 'source_ref', 'source_generation',
  // lineage / succession FKs. The authz gates on these are already `!= null`-guarded, so a clear
  // skips the gate harmlessly rather than bypassing it.
  'parent_plant_id', 'divergence_type', 'succession_group_id', 'succession_order',
  'source_inventory_item_id',
  // container_size only. vesselSizeSmall() returns null on unparseable input and isSmallVessel()
  // FAILS SAFE TO SMALL (more watering, not less), so a cleared size cannot under-water.
  'container_size',
];

// ─── TIER 2 — nullable and DB-legal, but EXCLUDED until the care engine is fixed first ───────────
// Each of these would change a watering or protection recommendation on clear. They are not
// oversights; putting any of them in CLEARABLE_FIELDS without the paired engine fix is a
// silent-harm change. Enumerated (not just omitted) so the reasoning survives the next reader.
//
//   status           two defects. (a) AUDIT HOLE: index.js computes
//                    `_newStatus = body.status != null ? body.status : _oldStatus`, so a CLEAR
//                    makes _newStatus === _oldStatus, isStatusChange() is false, and the in-txn
//                    status_change event PLUS both entity_memory touches are silently skipped —
//                    audit-row data loss. (b) clearing a `dormant` status RESUMES calendar
//                    watering on a plant whose profile says not to (the DRG-NOCALWATER-001
//                    Lithops class) and drops the 40-45F protect task.
//   container_type   NULL falls out of likelyInGround(), so an in-ground planting loses
//                    water_interval_days_inground and inherits the SHORTER container cadence —
//                    over-watering. Also loses the fabric-bag heat gate, re-arming
//                    DRG-WATERCREDIT-004.
//   transplanted_at  substrate freshness coalesces through these. Clearing both, with no
//   planted_out_at   potting_up event, makes transplant_at NULL -> `?? 999` -> "not fresh", so a
//                    3-day-old plug in a solo cup gets full rain credit. DRG-WATERCREDIT-002 in
//                    reverse. Also shifts substrate_start to created_at, changing every fertilize
//                    recommendation.
//
// ─── TIER 3 — never clearable ────────────────────────────────────────────────────────────────────
//   display_name/name   DB NOT NULL (hard 23502). Also the cadence-lookup key and one of only two
//                       routes to the "bring inside tonight" cold task. Same call as varieties'
//                       exclusion of `name`.
//   quantity            DB NOT NULL, DEFAULT 1, CHECK quantity >= 1.
//   qty_harvested       Nullable, but counters with DEFAULT 0 that the POST writes as `?? 0`. NULL
//   qty_lost            is off-vocabulary here; clear-to-ZERO is the correct affordance, and it
//                       already works through the plain COALESCE path.
//   location_id         Already clearable via its own hasLocation sentinel — NOT added here, and
//                       tracked separately as BUG-NOLOCOUTDOOR-001 (a location-less planting
//                       currently resolves covered=false, i.e. OUTDOOR, which enables rain credit
//                       on an indoor plant). Do not fold that into this channel.
//   acquired_mature     Same call as location_id: already fully tri-state via its own
//                       hasAcquiredMature sentinel (V4-ACQMATURE-001), so this channel would add
//                       nothing. It would also be actively wrong here — `clear` means "set to
//                       NULL", and for this column NULL is not an empty value, it is the assertion
//                       "nobody has been asked", which is exactly what the sentinel already
//                       expresses without an ambiguous second spelling.
//   created_by          Guarded by an ownership-transfer trigger on 9 tables that raises on any
//                       IS DISTINCT FROM change — including value->NULL. Must never be listed.
export const CLEARABLE_SET = new Set(CLEARABLE_FIELDS);

// A defensive ceiling. `clear` becomes a bound text[] evaluated once per CASE arm; an unbounded
// array is DoS-annoyance rather than a hole (the route is rate-limited), but there is no legitimate
// request naming more fields than exist.
export const MAX_CLEAR_KEYS = 64;

// Absent/null/[] is the legacy no-op, so every existing caller is byte-identical. A key that is
// BOTH cleared and given a value is REJECTED rather than silently resolved — picking a winner for
// an ambiguous request is the exact failure mode this ticket exists to remove.
//
// Note `body[k] != null` (not `in`): a client that unconditionally sends every key as `value || null`
// still composes correctly with an explicit clear, which is what the declarative client-side patch
// builder emits.
export function validateClear(clear, body = {}) {
  if (clear == null) return null;
  if (!Array.isArray(clear)) return 'clear must be an array of field names';
  if (clear.length > MAX_CLEAR_KEYS) return `clear may name at most ${MAX_CLEAR_KEYS} fields`;
  for (const k of clear) {
    if (typeof k !== 'string' || !CLEARABLE_SET.has(k)) {
      return `clear contains a field that cannot be cleared: ${String(k)}`;
    }
    if (body[k] != null) return `${k} cannot be both cleared and set in the same request`;
  }
  return null;
}

// BUG-SOWNAPPROXORPHAN-001 — an `X_approx` flag says "the date in X is approximate". With no X it
// qualifies nothing, so it is not a false flag, it is a meaningless one. Returns NULL rather than
// false when the date is absent: false would assert "this absent date is EXACT", which is a
// different and equally unfounded claim. Used on the create path; the PUT enforces the same rule in
// SQL because it must consult the pre-update row.
//
// LIVES HERE, NOT IN index.js, and that is a CI constraint rather than taste: index.js imports
// @neondatabase/serverless and the AWS/Clerk SDKs, which are installed per-Lambda-dir and are NOT
// present in the ROOT node_modules that CI's `npm ci` builds. A unit test importing index.js
// resolves locally (those packages happen to be hoisted here) and fails in CI with
// "Failed to resolve import". validate.js is dependency-free by design, so importing from it is
// safe from both. Every other lambda test avoids this by reading index.js as TEXT.
export function approxOrNull(dateVal, approxVal) {
  return (dateVal ?? null) === null ? null : (approxVal ?? false);
}

// V4-ACQMATURE-001 — acquired_mature is a TRI-STATE, and the third state is the point of it.
//
//   true   this plant arrived already grown; its transplanted_at is an ARRIVAL date, not a growth
//          start, so its time-to-first-harvest measures the nursery, not this site
//   false  asked, and it started here
//   NULL   never asked — the DEFAULT, and NOT the same claim as false
//
// The site calibration excludes `true` from its cohort. A default of false would have stamped a
// verdict on all 261 live plantings that nobody made, and the exclusion predicate would then have
// read that fabrication as evidence — the recon measured that NO existing column, tag, event type
// or derived table can infer this (source_type is anti-correlated: nursery_transplant's mean ratio
// is 0.763 against a cohort mean of 0.717). NULL has to stay reachable and has to stay distinct.
//
// STRICT BOOLEAN, no truthy coercion. `"true"`, `1` and `"yes"` are all REJECTED rather than
// silently accepted, because a coerced string is how a client bug becomes a permanent wrong
// assertion about a real plant. Returns an error string or null, matching validateClear's contract.
export function validateAcquiredMature(body = {}) {
  if (!Object.prototype.hasOwnProperty.call(body, 'acquired_mature')) return null;
  const v = body.acquired_mature;
  if (v === null || v === undefined) return null;
  if (typeof v !== 'boolean') return 'acquired_mature must be true, false or null';
  return null;
}
