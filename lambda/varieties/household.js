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
//   • a MALFORMED id answers the same null as a foreign one (see UUID_RE below).
//   • callers MUST already have rejected an empty JWT subject with a 401 before calling:
//     householdScope('') returns [''] and `'' = ANY(ARRAY[''])` is TRUE in Postgres, so an empty sub
//     is a live ownership value rather than a no-match.
//   • owner columns are per-table and were verified against live prod, NOT assumed:
//       locations.created_by · inventory_items.created_by · spaces.created_by
//       plants: its container's created_by, OR its own when it has no container.
// These live here rather than per-handler so the predicate has ONE canonical home; each Lambda is
// zipped from its own dir, so this file is copied per-dir (see DEPLOY NOTE above) and the copies are
// held byte-identical by lambda/household-copies-sync.test.js.

// A malformed id must answer the SAME generic null these loaders give a foreign id — never a 22P02
// ("invalid input syntax for type uuid") that falls through the handler's catch to an opaque 500.
// That 500 is both a worse client contract and a weak side channel: 500 = "syntactically invalid",
// 400 = "valid uuid, but not yours". Identical to the constant in authz-parents.js; the two files
// merge in the consolidating sweep. (V4-AUTHZRESIDUE-001 — previously only authz-parents.js carried
// this guard, so a malformed location_id / inventory_item_id / space_id still 500'd.)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Verify a location_id is one the caller may attach to. Soft-deleted locations are rejected.
export async function loadOwnedLocation(sql, locationId, householdIds) {
  if (!UUID_RE.test(String(locationId))) return null;
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
  if (!UUID_RE.test(String(itemId))) return null;
  const rows = await sql`
    SELECT id, name FROM inventory_items
    WHERE id = ${itemId}
      AND created_by = ANY(${householdIds})
      AND deleted_at IS NULL
  `;
  return rows.length ? rows[0] : null;
}

// Verify a planting id (plants.parent_plant_id lineage links).
//
// V4-AUTHZRESIDUE-001 — RECONCILED TO THE STRICT DIALECT. This predicate previously read
// `gn.created_by = ANY(h) OR pp.created_by = ANY(h)` over the garden_node/container VIEWS, which is
// strictly LOOSER than authz-parents.js loadOwnedPlantingRef: the bare own-created_by arm reaches a
// planting the caller created INSIDE another household's container — exactly the row the plants
// by-id predicate exists to keep unreachable. It is now byte-equivalent to loadOwnedPlantingRef.
//
// THE `project_id IS NULL` CONJUNCT IS LOAD-BEARING, NOT DECORATION — do not "simplify" it away.
// Container-less plantings still resolve, via that second arm; the arm is narrowed, not removed.
//
// MEASURED, NOT ASSUMED: against live prod and the staging branch, the strict predicate accepts the
// IDENTICAL planting set as the loose one for the configured household (prod 269 = 269, staging
// 1 = 1, newly-rejected = 0), and 0 of the existing preservation_log rows carrying a plant_id would
// fail it. This tightening rejects nothing the app legitimately does.
//
// Addresses the BASE TABLES rather than the views, matching loadOwnedPlantingRef: that is also where
// the CHECK constraints live. `plants.name` is what the garden_node view exposes as display_name.
//
// NOTE FOR THE CONSOLIDATING SWEEP: this is now a duplicate of authz-parents.js
// loadOwnedPlantingRef. It has ZERO callers today (verified repo-wide) and should be DELETED — not
// merely kept in sync — when authz-parents.js collapses into this file. Two identical predicates
// with different names is the condition that let the loose one survive the first sweep.
export async function loadOwnedPlanting(sql, plantId, householdIds) {
  if (!UUID_RE.test(String(plantId))) return null;
  const rows = await sql`
    SELECT gn.id, gn.name
    FROM public.plants gn
    LEFT JOIN public.plant_projects pp ON pp.id = gn.project_id
    WHERE gn.id = ${plantId}
      AND gn.deleted_at IS NULL
      AND ( pp.created_by = ANY(${householdIds})
            OR (gn.project_id IS NULL AND gn.created_by = ANY(${householdIds})) )
  `;
  return rows.length ? rows[0] : null;
}

// Verify a space_id. Consumed by V4-SPACEPHOTO-001 in lambda/photos (attach + set-featured).
// NO deleted_at predicate — the spaces table has no such column (verified live, V-P2).
// spaces.created_by is still NULLABLE, but the one live space row IS populated on BOTH prod and
// the staging branch (re-verified 2026-07-31), so this predicate no longer rejects every space —
// the earlier backfill prerequisite is discharged. Deliberately strict rather than adding an
// `OR created_by IS NULL` escape, which would make an unowned space writable by any household.
export async function loadOwnedSpace(sql, spaceId, householdIds) {
  if (!UUID_RE.test(String(spaceId))) return null;
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
