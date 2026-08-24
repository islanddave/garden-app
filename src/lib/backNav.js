// V4-BACKNAV-001 Slice 3a — the pure half of the Back arbiter (crucible V100, 2026-08-06).
//
// WHY THIS REPLACES useBackDismiss. Before this, Escape ran through ONE registry listener resolving
// topmost by (layer, seq), while Back ran through EIGHT per-surface popstate listeners each
// comparing its own opaque marker. Those are two different orderings, so the two gestures could
// resolve to DIFFERENT surfaces — shipped defect: with SowNow's sow sheet open and VarietyPicker's
// registry-only ConflictModal on top, Escape closed the modal (right) while Back closed the sheet
// beneath and tore the modal down with it. Slice 3a makes Back read the same registry Escape reads.
//
// Kept pure (no DOM, no React, no history) for the same reason dismissLayers.js is: jsdom cannot
// deliver an Android Back gesture, but it can drive a truth table exhaustively. src/lib/** is in
// vitest coverage.include; src/App.jsx is not.
//
// THE MARKER IS VERSION 2 AND THAT IS LOAD-BEARING. history.state survives a reload AND a deploy,
// and this app's service worker serves JS cache-first, so a v1 bundle and this one can alternate on
// the same device within one session. v1 markers were PER-SURFACE ({v:1, id}); v2 is a single
// PER-SESSION marker ({v:2, seq}). Reusing the key at v1 would let a stale per-surface marker be
// consumed as a session marker — a dead Back press. readMarker rejects v1; readAnyMarker still
// RECOGNISES it so the provider can skip it rather than act on it.
export const MARKER_KEY = '__backnav'
export const MARKER_VERSION = 2

// Strict read: only OUR current-version marker. Anything else degrades to null, which means
// "not ours" and makes Back behave exactly as it did before this feature.
export function readMarker(state) {
  const m = state && state[MARKER_KEY]
  if (!m || m.v !== MARKER_VERSION || typeof m.seq !== 'number') return null
  return m
}

// Loose read: ANY version of our marker, used only to tell "a stale entry of ours" apart from
// "someone else's entry". Never act on the result — skip or strip it.
export function readAnyMarker(state) {
  const m = state && state[MARKER_KEY]
  if (!m || typeof m.v !== 'number') return null
  return m
}

// An entry participates in Back only when it is BOTH ours to close and opted in.
//
// `armsBack` DEFAULTS FALSE and that inversion is deliberate. useBackDismiss was opt-IN at 8
// hand-picked call sites, and its own doc comment scoped that to surfaces which OPEN AND CLOSE IN
// PLACE. Moving Back into useDismissable would have made it opt-OUT — and because Sheet.jsx calls
// useDismissable ONCE on behalf of all 9 <Sheet> render sites, that would have SILENTLY enrolled
// surfaces nobody had judged. Registry membership must not imply Back membership; they are
// different questions with different safety scopes. That is why the default is false, and it still
// is.
//
// WHAT IS NO LONGER TRUE: BottomNav's two sheets. This comment used to name them as the case the
// false default existed to keep out, because every row there closes the sheet AND navigates, which
// orphans the pushed entry. As of v4.13.0 (BD-009 / BUG-BACKNAVMORE-001) they ARM — the exclusion
// cost a live bug (Back over an open sheet navigated the tab underneath), and the orphaning is
// fixed where it is actually caused, on the NAVIGATION side: BottomNav's SheetRowLink
// replace-navigates while the session marker is current, collapsing that entry into the
// destination, and its sign-out row applies the same gate at click time
// (BUG-SIGNOUTBACKRACE-001). So the false default is still the right default — it just no longer
// has BottomNav as its motivating example. A surface that navigates away MUST either consume the
// marker on the way out or leave armsBack false; those are the only two safe options.
export function isArmable(e) {
  return !!e && e.kind !== 'route' && !!e.armsBack
}

// The dismissal decision for ONE Back gesture. Exactly one outcome per input — never zero, never
// two — which is what makes the Escape/Back parity claim falsifiable rather than aspirational.
//
//   NONE      — the registry does not own this Back; the caller must NOT swallow it (let the
//               router navigate, or let the app exit).
//   BLOCKED   — topmost has a write in flight. popstate is NOT cancelable, so "blocking" can only
//               be expressed by re-pushing an entry; the provider bounds that (see A5).
//   CONFIRM   — topmost holds unsaved input AND has opted in (see the per-entry note on
//               decideDismiss). BUG-DIRTYDISMISSGAP-001 wired this to a real consumer branch: the
//               provider raises ConfirmSheet and RE-ARMS, rather than falling through to cbRef.
//   INTERCEPT — topmost wants to handle this itself first (a sub-state step-back).
//   DISMISS   — close the topmost, and only the topmost.
export function decideBack(entries, { confirmOnDirty = false, blockOnBusy = true } = {}) {
  const list = Array.isArray(entries) ? entries.filter(Boolean) : []
  if (list.length === 0) return { action: 'NONE', target: null }

  // TOPMOST OVERALL, then judge it — NOT "filter to armable, then take topmost". The difference
  // only shows in the stacked case, and the stacked case is the one that matters: an overlay opened
  // from inside an open Details sheet registers ABOVE that sheet, so filtering first would target
  // the sheet UNDERNEATH and close a surface the user cannot see while the visible overlay stays
  // put — reintroducing the exact wrong-surface defect this slice exists to fix.
  let top = null
  for (const e of list) {
    if (!top) { top = e; continue }
    if (e.layer > top.layer) { top = e; continue }
    if (e.layer === top.layer && e.seq > top.seq) top = e
  }

  // A route overlay is the router's to close. Escape still closes it (decideDismiss does not filter
  // kind) — this is the ONE place the two gestures legitimately differ, and it is deliberate: the
  // router already owns a real history entry for it, so arming a second one would produce two
  // adjacent entries for the same URL and a Back that visibly does nothing.
  if (top.kind === 'route') return { action: 'NONE', target: top }
  // NOTE `armsBack` is deliberately NOT consulted here. It governs whether a surface JUSTIFIES
  // CREATING a history entry (the BottomNav concern), not whether it may be dismissed by a Back we
  // already own. Gating dismissal on it was the first cut and it was wrong: a registry-only dialog
  // sitting on top of an armed sheet returned NONE, so Back consumed the marker and did nothing —
  // a dead press, and the exact Escape/Back divergence this slice exists to remove. Once a marker
  // is armed, Back closes the topmost, which is what parity with Escape means.
  if (blockOnBusy && top.busy) return { action: 'BLOCKED', target: top }
  // Per-entry opt-in, same three-term test decideDismiss uses — the two deciders must not disagree
  // about WHICH surfaces confirm, or Escape and Back diverge again.
  if (confirmOnDirty && top.dirty && top.confirmOnDirty) return { action: 'CONFIRM', target: top }
  if (top.canIntercept) return { action: 'INTERCEPT', target: top }
  return { action: 'DISMISS', target: top }
}

// Does any entry still want the marker held? Used by the provider to decide whether to re-arm after
// a dismissal. Kept here so the arm/re-arm predicate and the dismissal predicate cannot drift.
export function hasArmable(entries) {
  return Array.isArray(entries) && entries.some(isArmable)
}

// Consecutive BLOCKED refusals before Back is allowed through undismissed.
//
// popstate cannot be cancelled, so a refusal is implemented by pushing a fresh entry to undo the
// traversal. Unbounded, a `busy` flag that never clears would make Back stop exiting the app
// ENTIRELY — the user's only escape being force-stopping the PWA, which is the same
// no-in-app-recovery class as a stranded scroll lock. An abandoned in-flight write is the cheaper
// failure, so the refusal is bounded. Two is enough to cover a genuine save (the second press
// almost always lands after it resolves) without becoming a trap.
export const MAX_CONSECUTIVE_BLOCKS = 2
