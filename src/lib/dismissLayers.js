// V4-BACKNAV-001 Slice 1 — the pure half of the dismiss registry (decision V200 §3).
//
// WHY THIS EXISTS. Before this, "which modal is on top?" had THREE disagreeing answers:
//   1. Sheet.jsx's module-level openStack — insertion order, and it sees only Sheets.
//   2. Paint order — hardcoded zIndex literals scattered across ~69 sites.
//   3. Nothing at all — 8 of the app's 9 role="dialog" surfaces bind their own ungated document
//      keydown, so Escape over a Sheet+Lightbox stack fires BOTH onCloses today.
// An arbiter whose stack order disagrees with paint order dismisses a surface the user cannot see
// is on top. So layer is derived from the SAME scale that paints, and topmost = highest layer with
// insertion order as the tiebreak.
//
// Kept pure (no DOM, no React, no history) because it is the one part of back-nav that jsdom can
// exercise faithfully: the harness cannot deliver a real Android Back gesture, but it can drive a
// truth table. Lives in src/lib/ deliberately — vitest.config.ts coverage.include covers src/lib/**
// but NOT src/App.jsx, so an arbiter placed in App.jsx would be invisible to the coverage ratchet.

// Paint scale. These are the values already in use at the call sites, promoted to named tokens so
// registration order and paint order cannot drift apart. Sheet's backdrop/panel pair (190/200) and
// the 1000 used by Lightbox/ConflictModal/CritterFactsPopover/StreakModal are observed, not chosen.
export const Z = {
  sheetBackdrop: 190,
  sheet: 200,
  overlay: 300,          // FacebookShareSheet paints here — observed, not chosen
  dialog: 1000,
  systemConfirm: 1200,   // reserved: the B3 exit confirm must outrank every ordinary surface
}

// Layer tokens consumers pass to useDismissable. Named rather than numeric at the call site so a
// consumer never invents a z-value that the registry cannot order.
export const LAYER = {
  SHEET: Z.sheet,
  OVERLAY: Z.overlay,
  DIALOG: Z.dialog,
  SYSTEM: Z.systemConfirm,
}

// LAYER MUST MATCH WHAT THE SURFACE ACTUALLY PAINTS. That is this module's whole premise (see the
// header): an arbiter whose stack order disagrees with paint order dismisses a surface the user
// cannot see is on top.
//
// Four surfaces shipped in v3.103.0 violating it — they registered DIALOG (1000) while painting
// 200–300: PhotoLibrary's PhotoModal, SpaceAttachPicker, LoveMehPopover (all 200) and
// FacebookShareSheet (300). With any Sheet open beneath, the registry ranked them above a surface
// that paints level with or above them, so ESCAPE COULD ALREADY RESOLVE TO THE WRONG SURFACE in
// prod — independent of Back. Corrected at those four call sites; `layerMatchesPaint.test.js` pins
// the pairs so the two scales cannot drift apart again.

// Highest layer wins; equal layers break by insertion order (later = on top). Returns null for an
// empty stack — callers use that to mean "nothing registered, let the event through".
export function resolveTopmost(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null
  let best = null
  for (const e of entries) {
    if (!e) continue
    if (!best) { best = e; continue }
    if (e.layer > best.layer) { best = e; continue }
    if (e.layer === best.layer && e.seq > best.seq) best = e
  }
  return best
}

// The dismissal decision for ONE dismissal gesture (Escape, Back, or a labelled Close routed here).
// Exactly one outcome per input — never zero, never two. That closed-enum shape is what makes B1
// falsifiable rather than aspirational ("handled wherever possible" cannot fail a test).
//
//   NONE    — nothing registered; the caller must NOT swallow the event (Back should navigate).
//   BLOCKED — topmost has a write in flight; swallow the gesture, show the surface's reason.
//   CONFIRM — topmost holds unsaved input; ask before discarding.
//   DISMISS — close the topmost, and only the topmost.
//
// `confirmOnDirty` and `blockOnBusy` are the CALLER's opt-ins. `blockOnBusy` still defaults false
// here (the provider passes true); `confirmOnDirty` defaults false as the global kill-switch.
//
// BUG-DIRTYDISMISSGAP-001 — CONFIRM now needs BOTH the caller's switch AND the entry's own
// `confirmOnDirty`. The per-entry term is not belt-and-braces, it is what makes the switch safe to
// turn on at all: `dirty` means four different things at the four sites that pass it (a route
// overlay's aggregate, PlantingEditor's deliberately over-reporting latch ×3), and the three overlay
// routes behind App.jsx's OverlayHost carry real draft stashes, so confirming there would nag on the
// app's most-used path to protect content that already survives the dismiss. This is exactly the
// precedent `armsBack` set in backNav.js: registry membership must not imply Back membership, and by
// the same argument it must not imply CONFIRM membership. Entries opt in one at a time.
export function decideDismiss(entries, { confirmOnDirty = false, blockOnBusy = false } = {}) {
  const target = resolveTopmost(entries)
  if (!target) return { action: 'NONE', target: null }
  if (blockOnBusy && target.busy) return { action: 'BLOCKED', target }
  if (confirmOnDirty && target.dirty && target.confirmOnDirty) return { action: 'CONFIRM', target }
  return { action: 'DISMISS', target }
}
