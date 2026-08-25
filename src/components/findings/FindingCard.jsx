import React, { useState } from 'react'
import { OverlayLink } from '../../context/OverlayContext.jsx'
import { P } from '../../lib/constants.js'
import UrgencyIcon from './UrgencyIcon.jsx'
import ConfidenceBasis from './ConfidenceBasis.jsx'
import CaretakerBadge from '../CaretakerBadge.jsx'

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

// BUG-SILENTFAILSWEEP-001 — names this card's own verb and the state the finding is left in. The
// card staying put was the entire failure signal, and a card sitting there is what the card does
// when nothing has happened at all, so "you can retry" needed saying rather than implying.
const RESOLVE_FAILED_COPY = "Couldn't mark this resolved — it's still open."

// The DrG finding's source event id is carried in finding_id as `issue:<event_id>` (assemble.js).
// Parse it for the manual-resolve action rather than adding a contract field (keeps this change
// off the shared engine contract that the concurrent materialization seam also touches).
function sourceEventId(findingId) {
  return typeof findingId === 'string' && findingId.startsWith('issue:')
    ? findingId.slice('issue:'.length)
    : null
}

export default function FindingCard({ finding, onResolve, caretaker = null }) {
  const f = finding ?? {}
  const [busy, setBusy] = useState(false)
  const [resolveErr, setResolveErr] = useState(null)
  const trend = TREND[f.trend] ?? TREND.steady
  const isAsk = f.assertion_mode === 'ask'

  // Operational control (NOT a reward surface): lets the owner clear a live issue on their own
  // timeline. Reuses PATCH /api/events/:id {resolved:true}. Hidden once resolved and when no handler.
  const eventId = sourceEventId(f.finding_id)
  const canResolve = typeof onResolve === 'function' && !!eventId && f.decay_state !== 'resolved'
  // V4-TREATLOG-001: "Treated…" opens the treatment form (event_type=doctored) prefilled to this
  // planting/project, and resolves this finding once the treatment logs (EventNew reads ?resolve=).
  const canTreat = !!eventId && f.decay_state !== 'resolved'
  const treatHref = (() => {
    if (!canTreat) return null
    const q = new URLSearchParams({ event_type: 'doctored', resolve: eventId })
    if (f.plant_id) q.set('plant', f.plant_id)
    if (f.project_id) q.set('project', f.project_id)
    return `/log?${q.toString()}`
  })()

  const handleResolve = async () => {
    if (busy) return
    setBusy(true)
    setResolveErr(null)   // re-arm: a stale line from the last attempt must not outlive this tap
    try {
      await onResolve(eventId)
      // success → parent reloads findings and this card unmounts; no toast (Reward-UX: not a reward).
    } catch {
      // BUG-SILENTFAILSWEEP-001 — staying put IS the right recovery, but on its own it returned the
      // card to its resting state and said nothing, so "it didn't work" and "you didn't tap it"
      // looked identical. The message is the difference; the button is still the retry.
      setBusy(false)
      setResolveErr(RESOLVE_FAILED_COPY)
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
        {/* V4-ASSIGNLENS-002 — per-card caretaker badge, mirroring the Garden tiles. Only present
            when the parent surface resolves a caretaker (multi-caretaker household + mixed set);
            null otherwise, so single-caretaker/unassigned/badges-off cards draw nothing. */}
        {caretaker && <CaretakerBadge caretaker={caretaker} size={16} />}
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
        {canTreat && (
          <OverlayLink
            to={treatHref}
            style={{
              padding: 0, marginRight: 12, textDecoration: 'none',
              fontSize: '0.7rem', fontWeight: 600, color: P.green,
            }}
          >
            Treated…
          </OverlayLink>
        )}
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

      {/* Under the action row, on the card the tap came from — the page-level slot would report one
          tap somewhere the finding it belongs to isn't. Inserted on failure, so role="alert"
          announces it; removed again when the retry re-arms. */}
      {resolveErr && (
        <p role="alert" data-testid="finding-resolve-error"
          style={{ margin: 0, fontSize: '0.74rem', fontWeight: 600, color: P.terra }}>
          {resolveErr}
        </p>
      )}
    </div>
  )
}
