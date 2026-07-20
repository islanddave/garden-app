// V4-OVERLAY-001 Slice 2 — draft stash for the capture forms (§4 / §5.2 dirty-guard pairing).
// When a DIRTY /log or /log/many form is dismissed as an overlay, its in-progress state must survive
// so re-opening resumes it (the dirty-backdrop guard stops the accidental discard; this keeps the
// bytes). Smallest correct mechanism: a single versioned sessionStorage record per route key,
// written on change and cleared on a successful submit. sessionStorage (not localStorage) so a draft
// is scoped to the tab/session, never resurrected weeks later.
//
// Guarded everywhere: sessionStorage can throw (Safari private mode) or be absent (SSR/jsdom without
// the shim) — every call no-ops rather than crashing the form. Non-serializable field values (e.g. a
// picked File) are simply absent from the snapshot the caller passes; this module never touches them.

const PREFIX = 'gardenApp.draft.'
const VERSION = 1

export function draftKey(routeKey) {
  return PREFIX + routeKey
}

export function readDraft(routeKey) {
  try {
    const raw = sessionStorage.getItem(draftKey(routeKey))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || parsed.v !== VERSION) return null
    return parsed.data ?? null
  } catch {
    return null
  }
}

export function writeDraft(routeKey, data) {
  try {
    sessionStorage.setItem(draftKey(routeKey), JSON.stringify({ v: VERSION, data }))
  } catch {
    /* sessionStorage unavailable/full — a lost draft is acceptable; a crash is not */
  }
}

export function clearDraft(routeKey) {
  try {
    sessionStorage.removeItem(draftKey(routeKey))
  } catch {
    /* ignore */
  }
}
