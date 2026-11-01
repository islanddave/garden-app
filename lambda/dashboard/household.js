// household.js — Household Mode scope helper and the household gate.
// HOUSEHOLD-MODE: remove at V3-ROLES (DB-layer RLS via current_user_role() replaces this).
// householdScope returns the set of owner Clerk IDs whose rows a request may see/modify.
//
// MEMBERSHIP-GATED: widen to the configured household ONLY when the requester is a member
// of it; otherwise return just their own id. A non-member who authenticates must NEVER see
// the household's data. Fail-closed: empty/unset/whitespace env -> [userId] (single-user).
//
// DEPLOY NOTE: a Lambda zip holds only its own dir, so a `../household.js` import is NOT packaged and the
// handler 502s at module load. An IDENTICAL copy of this file lives in each in-scope Lambda dir and is
// imported as `./household.js`; this file is the canonical source, and the copies are kept byte-identical by
// lambda/household-copies-sync.test.js.
// The one read of GARDEN_HOUSEHOLD_IDS: comma-separated Clerk subs, trimmed, empties dropped.
function householdList() {
  return (process.env.GARDEN_HOUSEHOLD_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}
export function householdScope(userId) {
  const raw = householdList();
  return raw.includes(userId) ? raw : [userId]; // element equality on the parsed list, never a raw-string test
}
export function householdActive() {
  return householdList().length > 1;
}

// SEC-13a: every HTTP handler calls this on the line after its empty-sub 401 and before neon(), any rate
// limit, read or write, so a refused caller costs no statement and spends no bucket. Exact membership in
// the parsed list (a Set); an unset or blank list admits nobody. One generic 403 body for every handler;
// the reason goes to the log only (scripts/household-observability.sh watches this msg). Guards:
// lambda/household.test.js (the rule) and lambda/household-isolation.test.js (every handler, the order).
export function householdGate(userId) {
  const members = new Set(householdList());
  if (typeof userId === 'string' && members.has(userId)) return null;
  console.warn(JSON.stringify({ msg: 'household-membership-denied', userId, reason: members.size ? 'non-member' : 'env-missing' }));
  return { status: 403, body: { error: 'Forbidden' } };
}

// ── Write-FK ownership loaders (V4-AUTHZSWEEP-001) ───────────────────────────────────────────────
// A DB foreign key proves a referenced row EXISTS, not that the caller OWNS it. Every write path that
// accepts a cross-entity id (plants.location_id, inventory_items.location_id, plants.parent_plant_id, …)
// from a request body must prove the row is in the caller's household BEFORE storing it, or an
// authenticated user can pin their row to another household's and read its fields back through any JOIN.
//
// Contract (uniform, mirrors the preservation/index.js loaders):
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
// These live here so the predicate has ONE canonical home; the per-dir copies are explained by the
// DEPLOY NOTE above.

// A malformed id must answer the SAME generic null these loaders give a foreign id, never a 22P02 that
// falls through the handler's catch to an opaque 500: that 500 is a weak side channel (500 = "syntactically
// invalid", 400 = "valid uuid, but not yours"). Identical to the constant in authz-parents.js; the two
// files merge in the consolidating sweep.
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

// Verify a space_id. Consumed by lambda/photos (attach + set-featured).
// NO deleted_at predicate: the spaces table has no such column.
// spaces.created_by is still NULLABLE. Deliberately strict rather than adding an `OR created_by IS NULL`
// escape, which would make an unowned space writable by any household.
export async function loadOwnedSpace(sql, spaceId, householdIds) {
  if (!UUID_RE.test(String(spaceId))) return null;
  const rows = await sql`
    SELECT id, name FROM spaces
    WHERE id = ${spaceId}
      AND created_by = ANY(${householdIds})
  `;
  return rows.length ? rows[0] : null;
}

// Verify a photo_id the caller is attaching to one of their own rows (plant_varieties.photo_id,
// inventory_items.featured_image_id, preservation_log.photo_id). photos.created_by is the owner
// column (photos ALSO carries a stale `uploaded_by`, which is NOT the owner column and must never be
// used here; see the locations featured-photo assertion in authz-write-fk.test.js).
//
// Lifted verbatim from the module-private loadOwnedPhoto in lambda/preservation/index.js. preservation
// keeps its own copy for now: it is byte-equivalent to this and asserted as such by the preservation arm
// of authz-write-fk.test.js. Deleting it in favour of this import belongs to the consolidating sweep that
// also collapses authz-parents.js.
export async function loadOwnedPhoto(sql, photoId, householdIds) {
  if (!UUID_RE.test(String(photoId))) return null;
  const rows = await sql`
    SELECT id FROM photos
    WHERE id = ${photoId}
      AND created_by = ANY(${householdIds})
      AND deleted_at IS NULL
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
