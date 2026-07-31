// src/components/forms/Toast.jsx
// Lane D / Phase A — OPERATIONAL confirmation toast (e.g. "Item added", "Saved").
//
// ⚠ Reward-UX boundary (gardening.md Reward UX Rule / guideline V102): this Toast
// is for confirmations of a task the USER explicitly started (a save/delete) —
// the rule's own carve-out ("payment confirmations") class. It is NEVER for
// rewards, celebrations, critters, achievements, milestones, streaks, or nudges —
// those deliver as ambient in-context flourish, never a toast. Even here the
// delivery is ambient: non-modal, non-interactive, polite live region, auto-
// resolving via `duration`. It does not steal focus and cannot be tapped to claim.
import React from 'react'
import { P } from '../../lib/constants.js'

// Nav-aware bottom offset, matching UpdateBanner.jsx. --bottom-nav-height is defined in main.jsx's
// global style block (56px); the 0px fallback keeps this correct on surfaces that render no nav.
// Exported so the stacking offset in ToastContext builds on the same base rather than re-hardcoding.
export const TOAST_BOTTOM = 'calc(var(--bottom-nav-height, 0px) + env(safe-area-inset-bottom) + 12px)'
export const toastStackBottom = (i) =>
  `calc(var(--bottom-nav-height, 0px) + env(safe-area-inset-bottom) + ${12 + i * 56}px)`

export default function Toast({ message, show = true, duration = 2500, onDone, tone = 'success', style }) {
  React.useEffect(() => {
    if (!show || !duration) return
    const id = setTimeout(() => { if (onDone) onDone() }, duration)
    return () => clearTimeout(id)
  }, [show, duration, onDone])
  if (!show || !message) return null
  const bg = tone === 'error' ? P.terra : P.greenLight
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        // 2026-07-31 — was `bottom: 24` at zIndex 1000, which renders a toast ON TOP of the 56px
        // fixed BottomNav (zIndex 100) rather than above it. UpdateBanner.jsx already ships the
        // correct expression; this adopts it so the two bottom-anchored operational surfaces share
        // one offset convention instead of two incompatible ones.
        position: 'fixed', bottom: TOAST_BOTTOM, left: '50%', transform: 'translateX(-50%)',
        backgroundColor: bg, color: P.white, padding: '12px 24px', borderRadius: 8,
        fontSize: '0.9rem', fontWeight: 600, boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
        // whiteSpace was 'nowrap': any message longer than the viewport overflowed horizontally
        // rather than wrapping, on a 360px-wide Android target. Wrap and cap instead.
        zIndex: 1000, maxWidth: 'calc(100vw - 32px)', pointerEvents: 'none', ...style,
      }}
    >
      {message}
    </div>
  )
}
