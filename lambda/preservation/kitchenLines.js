// Release F — the rules for a batch LINE and a stage EDIT (contract-F §2.2, §2.3; 06 §1.4, §3.2, §3.7).
// PURE: shape and cross-field rules only, executed by kitchenLines.test.js. What needs a row (the jar's
// stock mode, whether a pick or a planting is the household's) is lineRoutes.js's, after these pass.
//
// Every rule here mirrors a CHECK in migrations/v5-fermentpath-001 (or 1b's), the belt-and-suspenders
// pattern the rest of kitchenBatch.js uses: a raw 23514 is not something a cook at a counter can act on.
import {
  KITCHEN_UUID_RE, KITCHEN_UNITS, KITCHEN_FORMS, KITCHEN_ROLES, KITCHEN_SALT_BASES, KITCHEN_SALT_METHODS,
  KITCHEN_BASE_FROM, KITCHEN_LINE_KINDS, KITCHEN_ACTS, KITCHEN_ENTERED_PRECISIONS, isMassUnit, normalizeText,
} from './kitchenBatch.js';

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isUuid = (v) => typeof v === 'string' && KITCHEN_UUID_RE.test(v);
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => Number.isInteger(Number(v)) && String(v).trim() !== '';

// The frozen line body (contract-F §2.2). A key outside it is a client bug, never something to ignore.
export const LINE_BODY_KEYS = [
  'input_kind', 'idempotency_key', 'label', 'qty', 'qty_unit', 'form', 'brand', 'note', 'source_label',
  'shu_rating_low', 'shu_rating_high', 'role', 'salt_pct', 'salt_base', 'base_g', 'salt_method', 'base_from',
  'ordinal', 'crop_type_slug', 'plant_id', 'harvest_log_id', 'preservation_log_id', 'count_drawn',
  'put_up_stage_id', 'output_id',
];

// The line PATCH allowlist (06 §3.7; contract-F §2.2). Identity (kind, the pick, the jar, the sitting)
// changes only by taking the line out and adding it again — the trigger backs this up.
export const LINE_PATCH_KEYS = [
  'label', 'qty', 'qty_unit', 'form', 'brand', 'source_label', 'note', 'shu_rating_low', 'shu_rating_high',
  'role', 'salt_pct', 'salt_base', 'base_g', 'salt_method', 'base_from', 'ordinal',
];
export const TAKE_IT_OUT = 'that cannot be changed here — take it out and add it again';

function textError(v, field, max) {
  if (v == null) return null;
  if (typeof v !== 'string') return `${field} must be text`;
  if (v.trim() === '') return `${field} cannot be blank`;
  if (max && v.trim().length > max) return `${field} can be at most ${max} characters`;
  return null;
}

function qtyError(qty, unit) {
  const u = normalizeText(unit);
  if ((qty == null) !== (u == null)) return 'qty and qty_unit must both be set, or both be empty';
  if (qty == null) return null;
  if (!Number.isFinite(Number(qty)) || Number(qty) <= 0) return 'qty must be greater than 0';
  if (!KITCHEN_UNITS.includes(u)) return `qty_unit must be one of: ${KITCHEN_UNITS.join(', ')}`;
  return null;
}

// chk_kbi_shu_rating_range: whole SHU, low >= 0; high needs low and is >= it. The typed rating is the
// FRESH pepper's (Dave 17:1x) — a dried line is counted x7..x10 by the estimator, never stored scaled.
function ratingError(low, high) {
  if (low == null && high == null) return null;
  if (low == null) return 'a heat rating needs its low end';
  if (!isInt(low) || Number(low) < 0) return 'shu_rating_low must be a whole number, 0 or more';
  if (high != null && (!isInt(high) || Number(high) < Number(low))) {
    return 'shu_rating_high must be a whole number at least shu_rating_low';
  }
  return null;
}

// The salt facts on one (effective) line: chk_kbi_salt_facts_* (A1: role IS NOT DISTINCT FROM 'salt'),
// chk_kbi_salt_pct_range, chk_kbi_base_g_positive, chk_kbi_salt_method(_on_salt_line), chk_kbi_base_from
// (_needs_base), and the route rule for a rinsed soak (06 §3.2: base 'water', base_from 'scale').
export function saltFactsError(l) {
  const isSalt = l.role === 'salt';
  const facts = [l.salt_pct, l.salt_base, l.base_g];
  const set = facts.filter((v) => v != null).length;
  if (set && !isSalt) return 'salt facts go only on a salt line';
  if (set && set !== 3) return 'the aimed %, what it is a % of, and that weight go together';
  if (l.salt_pct != null) {
    const p = Number(l.salt_pct);
    if (!Number.isFinite(p) || p <= 0 || p > 100) return 'salt_pct must be more than 0 and at most 100';
    if (l.qty_unit !== 'g') return 'a salt line with an aimed % is weighed in g';
  }
  if (l.salt_base != null && !KITCHEN_SALT_BASES.includes(l.salt_base)) {
    return `salt_base must be one of: ${KITCHEN_SALT_BASES.join(', ')}`;
  }
  if (l.base_g != null && !(Number.isFinite(Number(l.base_g)) && Number(l.base_g) > 0)) return 'base_g must be greater than 0';
  if (l.salt_method != null) {
    if (!isSalt) return 'salt_method goes only on a salt line';
    if (!KITCHEN_SALT_METHODS.includes(l.salt_method)) return `salt_method must be one of: ${KITCHEN_SALT_METHODS.join(', ')}`;
  }
  if (l.base_from != null) {
    if (!KITCHEN_BASE_FROM.includes(l.base_from)) return `base_from must be one of: ${KITCHEN_BASE_FROM.join(', ')}`;
    if (l.base_g == null) return 'base_from needs the base weight (base_g)';
  }
  if (l.salt_method === 'rinsed' && l.salt_pct != null && (l.salt_base !== 'water' || l.base_from !== 'scale')) {
    return 'a rinsed salt line is a % of the soak water, typed as one reading (salt_base water, base_from scale)';
  }
  return null;
}

function roleFormError(l) {
  if (l.role != null && !KITCHEN_ROLES.includes(l.role)) return `role must be one of: ${KITCHEN_ROLES.join(', ')}`;
  if (l.form != null && !KITCHEN_FORMS.includes(l.form)) return `form must be one of: ${KITCHEN_FORMS.join(', ')}`;
  if (l.role != null && l.form != null) return 'salt and water lines have no form';
  if (l.role != null && (l.shu_rating_low != null || l.shu_rating_high != null)) return 'salt and water lines have no heat rating';
  return null;
}

// One line of a keyed POST or a put-up sitting. { keyed } requires the idempotency_key.
export function lineError(line, { keyed = true, where = 'line' } = {}) {
  if (!isObj(line)) return `${where}: each line must be an object`;
  const unknown = Object.keys(line).filter((k) => !LINE_BODY_KEYS.includes(k));
  if (unknown.length) return `${where}: unknown field(s): ${unknown.join(', ')}`;
  const kind = line.input_kind;
  if (!KITCHEN_LINE_KINDS.includes(kind)) return `${where}: input_kind must be one of: ${KITCHEN_LINE_KINDS.join(', ')}`;
  if (keyed && !isUuid(line.idempotency_key ?? null)) return `${where}: idempotency_key must be a uuid`;
  if (!keyed && line.idempotency_key != null && !isUuid(line.idempotency_key)) return `${where}: idempotency_key must be a uuid`;
  for (const k of ['plant_id', 'harvest_log_id', 'preservation_log_id', 'put_up_stage_id', 'output_id']) {
    if (line[k] != null && !isUuid(line[k])) return `${where}: ${k} must be a uuid`;
  }
  if (kind === 'garden' && line.plant_id == null) return `${where}: a garden line names its planting (plant_id)`;
  if ((kind === 'harvest') !== (line.harvest_log_id != null)) {
    return kind === 'harvest' ? `${where}: a pick line names its pick (harvest_log_id)` : `${where}: only a pick line carries harvest_log_id`;
  }
  if ((kind === 'put_up') !== (line.preservation_log_id != null)) {
    return kind === 'put_up' ? `${where}: a draw names its jar (preservation_log_id)` : `${where}: only a draw carries preservation_log_id`;
  }
  if (kind !== 'garden' && kind !== 'harvest' && line.plant_id != null) return `${where}: only a garden or pick line names a planting`;
  if ((kind === 'purchased' || kind === 'other') && normalizeText(line.label) == null) {
    return `${where}: name what went in`;
  }
  if (line.count_drawn != null) {
    if (kind !== 'put_up') return `${where}: count_drawn goes only on a draw`;
    if (!isInt(line.count_drawn) || Number(line.count_drawn) < 1) return `${where}: count_drawn must be a whole number, 1 or more`;
  }
  if (line.role != null && kind !== 'purchased' && kind !== 'other') return `${where}: salt and water are typed lines`;
  if (line.output_id != null && line.put_up_stage_id == null) return `${where}: output_id needs its put_up_stage_id`;
  if (line.ordinal != null && !isInt(line.ordinal)) return `${where}: ordinal must be a whole number`;
  const e = textError(line.label, 'label') ?? textError(line.brand, 'brand', 120)
    ?? textError(line.source_label, 'source_label') ?? textError(line.crop_type_slug, 'crop_type_slug')
    ?? (line.note != null && typeof line.note !== 'string' ? 'note must be text' : null)
    ?? qtyError(line.qty, line.qty_unit) ?? roleFormError(line)
    ?? ratingError(line.shu_rating_low, line.shu_rating_high)
    ?? saltFactsError({ ...line, qty_unit: normalizeText(line.qty_unit) });
  return e ? `${where}: ${e}` : null;
}

// Many lines at once: each valid, and ONE draw per jar per request (API-I3) — the statement aggregates
// per jar anyway (boss F1), but a repeated jar in one POST is a client bug.
export function linesError(lines, { keyed = true } = {}) {
  if (!Array.isArray(lines) || lines.length === 0) return 'inputs must be a non-empty array';
  for (const [i, l] of lines.entries()) {
    const e = lineError(l, { keyed, where: `line ${i + 1}` });
    if (e) return e;
  }
  const jars = lines.map((l) => l.preservation_log_id).filter((v) => v != null);
  if (new Set(jars).size !== jars.length) return 'one draw per jar in one request — that jar is named twice';
  const keys = lines.map((l) => l.idempotency_key).filter((v) => v != null);
  if (new Set(keys).size !== keys.length) return 'each line needs its own idempotency_key';
  return null;
}

// Keyed vs un-keyed (contract-F §2.2): every row keyed = the F form; none = the shipped form; mixed = 400.
export function inputsForm(inputs) {
  if (!Array.isArray(inputs) || !inputs.length) return 'shipped';
  const keyed = inputs.filter((r) => isObj(r) && r.idempotency_key != null).length;
  if (keyed === 0) return 'shipped';
  return keyed === inputs.length ? 'keyed' : 'mixed';
}

// Draw rules (06 §1.4; contract-F §2.2), given the jar. Returns { error?, status?, code?, weighed, count }.
export const jarIsWeighed = (jar) => Number(jar.package_count) === 1 && isMassUnit(jar.quantity_unit);
export function drawPlan(line, jar) {
  if (jar.deleted_at != null) return { status: 409, code: 'jar_removed', error: 'That jar was removed.' };
  if (jar.remaining_count != null && Number(jar.remaining_count) === 0) {
    return { status: 409, code: 'jar_used_up', error: 'That one is marked used up.' };
  }
  if (jar.consumed_at != null) return { status: 409, code: 'jar_used_up', error: 'That one is marked used up.' };
  if (jarIsWeighed(jar)) {
    if (line.count_drawn != null) return { status: 400, error: 'that jar is weighed — say how many g went in, not how many' };
    if (line.qty == null || !isMassUnit(normalizeText(line.qty_unit))) {
      return { status: 400, error: 'that jar is weighed — give the grams (or oz, lb, kg) that went in' };
    }
    return { weighed: true, count: null };
  }
  return { weighed: false, count: line.count_drawn == null ? 1 : Number(line.count_drawn) };
}

// ── line PATCH ────────────────────────────────────────────────────────────────────────────────────
// `stored` is the live line (with the drawn jar's stock mode resolved by the route as `weighed`).
export function linePatchError(body, stored) {
  if (!isObj(body)) return 'body required';
  const unknown = Object.keys(body).filter((k) => !LINE_PATCH_KEYS.includes(k));
  if (unknown.length) return TAKE_IT_OUT;
  if (!Object.keys(body).length) return 'nothing to update';
  if (has(body, 'qty') !== has(body, 'qty_unit')) return 'qty and qty_unit are edited together';
  if (has(body, 'role')) {
    const from = stored.role ?? null;
    const to = body.role ?? null;
    if (from !== to && !((from == null && to === 'water') || (from === 'water' && to == null))) return TAKE_IT_OUT;
  }
  const next = { ...stored };
  for (const k of LINE_PATCH_KEYS) if (has(body, k)) next[k] = body[k];
  next.qty_unit = normalizeText(next.qty_unit);
  if (has(body, 'label') && normalizeText(body.label) == null) {
    if (stored.input_kind !== 'harvest') return 'label cannot be empty';
  }
  if (stored.input_kind === 'put_up' && stored.weighed && has(body, 'qty')) {
    if (body.qty == null || !isMassUnit(next.qty_unit)) return 'a weighed draw stays in g, kg, oz or lb';
  }
  if (next.ordinal != null && !isInt(next.ordinal)) return 'ordinal must be a whole number';
  return textError(body.brand, 'brand', 120) ?? textError(body.source_label, 'source_label')
    ?? (has(body, 'qty') ? qtyError(body.qty, body.qty_unit) : null)
    ?? roleFormError(next) ?? ratingError(next.shu_rating_low, next.shu_rating_high) ?? saltFactsError(next);
}

// ── stages (contract-F §2.3) ──────────────────────────────────────────────────────────────────────
// acts: tended only, de-duplicated, from the three words.
export function actsOf(acts) {
  if (acts == null) return { acts: null };
  if (!Array.isArray(acts) || !acts.length) return { error: 'acts must be a non-empty list, or absent' };
  const bad = acts.filter((a) => !KITCHEN_ACTS.includes(a));
  if (bad.length) return { error: `acts must be among: ${KITCHEN_ACTS.join(', ')}` };
  return { acts: [...new Set(acts)] };
}

// ph_read_at bounds (06 §3.7, FS-I3): refused if later than now + 5 min or before the batch's start
// date (the ET calendar day), so a typo cannot silence fermentStallPrompt.
export const PH_FUTURE_SLACK_MS = 5 * 60 * 1000;
export function phReadAtError(readAt, { nowMs, startDay, etDayOf }) {
  if (readAt == null) return null;
  const t = new Date(String(readAt)).getTime();
  if (Number.isNaN(t)) return 'ph_read_at has to be a timestamp';
  if (t > nowMs + PH_FUTURE_SLACK_MS) return 'that pH reading is dated in the future';
  if (startDay != null && etDayOf(new Date(t)) < startDay) return 'that pH reading is dated before the batch started';
  return null;
}

// What the stage PATCH may set, per kind (06 §3.7; contract-F §2.3). A void row, and a row that has
// been voided, are note-only.
const EVERY = ['note', 'photo_id', 'label'];
export const STAGE_PATCH_KEYS = Object.freeze({
  tended: [...EVERY, 'cue_observed', 'acts', 'ph_reading', 'ph_read_at', 'amount', 'amount_unit', 'entered_at', 'entered_precision'],
  moved: [...EVERY, 'storage_location_id', 'entered_at', 'entered_precision'],
  noted: [...EVERY, 'entered_at', 'entered_precision'],
  put_up: [...EVERY, 'amount', 'mash_in_g'],
  started: [...EVERY, 'amount', 'amount_unit'],
});
export function stagePatchKeys(kind, { voided }) {
  if (kind === 'void' || voided) return ['note'];
  return STAGE_PATCH_KEYS[kind] ?? EVERY;
}

export function stagePatchError(body, stored) {
  if (!isObj(body)) return 'body required';
  if (!Object.keys(body).length) return 'nothing to update';
  const allowed = stagePatchKeys(stored.stage_kind, { voided: stored.voided });
  const refused = Object.keys(body).filter((k) => !allowed.includes(k));
  if (refused.length) return `these cannot be changed on this entry: ${refused.join(', ')}`;
  if (has(body, 'label') && body.label != null && normalizeText(body.label) == null) return 'label cannot be blank';
  for (const k of ['photo_id', 'storage_location_id']) if (body[k] != null && !isUuid(body[k])) return `${k} must be a uuid`;
  if (stored.stage_kind === 'moved' && has(body, 'storage_location_id') && body.storage_location_id == null) {
    return "a 'moved' entry needs somewhere to have moved to";
  }
  if (has(body, 'entered_at') !== has(body, 'entered_precision')) return 'entered_at and entered_precision are edited together';
  if (has(body, 'entered_precision')) {
    const p = normalizeText(body.entered_precision);
    if (p != null && !KITCHEN_ENTERED_PRECISIONS.includes(p)) return `entered_precision must be one of: ${KITCHEN_ENTERED_PRECISIONS.join(', ')}`;
    if ((body.entered_at == null) !== (p === 'unknown')) return "'unknown' means there is no date, and a date needs a precision";
    if (p == null) return 'entered_precision is required with entered_at';
  }
  if (stored.stage_kind === 'put_up' && has(body, 'amount')) {
    if (body.amount != null && !(Number.isFinite(Number(body.amount)) && Number(body.amount) > 0)) return 'Made must be greater than 0';
  } else if (has(body, 'amount') || has(body, 'amount_unit')) {
    if (has(body, 'amount') !== has(body, 'amount_unit')) return 'amount and amount_unit are edited together';
    const e = qtyError(body.amount, body.amount_unit);
    if (e) return e.replace(/qty/g, 'amount');
  }
  if (has(body, 'mash_in_g') && body.mash_in_g != null && !(Number.isFinite(Number(body.mash_in_g)) && Number(body.mash_in_g) > 0)) {
    return 'mash_in_g must be greater than 0';
  }
  if (has(body, 'acts')) {
    const a = actsOf(body.acts);
    if (a.error) return a.error;
  }
  if (has(body, 'ph_read_at') && !has(body, 'ph_reading')) return 'ph_read_at travels with ph_reading';
  if (has(body, 'ph_reading') && body.ph_reading != null) {
    const n = Number(String(body.ph_reading).trim());
    if (String(body.ph_reading).trim() === '' || !Number.isFinite(n)) return 'a pH reading has to be a number';
    if (n < 0 || n > 14) return 'a pH reading has to be on the pH scale — 0 to 14';
    if (body.ph_read_at == null) return 'a pH reading needs the time it was read';
  }
  return null;
}

// The column arrays for a line INSERT's unnest(), in one place so no route binds them out of step.
export const LINE_COLUMNS = [
  'id', 'input_kind', 'harvest_log_id', 'plant_id', 'preservation_log_id', 'crop_type_slug', 'label',
  'source_label', 'qty', 'qty_unit', 'form', 'brand', 'note', 'shu_rating_low', 'shu_rating_high', 'role',
  'salt_pct', 'salt_base', 'base_g', 'salt_method', 'base_from', 'put_up_stage_id', 'output_id', 'ordinal',
  'idempotency_key', 'draw_count', 'draw_weighed',
];
export function lineColumns(rows) {
  return Object.fromEntries(LINE_COLUMNS.map((k) => [k, rows.map((r) => r[k])]));
}

