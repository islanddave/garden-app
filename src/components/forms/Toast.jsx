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
        position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
        backgroundColor: bg, color: P.white, padding: '12px 24px', borderRadius: 8,
        fontSize: '0.9rem', fontWeight: 600, boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
        zIndex: 1000, whiteSpace: 'nowrap', pointerEvents: 'none', ...style,
      }}
    >
      {message}
    </div>
  )
}
