// haptics.js — V4-HAPTICVOCAB-001. The operational feedback vocabulary for the one-handed
// weigh-in surface (EventNew's `?session=harvest` panel + its NumberPad).
//
// WHY THIS EXISTS. Dave logs harvests at a bench with his eyes ON THE SCALE and his right hand
// committed to the fruit. Measured on this build: the app has ZERO `navigator.vibrate`, ZERO audio,
// and `document.querySelectorAll('[aria-live],[role="status"],[role="alert"]')` is EMPTY on that
// surface until something errors — so nothing confirms anything through a channel he is actually
// attending to. The highest-value case is a REJECTED keypress: `numberPad.js` refuses a second '.'
// and any digit at `maxLen`, and the only signal is the key DIMMING. Eyes-on-scale, a refused tap
// feels exactly like an accepted one, so his mental model of the field diverges from its value and
// a wrong weight gets saved while he believes it is right. That is a data-integrity defect with a
// UI cause, and it is what this module exists to close.
//
// ── PRIOR RULING THIS RE-OPENS (read before deleting or extending) ────────────────────────────
// A log-save haptic ALREADY SHIPPED here and was deliberately REMOVED — see EventNew.jsx:1454-1455
// and `reward-ux-conformance-audit-V001-20260522.2150.md` §V-4, ratified by Dave 2026-05-22. Its
// own words: "Borderline (a save-confirmation could be task-feedback) but the channel is banned and
// the save completes without it → treat as a reward-signal-via-banned-channel." The banned-channel
// list it enforces (gardening.md §Reward UX) scopes to REWARD surfaces — XP, levels, critters — and
// the audit's disposition points forward to "the already-planned T-1 'haptic opt-in/default-OFF'
// Increment-0 direction". This module is that T-1 line, not a revival of §V-4: every pattern here is
// OPERATIONAL (did the input land / did the row save / did the undo apply), none is a reward signal,
// nothing fires on XP, level-up or critter award, and the whole vocabulary is behind a preference.
// Anyone adding a reward-path caller is re-committing the exact violation the audit closed.
//
// ── RULINGS ENCODED HERE (these are decisions, not defaults; changing one is a decision too) ───
// 1. GATED ON PREFERENCE **AND** CAPABILITY, both independently. Two separate suppressors, so any
//    test of one must neutralise the other or the mutation is masked.
// 2. **NOT gated on `prefers-reduced-motion`.** Haptics are not motion. That query is about visual
//    vestibular load — parallax, zoom, autoplay — and a phone in a pocket set to "reduce motion"
//    still buzzes for every message. Conflating the two is a category error whose cost lands
//    entirely on this user: it would silently disable the ONE channel that reaches him, on a
//    surface where the alternative is a mis-recorded weight. If a "reduce haptics" preference is
//    ever wanted it is its own switch (below), not a rider on a visual-motion query.
// 3. **No audio, ever.** A kitchen bench with running water is a poor audio environment and the
//    phone may be silenced; a cue that is inaudible half the time trains the user to ignore it.
//    `reward-ux-conformance-audit` §Out-of-scope also bans sound outright on this app.
// 4. **No haptic on field advance** (quantity → weight). It is user-initiated and visible, and a
//    vocabulary that fires on navigation as well as on outcomes teaches the hand to ignore it.
//    Encoded as the ABSENCE of a PATTERNS key, and pinned by a test, so it reads as a ruling rather
//    than an omission somebody helpfully "fixes".

// '1'/'0' with a null-means-default read, mirroring the house convention for a device-local
// preference (ScopeChecklist.jsx:57 `quicklog.defaultAllSelected`).
export const HAPTIC_PREF_KEY = 'haptics.enabled.v1'

// ON by default: Dave chose the full vocabulary for this surface, and there is no settings UI in
// this slice — shipping default-OFF would ship a feature nothing can turn on. The audit's T-1 line
// says "opt-in/default-OFF" about REWARD haptics; this is the operational set. Flipping this single
// constant is the entire cost of reversing that call.
export const HAPTIC_DEFAULT_ENABLED = true

// ── THE VOCABULARY ────────────────────────────────────────────────────────────────────────────
// Six events, five patterns (field advance is silent by ruling 4). The set is designed to be
// discriminable BY FEEL ALONE, eyes elsewhere, on three orthogonal axes:
//   • PULSE COUNT      — 1 or 2. The most robust discriminator for cues this brief.
//   • PULSE WEIGHT     — tick (≤20ms) / mid (21-45ms) / heavy (≥46ms).
//   • SYMMETRY         — equal pulses vs an ascending short→long ramp.
// The ordered weight-class signature is UNIQUE per event, so no two patterns share both count and
// weight profile: accepted [tick] · rejected [tick,tick] · committed [mid] · failed [heavy,heavy] ·
// undo [tick,mid]. haptics.test.js pins that uniqueness as a feature vector, not as array
// inequality — array inequality would pass for two patterns that feel identical.
export const PATTERNS = {
  // A landed digit. Deliberately the lightest thing the motor can do: it fires on EVERY keypress,
  // and anything heavier becomes noise across a 12-variety session.
  digitAccepted: 10,
  // The one that matters. TWO ticks, because count is the axis a fingertip reads without attention
  // — "that was not one tap's worth" is legible before any duration judgment is.
  digitRejected: [8, 40, 8],
  // The row is on the server. One mid pulse: 3.5x the accepted tick, well past the vibrotactile
  // duration JND, and a different event class (fires from the Save band, not the pad).
  saveCommitted: 35,
  // Failure must be unmistakably unlike success, so it differs on BOTH axes at once — two pulses
  // instead of one, and heavy instead of mid. 170ms total, the longest thing in the vocabulary.
  saveFailed: [60, 50, 60],
  // Undo is short→long, the only ASCENDING pattern here. Same count as digitRejected and the same
  // 40ms gap, but rejected is [tick,tick] and this is [tick,mid]: the second pulse growing rather
  // than matching is what the hand reads, and the two never fire from the same control anyway.
  undoApplied: [15, 40, 30],
}

export function hapticsSupported() {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function'
}

export function hapticsEnabled() {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return HAPTIC_DEFAULT_ENABLED
    const v = localStorage.getItem(HAPTIC_PREF_KEY)
    return v === null ? HAPTIC_DEFAULT_ENABLED : v === '1'
  } catch {
    // try/catch per the house convention (cropLogLedger.readStore, clientPrefs.clearClientPrefs):
    // an unavailable or throwing localStorage degrades to the default, never to an error on a
    // keypress path.
    return HAPTIC_DEFAULT_ENABLED
  }
}

export function setHapticsEnabled(on) {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return
    localStorage.setItem(HAPTIC_PREF_KEY, on ? '1' : '0')
  } catch { /* unavailable/denied — the preference simply does not persist */ }
}

// Fire one named pattern. Returns TRUE only when the platform accepted the request.
//
// The return value is not decoration: Chrome returns false when it refuses a vibration (no user
// activation on the frame, or a hidden document), which is the only in-app signal that the
// ACTIVATION RISK below actually bit. Callers may ignore it; the on-device check in the lane report
// reads it.
//
// ACTIVATION RISK — stated, not papered over. Chrome gates `vibrate` on user activation. The pad,
// reject and undo patterns are all gesture-descended (they run inside the click handler that caused
// them) and are safe. `saveCommitted` and `saveFailed` fire from an ASYNC response and can be
// refused. So neither of those two is ever the ONLY channel: both are accompanied by a visible
// change (the session strip / the error banner) and by a live-region announcement — the redundancy
// is placed exactly where the delivery guarantee is weakest. A dropped save haptic costs the
// eyes-free confirmation; it never costs the confirmation.
export function haptic(name) {
  const pattern = PATTERNS[name]
  if (pattern === undefined) return false      // unknown name, and field advance by ruling 4
  if (!hapticsEnabled()) return false
  // REDUNDANT-SUPPRESSION NOTE. This guard and the catch below suppress the SAME observable for the
  // same input — with vibrate absent, deleting this line still returns false, because calling a
  // non-function throws a TypeError the catch swallows. A mutation run confirmed it: removing this
  // line left every return-value assertion green (the mutant SURVIVED). So the check is pinned on
  // the one axis the catch cannot fake — that the capability is CONSULTED before it is used, not
  // discovered by throwing on every keypress on a platform that has no motor. haptics.test.js
  // counts reads of `navigator.vibrate` for exactly that reason; a refactor that caches the
  // function in a local must update that test rather than delete it.
  if (!hapticsSupported()) return false
  try {
    return navigator.vibrate(pattern) !== false
  } catch {
    // Some engines throw on a pattern they dislike rather than returning false. A feedback cue must
    // never be able to take down the keypress or the save that invoked it.
    return false
  }
}

// Named wrappers — the call sites read as the event, not as a lookup key, so a typo is a build
// error at the caller instead of a silent no-op inside haptic().
export const hapticDigitAccepted = () => haptic('digitAccepted')
export const hapticDigitRejected = () => haptic('digitRejected')
export const hapticSaveCommitted = () => haptic('saveCommitted')
export const hapticSaveFailed = () => haptic('saveFailed')
export const hapticUndoApplied = () => haptic('undoApplied')
