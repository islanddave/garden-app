import React from 'react'
import { P } from '../lib/constants.js'
import { T } from './forms/formStyles.js'
import Icon from './Icon.jsx'

// V4-FLAG-001 (2026-07-07): the per-planting flag UI is BACK; flagged severity variants (1/2/3)
// reinstated alongside the system 'stale' badge. Keyed on int severity (event_log.severity).
// V4-ICON-001: severity emoji -> the §9 monotonic glyph ladder (severity.low/med/high).
// The badge span sets `color` per tone below, so each mono glyph inherits its severity hue
// (shape carries the order; color reinforces; the label is the text channel — SC 1.4.1).
const FLAG = {
  1: { label: 'Keeping an eye on it', color: P.severityStaleInk, icon: 'severity.low' },
  2: { label: 'Needs attention', color: P.terra, icon: 'severity.med' },
  3: { label: 'Urgent', color: P.severityUrgent, icon: 'severity.high' },
}
const STALE = {
  label: 'Stale',
  color: P.severityStaleInk,
  title: 'Stale: no observations in 21+ days',
  icon: (c) => (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <circle cx="6" cy="6" r="5" fill="none" stroke={c} strokeWidth="1.5" strokeDasharray="2 1.5" />
    </svg>
  ),
}

const badgeStyle = (color) => ({
  display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', minHeight: 20,
  borderRadius: T.radiusCard, border: `1px solid ${color}`, color, fontSize: T.type.xs,
  fontWeight: 600, lineHeight: 1, whiteSpace: 'nowrap', backgroundColor: 'transparent',
})

export default function SeverityBadge({ reason, severity, daysStale }) {
  if (reason === 'flagged' && FLAG[severity]) {
    const f = FLAG[severity]
    return (
      <span role="status" title={`Flagged issue — ${f.label}`} data-testid="severity-badge"
        data-variant={`flagged-${severity}`} style={badgeStyle(f.color)}>
        <Icon name={f.icon} size={13} decorative />
        <span>{f.label}</span>
      </span>
    )
  }
  if (reason !== 'stale') return null
  const label = typeof daysStale === 'number' ? `${STALE.label} · ${daysStale}d` : STALE.label
  return (
    <span
      role="status"
      title={STALE.title}
      data-testid="severity-badge"
      data-variant="stale"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 8px',
        minHeight: 20,
        borderRadius: T.radiusCard,
        border: `1px solid ${STALE.color}`,
        color: STALE.color,
        fontSize: T.type.xs,
        fontWeight: 600,
        lineHeight: 1,
        whiteSpace: 'nowrap',
        backgroundColor: 'transparent',
      }}
    >
      {STALE.icon(STALE.color)}
      <span>{label}</span>
    </span>
  )
}
