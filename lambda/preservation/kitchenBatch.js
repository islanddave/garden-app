// V5-INFLIGHTBATCH-001 — vocabulary, validation and route parsing for /api/kitchen-batches.
//
// DEPENDENCY-FREE ON PURPOSE, exactly like ./provenance.js, ./attribution.js and ./useBy.js:
// index.js imports @neondatabase/serverless, @clerk/backend and @aws-sdk at module scope, so anything
// defined THERE can only ever be asserted by its spelling. Everything in this file is importable by
// the blocking `npm test` lane and is asserted by executing it. Do not add imports.
//
// Every vocabulary below duplicates a DB CHECK from migrations/v5-inflightbatch-001/0a-additive-ddl.sql
// on purpose — the same belt-and-suspenders pattern VALID_METHODS uses. A raw 23514 surfaces as
// `Constraint violation: chk_kitchen_batch_start_pairing`, which is not something a cook standing at a
// counter can act on. The DB is the belt; these messages are the product.

// chk_kitchen_batch_kind. NULLABLE on purpose — the existing put-up picker has a 40% mis-file rate on
// its live rows, and "something in the kitchen, started now, here is a photo" must be a COMPLETE,
// VALID record. The method is pinned at close-out, against a DIFFERENT vocabulary (VALID_METHODS).
// Never auto-map one to the other: one mash legitimately outputs both hot_sauce and ferment_mash jars.
export const KITCHEN_BATCH_KINDS = ['ferment', 'dehydrate', 'candy', 'cure', 'infuse', 'age', 'other'];

// chk_kitchen_batch_start_precision. 'hour' exists because a dehydrator run has no rung for "sometime
// this afternoon"; grading that as `day` renders a 100%+ error as a confident figure.
export const KITCHEN_START_PRECISIONS = ['exact', 'hour', 'day', 'week', 'month', 'season', 'year', 'unknown'];

// Put-Up release 1b — the estimated-date vocabulary widens by the two dated estimate words the estimate
// chips store (V4 "Estimated dates": "2–3 months ago" → season, "Earlier this year" / "Last year" →
// year). chk_kitchen_batch_start_precision and chk_ksl_entered_precision carry the same eight.
export const KITCHEN_ENTERED_PRECISIONS = KITCHEN_START_PRECISIONS;

export const KITCHEN_START_ANCHOR_KINDS = ['harvest', 'photo', 'purchase', 'memory', 'manual'];

// The two anchor kinds that name a row this app can actually resolve — and therefore the only two an
// id is accepted for. NARROWER THAN THE DDL ON PURPOSE: start_anchor_id has NO database FK (it is a
// polymorphic uuid pointing at photos.id or harvest_log.id), so nothing enforces even existence, let
// alone ownership. 'purchase' and 'manual' name no table here and 'memory' is defined as having no id,
// so an id under those kinds is a uuid nothing can ever dereference — and one an ownership gate could
// not check either. Refusing it is what lets the two remaining cases be gated exhaustively in
// kitchenRoutes.js. Widen this the day a kind gains a real table, and gate it in the same commit.
export const VERIFIABLE_ANCHOR_KINDS = ['harvest', 'photo'];

// chk_kitchen_batch_outcome. Six, and the four beyond the obvious two are load-bearing —
// put_up_different because candying's commonest non-ideal result is a downgrade that still produces a
// real storable product, and discarded_spoiled because in a two-user household "Jen cannot tell
// whether the jar was eaten or thrown out" is the actual hazard.
export const KITCHEN_OUTCOMES = [
  'put_up', 'put_up_different', 'consumed', 'given_away', 'discarded_spoiled', 'abandoned',
];

// chk_ksl_stage_kind. ORDER IS NOT MONOTONIC: a `tended` row legitimately arrives after a `finished`
// one (three of six documented candy recoveries re-enter the sequence). Nothing here may sort on it.
export const KITCHEN_STAGE_KINDS = ['started', 'tended', 'moved', 'finished', 'failed'];

// Put-Up release 1b — chk_ksl_stage_kind as 1b widened it: every kind a stage row can CARRY, which is
// every kind getBatch can send. KITCHEN_STAGE_KINDS above stays the five shipped kinds on purpose: it is
// what the view's legacy current_stage_* LATERAL reads, and the shipped client's label maps are bound to
// it (src/__tests__/PutUpBatchDetail.test.jsx) — the 1b client binds its maps to this list instead.
export const KITCHEN_STAGE_KINDS_ALL = [
  'started', 'tended', 'moved', 'finished', 'failed',
  'reopened', 'paused', 'resumed', 'noted', 'put_up', 'void',
];

// What POST /:id/stages accepts. put_up is written only by Put it up; a void of a put_up or finished row
// only by Undo that put-up (V4 Appendix A).
export const KITCHEN_STAGE_ROUTE_KINDS = [
  'started', 'tended', 'moved', 'finished', 'failed', 'reopened', 'paused', 'resumed', 'noted', 'void',
];
// The kinds a stages-route void may point at (V4 Appendix A: "tended, moved, noted — the only kinds the
// stages route voids").
export const KITCHEN_VOIDABLE_KINDS = ['tended', 'moved', 'noted'];
// The lifecycle kinds Undo that put-up reads when it decides whether to reopen (V4 "Undo that put-up":
// "noted, tended, moved and void rows do not count").
export const KITCHEN_LIFECYCLE_KINDS = ['put_up', 'finished', 'failed', 'reopened', 'paused', 'resumed'];
// The kinds that are a batch STATE change as well as a row: the stages route writes the row and moves
// the batch column in ONE statement, so the column stays authoritative and the log cannot disagree.
export const KITCHEN_STATE_STAGE_KINDS = ['paused', 'resumed', 'reopened'];

export const KITCHEN_INPUT_KINDS = ['harvest', 'purchased', 'pantry', 'other'];

// chk_kbi_qty_unit as v5-inflightbatch-001 shipped it (14 values). Applied to kitchen_stage_log.amount_unit
// TOO. Put-Up release 1b gives both columns (and preservation_log.quantity_unit, which had drifted —
// 'quarts' beside harvest_log's 'qt', BUG-PRESERVUNITNOCHECK-001) a real CHECK: KITCHEN_UNITS, 25 values,
// a superset of these 14. This list stays the 14 until release F widens the line writers (lane L2b).
export const KITCHEN_QTY_UNITS = [
  'g', 'kg', 'oz', 'lb', 'count', 'cup', 'tbsp', 'tsp', 'fl oz', 'qt', 'gal', 'ml', 'l', 'other',
];

// ── Release F (contract-F.md conventions) ─────────────────────────────────────────────────────────
// KITCHEN_UNITS — the one list (V4 "Units"), = chk_kbi_qty_unit / chk_ksl_amount_unit as 1b widened
// them and chk_kitchen_batch_vessel_unit (F). Every F writer (keyed lines, line PATCH, stage PATCH,
// vessel) takes these 25. KITCHEN_QTY_UNITS above stays the 14 the SHIPPED forms were built on, because
// the shipped client mirror (src/components/putup/batchInputs.js) is bound to it; the un-keyed bulk form
// keeps it.
export const KITCHEN_UNITS = [
  'g', 'kg', 'oz', 'lb', 'ml', 'l', 'tsp', 'tbsp', 'fl oz', 'cup', 'pint', 'qt', 'gal',
  'count', 'clove', 'head', 'bunch', 'pinch', 'peck', 'bushel', 'half-bushel', 'flat', 'jar', 'bag', 'other',
];
// Grams per unit — THE one mass table (06 §1.4). A unit not here is not a mass.
export const MASS_G = Object.freeze({ g: 1, kg: 1000, oz: 28.3495, lb: 453.592 });
// Grams per unit for a role='water' line ONLY (1 g/ml; 06's water-conversion rule). Every other volume is "no weight".
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
// The kinds a line POST writes (contract-F §2.2). B′ release 3 adds 'pantry': a bought item from the
// Pantry, named by pantry_item_id (chk_kbi_pantry_item_kind, v5-pantry-001).
export const KITCHEN_LINE_KINDS = ['garden', 'harvest', 'put_up', 'purchased', 'other', 'pantry'];
export const KITCHEN_SHU_BASES = ['computed', 'typed'];
// chk_kitchen_batch_vessel_count.
export const KITCHEN_VESSEL_COUNT_MAX = 50;

// V5-PHRECORD-001. chk_ksl_ph_scale, mirrored — the pH scale's definitional range and nothing else.
//
// ⚠ NOT A SAFETY BAND, and the distinction is the whole ruling. This range is symmetric, prefers no
// reading to any other, and excludes nothing a meter or a strip can produce; its only job is to catch
// a fat-finger before it is stored, exactly as the amount checks beside it do. The app RECORDS a
// measured pH, PROMPTS someone to measure, and LINKS to how — it never derives, scores, colours,
// gates on, or compares a reading to anything. There is no threshold constant in this file and there
// must never be one. Adjudication: FOODSAFETY-RULING-V101.md §2 (gardening-docs project-state).
// This is an original design choice, not a compliance posture: no published convention exists for
// what home-preservation software should say, which the research records as a negative RESULT.
//
// Restated in three places on purpose — the DB CHECK, here, and the client — which is the same
// belt-and-suspenders the vocabularies above use. A raw 23514 reads as
// `Constraint violation: chk_ksl_ph_scale`, which is not something a cook at a counter can act on.
export const KITCHEN_PH_SCALE_MIN = 0;
export const KITCHEN_PH_SCALE_MAX = 14;

// The PUT allowlist — an EXPLICIT set, not a full replace, and the difference from
// index.js:589-610 is deliberate. Closing goes through its own route, so closed_at/outcome are absent;
// first_recorded_at is the honest floor a client must never be able to move; user_id is ownership.
export const KITCHEN_BATCH_EDITABLE_COLUMNS = [
  'label', 'kind', 'kind_other', 'started_at', 'start_precision', 'start_anchor_kind', 'start_anchor_id',
  'expected_days_min', 'expected_days_max', 'brine_note', 'cover_photo_id', 'notes', 'suspended_at',
  // Release F (contract-F §2.1): the jar & heat facts and "Following a recipe?". shu_est_basis is NOT
  // here — the merge PUT writes 'typed' whenever it writes a heat estimate, and only
  // POST /:id/shu-estimate/save writes 'computed' (a body basis other than 'typed' is refused).
  'vessel_label', 'vessel_size', 'vessel_unit', 'vessel_count', 'no_salt', 'shu_est_low', 'shu_est_high',
  'recipe_ref',
];

// The complement, stated rather than implied. A column here reaching the PUT is a defect regardless of
// how it got there, and naming them is what lets a test assert the boundary from both sides.
export const KITCHEN_BATCH_SERVER_OWNED_COLUMNS = [
  'id', 'user_id', 'first_recorded_at', 'closed_at', 'outcome', 'outcome_note',
  'created_at', 'updated_at', 'deleted_at',
];

// THE REVERSIBILITY CONTRACT, NAMED SO A TEST CAN BIND IT. close writes exactly this set; reopen
// NULLs exactly this set. Under a mock driver a round-trip cannot be proven, only what each handler
// SENDS — so the assertable form is set equality in BOTH directions against this one constant, which
// is what stops close and reopen drifting apart later. Adding a fourth column to the close UPDATE
// without adding it here reds; adding it here without adding it to both statements also reds.
//
// suspended_at is DELIBERATELY NOT IN THIS SET even though close writes it. It is not part of the
// close's own record — it is the pause being cleared because chk_kitchen_batch_suspend_exclusive
// forbids a suspended closed batch — and a reopen that NULLed it would be a no-op on a column that
// is already NULL. Reopen therefore RESUMES a paused batch rather than restoring the pause, which is
// stated rather than silent: a batch you closed by mistake is one you are picking back up.
export const KITCHEN_BATCH_CLOSE_COLUMNS = ['closed_at', 'outcome', 'outcome_note'];

// The predicate bulk-add's window ceiling, inclusive of both endpoints. NOT a performance bound — a
// 1,212-row INSERT..SELECT is nothing to Postgres. It is a REPAIRABILITY bound: the undo for a
// mis-tapped predicate is DELETE /:id/inputs/:inputId, one row at a time, and the predicate form
// discards its RETURNING ids so even a targeted undo needs a full before/after GET diff. Measured on
// live prod 2026-09-04: `{from:'2000-01-01', to:'2100-01-01'}` with no other term inserts 1,212 rows
// in one tap.
//
// 366 and not less: the client's window comes from HarvestTimeframeChips, whose season chip spans a
// full Nov-Oct grow year (365 days inclusive, 366 across a leap day). A cap that rejected a season
// would break the one control the design ships for choosing the window.
export const KITCHEN_PREDICATE_MAX_SPAN_DAYS = 366;

// Columns whose value is normalized to "meaningful string or null" before it reaches the column.
// btrim() CHECKs exist on label / kind_other, and a whitespace-only brine_note is noise either way.
const KITCHEN_TEXT_COLUMNS = new Set([
  'label', 'kind', 'kind_other', 'start_precision', 'start_anchor_kind', 'brine_note', 'notes',
  'vessel_label', 'vessel_unit', 'recipe_ref',
]);

const KITCHEN_INTEGER_COLUMNS = new Set([
  'expected_days_min', 'expected_days_max', 'vessel_count', 'shu_est_low', 'shu_est_high',
]);

// ORDER KEYS, stated once. `id DESC` on the stage log is NOT decoration: two rows written in one
// statement tie on entered_at AND created_at, which is the nondeterminism seed_lot_stage_log's readers
// had until they took the same tiebreak (BUG-SEEDSTAGETZSHIFT-001) and this table's idx_ksl_batch was
// built to remove. A "topped up + skimmed" double-tap hits it.
export const STAGE_LOG_ORDER = 'entered_at DESC, id DESC';
export const INPUT_ORDER = 'added_at DESC, id DESC';
// NULLS LAST is mandatory (SavedSeeds.jsx:594-613): an unknown start must not outrank a measured one
// at the top of a "check this" list.
export const BATCH_LIST_ORDER = 'started_at DESC NULLS LAST, first_recorded_at DESC';

// Same literal as household.js / index.js. A malformed id must answer the SAME generic 400/404 a
// foreign id gets — never a 22P02 falling through to an opaque 500, which is both a worse contract and
// a weak "is this even a uuid" side channel.
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

// ── routing ──────────────────────────────────────────────────────────────────────────────────────
// Returned as data rather than branched inline so the route table is executable by a test. The
// literal sub-routes (`stages`, `inputs`, `close`) are matched by SHAPE, not by trying `:id` first —
// the SEEDINV / whats-put-up precedent, one altitude up.
export function parseKitchenRoute(rawPath) {
  if (typeof rawPath !== 'string') return null;
  const path = rawPath.length > 1 && rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
  if (path === '/api/kitchen-batches') return { kind: 'collection' };
  // Release F: the line search is a LITERAL, matched BEFORE any :id capture, so 'line-search' can never
  // be read as a batch id (API-I1).
  if (path === '/api/kitchen-batches/line-search') return { kind: 'line_search' };
  // B′ release 3: How it was made → — a literal too, for the same reason.
  if (path === '/api/kitchen-batches/from-jars') return { kind: 'from_jars' };
  const m = path.match(/^\/api\/kitchen-batches\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?(?:\/([^/]+))?$/);
  if (!m) return null;
  const [, id, sub, tail, fourth] = m;
  // The four-segment shapes: Put-Up 1b's undo, F's line restore. Every other arm has no fourth segment.
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

// `state` defaults to `going`. `going` = closed_at IS NULL and INCLUDES suspended batches — the client
// distinguishes them by suspended_at, because a frozen candy parent that resumes over months is not
// the same claim as a day-2 syrup pot, and hiding it would be a third state nobody asked for.
export function parseBatchState(raw) {
  return raw === 'closed' || raw === 'all' ? raw : 'going';
}

// ── shared field rules ───────────────────────────────────────────────────────────────────────────

// chk_kitchen_batch_start_pairing, mirrored:
//   (started_at IS NOT NULL) = (start_precision IS NOT NULL AND start_precision <> 'unknown')
// The four start states it makes exclusive are all real and all different claims — never asked, asked
// and unknown, and a date with a grade. `requirePair` is what makes the merge PUT safe: a merge cannot
// see the stored half, so a request that moves one half alone could only be validated by reading the
// row first, and a read-then-write is a TOCTOU where a paired requirement is not.
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

// chk_kitchen_batch_expected_pairing + _order. A RANGE rather than a single expected_days, because a
// single number makes "every derived number inherits the widest bound" uncomputable.
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

// `kind` OWNS THE PAIR, the same contract source_kind has over source_label in index.js — a request
// that names the kind names kind_other too, and one that omits it touches neither. Without that,
// switching a batch from 'other' to 'candy' would strand the old free-text label on the row.
function kindError(body, { requirePair }) {
  if (!has(body, 'kind')) return null;
  const kind = normalizeText(body.kind);
  if (kind != null && !KITCHEN_BATCH_KINDS.includes(kind)) {
    return `kind must be one of: ${KITCHEN_BATCH_KINDS.join(', ')}`;
  }
  // Put-Up release 1b: "Other" needs no text (chk_kitchen_batch_kind_other relaxed in place — it still
  // refuses a BLANK name, which normalizeText turns into NULL before it can reach the column).
  if (requirePair && kind !== 'other' && normalizeText(body.kind_other) != null) {
    return "kind_other only applies when kind is 'other'";
  }
  return null;
}

// ── POST /api/kitchen-batches ────────────────────────────────────────────────────────────────────
// `label` is the ONLY required field, and that is the entire point of the capture path: a batch with
// nothing but a label and a photo is a complete, valid record.
export function validateBatchCreate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body required';
  if (normalizeText(body.label) == null) return 'label is required';
  const rejected = KITCHEN_BATCH_SERVER_OWNED_COLUMNS.filter((c) => has(body, c));
  if (rejected.length) return `these fields are set by the server, not the client: ${rejected.join(', ')}`;
  // Put-Up release 1b (V4 API table, row "POST /api/kitchen-batches"): the key lives on the batch row
  // (uq_kitchen_batch_idempotency_key). Release 4 lifts 1b's recipe_id refusal: a batch may name the recipe
  // it follows (the route loads it household-scoped) and F's free-text recipe_ref rides the create too.
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

// ── PUT /api/kitchen-batches/:id ─────────────────────────────────────────────────────────────────
// A MERGE, not the full replace index.js:589-610 performs. Absent keys are left alone; an explicit
// null clears. That distinction is why this cannot be written with COALESCE — see kitchenRoutes.js.
export function validateBatchUpdate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body required';
  const rejected = KITCHEN_BATCH_SERVER_OWNED_COLUMNS.filter((c) => has(body, c));
  if (rejected.length) return `these fields cannot be edited here: ${rejected.join(', ')}`;
  // A heat estimate typed on the merge PUT is 'typed', by definition. 'computed' is written only by
  // POST /:id/shu-estimate/save, which recomputes it server-side (06 §2.1; contract-F §2.1).
  if (has(body, 'shu_est_basis')) {
    if (body.shu_est_basis !== 'typed') return "shu_est_basis can only be 'typed' here — use Work it out to save a computed estimate";
  }
  const unknown = Object.keys(body).filter((k) => k !== 'shu_est_basis' && !KITCHEN_BATCH_EDITABLE_COLUMNS.includes(k));
  if (unknown.length) return `unknown field(s): ${unknown.join(', ')}`;
  if (!Object.keys(body).length) return 'nothing to update';
  // A label may be changed but never emptied — chk_kitchen_batch_label_nonblank, and a batch with no
  // label is unfindable in the one list it appears in.
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

// Split a validated PUT body into "which columns did the request mention" and "what value for each".
// Two parallel objects rather than one sparse object because the values are frequently null and a
// merge must tell an explicit null from an absent key — the exact distinction a `?? null` destroys.
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

// ── POST /api/kitchen-batches/:id/stages ─────────────────────────────────────────────────────────
// No DELETE on a stage row, and that absence IS the design: the off-log repair path is what produced
// the seed-lot divergence this schema refuses to copy. (Release F's in-place edit is kitchenLines.js
// stagePatchError + kitchenRoutes.js patchStage.)
//
// Put-Up release 1b widens what it takes (V4 API table, row "POST /:id/stages"): reopened, paused,
// resumed, noted and void, and entered_precision. There is still no PUT or DELETE — an Undo is a VOID
// row appended beside the row it undoes, which is what keeps the log readable afterwards.
export function validateStage(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body required';
  const kind = normalizeText(body.stage_kind);
  if (kind == null || !KITCHEN_STAGE_ROUTE_KINDS.includes(kind)) {
    return `stage_kind must be one of: ${KITCHEN_STAGE_ROUTE_KINDS.join(', ')}`;
  }
  // "A void row carries nothing else" (V4 Appendix A) — a writer rule, not a CHECK, so it is here.
  if (kind === 'void') {
    const extra = Object.keys(body).filter((k) => k !== 'stage_kind' && k !== 'voids_id');
    if (extra.length) return `an undo carries only the row it undoes (voids_id), not: ${extra.join(', ')}`;
    if (!isUuid(body.voids_id ?? null)) return 'voids_id must be the id of the row to undo';
    return null;
  }
  if (body.voids_id != null) return "voids_id only goes with stage_kind 'void'";
  // Rows written "now, exact" (V4 Appendix A): a note, a pause, a resume, a reopen. Nothing retrospective
  // may be stamped on them, so a date or a precision sent with one is refused rather than ignored.
  if (kind === 'noted' || KITCHEN_STATE_STAGE_KINDS.includes(kind)) {
    if (body.entered_at != null || body.entered_precision != null) {
      return `a '${kind}' row is stamped when it is written — send no entered_at or entered_precision`;
    }
  }
  if (kind === 'noted' && normalizeText(body.note) == null) return "a 'noted' row needs the note";
  // Release F: what he did at a check-in (Dave 16:30) — tended only, from the three words
  // (chk_ksl_acts, chk_ksl_acts_on_tended); the route de-duplicates.
  if (has(body, 'acts') && body.acts != null) {
    if (kind !== 'tended') return 'what you did goes on a check-in';
    if (!Array.isArray(body.acts) || !body.acts.length) return 'acts must be a non-empty list, or absent';
    const unknownActs = body.acts.filter((a) => !KITCHEN_ACTS.includes(a));
    if (unknownActs.length) return `acts must be among: ${KITCHEN_ACTS.join(', ')}`;
  }
  const precErr = enteredPrecisionError(body);
  if (precErr) return precErr;
  // chk_ksl_moved_needs_location. Placement is a RATE input, not a milestone — a 'moved' row with no
  // destination records that something changed while destroying the only thing that changed.
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
// dated precision needs its date. ABSENT precision is the pre-1b writer's shape and stays legal forever
// (the route then stamps entered_at as it always did, with a NULL precision) — "never tightened".
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
// a cook measures at the counter and logs from the sofa, so entered_at ("when did you log this") and
// ph_read_at ("when did you read it") are different facts, and DEFAULTING one from the other would
// stamp a time onto a measurement nobody took then. There is no default anywhere in this path — not
// here, not in the route, not on the column — so the pair is required together or omitted together.
//
// NOTHING BELOW LOOKS AT THE VALUE'S MEANING. It is checked for being a number on the pH scale and
// then passed through untouched, as the STRING the client sent: a Number round-trip drops a trailing
// zero the meter displayed, so the route never coerces it either.
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
  // Checked here rather than left to ::timestamptz, which would surface a typo as a 22007 falling
  // through to an opaque 500 — the same reason KITCHEN_UUID_RE exists a few lines up.
  if (Number.isNaN(new Date(String(readAt)).getTime())) {
    return 'ph_read_at has to be a timestamp';
  }
  return null;
}

// ── POST /api/kitchen-batches/:id/inputs ─────────────────────────────────────────────────────────
// Two forms, one route. The PREDICATE form is required, not a nice-to-have: the measured fan-in for
// one five-week pepper mash is 139 harvest_log rows across 30 plantings, and a 139-row hand-pick is a
// discoverability failure arriving through the schema.
export function validateInputPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body required';
  const hasList = has(body, 'inputs');
  const hasPredicate = has(body, 'predicate');
  if (hasList === hasPredicate) return 'send either inputs or predicate, not both and not neither';
  // `preview` is the dry-run flag and it belongs to the predicate form ONLY. The explicit form is
  // already reviewable — the client built the rows — so a preview there would be an arm with nothing
  // to resolve, and accepting it silently is how a client ends up believing it dry-ran a write that
  // committed. Strict boolean for the same reason is_byproduct is: "true" must not read as true.
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
  // A NULL pair means "unrecorded, assume the whole thing" — the house idiom from
  // chk_harvest_log_weight_pairing. It never means zero.
  if ((qty == null) !== (unit == null)) return 'qty and qty_unit must both be set, or both be empty';
  if (qty != null) {
    if (!Number.isFinite(Number(qty)) || Number(qty) <= 0) return 'qty must be greater than 0';
    if (!KITCHEN_QTY_UNITS.includes(unit)) return `qty_unit must be one of: ${KITCHEN_QTY_UNITS.join(', ')}`;
  }
  return null;
}

// Inclusive day count between two YYYY-MM-DD literals. Date.parse of a date-only ISO string is
// specified as UTC, so both ends land on a UTC midnight and the difference is an exact multiple of
// 86_400_000 — no DST hour to round off, in any zone the runner happens to sit in. Callers must have
// shape-checked both literals first; a non-date reaches NaN here and NaN > cap is false, which is why
// predicateError runs DATE_RE before this and not after.
export function predicateSpanDays(p) {
  const from = Date.parse(`${p.from}T00:00:00Z`);
  const to = Date.parse(`${p.to}T00:00:00Z`);
  return Math.round((to - from) / 86400000) + 1;
}

function predicateError(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'predicate must be an object';
  // Zoneless local calendar days, both required. A window is what makes the bulk add reviewable
  // before it runs; an open-ended one is not a predicate, it is "everything".
  if (!DATE_RE.test(String(p.from ?? ''))) return 'predicate.from must be a YYYY-MM-DD date';
  if (!DATE_RE.test(String(p.to ?? ''))) return 'predicate.to must be a YYYY-MM-DD date';
  if (String(p.to) < String(p.from)) return 'predicate.to must be on or after predicate.from';
  // The span ceiling. The module already refuses an OPEN-ENDED window on the grounds that it "is not
  // a predicate, it is 'everything'" — this applies the same reasoning to a window wide enough to
  // mean the same thing. Both endpoints are ET calendar days, so the count is inclusive: from == to
  // is a span of 1.
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

// Normalized column arrays for the unnest'd bulk INSERT. Harvest ids are DEDUPED here as well as
// guarded by uq_kbi_batch_harvest — the index makes a repeat a no-op either way, but a request that
// names the same pick twice should not report two inserts when one row lands.
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

// ── POST /api/kitchen-batches/:id/close ──────────────────────────────────────────────────────────
// chk_kitchen_batch_close_pairing makes closed_at and outcome inseparable, so outcome is required
// here and is the only thing that is.
//
// `cue_observed` rides on this body and is NOT validated, deliberately. The close is the most
// consequential transition in the feature — "I decided it is done" — and it was the one transition
// that could not record the observation that decided it, while every lesser one could
// (kitchen_stage_log.cue_observed, there since INFLIGHTBATCH). For a dehydrate batch the published
// endpoint IS the cue: NCHFP's own test is "brittle or crisp… shatter if hit with a hammer", not an
// elapsed time. So it is free text, never a picklist, never range-checked, and never read back into
// any decision — that is exactly what keeps it a RECORD and not an assessment.
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

// ── POST /api/kitchen-batches/:id/outputs ────────────────────────────────────────────────────────
// LINKING IS DECOUPLED FROM CLOSING, and that is the ruling this route exists to carry. Before it,
// close was the only writer of preservation_log.batch_id, so a jar could not be linked to a batch
// without ENDING the batch — and the commonest real event in both of Dave's processes is a partial
// draw-off from a batch that keeps going (two quarts of sauce off a mash whose crock continues;
// three trays jarred while a fourth goes back in). The DDL anticipates exactly that — "one mash
// batch legitimately outputs both hot_sauce and ferment_mash jars" — and the only route that could
// record it was terminal. close keeps output_preservation_log_ids for the terminal case.
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

// ── error surfacing ──────────────────────────────────────────────────────────────────────────────
// Every CHECK this schema ships, given words. Returns null for anything not ours, so index.js's
// existing PG-code map keeps its behaviour unchanged for the preservation routes.
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
  // V5-PHRECORD-001. Both messages describe the SHAPE of the record, never the value's meaning.
  chk_ksl_ph_pairing: 'a pH reading needs the time it was read, and a time needs a reading',
  chk_ksl_ph_scale: 'that is not a reading on the pH scale',
  // The two-truths guard on the fan-out. A jar either came from a batch (whose inputs live on the
  // batch) or directly from one harvest — never both.
  // Put-Up release 1b (v5-putupmake-001).
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
