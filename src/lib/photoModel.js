// src/lib/photoModel.js — V4-PHOTOMODEL-001. THE canonical photo object.
//
// Every photo surface in this app used to re-derive its own notion of what a photo is: which URL to
// render, which parent it hangs off, whether a thumbnail exists. That re-derivation is the shared
// root cause of BUG-PHOTOTHUMB-001, BUG-PHOTONEWTHUMB-001, BUG-PHOTOPARENT-001, BUG-PHOTOBLANK-001
// and BUG-PHOTOFIRST-001. This module is the one place those questions get answered.
//
// GROUNDED IN LIVE PROD NEON, not in what the surfaces assume (measured 2026-08-07, 1094 live rows):
//   - The parent model is SIX FK columns, not four. `photos_must_have_parent` counts event_id,
//     project_id, location_id, plant_id, inventory_item_id and space_id, plus a 7th escape hatch
//     (intake_status='pending_tag') that permits a legitimately parentless row.
//   - MULTI-PARENT IS THE NORM: 972/1094 rows (88.8%) have TWO parents set and 9 have three. Only
//     113 have exactly one. Any surface written against "exactly one parent is set" is wrong on
//     ~90% of the corpus.
//   - ZERO live rows have no parent. BUG-PHOTOPARENT-001's "6 photos with no parent link at all"
//     are the 6 inventory_item_id photos: they are fully attached, and were invisible only because
//     the four-way model does not know inventory exists. That bug was in the MODEL, not the data.
//   - taken_at, mime_type, file_size_bytes and content_hash are 100% NULL on every live row. They
//     exist in the schema and carry no data — created_at is the only usable timestamp, which is why
//     `takenAt` is surfaced but never used as a sort/group key.
//   - caption is NULL on 1092/1094 rows, so the alt fallback is the common path, not the edge case.
// Duplicated from PhotoImg deliberately: this module is pure data and must not pull React in via a
// component import. photoModel.test.js asserts the two constants stay equal, so drift fails a test
// rather than silently splitting the expiry model in half.
export const PRESIGN_TTL_MS = 900 * 1000   // == server view-url expiresIn:900

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

// Parentage is a FOUR-state property, not a boolean. `multi` is the normal case (88.8% of live
// rows); `orphan` is an INVALID state that the CHECK forbids and that measures 0 live today — it is
// modelled rather than assumed-away so a surface degrades visibly instead of rendering nothing.
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
    // 1092/1094 live rows have no caption, so this fallback is the common path. Kept non-empty so a
    // photo always announces; a decorative usage passes alt="" at the call site instead.
    alt: caption || 'Garden photo',
    createdAt: raw.created_at ?? null,
    // Surfaced because it is in the schema, but 100% NULL live — never group or sort on it.
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
// not the object exists. storage_path is NOT NULL on 100% of live rows, so thumb_url is ALWAYS
// present. That is BUG-PHOTONEWTHUMB-001 in one sentence: only the 913 backfilled photos actually
// have thumbs, every surface tested `thumb_url &&`, and that test is true for all 1094.
// `guaranteed` is the field that carries the real information.
function buildSources(raw) {
  const out = {}
  const thumb = raw.thumb_url ?? null
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
// original because a missing thumb is expected (BUG-PHOTONEWTHUMB-001) — and the degrade target is
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
