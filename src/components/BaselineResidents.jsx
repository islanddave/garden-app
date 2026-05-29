// BaselineResidents — Day-1 always-present robin + honeybee.
// Canonical spec: revision §3.14 (Day-1 baseline residents — client-side render of
//                 species_id=1 (robin) + species_id=2 (honeybee), NEVER persisted
//                 to critter_state, coachmark trigger excludes baselines).
// V100 binding: §4 species pool (robin/honeybee = "always-present" — give Day-1 life signal).
//
// HARD RULES:
//   - Client-side ONLY — never POST to /api/critters, never appears in /api/critters/active
//   - Decorative — aria-hidden=true (not announced); not interactive (no long-press)
//   - NEVER count toward "first critter earned" → coachmark trigger excludes baselines
//   - Renders as 2 ambient sprites in fixed positions on the Garden tab
//
// Props:
//   size  — px (default 28)
//   style — additional inline style for the container

import React from 'react'
import { BASELINE_RESIDENTS } from '../lib/critterSpecies.js'

export default function BaselineResidents({ size = 28, style = {} }) {
  if (!BASELINE_RESIDENTS || BASELINE_RESIDENTS.length === 0) return null
  return (
    <div
      aria-hidden="true"
      data-testid="baseline-residents"
      style={{
        position: 'absolute',
        top: 8,
        right: 12,
        display: 'flex',
        gap: 6,
        pointerEvents: 'none',
        opacity: 0.7, // ambient — softer than earned critters
        ...style,
      }}
    >
      {BASELINE_RESIDENTS.map(species => (
        <img
          key={species.species_id}
          src={`/critters/${species.sprite_filename}`}
          alt=""
          draggable={false}
          data-baseline-species-id={species.species_id}
          style={{
            width: size,
            height: size,
            display: 'block',
            pointerEvents: 'none',
          }}
        />
      ))}
    </div>
  )
}
