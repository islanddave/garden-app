// src/components/seed/lotPhoto.js — V5-SEEDCARDS-001. A seed LOT is not a photo; this is the one
// adapter from a lot row to the photo object <PhotoView> takes, used by the My seeds card and the
// seed's detail page alike.
//
// The id is the PHOTO's (`hero_photo_id`), never the lot's `id`: photoModel reads `raw.id` as the
// photo id, and PhotoImg re-mints an expired URL at /api/photos/view-url/<that id>. Handing it the lot
// id would 404 there — a permanent blank the first time a 900s presigned URL expires, invisible to
// jsdom. Same trap, same remedy as PlantingTile's remap.
//
// `byId` (BUG-SEEDLISTSIGNING-001): the seed LIST no longer carries URLs, only `hero_photo_id`, so a
// list row maps to an ID-ONLY photo — which renders only under <PhotoView resolveById>, where it mints
// the thumb for the rows actually drawn. Opt-in, because the detail page's by-id GET still signs its
// photo and treats "no URL" as "no photo to show" (its box becomes the upload button, and its Lightbox
// needs a URL). A row that does carry a URL still renders from it, id or not.
export function lotPhoto(row, { byId = false } = {}) {
  if (row?.featured_photo_view_url) {
    return {
      id: row.hero_photo_id ?? null,
      featured_photo_view_url: row.featured_photo_view_url,
      featured_photo_thumb_url: row.featured_photo_thumb_url ?? null,
      inventory_item_id: row.id ?? null,
    }
  }
  if (byId && row?.hero_photo_id) return { id: row.hero_photo_id, inventory_item_id: row.id ?? null }
  return null
}
