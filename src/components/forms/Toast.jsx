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

// Nav-aware bottom offset, matching UpdateBanner.jsx. --bottom-nav-height is OWNED BY BottomNav,
// which sets it to its real height on mount and back to 0px on unmount — so this expression is
// correct on both signed-in surfaces (nav present) and signed-out ones (no nav, so no reservation).
// The 0px fallback covers the pre-mount frame and any surface that never renders a nav at all.
// (2026-07-31: this replaced a bare `bottom: 24`, which drew the toast ON TOP of the 56px fixed
// BottomNav rather than above it.) Exported so ToastContext's stack CONTAINER anchors on the same
// base rather than re-hardcoding the expression.
export const TOAST_BOTTOM = 'calc(var(--bottom-nav-height, 0px) + env(safe-area-inset-bottom) + 12px)'

export default function Toast({ message, show = true, duration = 2500, onDone, tone = 'success', inStack = false, style }) {
  // onDone lives in a ref so the dismiss timer depends only on (show, duration). It used to be an
  // effect dep, and ToastContext hands down a fresh closure on every render — so pushing a second
  // toast restarted the FIRST one's timer, and a run of quick taps left the whole stack standing
  // instead of draining. That was half of the pile-up this file's stack policy now prevents.
  const doneRef = React.useRef(onDone)
  doneRef.current = onDone
  React.useEffect(() => {
    if (!show || !duration) return
    const id = setTimeout(() => { if (doneRef.current) doneRef.current() }, duration)
    return () => clearTimeout(id)
  }, [show, duration])
  if (!show || !message) return null
  const bg = tone === 'error' ? P.terra : P.greenLight
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        // Two modes. Standalone (default) anchors itself above the nav. `inStack` means
        // ToastContext's flex-column container owns position AND spacing, so the toast must be a
        // plain flow child — see the STACK POLICY note in ToastContext.jsx for why per-toast fixed
        // positioning at a fixed per-index stride was removed rather than re-tuned.
        ...(inStack
          ? { position: 'static' }
          : { position: 'fixed', bottom: TOAST_BOTTOM, left: '50%', transform: 'translateX(-50%)' }),
        backgroundColor: bg, color: P.white, padding: '12px 24px', borderRadius: 8,
        fontSize: '0.9rem', fontWeight: 600, boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
        // whiteSpace was 'nowrap': any message longer than the viewport overflowed horizontally
        // rather than wrapping, on a 360px-wide Android target. Wrap and cap instead.
        zIndex: 1000, maxWidth: inStack ? '100%' : 'calc(100vw - 32px)', pointerEvents: 'none', ...style,
      }}
    >
      {message}
    </div>
  )
}
