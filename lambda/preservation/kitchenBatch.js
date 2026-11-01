// Vocabulary, validation and route parsing for /api/kitchen-batches.
//
// Dependency-free on purpose, like ./provenance.js, ./attribution.js and ./useBy.js: index.js imports
// neon, clerk and aws at module scope, so anything defined THERE is asserted only by its spelling.
// Everything here is importable by the blocking `npm test` lane and asserted by executing it. Do not add imports.
//
// Every vocabulary duplicates a DB CHECK from migrations/v5-inflightbatch-001/0a-additive-ddl.sql on
// purpose (like VALID_METHODS): a raw 23514 reads `Constraint violation: chk_...`, which a cook cannot
// act on. The DB is the belt; these messages are the product.

// chk_kitchen_batch_kind. NULLABLE on purpose: "something in the kitchen, started now, here is a photo"
// must be a COMPLETE, VALID record. The method is pinned at close-out against a DIFFERENT vocabulary
// (VALID_METHODS); never auto-map one to the other (one mash can output hot_sauce and ferment_mash jars).
export const KITCHEN_BATCH_KINDS = ['ferment', 'dehydrate', 'candy', 'cure', 'infuse', 'age', 'other'];

// chk_kitchen_batch_start_precision. 'hour' exists because a dehydrator run has no rung for "sometime
// this afternoon"; grading it as `day` renders a 100%+ error as a confident figure.
export const KITCHEN_START_PRECISIONS = ['exact', 'hour', 'day', 'week', 'month', 'season', 'year', 'unknown'];

// The estimated-date vocabulary includes the dated estimate words the chips store ("2–3 months ago" ->
// season, "Earlier this year" / "Last year" -> year). chk_kitchen_batch_start_precision and
// chk_ksl_entered_precision carry the same eight.
export const KITCHEN_ENTERED_PRECISIONS = KITCHEN_START_PRECISIONS;

export const KITCHEN_START_ANCHOR_KINDS = ['harvest', 'photo', 'purchase', 'memory', 'manual'];

// The two anchor kinds that name a row this app can resolve, so the only two an id is accepted for.
// NARROWER THAN THE DDL ON PURPOSE: start_anchor_id has no database FK (a polymorphic uuid for photos.id
// or harvest_log.id), so nothing else enforces existence or ownership. 'purchase', 'manual' and 'memory'
// name no table, so an id under them could never be dereferenced or ownership-checked. Widen this only
// when a kind gains a real table, and gate it in kitchenRoutes.js in the same commit.
export const VERIFIABLE_ANCHOR_KINDS = ['harvest', 'photo'];

// chk_kitchen_batch_outcome. put_up_different: candying's commonest non-ideal result is a downgrade that
// still makes a storable product. discarded_spoiled: in a two-user household "was the jar eaten or
// thrown out" is the actual hazard.
export const KITCHEN_OUTCOMES = [
  'put_up', 'put_up_different', 'consumed', 'given_away', 'discarded_spoiled', 'abandoned',
];

// chk_ksl_stage_kind. ORDER IS NOT MONOTONIC: a `tended` row can arrive after a `finished` one (candy
// recoveries re-enter the sequence). Nothing may sort on it.
export const KITCHEN_STAGE_KINDS = ['started', 'tended', 'moved', 'finished', 'failed'];

// chk_ksl_stage_kind as 1b widened it: every kind a stage row can carry. KITCHEN_STAGE_KINDS above stays
// the five shipped kinds on purpose: the view's legacy current_stage_* LATERAL reads it and the shipped
// client's label maps are bound to it (src/__tests__/PutUpBatchDetail.test.jsx).
export const KITCHEN_STAGE_KINDS_ALL = [
  'started', 'tended', 'moved', 'finished', 'failed',
  'reopened', 'paused', 'resumed', 'noted', 'put_up', 'void',
];

// What POST /:id/stages accepts. put_up is written only by Put it up; a void of a put_up or finished row
// only by Undo that put-up (V4 Appendix A).
export const KITCHEN_STAGE_ROUTE_KINDS = [
  'started', 'tended', 'moved', 'finished', 'failed', 'reopened', 'paused', 'resumed', 'noted', 'void',
];
// The kinds a stages-route void may point at (V4 Appendix A).
export const KITCHEN_VOIDABLE_KINDS = ['tended', 'moved', 'noted'];
// The lifecycle kinds Undo that put-up reads when deciding whether to reopen; noted, tended, moved and
// void rows do not count.
export const KITCHEN_LIFECYCLE_KINDS = ['put_up', 'finished', 'failed', 'reopened', 'paused', 'resumed'];
// The kinds that are a batch STATE change as well as a row: the stages route writes the row and moves
// the batch column in ONE statement, so the column stays authoritative and the log cannot disagree.
export const KITCHEN_STATE_STAGE_KINDS = ['paused', 'resumed', 'reopened'];

export const KITCHEN_INPUT_KINDS = ['harvest', 'purchased', 'pantry', 'other'];

// chk_kbi_qty_unit as v5-inflightbatch-001 shipped it (14 values); also applied to
// kitchen_stage_log.amount_unit. KITCHEN_UNITS below (25) is a superset; this list stays the 14 until
// release F widens the line writers.
export const KITCHEN_QTY_UNITS = [
  'g', 'kg', 'oz', 'lb', 'count', 'cup', 'tbsp', 'tsp', 'fl oz', 'qt', 'gal', 'ml', 'l', 'other',
];

// KITCHEN_UNITS: the one list (V4 "Units"), = chk_kbi_qty_unit / chk_ksl_amount_unit as widened, and
// chk_kitchen_batch_vessel_unit. Every F writer takes these 25. KITCHEN_QTY_UNITS above stays the 14 the
// shipped forms were built on (the client mirror src/components/putup/batchInputs.js is bound to it).
export const KITCHEN_UNITS = [
  'g', 'kg', 'oz', 'lb', 'ml', 'l', 'tsp', 'tbsp', 'fl oz', 'cup', 'pint', 'qt', 'gal',
  'count', 'clove', 'head', 'bunch', 'pinch', 'peck', 'bushel', 'half-bushel', 'flat', 'jar', 'bag', 'other',
];
// Grams per unit: the one mass table (06 §1.4). A unit not here is not a mass.
export const MASS_G = Object.freeze({ g: 1, kg: 1000, oz: 28.3495, lb: 453.592 });
// Grams per unit for a role='water' line ONLY (1 g/ml). Every other volume is "no weight".
export const WATER_G = Object.freeze({
  ml: 1, l: 1000, tsp: 4.92892, tbsp: 14.7868, 'fl oz': 29.5735, cup: 236.588, pint: 473.176,
  qt: 946.353, gal: 3785.41,
});
export const isMassUnit = (u) => Object.prototype.hasOwnProperty.call(MASS_G, u);
// qty in grams, or null ("no weight"). Water volumes convert only when the line IS water.
export function gramsOf(qty, unit, { water = false } = {}) {
  if (qty == null || unit == null) return null;
  const n = Number(qty);
  if (!Number.isFinite(n)) return null;
  if (isMassUnit(unit)) return n * MASS_G[unit];
  if (water && Object.prototype.hasOwnProperty.call(WATER_G, unit)) return n * WATER_G[unit];
  return null;
}

// chk_kbi_form, chk_kbi_salt_method, chk_kbi_base_from, chk_ksl_acts, chk_kbi_role.
export const KITCHEN_FORMS = ['fresh', 'frozen', 'dried', 'cooked'];
export const KITCHEN_SALT_METHODS = ['dry', 'brine', 'rinsed'];
export const KITCHEN_BASE_FROM = ['lines', 'scale'];
export const KITCHEN_ACTS = ['topped_up', 'pushed_under', 'skimmed'];
export const KITCHEN_ROLES = ['salt', 'water'];
// chk_kbi_salt_base admits 'peppers' for a 1b-era row; no F writer writes it (06 §3.1).
export const KITCHEN_SALT_BASES = ['produce', 'water', 'all'];
// The kinds a line POST writes (contract-F §2.2); 'pantry' names a bought item by pantry_item_id
// (chk_kbi_pantry_item_kind).
export const KITCHEN_LINE_KINDS = ['garden', 'harvest', 'put_up', 'purchased', 'other', 'pantry'];
export const KITCHEN_SHU_BASES = ['computed', 'typed'];
// chk_kitchen_batch_vessel_count.
export const KITCHEN_VESSEL_COUNT_MAX = 50;

// chk_ksl_ph_scale, mirrored: the pH scale's definitional range and nothing else.
//
// NOT A SAFETY BAND, and the distinction is the whole ruling. This range is symmetric, prefers no reading
// to any other, and excludes nothing a meter or strip can produce; its only job is to catch a fat-finger.
// The app RECORDS a measured pH, PROMPTS someone to measure, and LINKS to how; it never derives, scores,
// colours, gates on, or compares a reading to anything. There is no threshold constant in this file and
// there must never be one (FOODSAFETY-RULING-V101.md §2). Restated in the DB CHECK, here and the client.
export const KITCHEN_PH_SCALE_MIN = 0;
export const KITCHEN_PH_SCALE_MAX = 14;

// The PUT allowlist: an EXPLICIT set, not a full replace. Closing has its own route, so closed_at/outcome
// are absent; first_recorded_at is the honest floor a client must never move; user_id is ownership.
export const KITCHEN_BATCH_EDITABLE_COLUMNS = [
  'label', 'kind', 'kind_other', 'started_at', 'start_precision', 'start_anchor_kind', 'start_anchor_id',
  'expected_days_min', 'expected_days_max', 'brine_note', 'cover_photo_id', 'notes', 'suspended_at',
  // Release F: the jar & heat facts and "Following a recipe?". shu_est_basis is NOT here: the merge PUT
  // writes 'typed' whenever it writes a heat estimate, and only POST /:id/shu-estimate/save writes 'computed'.
  'vessel_label', 'vessel_size', 'vessel_unit', 'vessel_count', 'no_salt', 'shu_est_low', 'shu_est_high',
  'recipe_ref',
];

// The complement, stated rather than implied, so a test can assert the boundary from both sides. A column
// here reaching the PUT is a defect however it got there.
export const KITCHEN_BATCH_SERVER_OWNED_COLUMNS = [
  'id', 'user_id', 'first_recorded_at', 'closed_at', 'outcome', 'outcome_note',
  'created_at', 'updated_at', 'deleted_at',
];

// THE REVERSIBILITY CONTRACT, named so a test can bind it: close writes exactly this set; reopen NULLs
// exactly this set. A mock driver cannot prove a round-trip, only what each handler SENDS, so the
// assertable form is set equality in BOTH directions against this constant.
//
// suspended_at is deliberately NOT in this set though close writes it: that is the pause being cleared
// (chk_kitchen_batch_suspend_exclusive forbids a suspended closed batch), not part of the close's record,
// and a reopen that NULLed it would be a no-op. Reopen therefore RESUMES a paused batch.
export const KITCHEN_BATCH_CLOSE_COLUMNS = ['closed_at', 'outcome', 'outcome_note'];

// The predicate bulk-add's window ceiling, inclusive of both endpoints. NOT a performance bound but a
// REPAIRABILITY bound: the undo for a mis-tapped predicate is DELETE /:id/inputs/:inputId one row at a
// time, and the predicate form discards its RETURNING ids.
//
// 366 and not less: the client's window comes from HarvestTimeframeChips, whose season chip spans a full
// Nov-Oct grow year (365 days inclusive, 366 across a leap day).
export const KITCHEN_PREDICATE_MAX_SPAN_DAYS = 366;

// Columns normalized to "meaningful string or null" before reaching the column (btrim() CHECKs exist on
// label / kind_other).
const KITCHEN_TEXT_COLUMNS = new Set([
  'label', 'kind', 'kind_other', 'start_precision', 'start_anchor_kind', 'brine_note', 'notes',
  'vessel_label', 'vessel_unit', 'recipe_ref',
]);

const KITCHEN_INTEGER_COLUMNS = new Set([
  'expected_days_min', 'expected_days_max', 'vessel_count', 'shu_est_low', 'shu_est_high',
]);

// ORDER KEYS, stated once. `id DESC` on the stage log is NOT decoration: two rows written in one
// statement tie on entered_at AND created_at (a "topped up + skimmed" double-tap hits it).
export const STAGE_LOG_ORDER = 'entered_at DESC, id DESC';
export const INPUT_ORDER = 'added_at DESC, id DESC';
// NULLS LAST is mandatory (SavedSeeds.jsx:594-613): an unknown start must not outrank a measured one
// at the top of a "check this" list.
export const BATCH_LIST_ORDER = 'started_at DESC NULLS LAST, first_recorded_at DESC';

// Same literal as household.js / index.js. A malformed id must get the SAME generic 400/404 a foreign id
// gets, never a 22P02 falling through to an opaque 500 or an "is this a uuid" side channel.
export const KITCHEN_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Zoneless local calendar day. The predicate window is a CIVIL range a person types, never an instant.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function normalizeText(v) {
  if (v == null) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
}

const isUuid = (v) => typeof v === 'string' && KITCHEN_UUID_RE.test(v);
const has = (body, k) => Object.prototype.hasOwnProperty.call(body, k);

// Returned as data so a test can execute the route table. The literal sub-routes (`stages`, `inputs`,
// `close`) are matched by SHAPE, not by trying `:id` first.
export function parseKitchenRoute(rawPath) {
  if (typeof rawPath !== 'string') return null;
  const path = rawPath.length > 1 && rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
  if (path === '/api/kitchen-batches') return { kind: 'collection' };
  // The line search is a LITERAL, matched BEFORE any :id capture, so 'line-search' is never a batch id.
  if (path === '/api/kitchen-batches/line-search') return { kind: 'line_search' };
  // How it was made is a literal too, for the same reason.
  if (path === '/api/kitchen-batches/from-jars') return { kind: 'from_jars' };
  const m = path.match(/^\/api\/kitchen-batches\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?(?:\/([^/]+))?$/);
  if (!m) return null;
  const [, id, sub, tail, fourth] = m;
  // The four-segment shapes: Put-Up 1b's undo, F's line restore.
  if (sub === 'put-up' && tail && fourth === 'undo') return { kind: 'put_up_undo', id, stageId: tail };
  if (sub === 'inputs' && tail && fourth === 'restore') return { kind: 'input_restore', id, inputId: tail };
  if (fourth) return null;
  if (!sub) return { kind: 'batch', id };
  if (sub === 'stages' && tail) return { kind: 'stage', id, stageId: tail };
  if (sub === 'shu-estimate' && !tail) return { kind: 'shu_estimate', id };
  if (sub === 'shu-estimate' && tail === 'save') return { kind: 'shu_estimate_save', id };
  if (sub === 'put-up' && !tail) return { kind: 'put_up', id };
  if (sub === 'stages' && !tail) return { kind: 'stages', id };
  if (sub === 'inputs' && !tail) return { kind: 'inputs', id };
  if (sub === 'inputs' && tail) return { kind: 'input', id, inputId: tail };
  if (sub === 'close' && !tail) return { kind: 'close', id };
  if (sub === 'reopen' && !tail) return { kind: 'reopen', id };
  if (sub === 'outputs' && !tail) return { kind: 'outputs', id };
  if (sub === 'outputs' && tail) return { kind: 'output', id, outputId: tail };
  return null;
}

// `state` defaults to `going` (closed_at IS NULL, INCLUDING suspended batches: the client tells them apart
// by suspended_at, since a frozen candy parent that resumes over months is not a day-2 syrup pot).
export function parseBatchState(raw) {
  return raw === 'closed' || raw === 'all' ? raw : 'going';
}

// chk_kitchen_batch_start_pairing, mirrored: (started_at IS NOT NULL) = (start_precision IS NOT NULL AND
// start_precision <> 'unknown'). The four start states it makes exclusive are all real claims: never
// asked, asked and unknown, a date with a grade. `requirePair` makes the merge PUT safe: it cannot see
// the stored half, so a request moving one half alone could only be validated by read-then-write (TOCTOU).
function startPairingError(body, { requirePair }) {
  const hasDate = has(body, 'started_at');
  const hasGrade = has(body, 'start_precision');
  if (requirePair && (hasDate || hasGrade) && !(hasDate && hasGrade)) {
    return 'started_at and start_precision must be sent together — a date always carries its grade';
  }
  const startedAt = hasDate ? body.started_at : null;
  const precision = normalizeText(hasGrade ? body.start_precision : null);
  if (precision != null && !KITCHEN_START_PRECISIONS.includes(precision)) {
    return `start_precision must be one of: ${KITCHEN_START_PRECISIONS.join(', ')}`;
  }
  const dated = startedAt != null && String(startedAt).trim() !== '';
  const graded = precision != null && precision !== 'unknown';
  if (dated && !graded) {
    return "a start date needs a start_precision, and 'unknown' is not one — pick exact, hour, day, week or month";
  }
  if (!dated && graded) {
    return `start_precision '${precision}' needs a started_at — use 'unknown' to record that you do not know`;
  }
  return null;
}

function anchorError(body) {
  const kind = normalizeText(body.start_anchor_kind);
  if (kind != null && !KITCHEN_START_ANCHOR_KINDS.includes(kind)) {
    return `start_anchor_kind must be one of: ${KITCHEN_START_ANCHOR_KINDS.join(', ')}`;
  }
  const id = body.start_anchor_id ?? null;
  if (id != null && !isUuid(id)) return 'start_anchor_id must be a uuid';
  // One-directional, matching chk_kitchen_batch_anchor_pairing: 'memory' legitimately has no id, but
  // an id always needs a kind.
  if (id != null && kind == null) return 'start_anchor_id needs a start_anchor_kind';
  if (id != null && !VERIFIABLE_ANCHOR_KINDS.includes(kind)) {
    return `start_anchor_id is only meaningful for a ${VERIFIABLE_ANCHOR_KINDS.join(' or ')} anchor`;
  }
  return null;
}

// chk_kitchen_batch_expected_pairing + _order. A RANGE, because a single number makes "every derived
// number inherits the widest bound" uncomputable.
function expectedDaysError(body, { requirePair }) {
  const hasMin = has(body, 'expected_days_min');
  const hasMax = has(body, 'expected_days_max');
  if (requirePair && (hasMin || hasMax) && !(hasMin && hasMax)) {
    return 'expected_days_min and expected_days_max must be sent together';
  }
  const min = hasMin ? body.expected_days_min : null;
  const max = hasMax ? body.expected_days_max : null;
  if ((min == null) !== (max == null)) {
    return 'expected_days_min and expected_days_max must both be set, or both be empty';
  }
  if (min == null) return null;
  if (!Number.isInteger(Number(min)) || !Number.isInteger(Number(max))) {
    return 'expected_days_min and expected_days_max must be whole numbers of days';
  }
  if (Number(min) < 0) return 'expected_days_min must be 0 or more';
  if (Number(max) < Number(min)) return 'expected_days_max must be at least expected_days_min';
  return null;
}

// `kind` OWNS THE PAIR, as source_kind has over source_label in index.js: naming the kind names kind_other
// too, omitting it touches neither. Otherwise switching 'other' to 'candy' would strand the old text.
function kindError(body, { requirePair }) {
  if (!has(body, 'kind')) return null;
  const kind = normalizeText(body.kind);
  if (kind != null && !KITCHEN_BATCH_KINDS.includes(kind)) {
    return `kind must be one of: ${KITCHEN_BATCH_KINDS.join(', ')}`;
  }
  // "Other" needs no text (chk_kitchen_batch_kind_other); it still refuses a BLANK name, which
  // normalizeText turns into NULL.
  if (requirePair && kind !== 'other' && normalizeText(body.kind_other) != null) {
    return "kind_other only applies when kind is 'other'";
  }
  return null;
}

// POST /api/kitchen-batches: `label` is the only required field; a batch with nothing but a label and a
// photo is a complete, valid record.
export function validateBatchCreate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body required';
  if (normalizeText(body.label) == null) return 'label is required';
  const rejected = KITCHEN_BATCH_SERVER_OWNED_COLUMNS.filter((c) => has(body, c));
  if (rejected.length) return `these fields are set by the server, not the client: ${rejected.join(', ')}`;
  // The idempotency key lives on the batch row (uq_kitchen_batch_idempotency_key). A batch may name the
  // recipe it follows (the route loads it household-scoped); F's free-text recipe_ref rides the create too.
  return kindError(body, { requirePair: false })
    ?? uuidFieldError(body, 'recipe_id')
    ?? recipeRefError(body)
    ?? startPairingError(body, { requirePair: false })
    ?? anchorError(body)
    ?? expectedDaysError(body, { requirePair: false })
    ?? uuidFieldError(body, 'cover_photo_id')
    ?? uuidFieldError(body, 'idempotency_key');
}

function recipeRefError(body) {
  if (body.recipe_ref == null) return null;
  const t = normalizeText(body.recipe_ref);
  if (t == null) return 'the recipe reference cannot be blank';
  return t.length > 500 ? 'the recipe reference can be at most 500 characters' : null;
}

function uuidFieldError(body, field) {
  const v = body[field] ?? null;
  return v == null || isUuid(v) ? null : `${field} must be a uuid`;
}

// PUT /api/kitchen-batches/:id: a MERGE, not the full replace in index.js. Absent keys are left alone; an
// explicit null clears, which is why this cannot use COALESCE (see kitchenRoutes.js).
export function validateBatchUpdate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body required';
  const rejected = KITCHEN_BATCH_SERVER_OWNED_COLUMNS.filter((c) => has(body, c));
  if (rejected.length) return `these fields cannot be edited here: ${rejected.join(', ')}`;
  // A heat estimate typed on the merge PUT is 'typed'; 'computed' is written only by POST
  // /:id/shu-estimate/save, which recomputes it server-side.
  if (has(body, 'shu_est_basis')) {
    if (body.shu_est_basis !== 'typed') return "shu_est_basis can only be 'typed' here — use Work it out to save a computed estimate";
  }
  const unknown = Object.keys(body).filter((k) => k !== 'shu_est_basis' && !KITCHEN_BATCH_EDITABLE_COLUMNS.includes(k));
  if (unknown.length) return `unknown field(s): ${unknown.join(', ')}`;
  if (!Object.keys(body).length) return 'nothing to update';
  // A label may be changed but never emptied (chk_kitchen_batch_label_nonblank).
  if (has(body, 'label') && normalizeText(body.label) == null) return 'label cannot be empty';
  return fBatchFieldsError(body)
    ?? kindError(body, { requirePair: true })
    ?? startPairingError(body, { requirePair: true })
    ?? anchorError(body)
    ?? expectedDaysError(body, { requirePair: true })
    ?? uuidFieldError(body, 'cover_photo_id');
}

// Release F's batch fields (chk_kitchen_batch_vessel_*, _shu_est_*, _recipe_ref_nonblank), mirrored.
// The merge cannot see the stored half of a pair, so each pair travels together.
function fBatchFieldsError(body) {
  if (has(body, 'vessel_label') && body.vessel_label != null) {
    const t = normalizeText(body.vessel_label);
    if (t == null) return 'the jar size name cannot be blank';
    if (t.length > 120) return 'the jar size name can be at most 120 characters';
  }
  if (has(body, 'vessel_size') !== has(body, 'vessel_unit')) return 'vessel_size and vessel_unit are sent together';
  if (has(body, 'vessel_size')) {
    const size = body.vessel_size;
    const unit = normalizeText(body.vessel_unit);
    if ((size == null) !== (unit == null)) return 'a jar size needs its unit, and a unit needs its size';
    if (size != null && !(Number.isFinite(Number(size)) && Number(size) > 0)) return 'vessel_size must be greater than 0';
    if (unit != null && !KITCHEN_UNITS.includes(unit)) return `vessel_unit must be one of: ${KITCHEN_UNITS.join(', ')}`;
  }
  if (has(body, 'vessel_count') && body.vessel_count != null) {
    const c = Number(body.vessel_count);
    if (!Number.isInteger(c) || c < 1 || c > KITCHEN_VESSEL_COUNT_MAX) return `vessel_count must be 1 to ${KITCHEN_VESSEL_COUNT_MAX}`;
  }
  if (has(body, 'no_salt') && body.no_salt != null && typeof body.no_salt !== 'boolean') return 'no_salt must be true or false';
  if (has(body, 'shu_est_low') !== has(body, 'shu_est_high')) return 'shu_est_low and shu_est_high are sent together';
  if (has(body, 'shu_est_low')) {
    const lo = body.shu_est_low;
    const hi = body.shu_est_high;
    if (lo == null && hi != null) return 'a heat estimate needs its low end';
    if (lo != null && (!Number.isInteger(Number(lo)) || Number(lo) < 0)) return 'shu_est_low must be a whole number, 0 or more';
    if (hi != null && (!Number.isInteger(Number(hi)) || Number(hi) < Number(lo))) return 'shu_est_high must be a whole number at least shu_est_low';
  }
  if (has(body, 'recipe_ref') && body.recipe_ref != null) {
    const t = normalizeText(body.recipe_ref);
    if (t == null) return 'the recipe reference cannot be blank';
    if (t.length > 500) return 'the recipe reference can be at most 500 characters';
  }
  return null;
}

// Split a validated PUT body into "which columns were mentioned" and "what value for each": two objects,
// because a merge must tell an explicit null from an absent key, which `?? null` destroys.
export function batchUpdatePatch(body) {
  const present = {};
  const value = {};
  for (const col of KITCHEN_BATCH_EDITABLE_COLUMNS) {
    if (!has(body, col)) { present[col] = false; value[col] = null; continue; }
    present[col] = true;
    if (KITCHEN_TEXT_COLUMNS.has(col)) value[col] = normalizeText(body[col]);
    else if (KITCHEN_INTEGER_COLUMNS.has(col)) value[col] = body[col] == null ? null : Number(body[col]);
    else value[col] = body[col] ?? null;
  }
  // kind owns the pair. Set explicitly to anything but 'other' and the free-text label goes with it.
  if (present.kind && value.kind !== 'other') { present.kind_other = true; value.kind_other = null; }
  // Release F: numeric vessel size stays the STRING sent (a Number round-trip drops a trailing zero);
  // no_salt is true-or-NULL (chk_kitchen_batch_no_salt_true) — false clears.
  if (present.vessel_size) value.vessel_size = body.vessel_size == null ? null : String(body.vessel_size);
  if (present.no_salt) value.no_salt = body.no_salt === true ? true : null;
  return { present, value };
}

// POST /api/kitchen-batches/:id/stages. No DELETE on a stage row, and that absence IS the design: an
// off-log repair path produced the seed-lot divergence this schema refuses to copy (Release F's in-place
// edit is kitchenLines.js stagePatchError + kitchenRoutes.js patchStage). No PUT either: an Undo is a VOID
// row appended beside the row it undoes, which keeps the log readable.
export function validateStage(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body required';
  const kind = normalizeText(body.stage_kind);
  if (kind == null || !KITCHEN_STAGE_ROUTE_KINDS.includes(kind)) {
    return `stage_kind must be one of: ${KITCHEN_STAGE_ROUTE_KINDS.join(', ')}`;
  }
  // "A void row carries nothing else" (V4 Appendix A): a writer rule, not a CHECK.
  if (kind === 'void') {
    const extra = Object.keys(body).filter((k) => k !== 'stage_kind' && k !== 'voids_id');
    if (extra.length) return `an undo carries only the row it undoes (voids_id), not: ${extra.join(', ')}`;
    if (!isUuid(body.voids_id ?? null)) return 'voids_id must be the id of the row to undo';
    return null;
  }
  if (body.voids_id != null) return "voids_id only goes with stage_kind 'void'";
  // Rows written "now, exact" (a note, a pause, a resume, a reopen) take nothing retrospective, so a date
  // or precision sent with one is refused rather than ignored.
  if (kind === 'noted' || KITCHEN_STATE_STAGE_KINDS.includes(kind)) {
    if (body.entered_at != null || body.entered_precision != null) {
      return `a '${kind}' row is stamped when it is written — send no entered_at or entered_precision`;
    }
  }
  if (kind === 'noted' && normalizeText(body.note) == null) return "a 'noted' row needs the note";
  // Release F: what was done at a check-in. Tended only, from the three words (chk_ksl_acts,
  // chk_ksl_acts_on_tended); the route de-duplicates.
  if (has(body, 'acts') && body.acts != null) {
    if (kind !== 'tended') return 'what you did goes on a check-in';
    if (!Array.isArray(body.acts) || !body.acts.length) return 'acts must be a non-empty list, or absent';
    const unknownActs = body.acts.filter((a) => !KITCHEN_ACTS.includes(a));
    if (unknownActs.length) return `acts must be among: ${KITCHEN_ACTS.join(', ')}`;
  }
  const precErr = enteredPrecisionError(body);
  if (precErr) return precErr;
  // chk_ksl_moved_needs_location. Placement is a RATE input, not a milestone: a 'moved' row with no
  // destination destroys the only thing that changed.
  if (kind === 'moved' && !isUuid(body.storage_location_id ?? null)) {
    return "a 'moved' stage needs a storage_location_id — where did it go?";
  }
  if (has(body, 'label') && body.label != null && normalizeText(body.label) == null) {
    return 'label cannot be blank';
  }
  const amount = body.amount ?? null;
  const unit = normalizeText(body.amount_unit);
  if ((amount == null) !== (unit == null)) return 'amount and amount_unit must both be set, or both be empty';
  if (amount != null) {
    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) return 'amount must be greater than 0';
    if (!KITCHEN_QTY_UNITS.includes(unit)) return `amount_unit must be one of: ${KITCHEN_QTY_UNITS.join(', ')}`;
  }
  return phError(body) ?? uuidFieldError(body, 'storage_location_id') ?? uuidFieldError(body, 'photo_id');
}

// chk_ksl_entered_precision + chk_ksl_entered_pairing, mirrored: `unknown` iff there is no date, and a
// dated precision needs its date. An ABSENT precision is the pre-1b writer's shape and stays legal forever
// (the route stamps entered_at with a NULL precision).
function enteredPrecisionError(body) {
  const prec = normalizeText(body.entered_precision);
  const at = body.entered_at ?? null;
  if (at != null && Number.isNaN(new Date(String(at)).getTime())) return 'entered_at has to be a timestamp';
  if (prec == null) return null;
  if (!KITCHEN_ENTERED_PRECISIONS.includes(prec)) {
    return `entered_precision must be one of: ${KITCHEN_ENTERED_PRECISIONS.join(', ')}`;
  }
  if (prec === 'unknown' && at != null) return "'unknown' means there is no date — send no entered_at with it";
  if (prec !== 'unknown' && at == null) return `entered_precision '${prec}' needs an entered_at — use 'unknown' to record that you do not know`;
  return null;
}

// chk_ksl_ph_pairing + chk_ksl_ph_scale, mirrored. A reading always carries the instant it was read:
// entered_at ("when did you log this") and ph_read_at ("when did you read it") are different facts, and
// defaulting one from the other would stamp a time onto a measurement nobody took then. No default
// anywhere (here, the route, the column), so the pair is required together or omitted together.
//
// Nothing here looks at the value's meaning. It is passed through as the STRING the client sent (a Number
// round-trip drops a trailing zero the meter displayed), so the route never coerces it.
function phError(body) {
  const reading = body.ph_reading ?? null;
  const readAt = body.ph_read_at ?? null;
  if ((reading == null) !== (readAt == null)) {
    return 'a pH reading and the time it was read must both be set, or both be empty';
  }
  if (reading == null) return null;
  const n = Number(String(reading).trim());
  if (String(reading).trim() === '' || !Number.isFinite(n)) return 'a pH reading has to be a number';
  if (n < KITCHEN_PH_SCALE_MIN || n > KITCHEN_PH_SCALE_MAX) {
    return `a pH reading has to be on the pH scale — ${KITCHEN_PH_SCALE_MIN} to ${KITCHEN_PH_SCALE_MAX}`;
  }
  // Checked here rather than left to ::timestamptz, which would surface a typo as a 22007 and an opaque 500.
  if (Number.isNaN(new Date(String(readAt)).getTime())) {
    return 'ph_read_at has to be a timestamp';
  }
  return null;
}

// POST /api/kitchen-batches/:id/inputs: two forms, one route. The PREDICATE form is required: one
// five-week pepper mash fans in 139 harvest_log rows across 30 plantings, and a 139-row hand-pick is a
// discoverability failure.
export function validateInputPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body required';
  const hasList = has(body, 'inputs');
  const hasPredicate = has(body, 'predicate');
  if (hasList === hasPredicate) return 'send either inputs or predicate, not both and not neither';
  // `preview` is the dry-run flag and belongs to the predicate form ONLY: the explicit form is already
  // reviewable, and silently accepting preview there is how a client believes it dry-ran a write that
  // committed. Strict boolean, so "true" must not read as true.
  if (has(body, 'preview')) {
    if (!hasPredicate) return 'preview only applies to the predicate form';
    if (typeof body.preview !== 'boolean') return 'preview must be true or false';
  }
  if (hasPredicate) return predicateError(body.predicate);
  if (!Array.isArray(body.inputs) || body.inputs.length === 0) return 'inputs must be a non-empty array';
  for (const row of body.inputs) {
    const err = inputRowError(row);
    if (err) return err;
  }
  return null;
}

function inputRowError(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return 'each input must be an object';
  const kind = normalizeText(row.input_kind);
  if (kind == null || !KITCHEN_INPUT_KINDS.includes(kind)) {
    return `input_kind must be one of: ${KITCHEN_INPUT_KINDS.join(', ')}`;
  }
  const harvestId = row.harvest_log_id ?? null;
  if (harvestId != null && !isUuid(harvestId)) return 'harvest_log_id must be a uuid';
  // chk_kbi_harvest_pairing is a BICONDITIONAL, not two one-way checks: a harvest row must carry the
  // FK and a non-harvest row must not, so the discriminator can never disagree with the data.
  if ((kind === 'harvest') !== (harvestId != null)) {
    return kind === 'harvest'
      ? "an input of kind 'harvest' needs a harvest_log_id"
      : `an input of kind '${kind}' must not carry a harvest_log_id`;
  }
  if (kind !== 'harvest' && normalizeText(row.label) == null) {
    return `an input of kind '${kind}' needs a label — name what went in`;
  }
  // chk_kbi_byproduct_needs_harvest. Only a harvest can be an offcut of one: rind is a byproduct of
  // fruit already counted, and the flag is what lets a roll-up avoid double-counting it.
  if (row.is_byproduct === true && kind !== 'harvest') {
    return 'is_byproduct only applies to a harvest input';
  }
  const qty = row.qty ?? null;
  const unit = normalizeText(row.qty_unit);
  // A NULL pair means "unrecorded, assume the whole thing" (chk_harvest_log_weight_pairing's idiom), never zero.
  if ((qty == null) !== (unit == null)) return 'qty and qty_unit must both be set, or both be empty';
  if (qty != null) {
    if (!Number.isFinite(Number(qty)) || Number(qty) <= 0) return 'qty must be greater than 0';
    if (!KITCHEN_QTY_UNITS.includes(unit)) return `qty_unit must be one of: ${KITCHEN_QTY_UNITS.join(', ')}`;
  }
  return null;
}

// Inclusive day count between two YYYY-MM-DD literals. Date.parse of a date-only string is UTC, so the
// difference is an exact multiple of 86_400_000 in any zone. Callers must shape-check first: a non-date
// gives NaN and NaN > cap is false, so predicateError runs DATE_RE before this.
export function predicateSpanDays(p) {
  const from = Date.parse(`${p.from}T00:00:00Z`);
  const to = Date.parse(`${p.to}T00:00:00Z`);
  return Math.round((to - from) / 86400000) + 1;
}

function predicateError(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'predicate must be an object';
  // Zoneless local calendar days, both required: a window makes the bulk add reviewable; an open-ended
  // one is "everything".
  if (!DATE_RE.test(String(p.from ?? ''))) return 'predicate.from must be a YYYY-MM-DD date';
  if (!DATE_RE.test(String(p.to ?? ''))) return 'predicate.to must be a YYYY-MM-DD date';
  if (String(p.to) < String(p.from)) return 'predicate.to must be on or after predicate.from';
  // The span ceiling applies the same reasoning to a window wide enough to mean "everything". Both
  // endpoints are ET calendar days, so the count is inclusive (from == to is 1).
  const span = predicateSpanDays(p);
  if (span > KITCHEN_PREDICATE_MAX_SPAN_DAYS) {
    return `that window covers ${span} days — a bulk add takes at most ${KITCHEN_PREDICATE_MAX_SPAN_DAYS}, so narrow it or add the picks in two passes`;
  }
  if (p.variety_id != null && !isUuid(p.variety_id)) return 'predicate.variety_id must be a uuid';
  if (p.plant_id != null && !isUuid(p.plant_id)) return 'predicate.plant_id must be a uuid';
  if (p.crop_type_slug != null && normalizeText(p.crop_type_slug) == null) {
    return 'predicate.crop_type_slug cannot be blank';
  }
  return null;
}

// Normalized column arrays for the unnest'd bulk INSERT. Harvest ids are DEDUPED here as well as by
// uq_kbi_batch_harvest, so naming the same pick twice does not report two inserts.
export function normalizeInputRows(inputs) {
  const seenHarvest = new Set();
  const out = [];
  for (const row of inputs) {
    const kind = normalizeText(row.input_kind);
    const harvestLogId = row.harvest_log_id ?? null;
    if (harvestLogId != null) {
      if (seenHarvest.has(harvestLogId)) continue;
      seenHarvest.add(harvestLogId);
    }
    out.push({
      input_kind: kind,
      harvest_log_id: harvestLogId,
      label: normalizeText(row.label),
      qty: row.qty == null ? null : Number(row.qty),
      qty_unit: normalizeText(row.qty_unit),
      is_byproduct: row.is_byproduct === true,
      note: normalizeText(row.note),
    });
  }
  return out;
}

export function harvestIdsIn(inputs) {
  return [...new Set(inputs.map((r) => r.harvest_log_id).filter((v) => v != null))];
}

// POST /api/kitchen-batches/:id/close. chk_kitchen_batch_close_pairing makes closed_at and outcome
// inseparable, so outcome is the only required field.
//
// `cue_observed` rides on this body and is deliberately NOT validated: it is the observation that decided
// "it is done" (for a dehydrate batch the endpoint IS the cue, e.g. NCHFP's "brittle or crisp"). Free text,
// never a picklist, never range-checked, never read back into any decision, which keeps it a RECORD and
// not an assessment.
export function validateClose(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body required';
  const outcome = normalizeText(body.outcome);
  if (outcome == null || !KITCHEN_OUTCOMES.includes(outcome)) {
    return `outcome must be one of: ${KITCHEN_OUTCOMES.join(', ')}`;
  }
  const ids = body.output_preservation_log_ids;
  if (ids != null) {
    if (!Array.isArray(ids)) return 'output_preservation_log_ids must be an array';
    if (!ids.every(isUuid)) return 'output_preservation_log_ids must all be uuids';
  }
  return null;
}

export function outputIdsIn(body) {
  return [...new Set(body.output_preservation_log_ids ?? [])];
}

// POST /api/kitchen-batches/:id/outputs. LINKING IS DECOUPLED FROM CLOSING: close was once the only writer
// of preservation_log.batch_id, so a jar could not be linked without ENDING the batch, yet the commonest
// real event is a partial draw-off from a batch that keeps going (two quarts off a mash whose crock
// continues). close keeps output_preservation_log_ids for the terminal case.
export function validateOutputsPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body required';
  const ids = body.preservation_log_ids;
  if (!Array.isArray(ids)) return 'preservation_log_ids must be an array';
  if (!ids.length) return 'preservation_log_ids must be a non-empty array';
  if (!ids.every(isUuid)) return 'preservation_log_ids must all be uuids';
  return null;
}

// Deduped, matching outputIdsIn: a request naming the same jar twice must not report two links when
// one row moves.
export function outputLogIdsIn(body) {
  return [...new Set(body.preservation_log_ids ?? [])];
}

// Every CHECK this schema ships, given words. Returns null for anything not ours, so index.js's PG-code
// map keeps its behaviour for the preservation routes.
const CONSTRAINT_MESSAGES = {
  chk_kitchen_batch_kind: 'that is not a kind this app knows',
  chk_kitchen_batch_kind_other: "name the kind when you pick 'other'",
  chk_kitchen_batch_start_precision: 'that is not a start precision this app knows',
  chk_kitchen_batch_start_pairing:
    "a start date always carries a precision, and 'unknown' always comes without a date",
  chk_kitchen_batch_anchor_kind: 'that is not a start anchor this app knows',
  chk_kitchen_batch_anchor_pairing: 'a start anchor id needs to say what it is anchored to',
  chk_kitchen_batch_expected_pairing: 'an expected duration needs both a minimum and a maximum',
  chk_kitchen_batch_expected_order: 'the expected maximum has to be at least the minimum',
  chk_kitchen_batch_outcome: 'that is not an outcome this app knows',
  chk_kitchen_batch_close_pairing: 'closing a batch needs an outcome',
  // Reachable through the merge PUT, which never sees closed_at: suspending means "paused, still mine
  // to finish", and a closed batch is finished.
  chk_kitchen_batch_suspend_exclusive: 'this batch is already closed, so it cannot be suspended',
  chk_kitchen_batch_label_nonblank: 'a batch needs a label',
  chk_kbi_kind: 'that is not an input kind this app knows',
  chk_kbi_harvest_pairing: 'a harvest input needs a harvest link, and any other input must not have one',
  chk_kbi_label_required: 'a non-harvest input needs a label',
  chk_kbi_byproduct_needs_harvest: 'only a harvest can be marked as a byproduct',
  chk_kbi_qty_pairing: 'a quantity needs a unit, and a unit needs a quantity',
  chk_kbi_qty_positive: 'a quantity has to be greater than zero',
  chk_kbi_qty_unit: 'that is not a unit this app knows',
  chk_ksl_stage_kind: 'that is not a stage this app knows',
  chk_ksl_moved_needs_location: "a 'moved' stage needs somewhere to have moved to",
  chk_ksl_label_nonblank: 'a stage label cannot be blank',
  chk_ksl_amount_pairing: 'an amount needs a unit, and a unit needs an amount',
  chk_ksl_amount_positive: 'an amount has to be greater than zero',
  // Both messages describe the SHAPE of the record, never the value's meaning.
  chk_ksl_ph_pairing: 'a pH reading needs the time it was read, and a time needs a reading',
  chk_ksl_ph_scale: 'that is not a reading on the pH scale',
  // 1b CHECKs (v5-putupmake-001). The last entry guards the two-truths fan-out: a jar comes from a batch
  // or from one harvest, never both.
  chk_ksl_entered_precision: 'that is not a date precision this app knows',
  chk_ksl_entered_pairing: "a date always carries its precision, and 'unknown' always comes without a date",
  chk_ksl_void_pairing: 'an undo row points at the row it undoes, and nothing else does',
  chk_ksl_amount_unit: 'that is not a unit this app knows',
  chk_kbi_put_up_pairing: 'a line drawn from a put-up names that put-up, and no other line does',
  chk_kbi_role: 'that is not a line role this app knows',
  chk_kbi_salt_base: 'that is not a salt base this app knows',
  chk_kbi_output_needs_put_up: 'a line added to a jar belongs to the put-up that made it',
  chk_preservation_log_one_provenance:
    'one of those put-ups is already linked to a single harvest — a jar comes from a batch or from one harvest, not both',
};

export function kitchenErrorMessage(err) {
  if (!err || err.code !== '23514') return null;
  return CONSTRAINT_MESSAGES[String(err.constraint ?? '')] ?? null;
}
