// src/lib/micArbiter.js — V5-HARVESTVOICEFLOW-001 slice S1.
//
// ONE owner of "something is listening", across every start-path in the app. There are four
// recogniser construction sites and seven call sites (measured on dev 90a383b8):
//
//   lib/transcribe.js:139        — shared wrapper, 4 callers:
//                                    components/MicCaptureButton.jsx:169
//                                    components/TranscriptReview.jsx:169
//                                    lib/comboboxInput.js:98            (every PlantingSelect)
//                                    pages/Search.jsx:244
//   pages/EventNew.jsx:398       — useVoiceInput, open-coded, never touches transcribe.js
//   components/ContinuousVoiceProbe.jsx:283 — the /admin instrument, deliberately un-abstracted
//   pages/VoiceHarvest.jsx:74    — the continuous harvest flow
//
// Before this module, nothing knew about anything else: two of those could be live at once and the
// second one's results interleaved with the first's. The arbiter does not stop that by disabling
// controls — it stops it by making the newest start win and shutting the previous one down.
//
// ── THE ONE RULE THAT MATTERS: ACQUIRE ON start(), NEVER ON MOUNT ────────────────────────────────
//
// pages/CaptureFlow.jsx mounts THREE PlantingSelects simultaneously (:695, :734, :749) and
// pages/PhotoLibrary.jsx mounts two. A mount-time acquisition looks correct in every single-picker
// test in the suite and silently disables two of CaptureFlow's three the moment it ships, because
// the second and third mounts would evict the first before the user has touched anything.
//
// Acquiring at start() keeps all of them mounted, enabled and startable — which is the C7 regression
// criterion — while still guaranteeing only one is ever LISTENING. Nothing in this module reads or
// writes component state, and mounting a consumer costs nothing.
//
// ── A HOLD IS A LISTENING SESSION, NOT A RECOGNISER OBJECT ───────────────────────────────────────
//
// VoiceHarvest and ContinuousVoiceProbe both re-arm on `onend`, constructing a fresh recogniser
// every 15–22 ms. Those must acquire ONCE for the whole run and release when the run ends. Releasing
// per recogniser would open a window on every re-arm in which another surface could take the mic
// mid-sentence — the exact interleaving this module exists to prevent. Single-capture callers
// (everything through transcribe.js) have one recogniser per session, so the distinction collapses.
//
// ── WHY THE TOKEN ────────────────────────────────────────────────────────────────────────────────
//
// Same lesson as voiceCommitDebounce's invalidateLastWrite(token): an identity-free release races.
// `onend` is a real browser event and arrives AFTER the handover, so an evicted owner's release
// lands while the new owner holds the slot. Scoping release to the token makes that late call a
// no-op instead of a silent mic theft. Releases are therefore expected to fail and say so by
// returning false; that is not an error condition.
//
// Everything here is synchronous by contract. transcribe.js documents the iOS/Chrome
// user-activation rule — `.start()` must run in the tap handler's own frame — so acquire may not
// await, allocate a promise, or hop a microtask. A previous owner's stop() is called synchronously
// and inside try/catch: a throwing evictee must never prevent the new owner from starting.

let holder = null   // { token, label, stop } | null
let seq = 0

/**
 * Take the mic. Stops whoever held it first.
 *
 * @param {string}   label  surface name, for debugging and for micHolder(). Not an identity —
 *                          two mounts of the same component pass the same label and are still
 *                          distinct owners.
 * @param {Function} stop   synchronous shutdown for THIS owner. Called if someone else acquires.
 *                          Must be idempotent: it can also be reached by the owner's own cleanup.
 * @returns {object} token  opaque; pass to releaseMic().
 *
 * A caller that is already holding must releaseMic(itsToken) first. Acquiring twice without
 * releasing makes the second acquire evict the first — i.e. the owner stops itself.
 */
export function acquireMic(label, stop) {
  const previous = holder
  const token = { id: ++seq }
  // Install BEFORE evicting. The evicted owner's stop() may synchronously dispatch its own onend,
  // which calls releaseMic with the OLD token; with the new holder already in place that release
  // correctly no-ops. Evicting first would leave a window where holder is the dying owner.
  holder = { token, label: String(label || 'unknown'), stop: typeof stop === 'function' ? stop : noop }
  if (previous) {
    try { previous.stop() } catch { /* an evictee that throws must not block the new owner */ }
  }
  return token
}

/**
 * Give the mic back. Only the current holder can; a stale token is ignored.
 * @returns {boolean} true if this token held the mic and released it.
 */
export function releaseMic(token) {
  if (!token || !holder || holder.token !== token) return false
  holder = null
  return true
}

/** Label of the current holder, or null. Debug and test surface only — never gate UI on this. */
export function micHolder() {
  return holder ? holder.label : null
}

/** True while any surface is listening. Debug and test surface only. */
export function isMicHeld() {
  return holder !== null
}

/**
 * Drop the hold without running the holder's stop(). Tests only — module state outlives a
 * component tree, so a test that leaves a holder installed poisons the next one.
 */
export function resetMicArbiter() {
  holder = null
  seq = 0
}

function noop() {}
