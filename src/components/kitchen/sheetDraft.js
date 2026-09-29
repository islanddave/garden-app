// src/components/kitchen/sheetDraft.js
// Put-Up 1a (V4 §6.5 "Drafts: one mechanism") — the draft every new Put-Up sheet keeps while it is
// being filled in, so Android Back (which closes the sheet) and a deploy reload (which reloads the
// app under it) never cost the cook what they typed.
//
// ONE KEY PER SHEET PER BATCH PER PERSON:
//     garden:putup-draft:v1:<clerk sub>:<sheet>:<batch id | new>
// The sub is in the key so Dave's half-typed check-in never restores on Jen's phone session, and a
// sign-out/sign-in as someone else cannot read it back. The batch id is in the key so a check-in typed
// against one crock can never restore onto another — the same rule BatchCloseField's `batchId` guard
// states for its own draft.
//
// WHY localStorage AND NOT draftStash.js (sessionStorage): the same reason putUpSession.js gives for
// the walk. Dave runs an installed PWA on Android, where a backgrounded process can be discarded
// outright, taking sessionStorage with it; a check-in abandoned for a phone call is exactly the
// draft worth keeping. localStorage outlives that, so a record carries `savedAt` and EXPIRES after
// 24 h (a day-old half-sentence restored into a new check-in is a wrong write waiting to happen),
// and every read sweeps expired Put-Up drafts first — the "boot sweep", run lazily at the first
// sheet that opens rather than from App.jsx, which this lane does not own.
//
// VERSIONED AND SHAPE-CHECKED: `v` must match and the caller's `isShape` must accept `data`, or the
// record is dropped rather than half-restored. A stale bundle's draft shape is not trusted.
//
// No idempotency key rides in a 1a draft: keys arrive in release 1b (V4 §5.2), and a check-in is
// not keyed at all — `busy` refuses a second Save instead.
//
// Every accessor is try/catch'd and falls back to "no draft": storage throws in private modes, and a
// lost draft is acceptable where a crash is not.
//
// STORAGE ONLY — no React, no AuthContext. AuthContext.signOut imports clearSheetDraftsFor from here,
// so importing AuthContext back would make a cycle; the signed-in person's key comes from the hook in
// ./useSheetDraftKey.js instead.

export const SHEET_DRAFT_PREFIX = 'garden:putup-draft:v1:'
export const SHEET_DRAFT_VERSION = 1
export const SHEET_DRAFT_TTL_MS = 24 * 60 * 60 * 1000

function storage() {
  try { return typeof window !== 'undefined' ? window.localStorage ?? null : null } catch { return null }
}

// null when there is no signed-in person — a draft nobody owns is never written.
export function sheetDraftKey(sub, sheet, id) {
  if (!sub || !sheet) return null
  return `${SHEET_DRAFT_PREFIX}${sub}:${sheet}:${id || 'new'}`
}

function parseRecord(raw) {
  try {
    const rec = JSON.parse(raw)
    return rec && typeof rec === 'object' && !Array.isArray(rec) ? rec : null
  } catch { return null }
}

function isLive(rec, nowMs) {
  return !!rec && rec.v === SHEET_DRAFT_VERSION
    && typeof rec.savedAt === 'number' && Number.isFinite(rec.savedAt)
    && nowMs - rec.savedAt >= 0 && nowMs - rec.savedAt < SHEET_DRAFT_TTL_MS
}

// Drops every Put-Up draft that is expired, from another version, or not a record at all. Keys are
// collected before any removal so the scan never walks a list it is shrinking.
export function sweepSheetDrafts(nowMs = Date.now()) {
  const s = storage()
  if (!s) return
  try {
    const keys = []
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i)
      if (k && k.startsWith(SHEET_DRAFT_PREFIX)) keys.push(k)
    }
    for (const k of keys) if (!isLive(parseRecord(s.getItem(k)), nowMs)) s.removeItem(k)
  } catch { /* non-fatal */ }
}

export function readSheetDraft(key, sheet, isShape, nowMs = Date.now()) {
  const s = storage()
  if (!s || !key) return null
  sweepSheetDrafts(nowMs)
  try {
    const rec = parseRecord(s.getItem(key))
    if (!isLive(rec, nowMs) || rec.sheet !== sheet) return null
    if (typeof isShape === 'function' && !isShape(rec.data)) { s.removeItem(key); return null }
    return rec.data
  } catch { return null }
}

export function writeSheetDraft(key, sheet, data, nowMs = Date.now()) {
  const s = storage()
  if (!s || !key) return
  try { s.setItem(key, JSON.stringify({ v: SHEET_DRAFT_VERSION, sheet, savedAt: nowMs, data })) } catch { /* non-fatal */ }
}

export function clearSheetDraft(key) {
  const s = storage()
  if (!s || !key) return
  try { s.removeItem(key) } catch { /* non-fatal */ }
}

// For the sign-out funnel (V4 §6.5: "the sign-out funnel clears the sub's drafts"), called from
// AuthContext.signOut before the Clerk call. Removes only this person's drafts.
export function clearSheetDraftsFor(sub) {
  const s = storage()
  if (!s || !sub) return
  try {
    const mine = `${SHEET_DRAFT_PREFIX}${sub}:`
    const keys = []
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i)
      if (k && k.startsWith(mine)) keys.push(k)
    }
    for (const k of keys) s.removeItem(k)
  } catch { /* non-fatal */ }
}
