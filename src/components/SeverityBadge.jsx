import React from 'react'

// FLAG-REMOVAL (2026-06-10): the per-planting issue-flagging UI was retired; the flagged1/2/3
// variants left with it. Only the system-assigned 'stale' badge remains (HeadsUpTile).
const STALE = {
  label: 'Stale',
  color: '#d4b556',
  title: 'Stale: no observations in 21+ days',
  icon: (c) => (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <circle cx="6" cy="6" r="5" fill="none" stroke={c} strokeWidth="1.5" strokeDasharray="2 1.5" />
    </svg>
  ),
}

export default function SeverityBadge({ reason, daysStale }) {
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
        borderRadius: 10,
        border: `1px solid ${STALE.color}`,
        color: STALE.color,
        fontSize: '0.72rem',
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
