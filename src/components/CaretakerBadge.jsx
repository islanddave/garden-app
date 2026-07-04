// src/components/CaretakerBadge.jsx — V4-ASSIGNLENS-001. Tiny caretaker indicator: colored dot +
// initial (colour alone fails SC1.4.1). Unassigned -> hollow outline dot, no initial. Carries a
// human aria-label so the meaning survives without colour.
import React from 'react'
import { P } from '../lib/constants.js'

export default function CaretakerBadge({ caretaker = null, size = 18, style }) {
  const assigned = !!caretaker
  const color = assigned ? caretaker.color : P.light
  const who = assigned ? (caretaker.isMe ? 'you' : caretaker.name) : null
  const label = assigned ? `Cared for by ${who}` : 'Unassigned'
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: size, height: size, borderRadius: '50%', flexShrink: 0,
        fontSize: Math.round(size * 0.55), fontWeight: 700, lineHeight: 1,
        color: assigned ? P.white : 'transparent',
        backgroundColor: assigned ? color : 'transparent',
        border: assigned ? 'none' : `1.5px solid ${P.light}`,
        ...style,
      }}
    >
      {assigned ? caretaker.initial : ''}
    </span>
  )
}
