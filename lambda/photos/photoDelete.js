// W-DEL (V4-PHOTOREASSIGN-001 / defect D2) — the photo soft-delete + restore CORE.
//
// WHY A SEPARATE MODULE AND NOT MORE OF index.js. index.js "is not importable from repo root (its
// @aws-sdk/@clerk/@neondatabase deps are per-Lambda, not installed here)", so everything written
// into it can only ever be covered by SQL-TEXT assertions — a tier that cannot prove a statement
// runs, cannot prove ORDER, cannot prove a branch was taken, and has already let this repo ship
// features that were inert. This file imports nothing but node built-ins, so its behaviour is
// executed by the unit suite against a recording fake `sql` (the household.js / authz-parents.js /
// photo-access.js precedent). index.js keeps only auth, routing, and the response envelope.
//
// SOFT-DELETE-ONLY. Nothing here removes a row and nothing here touches S3. `deleted_at = now()`
// is the delete; default reads already filter it; every relation is preserved (no FK hard-cascade
// ever fires, because no hard delete ever happens); restore is the recovery path. A hard delete
// would additionally be BLOCKED by preservation_log.photo_id (ON DELETE NO ACTION) and would
// SILENTLY DESTROY share history via share_log.photo_id (ON DELETE CASCADE) — so the rule is also
// what keeps referential integrity honest here, not merely a policy.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// BUG-VARIETYACTOREMPTY-001. Kept byte-identical in behaviour to auditActor() in
// lambda/varieties/validate.js — each Lambda zips its own dir, so the two plant_varieties writers
// cannot share a module; lambda/audit-actor-empty.test.js drives BOTH and fails if they diverge.
// Rationale for throwing rather than substituting a sentinel is on softDeletePhoto below.
function auditActor(userId) {
  if (typeof userId !== 'string' || userId.trim() === '') {
    throw new Error('audit actor is absent — refusing to write an unattributable audit row');
  }
  return userId;
}

// ── DD4: PHOTO_POINTERS is the ONE named set, never a hand-written list per call site. ───────────
//
// Snapshot of live prod `pg_constraint WHERE confrelid = 'photos'::regclass` (introspected
// 2026-08-12): 12 FK columns across 8 tables. Refresh with
//   SELECT conrelid::regclass::text, a.attname::text, c.confdeltype::text
//     FROM pg_constraint c JOIN unnest(c.conkey) k ON true
//     JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k
//    WHERE c.confrelid = 'photos'::regclass AND c.contype = 'f';
// scripts/preflight-photodelete.sh re-runs exactly that and hard-aborts if it disagrees with this
// constant, so a new FK to photos cannot silently escape the null set.
//
// CLASSIFICATION — display pointers null on delete; LEDGER pointers retain:
//   share_log.photo_id records that an image was posted to an external Facebook page. A soft delete
//   inside this app cannot retract that post, so erasing the local record of it would make the
//   ledger lie. RETAIN is a correctness decision, not laziness.
//
// `surface` is the relation the statement targets, which is NOT always `table` (DD5): plants and
// plant_projects are written through the auto-updatable views `garden_node` / `container` (the same
// surface autoPromoteFeatured and the set-featured validators write), and plant_varieties through
// `cultivar` (the surface lambda/varieties writes). Base-table triggers still fire through a view.
//
// `featured_image_id` is the deprecated V1-era twin of featured_photo_id (0 rows populated on all
// four tables, live but unexercised). Open decision D-2 ("deprecate now or keep supported?") is NOT
// settled, so this lane does NOT stop accepting it in lambda/inventory-items — it only guarantees
// that if a row ever DOES carry one, deleting the photo clears it. Nulling a column nobody writes
// costs four no-op statements and removes the entire "we forgot the twin" failure mode.
export const PHOTO_POINTERS = [
  { table: 'plants', column: 'featured_photo_id', surface: 'public.garden_node', action: 'null' },
  { table: 'plants', column: 'featured_image_id', surface: 'public.garden_node', action: 'null' },
  { table: 'plant_projects', column: 'featured_photo_id', surface: 'public.container', action: 'null' },
  { table: 'plant_projects', column: 'featured_image_id', surface: 'public.container', action: 'null' },
  { table: 'locations', column: 'featured_photo_id', surface: 'public.locations', action: 'null' },
  { table: 'locations', column: 'featured_image_id', surface: 'public.locations', action: 'null' },
  { table: 'inventory_items', column: 'featured_photo_id', surface: 'public.inventory_items', action: 'null' },
  { table: 'inventory_items', column: 'featured_image_id', surface: 'public.inventory_items', action: 'null' },
  { table: 'plant_varieties', column: 'photo_id', surface: 'public.cultivar', action: 'null' },
  { table: 'preservation_log', column: 'photo_id', surface: 'public.preservation_log', action: 'null' },
  // Gated on SPACE_PHOTOS_ENABLED like every other spaces statement in this Lambda. NOTE the arm
  // carries NO `spaces.deleted_at` reference: that column does not exist (verified live), and
  // asserting it would 42703 — inside a transaction that aborts the WHOLE delete.
  { table: 'spaces', column: 'featured_photo_id', surface: 'public.spaces', action: 'null', flag: 'SPACE_PHOTOS_ENABLED' },
  { table: 'share_log', column: 'photo_id', surface: 'public.share_log', action: 'retain' },
];

// SCOPING RULE for every null statement: keyed on `<pointer column> = <deleted photo id>` and
// NOTHING ELSE. Deliberate, and uniform across all eleven arms:
//   • It is inherently safe. The caller's ownership of the PHOTO is proven by the pre-read before
//     any statement is built, so the only rows reachable are rows pointing at a photo this
//     household owns. Clearing a reference to a resource you own is not a foreign-row mutation.
//   • A household predicate would instead LEAVE a pointer at a soft-deleted photo whenever the two
//     ever diverge, which is precisely the INV-HERO violation this work exists to close — and it
//     would make preflight check #2 ("heroes pointing at a soft-deleted photo == 0") unsatisfiable
//     rather than meaningful.
//   • R8: plant_varieties is a SHARED cultivar catalogue (424 rows, RLS disabled, created_by values
//     include `system` and offline intake scripts). The plan rules that arm must be photo_id-scoped
//     only. Applying that rule uniformly is what lets the whole set be one loop instead of eleven
//     bespoke predicates with eleven chances to differ.
// NO statement here names `created_by` — `prevent_ownership_transfer` guards six of these tables
// and a NULL -> value or value -> value write on that column counts as a transfer.

const activePointers = (spaceEnabled) => PHOTO_POINTERS.filter(
  (p) => p.action === 'null' && (!p.flag || spaceEnabled),
);

// Each null statement, in PHOTO_POINTERS order. Identifiers cannot be interpolated into a neon
// tagged template (its parameters are values only), so every arm is written out literally and the
// constant above is cross-checked against these by photoDelete.test.js — a mismatch in EITHER
// direction fails, so the constant can neither over- nor under-state what the code does.
function pointerNullStatement(sql, p, photoId) {
  switch (`${p.table}.${p.column}`) {
    case 'plants.featured_photo_id':
      return sql`UPDATE public.garden_node SET featured_photo_id = NULL WHERE featured_photo_id = ${photoId} RETURNING id`;
    case 'plants.featured_image_id':
      return sql`UPDATE public.garden_node SET featured_image_id = NULL WHERE featured_image_id = ${photoId} RETURNING id`;
    case 'plant_projects.featured_photo_id':
      return sql`UPDATE public.container SET featured_photo_id = NULL WHERE featured_photo_id = ${photoId} RETURNING id`;
    case 'plant_projects.featured_image_id':
      return sql`UPDATE public.container SET featured_image_id = NULL WHERE featured_image_id = ${photoId} RETURNING id`;
    case 'locations.featured_photo_id':
      return sql`UPDATE public.locations SET featured_photo_id = NULL WHERE featured_photo_id = ${photoId} RETURNING id`;
    case 'locations.featured_image_id':
      return sql`UPDATE public.locations SET featured_image_id = NULL WHERE featured_image_id = ${photoId} RETURNING id`;
    case 'inventory_items.featured_photo_id':
      return sql`UPDATE public.inventory_items SET featured_photo_id = NULL WHERE featured_photo_id = ${photoId} RETURNING id`;
    case 'inventory_items.featured_image_id':
      return sql`UPDATE public.inventory_items SET featured_image_id = NULL WHERE featured_image_id = ${photoId} RETURNING id`;
    case 'plant_varieties.photo_id':
      return sql`UPDATE public.cultivar SET photo_id = NULL WHERE photo_id = ${photoId} RETURNING id`;
    case 'preservation_log.photo_id':
      return sql`UPDATE public.preservation_log SET photo_id = NULL WHERE photo_id = ${photoId} RETURNING id`;
    case 'spaces.featured_photo_id':
      return sql`UPDATE public.spaces SET featured_photo_id = NULL WHERE featured_photo_id = ${photoId} RETURNING id`;
    default:
      // Unreachable by construction — activePointers only yields the eleven cases above. Throwing
      // rather than returning undefined keeps a future PHOTO_POINTERS row from silently producing a
      // transaction with a hole in it.
      throw new Error(`no null statement for pointer ${p.table}.${p.column}`);
  }
}

// The household-owned photo, or null. NOT filtered on deleted_at — the whole point is to be able to
// tell "absent or not yours" (404) apart from "yours and already deleted" (idempotent 200). Doing
// that by row-count on the UPDATE is what conflates them.
//
// The effective_* columns implement the EVENT-INCLUSIVE planting linkage: EventNew logs event
// photos with {project_id, event_id} and NO plant_id, and 123 of prod's 250 explicit plant heroes
// are attached that way. `photos.plant_id` alone would miss the majority of them on restore. This
// is byte-for-byte the predicate lambda/plants/index.js's set-featured validator already enforces
// at WRITE time, which is the rule: the replay may not be STRICTER than the write, or the user
// re-picks the hero, the write accepts it, and the next restore drops it again.
//
// Deliberately NOT event-inclusive for projects/locations/inventory/spaces: each of those
// validators requires the exact column match, and a replay looser than its own write validator sets
// a hero the write would refuse.
async function loadOwnedPhotoForDelete(sql, photoId, householdIds) {
  const rows = await sql`
    SELECT ph.id,
           ph.deleted_at,
           ph.project_id,
           ph.location_id,
           ph.inventory_item_id,
           ph.space_id,
           ph.intake_status,
           COALESCE(ph.plant_id, e.plant_id) AS effective_plant_id
      FROM photos ph
      LEFT JOIN public.event_log e ON e.id = ph.event_id
     WHERE ph.id = ${photoId}
       AND ph.created_by = ANY(${householdIds})
  `;
  return rows.length ? rows[0] : null;
}

/**
 * DELETE /api/photos/:id — soft delete + display-pointer nulling, atomically.
 *
 * ATOMICITY IS NOT OPTIONAL. The neon driver auto-commits each tagged template individually, so
 * twelve loose statements can leave the photo deleted with its pointers intact — a hero rendering a
 * photo the gallery no longer shows, with no way to clear it. `sql.transaction([...])` is
 * NON-INTERACTIVE: every statement is constructed before anything executes, so the affected set
 * comes from per-statement RETURNING and never from a read-back that could see a concurrent write.
 *
 * Statement 0 is `set_config('app.actor_clerk_sub', …, true)` — transaction-local. plant_varieties
 * fires trg_audit_plant_varieties on UPDATE, which reads that GUC and otherwise records the actor as
 * 'system'. The events/plants/projects/varieties lambdas all set it; photos never has.
 *
 * BUG-VARIETYACTOREMPTY-001 — the bind goes through auditActor(), not `userId ?? 'system'`. `??`
 * only catches null/undefined, and the value that actually reaches the audit trail as '' is neither:
 * `set_config(name, NULL, true)` STORES the empty string rather than leaving the GUC unset, so
 * `COALESCE(current_setting(...), 'system')` in the trigger returns '' and the row records an actor
 * that is present-but-nameless. 201 such rows exist on prod. `?? 'system'` also passes a literal ''
 * straight through. Every caller is behind `if (!userId) return 401` (photos/index.js), so refusing
 * here is unreachable by design — it is what keeps it that way.
 *
 * @returns {{status:number, body:object}}
 */
export async function softDeletePhoto(sql, { photoId, householdIds, userId, spaceEnabled = false }) {
  if (!UUID_RE.test(String(photoId))) return { status: 404, body: { error: 'Photo not found' } };

  const photo = await loadOwnedPhotoForDelete(sql, photoId, householdIds);
  // Same generic 404 for "no such photo" and "not your household" — a distinct status would be an
  // existence oracle for another household's photo ids, which every other route here avoids.
  if (!photo) return { status: 404, body: { error: 'Photo not found' } };

  // W-DEL-AC2. Re-delete is a 200, and it must NOT re-stamp deleted_at: that timestamp is the only
  // forensic marker of when the delete happened, and the documented data-repair rollback
  // (`UPDATE photos SET deleted_at = NULL WHERE deleted_at > <deploy ts>`) is only correct because
  // of it. Returning early is what pins it — the UPDATE below additionally carries
  // `AND deleted_at IS NULL` so a concurrent second delete cannot re-stamp either.
  if (photo.deleted_at) {
    return { status: 200, body: { id: photo.id, deleted_at: photo.deleted_at, affected: [], already_deleted: true } };
  }

  const pointers = activePointers(spaceEnabled);
  const statements = [
    sql`SELECT set_config('app.actor_clerk_sub', ${auditActor(userId)}, true)`,
    sql`
      UPDATE photos
         SET deleted_at = now()
       WHERE id = ${photoId}
         AND created_by = ANY(${householdIds})
         AND deleted_at IS NULL
      RETURNING id, deleted_at
    `,
    ...pointers.map((p) => pointerNullStatement(sql, p, photoId)),
  ];

  const results = await sql.transaction(statements);
  const deleted = results[1]?.[0] ?? null;
  // Lost a race with a concurrent delete of the same photo. The pointer nulls in this transaction
  // were then no-ops against already-null columns, so the end state is still correct — report it as
  // the idempotent case rather than inventing a failure the user cannot act on.
  if (!deleted) {
    const now = await loadOwnedPhotoForDelete(sql, photoId, householdIds);
    return { status: 200, body: { id: photoId, deleted_at: now?.deleted_at ?? null, affected: [], already_deleted: true } };
  }

  // STABLE CONTRACT: an array of {table, column, id}. Not a bare id array — 22 photos on prod today
  // are the hero of two or more parents, and one table can be hit through two pointer columns, so a
  // flat id list cannot express what actually changed. Clients must tolerate its ABSENCE (an old
  // Lambda paired with a new client) and fall back to coarse invalidation.
  const affected = [];
  pointers.forEach((p, i) => {
    for (const row of results[i + 2] ?? []) affected.push({ table: p.table, column: p.column, id: row.id });
  });

  return { status: 200, body: { id: deleted.id, deleted_at: deleted.deleted_at, affected } };
}

// The restore's hero replay (DD8). Mirrors autoPromoteFeatured's shape — same `IS NULL` guard, same
// ownership predicates, same non-fatal contract — with two deliberate differences:
//   1. The plants arm keys on the EVENT-INCLUSIVE effective planting id (see
//      loadOwnedPhotoForDelete), because most plant heroes are event-linked.
//   2. It is a separate function rather than a call into autoPromoteFeatured, so restoring a photo
//      cannot change what an UPLOAD does. Widening the shared helper to fix restore would silently
//      alter the auto-promote semantics of every POST.
//
// `featured_photo_id IS NULL` is what makes this a RESTORE and not a takeover: a hero the user
// re-picked while the photo was deleted wins, exactly as DD8 requires. Consequence to state plainly
// rather than hide: this is a best-fit replay, not a byte-exact one. photos has no column to persist
// the delete's RETURNING set in and this lane may not ship DDL, so a photo that was merely IN a
// parent's gallery (never its hero) can be promoted on restore if that parent has no hero at the
// time. It can never DISPLACE a hero.
//
// featured_image_id / plant_varieties.photo_id / preservation_log.photo_id are not replayed: all
// three are 0-populated on prod and none has a designation UI, so there is no user intent to
// restore. Their delete-side null remains, which is the safe direction.
async function restoreHeroPointers(sql, photo, householdIds, spaceEnabled) {
  try {
    if (photo.project_id) {
      await sql`
        UPDATE public.container
           SET featured_photo_id = ${photo.id}
         WHERE id = ${photo.project_id}
           AND created_by = ANY(${householdIds})
           AND featured_photo_id IS NULL
           AND deleted_at IS NULL
      `;
    }
    if (photo.effective_plant_id) {
      await sql`
        UPDATE public.garden_node p
           SET featured_photo_id = ${photo.id}
          FROM public.container pp
         WHERE p.id = ${photo.effective_plant_id}
           AND p.container_id = pp.id
           AND pp.created_by = ANY(${householdIds})
           AND p.featured_photo_id IS NULL
           AND p.deleted_at IS NULL
      `;
    }
    if (photo.location_id) {
      await sql`
        UPDATE public.locations
           SET featured_photo_id = ${photo.id}
         WHERE id = ${photo.location_id}
           AND created_by = ANY(${householdIds})
           AND featured_photo_id IS NULL
           AND deleted_at IS NULL
      `;
    }
    if (photo.inventory_item_id) {
      await sql`
        UPDATE public.inventory_items
           SET featured_photo_id = ${photo.id}
         WHERE id = ${photo.inventory_item_id}
           AND created_by = ANY(${householdIds})
           AND featured_photo_id IS NULL
           AND deleted_at IS NULL
      `;
    }
    // No deleted_at predicate: `spaces` has no such column (see PHOTO_POINTERS).
    if (spaceEnabled && photo.space_id) {
      await sql`
        UPDATE public.spaces
           SET featured_photo_id = ${photo.id}
         WHERE id = ${photo.space_id}
           AND created_by = ANY(${householdIds})
           AND featured_photo_id IS NULL
      `;
    }
  } catch (err) {
    console.error('hero replay non-fatal failure', err?.message ?? err);
  }
}

/**
 * POST /api/photos/:id/restore — the DURABLE recovery path (DD8).
 *
 * This is why delete may carry low friction: forgiveness does not expire. A 5-second undo toast is
 * convenience; it is NOT the recovery model, and this project already paid for that lesson once
 * (V3-ARCHIVE-001 shipped archive with a 6s undo and no restore path).
 *
 * photos_must_have_parent needs no re-validation here: restore changes only deleted_at, and the row
 * satisfied the CHECK when it was written.
 *
 * @returns {{status:number, body:object}}
 */
export async function restorePhoto(sql, { photoId, householdIds, spaceEnabled = false }) {
  if (!UUID_RE.test(String(photoId))) return { status: 404, body: { error: 'Photo not found' } };

  const photo = await loadOwnedPhotoForDelete(sql, photoId, householdIds);
  if (!photo) return { status: 404, body: { error: 'Photo not found' } };
  if (!photo.deleted_at) {
    return { status: 200, body: { id: photo.id, deleted_at: null, already_restored: true } };
  }

  let restored;
  try {
    const rows = await sql`
      UPDATE photos
         SET deleted_at = NULL
       WHERE id = ${photoId}
         AND created_by = ANY(${householdIds})
         AND deleted_at IS NOT NULL
      RETURNING id, deleted_at
    `;
    restored = rows[0] ?? null;
  } catch (err) {
    // idx_photos_content_hash_uniq is UNIQUE (created_by, content_hash) WHERE content_hash IS NOT
    // NULL AND deleted_at IS NULL — a PARTIAL index the deleted row is currently outside of. Coming
    // back inside it collides if the same bytes were re-uploaded meanwhile. A typed 409 says
    // something the user can act on; a 500 says the app is broken. (Inert today by construction:
    // content_hash is NULL on all 1253 live rows, so this path cannot be exercised on prod data.)
    if (err?.code === '23505') {
      return { status: 409, body: { error: 'A copy of this photo has since been re-uploaded', code: 'photo_duplicate' } };
    }
    throw err;
  }
  if (!restored) {
    return { status: 200, body: { id: photoId, deleted_at: null, already_restored: true } };
  }

  await restoreHeroPointers(sql, photo, householdIds, spaceEnabled);
  return { status: 200, body: { id: restored.id, deleted_at: null } };
}

// ── W-RESTORE — the "Recently deleted" LIST (DD8's other half). ───────────────────────────────────
//
// WHY IT LIVES HERE AND NOT IN index.js. This is the ONE read in the whole photos surface that is
// SUPPOSED to return soft-deleted rows, and read-paths-deletedat.test.js's 0A.6 enumeration guard
// asserts that every `SELECT ... FROM photos` template in index.js carries `deleted_at IS NULL`.
// Putting the query here is not a dodge of that guard — it is the exemption made STRUCTURAL and
// nameable: the guard keeps meaning "no serving read in index.js leaks deleted photos", this module
// holds the single deliberate inverse, and photoDelete.test.js pins that this file contains exactly
// ONE `deleted_at IS NOT NULL` SELECT so a second one cannot appear unremarked. It also puts the
// query in the tier that can actually EXECUTE it (index.js is unit-testable only as source text).
//
// SCOPE: `created_by = ANY(householdIds)` — byte-identical to the live GET /api/photos list and to
// softDeletePhoto's own pre-read. Dave and Jen see (and can restore) each other's deletions, which
// is the same household decision the DELETE route documents; V5-PERMSHARD-001 is where that changes,
// if it ever does.
//
// ORDER is `deleted_at DESC` — most-recently-DELETED first, which is the order the user's memory is
// in ("I just deleted the wrong one"), NOT created_at. `id DESC` is a tiebreak so two photos deleted
// inside one transaction (the W-EVTDEL multi-photo path deletes several at one `now()`) have a
// stable order across refetches instead of drifting between renders.
//
// NO permanent-delete/empty-trash companion exists, deliberately. Soft-Delete-Only: this surface can
// only ever put things BACK.
export const DELETED_LIST_LIMIT_DEFAULT = 60;
export const DELETED_LIST_LIMIT_MAX = 200;

// Shared with the route so an unparseable/absent/hostile ?limit lands on the default rather than on
// NaN (which SQL-stringifies to `NaN` and errors the whole request).
export function clampDeletedLimit(raw) {
  const n = parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n < 1) return DELETED_LIST_LIMIT_DEFAULT;
  return Math.min(n, DELETED_LIST_LIMIT_MAX);
}

export async function listDeletedPhotos(sql, { householdIds, limit }) {
  const n = clampDeletedLimit(limit);
  return sql`
    SELECT p.id, p.storage_path, p.caption, p.created_at, p.deleted_at,
           p.project_id, p.plant_id, p.event_id, p.location_id, p.inventory_item_id,
           pp.display_name AS project_name
      FROM photos p
      LEFT JOIN public.container pp ON pp.id = p.project_id
     WHERE p.created_by = ANY(${householdIds})
       AND p.deleted_at IS NOT NULL
     ORDER BY p.deleted_at DESC, p.id DESC
     LIMIT ${n}
  `;
}
