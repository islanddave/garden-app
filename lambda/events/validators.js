// Pure validators for Lambda 2.2.x POST /api/events.
// Extracted from index.js so unit tests can import without dragging in
// @neondatabase/serverless / @clerk/backend / @aws-sdk/* (which aren't installed
// at the app-level package and would break vitest resolution).
//
// V002 §1.2 (F5, F6, F18, F22 applied). Source of truth for HARVEST_UNITS /
// MAX_PLAUSIBLE values: harvest_log.unit CHECK constraint in
// migrations/v1-2a-2/0a-additive-ddl.sql — vocabulary drift will break the dual-write CTE.

// V4-TREATLOG-001 / BUG-EVENTEDITFIELDS-001. Exported so the PUT applies the SAME rule and the
// SAME message the POST does. Previously this list and its message were inline in validatePostBody
// only, so the edit path had no category check at all — a bad value reached
// event_log_treatment_category_check, which is VALIDATED, and the 23514 surfaced as an opaque 500.
export const VALID_TREATMENT_CATEGORIES = ['fertilizer', 'amendment', 'pest_control', 'other'];
export const TREATMENT_CATEGORY_ERROR =
  'treatment_category must be fertilizer, amendment, pest_control, or other';

export function validateTreatmentCategory(v) {
  if (v != null && !VALID_TREATMENT_CATEGORIES.includes(v)) {
    return { status: 400, error: TREATMENT_CATEGORY_ERROR };
  }
  return null;
}

export const HARVEST_UNITS = ['lb', 'oz', 'kg', 'g', 'count', 'bunch', 'cup', 'head'];
export const MAX_PLAUSIBLE = {
  count: 10000, lb: 500, oz: 8000, kg: 500, g: 500000,
  bunch: 1000, cup: 1000, head: 1000,
};

// V4-HARVDUAL-001 Slice A — the OPTIONAL measured-weight half of a harvest. Separate vocabulary from
// HARVEST_UNITS on purpose: a weight is always a weight, so 'count'/'cup'/'head'/'bunch' are not
// admissible here even though they are valid harvest.unit values.
// Kitchen scales read oz and lb, so the client sends whatever the scale showed and the SERVER
// converts — grams is the only thing that reaches the database (harvest_log.weight_grams).
export const WEIGHT_UNITS = ['g', 'kg', 'lb', 'oz'];
export const WEIGHT_UNIT_GRAMS = { g: 1, kg: 1000, lb: 453.592, oz: 28.3495 };
// 50 kg in one pick. Deliberately far below MAX_PLAUSIBLE.g (500 000) — that cap governs a harvest
// LOGGED in grams, where a big number is a legitimate unit artefact; this one governs a hand-weighed
// bowl, where 50 kg is a typo. Catches the fat-finger (337 -> 3370) without blocking a real haul.
export const MAX_PLAUSIBLE_WEIGHT_G = 50000;

// Grams for a user-entered weight. Defaults to grams when weight_unit is omitted.
export function toGrams(weight, unit) {
  return weight * (WEIGHT_UNIT_GRAMS[unit ?? 'g'] ?? 1);
}

// V4-HARVDUAL-001 Slice C — did the USER type this row's weight, as opposed to it being derived?
//
// harvest_log.weight_estimated=false has TWO causes and they are not interchangeable:
//   (a) the user weighed the pick and typed the grams   -> an independent fact; preserve it, and it
//                                                          is what calibrates the variety
//   (b) the quantity itself was a weight ("3 lb")       -> derived from quantity+unit; recompute it,
//                                                          and it teaches nothing about grams-per-item
// Only (a) may seed a cultivar_weight_sample, and only (a) survives an edit that omits the weight.
// Extracted here because the create path, the edit path and the calibration hook must agree, and
// re-deriving the test at each site is how the three drift apart.
export function isUserSuppliedWeight(harvestRow) {
  if (!harvestRow) return false;
  if (harvestRow.weight_estimated !== false) return false;
  if (harvestRow.weight_grams == null) return false;
  if (WEIGHT_UNITS.includes(harvestRow.unit)) return false;
  return Number(harvestRow.weight_grams) > 0;
}

// F22 event_date bounds. Tolerates clock-skew + small client lag.
const PAST_BOUND_MS = 5 * 365 * 24 * 3600 * 1000;
const FUTURE_BOUND_MS = 3600 * 1000;

// Returns null on success, or { status, error } on validation failure.
export function validatePostBody(body) {
  if (!body.event_type) return { status: 400, error: 'event_type is required' };

  // BUG-CAPTUREFLOW400-001 (Dave decision S1: project-less plantings ARE a supported state).
  //
  // This used to be an unconditional `project_id is required`, which contradicted the plantings
  // surface: V3-CAPTURE-001 deliberately made garden_node.container_id nullable so CaptureFlow
  // could create a photo-first planting with no project. CaptureFlow then POSTed an event for that
  // planting and hit a GUARANTEED 400 here — a contract split between two halves of one flow, not
  // a typo. Verified nullable on live prod: garden_node.container_id and event_log.project_id are
  // both NULLABLE.
  //
  // The real invariant is the DB's entity_memory_exactly_one_parent CHECK — an event must hang off
  // SOMETHING. So require project_id OR plant_id rather than project_id alone. Requiring at least
  // one still rejects a fully parentless event, which would be unreachable in every read path
  // (every listing joins through one of them).
  if (!body.project_id && !body.plant_id) {
    return { status: 400, error: 'project_id or plant_id is required' };
  }

  // V3-EVENT-003 §3.1 — status_change is emitted ONLY by the server-side status-transition
  // path (plants/projects PUT). Reserve it from the public POST so a client cannot forge one.
  if (body.event_type === 'status_change') {
    return { status: 400, error: 'status_change is set automatically and cannot be logged directly' };
  }

  // F22 — event_date range validation
  if (body.event_date != null) {
    const ed = new Date(body.event_date);
    if (!Number.isFinite(ed.getTime())) return { status: 400, error: 'event_date invalid' };
    const now = Date.now();
    if (ed.getTime() < now - PAST_BOUND_MS) return { status: 400, error: 'event_date too far in past' };
    if (ed.getTime() > now + FUTURE_BOUND_MS) return { status: 400, error: 'event_date in future' };
  }

  // F6 reorder: severity SHAPE check first.
  if (body.severity != null && ![1, 2, 3].includes(body.severity)) {
    return { status: 400, error: 'severity must be 1, 2, or 3' };
  }
  // F5: severity REQUIRED when flagged_as_issue=true
  if (body.flagged_as_issue === true && body.severity == null) {
    return { status: 400, error: 'severity required when flagged_as_issue=true' };
  }
  // severity without flag invalid
  if (body.severity != null && body.flagged_as_issue !== true) {
    return { status: 400, error: 'severity requires flagged_as_issue=true' };
  }

  // Harvest validators
  if (body.event_type === 'harvest') {
    // BUG-HARVESTEDIT-001: delegated to validateHarvestFields so the create and edit paths share
    // one rule set. Behaviour here is unchanged — same checks, same messages, same order.
    const harvestErr = validateHarvestFields(body.harvest);
    if (harvestErr) return harvestErr;
  }

  // Forbid harvest fields on non-harvest events
  if (body.event_type !== 'harvest' && body.harvest != null) {
    return { status: 400, error: 'harvest fields only valid on event_type=harvest' };
  }

  // V4-TREATLOG-001: treatment_category, when present, must be a known kind.
  const catErr = validateTreatmentCategory(body.treatment_category);
  if (catErr) return catErr;

  // V4-WATERMATH-001 F0: `metadata` has always been passed straight through to the jsonb column
  // unvalidated. The amount-capture keys are now LOAD-BEARING (the F2 ledger folds them into the
  // watering math and the 30-day instrumentation gate counts them), so they get a vocabulary check
  // at the edge. Everything else in metadata keeps its historic pass-through behaviour.
  const metaErr = validateEventMetadata(body.metadata);
  if (metaErr) return metaErr;

  return null;
}

// ── V4-WATERMATH-001 F0 — watering amount capture ───────────────────────────────────────────────
// `metadata.water_depth` ('light'|'normal'|'deep') + `metadata.water_depth_source` ('user'|'default').
//
// WHY a whitelist and not free-text: these two keys feed the ledger's per-event water contribution.
// An unrecognised class does not degrade gracefully — it silently drops out of every aggregate and
// reads as "no annotation", which is indistinguishable from the habituation signal the 30-day
// instrumentation gate is trying to measure. Rejecting at the edge keeps "unannotated" honest.
//
// This validates SHAPE only. It does not require water_depth on watering events (the whole design
// is zero-added-taps-by-default), and it does not forbid it on other types — `rain` may plausibly
// carry one later, and a 400 on an unrelated type would be a gratuitous break.
import {
  NON_REWARD_EVENT_TYPES, isRewardedEventType,
  WATER_DEPTH_CLASSES, WATER_DEPTH_SOURCES,
} from './eventTypes.generated.js';
export { NON_REWARD_EVENT_TYPES, isRewardedEventType, WATER_DEPTH_CLASSES, WATER_DEPTH_SOURCES };

export const WATER_DEPTH_ERROR = `metadata.water_depth must be one of: ${WATER_DEPTH_CLASSES.join(', ')}`;
export const WATER_DEPTH_SOURCE_ERROR = `metadata.water_depth_source must be one of: ${WATER_DEPTH_SOURCES.join(', ')}`;
export const WATER_DEPTH_ORPHAN_ERROR = 'metadata.water_depth_source requires metadata.water_depth';

// A plain JSON object — not null, not an array. `metadata` is a jsonb column so Postgres would
// happily take an array or a scalar; every reader in the app does `metadata->>'key'`, which
// silently yields NULL for those shapes rather than erroring, so the check belongs here.
export function isPlainMetadataObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

// Returns null on success, or { status, error }.
export function validateEventMetadata(metadata) {
  if (metadata == null) return null;
  if (!isPlainMetadataObject(metadata)) {
    return { status: 400, error: 'metadata must be an object' };
  }
  const depth = metadata.water_depth;
  if (depth != null && !WATER_DEPTH_CLASSES.includes(depth)) {
    return { status: 400, error: WATER_DEPTH_ERROR };
  }
  const source = metadata.water_depth_source;
  if (source != null && !WATER_DEPTH_SOURCES.includes(source)) {
    return { status: 400, error: WATER_DEPTH_SOURCE_ERROR };
  }
  // Provenance without a value is meaningless and would corrupt the annotation-rate metric
  // (a row counted as "user-set" with nothing set).
  if (source != null && depth == null) {
    return { status: 400, error: WATER_DEPTH_ORPHAN_ERROR };
  }
  return null;
}

// BUG-HARVESTEDIT-001 — the harvest-field rules, extracted VERBATIM from validatePostBody so the
// edit path cannot drift from the create path. That drift is the whole reason this bug exists:
// harvest_log had one INSERT and no UPDATE, so nothing was keeping two write paths in agreement
// because there was only ever one. Now there are two, and they share this function.
//
// Mirrors harvest_log's live CHECKs: harvest_log_unit_check (the 8-value enum),
// harvest_log_quality_rating_check (NULL or 1-5), plus the app-level per-unit plausibility cap.
// Returns null on success, or { status, error }.
export function validateHarvestFields(h) {
  if (!h || typeof h !== 'object') {
    return { status: 400, error: 'harvest fields required for event_type=harvest' };
  }
  if (typeof h.quantity !== 'number' || !Number.isFinite(h.quantity) || h.quantity <= 0) {
    return { status: 400, error: 'harvest.quantity must be a positive finite number' };
  }
  if (!HARVEST_UNITS.includes(h.unit)) {
    return { status: 400, error: 'harvest.unit invalid' };
  }
  if (h.quantity > MAX_PLAUSIBLE[h.unit]) {
    return { status: 400, error: `harvest.quantity exceeds max for unit ${h.unit}` };
  }
  if (h.quality_rating != null && ![1, 2, 3, 4, 5].includes(h.quality_rating)) {
    return { status: 400, error: 'harvest.quality_rating must be 1-5' };
  }

  // V4-HARVDUAL-001 Slice A — OPTIONAL measured weight alongside the count ("5 tomatoes, 337 g").
  // quantity+unit are unchanged and still required; this is purely additive.
  //
  // Three distinct client intents, and the edit path treats them differently, so the distinction
  // between "absent" and "explicitly null" is load-bearing:
  //   weight: <number>  -> the user weighed it. Stored, weight_estimated = false.
  //   weight: null      -> the user CLEARED their weight. Falls back to the reference estimate.
  //   weight absent     -> untouched. An edit to quality/quantity must NOT drop a recorded weight.
  if (h.weight_unit != null && !WEIGHT_UNITS.includes(h.weight_unit)) {
    return { status: 400, error: 'harvest.weight_unit must be g, kg, lb, or oz' };
  }
  if (h.weight != null) {
    if (typeof h.weight !== 'number' || !Number.isFinite(h.weight) || h.weight <= 0) {
      return { status: 400, error: 'harvest.weight must be a positive finite number' };
    }
    if (toGrams(h.weight, h.weight_unit) > MAX_PLAUSIBLE_WEIGHT_G) {
      return { status: 400, error: 'harvest.weight exceeds max' };
    }
  }
  return null;
}

// ── V4-EVENTSEL-005 — ONE batch-level note ──────────────────────────────────────────────────────
// Log Many had no Notes field and POST /api/events/batch had no `notes` column in its INSERT, so a
// client-only fix would have written a note the user typed into NOTHING, behind a green success
// screen, across the whole batch. Silent loss behind a confirmation is worse than the missing
// field, which is why the server half lands FIRST (Lambda-before-SPA).
//
// Dave's ruling: ONE note per batch, applied to every row, with the UI saying so. Per-row notes are
// out of scope — Log Many exists for one activity across many plantings ("side-dressed the whole
// bed"), and per-row text entry on a phone outdoors is the exact per-item tapping this surface was
// built to remove.
//
// WHAT THE SINGLE-EVENT PATH ACTUALLY DOES (checked, not assumed): validatePostBody does NOT
// validate `notes` at all — index.js binds `body.notes ?? null` raw, and event_log.notes is a plain
// nullable `text` with no length CHECK. The trim/empty-to-null contract lives ONLY on the client
// (EventNew.jsx: `form.notes.trim() || null`). So "match the single path" means matching that
// CONTRACT — trim, blank becomes NULL — not copying a server validator that does not exist. It is
// re-implemented here rather than trusted to the client because the batch body is a public
// endpoint and one bad value fans out to up to 500 rows instead of one.
//
// The length bound is NEW (the single path has none). It exists because this is the fan-out path:
// an unbounded note is stored 500 times, not once. 2000 is ~5x the longest note in prod (397 chars
// over 405 notes as of 2026-08-14), so it cannot reject anything a human has ever written here.
export const MAX_NOTES_LEN = 2000;
export const NOTES_TYPE_ERROR = 'notes must be a string';
export const NOTES_LENGTH_ERROR = `notes must be ${MAX_NOTES_LEN} characters or fewer`;

// Returns null on success, or { status, error }.
export function validateNotes(v) {
  if (v == null) return null;
  if (typeof v !== 'string') return { status: 400, error: NOTES_TYPE_ERROR };
  // Bound the TRIMMED length so trailing whitespace cannot 400 a note that is otherwise in range —
  // the trim is what gets stored, so the trim is what gets measured.
  if (v.trim().length > MAX_NOTES_LEN) return { status: 400, error: NOTES_LENGTH_ERROR };
  return null;
}

// Trimmed note, or null for absent/blank/whitespace-only.
//
// Empty-to-NULL is load-bearing, not tidiness. A '' written as an empty string rather than NULL is
// a known defect class in this schema: every read surface tests `notes` for truthiness or renders
// it directly, so a '' row is an "event with a note" that displays as a blank note. Prod currently
// holds ZERO such rows (verified 2026-08-14) and this path must not introduce the first 500.
export function normalizeNotes(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

// F9 UUID regex — applied before any SQL fires so Postgres never sees a malformed UUID.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Bulk "Quick Log" / Unit A (2026-05-24, expanded 2026-05-28) ───────────
// V3-EVENT-008: the batch allowlist is now DERIVED, not hand-listed. It is generated
// from the canonical src/lib/eventTypes.js (EVENT_TYPES − BATCH_EXCLUDED_TYPES) into the
// committed sibling eventTypes.generated.js by scripts/gen-lambda-event-types.mjs, and
// CI (`npm run check:event-types`) fails on any drift. The deployed Lambda is a standalone
// zip with no bundler, so it imports the generated SIBLING (not src/lib/) at runtime.
// Excluded by design (see BATCH_EXCLUDED_TYPES in eventTypes.js):
//   - harvest                 — requires quantity+unit (dual-write to harvest_log)
//   - first_harvest           — MILESTONE only: carries NO quantity, writes NO harvest_log row.
//                               validateEventBody above REJECTS harvest fields on it (400), and
//                               index.js gates the harvest_log CTE on eventType === 'harvest'.
//                               Excluded from batch for per-plant-entry reasons, NOT for quantity.
//                               See the long note in src/lib/eventTypes.js for why this matters to
//                               evidence-only surfaces that INNER JOIN harvest_log.
//   - photo                   — requires a file upload (no bulk semantics)
//   - divided / cutting_taken — HS-1: spawn child plantings (lineage/transaction risk)
//   - hand_pollinated / fruit_set — HS-1: single-plant events, no bulk semantics
import { BATCH_EVENT_TYPES } from './eventTypes.generated.js';
export { BATCH_EVENT_TYPES };

// Returns null on success, or { status, error } on validation failure.
export function validateBatchBody(body) {
  if (body.dry_run !== true && (!body.idempotency_key || typeof body.idempotency_key !== 'string')) {
    return { status: 400, error: 'idempotency_key is required' };
  }
  if (!body.event_type) return { status: 400, error: 'event_type is required' };
  if (!BATCH_EVENT_TYPES.includes(body.event_type)) {
    return { status: 400, error: `event_type must be one of: ${BATCH_EVENT_TYPES.join(', ')} (harvest/first_harvest/photo not supported in batch)` };
  }
  if (body.event_date != null) {
    const ed = new Date(body.event_date);
    if (!Number.isFinite(ed.getTime())) return { status: 400, error: 'event_date invalid' };
    const now = Date.now();
    if (ed.getTime() < now - PAST_BOUND_MS) return { status: 400, error: 'event_date too far in past' };
    if (ed.getTime() > now + FUTURE_BOUND_MS) return { status: 400, error: 'event_date in future' };
  }
  const s = body.scope;
  if (!s || typeof s !== 'object') return { status: 400, error: 'scope is required' };
  if (!['all', 'project', 'space'].includes(s.type)) {
    return { status: 400, error: 'scope.type must be all, project, or space' };
  }
  if (s.type === 'project' && !UUID_RE.test(s.project_id ?? '')) {
    return { status: 400, error: 'scope.project_id must be a UUID when scope.type=project' };
  }
  if (s.type === 'space' && !UUID_RE.test(s.location_id ?? '')) {
    return { status: 400, error: 'scope.location_id must be a UUID when scope.type=space' };
  }
  if (body.exclude_plant_ids != null) {
    if (!Array.isArray(body.exclude_plant_ids)) {
      return { status: 400, error: 'exclude_plant_ids must be an array' };
    }
    if (body.exclude_plant_ids.some((id) => !UUID_RE.test(id))) {
      return { status: 400, error: 'exclude_plant_ids must all be UUIDs' };
    }
  }

  // V4-EVENTSEL-005 — ONE batch-level note, applied to every row. See validateNotes above for why
  // this is validated server-side even though the single path is not.
  const notesErr = validateNotes(body.notes);
  if (notesErr) return notesErr;

  // V4-WATERMATH-001 F0 — the batch path now carries metadata (it previously carried NONE; see
  // buildBatchMetadataPlan). One batch-level object applied to every row, plus optional per-row
  // overrides keyed by plant_id. Both go through the SAME vocabulary check as the single POST.
  const batchMetaErr = validateEventMetadata(body.metadata);
  if (batchMetaErr) return batchMetaErr;
  if (body.plant_metadata != null) {
    if (!isPlainMetadataObject(body.plant_metadata)) {
      return { status: 400, error: 'plant_metadata must be an object keyed by plant_id' };
    }
    for (const [plantId, meta] of Object.entries(body.plant_metadata)) {
      if (!UUID_RE.test(plantId)) {
        return { status: 400, error: 'plant_metadata keys must be plant UUIDs' };
      }
      if (!isPlainMetadataObject(meta)) {
        return { status: 400, error: 'plant_metadata values must be objects' };
      }
      const perErr = validateEventMetadata(meta);
      if (perErr) return perErr;
    }
  }
  return null;
}

// ── V4-WATERMATH-001 F0 — batch metadata merge ──────────────────────────────────────────────────
// THE bug this closes: the batch INSERT hardcoded its metadata as
//   jsonb_build_object('batch_id', <id>, 'batch_v', 1)
// and accepted no client metadata at all. Batch is the HIGH-VOLUME path (~80% of events
// historically), so amount chips wired only to the single POST would have captured ~0% of real
// watering. This function produces the two jsonb parameters the INSERT binds.
//
// Merge precedence, lowest to highest:
//   1. batch-level metadata      (the one chip the user set for the whole burst)
//   2. per-plant override        (the row whose chip they tapped individually)
//   3. server-owned batch keys   (batch_id / batch_v)
// (3) is LAST on purpose and is the security-relevant half: `metadata->>'batch_id'` is what the
// undo cascade, the side-effect re-hit lookup and the batch feed all key on. If a client could
// set batch_id it could attach its rows to — or detach them from — someone else's batch. Merging
// the server keys last makes that unforgeable rather than merely unlikely.
//
// Reserved-namespace strip: keys beginning with `_` are the app's internal channel (e.g.
// `_skip_critter_award`, honoured by the single POST) and are dropped from client-supplied batch
// metadata. The single path's behaviour is deliberately unchanged — this is a NEW surface, and
// opening a bulk bypass lever at the same moment is not a trade worth making.
export function stripReservedMetadataKeys(meta) {
  if (!isPlainMetadataObject(meta)) return {};
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    if (k.startsWith('_')) continue;
    out[k] = v;
  }
  return out;
}

// Returns { defaultMetadata, overrides } — both plain objects, ready to JSON.stringify.
//   defaultMetadata : applied to every row that has no per-plant entry
//   overrides       : { <lowercased plant_id>: <fully merged metadata> } — ONLY for plantings that
//                     are both in `plantIds` and carry an override. Rows for plantings outside the
//                     server-resolved scope are dropped: the scope SELECT is the authority on which
//                     plantings get written, and a metadata map must never widen it.
export function buildBatchMetadataPlan({ batchId, metadata, plantMetadata, plantIds }) {
  const serverKeys = { batch_id: String(batchId), batch_v: 1 };
  const base = stripReservedMetadataKeys(metadata);
  const defaultMetadata = { ...base, ...serverKeys };

  const overrides = {};
  if (isPlainMetadataObject(plantMetadata)) {
    const inScope = new Set((plantIds ?? []).map((id) => String(id).toLowerCase()));
    for (const [rawId, meta] of Object.entries(plantMetadata)) {
      const id = String(rawId).toLowerCase();
      if (!inScope.has(id)) continue;
      overrides[id] = { ...base, ...stripReservedMetadataKeys(meta), ...serverKeys };
    }
  }
  return { defaultMetadata, overrides };
}


// ── Event-date normalization (2.1.x event-date off-by-one fix) ──────────────
// Date-only values ("YYYY-MM-DD") from the create forms must be NOON-anchored.
// Otherwise `new Date("2026-05-24")` is parsed as MIDNIGHT UTC, which renders a
// day early in behind-UTC timezones (EDT) — the bug Dave hit logging a fert.
// Noon UTC stays the same calendar date across all real-world offsets. Full
// datetimes (the edit path already sends one) pass through unchanged.
// Returns an ISO string, or null for empty/invalid (caller falls back to now()).
export function normalizeEventDate(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T12:00:00Z' : s;
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

