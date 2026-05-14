import React from 'react'

const COLORS = {
  terraBold: '#a8442e',
  terra:     '#b94a3a',
  gold:      '#c19a3a',
  mutedGold: '#d4b556',
}

const VARIANTS = {
  flagged3: {
    label: 'Urgent',
    color: COLORS.terraBold,
    title: 'Urgent: action today or plant may be lost',
    icon: (c) => (
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <circle cx="6" cy="6" r="5" fill={c} />
      </svg>
    ),
  },
  flagged2: {
    label: 'Issue',
    color: COLORS.terra,
    title: 'Issue: action within 48h',
    icon: (c) => (
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <polygon points="6,1 11,11 1,11" fill={c} />
      </svg>
    ),
  },
  flagged1: {
    label: 'Watch',
    color: COLORS.gold,
    title: 'Watch: monitor only, no action today',
    icon: (c) => (
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <polygon points="6,1 11,11 1,11" fill="none" stroke={c} strokeWidth="1.5" />
      </svg>
    ),
  },
  stale: {
    label: 'Stale',
    color: COLORS.mutedGold,
    title: 'Stale: no observations in 21+ days',
    icon: (c) => (
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <circle cx="6" cy="6" r="5" fill="none" stroke={c} strokeWidth="1.5" strokeDasharray="2 1.5" />
      </svg>
    ),
  },
}

function pickVariant(severity, reason) {
  if (reason === 'stale') return VARIANTS.stale
  if (reason === 'flagged') {
    if (severity === 3) return VARIANTS.flagged3
    if (severity === 2) return VARIANTS.flagged2
    if (severity === 1) return VARIANTS.flagged1
  }
  return null
}

export default function SeverityBadge({ severity, reason, daysStale }) {
  const v = pickVariant(severity, reason)
  if (!v) return null
  const label = v === VARIANTS.stale && typeof daysStale === 'number'
    ? `${v.label} · ${daysStale}d`
    : v.label
  return (
    <span
      role="status"
      title={v.title}
      data-testid="severity-badge"
      data-variant={reason === 'stale' ? 'stale' : `flagged${severity}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 8px',
        minHeight: 20,
        borderRadius: 10,
        border: `1px solid ${v.color}`,
        color: v.color,
        fontSize: '0.72rem',
        fontWeight: 600,
        lineHeight: 1,
        whiteSpace: 'nowrap',
        backgroundColor: 'transparent',
      }}
    >
      {v.icon(v.color)}
      <span>{label}</span>
    </span>
  )
}
