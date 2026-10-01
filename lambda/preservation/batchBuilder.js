// B′ release 3 (the batch builder) — the PURE rules for "How it was made →" and the planting read.
// No driver, no clock except what a caller passes: every rule here is executed by batchBuilder.test.js.
// batchBuilderRoutes.js owns the statements that carry them.
//
// V4 §2.2 "How it was made →": from a jar row, the Start-a-batch sheet in retrospective posture. One
// write: a CLOSED batch + its lines + links the chosen jars (all or nothing), its started, put_up and
// finished rows (V4 §5.1: dated the jars' date), "How many did you make?" (optional; raises the made
// count, never what is left), the jars' "Next time…" lines copied into the batch. It never touches a
// jar's own where-from (source) fields.
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

// The jars' date → a stage row's (entered_at, entered_precision). One vocabulary (V4 §3.6), two words
// differ by table: on preservation_log 'after' / 'unknown' keep a date that is only a floor or the day
// it was logged; on kitchen_stage_log 'unknown' means NO date (chk_ksl_entered_pairing), and 'after' is
// not a stage word. A pre-1b jar (NULL precision) is a day, or unknown when it was marked approximate.
export function jarStageDate(jar) {
  const p = jar?.preserved_at_precision ?? null;
  const day = jar?.preserved_at == null ? null
    : (jar.preserved_at instanceof Date ? jar.preserved_at.toISOString().slice(0, 10) : String(jar.preserved_at).slice(0, 10));
  if (!day || p === 'after' || p === 'unknown' || (p == null && jar.preserved_at_approx === true)) {
    return { entered_at: null, entered_precision: 'unknown' };
  }
  return { entered_at: dayInstant(day), entered_precision: p ?? 'day' };
}

// "Next time…" lines in a batchless jar's (or a pantry item's) notes: V4 §2.5 appends them as dated
// lines. Any notes line that says "next time" is one; returned as written, in order, de-duplicated.
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

// made_count (V4 §2.2): raises the made count (package_count), never what is left — so a jar with no
// stored remaining_count has it pinned to its old package_count in the same UPDATE. A weighed jar (one
// container logged in a mass unit) has no "how many"; a count BELOW what was made is a lower, which is
// the count edit, not this.
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

// The stage rows the write inserts, in order: started (the sheet's start, mirroring the batch), put_up
// and finished (the jars' date), then one noted row per "Next time…" line (now, exact — a note's own
// time, V4 Appendix A). ids are the caller's.
//
// tick — the row's created_at is the statement's now() + tick µs. ONE statement writes every row, so a
// bare DEFAULT now() gives them all one created_at and every reader's write-order tiebreak (entered_at,
// created_at, id) falls to a random uuid: the view's current stage could read "started" on this closed
// batch whenever the start and the jars share a day (or are both unknown), and two "Next time…" lines
// could swap. put_up and finished keep ONE instant, as Put it up writes them: "the finished row this
// sitting wrote" is the finished row with the put_up row's created_at (kitchenRoutes.js undoPutUp).
export function planFromJarsStages({ startedAt, startPrecision, jarDate, notes, newId }) {
  const rows = [
    { id: newId(), kind: 'started', at: startedAt, precision: startPrecision, note: null, tick: 0 },
    { id: newId(), kind: 'put_up', at: jarDate.entered_at, precision: jarDate.entered_precision, note: null, tick: 1 },
    { id: newId(), kind: 'finished', at: jarDate.entered_at, precision: jarDate.entered_precision, note: null, tick: 1 },
  ];
  for (const [i, n] of notes.entries()) rows.push({ id: newId(), kind: 'noted', at: null, precision: 'exact', note: n, tick: 2 + i });
  return rows;
}

// ── the planting read (V4 §2.5 "Planting page") ──────────────────────────────────────────────────
// A batch "used" the planting directly (a garden or pick line from it) or through a drawn jar from it.
// A single-planting batch is one whose every planting-attributed line names THIS planting and nothing
// else — its jars already show on the planting's put-up list, where it reads "from <batch> →".
export function usedVia(direct, indirect) {
  if (direct && indirect) return 'both';
  return direct ? 'garden' : indirect ? 'jar' : null;
}

// ── "Finished — none kept" (V4 §2.2 "A make with nothing kept") ─────────────────────────────────
// The shipped close already records a make that kept nothing ("Did it make anything you kept? No" →
// Ate it · Gave it away · It spoiled · Gave up on it) and writes its `finished` row in the same statement.
// What it lacked is the close sheet's When (V4 Appendix A: finished — "the close sheet's When"): a make
// logged afterwards was dated the moment it was logged. `when` is optional; absent keeps the shipped row
// (now, no precision). Returns { at, precision } | null | { error }.
export function closeWhenOf(body) {
  if (!isObj(body) || body.when == null) return null;
  const e = startedError(body.when);
  if (e) return { error: e.replace(/^started/, 'when').replace(/started\./g, 'when.') };
  const precision = normalizeText(body.when.precision);
  return { at: precision === 'unknown' ? null : dayInstant(body.when.date), precision };
}
