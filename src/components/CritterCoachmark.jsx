// Phase B coachmark — MVP-Critter.
// Canonical spec: revision §3.7 (anchor to garden-view-enter, 1500ms min-visible-time),
//                 §3.9 step 3 (renders on SECOND garden-view visit after first earned critter,
//                 NOT first — first visit is reserved for unmediated Stage 2 delight),
//                 V101 2026-06-01: baseline residents RETIRED — all species count toward "first earned".
// V100 binding: §5 Stage 3 — explains the dot, NEVER a modal, NEVER interrupt.
//
// Render gating (parent computes + passes `eligible` prop):
//   eligible = (
//     coachmark_seen_at IS NULL         // server-side single source of truth
//     AND an earned critter exists   // V101: any species 1-8 (no baselines)
//     AND prevGardenViewAt > earnedAt   // SECOND visit (user has been here once since earning)
//   )
//
// Dismissal contract:
//   • Coachmark renders inline at top of Garden (NOT overlay, NOT popover).
//   • Visible-time timer starts on mount.
//   • On unmount (route change out of Garden): if visible ≥ 1500ms, fire onDismiss() →
//     parent posts Route 9 /api/notifications/coachmark-dismissed.
//   • If user leaves <1500ms (ADHD accidental route-change), do NOT write → re-renders next visit.
//
// Props:
//   eligible       — boolean; parent computes per spec
//   copy           — string; defaults to DEFAULT_COACHMARK_COPY
//   onDismiss      — () => void; called on unmount IFF visible ≥ COACHMARK_MIN_VISIBLE_MS
//   minVisibleMs   — test seam; default COACHMARK_MIN_VISIBLE_MS
//
// Returns null when not eligible. NEVER renders a button. NEVER calls Notification.requestPermission().

import React, { useEffect, useRef } from 'react'
import { P } from '../lib/constants.js'
import { DEFAULT_COACHMARK_COPY, COACHMARK_MIN_VISIBLE_MS } from '../lib/critterCoachmarkCopy.js'

export default function CritterCoachmark({
  eligible,
  copy = DEFAULT_COACHMARK_COPY,
  onDismiss = null,
  minVisibleMs = COACHMARK_MIN_VISIBLE_MS,
}) {
  const mountedAtRef = useRef(null)
  const dismissedRef = useRef(false)

  // Track mount time + fire onDismiss on unmount if visible long enough.
  useEffect(() => {
    if (!eligible) return undefined
    mountedAtRef.current = Date.now()
    return () => {
      if (dismissedRef.current) return
      const elapsed = Date.now() - (mountedAtRef.current ?? Date.now())
      if (elapsed >= minVisibleMs && typeof onDismiss === 'function') {
        dismissedRef.current = true
        onDismiss()
      }
    }
  }, [eligible, onDismiss, minVisibleMs])

  if (!eligible) return null

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="critter-coachmark"
      style={{
        backgroundColor: P.greenPale,
        border: `1px solid ${P.greenLight}`,
        borderLeft: `3px solid ${P.green}`,
        borderRadius: 8,
        padding: '10px 14px',
        marginBottom: 16,
        fontSize: '0.85rem',
        color: P.dark,
        lineHeight: 1.4,
      }}
    >
      {copy}
    </div>
  )
}
