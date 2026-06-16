import React from 'react'
import { P } from '../../lib/constants.js'
import UrgencyIcon from './UrgencyIcon.jsx'
import ConfidenceBasis from './ConfidenceBasis.jsx'

// No mascot, no character, no placeholder art (care-engine-spec C7 anti-anchor). The card leads
// with the engine's plain statement; ask-mode reads as a question, assert-mode as a heads-up.
const TREND = {
  improving: { icon: '↗', label: 'improving', color: P.green },
  steady:    { icon: '→', label: 'steady',    color: P.light },
  worsening: { icon: '↘', label: 'worsening', color: P.terra },
}
const DECAY_LABEL = {
  fresh: 'fresh', decaying: 'aging', stale_unverified: 'needs a check',
  dormant: 'dormant', resolved: 'resolved',
}
const MODE_LABEL = { ask: 'Question', assert: 'Heads-up' }

export default function FindingCard({ finding }) {
  const f = finding ?? {}
  const trend = TREND[f.trend] ?? TREND.steady
  const isAsk = f.assertion_mode === 'ask'
  return (
    <div
      data-testid="finding-card"
      style={{
        border: `1px solid ${P.border}`, borderRadius: 10, backgroundColor: P.white,
        padding: 14, display: 'flex', flexDirection: 'column', gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          fontSize: '0.66rem', fontWeight: 700, textTransform: 'uppercase',
          letterSpacing: '0.04em', color: isAsk ? P.blue : P.terra,
        }}>
          {MODE_LABEL[f.assertion_mode] ?? 'Note'}
        </span>
        <span style={{ flex: 1 }} />
        <UrgencyIcon level={f.urgency_level} />
      </div>

      <p style={{ margin: 0, fontSize: '0.98rem', fontWeight: 600, color: P.dark, lineHeight: 1.35 }}>
        {f.statement}
      </p>

      <ConfidenceBasis band={f.confidence_band} basis={f.confidence_basis} />

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: '0.7rem', color: P.light }}>
        <span style={{ color: trend.color, fontWeight: 600 }}>{trend.icon} {trend.label}</span>
        <span aria-hidden="true">·</span>
        <span>{DECAY_LABEL[f.decay_state] ?? f.decay_state}</span>
      </div>
    </div>
  )
}