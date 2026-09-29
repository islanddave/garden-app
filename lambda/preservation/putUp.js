// Put-Up release 1b — "Put it up" and "Undo that put-up": the request rules and the write PLAN.
//
// V4 "Put it up (the missing link)": one sheet, one atomic keyed write, repeatable ("More to put up
// later") or final ("Put it up and finish"). This module is PURE — no driver, no clock except what the
// caller passes — so every rule below is executed by putUp.test.js. kitchenRoutes.js owns the one
// statement that carries the plan; the plan is shaped as parallel column arrays for that statement's
// unnest()s, so what is decided here is exactly what is bound there.
//
// What the plan decides, per V4:
//   * the sitting's When → the put_up stage row's entered_at + entered_precision; "Not sure" stores no
//     date ('unknown') on the stage row, and each jar stores the resolved EARLIEST date (the batch's
//     latest dated event, passed in by the route) with preserved_at_approx and precision 'after';
//   * per row: count, container, size (quantity_value is the TOTAL contents: count × size — v4-putup-001
//     "package_count = # of containers, distinct from quantity_value = total"), place, name (default: the
//     batch label, which also names an 'Other'), Raw / In oil / texture / pH, discard-by;
//   * discard-by per row: typed (a date, or "none" = his "no date"), else the engine (resolveJarUseBy)
//     from the method, the place's kind, the row's facts and the jar date's precision;
//   * the lines: sitting lines (put_up_stage_id only) and each row's own (output_id = that row's jar);
//   * ids are minted here (the caller's crypto.randomUUID), so a line can name its jar inside the one
//     statement without a round trip; a retry mints new ones and is caught by the stage row's key.
//
// Release F (lane L2b) extends this with draw lines, mash_in_g and the row heat estimate; nothing here
// assumes they are absent beyond refusing a line kind 1b does not write.
import { VALID_METHODS } from './jarRules.js';
import {
  JAR_TEXTURES, JAR_TEXTURE_METHODS, normalizeJarText, normalizeJarUnit, isJarDate,
  jarLabelError, jarQuantityError, jarPhError,
} from './jarRules.js';
import { KITCHEN_QTY_UNITS } from './kitchenBatch.js';
import { resolveJarUseBy } from './shelfLife.js';
import { etDay } from './useBy.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

export const PUT_UP_PLACE_KINDS = ['deep_freezer', 'fridge_freezer', 'fridge', 'pantry', 'cold_storage', 'other'];
// The When chips (V4 Appendix B: Today · Yesterday · Earlier… · Not sure) store one of these on the
// stage row. 'after' is a preservation_log word only; the stage row says 'unknown' for Not sure.
export const PUT_UP_WHEN_PRECISIONS = ['exact', 'hour', 'day', 'week', 'month', 'season', 'year', 'unknown'];
// Dated precisions that are NOT an estimate: the jar's preserved_at_approx is false for these.
const PRECISE = new Set(['exact', 'hour', 'day']);
// The line kinds a 1b put-up writes for a typed "added at the end" line.
export const PUT_UP_LINE_KINDS = ['other', 'purchased'];
export const PUT_UP_MAX_ROWS = 20;
export const PUT_UP_MAX_LINES = 40;

// ── validation ──────────────────────────────────────────────────────────────────────────────────
function lineError(line, where) {
  if (!isObj(line)) return `${where}: each line must be an object`;
  const kind = line.input_kind == null ? 'other' : line.input_kind;
  if (!PUT_UP_LINE_KINDS.includes(kind)) {
    return `${where}: input_kind must be one of: ${PUT_UP_LINE_KINDS.join(', ')}`;
  }
  if (normalizeJarText(line.label) == null) return `${where}: name what went in`;
  const qty = line.qty ?? null;
  const unit = normalizeJarText(line.qty_unit);
  if ((qty == null) !== (unit == null)) return `${where}: qty and qty_unit must both be set, or both be empty`;
  if (qty != null) {
    if (!Number.isFinite(Number(qty)) || Number(qty) <= 0) return `${where}: qty must be greater than 0`;
    if (!KITCHEN_QTY_UNITS.includes(unit)) return `${where}: qty_unit must be one of: ${KITCHEN_QTY_UNITS.join(', ')}`;
  }
  return null;
}

function placeError(place, where) {
  if (place == null) return null;
  if (!isObj(place)) return `${where}: place must be {id} or {kind, label}`;
  if (place.id != null) return isUuid(place.id) ? null : `${where}: place.id must be a uuid`;
  if (!PUT_UP_PLACE_KINDS.includes(place.kind)) return `${where}: place.kind must be one of: ${PUT_UP_PLACE_KINDS.join(', ')}`;
  const label = normalizeJarText(place.label);
  if (label == null) return `${where}: a new place needs a name`;
  if (label.length > 120) return `${where}: a place name can be at most 120 characters`;
  return null;
}

// `when.date` is an ISO timestamp (what the chips compute on the phone) or a YYYY-MM-DD day.
function whenError(when) {
  if (!isObj(when)) return 'when is required: {date, precision}';
  if (!PUT_UP_WHEN_PRECISIONS.includes(when.precision)) {
    return `when.precision must be one of: ${PUT_UP_WHEN_PRECISIONS.join(', ')}`;
  }
  if (when.precision === 'unknown') {
    return when.date == null ? null : "'unknown' means there is no date — send no when.date with it";
  }
  if (when.date == null) return `when.precision '${when.precision}' needs a when.date`;
  const d = String(when.date);
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return isJarDate(d) ? null : 'when.date is not a date';
  return Number.isNaN(new Date(d).getTime()) ? 'when.date is not a date' : null;
}

export function validatePutUp(body) {
  if (!isObj(body)) return 'body required';
  if (!isUuid(body.idempotency_key ?? null)) return 'idempotency_key must be a uuid';
  const wErr = whenError(body.when);
  if (wErr) return wErr;
  if (!body.method || !VALID_METHODS.includes(body.method)) return `method must be one of: ${VALID_METHODS.join(', ')}`;
  if (typeof body.finish !== 'boolean') return 'finish must be true or false';
  if (!Array.isArray(body.rows) || body.rows.length === 0) return 'rows must be a non-empty array';
  if (body.rows.length > PUT_UP_MAX_ROWS) return `at most ${PUT_UP_MAX_ROWS} rows in one sitting`;
  let lineCount = 0;
  for (const [i, row] of body.rows.entries()) {
    const where = `row ${i + 1}`;
    if (!isObj(row)) return `${where}: must be an object`;
    if (!Number.isInteger(Number(row.count)) || Number(row.count) < 1) return `${where}: count must be a whole number, 1 or more`;
    const sizeGiven = row.size_value != null || row.size_unit != null;
    if (sizeGiven) {
      const e = jarQuantityError(row.size_value, row.size_unit);
      if (e) return `${where}: ${e.replace('quantity_value', 'size_value').replace('quantity_unit', 'size_unit')}`;
    }
    const e = placeError(row.place, where)
      ?? (row.name != null ? jarLabelError(row.name, 'name') : null)
      ?? (row.container_label != null ? jarLabelError(row.container_label, 'container_label') : null);
    if (e) return e.startsWith(where) ? e : `${where}: ${e}`;
    for (const k of ['is_raw', 'in_oil']) {
      if (row[k] != null && typeof row[k] !== 'boolean') return `${where}: ${k} must be true or false`;
    }
    if (row.texture != null) {
      if (!JAR_TEXTURES.includes(row.texture)) return `${where}: texture must be one of: ${JAR_TEXTURES.join(', ')}`;
      if (!JAR_TEXTURE_METHODS.includes(body.method)) return `${where}: texture only applies to a dried food`;
    }
    if (row.ph != null) {
      const ph = isObj(row.ph) ? row.ph : { reading: row.ph };
      const pErr = jarPhError(ph.reading ?? null, ph.read_at ?? null, { readAtRequired: false });
      if (pErr) return `${where}: ${pErr}`;
    }
    if (row.discard_by != null && row.discard_by !== 'none' && !isJarDate(row.discard_by)) {
      return `${where}: discard_by must be a YYYY-MM-DD date or "none"`;
    }
    if (row.added_lines != null) {
      if (!Array.isArray(row.added_lines)) return `${where}: added_lines must be an array`;
      for (const [j, l] of row.added_lines.entries()) {
        const le = lineError(l, `${where}, line ${j + 1}`);
        if (le) return le;
      }
      lineCount += row.added_lines.length;
    }
  }
  if (body.sitting_lines != null) {
    if (!Array.isArray(body.sitting_lines)) return 'sitting_lines must be an array';
    for (const [j, l] of body.sitting_lines.entries()) {
      const le = lineError(l, `line ${j + 1}`);
      if (le) return le;
    }
    lineCount += body.sitting_lines.length;
  }
  if (lineCount > PUT_UP_MAX_LINES) return `at most ${PUT_UP_MAX_LINES} added lines in one sitting`;
  if (body.made_g != null && (!Number.isFinite(Number(body.made_g)) || Number(body.made_g) <= 0)) {
    return 'made_g must be greater than 0';
  }
  if (body.next_time != null && typeof body.next_time !== 'string') return 'next_time must be text';
  return null;
}

// Place ids the rows name — the route loads their kinds household-scoped before it plans.
export function putUpPlaceIds(body) {
  return [...new Set(body.rows.map((r) => r.place?.id).filter((v) => v != null))];
}

// ── the plan ────────────────────────────────────────────────────────────────────────────────────
// ctx: { batchLabel, notSureDay (YYYY-MM-DD, required when when.precision is 'unknown'),
//        placeKinds: {id → kind}, newId: () => uuid }
export function planPutUp(body, ctx) {
  const notSure = body.when.precision === 'unknown';
  const whenIso = notSure ? null
    : /^\d{4}-\d{2}-\d{2}$/.test(String(body.when.date))
      // A bare day is stored at 16:00Z, which is that same calendar day in ET all year (noon EDT,
      // 11:00 EST) — never the evening before, which is what midnight UTC would read as on the phone.
      ? `${body.when.date}T16:00:00.000Z`
      : new Date(body.when.date).toISOString();
  const jarDay = notSure ? ctx.notSureDay : (/^\d{4}-\d{2}-\d{2}$/.test(String(body.when.date))
    ? String(body.when.date) : etDay(new Date(body.when.date)));
  const jarPrecision = notSure ? 'after' : body.when.precision;
  const approx = notSure || !PRECISE.has(body.when.precision);

  const stage = {
    id: ctx.newId(),
    entered_at: whenIso,
    entered_precision: body.when.precision,
    made_g: body.made_g == null ? null : Number(body.made_g),
    next_time: normalizeJarText(body.next_time),
  };

  const jars = [];
  const lines = [];
  let ordinal = 0;
  for (const line of body.sitting_lines ?? []) lines.push(lineRow(line, null, ordinal++));
  for (const row of body.rows) {
    const id = ctx.newId();
    const place = row.place ?? null;
    const kind = place == null ? null : (place.id != null ? (ctx.placeKinds[place.id] ?? null) : place.kind);
    const count = Number(row.count);
    const hasSize = row.size_value != null;
    const useBy = row.discard_by === 'none' ? { use_by_target: null, use_by_basis: 'typed' }
      : row.discard_by != null ? { use_by_target: row.discard_by, use_by_basis: 'typed' }
        : resolveJarUseBy({
          method: body.method, kind, isRaw: row.is_raw ?? null, inOil: row.in_oil ?? null,
          texture: row.texture ?? null, precision: jarPrecision,
        }, jarDay);
    const ph = row.ph == null ? null : (isObj(row.ph) ? row.ph : { reading: row.ph });
    jars.push({
      id,
      label: normalizeJarText(row.name) ?? ctx.batchLabel,
      container_label: normalizeJarText(row.container_label),
      // TOTAL contents: 2 × 8 fl oz woozy = 16 fl oz. Rounded to the column's two places.
      quantity_value: hasSize ? Math.round(count * Number(row.size_value) * 100) / 100 : null,
      quantity_unit: hasSize ? normalizeJarUnit(row.size_unit) : null,
      package_count: count,
      place_id: place?.id ?? null,
      place_kind: place?.id != null ? null : (place?.kind ?? null),
      place_label: place?.id != null ? null : normalizeJarText(place?.label),
      use_by_target: useBy.use_by_target,
      use_by_basis: useBy.use_by_basis,
      is_raw: row.is_raw ?? null,
      in_oil: row.in_oil ?? null,
      texture: row.texture ?? null,
      ph_reading: ph == null ? null : String(ph.reading).trim(),
      // pH at bottling: its time defaults to the jar's own date, never earlier (V4 pH section).
      ph_read_at: ph == null ? null : (ph.read_at ?? (whenIso ?? `${jarDay}T16:00:00.000Z`)),
    });
    for (const line of row.added_lines ?? []) lines.push(lineRow(line, id, ordinal++));
  }
  return {
    stage, jars, lines,
    jar_day: jarDay, jar_precision: jarPrecision, approx,
    // The places the statement must find or create, deduped on the key the 1b UNIQUE uses.
    new_places: dedupePlaces(jars),
  };
}

function lineRow(line, outputId, ordinal) {
  return {
    input_kind: line.input_kind ?? 'other',
    label: normalizeJarText(line.label),
    qty: line.qty == null ? null : Number(line.qty),
    qty_unit: normalizeJarText(line.qty_unit),
    note: normalizeJarText(line.note),
    output_id: outputId,
    ordinal,
  };
}

function dedupePlaces(jars) {
  const seen = new Map();
  for (const j of jars) {
    if (j.place_kind == null) continue;
    const key = `${j.place_kind}\u0000${j.place_label.toLowerCase()}`;
    if (!seen.has(key)) seen.set(key, { kind: j.place_kind, label: j.place_label });
  }
  return [...seen.values()];
}

// Column arrays for the statement's unnest()s, in one place so the route cannot bind them out of step.
export function putUpColumns(plan) {
  const col = (rows, k) => rows.map((r) => r[k]);
  return {
    jar: Object.fromEntries(['id', 'label', 'container_label', 'quantity_value', 'quantity_unit', 'package_count',
      'place_id', 'place_kind', 'place_label', 'use_by_target', 'use_by_basis', 'is_raw', 'in_oil', 'texture',
      'ph_reading', 'ph_read_at'].map((k) => [k, col(plan.jars, k)])),
    line: Object.fromEntries(['input_kind', 'label', 'qty', 'qty_unit', 'note', 'output_id', 'ordinal']
      .map((k) => [k, col(plan.lines, k)])),
    place: { kind: col(plan.new_places, 'kind'), label: col(plan.new_places, 'label') },
  };
}

// The refusal Undo gives when a jar of the sitting was already used (V4 "Undo that put-up": refused
// with the reason and a path).
export function putUpInUse(jarIds) {
  const n = jarIds.length;
  return {
    error: `${n === 1 ? '1 jar from this put-up was' : `${n} jars from this put-up were`} already used — change the count first, then undo.`,
    code: 'put_up_in_use',
    jar_ids: jarIds,
  };
}

export const BATCH_CLOSED = {
  error: 'This batch is finished. Reopen it to bottle more →',
  code: 'batch_closed',
  reopen: true,
};

