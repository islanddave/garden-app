// CritterArrival — global Stage 1 flash with name + first-sighting badge (Phase B++ celebration upgrade 2026-05-30 late).
//
// Spec: Dave directives 2026-05-30 evening:
// - "Make it 2x bigger and allow it to linger 2x longer"
// - "Animation 20% slower so it lasts a touch longer"
// - "Include name of the critter, and whether it is a first find"
// - "Name should be legible and hit dopamine enhancement triggers with style/colors/etc"
// - "This should be a celebratory moment, not just something happening"
//
// Sizing: sprite now 112px (was 56px). Name + badge stacked below.
//
// Timing (5000ms total):
//   0       → 960ms : fly-in arc from bottom-right (FAB origin) to viewport center (38vh), with bounce.
//   960     → 1500  : settle into hold position (small overshoot recovery).
//   1500    → 4400  : HOLD (3400ms) — name fade-in, glow ring, optional first-sighting flourish.
//   4400    → 5000  : fade-out (600ms).
//
// Pointer events: none — taps pass through to underlying UI.
//
// Props:
//   critter — { id, species_id, species_total_count? } — full row from /api/critters/active.
//   onDone  — callback when animation completes.

import React, { useEffect, useState } from 'react'
import { BY_ID as SPECIES_BY_ID } from '../lib/critterSpecies.js'

const FLASH_TOTAL_MS = 5000
const SPRITE_PX = 112

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
  const speciesName = species.name
  const isFirstSighting = Number.isInteger(critter.species_total_count) && critter.species_total_count === 1

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={(isFirstSighting ? 'First sighting! ' : '') + speciesName + ' arriving in your garden'}
      data-testid="critter-arrival"
      data-critter-id={critterId ?? ''}
      data-first-sighting={isFirstSighting ? 'true' : 'false'}
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
          0%   { left: 88vw; top: 88vh; transform: translate(-50%, -50%) scale(0.55) rotate(-12deg); opacity: 0;   filter: drop-shadow(0 0 0 rgba(255,215,100,0)); }
          16%  { opacity: 1; }
          22%  { left: 50vw; top: 38vh; transform: translate(-50%, -50%) scale(1.22) rotate(3deg);  opacity: 1;   filter: drop-shadow(0 0 22px rgba(255,215,100,0.85)); }
          30%  { left: 50vw; top: 38vh; transform: translate(-50%, -50%) scale(1)    rotate(0deg);              filter: drop-shadow(0 0 18px rgba(255,215,100,0.7)); }
          88%  { left: 50vw; top: 38vh; transform: translate(-50%, -50%) scale(1)    rotate(0deg);  opacity: 1;   filter: drop-shadow(0 0 16px rgba(255,215,100,0.6)); }
          100% { left: 50vw; top: 32vh; transform: translate(-50%, -50%) scale(1.08) rotate(0deg);  opacity: 0;   filter: drop-shadow(0 0 0 rgba(255,215,100,0)); }
        }
        @keyframes critter-arrival-sparkle {
          0%, 18%  { opacity: 0; transform: scale(0.5); }
          25%      { opacity: 0.9; transform: scale(1.5); }
          88%      { opacity: 0.45; transform: scale(1.7); }
          100%     { opacity: 0; transform: scale(1.9); }
        }
        @keyframes critter-arrival-name {
          0%, 22%  { opacity: 0; transform: translate(-50%, 6px) scale(0.92); }
          32%      { opacity: 1; transform: translate(-50%, 0) scale(1.04); }
          38%      { opacity: 1; transform: translate(-50%, 0) scale(1); }
          88%      { opacity: 1; transform: translate(-50%, 0) scale(1); }
          100%     { opacity: 0; transform: translate(-50%, -4px) scale(1); }
        }
        @keyframes critter-arrival-firstbadge {
          0%, 30%  { opacity: 0; transform: translate(-50%, 4px) scale(0.85); }
          38%      { opacity: 1; transform: translate(-50%, 0) scale(1.12); }
          46%      { opacity: 1; transform: translate(-50%, 0) scale(1); }
          88%      { opacity: 1; transform: translate(-50%, 0) scale(1); }
          100%     { opacity: 0; transform: translate(-50%, -4px) scale(1); }
        }
        @keyframes critter-arrival-confetti {
          0%, 24% { opacity: 0; transform: translate(-50%, -50%) scale(0); }
          30%     { opacity: 1; transform: translate(-50%, -50%) scale(1); }
          80%     { opacity: 0.6; transform: translate(-50%, -50%) scale(1.6); }
          100%    { opacity: 0; transform: translate(-50%, -50%) scale(2); }
        }
      `}</style>

      {/* Bird sprite with sparkle ring — anchored to viewport via animation keyframes */}
      <div
        style={{
          position: 'absolute',
          width: SPRITE_PX, height: SPRITE_PX,
          animation: `critter-arrival-anim ${FLASH_TOTAL_MS}ms cubic-bezier(0.34, 1.40, 0.64, 1) forwards`,
        }}
      >
        <img src={spriteSrc} alt="" draggable={false}
          style={{ width: '100%', height: '100%', display: 'block' }} />
        {/* Sparkle radial glow */}
        <div style={{
          position: 'absolute', inset: -14, borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(255,215,100,0.45) 0%, rgba(255,215,100,0) 70%)',
          animation: `critter-arrival-sparkle ${FLASH_TOTAL_MS}ms ease-in-out forwards`,
          pointerEvents: 'none',
        }} />
        {/* First-sighting extra confetti — purple/gold burst behind the sprite */}
        {isFirstSighting && (
          <div style={{
            position: 'absolute',
            top: '50%', left: '50%',
            width: 200, height: 200,
            borderRadius: '50%',
            background: 'radial-gradient(circle, rgba(186,104,200,0.55) 0%, rgba(255,215,100,0.4) 40%, rgba(186,104,200,0) 70%)',
            animation: `critter-arrival-confetti ${FLASH_TOTAL_MS}ms ease-out forwards`,
            pointerEvents: 'none',
            zIndex: -1,
          }} />
        )}
      </div>

      {/* Species name — anchored to viewport at fixed position below sprite center.
          Uses its own keyframe (name fades in after sprite lands, stays during hold, fades out). */}
      <div
        data-testid="critter-arrival-name"
        style={{
          position: 'absolute',
          left: '50vw',
          top: 'calc(38vh + 84px)',
          transform: 'translate(-50%, 0)',
          fontSize: '1.6rem',
          fontWeight: 800,
          fontFamily: 'inherit',
          color: '#3a2f0a',
          textShadow: '0 2px 12px rgba(255,215,100,0.9), 0 1px 2px rgba(255,255,255,0.7)',
          background: 'linear-gradient(180deg, rgba(255,235,160,0.95) 0%, rgba(255,210,90,0.92) 100%)',
          padding: '6px 18px',
          borderRadius: 999,
          border: '2px solid rgba(212,168,42,0.9)',
          boxShadow: '0 6px 18px rgba(212,168,42,0.35), inset 0 1px 0 rgba(255,255,255,0.6)',
          whiteSpace: 'nowrap',
          animation: `critter-arrival-name ${FLASH_TOTAL_MS}ms ease-out forwards`,
          pointerEvents: 'none',
        }}
      >
        {speciesName}
      </div>

      {/* First-sighting badge — second pill below the name, only when count==1 */}
      {isFirstSighting && (
        <div
          data-testid="critter-arrival-first-sighting"
          style={{
            position: 'absolute',
            left: '50vw',
            top: 'calc(38vh + 134px)',
            transform: 'translate(-50%, 0)',
            fontSize: '1rem',
            fontWeight: 700,
            color: '#fff',
            background: 'linear-gradient(180deg, #b388dc 0%, #8a5ec0 100%)',
            padding: '5px 14px',
            borderRadius: 999,
            border: '2px solid rgba(255,255,255,0.5)',
            boxShadow: '0 4px 16px rgba(138,94,192,0.5), 0 0 14px rgba(255,215,100,0.4)',
            textShadow: '0 1px 2px rgba(0,0,0,0.25)',
            whiteSpace: 'nowrap',
            animation: `critter-arrival-firstbadge ${FLASH_TOTAL_MS}ms ease-out forwards`,
            pointerEvents: 'none',
          }}
        >
          ✨ First sighting!
        </div>
      )}
    </div>
  )
}
