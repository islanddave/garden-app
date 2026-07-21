// src/lib/photoKeys.js
// V2-PHOTO-F1 — unified S3 key builder.
// Single source of truth for photo storage paths. Eliminates the
// PhotoLibrary("standalone/...") vs EventNew("events/{id}/...") drift
// captured in v2-photo-audit-20260513.md.
//
// Contract: buildPhotoKey({ prefix, id, uuid, ext }) -> string
//   prefix : "standalone" | "events" | "projects" | "plants" | "locations" | "inventory"
//   id     : parent entity id (required for everything except "standalone")
//   uuid   : per-photo UUID (caller-provided, persists into photos.id)
//   ext    : file extension WITHOUT the leading dot (e.g. "jpg", "png")
//
// Resulting shapes:
//   buildPhotoKey({ prefix: 'standalone',  uuid: 'A', ext: 'jpg' })   -> 'standalone/A.jpg'
//   buildPhotoKey({ prefix: 'events',      id: 'E',  uuid: 'A', ext: 'jpg' }) -> 'events/E/A.jpg'
//   buildPhotoKey({ prefix: 'projects',    id: 'P',  uuid: 'A', ext: 'png' }) -> 'projects/P/A.png'
//   buildPhotoKey({ prefix: 'plants',      id: 'PL', uuid: 'A', ext: 'jpg' }) -> 'plants/PL/A.jpg'
//   buildPhotoKey({ prefix: 'locations',   id: 'L',  uuid: 'A', ext: 'jpg' }) -> 'locations/L/A.jpg'
//   buildPhotoKey({ prefix: 'inventory',   id: 'I',  uuid: 'A', ext: 'jpg' }) -> 'inventory/I/A.jpg'
//
// Throws on invalid input — callers should never pass user-provided strings here.

// NOTE — 'inbox' is DELIBERATELY ABSENT (V4-PHOTOBULK-001, 2026-07-21). Bulk-intake keys
// (inbox/{userId}/{uuid}.{ext}) are derived SERVER-SIDE by POST /api/photos/batch from the
// authenticated Clerk sub; that route accepts no caller-supplied key at all. Listing 'inbox' here
// would hand the client a builder for a key space it must never name, re-opening the
// trust-the-client hole the batch route was designed to delete. An earlier draft of
// reference/garden-photo-model-decision.md asks for 'inbox' to be added here — that line predates
// the server-derivation decision in the same document and is superseded by it. Do not add it.
export const PHOTO_PREFIXES = Object.freeze([
  'standalone',
  'events',
  'projects',
  'plants',
  'locations',
  'inventory',
]);

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const SAFE_EXT     = /^[A-Za-z0-9]+$/;

export function buildPhotoKey({ prefix, id, uuid, ext } = {}) {
  if (!prefix || !PHOTO_PREFIXES.includes(prefix)) {
    throw new Error(`buildPhotoKey: prefix must be one of ${PHOTO_PREFIXES.join(', ')}`);
  }
  if (!uuid || typeof uuid !== 'string' || !SAFE_SEGMENT.test(uuid)) {
    throw new Error('buildPhotoKey: uuid is required (string, [A-Za-z0-9._-])');
  }
  if (!ext || typeof ext !== 'string' || !SAFE_EXT.test(ext)) {
    throw new Error('buildPhotoKey: ext is required (string, alphanumeric, no dot)');
  }
  if (prefix === 'standalone') {
    return `standalone/${uuid}.${ext}`;
  }
  if (!id || typeof id !== 'string' || !SAFE_SEGMENT.test(id)) {
    throw new Error(`buildPhotoKey: id is required for prefix=${prefix}`);
  }
  return `${prefix}/${id}/${uuid}.${ext}`;
}

// Helpers for callers that have a File and need an extension.
// Order: explicit (caller-supplied) > File.name extension > MIME-derived > "jpg".
const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/jpg':  'jpg',
  'image/png':  'png',
  'image/gif':  'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

export function extFromFile(file, explicit) {
  if (explicit && SAFE_EXT.test(explicit)) return explicit.toLowerCase();
  if (file?.name) {
    const m = /\.([A-Za-z0-9]+)$/.exec(file.name);
    if (m) return m[1].toLowerCase();
  }
  if (file?.type && MIME_EXT[file.type]) return MIME_EXT[file.type];
  return 'jpg';
}

// MIME fallback shared with the upload hook.
export function mimeFromFile(file) {
  return file?.type || 'image/jpeg';
}
