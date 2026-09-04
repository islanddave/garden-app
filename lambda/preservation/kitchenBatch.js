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
export const KITCHEN_START_PRECISIONS = ['exact', 'hour', 'day', 'week', 'month', 'unknown'];

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

export const KITCHEN_INPUT_KINDS = ['harvest', 'purchased', 'pantry', 'other'];

// chk_kbi_qty_unit. Applied to kitchen_stage_log.amount_unit TOO, where the DB has no CHECK: the DDL
// header records that preservation_log.quantity_unit is the one unit column in this family without one
// and that it has ALREADY drifted ('quarts' beside harvest_log's 'qt', BUG-PRESERVUNITNOCHECK-001).
// An app-layer belt is the only place that drift can be stopped for the stage log without a migration.
export const KITCHEN_QTY_UNITS = [
  'g', 'kg', 'oz', 'lb', 'count', 'cup', 'tbsp', 'tsp', 'fl oz', 'qt', 'gal', 'ml', 'l', 'other',
];

// The PUT allowlist — an EXPLICIT set, not a full replace, and the difference from
// index.js:589-610 is deliberate. Closing goes through its own route, so closed_at/outcome are absent;
// first_recorded_at is the honest floor a client must never be able to move; user_id is ownership.
export const KITCHEN_BATCH_EDITABLE_COLUMNS = [
  'label', 'kind', 'kind_other', 'started_at', 'start_precision', 'start_anchor_kind', 'start_anchor_id',
  'expected_days_min', 'expected_days_max', 'brine_note', 'cover_photo_id', 'notes', 'suspended_at',
];

// The complement, stated rather than implied. A column here reaching the PUT is a defect regardless of
// how it got there, and naming them is what lets a test assert the boundary from both sides.
export const KITCHEN_BATCH_SERVER_OWNED_COLUMNS = [
  'id', 'user_id', 'first_recorded_at', 'closed_at', 'outcome', 'outcome_note',
  'created_at', 'updated_at', 'deleted_at',
];

// Columns whose value is normalized to "meaningful string or null" before it reaches the column.
// btrim() CHECKs exist on label / kind_other, and a whitespace-only brine_note is noise either way.
const KITCHEN_TEXT_COLUMNS = new Set([
  'label', 'kind', 'kind_other', 'start_precision', 'start_anchor_kind', 'brine_note', 'notes',
]);

const KITCHEN_INTEGER_COLUMNS = new Set(['expected_days_min', 'expected_days_max']);

// ORDER KEYS, stated once. `id DESC` on the stage log is NOT decoration: two rows written in one
// statement tie on entered_at AND created_at, which is the nondeterminism seed_lot_stage_log has and
// this table's idx_ksl_batch was built to remove. A "topped up + skimmed" double-tap hits it.
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
  const m = path.match(/^\/api\/kitchen-batches\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?$/);
  if (!m) return null;
  const [, id, sub, tail] = m;
  if (!sub) return { kind: 'batch', id };
  if (sub === 'stages' && !tail) return { kind: 'stages', id };
  if (sub === 'inputs' && !tail) return { kind: 'inputs', id };
  if (sub === 'inputs' && tail) return { kind: 'input', id, inputId: tail };
  if (sub === 'close' && !tail) return { kind: 'close', id };
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
  if (kind === 'other' && normalizeText(body.kind_other) == null) {
    return "kind_other is required when kind is 'other' — name what this is";
  }
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
  return kindError(body, { requirePair: false })
    ?? startPairingError(body, { requirePair: false })
    ?? anchorError(body)
    ?? expectedDaysError(body, { requirePair: false })
    ?? uuidFieldError(body, 'cover_photo_id');
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
  const unknown = Object.keys(body).filter((k) => !KITCHEN_BATCH_EDITABLE_COLUMNS.includes(k));
  if (unknown.length) return `unknown field(s): ${unknown.join(', ')}`;
  if (!Object.keys(body).length) return 'nothing to update';
  // A label may be changed but never emptied — chk_kitchen_batch_label_nonblank, and a batch with no
  // label is unfindable in the one list it appears in.
  if (has(body, 'label') && normalizeText(body.label) == null) return 'label cannot be empty';
  return kindError(body, { requirePair: true })
    ?? startPairingError(body, { requirePair: true })
    ?? anchorError(body)
    ?? expectedDaysError(body, { requirePair: true })
    ?? uuidFieldError(body, 'cover_photo_id');
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
  return { present, value };
}

// ── POST /api/kitchen-batches/:id/stages ─────────────────────────────────────────────────────────
// Append-only. There is no PUT and no DELETE on a stage row and that absence IS the design: the
// off-log repair path is what produced the seed-lot divergence this schema refuses to copy.
export function validateStage(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body required';
  const kind = normalizeText(body.stage_kind);
  if (kind == null || !KITCHEN_STAGE_KINDS.includes(kind)) {
    return `stage_kind must be one of: ${KITCHEN_STAGE_KINDS.join(', ')}`;
  }
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
  return uuidFieldError(body, 'storage_location_id') ?? uuidFieldError(body, 'photo_id');
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

function predicateError(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'predicate must be an object';
  // Zoneless local calendar days, both required. A window is what makes the bulk add reviewable
  // before it runs; an open-ended one is not a predicate, it is "everything".
  if (!DATE_RE.test(String(p.from ?? ''))) return 'predicate.from must be a YYYY-MM-DD date';
  if (!DATE_RE.test(String(p.to ?? ''))) return 'predicate.to must be a YYYY-MM-DD date';
  if (String(p.to) < String(p.from)) return 'predicate.to must be on or after predicate.from';
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
  // The two-truths guard on the fan-out. A jar either came from a batch (whose inputs live on the
  // batch) or directly from one harvest — never both.
  chk_preservation_log_one_provenance:
    'one of those put-ups is already linked to a single harvest — a jar comes from a batch or from one harvest, not both',
};

export function kitchenErrorMessage(err) {
  if (!err || err.code !== '23514') return null;
  return CONSTRAINT_MESSAGES[String(err.constraint ?? '')] ?? null;
}
