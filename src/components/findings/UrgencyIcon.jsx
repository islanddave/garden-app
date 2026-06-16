import React from 'react'
import { P } from '../../lib/constants.js'

// Urgency is emitted by the engine but DE-PRIVILEGED (care-engine-spec C7): rendered as a small,
// low-emphasis dot with an accessible label only — never a size/color driver for the card and
// never an ordering key (see findingsSort.js). Default to low when unknown.
const DOT = { low: P.border, moderate: P.gold, high: P.terra }

export default function UrgencyIcon({ level }) {
  const color = DOT[level] ?? P.border
  return (
    <span
      role="img"
      aria-label={`urgency: ${level ?? 'low'}`}
      title={`urgency: ${level ?? 'low'}`}
      style={{
        width: 7, height: 7, borderRadius: '50%', backgroundColor: color,
        display: 'inline-block', flexShrink: 0, opacity: 0.7,
      }}
    />
  )
}