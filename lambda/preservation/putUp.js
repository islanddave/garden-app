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
import { lineError as fLineError, lineColumns } from './kitchenLines.js';
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
export const PUT_UP_MAX_ROWS = 20;
export const PUT_UP_MAX_LINES = 40;

// ── validation ──────────────────────────────────────────────────────────────────────────────────
// Release F: an "added at the end" line is a full F line (06 §3.6, HS-I3) — a pick, a planting, a draw
// ("8 g from the frozen reaper bag") or typed — validated by the same rules as What went in
// (kitchenLines.js), except that its sitting and row are the SERVER's (it names the jars this very
// statement creates), and its key is optional (the sitting's key is the event's).
function lineError(line, where) {
  if (isObj(line) && (line.put_up_stage_id != null || line.output_id != null)) {
    return `${where}: a line added here belongs to this bottling — send no put_up_stage_id or output_id`;
  }
  // Salt steps belong to What went in (the helper); a bottling adds ingredients only.
  if (isObj(line) && ['salt_pct', 'salt_base', 'base_g', 'salt_method', 'base_from'].some((k) => line[k] != null)) {
    return `${where}: salt facts go on a line in What went in, not on a bottling`;
  }
  return fLineError(withKind(line), { keyed: false, where });
}

// A 1b-era body may omit input_kind on a typed line; it means 'other'.
export const withKind = (line) => (isObj(line) && line.input_kind == null ? { ...line, input_kind: 'other' } : line);

// Every line body of a sitting, in the order planPutUp consumes them: sitting lines, then each row's.
export const putUpLineBodies = (body) =>
  [...(body.sitting_lines ?? []), ...body.rows.flatMap((r) => r.added_lines ?? [])].map(withKind);

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
    // Release F: the row's own heat estimate (typed, 06 §2.4) and "Cooked after blending?".
    if (row.shu_est_low != null || row.shu_est_high != null) {
      const lo = row.shu_est_low;
      const hi = row.shu_est_high;
      if (lo == null) return `${where}: a heat estimate needs its low end`;
      if (!Number.isInteger(Number(lo)) || Number(lo) < 0) return `${where}: shu_est_low must be a whole number, 0 or more`;
      if (hi != null && (!Number.isInteger(Number(hi)) || Number(hi) < Number(lo))) return `${where}: shu_est_high must be at least shu_est_low`;
    }
    if (row.cooked != null && typeof row.cooked !== 'boolean') return `${where}: cooked must be true or false`;
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
  if (body.mash_in_g != null && (!Number.isFinite(Number(body.mash_in_g)) || Number(body.mash_in_g) <= 0)) {
    return 'mash_in_g must be greater than 0';
  }
  // One draw per jar per sitting (API-I3), the same rule as What went in.
  const drawn = [...(body.sitting_lines ?? []), ...body.rows.flatMap((r) => r.added_lines ?? [])]
    .map((l) => l?.preservation_log_id).filter((v) => v != null);
  if (new Set(drawn).size !== drawn.length) return 'one draw per jar in one bottling — that jar is named twice';
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
    made_g: body.made_g == null ? null : String(body.made_g),
    mash_in_g: body.mash_in_g == null ? null : String(body.mash_in_g),
    next_time: normalizeJarText(body.next_time),
  };

  const jars = [];
  const lines = [];
  let ordinal = 0;
  // ctx.prepared: the F line rows lineRoutes.prepareLines resolved (ids, labels, plant_id, draws), in
  // body order — sitting lines first, then each row's. Without it (the pure tests) a typed line is
  // planned from its body alone.
  const prepared = ctx.prepared ?? null;
  let k = 0;
  const lineRow = (line, outputId) => ({
    ...(prepared ? prepared[k++] : typedLine(line, ctx.newId)),
    put_up_stage_id: stage.id, output_id: outputId, ordinal: ordinal++,
  });
  for (const line of body.sitting_lines ?? []) lines.push(lineRow(line, null));
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
      shu_est_low: row.shu_est_low == null ? null : Number(row.shu_est_low),
      shu_est_high: row.shu_est_low == null ? null : Number(row.shu_est_high ?? row.shu_est_low),
      shu_est_basis: row.shu_est_low == null ? null : 'typed',
      cooked: row.cooked ?? null,
      // pH at bottling: its time defaults to the jar's own date, never earlier (V4 pH section).
      ph_read_at: ph == null ? null : (ph.read_at ?? (whenIso ?? `${jarDay}T16:00:00.000Z`)),
    });
    for (const line of row.added_lines ?? []) lines.push(lineRow(line, id));
  }
  return {
    stage, jars, lines,
    jar_day: jarDay, jar_precision: jarPrecision, approx,
    // The places the statement must find or create, deduped on the key the 1b UNIQUE uses.
    new_places: dedupePlaces(jars),
  };
}

// A typed line planned from its body alone (the pure tests' path; the route always passes ctx.prepared).
function typedLine(line, newId) {
  return {
    id: newId(), input_kind: line.input_kind ?? 'other', harvest_log_id: null, plant_id: null,
    preservation_log_id: null, crop_type_slug: null, label: normalizeJarText(line.label),
    source_label: normalizeJarText(line.source_label),
    qty: line.qty == null ? null : String(line.qty), qty_unit: normalizeJarText(line.qty_unit),
    form: line.form ?? null, brand: normalizeJarText(line.brand), note: normalizeJarText(line.note),
    shu_rating_low: line.shu_rating_low ?? null, shu_rating_high: line.shu_rating_high ?? line.shu_rating_low ?? null,
    role: line.role ?? null, salt_pct: null, salt_base: null, base_g: null, salt_method: null, base_from: null,
    idempotency_key: line.idempotency_key ?? null, draw_count: null, draw_weighed: false,
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
      'ph_reading', 'ph_read_at', 'shu_est_low', 'shu_est_high', 'shu_est_basis', 'cooked'].map((k) => [k, col(plan.jars, k)])),
    // The F line columns (kitchenLines.js LINE_COLUMNS) — the same arrays the keyed line POST binds.
    line: lineColumns(plan.lines),
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

