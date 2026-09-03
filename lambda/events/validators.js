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

// ── V4-HARVDISPOSITION-001 — the outcome of a pick ──────────────────────────────────────────────
//
// THE FIFTH HAND-MAINTAINED COPY OF THIS VOCABULARY, and the first one in code. The canonical list
// is the ARRAY in migrations/v4-losscapture-001/0b-arm-checks.sql's chk_harvest_log_disposition;
// this literal, the two gates in that bundle's gates.yml, and the rollback are all pinned against it
// by lambda/plants/loss-cause-vocab.test.js. Never hand-edit one without the others — three
// unpinned copies of one vocabulary is BUG-DIVERGENCEVOCAB-001, which this bundle has already been
// bitten by once.
//
// PLANT GRAIN vs PICK GRAIN — these are NOT the same vocabulary and must never be merged.
// LOSS_REASONS (src/lib/eventTypes.js, V4-LOSSEVENT-001) describes plants that produced no pick at
// all and decrements plants.quantity/qty_lost. A disposition describes ONE PICK THAT WAS STILL
// LOGGED AS A HARVEST and touches no plant counter whatsoever. 'culled' appears in both lists
// because culling a plant and culling a fruit are both real; they are separate facts on separate
// tables and the overlap is harmless precisely because neither writer ever reads the other's column.
export const ALLOWED_DISPOSITION = ['dropped', 'culled', 'aborted', 'damaged'];
export const DISPOSITION_ERROR =
  `harvest.disposition must be one of: ${ALLOWED_DISPOSITION.join(', ')}`;

// A pick whose disposition is set is the app's own declaration that this pick was NOT typical, so
// its weight must not teach the cultivar calibration what a typical fruit weighs. Measured on prod:
// three of the four disposition-bearing harvests in the entire history already became
// cultivar_weight_sample rows, and two of them are the SOLE sample for their cultivar — Pumpkin
// Jalapeno derives 0.50 g/fruit from "Very early aborts", Habanero 2.0 g/fruit from "Unripe abort".
// Both are still `provisional`, so resolve_harvest_weight's corroboration predicate (confidence in
// high/medium OR independent_n >= 5) is not yet using them — but aborts are correlated and
// repeatable, so five more of them PROMOTE the wrong number rather than diluting it.
// Uniform across all four values, deliberately: 'aborted' is systematically light, 'damaged' and
// 'dropped' are picked-by-accident rather than picked-when-ready, and 'culled' is off-spec by
// definition. A per-value exception list would be a sixth vocabulary to keep in sync.
export function seedsWeightCalibration(disposition) {
  return disposition == null;
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

// BUG-EVENTPROJPLANTPAIR-001 — the anchor pair is DERIVED, never taken on the client's word.
//
// event_log carries BOTH project_id and plant_id, and every writer used to bind them from two
// independent request fields. Nothing reconciled them, so a body naming plant P (which lives in
// project X) alongside project_id Y wrote the pair (Y, P) — a row that disagrees with its own
// planting. 43 such rows exist on prod (39 live), the newest minted 2026-08-14, so this is an open
// wound rather than history.
//
// THE RULE: when an event has a planting, that planting owns the project. The request's project_id
// is then advisory at best and wrong at worst — it is the field the client gets stale. Only a
// planting-less event may take project_id from the body, because then there is nothing to disagree
// with. This is the same derivation the batch path has always done in SQL (`SELECT p.container_id
// ... FROM garden_node p`, index.js POST /api/events/batch), lifted into one testable function so
// the single-POST and PUT arms cannot drift from it or from each other.
//
// DERIVING TO NULL IS DELIBERATE AND IS NOW SAFE. A project-less planting is a supported state
// (V3-CAPTURE-001; validatePostBody below admits plant_id with no project_id), so a plant with no
// project yields an event with no project. `event_log_has_anchor` is still satisfied by plant_id.
// clearFields.js's "THE INNER-JOIN TRAP" note argues the opposite — that a NULL project_id makes a
// row permanently un-editable and un-deletable — but that note is STALE: the PUT's ownership
// SELECT, the PUT's UPDATE and the DELETE route have all since been rewritten to the two-arm
// `(project_id IS NOT NULL AND pp...) OR (project_id IS NULL AND pn...)` predicate, so such rows
// are fully reachable. Verified against origin/dev before relying on it. That note governs the
// `body.clear` channel, which is a different question and is untouched here.
//
// Callers pass the planting's CURRENT project, read in a query they were already running — see the
// two call sites in index.js. Both are read in the same request as the write, and no application
// path re-homes a planting (lambda/plants/index.js claim 3: container_id is absent from the PUT
// SET-list and `plants_project_id_fkey` is ON DELETE RESTRICT), so there is no TOCTOU window worth
// closing with a subquery.
export function deriveEventProjectId({ plantId, plantProjectId, requestedProjectId }) {
  if (plantId == null) return requestedProjectId ?? null;
  return plantProjectId ?? null;
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
  // THE INVARIANT, RE-ANCHORED (BUG-LOCEVENT400-001). This used to cite
  // entity_memory_exactly_one_parent, which is the WRONG CONSTRAINT and argues the opposite case: it
  // is on `entity_memory`, not event_log, and it is a THREE-way XOR
  // (plant XOR project XOR location) with 6 live location-only rows behind it. Cited as written it
  // reads as licence for a location-only EVENT.
  //
  // The constraint that actually governs this table, verified on live prod 2026-08-18, is
  //   event_log_has_anchor  CHECK (plant_id IS NOT NULL OR project_id IS NOT NULL)  NOT VALID
  // Two-way. No location arm. NOT VALID suppresses back-validation of existing rows, NOT enforcement
  // on INSERT — so a parentless event is refused by Postgres as 23514 whatever this function does.
  // Relaxing the check below without first migrating that CHECK does not enable the write; it only
  // trades a truthful 400 for an opaque 500. 0 of 15,019 prod rows have both ids NULL.
  //
  // The reachability half is independently true: every GET branch in index.js filters on project_id
  // or plant_id, there is no ?location_id branch, and GET /api/events/:id's ownership predicate
  // resolves false when both are NULL — so such a row would 404 to its own author.
  //
  // CaptureFlow's location destination used to send exactly this parentless body and 400'd on every
  // save; it now writes the photo onto the location instead (photos_must_have_parent DOES admit
  // location_id alone). src/__tests__/CaptureFlow.eventContract.test.jsx runs this very function over
  // the bodies that component actually sends, so the two halves red together rather than drift.
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

  // V4-LOSSEVENT-001 — the plant-reduction contract. Last, so a body that is wrong in a more basic
  // way still gets the more basic message.
  const redErr = validateReduction(body);
  if (redErr) return redErr;

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
  PLANT_REDUCTION_EVENT_TYPES, LOSS_REASONS, GIVEAWAY_REASONS,
  REDUCTION_QTY_KEY, LOSS_REASON_KEY, GIVEAWAY_REASON_KEY,
  REDUCTION_REASON_KEY_BY_TYPE, REDUCTION_REASONS_BY_KEY,
  isPlantReductionEventType, accruesQtyLost,
} from './eventTypes.generated.js';
export { NON_REWARD_EVENT_TYPES, isRewardedEventType, WATER_DEPTH_CLASSES, WATER_DEPTH_SOURCES };
export {
  PLANT_REDUCTION_EVENT_TYPES, LOSS_REASONS, GIVEAWAY_REASONS,
  REDUCTION_QTY_KEY, LOSS_REASON_KEY, GIVEAWAY_REASON_KEY,
  isPlantReductionEventType, accruesQtyLost,
};

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

// ── V4-LOSSEVENT-001 — plant-reduction ledger, wire contract ────────────────────────────────────
// `failed` / `given_away` carry THREE metadata keys and this is the only place they are policed:
//   qty_reduced     integer >= 1  — how many plants this reduction removed. REQUIRED on both types.
//   loss_reason     LOSS_REASONS      — REQUIRED on `failed`, and legal NOWHERE else.
//   giveaway_reason GIVEAWAY_REASONS  — REQUIRED on `given_away`, and legal NOWHERE else.
//
// EVERY EVENT CARRIES A QUANTITY, and that is the requirement rather than a nicety: without it,
// losing one pepper is indistinguishable from losing nineteen, and `SUM` over the ledger — the only
// way to answer "how many did I lose to pests this season" — degrades to `count(*)`, which in this
// schema measures batches rather than plants.
//
// THE KEYS ARE FORBIDDEN ON EVERY OTHER TYPE, and this is where it diverges from the water_depth
// precedent above, which deliberately does NOT forbid its keys elsewhere. water_depth is an
// ANNOTATION on an event that happened; these three are LEDGER ENTRIES that an aggregate sums. A
// `loss_reason` riding on a watering row is a loss nobody recorded, and it would decrement nothing
// while still being counted — a fabricated number with a real-looking provenance.
//
// Deliberately NOT stored in event_log.quantity_numeric: BUG-QTYSPLITBRAIN-001 pins that column to
// harvest_log.quantity, and V4-WATERMATH-001 F0 already ruled on this exact question for
// water_depth ("structurally harvest-only ... would collide with real gallons later").
// event_log.quantity is `text`, so it types nothing. jsonb with an edge validator is the shipped
// house pattern for a small closed vocabulary, and it needs no DDL and therefore no deploy ordering.
export const MAX_REDUCTION_QTY = 10000; // mirrors MAX_PLAUSIBLE.count — a shape bound, not a policy
export const REDUCTION_KEYS = [REDUCTION_QTY_KEY, LOSS_REASON_KEY, GIVEAWAY_REASON_KEY];

export const REDUCTION_PLANT_ERROR =
  `plant_id is required for ${PLANT_REDUCTION_EVENT_TYPES.join(' / ')} (a reduction is arithmetic on one planting's count)`;
export const REDUCTION_QTY_ERROR =
  `metadata.${REDUCTION_QTY_KEY} must be an integer of at least 1`;
export const REDUCTION_QTY_MAX_ERROR =
  `metadata.${REDUCTION_QTY_KEY} exceeds ${MAX_REDUCTION_QTY}`;

export function reductionReasonError(key) {
  return `metadata.${key} must be one of: ${REDUCTION_REASONS_BY_KEY[key].join(', ')}`;
}
export function reductionKeyForbiddenError(key, eventType) {
  return `metadata.${key} is not valid on event_type=${eventType}`;
}

// Returns null on success, or { status, error }. Safe to call for EVERY event type — the non-
// reduction arm is the forbid check, so this cannot be forgotten for the types it does not name.
export function validateReduction(body = {}) {
  const eventType = body.event_type;
  const meta = isPlainMetadataObject(body.metadata) ? body.metadata : {};

  if (!isPlantReductionEventType(eventType)) {
    for (const k of REDUCTION_KEYS) {
      if (meta[k] != null) {
        return { status: 400, error: reductionKeyForbiddenError(k, String(eventType)) };
      }
    }
    return null;
  }

  // A planting-less reduction would insert an event row and silently decrement nothing, behind a
  // 201. The client-side requiresPlanting() partition says the same thing, but it is feature-
  // flagged and a stale service-worker bundle can outlive a flag flip (spec D7), so the server
  // asserts it independently for these two types only.
  if (!body.plant_id) return { status: 400, error: REDUCTION_PLANT_ERROR };

  const qty = meta[REDUCTION_QTY_KEY];
  // STRICT, no coercion, same call as validateQtyLost in lambda/plants/validate.js: `"3"` and
  // `3.5` are client bugs, and a coerced number writes a count nobody chose onto a real planting.
  if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < 1) {
    return { status: 400, error: REDUCTION_QTY_ERROR };
  }
  if (qty > MAX_REDUCTION_QTY) return { status: 400, error: REDUCTION_QTY_MAX_ERROR };

  const wantKey = REDUCTION_REASON_KEY_BY_TYPE[eventType];
  const otherKey = wantKey === LOSS_REASON_KEY ? GIVEAWAY_REASON_KEY : LOSS_REASON_KEY;
  if (meta[otherKey] != null) {
    return { status: 400, error: reductionKeyForbiddenError(otherKey, eventType) };
  }
  if (!REDUCTION_REASONS_BY_KEY[wantKey].includes(meta[wantKey])) {
    return { status: 400, error: reductionReasonError(wantKey) };
  }
  return null;
}

// ── V4-LOSSEVENT-001 — the END-STATUS OFFER (Dave's ruling, 2026-08-18) ─────────────────────────
// "OFFER it. Never automatic."
//
// AND THE REASONING IS THE DESIGN, not a preamble to it: reaching zero does NOT tell you which
// ending it was. A planting reaches zero because it was harvested out — a good, successful season.
// Or because it failed. Or because it was given away. Or through a MIX (harvested 5, pest took 3,
// gave away 2). Assuming `failed` merely because a reduction triggered the prompt would mislabel a
// successful season as a failure, which is precisely the error this whole ledger exists to avoid.
//
// So the server RANKS and the user CHOOSES. Ranking uses the composition of how the planting got to
// zero, which is available without inference: qty_harvested is an existing column, qty_lost is this
// ledger's own accrual, and the give-away total is a SUM over the ledger.
//
// TIES GO TO THE GENTLER READING. `failed` is never offered first unless losses strictly dominate —
// a wrong "failed" is the costly error; a wrong "harvested" is a shrug and one tap.
export const END_STATUS_OFFER = ['harvested', 'ended', 'failed'];

// Returns the three candidate statuses, most-plausible first. Pure, so the ordering is testable
// without a database; index.js supplies the three totals from one read.
export function orderEndStatusOffer({ harvested = 0, lost = 0, given_away: givenAway = 0 } = {}) {
  const h = Number(harvested) || 0;
  const l = Number(lost) || 0;
  const g = Number(givenAway) || 0;
  // Strict `>` throughout: equality falls through to the next arm, so a tie never promotes `failed`.
  if (l > h && l > g) return ['failed', 'ended', 'harvested'];
  if (g > h && g >= l) return ['ended', 'harvested', 'failed'];
  return END_STATUS_OFFER;
}

// The two numbers index.js binds. Returns null for a non-reduction event so the caller has one
// branch rather than two, and the SQL below it stays no-op-by-predicate for every other type.
export function readReductionPlan(body = {}) {
  if (!isPlantReductionEventType(body.event_type)) return null;
  const meta = isPlainMetadataObject(body.metadata) ? body.metadata : {};
  const qty = meta[REDUCTION_QTY_KEY];
  return {
    qty,
    // A give-away is a reduction, not a loss — the plant is alive somewhere else. Give-away totals
    // are read off the ledger rather than getting a column of their own.
    lostAccrual: accruesQtyLost(body.event_type) ? qty : 0,
    reason: meta[REDUCTION_REASON_KEY_BY_TYPE[body.event_type]],
  };
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

  // V4-HARVDISPOSITION-001. Same three-intent shape as `weight` below, and for the same reason:
  //   disposition: <value>  -> this pick went wrong in that way.
  //   disposition: null     -> the user CLEARED it; it was a normal pick after all.
  //   disposition absent    -> untouched. EventDetail sends the whole harvest object on every save
  //                            and does not know this key yet, so "absent means clear" would wipe a
  //                            recorded disposition on an unrelated quality-star tap — the exact
  //                            silent-nulling shape BUG-TREATMENTPRODUCT-001 cost a season of
  //                            fertilizing product text.
  // Checked BEFORE it can reach chk_harvest_log_disposition, which 0c VALIDATEs: an out-of-vocab
  // value that got as far as the database would surface as an opaque 500, not a readable 400.
  if (h.disposition != null && !ALLOWED_DISPOSITION.includes(h.disposition)) {
    return { status: 400, error: DISPOSITION_ERROR };
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

// ── V4-LOGMANYUXREFRESH-001 S4 — scope.type:'ids' ("pick, don't un-pick") ───────────────────────
// The three shipped scopes are all SERVER-RESOLVED sets the client then subtracts from with
// exclude_plant_ids. That is the right model for "water the whole Bag Area" and the wrong one for
// "these three": a 3-planting pick out of 239 travels as 236 exclusions, so the body's size is set
// by the garden rather than by the intent, and — the part that matters — the client's intent is
// only recoverable by SUBTRACTING two sets it does not control. If the server's resolution moves
// between the preview and the commit (a planting archived, ended, or reassigned by the other
// household member in the interim), the complement quietly re-includes or drops plantings and
// nothing anywhere can tell. An explicit id list makes the intent the payload, which is what makes
// the count assertion in index.js possible at all: you cannot assert "we logged what you picked"
// against a body that never said what was picked.
//
// Cap = the batch cap. Anything above it is rejected here rather than silently truncated by the
// resolver's LIMIT 501 — a truncation on this path would under-write a set the user named
// explicitly, which is the exact failure BD-073 was filed about.
export const MAX_SCOPE_IDS = 500;

// Deduped, lower-cased plant ids for scope.type='ids'; [] for every other scope.
//
// BOTH normalizations are load-bearing for the count assertion, not tidiness. Postgres compares
// uuid VALUES, so '5C6…' and '5c6…' are one planting to the resolver and two to a naive
// `requested.length === resolved.length` — the assertion would 409 a correct batch. Duplicates do
// the same thing. Normalizing here, once, means the number the assertion compares against is the
// number of DISTINCT plantings the client actually named.
export function normalizeScopeIds(scope) {
  if (!scope || scope.type !== 'ids' || !Array.isArray(scope.plant_ids)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of scope.plant_ids) {
    if (typeof raw !== 'string') continue;
    const id = raw.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

// ── Bulk "Quick Log" / Unit A (2026-05-24, expanded 2026-05-28) ───────────
// V3-EVENT-008: the batch allowlist is now DERIVED, not hand-listed. It is generated
// from the canonical src/lib/eventTypes.js (EVENT_TYPES − BATCH_EXCLUDED_TYPES) into the
// committed sibling eventTypes.generated.js by scripts/gen-lambda-event-types.mjs, and
// CI (`npm run check:event-types`) fails on any drift. The deployed Lambda is a standalone
// zip with no bundler, so it imports the generated SIBLING (not src/lib/) at runtime.
// WHAT IS EXCLUDED, AND WHY, LIVES IN ONE PLACE: the BATCH_EXCLUDED_TYPES block in
// src/lib/eventTypes.js, which carries a per-entry rationale keyed to the ticket that added it.
// This comment deliberately does NOT restate the list. The copy that used to sit here drifted:
// it still named `fruit_set` as excluded after V4-EVENTSEL-002 un-excluded it (2026-07-07), and it
// never gained `moisture_check`, `failed`, `given_away` or `seed_saved`. A hand-maintained mirror
// of a derived list is exactly the drift `npm run check:event-types` exists to prevent, so the
// mirror is gone rather than refreshed. The shared shape across every entry is that the event
// either needs per-plant data the batch body cannot carry, or writes a child record that only the
// single path writes — so a bulk row would assert something no evidence surface can corroborate.
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
  if (!['all', 'project', 'space', 'ids'].includes(s.type)) {
    return { status: 400, error: 'scope.type must be all, project, space, or ids' };
  }
  if (s.type === 'project' && !UUID_RE.test(s.project_id ?? '')) {
    return { status: 400, error: 'scope.project_id must be a UUID when scope.type=project' };
  }
  if (s.type === 'space' && !UUID_RE.test(s.location_id ?? '')) {
    return { status: 400, error: 'scope.location_id must be a UUID when scope.type=space' };
  }
  // V4-LOGMANYUXREFRESH-001 S4. EMPTY IS REJECTED, not treated as "nothing to do": an empty list
  // reaching the resolver would resolve to zero rows and fall out as the generic "No plantings
  // matched the scope", which reads as "your garden is empty" for what is really a malformed body.
  if (s.type === 'ids') {
    if (!Array.isArray(s.plant_ids) || s.plant_ids.length === 0) {
      return { status: 400, error: 'scope.plant_ids must be a non-empty array when scope.type=ids' };
    }
    if (s.plant_ids.some((id) => typeof id !== 'string' || !UUID_RE.test(id))) {
      return { status: 400, error: 'scope.plant_ids must all be UUIDs' };
    }
    if (normalizeScopeIds(s).length > MAX_SCOPE_IDS) {
      return { status: 400, error: `scope.plant_ids may name at most ${MAX_SCOPE_IDS} plantings` };
    }
  }
  if (body.exclude_plant_ids != null) {
    if (!Array.isArray(body.exclude_plant_ids)) {
      return { status: 400, error: 'exclude_plant_ids must be an array' };
    }
    if (body.exclude_plant_ids.some((id) => !UUID_RE.test(id))) {
      return { status: 400, error: 'exclude_plant_ids must all be UUIDs' };
    }
    // The two are OPPOSITE models and a body carrying both states its intent twice. It is rejected
    // rather than reconciled because reconciling it breaks the count assertion in the confusing
    // direction: an id that is both named and excluded resolves to nothing, the assertion fires,
    // and the user is told plantings "are no longer available" when the client asked for exactly
    // that. Empty arrays pass — a client that always sends the key is not making a claim.
    if (s.type === 'ids' && body.exclude_plant_ids.length > 0) {
      return { status: 400, error: 'exclude_plant_ids cannot be combined with scope.type=ids' };
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
  // V4-LOSSEVENT-001. BATCH_EVENT_TYPES already excludes `failed`/`given_away`, so this arm can
  // only ever be the FORBID half — and that is exactly why it is here. The batch path fans one
  // body out to up to 500 rows, so a reduction key riding on a legal type (a `watering` batch
  // carrying loss_reason) would mint 500 losses that decremented nothing. Relying on the type
  // allowlist alone would leave the keys unpoliced on every type it admits.
  const batchRedErr = validateReduction({ event_type: body.event_type, metadata: body.metadata });
  if (batchRedErr) return batchRedErr;
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
      const perRedErr = validateReduction({ event_type: body.event_type, metadata: meta });
      if (perRedErr) return perRedErr;
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

