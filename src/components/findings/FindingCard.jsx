import React, { useState } from 'react'
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

// The DrG finding's source event id is carried in finding_id as `issue:<event_id>` (assemble.js).
// Parse it for the manual-resolve action rather than adding a contract field (keeps this change
// off the shared engine contract that the concurrent materialization seam also touches).
function sourceEventId(findingId) {
  return typeof findingId === 'string' && findingId.startsWith('issue:')
    ? findingId.slice('issue:'.length)
    : null
}

export default function FindingCard({ finding, onResolve }) {
  const f = finding ?? {}
  const [busy, setBusy] = useState(false)
  const trend = TREND[f.trend] ?? TREND.steady
  const isAsk = f.assertion_mode === 'ask'

  // Operational control (NOT a reward surface): lets the owner clear a live issue on their own
  // timeline. Reuses PATCH /api/events/:id {resolved:true}. Hidden once resolved and when no handler.
  const eventId = sourceEventId(f.finding_id)
  const canResolve = typeof onResolve === 'function' && !!eventId && f.decay_state !== 'resolved'

  const handleResolve = async () => {
    if (busy) return
    setBusy(true)
    try {
      await onResolve(eventId)
      // success → parent reloads findings and this card unmounts; no toast (Reward-UX: not a reward).
    } catch {
      setBusy(false) // stay put on failure so the owner can retry
    }
  }

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

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: '0.7rem', color: P.light }}>
        <span style={{ color: trend.color, fontWeight: 600 }}>{trend.icon} {trend.label}</span>
        <span aria-hidden="true">·</span>
        <span>{DECAY_LABEL[f.decay_state] ?? f.decay_state}</span>
        <span style={{ flex: 1 }} />
        {canResolve && (
          <button
            type="button"
            onClick={handleResolve}
            disabled={busy}
            style={{
              background: 'none', border: 'none', padding: 0,
              cursor: busy ? 'default' : 'pointer', fontSize: '0.7rem', fontWeight: 600,
              color: P.green, opacity: busy ? 0.6 : 1,
            }}
          >
            {busy ? 'Resolving…' : 'Mark resolved'}
          </button>
        )}
      </div>
    </div>
  )
}
