// V4-EVTDELCONFIRM-001 — the event-photos read that makes EventDeleteConfirm's photo path
// REACHABLE. Until this, no live endpoint reported an event's photos or their cover usage, so the
// DD9 sheet's offer ("Also delete the photo") and disclosure ("This photo is the cover photo for
// Celebrity Rescue") sat at the component defaults (0 / []) on both delete surfaces.
//
// WHY THIS LAMBDA AND NOT lambda/photos. The question being answered is "what does THIS EVENT
// carry?" — event-detail data, served on the route the delete flow already reads
// (GET /api/events/:id). The photos Lambda owns photo CRUD (upload, presign, soft-delete,
// restore); it has no per-event read and adding one there would give the client a second
// round-trip for data the event GET can carry. The actual photo DELETE the checked path fires
// stays entirely owned by lambda/photos (softDeletePhoto — W-DEL).
//
// WHY A MODULE AND NOT MORE OF index.js. index.js is not importable from repo root (its
// @aws-sdk/@clerk/@neondatabase deps are per-Lambda), so anything written into it can only be
// covered by SQL-TEXT assertions — a tier that cannot prove a statement runs or that a result is
// mapped. This file imports nothing at all, so event-photos.test.js EXECUTES it against a
// recording fake `sql` (the household.js / photoDelete.js precedent).
//
// SHAPE (additive key on the GET /api/events/:id response — clients must tolerate its absence,
// an old Lambda paired with a new client degrades to the sheet's unchecked default):
//   photos: [{ id, storage_path, cover_for: [{ type, id, name }] }]
//     - storage_path is the S3 KEY, not a URL. The confirm sheet renders no imagery, and
//       presigning lives in lambda/photos (S3 client + secrets this Lambda does not carry) — so a
//       URL here would be neither cheap nor used. The key ships because it costs nothing and lets
//       a future surface resolve a thumb via the photos Lambda's view-url route.
//     - cover_for enumerates every entity whose featured_photo_id OR featured_image_id points at
//       the photo — exactly the display-pointer set softDeletePhoto NULLs on the checked path
//       (photoDelete.js PHOTO_POINTERS), minus the non-cover ledger/catalog pointers
//       (share_log, preservation_log, plant_varieties: not "cover photo for X" semantics, and
//       the first is retained on delete anyway) and minus spaces (every spaces statement in this
//       codebase is gated on SPACE_PHOTOS_ENABLED, a flag this Lambda does not read; when that
//       flag graduates, add the arm here alongside it). `type` uses the app's own nouns
//       (planting/project/location/inventory_item), not table names.
//
// SOFT-DELETE FILTERING per house rules: the photos read carries deleted_at IS NULL (an
// already-deleted photo must not inflate the offer count), and every cover arm carries its own
// deleted_at IS NULL (a soft-deleted planting's hero pointer is not a disclosure the user can act
// on). Scope is created_by = ANY(householdIds) — byte-identical to the photos Lambda's own reads,
// so the count here can never include a photo the checked path's DELETE would then 404 on.
//
// ORDER: created_at ASC, id ASC — stable across refetches; the id tiebreak matters because the
// mini-logger uploads land inside one second.

export async function loadEventPhotos(sql, eventId, householdIds) {
  return sql`
    SELECT ph.id,
           ph.storage_path,
           COALESCE((
             SELECT json_agg(json_build_object('type', t.kind, 'id', t.id, 'name', t.name) ORDER BY t.name)
               FROM (
                 SELECT 'planting' AS kind, gn.id AS id, gn.display_name AS name
                   FROM public.garden_node gn
                  WHERE (gn.featured_photo_id = ph.id OR gn.featured_image_id = ph.id)
                    AND gn.deleted_at IS NULL
                 UNION ALL
                 SELECT 'project' AS kind, pp.id, pp.display_name
                   FROM public.container pp
                  WHERE (pp.featured_photo_id = ph.id OR pp.featured_image_id = ph.id)
                    AND pp.deleted_at IS NULL
                 UNION ALL
                 SELECT 'location' AS kind, l.id, l.name
                   FROM public.locations l
                  WHERE (l.featured_photo_id = ph.id OR l.featured_image_id = ph.id)
                    AND l.deleted_at IS NULL
                 UNION ALL
                 SELECT 'inventory_item' AS kind, ii.id, ii.name
                   FROM public.inventory_items ii
                  WHERE (ii.featured_photo_id = ph.id OR ii.featured_image_id = ph.id)
                    AND ii.deleted_at IS NULL
               ) t
           ), '[]'::json) AS cover_for
      FROM photos ph
     WHERE ph.event_id = ${eventId}
       AND ph.deleted_at IS NULL
       AND ph.created_by = ANY(${householdIds})
     ORDER BY ph.created_at ASC, ph.id ASC
  `;
}
