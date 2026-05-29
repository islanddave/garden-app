// Stage 2: in-garden sprite — MVP-Critter.
// Canonical spec: revision §1.8 (Session 3 scope), §3.11 (freshness desaturation),
//                 §3.12 (300ms opacity fade clear), §3.13 (quiet-hours skip landing),
//                 §3.26 (IntersectionObserver viewport gate),
//                 §3.29 (D-INV-1 long-press handler).
// V100 binding: §5 Stage 2 — in-tile reveal, ambient, no overlay/modal/tap-to-claim.
//
// Behavior:
//   - IO-gated reveal: defer landing animation until tile scrolls into viewport.
//   - 3-4s landing animation on first reveal (default 3500ms). Skips in quiet hours.
//   - After landing: settle to static.
//   - >24h since earned_at: render with filter: saturate(0.7) per §3.11 (passive time orientation).
//   - 300ms opacity fade on clear (when critter.viewed_at fires from elsewhere) per §3.12.
//   - Long-press ≥500ms (configurable) fires onLongPress(critter) — caller opens LoveMehPopover.
//
// Props:
//   critter             — { id, species_id, earned_at, viewed_at, dot_visible_after, ... }
//   inQuietHours        — boolean (caller derives from prefs OR from critter.dot_visible_after > now)
//   prefersReducedMotion — optional override (test seam)
//   onLongPress         — (critter) => void; opens LoveMehPopover anchored to sprite
//   onIntersect         — (critter) => void; fires once when sprite enters viewport (for actually_seen marking)
//   spriteSize          — px (default 32)
//
// Renders null when critter is null or species not in pool.

import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react'
import { BY_ID as SPECIES_BY_ID } from '../lib/critterSpecies.js'
import { useIntersectionObserver } from '../hooks/useIntersectionObserver.js'

const LANDING_MS = 3500
const FRESHNESS_THRESHOLD_MS = 24 * 60 * 60 * 1000 // 24h
const LONG_PRESS_MS = 500
const FADE_MS = 300

function detectReducedMotion() {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

export default function CritterSprite({
  critter,
  inQuietHours = false,
  prefersReducedMotion = null,
  onLongPress = null,
  onIntersect = null,
  spriteSize = 32,
}) {
  const reducedMotion = useMemo(
    () => (prefersReducedMotion ?? detectReducedMotion()),
    [prefersReducedMotion]
  )
  const skipLanding = inQuietHours || reducedMotion
  const [landingComplete, setLandingComplete] = useState(skipLanding)
  const [cleared, setCleared] = useState(false)
  const intersectedRef = useRef(false)
  const longPressTimer = useRef(null)
  const longPressFired = useRef(false)

  const { ref, isIntersecting } = useIntersectionObserver({ threshold: 0.1 })

  // Fire onIntersect ONCE the first time sprite is in viewport (for actually_seen marking).
  useEffect(() => {
    if (isIntersecting && !intersectedRef.current && critter) {
      intersectedRef.current = true
      if (typeof onIntersect === 'function') onIntersect(critter)
    }
  }, [isIntersecting, critter, onIntersect])

  // Landing animation timer. Only starts AFTER intersected (defer per §3.26).
  useEffect(() => {
    if (skipLanding) { setLandingComplete(true); return undefined }
    if (!isIntersecting || landingComplete) return undefined
    const t = setTimeout(() => setLandingComplete(true), LANDING_MS)
    return () => clearTimeout(t)
  }, [isIntersecting, skipLanding, landingComplete])

  // Clear fade when critter.viewed_at flips from null to a timestamp.
  useEffect(() => {
    if (critter?.viewed_at && !cleared) {
      const t = setTimeout(() => setCleared(true), FADE_MS)
      return () => clearTimeout(t)
    }
    return undefined
  }, [critter?.viewed_at, cleared])

  // Long-press handlers (works for touch + mouse).
  const startPress = useCallback((e) => {
    longPressFired.current = false
    longPressTimer.current = setTimeout(() => {
      longPressFired.current = true
      if (typeof onLongPress === 'function') onLongPress(critter, e)
    }, LONG_PRESS_MS)
  }, [critter, onLongPress])

  const endPress = useCallback((e) => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
    // If long-press fired, suppress click (caller's choice via stopPropagation if needed).
    if (longPressFired.current) {
      e.preventDefault?.()
      e.stopPropagation?.()
    }
  }, [])

  const cancelPress = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }, [])

  useEffect(() => () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current)
  }, [])

  if (!critter || cleared) return null

  const species = SPECIES_BY_ID[critter.species_id]
  if (!species) return null

  // Freshness: passive time orientation per §3.11.
  const earnedAtMs = critter.earned_at ? Date.parse(critter.earned_at) : Date.now()
  const isStale = Number.isFinite(earnedAtMs) && (Date.now() - earnedAtMs) > FRESHNESS_THRESHOLD_MS

  // Landing animation = brief scale-up + fade-in. Reduced-motion / quiet-hours = static immediate.
  const animStyle = skipLanding
    ? { opacity: 1, transform: 'scale(1)' }
    : landingComplete
      ? { opacity: 1, transform: 'scale(1)', transition: 'none' }
      : { opacity: 0, transform: 'scale(0.6)', transition: 'opacity 600ms ease-out, transform 600ms cubic-bezier(0.34, 1.56, 0.64, 1)' }

  // After mount, kick the transition by setting target style (CSS handles the rest).
  // We trigger by toggling a dataset attribute the browser repaints on.
  const stylePost = (isIntersecting && !landingComplete && !skipLanding)
    ? { opacity: 1, transform: 'scale(1)', transition: 'opacity 600ms ease-out, transform 600ms cubic-bezier(0.34, 1.56, 0.64, 1)' }
    : animStyle

  const fadeStyle = critter.viewed_at
    ? { opacity: 0, transition: `opacity ${FADE_MS}ms ease-out` }
    : {}

  const spriteSrc = `/critters/${species.sprite_filename}`

  return (
    <div
      ref={ref}
      role="img"
      aria-label={species.aria_announce_name}
      data-testid="critter-sprite"
      data-species-id={species.species_id}
      data-critter-id={critter.id ?? ''}
      data-landed={landingComplete ? 'true' : 'false'}
      data-intersecting={isIntersecting ? 'true' : 'false'}
      onPointerDown={startPress}
      onPointerUp={endPress}
      onPointerLeave={cancelPress}
      onPointerCancel={cancelPress}
      onContextMenu={(e) => { /* prevent native long-press menu on iOS Safari */ e.preventDefault?.() }}
      style={{
        width: spriteSize,
        height: spriteSize,
        display: 'inline-block',
        filter: isStale ? 'saturate(0.7)' : 'none',
        cursor: 'default',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        WebkitTouchCallout: 'none',
        touchAction: 'manipulation',
        ...stylePost,
        ...fadeStyle,
      }}
    >
      <img
        src={spriteSrc}
        alt=""
        draggable={false}
        style={{ width: '100%', height: '100%', display: 'block', pointerEvents: 'none' }}
      />
    </div>
  )
}
