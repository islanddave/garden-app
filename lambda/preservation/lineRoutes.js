// Release F — a batch's LINES: the keyed add (with draws), the line PATCH, take-out, restore, and the
// one read projection every route returns (contract-F §2.1 / §2.2; 06 §1.3-§1.4, §3.11).
//
// Importable for the same reason kitchenRoutes.js is (index.js cannot be imported by vitest); takes
// `sql` as an argument and imports only dependency-free siblings. kitchenRoutes.js dispatches here.
//
// STOCK, IN ONE PLACE PER STATEMENT (06 §1.4, boss conditions F1-F2):
//   * A jar's stock mode is decided at draw time: WEIGHED when package_count = 1 and it was logged in a
//     mass unit, else COUNTED. A counted draw writes a pantry_use (count, fate 'batch', the line) and
//     moves remaining_count; a weighed draw writes NO pantry_use and moves remaining_amount (grams).
//     So "was this line a weighed draw" is read back as "a put_up line with no pantry_use at all".
//   * No guard predicate on a draw's UPDATE: chk_preservation_log_remaining_count / _remaining_amount
//     (>= 0) abort the WHOLE statement, so a line never lands without its draw. Both 23514s map to 409
//     only_n_left / only_g_left by constraint name.
//   * F1: every statement moves each jar ONCE — the movements are aggregated `GROUP BY
//     x.preservation_log_id` first, then one UPDATE per jar. Postgres applies only one of several updates
//     one statement makes to the same row, so an un-aggregated join silently loses all but one.
//   * F2: a weighed draw that reaches 0 g also sets remaining_count 0, consumed_at and delta_at. Giving
//     grams back un-consumes the bag ONLY when it was at 0 g before and no use-route tap (a pantry_use
//     with no line) exists for it — a bag Dave marked used up stays used up.
//   * delta_at is stamped by every UPDATE here that moves remaining_count (06 §1.3 item 5); a weighed
//     draw that does not touch the count does not stamp it (DS-B1).
//   * Grams are computed IN SQL from one bound copy of MASS_G, never in JS: a JS float bound into a
//     numeric column drifts, and a reversal must add back exactly what the draw took.
// AUDIT: kitchen_batch_input (F) and preservation_log (1b) carry statement-level audit triggers, so
// every write here runs in sql.transaction([set_config('app.actor_clerk_sub', <sub>, true), write]).
import { randomUUID } from 'node:crypto';
import { MASS_G, KITCHEN_UUID_RE, normalizeText } from './kitchenBatch.js';
import {
  linesError, inputsForm, drawPlan, jarIsWeighed, linePatchError, LINE_PATCH_KEYS, lineColumns,
} from './kitchenLines.js';

export { LINE_COLUMNS, lineColumns } from './kitchenLines.js';

export const MASS_UNITS = Object.keys(MASS_G);
export const MASS_FACTORS = Object.values(MASS_G);

const notFound = { status: 404, body: { error: 'Not found', code: 'not_found' } };
const bad = (error) => ({ status: 400, body: { error } });
const refuse = (status, code, error, extra = {}) => ({ status, body: { error, code, ...extra } });
const keyConflict = refuse(409, 'key_conflict', 'That key is already in use.');
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// ── the read projection (contract-F §2.1) ─────────────────────────────────────────────────────────
// Every §1.2 column except idempotency_key, plus from_garden and count_drawn. The `_`-prefixed columns
// feed the heat estimate and are stripped by publicLine before anything leaves the Lambda.
export async function readLines(sql, batchId, { ids = null, includeDeleted = false } = {}) {
  return sql`
    SELECT i.id, i.batch_id, i.input_kind, i.harvest_log_id, i.label, i.qty, i.qty_unit, i.is_byproduct,
           i.added_at, i.note, i.created_by, i.created_at,
           i.plant_id, i.preservation_log_id, i.crop_type_slug, i.source_label, i.role, i.salt_pct,
           i.salt_base, i.base_g, i.put_up_stage_id, i.output_id, i.ordinal, i.deleted_at,
           i.brand, i.form, i.shu_rating_low, i.shu_rating_high, i.salt_method, i.base_from, i.edited_at,
           (i.input_kind IN ('garden', 'harvest')
             OR (i.input_kind = 'put_up'
                 AND (jar.source_kind = 'own_garden'
                      OR EXISTS (SELECT 1 FROM preservation_source ps
                                  WHERE ps.preservation_log_id = jar.id
                                    AND ps.source_kind = 'own_garden'
                                    AND ps.deleted_at IS NULL)))) AS from_garden,
           (SELECT u.count_used FROM pantry_use u
             WHERE u.kitchen_batch_input_id = i.id AND u.count_used > 0
               AND NOT EXISTS (SELECT 1 FROM pantry_use r WHERE r.reverses_use_id = u.id)
             ORDER BY u.created_at DESC, u.id DESC LIMIT 1) AS count_drawn,
           cv.scoville_min AS _rating_low, cv.scoville_max AS _rating_high,
           COALESCE(i.crop_type_slug, cv.crop_type_slug, jar.crop_type_slug) AS _crop,
           jar.quantity_value AS _jar_quantity_value, jar.quantity_unit AS _jar_quantity_unit,
           jar.package_count AS _jar_package_count
    FROM kitchen_batch_input i
    LEFT JOIN preservation_log jar ON jar.id = i.preservation_log_id
    LEFT JOIN garden_node gn ON gn.id = i.plant_id
    LEFT JOIN cultivar cv ON cv.id = COALESCE(gn.cultivar_id, jar.variety_id) AND cv.deleted_at IS NULL
    WHERE i.batch_id = ${batchId}::uuid
      AND (${includeDeleted}::boolean OR i.deleted_at IS NULL)
      AND (${ids}::uuid[] IS NULL OR i.id = ANY(${ids}::uuid[]))
    ORDER BY i.ordinal NULLS FIRST, i.added_at, i.id
  `;
}

export function publicLine(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) if (!k.startsWith('_')) out[k] = v;
  return out;
}

// A line as shuEstimate.js reads it.
export function shuLine(row) {
  return {
    id: row.id, label: row.label, qty: row.qty, qty_unit: row.qty_unit, form: row.form, role: row.role,
    put_up_stage_id: row.put_up_stage_id, output_id: row.output_id, input_kind: row.input_kind,
    shu_rating_low: row.shu_rating_low, shu_rating_high: row.shu_rating_high,
    crop_type_slug: row._crop ?? null,
    variety_rating: row._rating_low != null ? { low: row._rating_low, high: row._rating_high } : null,
    draw: row.count_drawn != null ? {
      count_drawn: row.count_drawn, jar_quantity_value: row._jar_quantity_value,
      jar_quantity_unit: row._jar_quantity_unit, jar_package_count: row._jar_package_count,
    } : null,
  };
}

// ── the household loaders a line needs (V4 §5.3: every body-settable FK has one) ──────────────────
// Contract, same as household.js: a row on success, nothing on ANY failure, so the caller answers a
// foreign id with the same 400 as a malformed one (no existence oracle). A jar comes back even when
// soft-deleted — "That jar was removed" is a household fact, never a foreign one.
const uuids = (xs) => [...new Set(xs.filter((v) => v != null))].filter((v) => KITCHEN_UUID_RE.test(String(v)));

export async function loadPlantings(sql, ids, householdIds) {
  if (!ids.length) return [];
  return sql`
    SELECT gn.id, gn.display_name, cv.crop_type_slug
    FROM garden_node gn
    LEFT JOIN container pp ON pp.id = gn.container_id
    LEFT JOIN cultivar cv ON cv.id = gn.cultivar_id AND cv.deleted_at IS NULL
    WHERE gn.id = ANY(${ids}::uuid[])
      AND gn.deleted_at IS NULL
      AND ( pp.created_by = ANY(${householdIds})
            OR (gn.container_id IS NULL AND gn.created_by = ANY(${householdIds})) )
  `;
}

export async function loadPicks(sql, ids, householdIds) {
  if (!ids.length) return [];
  return sql`
    SELECT h.id, e.plant_id, gn.display_name
    FROM harvest_log h
    JOIN event_log e ON e.id = h.event_id
    LEFT JOIN garden_node gn ON gn.id = e.plant_id
    WHERE h.id = ANY(${ids}::uuid[])
      AND h.created_by = ANY(${householdIds})
      AND h.deleted_at IS NULL
  `;
}

export async function loadJars(sql, ids, householdIds) {
  if (!ids.length) return [];
  return sql`
    SELECT p.id, p.deleted_at, p.package_count, p.remaining_count, p.consumed_at, p.remaining_amount,
           p.quantity_value, p.quantity_unit, p.label, p.method, p.crop_type_slug
    FROM preservation_log p
    WHERE p.id = ANY(${ids}::uuid[])
      AND p.user_id = ANY(${householdIds})
  `;
}

// Live put_up rows of THIS batch (not voided), with their live jars.
async function loadSittings(sql, batchId, ids) {
  if (!ids.length) return [];
  return sql`
    SELECT s.id,
           (SELECT array_agg(j.id) FROM preservation_log j
             WHERE j.put_up_stage_id = s.id AND j.deleted_at IS NULL) AS jar_ids
    FROM kitchen_stage_log s
    WHERE s.id = ANY(${ids}::uuid[])
      AND s.batch_id = ${batchId}::uuid
      AND s.stage_kind = 'put_up'
      AND NOT EXISTS (SELECT 1 FROM kitchen_stage_log v WHERE v.voids_id = s.id)
  `;
}

// Resolve every FK a set of line bodies names, household-scoped, and turn each body into the row the
// INSERT writes (ids minted here, labels stamped from the hit, plant_id copied from a pick, the draw's
// stock mode decided from its jar). Returns { rows } or { refusal: {status, body} }.
// opts.sittingFixed: put-up lines, whose sitting/row the SERVER sets (a body may not name them).
export async function prepareLines(sql, batchId, bodies, householdIds, opts = {}) {
  const plantings = await loadPlantings(sql, uuids(bodies.filter((l) => l.input_kind === 'garden').map((l) => l.plant_id)), householdIds);
  const picks = await loadPicks(sql, uuids(bodies.map((l) => l.harvest_log_id)), householdIds);
  const jars = await loadJars(sql, uuids(bodies.map((l) => l.preservation_log_id)), householdIds);
  const sittingIds = uuids(bodies.map((l) => l.put_up_stage_id));
  const sittings = opts.sittingFixed ? [] : await loadSittings(sql, batchId, sittingIds);
  const byId = (rows) => new Map(rows.map((r) => [r.id, r]));
  const P = byId(plantings);
  const H = byId(picks);
  const J = byId(jars);
  const S = byId(sittings);
  const rows = [];
  for (const [i, l] of bodies.entries()) {
    const where = `line ${i + 1}`;
    let label = normalizeText(l.label);
    let plantId = null;
    if (l.input_kind === 'garden') {
      const p = P.get(l.plant_id);
      if (!p) return { refusal: bad(`${where}: that planting does not match a planting you can use`) };
      plantId = p.id;
      label = label ?? p.display_name;
    }
    if (l.input_kind === 'harvest') {
      const h = H.get(l.harvest_log_id);
      if (!h) return { refusal: bad(`${where}: that pick does not match a harvest you can use`) };
      plantId = h.plant_id ?? null;
      label = label ?? h.display_name ?? 'Pick';
    }
    let draw = { count: null, weighed: false };
    if (l.input_kind === 'put_up') {
      const j = J.get(l.preservation_log_id);
      if (!j) return { refusal: bad(`${where}: that jar does not match a put-up you can use`) };
      const plan = drawPlan(l, j);
      if (plan.error) return { refusal: plan.status === 400 ? bad(`${where}: ${plan.error}`) : refuse(plan.status, plan.code, plan.error) };
      draw = plan;
      label = label ?? j.label ?? j.crop_type_slug ?? 'Put-up';
    }
    if (!opts.sittingFixed && l.put_up_stage_id != null) {
      const s = S.get(l.put_up_stage_id);
      if (!s) return { refusal: bad(`${where}: that is not a bottling of this batch`) };
      if (l.output_id != null && !(s.jar_ids ?? []).includes(l.output_id)) {
        return { refusal: bad(`${where}: that jar is not one this bottling made`) };
      }
    }
    rows.push({
      id: randomUUID(),
      input_kind: l.input_kind,
      harvest_log_id: l.harvest_log_id ?? null,
      plant_id: plantId,
      preservation_log_id: l.preservation_log_id ?? null,
      crop_type_slug: normalizeText(l.crop_type_slug) ?? P.get(l.plant_id)?.crop_type_slug ?? null,
      label,
      source_label: normalizeText(l.source_label),
      qty: l.qty == null ? null : String(l.qty),
      qty_unit: normalizeText(l.qty_unit),
      form: l.form ?? null,
      brand: normalizeText(l.brand),
      note: normalizeText(l.note),
      shu_rating_low: l.shu_rating_low == null ? null : Number(l.shu_rating_low),
      shu_rating_high: l.shu_rating_high == null ? (l.shu_rating_low == null ? null : Number(l.shu_rating_low)) : Number(l.shu_rating_high),
      role: l.role ?? null,
      salt_pct: l.salt_pct == null ? null : String(l.salt_pct),
      salt_base: l.salt_base ?? null,
      base_g: l.base_g == null ? null : String(l.base_g),
      salt_method: l.salt_method ?? null,
      base_from: l.base_from ?? null,
      put_up_stage_id: opts.sittingFixed ? null : (l.put_up_stage_id ?? null),
      output_id: opts.sittingFixed ? null : (l.output_id ?? null),
      ordinal: l.ordinal == null ? null : Number(l.ordinal),
      idempotency_key: l.idempotency_key ?? null,
      draw_count: draw.count,
      draw_weighed: draw.weighed === true,
    });
  }
  return { rows };
}

// The two draw CHECKs, answered with the number the person needs. The statement aborted, so nothing
// was written; the follow-up read says how many (or how many g) the jar really has.
export async function drawRefusal(err, sql, jarIds, householdIds) {
  if (err?.code !== '23514') return null;
  const name = String(err.constraint ?? '');
  if (name !== 'chk_preservation_log_remaining_count' && name !== 'chk_preservation_log_remaining_amount') return null;
  const jars = await sql`
    SELECT p.id, COALESCE(p.remaining_count, p.package_count) AS left_n,
           COALESCE(p.remaining_amount,
                    p.quantity_value * (SELECT m.f FROM unnest(${MASS_UNITS}::text[], ${MASS_FACTORS}::numeric[]) AS m(u, f)
                                         WHERE m.u = p.quantity_unit)) AS left_g
    FROM preservation_log p
    WHERE p.id = ANY(${jarIds}::uuid[]) AND p.user_id = ANY(${householdIds})
  `;
  if (name === 'chk_preservation_log_remaining_count') {
    const n = Math.min(...jars.map((j) => Number(j.left_n)).filter(Number.isFinite));
    const left = Number.isFinite(n) ? n : 0;
    return refuse(409, 'only_n_left', left === 0 ? 'None are left in that one.' : `Only ${left} left in that one.`, { n: left });
  }
  const g = Math.min(...jars.map((j) => Number(j.left_g)).filter(Number.isFinite));
  const left = Number.isFinite(g) ? Math.floor(g + 0.5) : 0;
  return refuse(409, 'only_g_left', `Only about ${left} g left in that one.`, { g: left });
}

// ── POST /:id/inputs, the keyed form (contract-F §2.2) ────────────────────────────────────────────
// NO ON CONFLICT (boss F3). A 23505 on uq_kbi_idempotency_key is a replay (every key found in this
// batch → 200 replayed, else 409 key_conflict); on uq_kbi_batch_harvest it is 409 already_in.
// ONE statement: the lines, then their draws from the INSERT's RETURNING — the pantry_use rows and ONE
// aggregated movement per jar — and a salt line clears the batch's "No salt" in the same statement.
export async function addKeyedLines(sql, batchId, body, userId, householdIds) {
  const inputs = body.inputs;
  const form = inputsForm(inputs);
  if (form === 'mixed') return bad('send every line with an idempotency_key, or none of them');
  const verr = linesError(inputs, { keyed: true });
  if (verr) return bad(verr);
  const prep = await prepareLines(sql, batchId, inputs, householdIds);
  if (prep.refusal) return prep.refusal;
  const c = lineColumns(prep.rows);
  const jarIds = uuids(prep.rows.map((r) => r.preservation_log_id));
  let rows;
  try {
    [, rows] = await sql.transaction([
      sql`SELECT set_config('app.actor_clerk_sub', ${userId}, true)`,
      sql`
      WITH ins AS (
        INSERT INTO kitchen_batch_input (
          id, batch_id, input_kind, harvest_log_id, plant_id, preservation_log_id, crop_type_slug, label,
          source_label, qty, qty_unit, form, brand, note, shu_rating_low, shu_rating_high, role, salt_pct,
          salt_base, base_g, salt_method, base_from, put_up_stage_id, output_id, ordinal, idempotency_key,
          created_by
        )
        SELECT u.id, ${batchId}::uuid, u.input_kind, u.harvest_log_id, u.plant_id, u.preservation_log_id,
               u.crop_type_slug, u.label, u.source_label, u.qty, u.qty_unit, u.form, u.brand, u.note,
               u.shu_rating_low, u.shu_rating_high, u.role, u.salt_pct, u.salt_base, u.base_g, u.salt_method,
               u.base_from, u.put_up_stage_id, u.output_id,
               COALESCE(u.ordinal, (SELECT COALESCE(max(k.ordinal), -1) FROM kitchen_batch_input k
                                     WHERE k.batch_id = ${batchId}::uuid) + u.n::int),
               u.idempotency_key, ${userId}::text
        FROM unnest(
          ${c.id}::uuid[], ${c.input_kind}::text[], ${c.harvest_log_id}::uuid[], ${c.plant_id}::uuid[],
          ${c.preservation_log_id}::uuid[], ${c.crop_type_slug}::text[], ${c.label}::text[],
          ${c.source_label}::text[], ${c.qty}::numeric[], ${c.qty_unit}::text[], ${c.form}::text[],
          ${c.brand}::text[], ${c.note}::text[], ${c.shu_rating_low}::int[], ${c.shu_rating_high}::int[],
          ${c.role}::text[], ${c.salt_pct}::numeric[], ${c.salt_base}::text[], ${c.base_g}::numeric[],
          ${c.salt_method}::text[], ${c.base_from}::text[], ${c.put_up_stage_id}::uuid[],
          ${c.output_id}::uuid[], ${c.ordinal}::int[], ${c.idempotency_key}::uuid[]
        ) WITH ORDINALITY AS u(id, input_kind, harvest_log_id, plant_id, preservation_log_id, crop_type_slug,
                               label, source_label, qty, qty_unit, form, brand, note, shu_rating_low,
                               shu_rating_high, role, salt_pct, salt_base, base_g, salt_method, base_from,
                               put_up_stage_id, output_id, ordinal, idempotency_key, n)
        RETURNING id, preservation_log_id, qty, qty_unit, role
      ), mass AS (
        SELECT m.unit, m.factor FROM unnest(${MASS_UNITS}::text[], ${MASS_FACTORS}::numeric[]) AS m(unit, factor)
      ), draws AS (
        SELECT i.id AS line_id, i.preservation_log_id, d.n,
               CASE WHEN d.weighed THEN i.qty * (SELECT factor FROM mass WHERE unit = i.qty_unit) END AS g
        FROM ins i
        JOIN unnest(${c.id}::uuid[], ${c.draw_count}::int[], ${c.draw_weighed}::boolean[]) AS d(line_id, n, weighed)
          ON d.line_id = i.id
        WHERE i.preservation_log_id IS NOT NULL
      ), moved AS (
        UPDATE preservation_log p SET
          remaining_count  = CASE WHEN a.n IS NOT NULL THEN COALESCE(p.remaining_count, p.package_count) - a.n
                                  WHEN a.g IS NOT NULL
                                   AND COALESCE(p.remaining_amount, p.quantity_value * (SELECT factor FROM mass WHERE unit = p.quantity_unit)) - a.g = 0
                                    THEN 0
                                  ELSE p.remaining_count END,
          remaining_amount = CASE WHEN a.g IS NOT NULL
                                    THEN COALESCE(p.remaining_amount, p.quantity_value * (SELECT factor FROM mass WHERE unit = p.quantity_unit)) - a.g
                                  ELSE p.remaining_amount END,
          consumed_at      = CASE WHEN a.g IS NOT NULL
                                   AND COALESCE(p.remaining_amount, p.quantity_value * (SELECT factor FROM mass WHERE unit = p.quantity_unit)) - a.g = 0
                                    THEN COALESCE(p.consumed_at, now())
                                  ELSE p.consumed_at END,
          delta_at         = CASE WHEN a.n IS NOT NULL
                                    OR (a.g IS NOT NULL
                                        AND COALESCE(p.remaining_amount, p.quantity_value * (SELECT factor FROM mass WHERE unit = p.quantity_unit)) - a.g = 0)
                                    THEN now()
                                  ELSE p.delta_at END
        FROM (SELECT x.preservation_log_id, sum(x.n) AS n, sum(x.g) AS g
                FROM draws x GROUP BY x.preservation_log_id) a
        WHERE p.id = a.preservation_log_id
          AND p.user_id = ANY(${householdIds})
        RETURNING p.id
      ), uses AS (
        INSERT INTO pantry_use (created_by, preservation_log_id, count_used, fate, kitchen_batch_input_id)
        SELECT ${userId}::text, d.preservation_log_id, d.n, 'batch', d.line_id
        FROM draws d WHERE d.n IS NOT NULL
        RETURNING id
      ), salted AS (
        UPDATE kitchen_batch SET no_salt = NULL
        WHERE id = ${batchId}::uuid AND no_salt IS TRUE AND EXISTS (SELECT 1 FROM ins WHERE role = 'salt')
        RETURNING id
      )
      SELECT (SELECT count(*)::int FROM ins) AS inserted,
             (SELECT count(*)::int FROM moved) AS jars_moved,
             (SELECT count(*)::int FROM uses) AS uses_written
    `,
    ]);
  } catch (err) {
    if (err?.code === '23505' && err.constraint === 'uq_kbi_idempotency_key') {
      const keys = prep.rows.map((r) => r.idempotency_key);
      const prior = await sql`
        SELECT i.id, i.batch_id FROM kitchen_batch_input i
        JOIN v_kitchen_batch_current b ON b.id = i.batch_id
        WHERE i.idempotency_key = ANY(${keys}::uuid[])
          AND b.user_id = ANY(${householdIds})
          AND b.deleted_at IS NULL
      `;
      if (prior.length !== keys.length || prior.some((r) => r.batch_id !== batchId)) return keyConflict;
      const lines = await readLines(sql, batchId, { ids: prior.map((r) => r.id), includeDeleted: true });
      return { status: 200, body: { replayed: true, inputs: lines.map(publicLine) } };
    }
    if (err?.code === '23505' && err.constraint === 'uq_kbi_batch_harvest') {
      return refuse(409, 'already_in', 'That pick is already in this batch.');
    }
    const r = await drawRefusal(err, sql, jarIds, householdIds);
    if (r) return r;
    throw err;
  }
  const lines = await readLines(sql, batchId, { ids: prep.rows.map((r) => r.id) });
  return {
    status: 201,
    body: { inserted: rows[0]?.inserted ?? 0, requested: prep.rows.length, inputs: lines.map(publicLine) },
  };
}

// The line as the PATCH / take-out / restore routes read it: this batch, any state, with how its draw
// moved stock (weighed = a put_up line that never wrote a pantry_use).
async function loadLine(sql, batchId, lineId) {
  if (!KITCHEN_UUID_RE.test(String(lineId))) return null;
  const rows = await sql`
    SELECT i.id, i.input_kind, i.harvest_log_id, i.preservation_log_id, i.label, i.qty, i.qty_unit, i.role,
           i.form, i.shu_rating_low, i.shu_rating_high, i.salt_pct, i.salt_base, i.base_g, i.salt_method,
           i.base_from, i.ordinal, i.deleted_at,
           (i.input_kind = 'put_up'
             AND NOT EXISTS (SELECT 1 FROM pantry_use u WHERE u.kitchen_batch_input_id = i.id)) AS weighed
    FROM kitchen_batch_input i
    WHERE i.id = ${lineId}::uuid
      AND i.batch_id = ${batchId}::uuid
  `;
  return rows[0] ?? null;
}

// ── PATCH /:id/inputs/:lineId (06 §3.7; contract-F §2.2) ──────────────────────────────────────────
// Presence-sentinel over the allowlist; stamps edited_at. A weighed draw's qty stays in a mass unit and
// the SAME statement moves the jar by the change in grams (over-draw → 409 only_g_left); guarded on the
// qty it read, so two phones editing one draw cannot both apply their difference. A counted draw's qty
// is free — it is what went in the pot and moves no stock.
export async function patchLine(sql, batchId, lineId, body, userId, householdIds) {
  const line = await loadLine(sql, batchId, lineId);
  if (!line || line.deleted_at != null) return notFound;
  const verr = linePatchError(body, line);
  if (verr) return bad(verr);
  const present = Object.fromEntries(LINE_PATCH_KEYS.map((k) => [k, has(body, k)]));
  const v = (k) => (present[k] ? body[k] ?? null : null);
  const moveGrams = line.input_kind === 'put_up' && line.weighed && present.qty;
  const shuHigh = present.shu_rating_low && !present.shu_rating_high ? v('shu_rating_low') : v('shu_rating_high');
  let rows;
  try {
    [, rows] = await sql.transaction([
      sql`SELECT set_config('app.actor_clerk_sub', ${userId}, true)`,
      sql`
      WITH upd AS (
        UPDATE kitchen_batch_input SET
          label           = CASE WHEN ${present.label}::boolean THEN COALESCE(${normalizeText(v('label'))}::text, label) ELSE label END,
          qty             = CASE WHEN ${present.qty}::boolean THEN ${v('qty') == null ? null : String(v('qty'))}::numeric ELSE qty END,
          qty_unit        = CASE WHEN ${present.qty}::boolean THEN ${normalizeText(v('qty_unit'))}::text ELSE qty_unit END,
          form            = CASE WHEN ${present.form}::boolean THEN ${v('form')}::text ELSE form END,
          brand           = CASE WHEN ${present.brand}::boolean THEN ${normalizeText(v('brand'))}::text ELSE brand END,
          source_label    = CASE WHEN ${present.source_label}::boolean THEN ${normalizeText(v('source_label'))}::text ELSE source_label END,
          note            = CASE WHEN ${present.note}::boolean THEN ${normalizeText(v('note'))}::text ELSE note END,
          shu_rating_low  = CASE WHEN ${present.shu_rating_low}::boolean THEN ${v('shu_rating_low')}::int ELSE shu_rating_low END,
          shu_rating_high = CASE WHEN ${present.shu_rating_low || present.shu_rating_high}::boolean THEN ${shuHigh}::int ELSE shu_rating_high END,
          role            = CASE WHEN ${present.role}::boolean THEN ${v('role')}::text ELSE role END,
          salt_pct        = CASE WHEN ${present.salt_pct}::boolean THEN ${v('salt_pct') == null ? null : String(v('salt_pct'))}::numeric ELSE salt_pct END,
          salt_base       = CASE WHEN ${present.salt_base}::boolean THEN ${v('salt_base')}::text ELSE salt_base END,
          base_g          = CASE WHEN ${present.base_g}::boolean THEN ${v('base_g') == null ? null : String(v('base_g'))}::numeric ELSE base_g END,
          salt_method     = CASE WHEN ${present.salt_method}::boolean THEN ${v('salt_method')}::text ELSE salt_method END,
          base_from       = CASE WHEN ${present.base_from}::boolean THEN ${v('base_from')}::text ELSE base_from END,
          ordinal         = CASE WHEN ${present.ordinal}::boolean THEN ${v('ordinal')}::int ELSE ordinal END,
          edited_at       = now()
        WHERE id = ${line.id}::uuid
          AND batch_id = ${batchId}::uuid
          AND deleted_at IS NULL
          AND (NOT ${moveGrams}::boolean
               OR (qty IS NOT DISTINCT FROM ${line.qty}::numeric AND qty_unit IS NOT DISTINCT FROM ${line.qty_unit}::text))
        RETURNING id, preservation_log_id
      ), mass AS (
        SELECT m.unit, m.factor FROM unnest(${MASS_UNITS}::text[], ${MASS_FACTORS}::numeric[]) AS m(unit, factor)
      ), delta AS (
        SELECT u.preservation_log_id,
               ${v('qty') == null ? null : String(v('qty'))}::numeric * (SELECT factor FROM mass WHERE unit = ${normalizeText(v('qty_unit'))}::text)
               - ${line.qty}::numeric * (SELECT factor FROM mass WHERE unit = ${line.qty_unit}::text) AS g
        FROM upd u
        WHERE ${moveGrams}::boolean AND u.preservation_log_id IS NOT NULL
      ), moved AS (
        UPDATE preservation_log p SET
          remaining_amount = COALESCE(p.remaining_amount, p.quantity_value * (SELECT factor FROM mass WHERE unit = p.quantity_unit)) - a.g,
          remaining_count  = CASE WHEN COALESCE(p.remaining_amount, p.quantity_value * (SELECT factor FROM mass WHERE unit = p.quantity_unit)) - a.g = 0 THEN 0
                                  WHEN a.g < 0
                                   AND COALESCE(p.remaining_amount, p.quantity_value * (SELECT factor FROM mass WHERE unit = p.quantity_unit)) = 0
                                   AND NOT EXISTS (SELECT 1 FROM pantry_use t WHERE t.preservation_log_id = p.id AND t.kitchen_batch_input_id IS NULL)
                                    THEN p.package_count
                                  ELSE p.remaining_count END,
          consumed_at      = CASE WHEN COALESCE(p.remaining_amount, p.quantity_value * (SELECT factor FROM mass WHERE unit = p.quantity_unit)) - a.g = 0
                                    THEN COALESCE(p.consumed_at, now())
                                  WHEN a.g < 0
                                   AND COALESCE(p.remaining_amount, p.quantity_value * (SELECT factor FROM mass WHERE unit = p.quantity_unit)) = 0
                                   AND NOT EXISTS (SELECT 1 FROM pantry_use t WHERE t.preservation_log_id = p.id AND t.kitchen_batch_input_id IS NULL)
                                    THEN NULL
                                  ELSE p.consumed_at END,
          delta_at         = CASE WHEN COALESCE(p.remaining_amount, p.quantity_value * (SELECT factor FROM mass WHERE unit = p.quantity_unit)) - a.g = 0
                                    OR (a.g < 0
                                        AND COALESCE(p.remaining_amount, p.quantity_value * (SELECT factor FROM mass WHERE unit = p.quantity_unit)) = 0
                                        AND NOT EXISTS (SELECT 1 FROM pantry_use t WHERE t.preservation_log_id = p.id AND t.kitchen_batch_input_id IS NULL))
                                    THEN now()
                                  ELSE p.delta_at END
        FROM (SELECT x.preservation_log_id, sum(x.g) AS g FROM delta x GROUP BY x.preservation_log_id) a
        WHERE p.id = a.preservation_log_id AND a.g <> 0
        RETURNING p.id
      )
      SELECT (SELECT count(*)::int FROM upd) AS updated
    `,
    ]);
  } catch (err) {
    const r = await drawRefusal(err, sql, uuids([line.preservation_log_id]), householdIds);
    if (r) return r;
    throw err;
  }
  if (!rows[0]?.updated) {
    return moveGrams ? refuse(409, 'client_stale', 'This line just changed. Refresh and try again.') : notFound;
  }
  const out = await readLines(sql, batchId, { ids: [line.id] });
  return { status: 200, body: { input: out[0] ? publicLine(out[0]) : null } };
}

// ── DELETE /:id/inputs/:lineId (06 §3.11; contract-F §2.2) ────────────────────────────────────────
// A pick line stays a HARD delete (uq_kbi_batch_harvest is not partial and harvest_log_id is RESTRICT);
// every other line is TAKEN OUT: soft-deleted, its draw reversed from that same UPDATE's RETURNING —
// a counted draw writes the reversing pantry_use (−n, reverses_use_id = its live forward use) and gives
// the count back; a weighed draw gives the grams back (F2's un-consume rule). A second take-out matches
// nothing and answers 200 already:true with no second reversal; reverses_use_id UNIQUE is the backstop.
export async function takeOutLine(sql, batchId, lineId, userId) {
  const line = await loadLine(sql, batchId, lineId);
  if (!line) return notFound;
  if (line.harvest_log_id != null) {
    const [, rows] = await sql.transaction([
      sql`SELECT set_config('app.actor_clerk_sub', ${userId}, true)`,
      sql`
      DELETE FROM kitchen_batch_input
      WHERE id = ${line.id}::uuid
        AND batch_id = ${batchId}::uuid
      RETURNING id
    `,
    ]);
    if (!rows.length) return notFound;
    return { status: 200, body: { ok: true, input: null } };
  }
  const [, rows] = await sql.transaction([
    sql`SELECT set_config('app.actor_clerk_sub', ${userId}, true)`,
    sql`
    WITH gone AS (
      UPDATE kitchen_batch_input SET deleted_at = now()
      WHERE id = ${line.id}::uuid
        AND batch_id = ${batchId}::uuid
        AND deleted_at IS NULL
        AND harvest_log_id IS NULL
      RETURNING id, preservation_log_id, qty, qty_unit
    ), mass AS (
      SELECT m.unit, m.factor FROM unnest(${MASS_UNITS}::text[], ${MASS_FACTORS}::numeric[]) AS m(unit, factor)
    ), fwd AS (
      SELECT u.id, u.preservation_log_id, u.count_used, u.kitchen_batch_input_id
      FROM pantry_use u JOIN gone g ON g.id = u.kitchen_batch_input_id
      WHERE u.count_used > 0
        AND NOT EXISTS (SELECT 1 FROM pantry_use r WHERE r.reverses_use_id = u.id)
    ), weighed AS (
      SELECT g.preservation_log_id, g.qty * (SELECT factor FROM mass WHERE unit = g.qty_unit) AS g
      FROM gone g
      WHERE g.preservation_log_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM pantry_use u WHERE u.kitchen_batch_input_id = g.id)
    ), rev AS (
      INSERT INTO pantry_use (created_by, preservation_log_id, count_used, fate, kitchen_batch_input_id, reverses_use_id)
      SELECT ${userId}::text, f.preservation_log_id, -f.count_used, 'batch', f.kitchen_batch_input_id, f.id
      FROM fwd f
      RETURNING id
    ), moved AS (
      UPDATE preservation_log p SET
        remaining_count  = CASE WHEN a.n IS NOT NULL THEN COALESCE(p.remaining_count, p.package_count) + a.n
                                WHEN a.g IS NOT NULL
                                 AND COALESCE(p.remaining_amount, p.quantity_value * (SELECT factor FROM mass WHERE unit = p.quantity_unit)) = 0
                                 AND NOT EXISTS (SELECT 1 FROM pantry_use t WHERE t.preservation_log_id = p.id AND t.kitchen_batch_input_id IS NULL)
                                  THEN p.package_count
                                ELSE p.remaining_count END,
        remaining_amount = CASE WHEN a.g IS NOT NULL
                                  THEN COALESCE(p.remaining_amount, p.quantity_value * (SELECT factor FROM mass WHERE unit = p.quantity_unit)) + a.g
                                ELSE p.remaining_amount END,
        consumed_at      = CASE WHEN a.g IS NOT NULL
                                 AND COALESCE(p.remaining_amount, p.quantity_value * (SELECT factor FROM mass WHERE unit = p.quantity_unit)) = 0
                                 AND NOT EXISTS (SELECT 1 FROM pantry_use t WHERE t.preservation_log_id = p.id AND t.kitchen_batch_input_id IS NULL)
                                  THEN NULL
                                ELSE p.consumed_at END,
        delta_at         = CASE WHEN a.n IS NOT NULL
                                  OR (a.g IS NOT NULL
                                      AND COALESCE(p.remaining_amount, p.quantity_value * (SELECT factor FROM mass WHERE unit = p.quantity_unit)) = 0
                                      AND NOT EXISTS (SELECT 1 FROM pantry_use t WHERE t.preservation_log_id = p.id AND t.kitchen_batch_input_id IS NULL))
                                  THEN now()
                                ELSE p.delta_at END
      FROM (SELECT x.preservation_log_id, sum(x.n) AS n, sum(x.g) AS g FROM (
              SELECT f.preservation_log_id, f.count_used AS n, NULL::numeric AS g FROM fwd f
              UNION ALL
              SELECT w.preservation_log_id, NULL::int, w.g FROM weighed w
            ) x GROUP BY x.preservation_log_id) a
      WHERE p.id = a.preservation_log_id
      RETURNING p.id
    )
    SELECT (SELECT count(*)::int FROM gone) AS removed,
           (SELECT count(*)::int FROM rev) AS reversed
  `,
  ]);
  if (!rows[0]?.removed) {
    if (line.deleted_at != null) return { status: 200, body: { ok: true, already: true } };
    return notFound;
  }
  const out = await readLines(sql, batchId, { ids: [line.id], includeDeleted: true });
  return { status: 200, body: { ok: true, input: out[0] ? publicLine(out[0]) : null } };
}

// ── POST /:id/inputs/:lineId/restore (06 §3.11; contract-F §2.2) ──────────────────────────────────
// State-idempotent, no key: `SET deleted_at = NULL WHERE ... deleted_at IS NOT NULL`, the re-draw from
// its RETURNING (a new forward use for the count it last drew, or the grams again). The draw CHECKs
// abort everything if the jar was used in between (409 only_n_left / only_g_left); a jar since marked
// used up or removed is refused before the statement (jar_used_up / jar_removed). A salt line coming
// back clears "No salt" in the same statement (a salt line wins).
export async function restoreLine(sql, batchId, lineId, userId, householdIds) {
  const line = await loadLine(sql, batchId, lineId);
  if (!line) return notFound;
  if (line.deleted_at == null) return { status: 200, body: { ok: true, already: true } };
  if (line.preservation_log_id != null) {
    const [jar] = await loadJars(sql, [line.preservation_log_id], householdIds);
    if (!jar) return notFound;
    const plan = drawPlan({ count_drawn: null, qty: line.qty, qty_unit: line.qty_unit }, jar);
    if (plan.code) return refuse(plan.status, plan.code, plan.error);
    if (jarIsWeighed(jar) !== line.weighed) {
      return refuse(409, 'client_stale', 'That jar changed since this line drew from it. Add it again.');
    }
  }
  let rows;
  try {
    [, rows] = await sql.transaction([
      sql`SELECT set_config('app.actor_clerk_sub', ${userId}, true)`,
      sql`
      WITH back AS (
        UPDATE kitchen_batch_input SET deleted_at = NULL
        WHERE id = ${line.id}::uuid
          AND batch_id = ${batchId}::uuid
          AND deleted_at IS NOT NULL
        RETURNING id, preservation_log_id, qty, qty_unit, role
      ), mass AS (
        SELECT m.unit, m.factor FROM unnest(${MASS_UNITS}::text[], ${MASS_FACTORS}::numeric[]) AS m(unit, factor)
      ), last_use AS (
        SELECT DISTINCT ON (u.kitchen_batch_input_id) u.kitchen_batch_input_id, u.preservation_log_id, u.count_used
        FROM pantry_use u JOIN back b ON b.id = u.kitchen_batch_input_id
        WHERE u.count_used > 0
        ORDER BY u.kitchen_batch_input_id, u.created_at DESC, u.id DESC
      ), weighed AS (
        SELECT b.preservation_log_id, b.qty * (SELECT factor FROM mass WHERE unit = b.qty_unit) AS g
        FROM back b
        WHERE b.preservation_log_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM pantry_use u WHERE u.kitchen_batch_input_id = b.id)
      ), fwd AS (
        INSERT INTO pantry_use (created_by, preservation_log_id, count_used, fate, kitchen_batch_input_id)
        SELECT ${userId}::text, l.preservation_log_id, l.count_used, 'batch', l.kitchen_batch_input_id
        FROM last_use l
        RETURNING id
      ), moved AS (
        UPDATE preservation_log p SET
          remaining_count  = CASE WHEN a.n IS NOT NULL THEN COALESCE(p.remaining_count, p.package_count) - a.n
                                  WHEN a.g IS NOT NULL
                                   AND COALESCE(p.remaining_amount, p.quantity_value * (SELECT factor FROM mass WHERE unit = p.quantity_unit)) - a.g = 0
                                    THEN 0
                                  ELSE p.remaining_count END,
          remaining_amount = CASE WHEN a.g IS NOT NULL
                                    THEN COALESCE(p.remaining_amount, p.quantity_value * (SELECT factor FROM mass WHERE unit = p.quantity_unit)) - a.g
                                  ELSE p.remaining_amount END,
          consumed_at      = CASE WHEN a.g IS NOT NULL
                                   AND COALESCE(p.remaining_amount, p.quantity_value * (SELECT factor FROM mass WHERE unit = p.quantity_unit)) - a.g = 0
                                    THEN COALESCE(p.consumed_at, now())
                                  ELSE p.consumed_at END,
          delta_at         = CASE WHEN a.n IS NOT NULL
                                    OR (a.g IS NOT NULL
                                        AND COALESCE(p.remaining_amount, p.quantity_value * (SELECT factor FROM mass WHERE unit = p.quantity_unit)) - a.g = 0)
                                    THEN now()
                                  ELSE p.delta_at END
        FROM (SELECT x.preservation_log_id, sum(x.n) AS n, sum(x.g) AS g FROM (
                SELECT l.preservation_log_id, l.count_used AS n, NULL::numeric AS g FROM last_use l
                UNION ALL
                SELECT w.preservation_log_id, NULL::int, w.g FROM weighed w
              ) x GROUP BY x.preservation_log_id) a
        WHERE p.id = a.preservation_log_id
          AND p.user_id = ANY(${householdIds})
        RETURNING p.id
      ), salted AS (
        UPDATE kitchen_batch SET no_salt = NULL
        WHERE id = ${batchId}::uuid AND no_salt IS TRUE AND EXISTS (SELECT 1 FROM back WHERE role = 'salt')
        RETURNING id
      )
      SELECT (SELECT count(*)::int FROM back) AS restored
    `,
    ]);
  } catch (err) {
    const r = await drawRefusal(err, sql, uuids([line.preservation_log_id]), householdIds);
    if (r) return r;
    throw err;
  }
  if (!rows[0]?.restored) return { status: 200, body: { ok: true, already: true } };
  const out = await readLines(sql, batchId, { ids: [line.id] });
  return { status: 200, body: { ok: true, input: out[0] ? publicLine(out[0]) : null } };
}
