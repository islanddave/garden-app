// Pure rules for "How it was made" (V4 §2.2) and the planting read; no driver, no clock except what a
// caller passes (batchBuilder.test.js runs every rule). batchBuilderRoutes.js owns the statements.
// The from-jars write makes one CLOSED batch with its lines and links; it never touches a jar's own
// where-from (source) fields.
import { KITCHEN_UUID_RE, KITCHEN_BATCH_KINDS, KITCHEN_START_PRECISIONS, normalizeText, isMassUnit } from './kitchenBatch.js';
import { lineError } from './kitchenLines.js';

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const isUuid = (v) => typeof v === 'string' && KITCHEN_UUID_RE.test(v);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export const FROM_JARS_KEYS = [
  'idempotency_key', 'label', 'started', 'kind', 'kind_other', 'inputs', 'jar_ids', 'made_count', 'next_time',
];
export const FROM_JARS_MAX_JARS = 20;
export const FROM_JARS_MAX_LINES = 40;
export const LABEL_MAX = 120;

// A bare day is stored at 16:00Z — that same calendar day in ET all year (putUp.js's rule, kept in step).
export function dayInstant(date) {
  if (date == null) return null;
  if (DAY_RE.test(String(date))) return `${date}T16:00:00.000Z`;
  const t = new Date(date);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

function startedError(started) {
  if (!isObj(started)) return 'started must be { date, precision }';
  const p = normalizeText(started.precision);
  if (!KITCHEN_START_PRECISIONS.includes(p)) return `started.precision must be one of: ${KITCHEN_START_PRECISIONS.join(', ')}`;
  if (p === 'unknown') return started.date == null ? null : "a start that is 'unknown' carries no date";
  if (started.date == null) return 'started.date is required unless the precision is unknown';
  if (dayInstant(started.date) == null) return 'started.date must be a date (YYYY-MM-DD) or a timestamp';
  return null;
}

// POST /api/kitchen-batches/from-jars — the body (V4 §5.1 row "3 · from-jars").
export function validateFromJars(body) {
  if (!isObj(body)) return 'body required';
  const unknown = Object.keys(body).filter((k) => !FROM_JARS_KEYS.includes(k));
  if (unknown.length) return `unknown field(s): ${unknown.join(', ')}`;
  if (!isUuid(body.idempotency_key ?? null)) return 'idempotency_key must be a uuid';
  const label = normalizeText(body.label);
  if (label == null) return 'label is required';
  if (label.length > LABEL_MAX) return `label can be at most ${LABEL_MAX} characters`;
  const se = startedError(body.started);
  if (se) return se;
  if (body.kind != null && !KITCHEN_BATCH_KINDS.includes(normalizeText(body.kind))) {
    return `kind must be one of: ${KITCHEN_BATCH_KINDS.join(', ')}`;
  }
  if (normalizeText(body.kind_other) != null && normalizeText(body.kind) !== 'other') {
    return "kind_other only applies when kind is 'other'";
  }
  const ids = body.jar_ids;
  if (!Array.isArray(ids) || !ids.length) return 'jar_ids must be a non-empty array';
  if (!ids.every(isUuid)) return 'jar_ids must all be uuids';
  if (new Set(ids).size > FROM_JARS_MAX_JARS) return `at most ${FROM_JARS_MAX_JARS} jars at once`;
  const inputs = body.inputs ?? [];
  if (!Array.isArray(inputs)) return 'inputs must be an array';
  if (inputs.length > FROM_JARS_MAX_LINES) return `at most ${FROM_JARS_MAX_LINES} lines at once`;
  for (const [i, l] of inputs.entries()) {
    const where = `line ${i + 1}`;
    // The lines are What went in: never a bottling's own additions (there is no sitting to name).
    if (isObj(l) && (l.put_up_stage_id != null || l.output_id != null)) return `${where}: send no put_up_stage_id or output_id`;
    const e = lineError(l, { keyed: false, where });
    if (e) return e;
    if (l.preservation_log_id != null && ids.includes(l.preservation_log_id)) {
      return `${where}: a jar that came from this batch cannot also have gone into it`;
    }
  }
  const drawn = inputs.map((l) => l.preservation_log_id).filter((v) => v != null);
  if (new Set(drawn).size !== drawn.length) return 'one draw per jar in one request — that jar is named twice';
  const keys = inputs.map((l) => l.idempotency_key).filter((v) => v != null);
  if (keys.includes(body.idempotency_key) || new Set(keys).size !== keys.length) return 'each line needs its own idempotency_key';
  if (body.made_count != null) {
    const n = Number(body.made_count);
    if (!Number.isInteger(n) || n < 1 || String(body.made_count).trim() === '') return 'made_count must be a whole number, 1 or more';
    if (new Set(ids).size !== 1) return 'made_count goes with exactly one jar';
  }
  if (body.next_time != null && typeof body.next_time !== 'string') return 'next_time must be text';
  return null;
}

// The jars' date -> a stage row's (entered_at, entered_precision). On preservation_log 'after'/'unknown'
// keep a date that is only a floor or the day it was logged; on kitchen_stage_log 'unknown' means NO
// date (chk_ksl_entered_pairing) and 'after' is not a stage word. A pre-1b jar (NULL precision) is a
// day, or unknown when marked approximate.
export function jarStageDate(jar) {
  const p = jar?.preserved_at_precision ?? null;
  const day = jar?.preserved_at == null ? null
    : (jar.preserved_at instanceof Date ? jar.preserved_at.toISOString().slice(0, 10) : String(jar.preserved_at).slice(0, 10));
  if (!day || p === 'after' || p === 'unknown' || (p == null && jar.preserved_at_approx === true)) {
    return { entered_at: null, entered_precision: 'unknown' };
  }
  return { entered_at: dayInstant(day), entered_precision: p ?? 'day' };
}

// "Next time…" lines in a batchless jar's (or a pantry item's) notes: any line that says "next time",
// as written, in order, de-duplicated.
export const NEXT_TIME_RE = /\bnext time\b/i;
export function nextTimeLines(notes) {
  if (notes == null) return [];
  const out = [];
  for (const raw of String(notes).split(/\r?\n/)) {
    const line = raw.trim();
    if (line && NEXT_TIME_RE.test(line) && !out.includes(line)) out.push(line);
  }
  return out;
}

// made_count raises package_count, never what is left, so a jar with no stored remaining_count has it
// pinned to its old package_count in the same UPDATE. A weighed jar has no "how many"; a count BELOW
// what was made is the count edit, not this.
export function madeCountError(jar, madeCount) {
  if (madeCount == null) return null;
  if (Number(jar.package_count) === 1 && isMassUnit(jar.quantity_unit)) {
    return { status: 400, code: 'jar_weighed', error: 'That one is weighed — there is no count to raise.' };
  }
  if (Number(madeCount) < Number(jar.package_count)) {
    return { status: 409, code: 'made_count_lower', error: `That jar already says ${jar.package_count} were made — this only raises it.` };
  }
  return null;
}

// The stage rows the write inserts, in order: started, put_up, finished, then one noted row per
// "Next time…" line. ids are the caller's.
//
// tick: created_at is the statement's now() + tick µs. One statement writes every row, so a bare DEFAULT
// now() would give them one created_at and the (entered_at, created_at, id) tiebreak would fall to a
// random uuid (the current stage could read "started"; notes could swap). put_up and finished keep ONE
// instant: kitchenRoutes.js undoPutUp finds "the finished row this sitting wrote" by the put_up created_at.
export function planFromJarsStages({ startedAt, startPrecision, jarDate, notes, newId }) {
  const rows = [
    { id: newId(), kind: 'started', at: startedAt, precision: startPrecision, note: null, tick: 0 },
    { id: newId(), kind: 'put_up', at: jarDate.entered_at, precision: jarDate.entered_precision, note: null, tick: 1 },
    { id: newId(), kind: 'finished', at: jarDate.entered_at, precision: jarDate.entered_precision, note: null, tick: 1 },
  ];
  for (const [i, n] of notes.entries()) rows.push({ id: newId(), kind: 'noted', at: null, precision: 'exact', note: n, tick: 2 + i });
  return rows;
}

// A batch "used" a planting directly (a garden or pick line) or through a drawn jar from it. A
// single-planting batch has every planting-attributed line naming THIS planting; its jars already show
// on the planting's put-up list.
export function usedVia(direct, indirect) {
  if (direct && indirect) return 'both';
  return direct ? 'garden' : indirect ? 'jar' : null;
}

// closeWhenOf: the close sheet's optional When for a make that kept nothing; absent keeps the shipped
// row (now, no precision). Returns { at, precision } | null | { error }.
export function closeWhenOf(body) {
  if (!isObj(body) || body.when == null) return null;
  const e = startedError(body.when);
  if (e) return { error: e.replace(/^started/, 'when').replace(/started\./g, 'when.') };
  const precision = normalizeText(body.when.precision);
  return { at: precision === 'unknown' ? null : dayInstant(body.when.date), precision };
}
