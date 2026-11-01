// THE canonical photo object.
//
// Every photo surface used to re-derive its own notion of what a photo is: which URL to render,
// which parent it hangs off, whether a thumbnail exists. That re-derivation was the shared root cause
// of a run of thumbnail, parent and blank-photo bugs. This module is the one place those questions get
// answered (photoPrimitive.static.test.js bans re-deriving them elsewhere).
//
// What the live data looks like (point-in-time counts go stale, so none are quoted: re-measure before
// relying on a number):
//   - The parent model is SIX FK columns. `photos_must_have_parent` counts event_id, project_id,
//     location_id, plant_id, inventory_item_id and space_id, plus an escape hatch
//     (intake_status='pending_tag') that permits a legitimately parentless row.
//   - MULTI-PARENT IS THE NORM: most rows have two parents set. Any surface written against "exactly one
//     parent is set" is wrong on most of the corpus.
//   - No live row is parentless outside pending_tag. Inventory photos are fully attached; they were
//     invisible only to a four-way model that does not know inventory exists.
//   - taken_at, mime_type and file_size_bytes are populated only on rows uploaded by the newer path
//     (one path fills the three together); content_hash may be empty on older rows. Older rows have
//     NULLs, so every reader must tolerate them.
//   - caption is NULL on nearly every row, so the alt fallback is the common path, not the edge case.
//
// Duplicated from PhotoImg deliberately: this module is pure data and must not pull React in via a
// component import. photoModel.test.js asserts the two constants stay equal, so drift fails a test
// rather than silently splitting the expiry model in half.
export const PRESIGN_TTL_MS = 900 * 1000   // == server view-url expiresIn:900

// THE date of a photograph: when the shutter fired, falling back to when the row was created.
// Every gallery sort and the Photos wall's month sectioning go through this one function, so a
// photograph cannot land in one place on one surface and somewhere else on another. Mirrors the
// public site's `coalesce(e.event_date, p.taken_at, p.created_at)` (gam-site/tools/generate_candidates.py)
// minus the event leg, which this model cannot see.
//
// Sorting on created_at alone files a frame shot in August and uploaded in September under September.
//
// THE FALLBACK IS THE FEATURE, not defensive padding: taken_at is NULL on most rows, so sorting on the
// bare field would sink them to the bottom of every gallery. It is NULL because the upload path did not
// read EXIF until recently, not because the data was missing; photos re-encoded through a canvas by the
// client-side downscale lost their EXIF for good.
//
// ACCEPTS BOTH SPELLINGS on purpose. Callers hand it raw API rows (`taken_at`/`created_at`) in the
// filter helpers and built models (`takenAt`/`createdAt`) elsewhere; making each caller remember
// which shape it holds is how the two drift apart again. Returns an ISO string or null — null sorts
// LAST in both directions at every call site, never to the head of a list someone is scanning.
export function photoDate(photo) {
  if (!photo) return null
  return photo.takenAt ?? photo.taken_at ?? photo.createdAt ?? photo.created_at ?? null
}

// The six parent FKs the live CHECK actually counts, in the order the CHECK names them.
export const PARENT_KINDS = Object.freeze(['event', 'project', 'location', 'plant', 'inventory', 'space'])

// kind -> the field name the photos API returns. `inventory` is the one whose API field name does
// not match its kind, and it is exactly the one every four-way surface dropped.
export const PARENT_FIELDS = Object.freeze({
  event: 'event_id',
  project: 'project_id',
  location: 'location_id',
  plant: 'plant_id',
  inventory: 'inventory_item_id',
  space: 'space_id',
})

// Parentage is a FOUR-state property, not a boolean. `multi` is the normal case; `orphan` is an
// INVALID state that the CHECK forbids and that should never occur live; it is modelled rather than
// assumed-away so a surface degrades visibly instead of rendering nothing.
export const PARENTAGE = Object.freeze({
  ORPHAN: 'orphan',        // no parent AND not pending_tag — violates photos_must_have_parent
  PENDING: 'pending-tag',  // no parent, but intake_status='pending_tag' — legitimately unattached
  SINGLE: 'single',
  MULTI: 'multi',
})

export const TIER = Object.freeze({ THUMB: 'thumb', FULL: 'full' })

const PHOTO_BRAND = Symbol.for('garden.photoModel.v1')

// Normalize whatever the API actually returns today into the canonical object.
//
// `receivedAt` is when THIS client received the URL, not when the server minted it. The server mints
// a few hundred ms earlier, so treating receipt as the mint time makes every expiry judgement
// conservative (we call a URL stale slightly before S3 does), which is the safe direction.
export function toPhoto(raw, { receivedAt = Date.now() } = {}) {
  if (raw == null) return null
  if (raw[PHOTO_BRAND]) return raw   // idempotent: re-adapting a canonical photo is a no-op

  const parents = {}
  const parentKinds = []
  for (const kind of PARENT_KINDS) {
    const id = raw[PARENT_FIELDS[kind]] ?? null
    parents[kind] = id
    if (id) parentKinds.push(kind)
  }

  const pendingTag = raw.intake_status === 'pending_tag'
  const parentCount = parentKinds.length
  const parentage = parentCount === 0
    ? (pendingTag ? PARENTAGE.PENDING : PARENTAGE.ORPHAN)
    : (parentCount === 1 ? PARENTAGE.SINGLE : PARENTAGE.MULTI)

  const caption = raw.caption ?? null

  return Object.freeze({
    [PHOTO_BRAND]: true,
    id: raw.id ?? null,
    storagePath: raw.storage_path ?? null,
    caption,
    // Most live rows have no caption, so this fallback is the common path. Kept non-empty so a
    alt: caption || 'Garden photo',
    createdAt: raw.created_at ?? null,
    // EXIF DateTimeOriginal, or null on rows that predate the client-side read (or whose EXIF was
    // stripped before the file reached us). Do NOT sort on this
    takenAt: raw.taken_at ?? null,
    parents: Object.freeze(parents),
    parentKinds: Object.freeze(parentKinds),
    parentCount,
    parentage,
    pendingTag,
    isAttached: parentCount > 0,
    // True only for the CHECK-violating state, NOT for a legitimately pending_tag intake row.
    isOrphan: parentage === PARENTAGE.ORPHAN,
    sources: Object.freeze(buildSources(raw)),
    urlMintedAt: receivedAt,
    raw,
  })
}

// A photo's renderable sources.
//
// THE THUMB IS A HINT AND ITS TRUTHINESS CARRIES ZERO INFORMATION. The photos Lambda derives
// thumb_url by CONVENTION (`thumbs/<storage_path>`) and presigns it — and presigning is pure
// signature math that never touches S3, so a thumb URL is returned as a non-empty string whether or
// not the object exists. storage_path is NOT NULL on every live row, so thumb_url is ALWAYS present.
// Only backfilled photos actually have thumbs, so a `thumb_url &&` test is true for all of them.
// `guaranteed` is the field that carries the real information.
function buildSources(raw) {
  const out = {}
  // featured_photo_thumb_url is the featured-photo spelling of thumb_url — /api/plants derives the
  // same `thumbs/<storage_path>` key by the same convention (lambda/plants featuredPhotoUrls). Same
  // hint semantics, so it degrades through the same chain.
  const thumb = raw.thumb_url ?? raw.featured_photo_thumb_url ?? null
  // featured_photo_view_url is the same presigned original under a different name, used by the
  // plants/projects/spaces list endpoints. It is a FULL source, never a thumb.
  const full = raw.view_url ?? raw.featured_photo_view_url ?? null
  if (thumb) out.thumb = Object.freeze({ url: thumb, tier: TIER.THUMB, guaranteed: false })
  if (full) out.full = Object.freeze({ url: full, tier: TIER.FULL, guaranteed: true })
  return out
}

export function isPhoto(x) {
  return !!(x && x[PHOTO_BRAND])
}

// The ordered list of sources to try for a requested tier. A thumb request degrades to the full
// original because a missing thumb is expected, and the degrade target is
// already in hand from the same list response, so recovering costs NO network round-trip.
export function sourceChain(photo, tier = TIER.FULL) {
  if (!photo) return []
  const { thumb, full } = photo.sources
  const chain = tier === TIER.THUMB ? [thumb, full] : [full]
  return chain.filter(Boolean)
}

export function pickSource(photo, tier = TIER.FULL) {
  return sourceChain(photo, tier)[0] ?? null
}

// ── Presigned-URL freshness ───────────────────────────────────────────────────────────────────
// A presigned S3 URL is a transferable bearer credential with a 900s TTL. Expiry is a PROPERTY of
// the object, not an implicit assumption a surface may make — a URL held past its TTL renders a
// permanent blank with no error event a static render test could ever see.
export function presignAgeMs(photo, now = Date.now()) {
  return photo ? now - photo.urlMintedAt : Infinity
}

export function isPresignStale(photo, now = Date.now()) {
  return presignAgeMs(photo, now) >= PRESIGN_TTL_MS
}

// Adapt a list response in one pass, sharing one receivedAt so a whole page expires together.
export function toPhotos(rows, { receivedAt = Date.now() } = {}) {
  if (!Array.isArray(rows)) return []
  return rows.map(r => toPhoto(r, { receivedAt })).filter(Boolean)
}
