// Put-Up release 4 — the rules for a RECIPE, its lines and its type (V4 §2.6, §4.5; F §1.5; recipe types per
// Dave 2026-09-30). PURE: shape and cross-field rules, the route table and the column arrays a write binds.
// Executed by recipeRoutes.test.js. What needs a row (is that type the household's? is that batch?) is
// recipeRoutes.js's, after these pass.
//
// Every rule mirrors a CHECK in migrations/v5-recipes-001/0a-additive-ddl.sql, the belt-and-suspenders the
// kitchen modules use: a raw 23514 is not something a cook at a counter can act on.
//
// ⚠ NO pH HERE, EVER (V4 §3.8). His target pH is text inside `notes`, stored verbatim and rendered only on
// recipe detail. Nothing in this module reads, parses or validates a number out of the notes.
import {
  KITCHEN_UUID_RE, KITCHEN_UNITS, KITCHEN_FORMS, KITCHEN_ROLES, KITCHEN_SALT_METHODS, KITCHEN_BASE_FROM,
  KITCHEN_BATCH_KINDS, KITCHEN_VESSEL_COUNT_MAX, normalizeText,
} from './kitchenBatch.js';
import { RECIPE_KEEPS_UNITS } from './shelfLife.js';

export { RECIPE_KEEPS_UNITS };

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const isUuid = (v) => typeof v === 'string' && KITCHEN_UUID_RE.test(v);
const isInt = (v) => v != null && String(v).trim() !== '' && Number.isInteger(Number(v));

// chk_recipe_keeps_storage_kind = storage_location.kind's vocabulary.
export const RECIPE_STORAGE_KINDS = ['deep_freezer', 'fridge_freezer', 'fridge', 'pantry', 'cold_storage', 'other'];
export const RECIPE_NAME_MAX = 120;
export const RECIPE_NOTES_MAX = 20000;
export const RECIPE_LINK_MAX = 2000;
export const RECIPE_KEEPS_N_MAX = 1000;
export const RECIPE_LINE_NAME_MAX = 200;
export const RECIPE_AMOUNT_TEXT_MAX = 500;
export const RECIPE_MAX_LINES = 60;
export const RECIPE_TYPE_LABEL_MAX = 60;
// chk_ri_salt_base: 'peppers' only because "Save as recipe" copies a 1b-era batch line as it is; no body here
// may write it (the same rule F's line POST keeps).
export const RECIPE_SALT_BASES = ['produce', 'water', 'all'];

// The fifteen built-in types, in Dave's order (2026-09-30), with the fixed ids 0a inserts. A parity test binds
// this list to the migration.
export const RECIPE_BUILTIN_TYPES = Object.freeze([
  ['7ec1be00-0000-4000-8000-000000000001', 'Hot sauce', 10],
  ['7ec1be00-0000-4000-8000-000000000002', 'Chili paste', 20],
  ['7ec1be00-0000-4000-8000-000000000003', 'Salsa & chutney', 30],
  ['7ec1be00-0000-4000-8000-000000000004', 'Chili crisp & oil', 40],
  ['7ec1be00-0000-4000-8000-000000000005', 'Glaze & wing sauce', 50],
  ['7ec1be00-0000-4000-8000-000000000006', 'Pesto', 60],
  ['7ec1be00-0000-4000-8000-000000000007', 'Jam & preserve', 70],
  ['7ec1be00-0000-4000-8000-000000000008', 'Pickle', 80],
  ['7ec1be00-0000-4000-8000-000000000009', 'Canned vegetables', 90],
  ['7ec1be00-0000-4000-8000-000000000010', 'Canned fruit', 100],
  ['7ec1be00-0000-4000-8000-000000000011', 'Fruit leather & snacks', 110],
  ['7ec1be00-0000-4000-8000-000000000012', 'Candy', 120],
  ['7ec1be00-0000-4000-8000-000000000013', 'Spice & powder', 130],
  ['7ec1be00-0000-4000-8000-000000000014', 'Ferment (kraut, kimchi…)', 140],
  ['7ec1be00-0000-4000-8000-000000000015', 'Other', 150],
].map(([id, label, sort_order]) => Object.freeze({ id, label, sort_order })));

// ── routing ──────────────────────────────────────────────────────────────────────────────────────
// The literals (`types`, `from-batch`) are matched BEFORE any :id capture, so neither can be read as a recipe
// id; an :id must be uuid-shaped or the path is not ours.
export function parseRecipeRoute(rawPath) {
  if (typeof rawPath !== 'string') return null;
  const path = rawPath.length > 1 && rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
  if (path === '/api/recipes') return { kind: 'collection' };
  if (path === '/api/recipes/types') return { kind: 'types' };
  let m = path.match(/^\/api\/recipes\/types\/([^/]+)$/);
  if (m) return isUuid(m[1]) ? { kind: 'type', id: m[1] } : { kind: 'bad_id' };
  m = path.match(/^\/api\/recipes\/from-batch\/([^/]+)$/);
  if (m) return isUuid(m[1]) ? { kind: 'from_batch', batchId: m[1] } : { kind: 'bad_id' };
  m = path.match(/^\/api\/recipes\/([^/]+)$/);
  if (m) return isUuid(m[1]) ? { kind: 'recipe', id: m[1] } : { kind: 'bad_id' };
  return null;
}

// ── field rules ──────────────────────────────────────────────────────────────────────────────────
function textError(v, field, max, { allowNull = true } = {}) {
  if (v == null) return allowNull ? null : `${field} is required`;
  if (typeof v !== 'string') return `${field} must be text`;
  if (v.trim() === '') return allowNull ? `${field} cannot be blank — leave it out instead` : `${field} is required`;
  if (v.trim().length > max) return `${field} can be at most ${max} characters`;
  return null;
}

// http/https only (chk_recipe_link_url). A `javascript:` or `data:` link would run when tapped on recipe
// detail; anything with a space or no host is not a link.
export function linkUrlError(v) {
  if (v == null) return null;
  if (typeof v !== 'string' || v.trim() === '') return 'the link cannot be blank — leave it out instead';
  const t = v.trim();
  if (t.length > RECIPE_LINK_MAX) return `the link can be at most ${RECIPE_LINK_MAX} characters`;
  if (!/^https?:\/\/[^\s]+$/i.test(t)) return 'the link has to start with http:// or https://';
  let u;
  try { u = new URL(t); } catch { return 'that link does not look like a web address'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'the link has to start with http:// or https://';
  if (!u.hostname) return 'that link does not look like a web address';
  return null;
}

// The keeps line: {n, unit, storage_kind} — all three or none (null).
export function keepsError(k) {
  if (k == null) return null;
  if (!isObj(k)) return 'keeps must be {n, unit, storage_kind} or null';
  const unknown = Object.keys(k).filter((x) => !['n', 'unit', 'storage_kind'].includes(x));
  if (unknown.length) return `keeps: unknown field(s): ${unknown.join(', ')}`;
  if (!isInt(k.n) || Number(k.n) < 1 || Number(k.n) > RECIPE_KEEPS_N_MAX) {
    return `how long it keeps must be a whole number, 1 to ${RECIPE_KEEPS_N_MAX}`;
  }
  if (!RECIPE_KEEPS_UNITS.includes(k.unit)) return `keeps.unit must be one of: ${RECIPE_KEEPS_UNITS.join(', ')}`;
  if (!RECIPE_STORAGE_KINDS.includes(k.storage_kind)) {
    return `keeps.storage_kind must be one of: ${RECIPE_STORAGE_KINDS.join(', ')}`;
  }
  return null;
}

function positiveNumberError(v, field) {
  if (v == null) return null;
  if (String(v).trim() === '' || !Number.isFinite(Number(v)) || Number(v) <= 0) return `${field} must be greater than 0`;
  return null;
}

function vesselError(body) {
  if (has(body, 'vessel_label')) {
    const e = textError(body.vessel_label, 'the jar size name', 120);
    if (e) return e;
  }
  if (has(body, 'vessel_size') !== has(body, 'vessel_unit')) return 'vessel_size and vessel_unit are sent together';
  if (has(body, 'vessel_size')) {
    const size = body.vessel_size;
    const unit = normalizeText(body.vessel_unit);
    if ((size == null) !== (unit == null)) return 'a jar size needs its unit, and a unit needs its size';
    const e = positiveNumberError(size, 'vessel_size');
    if (e) return e;
    if (unit != null && !KITCHEN_UNITS.includes(unit)) return `vessel_unit must be one of: ${KITCHEN_UNITS.join(', ')}`;
  }
  if (has(body, 'vessel_count') && body.vessel_count != null) {
    if (!isInt(body.vessel_count) || Number(body.vessel_count) < 1 || Number(body.vessel_count) > KITCHEN_VESSEL_COUNT_MAX) {
      return `vessel_count must be 1 to ${KITCHEN_VESSEL_COUNT_MAX}`;
    }
  }
  if (has(body, 'no_salt') && body.no_salt != null && typeof body.no_salt !== 'boolean') return 'no_salt must be true or false';
  return positiveNumberError(body.mash_in_g, 'mash_in_g') ?? positiveNumberError(body.made_g, 'made_g');
}

// ── lines ────────────────────────────────────────────────────────────────────────────────────────
export const RECIPE_LINE_KEYS = [
  'ordinal', 'name', 'amount_text', 'qty', 'qty_unit', 'at_the_end', 'form', 'brand', 'role', 'note',
  'shu_rating_low', 'shu_rating_high', 'salt_pct', 'salt_base', 'base_g', 'salt_method', 'base_from',
];

export function recipeLineError(line, where = 'line') {
  if (!isObj(line)) return `${where}: each line must be an object`;
  const unknown = Object.keys(line).filter((k) => !RECIPE_LINE_KEYS.includes(k));
  if (unknown.length) return `${where}: unknown field(s): ${unknown.join(', ')}`;
  const e = textError(line.name, 'the name', RECIPE_LINE_NAME_MAX, { allowNull: false })
    ?? textError(line.amount_text, 'the amount', RECIPE_AMOUNT_TEXT_MAX)
    ?? textError(line.brand, 'the brand', 120)
    ?? (line.note != null && typeof line.note !== 'string' ? 'the note must be text' : null);
  if (e) return `${where}: ${e}`;
  if (line.ordinal != null && (!isInt(line.ordinal) || Number(line.ordinal) < 0)) return `${where}: ordinal must be a whole number`;
  if (line.at_the_end != null && typeof line.at_the_end !== 'boolean') return `${where}: at_the_end must be true or false`;
  const unit = normalizeText(line.qty_unit);
  if ((line.qty == null) !== (unit == null)) return `${where}: qty and qty_unit must both be set, or both be empty`;
  if (line.qty != null) {
    const qe = positiveNumberError(line.qty, 'qty');
    if (qe) return `${where}: ${qe}`;
    if (!KITCHEN_UNITS.includes(unit)) return `${where}: qty_unit must be one of: ${KITCHEN_UNITS.join(', ')}`;
  }
  if (line.form != null && !KITCHEN_FORMS.includes(line.form)) return `${where}: form must be one of: ${KITCHEN_FORMS.join(', ')}`;
  if (line.role != null && !KITCHEN_ROLES.includes(line.role)) return `${where}: role must be one of: ${KITCHEN_ROLES.join(', ')}`;
  if (line.role != null && line.form != null) return `${where}: salt and water lines have no form`;
  const lo = line.shu_rating_low;
  const hi = line.shu_rating_high;
  if (lo != null || hi != null) {
    if (line.role != null) return `${where}: salt and water lines have no heat rating`;
    if (lo == null) return `${where}: a heat rating needs its low end`;
    if (!isInt(lo) || Number(lo) < 0) return `${where}: shu_rating_low must be a whole number, 0 or more`;
    if (hi != null && (!isInt(hi) || Number(hi) < Number(lo))) return `${where}: shu_rating_high must be a whole number at least shu_rating_low`;
  }
  // The salt facts (chk_ri_salt_*), as F's saltFactsError states them for a batch line.
  const facts = [line.salt_pct, line.salt_base, line.base_g].filter((v) => v != null).length;
  if (facts && line.role !== 'salt') return `${where}: salt facts go only on a salt line`;
  if (facts && facts !== 3) return `${where}: the aimed %, what it is a % of, and that weight go together`;
  if (line.salt_pct != null) {
    const p = Number(line.salt_pct);
    if (!Number.isFinite(p) || p <= 0 || p > 100) return `${where}: salt_pct must be more than 0 and at most 100`;
    if (unit !== 'g') return `${where}: a salt line with an aimed % is weighed in g`;
  }
  if (line.salt_base != null && !RECIPE_SALT_BASES.includes(line.salt_base)) {
    return `${where}: salt_base must be one of: ${RECIPE_SALT_BASES.join(', ')}`;
  }
  if (line.base_g != null) {
    const be = positiveNumberError(line.base_g, 'base_g');
    if (be) return `${where}: ${be}`;
  }
  if (line.salt_method != null) {
    if (line.role !== 'salt') return `${where}: salt_method goes only on a salt line`;
    if (!KITCHEN_SALT_METHODS.includes(line.salt_method)) return `${where}: salt_method must be one of: ${KITCHEN_SALT_METHODS.join(', ')}`;
  }
  if (line.base_from != null) {
    if (!KITCHEN_BASE_FROM.includes(line.base_from)) return `${where}: base_from must be one of: ${KITCHEN_BASE_FROM.join(', ')}`;
    if (line.base_g == null) return `${where}: base_from needs the base weight (base_g)`;
  }
  return null;
}

export function recipeLinesError(lines) {
  if (!Array.isArray(lines)) return 'lines must be a list';
  if (lines.length > RECIPE_MAX_LINES) return `at most ${RECIPE_MAX_LINES} lines on one recipe`;
  for (const [i, l] of lines.entries()) {
    const e = recipeLineError(l, `line ${i + 1}`);
    if (e) return e;
  }
  return null;
}

// The column arrays for a line INSERT's unnest(), in one place so no statement binds them out of step.
// Ordinals are 1..n in body order unless the body states them. Numeric values stay the STRING sent (a Number
// round-trip drops a trailing zero); the amount as written is kept exactly as written, trimmed.
export const RECIPE_LINE_COLUMNS = [
  'ordinal', 'name', 'amount_text', 'qty', 'qty_unit', 'at_the_end', 'form', 'brand', 'role', 'note',
  'shu_rating_low', 'shu_rating_high', 'salt_pct', 'salt_base', 'base_g', 'salt_method', 'base_from',
];
const str = (v) => (v == null ? null : String(v).trim());
export function recipeLineRows(lines) {
  return (lines ?? []).map((l, i) => ({
    ordinal: l.ordinal != null ? Number(l.ordinal) : i + 1,
    name: l.name.trim(),
    amount_text: normalizeText(l.amount_text),
    qty: str(l.qty),
    qty_unit: normalizeText(l.qty_unit),
    at_the_end: l.at_the_end === true,
    form: l.form ?? null,
    brand: normalizeText(l.brand),
    role: l.role ?? null,
    note: normalizeText(l.note),
    shu_rating_low: l.shu_rating_low == null ? null : Number(l.shu_rating_low),
    shu_rating_high: l.shu_rating_low == null ? null : Number(l.shu_rating_high ?? l.shu_rating_low),
    salt_pct: str(l.salt_pct),
    salt_base: l.salt_base ?? null,
    base_g: str(l.base_g),
    salt_method: l.salt_method ?? null,
    base_from: l.base_from ?? null,
  }));
}
export function recipeLineColumns(lines) {
  const rows = recipeLineRows(lines);
  return Object.fromEntries(RECIPE_LINE_COLUMNS.map((k) => [k, rows.map((r) => r[k])]));
}

// ── the recipe body ──────────────────────────────────────────────────────────────────────────────
// The columns a body may set (never user_id, idempotency_key after create, created_at, updated_at, deleted_at).
export const RECIPE_BODY_KEYS = [
  'name', 'kind', 'recipe_type_id', 'link_url', 'notes', 'keeps', 'vessel_label', 'vessel_size', 'vessel_unit',
  'vessel_count', 'no_salt', 'mash_in_g', 'made_g', 'lines',
];
export const RECIPE_SERVER_OWNED = ['id', 'user_id', 'created_at', 'updated_at', 'deleted_at'];

function fieldsError(body) {
  if (has(body, 'kind') && body.kind != null && !KITCHEN_BATCH_KINDS.includes(body.kind)) {
    return `kind must be one of: ${KITCHEN_BATCH_KINDS.join(', ')}`;
  }
  if (has(body, 'recipe_type_id') && body.recipe_type_id != null && !isUuid(body.recipe_type_id)) {
    return 'recipe_type_id must be a uuid';
  }
  return linkUrlError(body.link_url)
    ?? textError(body.notes, 'the notes', RECIPE_NOTES_MAX)
    ?? keepsError(body.keeps)
    ?? vesselError(body)
    ?? (has(body, 'lines') ? recipeLinesError(body.lines ?? []) : null);
}

export function validateRecipeCreate(body) {
  if (!isObj(body)) return 'body required';
  const owned = RECIPE_SERVER_OWNED.filter((k) => has(body, k));
  if (owned.length) return `these fields are set by the server, not the client: ${owned.join(', ')}`;
  const unknown = Object.keys(body).filter((k) => k !== 'idempotency_key' && !RECIPE_BODY_KEYS.includes(k));
  if (unknown.length) return `unknown field(s): ${unknown.join(', ')}`;
  if (!isUuid(body.idempotency_key ?? null)) return 'idempotency_key must be a uuid';
  return textError(body.name, 'a name', RECIPE_NAME_MAX, { allowNull: false }) ?? fieldsError(body);
}

// PATCH: presence-sentinel. Absent = unchanged; an explicit null clears (never the name); `lines` present
// replaces the whole set; `keeps: null` clears the keeps line.
export function validateRecipePatch(body) {
  if (!isObj(body)) return 'body required';
  const owned = [...RECIPE_SERVER_OWNED, 'idempotency_key'].filter((k) => has(body, k));
  if (owned.length) return `these fields cannot be edited: ${owned.join(', ')}`;
  const unknown = Object.keys(body).filter((k) => !RECIPE_BODY_KEYS.includes(k));
  if (unknown.length) return `unknown field(s): ${unknown.join(', ')}`;
  if (!Object.keys(body).length) return 'nothing to update';
  if (has(body, 'name')) {
    const e = textError(body.name, 'a name', RECIPE_NAME_MAX, { allowNull: false });
    if (e) return e === 'a name is required' ? 'the name cannot be empty' : e;
  }
  if (has(body, 'lines') && body.lines === null) return 'lines must be a list (send [] to clear them)';
  return fieldsError(body);
}

// Parallel "is it present" / "its value" objects for the PATCH's CASE arms: absent vs explicit null is the
// distinction a `?? null` destroys. keeps is one presence flag over its three columns.
export function recipePatchPlan(body) {
  const p = (k) => has(body, k);
  const keeps = body.keeps ?? null;
  return {
    present: {
      name: p('name'), kind: p('kind'), recipe_type_id: p('recipe_type_id'), link_url: p('link_url'),
      notes: p('notes'), keeps: p('keeps'), vessel_label: p('vessel_label'), vessel_size: p('vessel_size'),
      vessel_count: p('vessel_count'), no_salt: p('no_salt'), mash_in_g: p('mash_in_g'), made_g: p('made_g'),
      lines: p('lines'),
    },
    value: {
      name: p('name') ? body.name.trim() : null,
      kind: body.kind ?? null,
      recipe_type_id: body.recipe_type_id ?? null,
      link_url: normalizeText(body.link_url),
      notes: body.notes == null ? null : String(body.notes),
      keeps_n: keeps ? Number(keeps.n) : null,
      keeps_unit: keeps ? keeps.unit : null,
      keeps_storage_kind: keeps ? keeps.storage_kind : null,
      vessel_label: normalizeText(body.vessel_label),
      vessel_size: body.vessel_size == null ? null : String(body.vessel_size),
      vessel_unit: normalizeText(body.vessel_unit),
      vessel_count: body.vessel_count == null ? null : Number(body.vessel_count),
      no_salt: body.no_salt === true ? true : null,
      mash_in_g: body.mash_in_g == null ? null : String(body.mash_in_g),
      made_g: body.made_g == null ? null : String(body.made_g),
    },
    lines: recipeLineColumns(body.lines ?? []),
  };
}

// The values a create binds (the same shape as the PATCH plan's `value`).
export function recipeCreateValues(body) {
  return recipePatchPlan(Object.fromEntries(RECIPE_BODY_KEYS.filter((k) => has(body, k)).map((k) => [k, body[k]])));
}

// Notes are stored VERBATIM (his text, including his own target pH): no trim of inner whitespace, no
// rewrite. Only a wholly blank value is refused (chk_recipe_notes_nonblank); leading/trailing space is kept.

// ── "Save as recipe" (POST /api/recipes/from-batch/:batchId) ─────────────────────────────────────
export function validateFromBatch(body) {
  if (!isObj(body)) return 'body required';
  const unknown = Object.keys(body).filter((k) => !['idempotency_key', 'name', 'recipe_type_id'].includes(k));
  if (unknown.length) return `unknown field(s): ${unknown.join(', ')}`;
  if (!isUuid(body.idempotency_key ?? null)) return 'idempotency_key must be a uuid';
  if (body.recipe_type_id != null && !isUuid(body.recipe_type_id)) return 'recipe_type_id must be a uuid';
  return textError(body.name, 'the name', RECIPE_NAME_MAX);
}

// ── types ────────────────────────────────────────────────────────────────────────────────────────
export function validateTypeCreate(body) {
  if (!isObj(body)) return 'body required';
  const unknown = Object.keys(body).filter((k) => k !== 'label');
  if (unknown.length) return `unknown field(s): ${unknown.join(', ')}`;
  return textError(body.label, 'a name for the type', RECIPE_TYPE_LABEL_MAX, { allowNull: false });
}
// The key find-or-create matches on: lower(btrim(label)) — the same fold the UNIQUE indexes use. Inner
// spacing is collapsed for the STORED label (so "Hot  sauce" is stored "Hot sauce"), never case.
export const typeLabelOf = (label) => String(label).trim().replace(/\s+/g, ' ');
