// B′ release 3 (the batch builder) — two routes, importable for the reason kitchenRoutes.js is (index.js
// cannot be imported by vitest). kitchenRoutes.js dispatches here; this file imports only
// dependency-free siblings and takes `sql` as an argument.
//
//   POST /api/kitchen-batches/from-jars   How it was made → (V4 §2.2, §5.1)
//   GET  /api/kitchen-batches?plant_id=   the planting read (V4 §2.5 "Planting page", §5.1)
//
// AUDIT: preservation_log and kitchen_batch_input carry statement-level audit triggers, so the write runs
// in sql.transaction([set_config('app.actor_clerk_sub', <sub>, true), <the one statement>]).
import { randomUUID } from 'node:crypto';
import { KITCHEN_UUID_RE, normalizeText } from './kitchenBatch.js';
import { prepareLines, drawRefusal, MASS_UNITS, MASS_FACTORS } from './lineRoutes.js';
import { lineColumns } from './kitchenLines.js';
import {
  validateFromJars, jarStageDate, nextTimeLines, madeCountError, planFromJarsStages, dayInstant, usedVia,
} from './batchBuilder.js';

const bad = (error, code) => ({ status: 400, body: code ? { error, code } : { error } });
const refuse = (status, code, error, extra = {}) => ({ status, body: { error, code, ...extra } });
const keyConflict = refuse(409, 'key_conflict', 'That key is already in use.');
const notFound = { status: 404, body: { error: 'Not found' } };
// One answer for a jar that is absent, malformed, removed or another household's — no existence oracle.
const NO_JAR = 'jar_ids must name put-ups you can use';
const uuids = (xs) => [...new Set(xs.filter((v) => v != null))].filter((v) => KITCHEN_UUID_RE.test(String(v)));

// ── POST /api/kitchen-batches/from-jars ──────────────────────────────────────────────────────────
// Body: { idempotency_key, label, started:{date, precision}, kind?, kind_other?, inputs?, jar_ids, made_count?,
//         next_time? }
// → 201 <the batch detail, GET /:id's shape> · replay 200 { ...detail, replayed: true }.
// Refusals: 400 (shape; a jar that is not the household's or was removed — one answer), 409 jar_has_batch,
// 409 jar_from_harvest, 409 made_count_lower, 409 only_n_left / only_g_left (a draw), 409 key_conflict.
//
// ONE STATEMENT (V4 §5.1), all or nothing:
//   locked    the chosen jars, household-scoped, live, batchless and not harvest-linked, FOR UPDATE — so a
//             concurrent link cannot slip between the check and the link;
//   b         the batch, CLOSED as put_up, keyed — inserted only when EVERY chosen jar is locked, and
//             every other CTE hangs off it, so a partial answer writes nothing at all;
//   st        started (the sheet's start) · put_up · finished (the jars' date) · noted (each "Next time…"),
//             created_at stepped 1 µs per plan tick so the write order survives the one statement;
//   ins/draws/moved/uses   the lines and their draws, exactly as the keyed line POST writes them;
//   linked    the jars get batch_id — and NOT put_up_stage_id: these jars existed before this batch,
//             and a sitting's jars are what "Undo that put-up" soft-deletes (see the README);
//   made      "How many did you make?" raises package_count and pins remaining_count to what was left.
// The jars' own where-from (source_kind / source_label / plant_id / crop / variety) is never written.
export async function fromJars(sql, body, userId, householdIds, readDetail) {
  const verr = validateFromJars(body);
  if (verr) return bad(verr);
  const key = body.idempotency_key;
  // A replay is decided before anything is checked against the jars: a retried write whose answer was
  // lost finds its jars already linked — to itself — and must get its own success back.
  const prior = await sql`
    SELECT id FROM v_kitchen_batch_current
    WHERE idempotency_key = ${key}::uuid
      AND user_id = ANY(${householdIds})
      AND deleted_at IS NULL
  `;
  if (prior.length) return { status: 200, body: { ...(await readDetail(prior[0].id)), replayed: true } };

  const jarIds = [...new Set(body.jar_ids)];
  const jars = await sql`
    SELECT p.id, p.batch_id, p.harvest_log_id, p.deleted_at, p.preserved_at, p.preserved_at_precision,
           p.preserved_at_approx, p.package_count, p.remaining_count, p.quantity_unit, p.notes
    FROM preservation_log p
    WHERE p.id = ANY(${jarIds}::uuid[])
      AND p.user_id = ANY(${householdIds})
  `;
  const J = new Map(jars.map((j) => [j.id, j]));
  if (jarIds.some((id) => !J.has(id) || J.get(id).deleted_at != null)) return bad(NO_JAR, 'jar_not_found');
  if (jarIds.some((id) => J.get(id).batch_id != null)) {
    return refuse(409, 'jar_has_batch', 'One of those already has a batch — open it there.');
  }
  if (jarIds.some((id) => J.get(id).harvest_log_id != null)) {
    return refuse(409, 'jar_from_harvest', 'One of those is linked to one harvest, so it cannot come from a batch.');
  }
  const primary = J.get(body.jar_ids[0]);
  const madeErr = madeCountError(primary, body.made_count);
  if (madeErr) return refuse(madeErr.status, madeErr.code ?? 'bad_request', madeErr.error);

  const batchId = randomUUID();
  const inputs = body.inputs ?? [];
  const prep = inputs.length
    ? await prepareLines(sql, batchId, inputs, householdIds, { sittingFixed: true })
    : { rows: [] };
  if (prep.refusal) return prep.refusal;
  prep.rows.forEach((r, i) => { r.ordinal = r.ordinal ?? i; });
  const c = lineColumns(prep.rows);
  const drawJarIds = uuids(prep.rows.map((r) => r.preservation_log_id));

  const notes = [];
  for (const id of jarIds) for (const n of nextTimeLines(J.get(id).notes)) if (!notes.includes(n)) notes.push(n);
  const typed = normalizeText(body.next_time);
  if (typed && !notes.includes(typed)) notes.push(typed);
  const precision = normalizeText(body.started.precision);
  const startedAt = precision === 'unknown' ? null : dayInstant(body.started.date);
  const stages = planFromJarsStages({
    startedAt, startPrecision: precision, jarDate: jarStageDate(primary), notes, newId: randomUUID,
  });
  const kind = normalizeText(body.kind);
  const made = body.made_count == null ? null : Number(body.made_count);

  let rows;
  try {
    [, rows] = await sql.transaction([
      sql`SELECT set_config('app.actor_clerk_sub', ${userId}, true)`,
      sql`
      WITH locked AS (
        SELECT p.id FROM preservation_log p
        WHERE p.id = ANY(${jarIds}::uuid[])
          AND p.user_id = ANY(${householdIds})
          AND p.deleted_at IS NULL
          AND p.batch_id IS NULL
          AND p.harvest_log_id IS NULL
        FOR UPDATE
      ), b AS (
        INSERT INTO kitchen_batch (id, user_id, label, kind, kind_other, started_at, start_precision, start_anchor_kind,
                                   idempotency_key, closed_at, outcome)
        SELECT ${batchId}::uuid, ${userId}::text, ${normalizeText(body.label)}::text, ${kind}::text,
               ${kind === 'other' ? normalizeText(body.kind_other) : null}::text,
               ${startedAt}::timestamptz, ${precision}::text,
               CASE WHEN ${startedAt}::timestamptz IS NULL THEN NULL ELSE 'memory' END,
               ${key}::uuid, now(), 'put_up'::text
        WHERE (SELECT count(*) FROM locked) = ${jarIds.length}::int
        RETURNING id
      ), st AS (
        INSERT INTO kitchen_stage_log (id, batch_id, stage_kind, entered_at, entered_precision, note, created_by, created_at)
        SELECT s.id, b.id, s.kind,
               CASE WHEN s.kind = 'noted' THEN now() ELSE s.at END,
               s.precision, s.note, ${userId}::text,
               -- The write order, which one statement's shared now() cannot carry (planFromJarsStages).
               now() + s.tick::float8 * interval '1 microsecond'
        FROM b CROSS JOIN unnest(
          ${stages.map((s) => s.id)}::uuid[], ${stages.map((s) => s.kind)}::text[],
          ${stages.map((s) => s.at)}::timestamptz[], ${stages.map((s) => s.precision)}::text[],
          ${stages.map((s) => s.note)}::text[], ${stages.map((s) => s.tick)}::int[]
        ) AS s(id, kind, at, precision, note, tick)
        RETURNING id
      ), ins AS (
        INSERT INTO kitchen_batch_input (
          id, batch_id, input_kind, harvest_log_id, plant_id, preservation_log_id, crop_type_slug, label,
          source_label, qty, qty_unit, form, brand, note, shu_rating_low, shu_rating_high, role, salt_pct,
          salt_base, base_g, salt_method, base_from, ordinal, idempotency_key, created_by, pantry_item_id
        )
        SELECT u.id, b.id, u.input_kind, u.harvest_log_id, u.plant_id, u.preservation_log_id,
               u.crop_type_slug, u.label, u.source_label, u.qty, u.qty_unit, u.form, u.brand, u.note,
               u.shu_rating_low, u.shu_rating_high, u.role, u.salt_pct, u.salt_base, u.base_g, u.salt_method,
               u.base_from, u.ordinal, u.idempotency_key, ${userId}::text, u.pantry_item_id
        FROM b CROSS JOIN unnest(
          ${c.id}::uuid[], ${c.input_kind}::text[], ${c.harvest_log_id}::uuid[], ${c.plant_id}::uuid[],
          ${c.preservation_log_id}::uuid[], ${c.crop_type_slug}::text[], ${c.label}::text[],
          ${c.source_label}::text[], ${c.qty}::numeric[], ${c.qty_unit}::text[], ${c.form}::text[],
          ${c.brand}::text[], ${c.note}::text[], ${c.shu_rating_low}::int[], ${c.shu_rating_high}::int[],
          ${c.role}::text[], ${c.salt_pct}::numeric[], ${c.salt_base}::text[], ${c.base_g}::numeric[],
          ${c.salt_method}::text[], ${c.base_from}::text[], ${c.ordinal}::int[], ${c.idempotency_key}::uuid[],
          ${c.pantry_item_id}::uuid[]
        ) AS u(id, input_kind, harvest_log_id, plant_id, preservation_log_id, crop_type_slug, label,
               source_label, qty, qty_unit, form, brand, note, shu_rating_low, shu_rating_high, role, salt_pct,
               salt_base, base_g, salt_method, base_from, ordinal, idempotency_key, pantry_item_id)
        RETURNING id, preservation_log_id, qty, qty_unit
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
      ), linked AS (
        UPDATE preservation_log p
        SET batch_id = b.id,
            package_count   = CASE WHEN p.id = ${primary.id}::uuid AND ${made}::int IS NOT NULL
                                   THEN GREATEST(p.package_count, ${made}::int) ELSE p.package_count END,
            remaining_count = CASE WHEN p.id = ${primary.id}::uuid AND ${made}::int IS NOT NULL
                                   THEN COALESCE(p.remaining_count, p.package_count) ELSE p.remaining_count END
        FROM b
        WHERE p.id IN (SELECT id FROM locked)
        RETURNING p.id
      )
      SELECT (SELECT count(*)::int FROM b) AS created,
             (SELECT count(*)::int FROM linked) AS linked_count,
             (SELECT count(*)::int FROM ins) AS lines_inserted,
             (SELECT count(*)::int FROM st) AS stages_inserted,
             (SELECT count(*)::int FROM uses) AS uses_written,
             (SELECT count(*)::int FROM moved) AS jars_moved
    `,
    ]);
  } catch (err) {
    if (err?.code === '23505' && err.constraint === 'uq_kitchen_batch_idempotency_key') {
      // Another writer's key, or ours outside the household (the pre-read above found nothing of ours).
      const again = await sql`
        SELECT id FROM v_kitchen_batch_current
        WHERE idempotency_key = ${key}::uuid AND user_id = ANY(${householdIds}) AND deleted_at IS NULL
      `;
      if (!again.length) return keyConflict;
      return { status: 200, body: { ...(await readDetail(again[0].id)), replayed: true } };
    }
    if (err?.code === '23505' && (err.constraint === 'uq_kbi_idempotency_key' || err.constraint === 'uq_pantry_use_idempotency_key')) {
      return keyConflict;
    }
    if (err?.code === '23505' && err.constraint === 'uq_kbi_batch_harvest') {
      return refuse(409, 'already_in', 'That pick is named twice.');
    }
    const r = await drawRefusal(err, sql, drawJarIds, householdIds);
    if (r) return r;
    throw err;
  }
  if (!rows[0]?.created) {
    // A concurrent writer linked (or removed) a jar between the read above and the lock.
    return refuse(409, 'jar_has_batch', 'One of those already has a batch — open it there.');
  }
  return { status: 201, body: await readDetail(batchId) };
}

// ── GET /api/kitchen-batches?plant_id= ───────────────────────────────────────────────────────────
// → 200 { plant_id, batches: [...], kept_fresh: [...] } · 404 when the planting is not the household's.
//   batches: every live batch that used the planting — directly (a live garden or pick line naming it) or
//            through stock from it (a live draw line on a jar whose plant_id is it, or a live pantry line
//            on a "Fresh, as picked" item from it). Each is the
//            view row plus: used_via ('garden' | 'jar' | 'both'), single_planting (every planting its
//            lines name is this one), output_ids (its live jars), next_time ([{ id, note, entered_at }],
//            its un-voided noted rows, oldest first). Newest start first, unknown starts last.
//   kept_fresh: the household's live pantry items with this plant_id ("Fresh, as picked"): { id, name,
//            place_label, acquired_at, acquired_precision, used_up_at, notes, next_time: [text] }.
// A LIST, never a sum or a percentage (V4 §2.5; reward-UX ambient only).
export async function plantingBatches(sql, plantId, householdIds) {
  if (!KITCHEN_UUID_RE.test(String(plantId ?? ''))) return notFound;
  const owned = await sql`
    SELECT gn.id FROM garden_node gn
    LEFT JOIN container pp ON pp.id = gn.container_id
    WHERE gn.id = ${plantId}::uuid
      AND ( pp.created_by = ANY(${householdIds})
            OR (gn.container_id IS NULL AND gn.created_by = ANY(${householdIds})) )
  `;
  if (!owned.length) return notFound;
  const batches = await sql`
    WITH direct AS (
      SELECT DISTINCT i.batch_id FROM kitchen_batch_input i
      WHERE i.plant_id = ${plantId}::uuid AND i.deleted_at IS NULL
        AND i.input_kind IN ('garden', 'harvest')
    ), indirect AS (
      SELECT DISTINCT i.batch_id FROM kitchen_batch_input i
      JOIN preservation_log jar ON jar.id = i.preservation_log_id
      WHERE jar.plant_id = ${plantId}::uuid AND i.deleted_at IS NULL AND i.input_kind = 'put_up'
      UNION
      SELECT i.batch_id FROM kitchen_batch_input i
      JOIN pantry_item it ON it.id = i.pantry_item_id
      WHERE it.plant_id = ${plantId}::uuid AND i.deleted_at IS NULL AND i.input_kind = 'pantry'
    )
    SELECT v.*,
           (v.id IN (SELECT batch_id FROM direct)) AS used_direct,
           (v.id IN (SELECT batch_id FROM indirect)) AS used_indirect,
           NOT EXISTS (
             SELECT 1 FROM kitchen_batch_input k
             LEFT JOIN preservation_log kj ON kj.id = k.preservation_log_id
             LEFT JOIN pantry_item kp ON kp.id = k.pantry_item_id
             WHERE k.batch_id = v.id AND k.deleted_at IS NULL
               AND COALESCE(k.plant_id, kj.plant_id, kp.plant_id) IS NOT NULL
               AND COALESCE(k.plant_id, kj.plant_id, kp.plant_id) <> ${plantId}::uuid
           ) AS single_planting,
           COALESCE((SELECT array_agg(o.id ORDER BY o.preserved_at DESC, o.id DESC) FROM preservation_log o
                      WHERE o.batch_id = v.id AND o.deleted_at IS NULL), '{}'::uuid[]) AS output_ids,
           COALESCE((SELECT json_agg(json_build_object('id', n.id, 'note', n.note, 'entered_at', n.entered_at)
                                     ORDER BY n.created_at, n.id)
                       FROM kitchen_stage_log n
                      WHERE n.batch_id = v.id AND n.stage_kind = 'noted' AND n.note IS NOT NULL
                        AND NOT EXISTS (SELECT 1 FROM kitchen_stage_log x WHERE x.voids_id = n.id)), '[]'::json) AS next_time
    FROM v_kitchen_batch_current v
    WHERE v.user_id = ANY(${householdIds})
      AND v.deleted_at IS NULL
      AND (v.id IN (SELECT batch_id FROM direct) OR v.id IN (SELECT batch_id FROM indirect))
    ORDER BY v.started_at DESC NULLS LAST, v.first_recorded_at DESC, v.id DESC
  `;
  const fresh = await sql`
    SELECT pit.id, pit.name, s.label AS place_label, pit.acquired_at, pit.acquired_precision, pit.used_up_at, pit.notes
    FROM pantry_item pit
    LEFT JOIN storage_location s ON s.id = pit.storage_location_id
    WHERE pit.plant_id = ${plantId}::uuid
      AND pit.user_id = ANY(${householdIds})
      AND pit.deleted_at IS NULL
    ORDER BY pit.used_up_at IS NOT NULL, pit.acquired_at DESC NULLS LAST, pit.created_at DESC, pit.id DESC
  `;
  return {
    status: 200,
    body: {
      plant_id: plantId,
      batches: batches.map(({ used_direct: d, used_indirect: x, ...b }) => ({ ...b, used_via: usedVia(d, x) })),
      kept_fresh: fresh.map((f) => ({ ...f, next_time: nextTimeLines(f.notes) })),
    },
  };
}
