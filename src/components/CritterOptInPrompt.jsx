// Phase B opt-in prompt — MVP-Critter.
// Canonical spec: revision §3.8 (informational ONLY — NO "Sure" nav button — preserves
//                 project CLAUDE.md notification-permission discipline rule),
//                 §3.9 step 4 (renders after 3+ earned critters AND coachmark dismissed).
// V100 binding: §6 system-notification opt-in is user-initiated nav only;
//               project CLAUDE.md: "Notification permission discipline:
//               NEVER auto-call Notification.requestPermission() from a reward flow."
//
// SUPPRESSION-FLAG FIX (§3.8): opt_in_prompt_seen_at is ONLY set after prompt ACTUALLY rendered.
// Parent computes `eligible` strictly:
//   eligible = (
//     SYSTEM_NOTIFICATIONS_ENABLED === true     // §6 feature flag (currently FALSE in V2.x)
//     AND earned_critter_count >= OPT_IN_CRITTER_THRESHOLD  // V101: all species count (no baselines)
//     AND coachmark_seen_at IS NOT NULL
//     AND opt_in_prompt_seen_at IS NULL
//   )
//
// Dismissal contract:
//   • Informational text only — NO button, NO link to /settings, NO "Sure" navigation.
//   • Renders inline at top of Garden (sibling to coachmark).
//   • On unmount (route change out): fire onDismiss() → parent posts Route 10 only
//     because the prompt actually rendered (suppression-flag fix).
//   • NEVER calls Notification.requestPermission() — that's user-initiated from Settings only.
//
// Props:
//   eligible       — boolean; parent computes per spec including SYSTEM_NOTIFICATIONS_ENABLED gate
//   copy           — string; defaults to DEFAULT_OPT_IN_COPY
//   onDismiss      — () => void; called on unmount IFF prompt actually rendered (eligible was true)
//
// Returns null when not eligible.

import React, { useEffect, useRef } from 'react'
import { P } from '../lib/constants.js'
import { DEFAULT_OPT_IN_COPY } from '../lib/critterCoachmarkCopy.js'

export default function CritterOptInPrompt({
  eligible,
  copy = DEFAULT_OPT_IN_COPY,
  onDismiss = null,
}) {
  const renderedRef = useRef(false)

  useEffect(() => {
    if (!eligible) return undefined
    renderedRef.current = true
    return () => {
      // Suppression-flag fix (§3.8): fire ONLY if the prompt actually rendered.
      if (renderedRef.current && typeof onDismiss === 'function') {
        onDismiss()
      }
    }
  }, [eligible, onDismiss])

  if (!eligible) return null

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="critter-opt-in-prompt"
      style={{
        backgroundColor: P.cream,
        border: `1px solid ${P.border}`,
        borderLeft: `3px solid ${P.gold ?? '#b5a04a'}`,
        borderRadius: 8,
        padding: '10px 14px',
        marginBottom: 16,
        fontSize: '0.85rem',
        color: P.mid,
        lineHeight: 1.4,
      }}
    >
      {copy}
    </div>
  )
}
