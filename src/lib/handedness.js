// src/lib/handedness.js — V4-HANDEDNESSCONTROLS-001 (BD-054). Which hand works the phone.
//
// THIS IS A SAFETY SETTING, NOT A COSMETIC ONE. Dave's weigh-in ergonomics: the RIGHT hand moves
// fruit onto the scale and the LEFT hand logs. Every two-control row in this app was laid out on
// the unstated assumption of a right thumb — HarvestWatchBand.jsx:323-327 says so in as many words
// ("'Log harvest' takes the right-hand natural thumb zone and 'Not yet' the harder-to-reach left").
// Worked left-handed that reasoning INVERTS: the control under the thumb becomes "Not yet", which
// writes suppressed_until = observed_on + 10 days and can cost 20 days of invisibility on a system
// running 11.8% calibration. A stray thumb tap stops landing on navigation and starts landing on
// the destructive control. That is the defect this preference exists to close.
//
// A SETTING, NOT A CONSTANT — Dave's instruction, verbatim: "I want a setting if at all possible.
// My usage may easily change based on setup/kitchen space." So nothing here hardcodes 'left'.
//
// DEFAULT IS 'right', AND THAT DEFAULT IS LOAD-BEARING. Every wired surface renders byte-identically
// to its pre-change output while the value is unset, so this lands as a provable no-op for anyone
// who never opens the setting — including Jen, and including the pinned oracles on those surfaces.
//
// STORAGE. localStorage is the SYNCHRONOUS layer only, exactly as whatsNew.js and ScopeChecklist
// use theirs: a layout that resolves on the first frame cannot flicker its controls into place
// while a prefs GET is in flight, and a control that MOVES after first paint is a worse version of
// the same mis-tap hazard. The per-user cross-device layer is user_notification_prefs.handedness
// (see src/hooks/useHandedness.js) — the store this app already has, not a second one.
//
// try/catch per the house convention (cropLogLedger.readStore, clientPrefs.clearClientPrefs): an
// unavailable or throwing localStorage degrades to the default hand, never to an error on a render
// path. A private-mode browser gets right-handed layout, which is what it gets today.

export const HANDS = ['right', 'left']
export const DEFAULT_HAND = 'right'
export const HANDEDNESS_KEY = 'ui.handedness'
// Cross-instance notification, same mechanism as whatsNew.js's SEEN_EVENT: ten surfaces read this
// value and they must all turn over on the same tap, without a reload and without a provider.
export const HANDEDNESS_EVENT = 'garden:handedness'

// Anything that is not one of the two known hands is the default. Not a truthiness check and not a
// throw: a corrupted key, a value written by a future version, and "never set" are all the same
// answer here — lay the app out the way it has always been laid out.
export function normalizeHand(v) {
  return HANDS.includes(v) ? v : DEFAULT_HAND
}

export function readHand() {
  try { return normalizeHand(localStorage.getItem(HANDEDNESS_KEY)) } catch { return DEFAULT_HAND }
}

export function writeHand(v) {
  const hand = normalizeHand(v)
  try {
    localStorage.setItem(HANDEDNESS_KEY, hand)
    if (typeof window !== 'undefined' && window.dispatchEvent) window.dispatchEvent(new Event(HANDEDNESS_EVENT))
  } catch { /* private-mode / SSR: the in-memory hand still updates via the hook's own state */ }
  return hand
}

// THE ONE PRIMITIVE EVERY WIRED SURFACE USES, and the reason the safety property is expressible in
// a test rather than only in a comment. Callers name the two controls by CONSEQUENCE — which one
// they want under the thumb and which one they want out of its way — and get back DOM order,
// leading first. Nothing at a call site has to reason about "left" or "right" again.
//
// DOM order is deliberately the ONLY mechanism. `flexDirection: row-reverse` and CSS `order` would
// both do this visually while leaving DOM order — and therefore tab order, screen-reader order, and
// everything jsdom can observe — pointing the old way. Two mechanisms for one behaviour is also how
// a mutation test goes green whichever one you break (L: redundant-suppression-hides-mutations), so
// there is exactly one here and the tests assert no reversing flexDirection alongside it.
export function orderByThumb(hand, underThumb, farSide) {
  return normalizeHand(hand) === 'left' ? [underThumb, farSide] : [farSide, underThumb]
}

// The physical edge the thumb reaches, for the surfaces that position with absolute `left:`/`right:`
// offsets rather than flow (comboboxInput.js's ⌨/🎤/✕ slots). Those offsets are physical, not
// logical, so no `dir` flip and no flex reorder would ever reach them.
export function thumbEdge(hand) {
  return normalizeHand(hand) === 'left' ? 'left' : 'right'
}

// The opposite edge, for the padding that keeps text out from under those slots.
export function offhandEdge(hand) {
  return normalizeHand(hand) === 'left' ? 'right' : 'left'
}
