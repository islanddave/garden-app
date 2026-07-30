// inventory-items-authz.int.test.js — 0A.5 Phase-1 leak-lock for the inventory-items Lambda
// (lambda/inventory-items/index.js). Runs the REAL handler against an ephemeral Neon branch
// (SecretsManager + Clerk stubbed by _harness.js; the SQL layer is REAL). Compensating control for
// the RLS-off posture (see _authz.js header): fails the moment an ownership predicate is dropped.
//
// AUTH MODEL: household-scoped on `created_by = ANY(householdIds)` (+ `deleted_at IS NULL`) on
// GET/:id (index.js:191-192), PUT/:id (:260-261), DELETE/:id (:273-274) and the list (:293/:302).
// With GARDEN_HOUSEHOLD_IDS unset (harness default) householdScope(u) = [u], so OWNER and FOREIGN
// see disjoint sets. Denied status = 404 (the `if (!rows.length)` gate on every id route). Fits the
// generic 4-arm matrix: single-object read + PUT write + soft-delete.
//
// NB the featured_photo_view_url branch in GET/:id presigns S3 ONLY when the row carries a
// featured_photo_id; the seed leaves it null, so resolvePhotoViewUrl short-circuits to null and no
// S3 call happens — this file needs no presigner mock (unlike photos-authz).
import { directSql } from './_harness.js'
import { describeAuthzMatrix } from './_authz.js'
import { handler as inventoryHandler } from '../../lambda/inventory-items/index.js'

describeAuthzMatrix({
  name: 'inventory-items /api/inventory-items/:id',
  handler: inventoryHandler,
  // Durable/tools: satisfies durable_requires_quantity + consumable_fields_null_for_durables and
  // needs no variety_id (chk_inventory_seed_requires_variety only bites category='seeds').
  seedResource: async (owner) => {
    const r = await directSql`
      INSERT INTO inventory_items (user_id, created_by, type, name, category, quantity)
      VALUES (${owner}, ${owner}, 'durable', ${'authz-inv-' + owner}, 'tools', ${1})
      RETURNING id`
    return r[0].id
  },
  read: (id) => ({ method: 'GET', path: `/api/inventory-items/${id}` }),
  // PUT is a FULL replace — type/name/category are NOT NULL, so a partial {name} body would null
  // them (23502 -> 400) and the owner-write arm would fail for the wrong reason. Send a complete,
  // constraint-valid durable payload.
  write: (id) => ({
    method: 'PUT', path: `/api/inventory-items/${id}`,
    body: { name: 'authz-mutated', type: 'durable', category: 'tools', quantity: 1 },
  }),
  softDelete: async (id) => { await directSql`UPDATE inventory_items SET deleted_at = NOW() WHERE id = ${id}` },
  readBack: async (id) => {
    const r = await directSql`SELECT name FROM inventory_items WHERE id = ${id}`
    return r[0] ?? null
  },
  cleanup: async (ctx) => {
    // No entity-registry row for inventory_items; variety_id/featured_photo_id left null, so a plain
    // delete is FK-safe.
    await directSql`DELETE FROM inventory_items WHERE created_by = ${ctx.__owner}`
  },
})
