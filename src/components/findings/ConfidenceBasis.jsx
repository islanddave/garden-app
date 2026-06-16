import React from 'react'
import { P } from '../../lib/constants.js'

// Confidence band + the engine's rendered basis text (e.g. "no first-party log yet").
// Bands are coarse (low/moderate/high) per the engine; styling is muted, not alarm-colored.
const BAND = {
  high:     { bg: P.greenPale, fg: P.green, label: 'high confidence' },
  moderate: { bg: P.warn,      fg: P.gold,  label: 'moderate confidence' },
  low:      { bg: P.cream,     fg: P.light, label: 'low confidence' },
}

export default function ConfidenceBasis({ band, basis }) {
  const s = BAND[band] ?? BAND.low
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{
        alignSelf: 'flex-start', fontSize: '0.68rem', fontWeight: 700,
        color: s.fg, backgroundColor: s.bg, border: `1px solid ${P.border}`,
        borderRadius: 6, padding: '2px 8px',
      }}>
        {s.label}
      </span>
      {basis ? <span style={{ fontSize: '0.78rem', color: P.light }}>{basis}</span> : null}
    </div>
  )
}