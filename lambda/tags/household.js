// household.js — Household Mode scope helper (V2 multi-user bridge).
// HOUSEHOLD-MODE: remove at V3-ROLES (DB-layer RLS via current_user_role() replaces this).
// Returns the set of owner Clerk IDs whose rows a request may see/modify.
//
// MEMBERSHIP-GATED: widen to the configured household ONLY when the requester is a member
// of it; otherwise return just their own id. A non-member who authenticates must NEVER see
// the household's data. Fail-closed: empty/unset/whitespace env -> [userId] (single-user).
//
// DEPLOY NOTE: each Lambda is zipped from its OWN directory (deploy-lambda.yml / deploy-staging.yml:
// `cd lambda/<fn> && zip -r ../<fn>.zip .`), so a `../household.js` import is NOT packaged and the
// handler 502s at module load. Therefore an IDENTICAL copy of this file lives in each in-scope
// Lambda dir and is imported as `./household.js`. This file (lambda/household.js) is the canonical
// source + unit-test target; copies are kept byte-identical by lambda/household-copies-sync.test.js.
export function householdScope(userId) {
  const raw = (process.env.GARDEN_HOUSEHOLD_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  return raw.includes(userId) ? raw : [userId];
}
export function householdActive() {
  const raw = (process.env.GARDEN_HOUSEHOLD_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  return raw.length > 1;
}

// ── V4-AUTHZSWEEP-001 — write-FK ownership loaders ────────────────────────────────────────────────
// A cross-entity FK column (plants.location_id, inventory_items.location_id, plants.parent_plant_id,
// …) has a DB-level FK that enforces EXISTENCE but says nothing about OWNERSHIP. Every write path
// that accepts one of these ids from a request body must therefore prove the referenced row is in
// the caller's household BEFORE storing it — otherwise an authenticated user can pin their own row
// to another household's location/planting/item, which (a) writes a cross-household FK and (b) leaks
// the referenced row's fields back through any read surface that JOINs it.
//
// Contract (uniform, mirrors the shipped preservation/index.js loaders):
//   • return the row on success, null on ANY failure — absent id, out-of-household, soft-deleted.
//   • NO existence oracle: callers must answer a null with the same generic 400 they would give for
//     a malformed id, never "not found" vs "forbidden" — that distinction is itself a leak.
//   • owner columns are per-table and were verified against live prod, NOT assumed:
//       locations.created_by · inventory_items.created_by · spaces.created_by
//       garden_node: own created_by OR its container's (container-less plantings exist).
// These live here rather than per-handler so the predicate has ONE canonical home; each Lambda is
// zipped from its own dir, so this file is copied per-dir (see DEPLOY NOTE above) and the copies are
// held byte-identical by lambda/household-copies-sync.test.js.

// Verify a location_id is one the caller may attach to. Soft-deleted locations are rejected.
export async function loadOwnedLocation(sql, locationId, householdIds) {
  const rows = await sql`
    SELECT id, name FROM locations
    WHERE id = ${locationId}
      AND created_by = ANY(${householdIds})
      AND deleted_at IS NULL
  `;
  return rows.length ? rows[0] : null;
}

// Verify an inventory_item_id is one the caller may reference (plants.source_inventory_item_id).
export async function loadOwnedInventoryItem(sql, itemId, householdIds) {
  const rows = await sql`
    SELECT id, name FROM inventory_items
    WHERE id = ${itemId}
      AND created_by = ANY(${householdIds})
      AND deleted_at IS NULL
  `;
  return rows.length ? rows[0] : null;
}

// Verify a planting id (plants.parent_plant_id lineage links). Scope mirrors preservation's
// loadPlanting: EITHER the node's own created_by or its container's, because container-less
// plantings exist and lambda/plants otherwise scopes through the container.
export async function loadOwnedPlanting(sql, plantId, householdIds) {
  const rows = await sql`
    SELECT gn.id, gn.display_name
    FROM garden_node gn
    LEFT JOIN container pp ON pp.id = gn.container_id
    WHERE gn.id = ${plantId}
      AND gn.deleted_at IS NULL
      AND (gn.created_by = ANY(${householdIds}) OR pp.created_by = ANY(${householdIds}))
  `;
  return rows.length ? rows[0] : null;
}

// Verify a space_id. Built for V4-SPACEPHOTO-001 (Lane C) to consume; nothing wires it yet.
// NO deleted_at predicate — the spaces table has no such column (verified live, V-P2).
// ⚠ PREREQUISITE: spaces.created_by is NULLABLE and is NULL on the only live space row, so this
// predicate currently rejects EVERY space. Lane C must backfill spaces.created_by before wiring
// this in, or its attach path will reject all writes. Deliberately strict rather than adding an
// `OR created_by IS NULL` escape, which would make an unowned space writable by any household.
export async function loadOwnedSpace(sql, spaceId, householdIds) {
  const rows = await sql`
    SELECT id, name FROM spaces
    WHERE id = ${spaceId}
      AND created_by = ANY(${householdIds})
  `;
  return rows.length ? rows[0] : null;
}

// Server-side observability for a rejected write-FK. Deliberately one-way: the detail goes to
// CloudWatch, the caller gets only the generic 400 from the call site. A silent reject is
// indistinguishable from a client bug, and this class of failure is exactly what we want to see if
// household membership is ever misconfigured.
export function warnRejectedFk(userId, table, column, value) {
  console.warn(JSON.stringify({ msg: 'authz-fk-reject', userId, table, column, value: value ?? null }));
}
