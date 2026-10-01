// Put-Up release 4 — /api/recipes: the recipe library (V4 §2.6, §4.5, §5.1 row 4; F §1.5; recipe types per
// Dave 2026-09-30).
//
//   GET    /api/recipes                    the household's recipes (list rows; ?type_id= narrows)
//   POST   /api/recipes                    keyed create: the recipe and its lines in ONE statement
//   GET    /api/recipes/:id                one recipe: notes verbatim, lines, and the dated batches made from it
//   PATCH  /api/recipes/:id                presence-sentinel edit; `lines` present replaces the set
//   DELETE /api/recipes/:id                soft delete (the recipe and its lines, one statement)
//   POST   /api/recipes/from-batch/:batchId  "Save as recipe": one statement reads the batch (every F §1.5
//                                         column) and writes the recipe, its lines, and links the batch
//   GET    /api/recipes/types              built-in types, then the household's
//   POST   /api/recipes/types              find-or-create a type by lower(btrim(label))
//   DELETE /api/recipes/types/:id          soft delete a household type (a built-in is refused)
//
// WHY A SIBLING MODULE. index.js loads neon, clerk and aws at module scope and cannot be imported by vitest;
// this file takes `sql` as an argument and imports only dependency-free siblings, so every statement below is
// EXECUTED under `npm test` against a mock driver (recipeRoutes.test.js). index.js delegates with the same
// null-for-not-mine contract the kitchen and jar delegations use.
//
// HOUSEHOLD SCOPE (V4 §5.3). Dave and Jen read and write every recipe; STRANGER gets not-found. The owner
// column is user_id (the creator; never changed — prevent_recipe_ownership_transfer). Lines take their owner
// from their recipe. Every body-settable FK has a household loader: recipe_type_id (loadOwnedRecipeType) here,
// and a batch's recipe_id (loadOwnedRecipe, exported for kitchenRoutes.js's create).
//
// ⚠ pH (V4 "pH"). His target pH lives in `notes` and is returned ONLY by GET /api/recipes/:id (recipe detail).
// The list omits notes; the batch-facing read (readRecipeForBatch) omits notes; the detail's batch list is an
// explicit column list with no pH column. No route here parses the notes.
//
// IDEMPOTENCY (V4 §5.2). The key lives on the recipe row (uq_recipe_idempotency_key, global partial). A 23505
// on that index is a replay → re-read owner-scoped → 200 `replayed: true`; a key held outside the household →
// 409 key_conflict, no payload. Never ON CONFLICT DO NOTHING on the recipe row.
import {
  parseRecipeRoute, validateRecipeCreate, validateRecipePatch, recipePatchPlan, recipeCreateValues,
  validateFromBatch, validateTypeCreate, typeLabelOf,
} from './recipeRules.js';
import { KITCHEN_UUID_RE, KITCHEN_UNITS } from './kitchenBatch.js';

const notFound = { status: 404, body: { error: 'Not found', code: 'not_found' } };
const notAllowed = { status: 405, body: { error: 'Method not allowed' } };
const bad = (error) => ({ status: 400, body: { error } });
const keyConflict = { status: 409, body: { error: 'That key is already in use.', code: 'key_conflict' } };
const isUuid = (v) => typeof v === 'string' && KITCHEN_UUID_RE.test(v);

// ── household loaders (V4 §5.3) ──────────────────────────────────────────────────────────────────
// A row on success, null on ANY failure (malformed, foreign, soft-deleted): the caller answers the same 400 for
// all of them, so there is no existence oracle.
export async function loadOwnedRecipe(sql, recipeId, householdIds) {
  if (!isUuid(recipeId)) return null;
  const rows = await sql`
    SELECT id, name, keeps_n, keeps_unit, keeps_storage_kind FROM recipe
    WHERE id = ${recipeId}::uuid
      AND user_id = ANY(${householdIds})
      AND deleted_at IS NULL
  `;
  return rows.length ? rows[0] : null;
}

// A built-in (user_id NULL) is everyone's; a household type is the household's.
export async function loadOwnedRecipeType(sql, typeId, householdIds) {
  if (!isUuid(typeId)) return null;
  const rows = await sql`
    SELECT id, label FROM recipe_type
    WHERE id = ${typeId}::uuid
      AND (user_id IS NULL OR user_id = ANY(${householdIds}))
      AND deleted_at IS NULL
  `;
  return rows.length ? rows[0] : null;
}

// The batch surface's view of its recipe (getBatch's `recipe` key, and Put it up's preview): the name, the keeps
// line, the process jar and the final container (Put it up's row defaults), and the lines as reference text. NOT the notes — his target pH is in them, and it renders only on recipe
// detail (V4 "pH"). A soft-deleted recipe answers null (the batch keeps its recipe_id; the surface stops naming it).
export async function readRecipeForBatch(sql, recipeId, householdIds) {
  if (!isUuid(recipeId)) return null;
  const rows = await sql`
    SELECT r.id, r.name, r.kind, r.recipe_type_id, t.label AS type_label, r.link_url,
           r.keeps_n, r.keeps_unit, r.keeps_storage_kind, r.vessel_label, r.vessel_size, r.vessel_unit,
           r.vessel_count, r.bottle_label, r.bottle_size, r.bottle_unit, r.bottle_cooked, r.made_text,
           COALESCE((SELECT json_agg(json_build_object(
                      'id', i.id, 'ordinal', i.ordinal, 'name', i.name, 'amount_text', i.amount_text,
                      'qty', i.qty, 'qty_unit', i.qty_unit, 'at_the_end', i.at_the_end, 'form', i.form,
                      'brand', i.brand, 'role', i.role, 'note', i.note, 'shu_rating_low', i.shu_rating_low,
                      'shu_rating_high', i.shu_rating_high, 'salt_pct', i.salt_pct, 'salt_base', i.salt_base,
                      'base_g', i.base_g, 'salt_method', i.salt_method, 'base_from', i.base_from)
                      ORDER BY i.ordinal, i.id)
                     FROM recipe_ingredient i
                    WHERE i.recipe_id = r.id AND i.deleted_at IS NULL), '[]'::json) AS lines
    FROM recipe r
    LEFT JOIN recipe_type t ON t.id = r.recipe_type_id
    WHERE r.id = ${recipeId}::uuid
      AND r.user_id = ANY(${householdIds})
      AND r.deleted_at IS NULL
  `;
  return rows.length ? rows[0] : null;
}

// ── the route table ──────────────────────────────────────────────────────────────────────────────
export async function handleRecipeRoute({ sql, rawPath, method, rawBody, query, userId, householdIds }) {
  const route = parseRecipeRoute(rawPath);
  if (!route) return null;
  const q = query ?? {};
  let body;
  const parseBody = () => {
    if (body !== undefined) return body;
    try { body = JSON.parse(rawBody ?? '{}'); } catch { body = null; }
    return body;
  };
  if (route.kind === 'bad_id') return notFound;
  if (route.kind === 'collection') {
    if (method === 'GET') return listRecipes(sql, q, householdIds);
    if (method === 'POST') return createRecipe(sql, parseBody(), userId, householdIds);
    return notAllowed;
  }
  if (route.kind === 'types') {
    if (method === 'GET') return listTypes(sql, householdIds);
    if (method === 'POST') return createType(sql, parseBody(), userId, householdIds);
    return notAllowed;
  }
  if (route.kind === 'type') {
    if (method === 'DELETE') return deleteType(sql, route.id, householdIds);
    return notAllowed;
  }
  if (route.kind === 'from_batch') {
    if (method === 'POST') return fromBatch(sql, route.batchId, parseBody(), userId, householdIds);
    return notAllowed;
  }
  if (method === 'GET') return getRecipe(sql, route.id, householdIds);
  if (method === 'PATCH') return patchRecipe(sql, route.id, parseBody(), householdIds);
  if (method === 'DELETE') return deleteRecipe(sql, route.id, householdIds);
  return notAllowed;
}

// ── reads ────────────────────────────────────────────────────────────────────────────────────────
// The list: no notes (they can be long, and they carry his target pH — detail only). What a list row needs to
// group, filter and say "made 3 times, last Sep 12": its type, its keeps line, its line count, its batches.
async function listRecipes(sql, q, householdIds) {
  const typeId = isUuid(q.type_id) ? q.type_id : null;
  const rows = await sql`
    SELECT r.id, r.user_id, r.name, r.kind, r.recipe_type_id, t.label AS type_label, t.sort_order AS type_sort,
           r.link_url, r.keeps_n, r.keeps_unit, r.keeps_storage_kind, r.created_at, r.updated_at,
           (SELECT count(*) FROM recipe_ingredient i WHERE i.recipe_id = r.id AND i.deleted_at IS NULL)::int AS line_count,
           (SELECT count(*) FROM v_kitchen_batch_current b
             WHERE b.recipe_id = r.id AND b.user_id = ANY(${householdIds}) AND b.deleted_at IS NULL)::int AS batch_count,
           (SELECT max(COALESCE(b.started_at, b.first_recorded_at)) FROM v_kitchen_batch_current b
             WHERE b.recipe_id = r.id AND b.user_id = ANY(${householdIds}) AND b.deleted_at IS NULL) AS last_made_at
    FROM recipe r
    LEFT JOIN recipe_type t ON t.id = r.recipe_type_id
    WHERE r.user_id = ANY(${householdIds})
      AND r.deleted_at IS NULL
      AND (${typeId}::uuid IS NULL OR r.recipe_type_id = ${typeId}::uuid)
    ORDER BY lower(r.name), r.id
  `;
  return { status: 200, body: { recipes: rows } };
}

// One recipe. Notes verbatim; lines in order; the dated batches made from it, newest first, with their endings
// (the client words them). The batch list is an EXPLICIT column list: no last_ph_reading, no outcome_note —
// "recipe detail's batch list never shows a pH" (V4 "pH") is decided here, not left to the client.
async function readRecipe(sql, recipeId, householdIds) {
  const rows = await sql`
    SELECT r.id, r.user_id, r.name, r.kind, r.recipe_type_id, t.label AS type_label, r.link_url, r.notes,
           r.keeps_n, r.keeps_unit, r.keeps_storage_kind, r.vessel_label, r.vessel_size, r.vessel_unit,
           r.vessel_count, r.no_salt, r.mash_in_g, r.made_g, r.made_text, r.bottle_label, r.bottle_size,
           r.bottle_unit, r.bottle_cooked, r.created_at, r.updated_at
    FROM recipe r
    LEFT JOIN recipe_type t ON t.id = r.recipe_type_id
    WHERE r.id = ${recipeId}::uuid
      AND r.user_id = ANY(${householdIds})
      AND r.deleted_at IS NULL
  `;
  if (!rows.length) return null;
  const lines = await sql`
    SELECT id, ordinal, name, amount_text, qty, qty_unit, at_the_end, form, brand, role, note,
           shu_rating_low, shu_rating_high, salt_pct, salt_base, base_g, salt_method, base_from
    FROM recipe_ingredient
    WHERE recipe_id = ${recipeId}::uuid
      AND deleted_at IS NULL
    ORDER BY ordinal, id
  `;
  const batches = await sql`
    SELECT b.id, b.user_id, b.label, b.started_at, b.start_precision, b.first_recorded_at, b.closed_at,
           b.outcome, b.suspended_at, b.current_stage_kind, b.output_count
    FROM v_kitchen_batch_current b
    WHERE b.recipe_id = ${recipeId}::uuid
      AND b.user_id = ANY(${householdIds})
      AND b.deleted_at IS NULL
    ORDER BY b.started_at DESC NULLS LAST, b.first_recorded_at DESC, b.id DESC
  `;
  return { ...rows[0], lines, batches };
}

async function getRecipe(sql, recipeId, householdIds) {
  const recipe = await readRecipe(sql, recipeId, householdIds);
  return recipe ? { status: 200, body: { recipe } } : notFound;
}

// The replay read: the recipe under this key, household-scoped. null when nothing holds it; key_conflict when
// someone outside the household does.
async function replayRecipe(sql, key, householdIds) {
  const prior = await sql`
    SELECT id, (user_id = ANY(${householdIds}) AND deleted_at IS NULL) AS mine
    FROM recipe WHERE idempotency_key = ${key}::uuid
  `;
  if (!prior.length) return null;
  if (!prior[0].mine) return keyConflict;
  const recipe = await readRecipe(sql, prior[0].id, householdIds);
  return recipe ? { status: 200, body: { recipe, replayed: true } } : keyConflict;
}

// ── POST /api/recipes ────────────────────────────────────────────────────────────────────────────
async function createRecipe(sql, body, userId, householdIds) {
  const verr = validateRecipeCreate(body);
  if (verr) return bad(verr);
  if (body.recipe_type_id != null && !(await loadOwnedRecipeType(sql, body.recipe_type_id, householdIds))) {
    return bad('that type does not match a recipe type you can use');
  }
  const { value: v, lines: c } = recipeCreateValues(body);
  let rows;
  try {
    rows = await sql`
      WITH r AS (
        INSERT INTO recipe (
          user_id, name, kind, recipe_type_id, link_url, notes, keeps_n, keeps_unit, keeps_storage_kind,
          vessel_label, vessel_size, vessel_unit, vessel_count, no_salt, mash_in_g, made_g, made_text,
          bottle_label, bottle_size, bottle_unit, bottle_cooked, idempotency_key
        ) VALUES (
          ${userId}::text, ${v.name}::text, ${v.kind}::text, ${v.recipe_type_id}::uuid, ${v.link_url}::text,
          ${v.notes}::text, ${v.keeps_n}::int, ${v.keeps_unit}::text, ${v.keeps_storage_kind}::text,
          ${v.vessel_label}::text, ${v.vessel_size}::numeric, ${v.vessel_unit}::text, ${v.vessel_count}::smallint,
          ${v.no_salt}::boolean, ${v.mash_in_g}::numeric, ${v.made_g}::numeric, ${v.made_text}::text,
          ${v.bottle_label}::text, ${v.bottle_size}::numeric, ${v.bottle_unit}::text, ${v.bottle_cooked}::boolean,
          ${body.idempotency_key}::uuid
        ) RETURNING id
      ), l AS (
        INSERT INTO recipe_ingredient (
          recipe_id, ordinal, name, amount_text, qty, qty_unit, at_the_end, form, brand, role, note,
          shu_rating_low, shu_rating_high, salt_pct, salt_base, base_g, salt_method, base_from
        )
        SELECT r.id, u.ordinal, u.name, u.amount_text, u.qty, u.qty_unit, u.at_the_end, u.form, u.brand, u.role,
               u.note, u.shu_rating_low, u.shu_rating_high, u.salt_pct, u.salt_base, u.base_g, u.salt_method,
               u.base_from
        FROM r, unnest(
          ${c.ordinal}::int[], ${c.name}::text[], ${c.amount_text}::text[], ${c.qty}::numeric[], ${c.qty_unit}::text[],
          ${c.at_the_end}::boolean[], ${c.form}::text[], ${c.brand}::text[], ${c.role}::text[], ${c.note}::text[],
          ${c.shu_rating_low}::int[], ${c.shu_rating_high}::int[], ${c.salt_pct}::numeric[], ${c.salt_base}::text[],
          ${c.base_g}::numeric[], ${c.salt_method}::text[], ${c.base_from}::text[]
        ) AS u(ordinal, name, amount_text, qty, qty_unit, at_the_end, form, brand, role, note,
               shu_rating_low, shu_rating_high, salt_pct, salt_base, base_g, salt_method, base_from)
        RETURNING id
      )
      SELECT r.id, (SELECT count(*) FROM l)::int AS line_count FROM r
    `;
  } catch (err) {
    if (err?.code === '23505' && err.constraint === 'uq_recipe_idempotency_key') {
      return (await replayRecipe(sql, body.idempotency_key, householdIds)) ?? keyConflict;
    }
    throw err;
  }
  const recipe = await readRecipe(sql, rows[0].id, householdIds);
  return { status: 201, body: { recipe } };
}

// ── PATCH /api/recipes/:id ───────────────────────────────────────────────────────────────────────
// Presence-sentinel: every column is a CASE on its presence flag (absent = unchanged, explicit null = clear;
// COALESCE could not tell them apart). `lines` present replaces the live set in the SAME statement: the old
// lines are soft-deleted and the new ones inserted, both hanging off the recipe UPDATE's RETURNING, so a recipe
// that is not the household's (or went away) changes nothing at all.
async function patchRecipe(sql, recipeId, body, householdIds) {
  const verr = validateRecipePatch(body);
  if (verr) return bad(verr);
  if (body.recipe_type_id != null && !(await loadOwnedRecipeType(sql, body.recipe_type_id, householdIds))) {
    return bad('that type does not match a recipe type you can use');
  }
  const { present: p, value: v, lines: c } = recipePatchPlan(body);
  const rows = await sql`
    WITH r AS (
      UPDATE recipe SET
        name               = CASE WHEN ${p.name}::boolean THEN ${v.name}::text ELSE name END,
        kind               = CASE WHEN ${p.kind}::boolean THEN ${v.kind}::text ELSE kind END,
        recipe_type_id     = CASE WHEN ${p.recipe_type_id}::boolean THEN ${v.recipe_type_id}::uuid ELSE recipe_type_id END,
        link_url           = CASE WHEN ${p.link_url}::boolean THEN ${v.link_url}::text ELSE link_url END,
        notes              = CASE WHEN ${p.notes}::boolean THEN ${v.notes}::text ELSE notes END,
        keeps_n            = CASE WHEN ${p.keeps}::boolean THEN ${v.keeps_n}::int ELSE keeps_n END,
        keeps_unit         = CASE WHEN ${p.keeps}::boolean THEN ${v.keeps_unit}::text ELSE keeps_unit END,
        keeps_storage_kind = CASE WHEN ${p.keeps}::boolean THEN ${v.keeps_storage_kind}::text ELSE keeps_storage_kind END,
        vessel_label       = CASE WHEN ${p.vessel_label}::boolean THEN ${v.vessel_label}::text ELSE vessel_label END,
        vessel_size        = CASE WHEN ${p.vessel_size}::boolean THEN ${v.vessel_size}::numeric ELSE vessel_size END,
        vessel_unit        = CASE WHEN ${p.vessel_size}::boolean THEN ${v.vessel_unit}::text ELSE vessel_unit END,
        vessel_count       = CASE WHEN ${p.vessel_count}::boolean THEN ${v.vessel_count}::smallint ELSE vessel_count END,
        no_salt            = CASE WHEN ${p.no_salt}::boolean THEN ${v.no_salt}::boolean ELSE no_salt END,
        mash_in_g          = CASE WHEN ${p.mash_in_g}::boolean THEN ${v.mash_in_g}::numeric ELSE mash_in_g END,
        made_g             = CASE WHEN ${p.made_g}::boolean THEN ${v.made_g}::numeric ELSE made_g END,
        made_text          = CASE WHEN ${p.made_text}::boolean THEN ${v.made_text}::text ELSE made_text END,
        bottle_label       = CASE WHEN ${p.bottle_label}::boolean THEN ${v.bottle_label}::text ELSE bottle_label END,
        bottle_size        = CASE WHEN ${p.bottle_size}::boolean THEN ${v.bottle_size}::numeric ELSE bottle_size END,
        bottle_unit        = CASE WHEN ${p.bottle_size}::boolean THEN ${v.bottle_unit}::text ELSE bottle_unit END,
        bottle_cooked      = CASE WHEN ${p.bottle_cooked}::boolean THEN ${v.bottle_cooked}::boolean ELSE bottle_cooked END
      WHERE id = ${recipeId}::uuid
        AND user_id = ANY(${householdIds})
        AND deleted_at IS NULL
      RETURNING id
    ), gone AS (
      UPDATE recipe_ingredient i SET deleted_at = now()
      FROM r
      WHERE ${p.lines}::boolean AND i.recipe_id = r.id AND i.deleted_at IS NULL
      RETURNING i.id
    ), l AS (
      INSERT INTO recipe_ingredient (
        recipe_id, ordinal, name, amount_text, qty, qty_unit, at_the_end, form, brand, role, note,
        shu_rating_low, shu_rating_high, salt_pct, salt_base, base_g, salt_method, base_from
      )
      SELECT r.id, u.ordinal, u.name, u.amount_text, u.qty, u.qty_unit, u.at_the_end, u.form, u.brand, u.role,
             u.note, u.shu_rating_low, u.shu_rating_high, u.salt_pct, u.salt_base, u.base_g, u.salt_method,
             u.base_from
      FROM r, unnest(
        ${c.ordinal}::int[], ${c.name}::text[], ${c.amount_text}::text[], ${c.qty}::numeric[], ${c.qty_unit}::text[],
        ${c.at_the_end}::boolean[], ${c.form}::text[], ${c.brand}::text[], ${c.role}::text[], ${c.note}::text[],
        ${c.shu_rating_low}::int[], ${c.shu_rating_high}::int[], ${c.salt_pct}::numeric[], ${c.salt_base}::text[],
        ${c.base_g}::numeric[], ${c.salt_method}::text[], ${c.base_from}::text[]
      ) AS u(ordinal, name, amount_text, qty, qty_unit, at_the_end, form, brand, role, note,
             shu_rating_low, shu_rating_high, salt_pct, salt_base, base_g, salt_method, base_from)
      WHERE ${p.lines}::boolean
      RETURNING id
    )
    SELECT r.id, (SELECT count(*) FROM gone)::int AS taken_out, (SELECT count(*) FROM l)::int AS put_in FROM r
  `;
  if (!rows.length) return notFound;
  const recipe = await readRecipe(sql, recipeId, householdIds);
  return { status: 200, body: { recipe } };
}

// ── DELETE /api/recipes/:id — soft, the recipe and its live lines in one statement ──────────────────
// A batch made from it keeps its recipe_id (history); the batch surface stops naming a removed recipe.
async function deleteRecipe(sql, recipeId, householdIds) {
  const rows = await sql`
    WITH r AS (
      UPDATE recipe SET deleted_at = now()
      WHERE id = ${recipeId}::uuid
        AND user_id = ANY(${householdIds})
        AND deleted_at IS NULL
      RETURNING id
    ), l AS (
      UPDATE recipe_ingredient i SET deleted_at = now()
      FROM r
      WHERE i.recipe_id = r.id AND i.deleted_at IS NULL
      RETURNING i.id
    )
    SELECT r.id FROM r
  `;
  if (!rows.length) return notFound;
  return { status: 200, body: { ok: true } };
}

// ── POST /api/recipes/from-batch/:batchId — "Save as recipe" (V4 §2.6; F §1.5) ─────────────────────
// ONE statement. It reads, household-scoped, every column F §1.5 says a batch hands a recipe without retyping:
// the batch's label (the default name), kind, vessel (label/size/unit/count) and "No salt"; every LIVE line's
// name, amount (qty + unit, and the same written as text), form, brand, listed heat, note, order, sitting
// membership (a line added at a bottling = "at the end") and salt facts (role, salt_pct, salt_base, base_g,
// salt_method, base_from); and from the live (un-voided) bottlings, Made (the put_up rows' amount in g) and
// mash_in_g, summed across sittings so ratio scaling can be derived; and (Dave 2026-09-30) the final
// container — the first bottling's first row's container, size of each and "cooked after blending" — as
// bottle_*. Method, day gates, scale rules, targets and serve notes come across ONLY as notes: the batch's notes verbatim, its brine note, "Following: <recipe_ref>"
// and its "Next time…" rows. No stage note, no reading, no pH (V4 "pH"). The batch is linked to the new recipe
// when it follows none yet (it was made this way).
async function fromBatch(sql, batchId, body, userId, householdIds) {
  const verr = validateFromBatch(body);
  if (verr) return bad(verr);
  if (body.recipe_type_id != null && !(await loadOwnedRecipeType(sql, body.recipe_type_id, householdIds))) {
    return bad('that type does not match a recipe type you can use');
  }
  const name = body.name == null ? null : body.name.trim();
  let rows;
  try {
    rows = await sql`
      WITH b AS (
        SELECT v.id, v.label, v.kind, v.notes, v.brine_note, v.recipe_ref, v.vessel_label, v.vessel_size,
               v.vessel_unit, v.vessel_count, v.no_salt
        FROM v_kitchen_batch_current v
        WHERE v.id = ${batchId}::uuid
          AND v.user_id = ANY(${householdIds})
          AND v.deleted_at IS NULL
      ), sit AS (
        SELECT sum(sl.amount) FILTER (WHERE sl.amount_unit = 'g' AND sl.amount > 0) AS made_g,
               sum(sl.mash_in_g) FILTER (WHERE sl.mash_in_g > 0) AS mash_in_g
        FROM kitchen_stage_log sl
        JOIN b ON sl.batch_id = b.id
        WHERE sl.stage_kind = 'put_up'
          AND NOT EXISTS (SELECT 1 FROM kitchen_stage_log x WHERE x.voids_id = sl.id)
      ), nx AS (
        SELECT string_agg(btrim(sl.note), E'\n' ORDER BY sl.entered_at NULLS LAST, sl.created_at, sl.id) AS next_time
        FROM kitchen_stage_log sl
        JOIN b ON sl.batch_id = b.id
        WHERE sl.stage_kind = 'noted' AND btrim(COALESCE(sl.note, '')) <> ''
          AND NOT EXISTS (SELECT 1 FROM kitchen_stage_log x WHERE x.voids_id = sl.id)
      ), jar AS (
        -- The final container (Dave 2026-09-30): the FIRST row of the first live bottling — its container name,
        -- the size of EACH (quantity_value is the total, so ÷ package_count) when its unit is one a recipe can
        -- hold, and "cooked after blending".
        SELECT f.bottle_label, f.each_size AS bottle_size,
               CASE WHEN f.each_size IS NOT NULL THEN f.quantity_unit END AS bottle_unit, f.bottle_cooked
        FROM (
          SELECT NULLIF(btrim(p.container_label), '') AS bottle_label, p.quantity_unit, p.cooked AS bottle_cooked,
                 NULLIF(CASE WHEN p.quantity_unit = ANY(${KITCHEN_UNITS}::text[]) AND p.quantity_value > 0
                                  AND p.package_count > 0
                             THEN trim_scale(round(p.quantity_value / p.package_count, 2)) END, 0) AS each_size
          FROM preservation_log p
          JOIN kitchen_stage_log sl ON sl.id = p.put_up_stage_id
          JOIN b ON p.batch_id = b.id
          WHERE p.deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM kitchen_stage_log x WHERE x.voids_id = sl.id)
          ORDER BY sl.entered_at NULLS LAST, sl.created_at, p.created_at, p.id
          LIMIT 1
        ) f
      ), r AS (
        INSERT INTO recipe (
          user_id, name, kind, recipe_type_id, notes, vessel_label, vessel_size, vessel_unit, vessel_count, no_salt,
          mash_in_g, made_g, bottle_label, bottle_size, bottle_unit, bottle_cooked, idempotency_key
        )
        SELECT ${userId}::text, COALESCE(${name}::text, left(btrim(b.label), 120)), b.kind, ${body.recipe_type_id ?? null}::uuid,
               NULLIF(left(concat_ws(E'\n\n',
                 NULLIF(btrim(b.notes), ''),
                 'Brine: ' || NULLIF(btrim(b.brine_note), ''),
                 'Following: ' || NULLIF(btrim(b.recipe_ref), ''),
                 'Next time: ' || nx.next_time), 20000), ''),
               b.vessel_label, b.vessel_size, b.vessel_unit, b.vessel_count, b.no_salt,
               sit.mash_in_g, sit.made_g, jar.bottle_label, jar.bottle_size, jar.bottle_unit, jar.bottle_cooked,
               ${body.idempotency_key}::uuid
        FROM b CROSS JOIN sit CROSS JOIN nx LEFT JOIN jar ON true
        RETURNING id
      ), l AS (
        INSERT INTO recipe_ingredient (
          recipe_id, ordinal, name, amount_text, qty, qty_unit, at_the_end, form, brand, role, note,
          shu_rating_low, shu_rating_high, salt_pct, salt_base, base_g, salt_method, base_from
        )
        SELECT r.id,
               (row_number() OVER (ORDER BY (i.put_up_stage_id IS NOT NULL), i.ordinal NULLS FIRST, i.added_at, i.id))::int,
               left(COALESCE(NULLIF(btrim(i.label), ''), NULLIF(btrim(i.source_label), ''), 'Unnamed line'), 200),
               CASE WHEN i.qty > 0 AND i.qty_unit IS NOT NULL THEN trim_scale(i.qty)::text || ' ' || i.qty_unit END,
               CASE WHEN i.qty > 0 AND i.qty_unit IS NOT NULL THEN i.qty END,
               CASE WHEN i.qty > 0 AND i.qty_unit IS NOT NULL THEN i.qty_unit END,
               (i.put_up_stage_id IS NOT NULL),
               i.form, i.brand, i.role, NULLIF(btrim(i.note), ''), i.shu_rating_low, i.shu_rating_high,
               i.salt_pct, i.salt_base, i.base_g, i.salt_method, i.base_from
        FROM r, b
        JOIN kitchen_batch_input i ON i.batch_id = b.id
        WHERE i.deleted_at IS NULL
        RETURNING id
      ), link AS (
        UPDATE kitchen_batch kb SET recipe_id = r.id
        FROM r, b
        WHERE kb.id = b.id AND kb.recipe_id IS NULL
        RETURNING kb.id
      )
      SELECT (SELECT id FROM r) AS id, (SELECT count(*) FROM l)::int AS line_count,
             (SELECT count(*) FROM link)::int AS linked
    `;
  } catch (err) {
    if (err?.code === '23505' && err.constraint === 'uq_recipe_idempotency_key') {
      return (await replayRecipe(sql, body.idempotency_key, householdIds)) ?? keyConflict;
    }
    throw err;
  }
  if (!rows.length || rows[0].id == null) return notFound;
  const recipe = await readRecipe(sql, rows[0].id, householdIds);
  return { status: 201, body: { recipe, batch_linked: rows[0].linked > 0 } };
}

// ── types (Dave 2026-09-30: "create a type"; the crop_types / place find-or-create precedent) ────────
async function listTypes(sql, householdIds) {
  const rows = await sql`
    SELECT id, label, sort_order, user_id, (user_id IS NULL) AS builtin
    FROM recipe_type
    WHERE deleted_at IS NULL
      AND (user_id IS NULL OR user_id = ANY(${householdIds}))
    ORDER BY (user_id IS NULL) DESC, sort_order, lower(label), id
  `;
  return { status: 200, body: { types: rows } };
}

// Find-or-create on lower(btrim(label)), ONE statement: a live built-in wins, then a live household type, then
// the caller's own soft-deleted one is RESTORED (the crop_types rule: Soft-Delete-Only means it never left),
// else a new row under the caller. The per-owner UNIQUE is the race backstop: a concurrent tap's row comes back
// through ON CONFLICT … DO UPDATE (a no-op write that returns it), the 1b place-create pattern.
async function createType(sql, body, userId, householdIds) {
  const verr = validateTypeCreate(body);
  if (verr) return bad(verr);
  const label = typeLabelOf(body.label);
  const rows = await sql`
    WITH found AS (
      SELECT t.id, t.label, t.sort_order, t.user_id, (t.user_id IS NULL) AS builtin
      FROM recipe_type t
      WHERE lower(btrim(t.label)) = lower(${label}::text)
        AND t.deleted_at IS NULL
        AND (t.user_id IS NULL OR t.user_id = ANY(${householdIds}))
      ORDER BY (t.user_id IS NULL) DESC, (t.user_id = ${userId}::text) DESC, t.created_at, t.id
      LIMIT 1
    ), restored AS (
      UPDATE recipe_type t SET deleted_at = NULL
      WHERE NOT EXISTS (SELECT 1 FROM found)
        AND t.id = (SELECT d.id FROM recipe_type d
                     WHERE d.user_id = ${userId}::text AND d.deleted_at IS NOT NULL
                       AND lower(btrim(d.label)) = lower(${label}::text)
                     ORDER BY d.deleted_at DESC, d.id LIMIT 1)
      RETURNING t.id, t.label, t.sort_order, t.user_id, false AS builtin
    ), made AS (
      INSERT INTO recipe_type (user_id, label)
      SELECT ${userId}::text, ${label}::text
      WHERE NOT EXISTS (SELECT 1 FROM found) AND NOT EXISTS (SELECT 1 FROM restored)
      ON CONFLICT (user_id, lower(btrim(label))) WHERE user_id IS NOT NULL AND deleted_at IS NULL
        DO UPDATE SET label = recipe_type.label
      RETURNING id, label, sort_order, user_id, false AS builtin, (xmax = 0) AS inserted
    )
    SELECT 'found' AS how, id, label, sort_order, user_id, builtin, false AS inserted FROM found
    UNION ALL SELECT 'restored', id, label, sort_order, user_id, builtin, false FROM restored
    UNION ALL SELECT 'made', id, label, sort_order, user_id, builtin, inserted FROM made
  `;
  const r = rows[0];
  const type = { id: r.id, label: r.label, sort_order: r.sort_order, user_id: r.user_id, builtin: r.builtin };
  if (r.how === 'made' && r.inserted) return { status: 201, body: { type, created: true } };
  return { status: 200, body: { type, created: false, ...(r.how === 'restored' ? { restored: true } : {}) } };
}

// A built-in cannot be removed (409 builtin_type); a household type is soft-deleted. Recipes that name it keep
// the id and its label; the picker stops offering it.
async function deleteType(sql, typeId, householdIds) {
  const rows = await sql`
    WITH t AS (
      SELECT id, user_id FROM recipe_type
      WHERE id = ${typeId}::uuid AND deleted_at IS NULL
        AND (user_id IS NULL OR user_id = ANY(${householdIds}))
    ), gone AS (
      UPDATE recipe_type r SET deleted_at = now()
      FROM t
      WHERE r.id = t.id AND t.user_id IS NOT NULL
      RETURNING r.id
    )
    SELECT (SELECT count(*) FROM t)::int AS found, (SELECT count(*) FROM t WHERE user_id IS NULL)::int AS builtin,
           (SELECT count(*) FROM gone)::int AS gone
  `;
  const r = rows[0] ?? {};
  if (!r.found) return notFound;
  if (r.builtin) return { status: 409, body: { error: 'That type comes with the app and stays.', code: 'builtin_type' } };
  return { status: 200, body: { ok: true } };
}
