// BUG-INVREFSTRAND-001 — the pre-delete reference check, and why the database cannot do it for us.
//
// THE DEFECT. Four foreign keys point at inventory_items, two of them ON DELETE RESTRICT:
//
//   plants.source_inventory_item_id          RESTRICT
//   photos.inventory_item_id                 RESTRICT
//   seed_lot_stage_log.inventory_item_id     NO ACTION
//   event_log.treatment_product_id           NO ACTION
//
// NONE of them ever fires, because this handler's DELETE is `UPDATE inventory_items SET
// deleted_at = NOW()`. A soft delete is an UPDATE, and an FK guards DELETEs. So the row survives,
// every referencing row keeps a technically-valid pointer, and every read path — all of which
// filter `deleted_at IS NULL` — stops resolving it. Silently, with no error, on a 200.
//
// WHAT THAT COSTS, in this handler's own code:
//   • the /seed-stage GET joins `public.inventory_items i ... AND i.deleted_at IS NULL` and then
//     resp(200, rows). Soft-delete the lot and its stage history returns HTTP 200 + [] —
//     indistinguishable from "this lot has no history". Measured on live prod 2026-09-08: one
//     fermenting entry logged 2026-09-07 is already in exactly this state.
//   • lambda/plants/index.js returns source_inventory_item_id raw with no join, so the planting
//     keeps an id that resolves to nothing and seed -> plant provenance breaks quietly. Also live:
//     one archived planting ("Hungarian", Black Hungarian) points at a deleted seed row.
//
// WHY A CHECK HERE CLOSES THE APP-SIDE PATH COMPLETELY. Every writer of these four columns already
// refuses to point at a deleted item: lambda/plants/household.js's loadOwnedInventoryItem filters
// `deleted_at IS NULL`, and so does the /seed-stage CTE. A strand can therefore only be created by
// deleting AFTER pointing — i.e. here. This is the single choke point.
//
// IT IS NOT THE WHOLE STORY, deliberately. Hand-written SQL bypasses this entirely, and the two
// findings above predate it. migrations/v5-invrefstrand-001/gates.yml is the detection half and
// covers what a handler cannot see.

// The four relations, named by their real constraint so the census gate in that migration and this
// list can be compared against pg_constraint rather than against each other. Adding a fifth FK to
// inventory_items requires adding it BOTH here and there — post_inventory_fk_census_is_unchanged
// reds until it is.
export const REFERRING_RELATIONS = Object.freeze([
  { table: 'plants', column: 'source_inventory_item_id',
    constraint: 'plants_source_inventory_item_id_fkey', one: 'planting', many: 'plantings' },
  { table: 'photos', column: 'inventory_item_id',
    constraint: 'photos_inventory_item_id_fkey', one: 'photo', many: 'photos' },
  { table: 'seed_lot_stage_log', column: 'inventory_item_id',
    constraint: 'seed_lot_stage_log_inventory_item_id_fkey',
    one: 'seed stage entry', many: 'seed stage entries' },
  { table: 'event_log', column: 'treatment_product_id',
    constraint: 'event_log_treatment_product_id_fkey',
    one: 'treatment event', many: 'treatment events' },
]);

// ONE statement, not four. Each of these is a separate HTTP round trip on the Neon serverless
// driver, and a delete already pays one for the write. Four scalar subqueries in a single SELECT
// answer ownership and all four counts at once.
//
// LIVE referrers only (`deleted_at IS NULL` on the three tables that carry the column;
// seed_lot_stage_log has none). A soft-deleted planting pointing at this item is already invisible
// to everyone, so blocking on it would make the item permanently undeletable to protect nothing.
// The gate in v5-invrefstrand-001 scopes identically on purpose — a preventer and a detector that
// disagree about what counts produce findings the preventer says are fine.
export async function deletePreflight(sql, itemId, householdIds) {
  const rows = await sql`
    SELECT
      (SELECT count(*) FROM inventory_items
        WHERE id = ${itemId} AND created_by = ANY(${householdIds}) AND deleted_at IS NULL)::int
        AS owned,
      (SELECT count(*) FROM public.plants
        WHERE source_inventory_item_id = ${itemId} AND deleted_at IS NULL)::int AS plants,
      (SELECT count(*) FROM public.photos
        WHERE inventory_item_id = ${itemId} AND deleted_at IS NULL)::int AS photos,
      (SELECT count(*) FROM public.seed_lot_stage_log
        WHERE inventory_item_id = ${itemId})::int AS seed_lot_stage_log,
      (SELECT count(*) FROM public.event_log
        WHERE treatment_product_id = ${itemId} AND deleted_at IS NULL)::int AS event_log
  `;
  const row = rows[0] ?? {};
  const blocking = REFERRING_RELATIONS
    .map((rel) => ({ ...rel, count: Number(row[rel.table] ?? 0) }))
    .filter((rel) => rel.count > 0);
  return { found: Number(row.owned ?? 0) > 0, blocking };
}

// The 409 body's message. Names WHAT is in the way and HOW MANY, because "cannot delete" with no
// subject is a dead end for the one person who can act on it — /inventory/:id renders this string
// verbatim in its form error (InventoryDetail.jsx handleDelete -> setErrors({_form: error})), and
// src/lib/api.js turns a non-ok body's `error` into the thrown message that gets there.
export function blockingMessage(blocking) {
  const parts = blocking.map((r) => `${r.count} ${r.count === 1 ? r.one : r.many}`);
  const list = parts.length > 1
    ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
    : parts[0];
  return `Can't delete this — ${list} still point${
    blocking.length === 1 && blocking[0].count === 1 ? 's' : ''
  } at it. Detach or remove ${blocking.length === 1 && blocking[0].count === 1 ? 'it' : 'them'} first.`;
}
