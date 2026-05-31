// CritterArrival — global Stage 1 flash (Phase B++ reward redesign 2026-05-30).
//
// Spec: Dave directive 2026-05-30 — the reward IS the animation, not a text announcement.
// Fires on whatever screen the user is on at award time (NOT gated by Garden navigation).
//
// Animation (3s total):
//   0-800ms  : bird flies in from bottom-right (FAB origin), arcs up-left to viewport center
//   800-2500ms: holds at screen center (~40% from top) with soft golden glow
//   2500-3000: fades out
//
// Pointer events: none — taps pass through to underlying UI (Dave's call: stray tap shouldn't
// kill the reward; ignore taps during flash).
//
// Caller mounts at App.jsx level (global) and feeds it a critter prop. Renders null when
// critter is null OR animation complete. Idempotent on prop change — new critter restarts.

import React, { useEffect, useState } from 'react'
import { BY_ID as SPECIES_BY_ID } from '../lib/critterSpecies.js'

const FLASH_TOTAL_MS = 3000

export default function CritterArrival({ critter, onDone = null }) {
  const [active, setActive] = useState(false)
  const [critterId, setCritterId] = useState(null)

  useEffect(() => {
    if (!critter) return
    setActive(true)
    setCritterId(critter.id)
    const t = setTimeout(() => {
      setActive(false)
      if (typeof onDone === 'function') onDone()
    }, FLASH_TOTAL_MS)
    return () => clearTimeout(t)
  }, [critter?.id])

  if (!active || !critter) return null
  const species = SPECIES_BY_ID[critter.species_id]
  if (!species) return null
  const spriteSrc = `/critters/${species.sprite_filename}`

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={species.aria_announce_name + ' arriving in your garden'}
      data-testid="critter-arrival"
      data-critter-id={critterId ?? ''}
      style={{
        position: 'fixed',
        top: 0, left: 0,
        width: '100vw', height: '100vh',
        pointerEvents: 'none',
        zIndex: 1000,
      }}
    >
      <style>{`
        @keyframes critter-arrival-anim {
          0% {
            left: 88vw;
            top: 88vh;
            transform: translate(-50%, -50%) scale(0.55) rotate(-12deg);
            opacity: 0;
            filter: drop-shadow(0 0 0 rgba(255, 220, 100, 0));
          }
          22% {
            opacity: 1;
          }
          30% {
            left: 50vw;
            top: 38vh;
            transform: translate(-50%, -50%) scale(1.18) rotate(2deg);
            opacity: 1;
            filter: drop-shadow(0 0 18px rgba(255, 220, 100, 0.7));
          }
          40% {
            left: 50vw;
            top: 38vh;
            transform: translate(-50%, -50%) scale(1) rotate(0deg);
            filter: drop-shadow(0 0 16px rgba(255, 220, 100, 0.6));
          }
          80% {
            left: 50vw;
            top: 38vh;
            transform: translate(-50%, -50%) scale(1) rotate(0deg);
            opacity: 1;
            filter: drop-shadow(0 0 14px rgba(255, 220, 100, 0.5));
          }
          100% {
            left: 50vw;
            top: 32vh;
            transform: translate(-50%, -50%) scale(1.08) rotate(0deg);
            opacity: 0;
            filter: drop-shadow(0 0 0 rgba(255, 220, 100, 0));
          }
        }
        @keyframes critter-arrival-sparkle {
          0%, 30% { opacity: 0; transform: scale(0.5); }
          50% { opacity: 0.8; transform: scale(1.4); }
          85% { opacity: 0.4; transform: scale(1.6); }
          100% { opacity: 0; transform: scale(1.8); }
        }
      `}</style>
      <div
        style={{
          position: 'absolute',
          width: 56, height: 56,
          animation: `critter-arrival-anim ${FLASH_TOTAL_MS}ms cubic-bezier(0.34, 1.34, 0.64, 1) forwards`,
        }}
      >
        <img
          src={spriteSrc}
          alt=""
          draggable={false}
          style={{ width: '100%', height: '100%', display: 'block' }}
        />
        {/* Soft sparkle ring during hold phase */}
        <div
          style={{
            position: 'absolute',
            inset: -8,
            borderRadius: '50%',
            background: 'radial-gradient(circle, rgba(255,220,100,0.35) 0%, rgba(255,220,100,0) 70%)',
            animation: `critter-arrival-sparkle ${FLASH_TOTAL_MS}ms ease-in-out forwards`,
            pointerEvents: 'none',
          }}
        />
      </div>
    </div>
  )
}
