// src/lib/reloadGate.js
// OPS-SWRELOADGUARD-001 — a deferral channel between in-progress capture forms and registerSW's
// controllerchange→reload().
//
// Why it exists: public/sw.js skipWaiting()s at install and clients.claim()s, and registerSW
// reload()s the page the instant a new worker takes control — including off the
// visibilitychange→visible update re-check, i.e. exactly when the phone comes out of a pocket at a
// plant. public/releases.json holds 105 releases across 24 active days (~4.4/active day), so a
// deploy landing mid-form is routine, not hypothetical. It destroys a typed harvest weight ON FULL
// SIGNAL: DRAFT_FORM_FIELDS does not cover harvest quantity/weight, so nothing restores it.
//
// DEFER, DO NOT DISARM. BUG-STALECLIENT-001 exists because updates parked in `waiting` forever and
// clients silently ran a stale bundle indefinitely; blocking the swap outright would rebuild that
// bug. A hold only postpones the reload to the next safe moment — the instant the last hold clears,
// or the next resume with nothing held.
//
// KEYED SET, NOT A BOOLEAN. Several surfaces can be dirty at once (a capture form under an open
// overlay, PutUp, LogMany). With a shared boolean the second surface reporting clean would release
// the first surface's hold; a per-surface key cannot.
//
// Framework-free on purpose: registerSW runs before React mounts and consults this from module
// scope, so it must not pull in React or a context.
//
// FIRST INTENDED CONSUMER: src/pages/EventNew.jsx — call setReloadBlocked('event-new', isDirty)
// from an effect whose cleanup releases the key (same shape as useReportOverlayDirty), so a
// dismissed or unmounted form can never strand a hold and wedge updates forever.

const holds = new Set()
const listeners = new Set()

/**
 * Hold (or release) the service-worker reload for one surface.
 *
 * @param {string} key    stable per-surface id — the SAME key must release it
 * @param {boolean} blocked  true to hold, false to release
 */
export function setReloadBlocked(key, blocked) {
  if (!key) return
  const wasBlocked = holds.size > 0
  if (blocked) holds.add(key)
  else holds.delete(key)
  // Only the non-empty→empty transition is interesting. Releasing a key that was never held, or
  // one of several, must not fire a deferred reload while another surface is still dirty.
  if (wasBlocked && holds.size === 0) {
    // Snapshot: a listener that unsubscribes itself mid-notify (registerSW does, immediately
    // before reloading) would otherwise mutate the set under iteration.
    for (const cb of [...listeners]) {
      try { cb() } catch { /* noop */ }
    }
  }
}

/** True while any surface holds the reload. */
export function isReloadBlocked() {
  return holds.size > 0
}

/**
 * Subscribe to the last-hold-released transition. Returns an unsubscribe function.
 * Never fires on subscribe — callers that need the current state read isReloadBlocked().
 */
export function onReloadUnblocked(cb) {
  if (typeof cb !== 'function') return () => {}
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/**
 * Drop every hold WITHOUT notifying. Test/teardown reset only — production surfaces release their
 * own key, and a silent clear here must not trip a deferred reload in an unrelated registration.
 */
export function clearReloadBlocks() {
  holds.clear()
}
