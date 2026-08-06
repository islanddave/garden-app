// LoveMehPopover — D-INV-1 Option A in-context species prefs.
// Canonical spec: revision §3.29 (long-press → ❤️ Love / ☓ Meh / Cancel → PATCH species-prefs).
// V100 binding: §5 Stage 2 ambient; this is an in-context popover, NOT a modal.
//
// HARD RULES:
//   - NOT a modal / NOT a coachmark / NOT a toast / NOT a tap-to-claim
//   - Discoverability INTENTIONALLY undiscovered for week 1 (no onboarding hint)
//   - 300ms heart/dot pulse confirmation per §3.29, NO toast
//   - Click outside / Escape / pick = dismiss
//
// Props:
//   open      — boolean
//   anchorRef — ref to the long-pressed sprite (for positioning) — optional
//   species   — species object from BY_ID
//   onPick    — (action: 'love'|'meh'|'reset'|'cancel') => void
//   onClose   — () => void
//
// Caller wires onPick → patchSpeciesPrefs (love → weight 2.0, meh → weight 0.5, reset → 1.0).

import React, { useEffect, useRef, useState } from 'react'
import { useDismissable } from '../context/DismissRegistry.jsx'
import { LAYER } from '../lib/dismissLayers.js'

const PULSE_MS = 300

export default function LoveMehPopover({ open, anchorRef = null, species = null, onPick = null, onClose = null }) {
  const ref = useRef(null)
  const [pulse, setPulse] = useState(null) // 'love' | 'meh' | null

  // V4-BACKNAV-001 Slice 2 — shared registry owns Escape when present.
  const { registered, isTopmost } = useDismissable({ open, onDismiss: onClose, layer: LAYER.DIALOG })

  // Escape key dismiss.
  useEffect(() => {
    if (!open || registered) return undefined
    function onKey(e) {
      if (e.key === 'Escape') {
        onClose?.()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose, registered])

  // Click-outside dismiss.
  useEffect(() => {
    if (!open) return undefined
    function onDocPointer(e) {
      if (ref.current && !ref.current.contains(e.target)) {
        // Also exclude anchor element (so re-press doesn't immediately dismiss).
        if (anchorRef?.current && anchorRef.current.contains(e.target)) return
        onClose?.()
      }
    }
    // Use mousedown/pointerdown so it fires before nav-link click bubbles up.
    document.addEventListener('pointerdown', onDocPointer)
    return () => document.removeEventListener('pointerdown', onDocPointer)
  }, [open, anchorRef, onClose])

  if (!open || !species) return null

  function handlePick(action) {
    if (action === 'love' || action === 'meh') {
      setPulse(action)
      setTimeout(() => {
        setPulse(null)
        onPick?.(action)
        onClose?.()
      }, PULSE_MS)
    } else {
      onPick?.(action)
      onClose?.()
    }
  }

  // Anchor positioning: above the sprite, centered. Falls back to fixed-center when no anchor.
  let posStyle = { position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }
  if (anchorRef?.current) {
    const rect = anchorRef.current.getBoundingClientRect()
    posStyle = {
      position: 'fixed',
      top: Math.max(8, rect.top - 60), // 60px above anchor
      left: Math.min(window.innerWidth - 200, Math.max(8, rect.left + rect.width / 2 - 100)),
      width: 200,
    }
  }

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={`${species.aria_announce_name} preferences`}
      data-testid="love-meh-popover"
      data-species-id={species.species_id}
      style={{
        ...posStyle,
        backgroundColor: '#fbf8f0',
        border: '1px solid #d6cdb2',
        borderRadius: 12,
        padding: '8px 6px',
        boxShadow: '0 4px 14px rgba(0,0,0,0.12)',
        zIndex: 200,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-around',
        gap: 4,
      }}
    >
      <button
        type="button"
        onClick={() => handlePick('love')}
        aria-label={`Love ${species.aria_announce_name}`}
        data-testid="prefs-love"
        style={{
          background: 'none',
          border: 'none',
          fontSize: '1.4rem',
          cursor: 'pointer',
          padding: '8px 10px',
          minHeight: 44,
          minWidth: 44,
          transform: pulse === 'love' ? 'scale(1.3)' : 'scale(1)',
          transition: `transform ${PULSE_MS}ms ease-out`,
        }}
      >
        ❤️
      </button>
      <button
        type="button"
        onClick={() => handlePick('meh')}
        aria-label={`Meh ${species.aria_announce_name}`}
        data-testid="prefs-meh"
        style={{
          background: 'none',
          border: 'none',
          fontSize: '1.4rem',
          cursor: 'pointer',
          padding: '8px 10px',
          minHeight: 44,
          minWidth: 44,
          transform: pulse === 'meh' ? 'scale(1.3)' : 'scale(1)',
          transition: `transform ${PULSE_MS}ms ease-out`,
        }}
      >
        ☓
      </button>
      <button
        type="button"
        onClick={() => handlePick('cancel')}
        aria-label="Cancel"
        data-testid="prefs-cancel"
        style={{
          background: 'none',
          border: 'none',
          fontSize: '0.8rem',
          color: '#666',
          cursor: 'pointer',
          padding: '8px 8px',
          minHeight: 44,
        }}
      >
        Cancel
      </button>
    </div>
  )
}
