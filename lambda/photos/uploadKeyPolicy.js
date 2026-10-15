// A0.1 — closed allowlist for the caller-named key on GET /api/photos/upload-url.
// The grammar mirrors src/lib/photoKeys.js buildPhotoKey EXACTLY (the only shapes the app
// client emits): standalone/{uuid}.{ext} or {prefix}/{id}/{uuid}.{ext}. Segments are dot-free
// (genUuid + DB uuids never contain dots) — that one restriction rejects traversal (`..`),
// absolute keys, and multi-extension smuggling in a single rule. 'inbox' is DELIBERATELY
// absent: inbox/* keys are server-derived by POST /api/photos/batch from the authenticated
// Clerk sub and must never be caller-named (see the photoKeys.js NOTE) — any inbox key here
// is a spoof attempt and 403s.
export const UPLOAD_KEY_PREFIXES = Object.freeze([
  'standalone',
  'events',
  'projects',
  'plants',
  'locations',
  'inventory',
]);

const SEG = '[A-Za-z0-9_-]+';
const FILE = `${SEG}\\.[a-z0-9]{1,8}`;
const KEY_RE = new RegExp(
  `^(?:standalone/${FILE}|(?:${UPLOAD_KEY_PREFIXES.filter((p) => p !== 'standalone').join('|')})/${SEG}/${FILE})$`
);

export function isAllowedUploadKey(key) {
  return typeof key === 'string' && key.length <= 256 && KEY_RE.test(key);
}

// I34 (BUG-AUTHZLAMBDA-001) — what POST /api/photos may REGISTER as storage_path: a caller-nameable
// upload key above, or the caller's OWN inbox key in exactly the shape POST /api/photos/batch mints
// (inbox/{sub}/{uuid}.{ext}). Never thumbs/…, never another sub's inbox, never a nested, traversal
// or empty tail — a bare startsWith() admitted all three. SAFE_KEY_SEGMENT is the ONE copy of the
// sub rule: index.js imports it for the check /batch applies before putting the sub in a key, so
// POST and /batch cannot drift. A whole-segment `.` or `..` is refused (never a Clerk sub).
export const SAFE_KEY_SEGMENT = /^(?!\.\.?$)[A-Za-z0-9._-]+$/;
const INBOX_FILE_RE = new RegExp(`^${FILE}$`);

export function isAllowedStoragePath(sp, userId) {
  if (isAllowedUploadKey(sp)) return true;
  if (typeof sp !== 'string' || typeof userId !== 'string' || sp.length > 256) return false;
  const pfx = `inbox/${userId}/`;
  return SAFE_KEY_SEGMENT.test(userId) && sp.startsWith(pfx) && INBOX_FILE_RE.test(sp.slice(pfx.length));
}
