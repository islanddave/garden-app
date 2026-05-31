// Stage 1: inline announcement React component — MVP-Critter.
// Canonical spec: revision §1.8 (Session 2 scope), §3.18 (aria override on emoji).
// V100 binding: §5 Stage 1 (≤400ms reveal, aria-live polite, no overlay, no dismissal,
// ambient over interrupt). Reduced-motion = 600ms color flash fallback.
//
// Props:
//   critter — server response from POST /api/critters: { species_id, plant_id, ... }
//   mode    — 'arrival' (default) | 'present_tense' | 'burst'
//   plantName — optional noun for present-tense template (e.g., "tomatoes")
//   onFade  — optional callback when the announcement self-fades (default 6s)
//
// HARD RULES (V100 + project CLAUDE.md Reward UX Rule):
//   - aria-live="polite" (never "assertive")
//   - aria-label strips the ✨ emoji (revision §3.18)
//   - NO modal / NO overlay / NO toast / NO tap-to-claim / NO haptic / NO sound
//   - NO dismiss button — auto-fades after ~6s
//   - Reduced-motion: 600ms color flash instead of fade animation
//
// Renders nothing when critter is null/undefined.

import React, { useEffect, useState, useMemo } from 'react'
import { BY_ID as SPECIES_BY_ID } from '../lib/critterSpecies.js'
import { resolveCopy } from '../lib/critterCopyVariants.js'

const FADE_AFTER_MS = 6000

// Detect prefers-reduced-motion at render time. Safe in tests (returns false
// when matchMedia unavailable).
function prefersReducedMotion() {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

export default function CritterAnnouncement({ critter, mode = 'arrival', plantName = null, onFade = null }) {
  const [visible, setVisible] = useState(true)
  const reducedMotion = useMemo(() => prefersReducedMotion(), [])

  // Auto-fade timer.
  useEffect(() => {
    if (!critter) return undefined
    setVisible(true)
    const t = setTimeout(() => {
      setVisible(false)
      if (typeof onFade === 'function') onFade()
    }, FADE_AFTER_MS)
    return () => clearTimeout(t)
  }, [critter, onFade])

  if (!critter) return null

  const species = SPECIES_BY_ID[critter.species_id]
  // Defensive: unknown species_id (smoke sentinel 255, etc.) → render nothing visible
  // (we don't want "an unknown critter" leaking to users).
  if (!species) return null

  const variantIndex = critter.meta?.copy_variant_id ?? 0
  const { visible: visibleText, aria: ariaText } = resolveCopy({
    mode,
    variantIndex,
    speciesAnnounceName: species.aria_announce_name,
    plantName,
  })

  // Style: cream-on-sage inline strip, no border, no chrome. Sits inline in the
  // parent layout. Per V100: ambient — no shadow, no z-index escalation.
  // Fade-out via opacity transition; reduced-motion uses solid color flash.
  const animStyle = reducedMotion
    ? {
        backgroundColor: visible ? 'rgba(168, 185, 145, 0.18)' : 'transparent', // sage flash
        transition: 'background-color 600ms ease-out',
      }
    : {
        opacity: visible ? 1 : 0,
        transition: 'opacity 600ms ease-out',
      }

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-label={ariaText}
      data-testid="critter-announcement"
      data-species-id={species.species_id}
      style={{
        display: 'inline-block',
        padding: '8px 14px',
        margin: '6px 0',
        borderRadius: 12,
        fontSize: '0.92rem',
        lineHeight: 1.35,
        color: '#3a4a32',
        ...animStyle,
      }}
    >
      <span aria-hidden="true">{visibleText}</span>
    </div>
  )
}
