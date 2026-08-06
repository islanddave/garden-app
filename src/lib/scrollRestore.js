// src/lib/scrollRestore.js
// V4-NAVSTATE-002 — the scroll-restore RETRY decision, kept pure.
//
// Same discipline as backNav.js: no DOM, no React, no history. src/lib/** is in vitest
// coverage.include; src/pages/Garden.jsx is NOT, so the decision lives here where it can be
// exhaustively table-tested and only the driving loop stays in the page.
//
// WHY A RETRY EXISTS AT ALL. V4-NAVSTATE-001 restored Garden's scroll with a single
// requestAnimationFrame(() => window.scrollTo(0, y)) and latched a one-shot ref BEFORE the attempt.
// Both halves were wrong on the same navigation:
//
//   1. Every planting grid is windowed at 24 tiles (BUG-PHOTOTHUMB-001, useImageWindow.js). On
//      remount the window collapses back to one page, so a group that was showing 56 tiles comes
//      back showing 24 and the document is a fraction of its former height. Chrome CLAMPS
//      window.scrollTo to the current max scroll and reports no error, so the restore silently
//      lands short — which reads as "it jumped somewhere random", not "it failed".
//   2. The one-shot latched anyway, so the miss was permanent for that mount.
//
// The fix is to keep attempting across frames, because the attempt is itself the cure: a clamped
// scrollTo still lands at the bottom of the short document, which fires a scroll event, which is
// precisely the signal useImageWindow's growth listener keys on (it grows when
// innerHeight + scrollY >= scrollHeight - 800). So each attempt makes the NEXT attempt able to go
// further, and the loop converges on its own.
//
// IT IS SELF-LIMITING, which is why no window cap is needed here. The target offset can never
// exceed the document height that existed when the user left the page, and that height was reached
// by real scrolling. So the restore can only re-grow the window back to roughly where the user
// already had it — it cannot run away toward the ~120 live <img> that froze the renderer in
// BUG-PHOTOTHUMB-001. A blind index SEED has no such ceiling and must be capped separately; that
// belongs with anchor restoration, not here.

// Chrome reports fractional scroll offsets on a zoomed/DPR-scaled viewport, and the last growth
// step can leave the document a hair short. 4px is below one line of text — a miss this small is
// not perceptible and is not worth another frame.
export const RESTORE_TOLERANCE_PX = 4

// ~20 frames is a third of a second at 60fps. Long enough to absorb several window-growth steps
// (each needs a commit + a layout pass), short enough that a target which is genuinely
// unreachable — the content was deleted, the group collapsed, the list is simply shorter now —
// stops trying well before the user notices anything fighting them.
export const RESTORE_MAX_FRAMES = 20

/**
 * Decide what a restore loop should do after an attempt.
 *
 * DONE      — within tolerance; latch the one-shot, we actually landed.
 * EXHAUSTED — out of frames; latch the one-shot, but we did NOT land. Distinct from DONE on
 *             purpose: the caller may want to fall back (e.g. to a group header) rather than
 *             leave the user wherever the clamp dropped them.
 * RETRY     — still short; scroll again next frame. The attempt itself grows the window.
 *
 * @param {{currentY:number, targetY:number, frames:number}} s
 * @returns {'DONE'|'EXHAUSTED'|'RETRY'}
 */
export function restoreStep({ currentY, targetY, frames }) {
  if (!Number.isFinite(currentY) || !Number.isFinite(targetY) || !Number.isFinite(frames)) {
    // A non-finite reading means we cannot tell whether we landed. Treat it as unrecoverable
    // rather than looping on garbage — EXHAUSTED still latches, so we never spin.
    return 'EXHAUSTED'
  }
  if (Math.abs(currentY - targetY) <= RESTORE_TOLERANCE_PX) return 'DONE'
  if (frames >= RESTORE_MAX_FRAMES) return 'EXHAUSTED'
  return 'RETRY'
}

/**
 * Is there anything to restore at all?
 *
 * Kept separate from restoreStep so the "inert" case cannot consume the one-shot latch. The
 * original code set the latch and THEN checked the offset, so on any mount where the offset was 0
 * the restore was permanently disarmed before it had done anything — meaning an offset that
 * arrived even slightly late could never be applied for that mount.
 *
 * @param {number} targetY
 * @returns {boolean}
 */
export function hasRestoreTarget(targetY) {
  return Number.isFinite(targetY) && targetY > 0
}
