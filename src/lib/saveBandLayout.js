// saveBandLayout.js — BUG-WEIGHPADSAVEBAND-001.
// The one place that states how much room a control owes EventNew's sticky Save band, and the
// only mechanism that enforces it.
//
// WHY THIS IS NOT A MARGIN IN THE MARKUP. The band (`[data-testid="save-sticky"]`) is
// `position: sticky; bottom: SAVE_BAND_BOTTOM_INSET_PX` inside its scrollport and floats OVER the
// form — transparent before a save, so the strip of viewport it owns is INVISIBLE and still answers
// every hit test (`pointerEvents: auto`, full content width, only its right ~180px painted). And its
// height is not a constant: 48px with the action row alone, 128px once one session ledger row
// renders, 156px at two, 184px at the three-row cap. The band's TOP EDGE therefore moves by 136px
// during an ordinary weigh-in session while the form underneath is laid out knowing none of it. A
// static `marginBottom` cannot express that, which is exactly how the shipped clearance came to be
// an accident rather than a decision.
//
// MEASURED, real engine, tests/harness at a TRUE 390x500 (page inside a 390px iframe in a
// normally-sized window — macOS Chrome floors an OS window at ~500px and CROPS the capture instead
// of reflowing, so `--window-size=390` measures a 500px layout and lies). Weigh-in session,
// full-page surface, harvest section anchored, self-evidenced `innerWidth 390 / scrollWidth 390 /
// no h-scroll`:
//   band y384-432 (h48)  ·  weight keypad bottom row y351-399
//   → 15px of every bottom-row key covered; key centre 9px from the band's top edge, i.e. 9px from
//     `elementFromPoint` returning `#save-sticky` instead of the key.
// BUG-WEIGHPADSAVEBAND-001 measured the same collision at 1px on the pre-BD-063 build, where the
// quantity pad still carried its `Next →` row and pushed the weight pad 56px lower. 1px and 9px are
// the same accident at two different values; neither was ever chosen.
//
// ⚠️ jsdom can falsify NONE of the geometry above — `getBoundingClientRect()` returns zeros there
// and `elementFromPoint` is meaningless (tests/harness/README.md:14-16). The pure functions below
// are unit-testable because they take rects as ARGUMENTS; the layout claim they encode is not, and
// is gated by `scripts/layout-gate/save-band-clearance.mjs` instead.
import { BOTTOM_NAV_HEIGHT_PX } from './constants.js'

// The band's own bottom offset on the full-page surface: clear the fixed BottomNav, plus a 12px
// gap. Named rather than spelled `BOTTOM_NAV_HEIGHT_PX + 12` at the render site so the number the
// clearance rule is measured against has one home. (In the overlay the band's inset is 0 — the
// Sheet paints over the nav and reserves its own safe-area foot — so this is the full-page value.)
export const SAVE_BAND_BOTTOM_INSET_PX = BOTTOM_NAV_HEIGHT_PX + 12

// THE STATED MINIMUM. Vertical gap every interactive control owes the band's rendered top edge.
// 20px is not a fresh magic number: it is the clearance the band's own action zone already mandates
// between two mis-tappable controls (Undo's bottom edge to Save's top edge, V4-HARVFEEDBACK-001
// spec §2, EventNew.jsx). Reusing it keeps one number for "how far apart do two things a thumb can
// confuse have to be" instead of minting a second. It is also >= the 8dp adjacent-target spacing
// Material asks for, and it is 20x the clearance this bug was filed about.
export const SAVE_BAND_MIN_CLEARANCE_PX = 20

// ── V4-WEIGHFRAME-001 R1 — the same rule on the FRAME arm, which has no band ───────────────────
// The frame's Save lives in `weigh-frame-track3`, a real grid track, so nothing can slide under
// anything and the clearance rule above has no band to resolve against. The frame's first gate
// therefore asserted only "the pad is not BENEATH the ledger" — a different question from the one
// this file exists to answer, and it passed at the number below.
//
// MEASURED, real engine, tests/harness at a true 390x500 (iframe, self-reported 390x500/scrollW 390),
// WEIGH_IN_FRAME_ENABLED true, weigh-in session, weight field focused:
//   weight-pad bottom row y351-399  ·  track 3 top y399 (1px border)  ·  Save y400-448
//   -> 1px between ⌫ and an irreversible commit, with three bottom-row keys inside Save's x-range
//      (0 x199-252, . x260-313, ⌫ x321-374 against Save x224-374 at the default hand).
// Every key hit-tests to itself, so this is not occlusion — it is the mis-tap that COMMITS, and it
// is recovered only by Undo-then-redo. 1px is the same accident BUG-WEIGHPADSAVEBAND-001 was filed
// about at a different value, on a surface whose whole point was to end that class.
//
// SAVE_BAND_MIN_CLEARANCE_PX is REUSED rather than a second number minted. Its own note says why:
// one answer to "how far apart do two things a thumb can confuse have to be". The two arms ship
// together, so a frame-only floor would be a second policy for one hazard.
//
// WHERE THE PIXELS COME FROM, because at 390x500 the frame had none spare (track 2 measured
// 347/347, `overflowing: false`). Track 2 is `minmax(0,1fr) auto`: the harvest row is `auto` and the
// disclosure row is the 1fr SPONGE, so freeing height in track 1 or track 3 does nothing — the
// sponge absorbs it and the pad does not move. Only two things move the pad up relative to Save:
// content removed from the harvest row, and height removed from Save itself.
//   8px  the quantity pad's own marginBottom, cancelled at its wrapper the way the weight pad's
//        already was — the two pads now abut the labels below them
//   2px  the weight label's in-frame marginBottom
//   5px  the sponge's remainder (7px at this viewport, showing 0px of content — the disclosure row
//        was already scrolled to a sliver, 245px of content in a 7px window)
//   4px  Save, 48 -> FRAME_SAVE_HEIGHT_PX, leaving a dead strip at the TOP of track 3
//   1px  track 3's border-top, which was always there
// = 20. This is the whole of what exists; there is no sixth source that does not cost a control.
export const FRAME_SAVE_HEIGHT_PX = 44
export const FRAME_LEDGER_BORDER_PX = 1

// Space to leave below the weight pad so that pad-bottom -> Save-top is `minClearance`. Derived,
// never spelled: the ledger height and Save's height are what make the strip above Save dead, and a
// hardcoded gap would silently stop meaning 20px the moment either changed.
export function framePadGapPx(ledgerPx, minClearance = SAVE_BAND_MIN_CLEARANCE_PX) {
  return minClearance - (ledgerPx + FRAME_LEDGER_BORDER_PX - FRAME_SAVE_HEIGHT_PX)
}

// The inverse, for the guards: what a given geometry actually yields. Save is bottom-aligned in
// track 3, so everything between the pad and Save's top edge is track 3's own container — painted,
// but with no handler, which is what makes a low ⌫ press land on nothing instead of committing.
export function frameSaveClearancePx(ledgerPx, padGapPx, saveHeightPx = FRAME_SAVE_HEIGHT_PX) {
  return ledgerPx + FRAME_LEDGER_BORDER_PX - saveHeightPx + padGapPx
}

// Signed gap between a control's bottom edge and the band's top edge. Negative = the band's box
// covers the control by that many px. Both arguments are viewport-relative DOMRects.
export function saveBandClearancePx(controlRect, bandRect) {
  if (!controlRect || !bandRect) return null
  return bandRect.top - controlRect.bottom
}

// How far the scroll container must move DOWN (content up) for `controlRect` to clear the band by
// `minClearance`. 0 when it already does — this never scrolls to "tidy up" a control that is fine,
// so it is a no-op on every surface and viewport where the collision does not exist.
// Ceil, not round: a fractional shortfall is still a shortfall.
export function padClearanceScrollDelta(controlRect, bandRect, minClearance = SAVE_BAND_MIN_CLEARANCE_PX) {
  const clearance = saveBandClearancePx(controlRect, bandRect)
  if (clearance == null) return 0
  return Math.max(0, Math.ceil(minClearance - clearance))
}

// Nearest scrolling ancestor. Two surfaces, two answers: full page -> the document, overlay -> the
// Sheet's own scrollport. Resolved by walking rather than branching on `inOverlay` so the helper
// stays correct if the panel is ever mounted in a third container.
function scrollParentOf(el) {
  const doc = el.ownerDocument
  const view = doc.defaultView
  for (let n = el.parentElement; n; n = n.parentElement) {
    const overflowY = view ? view.getComputedStyle(n).overflowY : ''
    if ((overflowY === 'auto' || overflowY === 'scroll') && n.scrollHeight > n.clientHeight) return n
  }
  return doc.scrollingElement || doc.documentElement
}

// Scroll the minimum amount that puts `[aria-label="Harvest weight keypad"]` SAVE_BAND_MIN_CLEARANCE_PX
// clear of the band, and return the px actually applied.
//
// Called at the two moments the user commits to the weigh-in — focusing the weight field, and
// pressing any weight-pad key — NOT on quantity focus. That restraint is deliberate: quantity focus
// already runs `anchorSectionToTop` (V4-HARVSCROLLANCHOR-001 / BD-016), and adding a second scroll
// there would both fight the smooth anchor mid-animation and, once the session ledger has grown the
// band, push the field being typed into off the top of the viewport to make room for a pad the user
// has not reached yet. Clearing the pad the moment it is wanted costs nothing and breaks nothing.
//
// Assignment to `.scrollTop` rather than `scrollTo`/`scrollBy`: it is instant (no animation to race
// against a second call), it works identically on an element scrollport and on
// `document.scrollingElement`, and jsdom implements it as a plain settable property instead of the
// "Not implemented" console noise the scroll methods produce.
export function clearWeightPadOfSaveBand(doc = typeof document === 'undefined' ? null : document, {
  padSelector = '[aria-label="Harvest weight keypad"]',
  bandSelector = '[data-testid="save-sticky"]',
  minClearance = SAVE_BAND_MIN_CLEARANCE_PX,
} = {}) {
  if (!doc) return 0
  const pad = doc.querySelector(padSelector)
  const band = doc.querySelector(bandSelector)
  if (!pad || !band) return 0
  // A hidden band occludes nothing — the picker-open suppression (V4-PICKERUX-001) sets
  // `visibility: hidden`, which removes the whole subtree from hit testing. Scrolling for a band
  // that cannot take a tap would be a jump with no cause.
  const view = doc.defaultView
  if (view && view.getComputedStyle(band).visibility === 'hidden') return 0
  const delta = padClearanceScrollDelta(pad.getBoundingClientRect(), band.getBoundingClientRect(), minClearance)
  if (delta <= 0) return 0
  const scroller = scrollParentOf(pad)
  if (!scroller) return 0
  const before = scroller.scrollTop
  const room = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
  scroller.scrollTop = Math.min(before + delta, room)
  return scroller.scrollTop - before
}
