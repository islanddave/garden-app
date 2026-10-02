// Put-Up release 2 (B′) — the Pantry's routes on the preservation Lambda (V4 §2.5, §4.3, §5.1 rows "2",
// §5.2-§5.4; the pinned B′ cross-lane contract):
//   GET    /api/pantry?group=place|kind&q=&place_id=   put-ups ∪ pantry items, one row shape
//   POST   /api/pantry/items                          keyed create ("As is" / "Fresh, as picked")
//   PATCH  /api/pantry/items/:id                      presence-sentinel edit, Used it up / its Undo, Move
//   DELETE /api/pantry/items/:id                      Remove (logged by mistake) — a soft delete
//   POST   /api/pantry/uses/:id/undo                  the reversing use (Used one / Went bad / Gave it away)
// and removeJar, the body of DELETE /api/preservation/:id (Remove on a put-up), which index.js calls.
// POST /api/pantry/uses itself is F's (pantryUses.js), matched first as a literal; B′ widens its fate there.
//
// WHY A SIBLING MODULE. index.js loads neon, clerk and aws at module scope and cannot be imported by vitest;
// this file takes `sql` as an argument and imports only dependency-free siblings, so every statement below
// is EXECUTED under `npm test` against a mock driver (pantryRoutes.test.js). Same null-for-not-mine
// contract as the kitchen, sources, jar and uses delegations.
//
// AUTHORIZATION (V4 §5.3). Household scope on every read and write (Dave and Jen read and write; a STRANGER
// gets not-found). Every body-settable FK has a household loader: storage_location_id (loadPlace below),
// plant_id (lineRoutes.js loadPlantings), pantry_item_id on a line (pantryItems.js loadPantryItems).
// Server-set only, never read from a body: user_id, created_by, delta_at, remaining_count,
// remaining_amount, deleted_at.
//
// AUDIT. pantry_item is unaudited (V4 §5.5). preservation_log is audited (1b), so the undo and removeJar
// run in sql.transaction([set_config('app.actor_clerk_sub', <sub>, true), <write>]) — the grouping
// lambda/audit-actor-guc.test.js asserts.
import { MASS_G, normalizeText } from './kitchenBatch.js';
import { loadPlantings } from './lineRoutes.js';
import {
  isUuid, validateItemCreate, validateItemPatch, acquiredOf, amountOf, sourceOf, projectItem, jarRow, itemRow,
  sortPantryRows, matchesQuery, PANTRY_GROUPS, PLANTING_SOURCE_REFUSAL,
} from './pantryItems.js';

const MASS_UNITS = Object.keys(MASS_G);
const MASS_FACTORS = Object.values(MASS_G);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const notFound = { status: 404, body: { error: 'Not found', code: 'not_found' } };
const bad = (error) => ({ status: 400, body: { error } });
const refuse = (status, code, error, extra = {}) => ({ status, body: { error, code, ...extra } });
const keyConflict = refuse(409, 'key_conflict', 'That key is already in use.');
const notAllowed = { status: 405, body: { error: 'Method not allowed' } };

// ── routing ──────────────────────────────────────────────────────────────────────────────────────
// Returns { route, id } for a path that is ours, null otherwise. '/api/pantry/uses' is NOT ours (F's
// literal, matched earlier in index.js). The captures are `[^/]+` and the uuid is checked in the handler
// (a malformed id is a 404), so the client↔Lambda route contract can execute the patterns.
export function parsePantryRoute(rawPath) {
  if (typeof rawPath !== 'string') return null;
  if (rawPath === '/api/pantry' || rawPath === '/api/pantry/') return { route: 'list' };
  if (rawPath === '/api/pantry/items' || rawPath === '/api/pantry/items/') return { route: 'items' };
  const item = rawPath.match(/^\/api\/pantry\/items\/([^/]+)\/?$/);
  if (item) return { route: 'item', id: item[1] };
  const undo = rawPath.match(/^\/api\/pantry\/uses\/([^/]+)\/undo\/?$/);
  if (undo) return { route: 'undo', id: undo[1] };
  return null;
}

export async function handlePantryRoute({ sql, rawPath, method, rawBody, query = {}, userId, householdIds, now }) {
  const r = parsePantryRoute(rawPath);
  if (!r) return null;
  const body = () => JSON.parse(rawBody ?? '{}');
  if (r.route === 'list') {
    if (method !== 'GET') return notAllowed;
    return listPantry(sql, query ?? {}, householdIds, now ?? new Date());
  }
  if (r.route === 'items') {
    if (method !== 'POST') return notAllowed;
    return createItem(sql, body(), userId, householdIds);
  }
  if (r.route === 'item') {
    if (method === 'PATCH') return patchItem(sql, r.id, body(), householdIds);
    if (method === 'DELETE') return deleteItem(sql, r.id, householdIds);
    return notAllowed;
  }
  if (method !== 'POST') return notAllowed;
  return undoUse(sql, r.id, body(), userId, householdIds);
}

// ── the place loader (storage_location_id is body-settable here) ───────────────────────────────────
// The index.js loadStorageLocation predicate (user_id in the household, live), returning what the item's
// reply names. null on any failure — no existence oracle.
export async function loadPlace(sql, id, householdIds) {
  if (!isUuid(id)) return null;
  const rows = await sql`
    SELECT s.id, s.label, s.kind FROM storage_location s
    WHERE s.id = ${id}::uuid
      AND s.user_id = ANY(${householdIds})
      AND s.deleted_at IS NULL
  `;
  return rows[0] ?? null;
}

// ── GET /api/pantry ──────────────────────────────────────────────────────────────────────────────
// Put-ups: live, with something left (COALESCE(remaining_count, package_count) > 0) and not consumed. Items:
// live and not used up. The discard-by status is classified here, from the STORED date and basis
// (pantryItems.js discardOf); from_garden for a put-up is F §2.7's jar rule (its source is our garden, or
// any of its live preservation_source rows is) — plus a planting link, which chk_preservation_log_source_plant
// already ties to our garden. Both arms read quantity_value, quantity_unit, source_kind and source_label, so
// both row kinds carry those four AS STORED (R2a: an item's Edit panel is seeded from its list row).
export async function listPantry(sql, query, householdIds, now) {
  const group = PANTRY_GROUPS.includes(query.group) ? query.group : 'place';
  const placeId = normalizeText(query.place_id);
  if (placeId != null && !isUuid(placeId)) return bad('place_id must be a uuid');
  const jars = await sql`
    SELECT p.id, p.user_id, p.label, p.method, p.method_other_text, p.crop_type_slug, p.plant_id, p.batch_id,
           p.package_count, p.remaining_count, p.remaining_amount, p.quantity_value, p.quantity_unit,
           p.preserved_at, p.preserved_at_precision, p.use_by_target, p.use_by_basis, p.storage_location_id,
           p.source_kind, p.source_label, p.notes, p.updated_at,
           s.label AS place_label, s.kind AS place_kind, ct.display_name AS crop_display_name,
           cv.display_name AS variety_name, gn.display_name AS planting_name, gn.sown_at AS planting_sown_at,
           gn.succession_order AS planting_succession_order,
           (p.source_kind IS NOT DISTINCT FROM 'own_garden'
             OR p.plant_id IS NOT NULL
             OR EXISTS (SELECT 1 FROM preservation_source ps
                         WHERE ps.preservation_log_id = p.id
                           AND ps.source_kind = 'own_garden'
                           AND ps.deleted_at IS NULL)) AS from_garden
    FROM preservation_log p
    LEFT JOIN storage_location s ON s.id = p.storage_location_id
    LEFT JOIN crop_types ct ON ct.slug = p.crop_type_slug
    LEFT JOIN cultivar cv ON cv.id = p.variety_id AND cv.deleted_at IS NULL
    LEFT JOIN garden_node gn ON gn.id = p.plant_id AND gn.deleted_at IS NULL
    WHERE p.user_id = ANY(${householdIds})
      AND p.deleted_at IS NULL
      AND COALESCE(p.remaining_count, p.package_count) > 0
      AND p.consumed_at IS NULL
      AND (${placeId}::uuid IS NULL OR p.storage_location_id = ${placeId}::uuid)
  `;
  const items = await sql`
    SELECT i.id, i.user_id, i.name, i.storage_location_id, i.acquired_at, i.acquired_precision, i.use_by_target,
           i.plant_id, i.crop_type_slug, i.notes, i.updated_at,
           i.quantity_value, i.quantity_unit, i.source_kind, i.source_label,
           s.label AS place_label, s.kind AS place_kind, ct.display_name AS crop_display_name,
           gn.display_name AS planting_name, gn.sown_at AS planting_sown_at,
           gn.succession_order AS planting_succession_order
    FROM pantry_item i
    LEFT JOIN storage_location s ON s.id = i.storage_location_id
    LEFT JOIN crop_types ct ON ct.slug = i.crop_type_slug
    LEFT JOIN garden_node gn ON gn.id = i.plant_id AND gn.deleted_at IS NULL
    WHERE i.user_id = ANY(${householdIds})
      AND i.deleted_at IS NULL
      AND i.used_up_at IS NULL
      AND (${placeId}::uuid IS NULL OR i.storage_location_id = ${placeId}::uuid)
  `;
  const rows = [...jars.map((r) => jarRow(r, group, now)), ...items.map((r) => itemRow(r, group, now))]
    .filter((row) => matchesQuery(row, query.q));
  return { status: 200, body: { rows: sortPantryRows(rows) } };
}

// ── POST /api/pantry/items ───────────────────────────────────────────────────────────────────────
// ONE statement: the place found or made (by {kind, label}, the put-up route's find-or-create, trimmed and
// case-insensitive over the household) and the item. A 23505 on uq_pantry_item_idempotency_key (only that
// one) is a replay; a key held outside the household is 409 with no payload. Never ON CONFLICT on the item.
//
// EVERY CHECK ON pantry_item HAS WORDS HERE (R2a adds the nine of migrations/v5-pantryitemamount-001): a
// 23514 with no row below is rethrown and reaches the person as a 500. The validators pre-empt all but one —
// chk_pantry_item_source_plant, which reads the STORED plant_id that a PATCH body cannot carry, so on a PATCH
// the database decides it and this map answers. These are user copy: a cached bundle prints them verbatim.
export const ITEM_CONSTRAINT_MESSAGES = {
  chk_pantry_item_name_nonblank: 'Name what it is (at most 120 characters).',
  chk_pantry_item_acquired_precision: 'That is not a date precision this app knows.',
  chk_pantry_item_acquired_pairing: 'A date needs how sure you are of it, and "not sure" has no date.',
  pantry_item_crop_type_slug_fkey: 'That crop is not one this app knows.',
  chk_pantry_item_quantity_pairing: 'An amount is a number and a unit together. Give both, or clear both.',
  chk_pantry_item_quantity_value: 'The amount must be a number above 0.',
  chk_pantry_item_quantity_unit: 'That is not a unit this app knows.',
  chk_pantry_item_source_kind: 'That is not a source this app knows.',
  chk_pantry_item_source_label_nonblank: 'A source name cannot be blank.',
  chk_pantry_item_source_label_len: 'A source name can be at most 120 characters.',
  chk_pantry_item_source_label_kind: 'A source name needs a source. Say where it came from.',
  chk_pantry_item_source_other: 'Name where it came from.',
  chk_pantry_item_source_plant: PLANTING_SOURCE_REFUSAL,
};
function itemError(err) {
  if (err?.code !== '23514' && err?.code !== '23503') return null;
  const words = ITEM_CONSTRAINT_MESSAGES[String(err.constraint ?? '')];
  return words ? bad(words) : null;
}

export async function createItem(sql, body, userId, householdIds) {
  const verr = validateItemCreate(body);
  if (verr) return bad(verr);
  let place = null;
  if (body.storage_location_id != null) {
    place = await loadPlace(sql, body.storage_location_id, householdIds);
    if (!place) return bad('storage_location_id does not match a place you can use');
  }
  let crop = normalizeText(body.crop_type_slug);
  if (body.plant_id != null) {
    const [planting] = await loadPlantings(sql, [body.plant_id], householdIds);
    if (!planting) return bad('that planting does not match a planting you can use');
    if (crop != null && planting.crop_type_slug != null && crop !== planting.crop_type_slug) {
      return bad('that planting is a different crop');
    }
    crop = crop ?? planting.crop_type_slug ?? null;
  }
  const acq = acquiredOf(body);
  // The amount as logged and where it came from (validated above): a body without them binds NULL for all
  // four, which is the row the pre-R2a writer made.
  const amt = amountOf(body);
  const src = sourceOf(body, body.plant_id ?? null);
  const newKind = place ? null : body.place.kind;
  const newLabel = place ? null : normalizeText(body.place.label);
  let rows;
  try {
    rows = await sql`
      WITH found AS (
        SELECT sl.id, sl.label, sl.kind FROM storage_location sl
        WHERE ${newKind}::text IS NOT NULL
          AND sl.kind = ${newKind}::text AND lower(btrim(sl.label)) = lower(${newLabel}::text)
          AND sl.user_id = ANY(${householdIds}) AND sl.deleted_at IS NULL
        ORDER BY (sl.user_id = ${userId}::text) DESC, sl.created_at, sl.id
        LIMIT 1
      ), made AS (
        INSERT INTO storage_location (user_id, label, kind)
        SELECT ${userId}::text, ${newLabel}::text, ${newKind}::text
        WHERE ${newKind}::text IS NOT NULL AND NOT EXISTS (SELECT 1 FROM found)
        ON CONFLICT (user_id, kind, lower(label)) WHERE deleted_at IS NULL
          DO UPDATE SET label = storage_location.label
        RETURNING id, label, kind
      ), place AS (
        SELECT id, label, kind FROM found
        UNION ALL SELECT id, label, kind FROM made
        UNION ALL SELECT ${place?.id ?? null}::uuid, ${place?.label ?? null}::text, ${place?.kind ?? null}::text
                   WHERE ${place?.id ?? null}::uuid IS NOT NULL
      ), ins AS (
        INSERT INTO pantry_item (
          user_id, name, storage_location_id, acquired_at, acquired_precision, use_by_target, plant_id,
          crop_type_slug, notes, quantity_value, quantity_unit, source_kind, source_label, idempotency_key
        )
        SELECT ${userId}::text, ${body.name.trim()}::text, (SELECT id FROM place LIMIT 1),
               ${acq.acquired_at}::date, ${acq.acquired_precision}::text, ${body.use_by_target ?? null}::date,
               ${body.plant_id ?? null}::uuid, ${crop}::text, ${normalizeText(body.notes)}::text,
               ${amt.quantity_value}::numeric, ${amt.quantity_unit}::text,
               ${src.source_kind}::text, ${src.source_label}::text,
               ${body.idempotency_key}::uuid
        RETURNING id, user_id, name, storage_location_id, acquired_at, acquired_precision, use_by_target,
                  plant_id, crop_type_slug, quantity_value, quantity_unit, source_kind, source_label,
                  used_up_at, notes, created_at, updated_at, deleted_at
      )
      SELECT ins.*, place.label AS place_label, place.kind AS place_kind
      FROM ins LEFT JOIN place ON place.id = ins.storage_location_id
    `;
  } catch (err) {
    if (err?.code === '23505' && err.constraint === 'uq_pantry_item_idempotency_key') {
      return replayItem(sql, body.idempotency_key, householdIds);
    }
    const r = itemError(err);
    if (r) return r;
    throw err;
  }
  return { status: 201, body: { item: projectItem(rows[0]) } };
}

async function replayItem(sql, key, householdIds) {
  const prior = await sql`
    SELECT i.id, i.user_id, i.name, i.storage_location_id, i.acquired_at, i.acquired_precision,
           i.use_by_target, i.plant_id, i.crop_type_slug, i.quantity_value, i.quantity_unit, i.source_kind,
           i.source_label, i.used_up_at, i.notes, i.created_at, i.updated_at,
           i.deleted_at, s.label AS place_label, s.kind AS place_kind
    FROM pantry_item i
    LEFT JOIN storage_location s ON s.id = i.storage_location_id
    WHERE i.idempotency_key = ${key}::uuid
      AND i.user_id = ANY(${householdIds})
  `;
  if (!prior.length) return keyConflict;
  return { status: 200, body: { item: projectItem(prior[0]), replayed: true } };
}

// ── PATCH /api/pantry/items/:id ──────────────────────────────────────────────────────────────────
// Presence-sentinel over ITEM_PATCH_KEYS: an absent key is unchanged. used_up_at "now" stamps it (keeping
// an earlier stamp — a retried tap is a no-op) and null clears it (Undo). A move is storage_location_id
// (household-loaded). Works on a used-up item (that is how Undo reaches it); a removed one is 404.
// The amount pair and the source pair each travel together (the validator refuses one alone), so ONE flag
// writes both columns of a pair: null, null clears the amount, or un-chooses the source. A source that is
// not our garden on an item tied to a planting is refused by chk_pantry_item_source_plant in the UPDATE
// itself — the stored plant_id is the database's to read — and answered in words (itemError).
export async function patchItem(sql, itemId, body, householdIds) {
  if (!isUuid(itemId)) return notFound;
  const verr = validateItemPatch(body);
  if (verr) return bad(verr);
  const p = Object.fromEntries([
    'name', 'storage_location_id', 'acquired_at', 'use_by_target', 'notes', 'used_up_at', 'quantity_value', 'source_kind',
  ].map((k) => [k, has(body, k)]));
  if (p.storage_location_id && !(await loadPlace(sql, body.storage_location_id, householdIds))) {
    return bad('storage_location_id does not match a place you can use');
  }
  const acq = p.acquired_at ? acquiredOf(body) : { acquired_at: null, acquired_precision: null };
  const amt = p.quantity_value ? amountOf(body) : { quantity_value: null, quantity_unit: null };
  const src = p.source_kind ? sourceOf(body) : { source_kind: null, source_label: null };
  let rows;
  try {
    rows = await sql`
      WITH upd AS (
        UPDATE pantry_item SET
          name                = CASE WHEN ${p.name}::boolean THEN ${p.name ? body.name.trim() : null}::text ELSE name END,
          storage_location_id = CASE WHEN ${p.storage_location_id}::boolean THEN ${body.storage_location_id ?? null}::uuid
                                     ELSE storage_location_id END,
          acquired_at         = CASE WHEN ${p.acquired_at}::boolean THEN ${acq.acquired_at}::date ELSE acquired_at END,
          acquired_precision  = CASE WHEN ${p.acquired_at}::boolean THEN ${acq.acquired_precision}::text ELSE acquired_precision END,
          use_by_target       = CASE WHEN ${p.use_by_target}::boolean THEN ${body.use_by_target ?? null}::date ELSE use_by_target END,
          notes               = CASE WHEN ${p.notes}::boolean THEN ${normalizeText(body.notes)}::text ELSE notes END,
          quantity_value      = CASE WHEN ${p.quantity_value}::boolean THEN ${amt.quantity_value}::numeric ELSE quantity_value END,
          quantity_unit       = CASE WHEN ${p.quantity_value}::boolean THEN ${amt.quantity_unit}::text ELSE quantity_unit END,
          source_kind         = CASE WHEN ${p.source_kind}::boolean THEN ${src.source_kind}::text ELSE source_kind END,
          source_label        = CASE WHEN ${p.source_kind}::boolean THEN ${src.source_label}::text ELSE source_label END,
          used_up_at          = CASE WHEN NOT ${p.used_up_at}::boolean THEN used_up_at
                                     WHEN ${body.used_up_at === 'now'}::boolean THEN COALESCE(used_up_at, now())
                                     ELSE NULL END
        WHERE id = ${itemId}::uuid
          AND user_id = ANY(${householdIds})
          AND deleted_at IS NULL
        RETURNING id, user_id, name, storage_location_id, acquired_at, acquired_precision, use_by_target,
                  plant_id, crop_type_slug, quantity_value, quantity_unit, source_kind, source_label,
                  used_up_at, notes, created_at, updated_at, deleted_at
      )
      SELECT upd.*, s.label AS place_label, s.kind AS place_kind
      FROM upd LEFT JOIN storage_location s ON s.id = upd.storage_location_id
    `;
  } catch (err) {
    const r = itemError(err);
    if (r) return r;
    throw err;
  }
  if (!rows.length) return notFound;
  return { status: 200, body: { item: projectItem(rows[0]) } };
}

// ── DELETE /api/pantry/items/:id — Remove (logged by mistake), a soft delete ───────────────────────
// A line that already named the item keeps its stamped label; the item stays a record (V4 §2.5 "Bought
// items": "Remove (logged by mistake; a soft delete)"). A second DELETE matches nothing → 404.
export async function deleteItem(sql, itemId, householdIds) {
  if (!isUuid(itemId)) return notFound;
  const rows = await sql`
    UPDATE pantry_item SET deleted_at = now()
    WHERE id = ${itemId}::uuid
      AND user_id = ANY(${householdIds})
      AND deleted_at IS NULL
    RETURNING id
  `;
  if (!rows.length) return notFound;
  return { status: 200, body: { ok: true } };
}

// ── POST /api/pantry/uses/:id/undo ───────────────────────────────────────────────────────────────
// The reversing row (count −n, reverses_use_id = the use, the same fate) and the increment, in ONE
// statement, read from the use and its jar household-scoped. Refused (409): a batch-linked use
// (use_is_batch_line — taking its line out reverses it), a row that is itself a reversal
// (use_is_reversal), a use already undone under another key (already_undone; uq_pantry_use_reverses_use_id
// is the backstop for two phones at once), a removed jar (jar_removed), and a count the jar can no longer
// hold (count_changed — the count was lowered since). The key is the undo tap's own: the same key again
// is a replay (200 replayed), a key used for anything else is key_conflict.
//   * delta_at is stamped (06 §1.3 item 5: every non-legacy UPDATE that moves remaining_count).
//   * consumed_at is cleared: after the increment something is left.
//   * A WEIGHED jar that the use took to 0 g (pantryUses.js sets remaining_amount 0 there) gets its grams
//     back as the bag's weight less its live weighed draws (lines of kind put_up with no pantry_use — F's
//     definition of a weighed draw). The grams the tap zeroed are not recorded anywhere else.
export async function undoUse(sql, useId, body, userId, householdIds) {
  if (!isUuid(useId)) return notFound;
  const key = body?.idempotency_key ?? null;
  if (body == null || typeof body !== 'object' || Array.isArray(body)) return bad('body required');
  const unknown = Object.keys(body).filter((k) => k !== 'idempotency_key');
  if (unknown.length) return bad(`unknown field(s): ${unknown.join(', ')}`);
  if (!isUuid(key)) return bad('idempotency_key must be a uuid');
  let rows;
  try {
    [, rows] = await sql.transaction([
      sql`SELECT set_config('app.actor_clerk_sub', ${userId}, true)`,
      sql`
      WITH prior AS (
        SELECT r.id, r.reverses_use_id FROM pantry_use r WHERE r.idempotency_key = ${key}::uuid
      ), fwd AS (
        SELECT u.id, u.preservation_log_id, u.count_used, u.fate, u.kitchen_batch_input_id, u.reverses_use_id
        FROM pantry_use u
        JOIN preservation_log p ON p.id = u.preservation_log_id
        WHERE u.id = ${useId}::uuid
          AND p.user_id = ANY(${householdIds})
      ), done AS (
        SELECT r.id FROM pantry_use r WHERE r.reverses_use_id = ${useId}::uuid
      ), ok AS (
        SELECT fwd.id, fwd.preservation_log_id, fwd.count_used, fwd.fate FROM fwd
        WHERE NOT EXISTS (SELECT 1 FROM prior)
          AND NOT EXISTS (SELECT 1 FROM done)
          AND fwd.count_used > 0
          AND fwd.reverses_use_id IS NULL
          AND fwd.kitchen_batch_input_id IS NULL
      ), mass AS (
        SELECT m.unit, m.factor FROM unnest(${MASS_UNITS}::text[], ${MASS_FACTORS}::numeric[]) AS m(unit, factor)
      ), jar AS (
        UPDATE preservation_log p SET
          remaining_count  = COALESCE(p.remaining_count, p.package_count) + ok.count_used,
          delta_at         = now(),
          consumed_at      = NULL,
          remaining_amount = CASE WHEN p.package_count = 1 AND p.quantity_unit = ANY(${MASS_UNITS}::text[])
                                   AND p.remaining_amount = 0
                                  THEN GREATEST(
                                         p.quantity_value * (SELECT factor FROM mass WHERE unit = p.quantity_unit)
                                         - COALESCE((SELECT sum(i.qty * (SELECT factor FROM mass WHERE unit = i.qty_unit))
                                                       FROM kitchen_batch_input i
                                                      WHERE i.preservation_log_id = p.id
                                                        AND i.input_kind = 'put_up'
                                                        AND i.deleted_at IS NULL
                                                        AND NOT EXISTS (SELECT 1 FROM pantry_use lu
                                                                         WHERE lu.kitchen_batch_input_id = i.id)), 0),
                                         0)
                                  ELSE p.remaining_amount END
        FROM ok
        WHERE p.id = ok.preservation_log_id
          AND p.user_id = ANY(${householdIds})
          AND p.deleted_at IS NULL
        RETURNING p.id, p.remaining_count, p.consumed_at, p.remaining_amount, ok.count_used AS n, ok.fate,
                  ok.id AS use_id
      ), rev AS (
        INSERT INTO pantry_use (created_by, preservation_log_id, count_used, fate, reverses_use_id, idempotency_key)
        SELECT ${userId}::text, jar.id, -jar.n, jar.fate, jar.use_id, ${key}::uuid FROM jar
        RETURNING id, created_by, preservation_log_id, count_used, fate, kitchen_batch_input_id,
                  reverses_use_id, idempotency_key, used_at, note, created_at
      )
      SELECT (SELECT row_to_json(prior) FROM prior LIMIT 1) AS prior,
             (SELECT row_to_json(fwd) FROM fwd) AS fwd,
             (SELECT count(*)::int FROM done) AS done_n,
             (SELECT row_to_json(rev) FROM rev) AS use,
             (SELECT json_build_object('id', jar.id, 'remaining_count', jar.remaining_count,
                                       'consumed_at', jar.consumed_at, 'remaining_amount', jar.remaining_amount)
                FROM jar) AS jar
    `,
    ]);
  } catch (err) {
    if (err?.code === '23505' && err.constraint === 'uq_pantry_use_idempotency_key') {
      return replayUndo(sql, useId, key, householdIds);
    }
    if (err?.code === '23505' && err.constraint === 'uq_pantry_use_reverses_use_id') return ALREADY_UNDONE;
    if (err?.code === '23514' && err.constraint === 'chk_preservation_log_remaining_within_package') {
      return COUNT_CHANGED;
    }
    throw err;
  }
  const r = rows[0] ?? {};
  if (r.prior) return replayUndo(sql, useId, key, householdIds);
  if (!r.fwd) return notFound;
  if (r.fwd.kitchen_batch_input_id != null) {
    return refuse(409, 'use_is_batch_line', 'That went into a batch — take the line out there to put it back.');
  }
  if (r.fwd.reverses_use_id != null || Number(r.fwd.count_used) < 0) {
    return refuse(409, 'use_is_reversal', 'That was already an undo.');
  }
  if (r.done_n > 0) return ALREADY_UNDONE;
  if (!r.use) return refuse(409, 'jar_removed', 'That jar was removed.');
  return { status: 200, body: { use: r.use, jar: r.jar } };
}

const ALREADY_UNDONE = refuse(409, 'already_undone', 'That was already undone.');
const COUNT_CHANGED = refuse(409, 'count_changed', 'The count on that jar changed since. Refresh and try again.');

// The replay: the reversal under this key, read household-scoped through its jar. It must be the reversal
// of THIS use; the key on anything else (another use, a Mark used tap) is key_conflict.
async function replayUndo(sql, useId, key, householdIds) {
  const prior = await sql`
    SELECT row_to_json(u) AS use,
           json_build_object('id', p.id, 'remaining_count', p.remaining_count,
                             'consumed_at', p.consumed_at, 'remaining_amount', p.remaining_amount) AS jar
    FROM pantry_use u
    JOIN preservation_log p ON p.id = u.preservation_log_id
    WHERE u.idempotency_key = ${key}::uuid
      AND u.reverses_use_id = ${useId}::uuid
      AND p.user_id = ANY(${householdIds})
  `;
  if (!prior.length) return keyConflict;
  return { status: 200, body: { replayed: true, use: prior[0].use, jar: prior[0].jar } };
}

// ── DELETE /api/preservation/:id — Remove on a put-up (V4 §2.5 "Remove") ─────────────────────────────
// Remove means logged by mistake. Refused, with the reason and a path, on a jar that was used (the net of
// its non-batch uses is above 0 — Used one, Used up, Went bad, Gave it away that were not undone) or that
// has a live batch line drawing from it (a draw, counted or weighed). Otherwise the shipped soft delete.
// ONE statement: the checks and the UPDATE read the same snapshot. preservation_log is audited
// (deleted_at is watched), so it rides the actor GUC.
export async function removeJar(sql, jarId, userId, householdIds) {
  if (!isUuid(jarId)) return notFound;
  const [, rows] = await sql.transaction([
    sql`SELECT set_config('app.actor_clerk_sub', ${userId}, true)`,
    sql`
    WITH jar AS (
      SELECT p.id FROM preservation_log p
      WHERE p.id = ${jarId}::uuid
        AND p.user_id = ANY(${householdIds})
        AND p.deleted_at IS NULL
    ), used AS (
      SELECT COALESCE(sum(u.count_used), 0)::int AS n FROM pantry_use u
      WHERE u.preservation_log_id = ${jarId}::uuid
        AND u.kitchen_batch_input_id IS NULL
    ), lines AS (
      SELECT i.id, b.label FROM kitchen_batch_input i
      LEFT JOIN kitchen_batch b ON b.id = i.batch_id
      WHERE i.preservation_log_id = ${jarId}::uuid
        AND i.deleted_at IS NULL
    ), del AS (
      UPDATE preservation_log p SET deleted_at = now()
      FROM jar
      WHERE p.id = jar.id
        AND (SELECT n FROM used) <= 0
        AND NOT EXISTS (SELECT 1 FROM lines)
      RETURNING p.id
    )
    SELECT (SELECT count(*)::int FROM jar) AS found,
           (SELECT n FROM used) AS used_n,
           (SELECT count(*)::int FROM lines) AS line_n,
           (SELECT label FROM lines LIMIT 1) AS batch_label,
           (SELECT count(*)::int FROM del) AS removed
  `,
  ]);
  const r = rows[0] ?? {};
  if (!r.found) return notFound;
  if (r.removed) return { status: 200, body: { ok: true } };
  if (Number(r.used_n) > 0) {
    const n = Number(r.used_n);
    return refuse(409, 'jar_was_used',
      `${n} ${n === 1 ? 'was' : 'were'} used — mark the rest Went bad, or undo that use.`, { n });
  }
  return refuse(409, 'jar_in_batch',
    `Some of it went into ${r.batch_label ? `“${r.batch_label}”` : 'a batch'} — take that line out first.`,
    { lines: Number(r.line_n) });
}
