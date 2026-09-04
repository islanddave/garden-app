// src/components/putup/PhReadingField.jsx
// V5-PHRECORD-001 — writing down a pH someone measured, on the Going-now card.
//
// ⚠ THE LINE THIS COMPONENT HOLDS:
//   FORBIDDEN — derive, score, colour, gate, compare to a threshold, or infer from elapsed time.
//   PERMITTED — record a measured value verbatim, prompt someone to measure, link to how.
// There is no branch below that reads a recorded value and decides anything about it. The number is
// rendered in the card's ordinary ink beside the date it was taken, and every other line here is a
// question or an attribution. No verdict, no colour, no badge, no tick.
//
// AND NEVER AN AGGREGATE. Only the newest reading is shown, always with its date. No count, no
// streak, no run of ticks, no "3 checks this week": a batch that never acidified produces an unbroken
// run of "checked" entries, so any aggregate turns absent failure signs into apparent success. The
// full history is the stage log, where each reading is one dated line. Same rule that already binds
// the submersion prompt.
//
// WHY IT LIVES ON THE CHECK-IN AND NOT ON CAPTURE. Nobody measures pH while photographing a jar they
// just packed, and CaptureFlow's assertion that the capture surface carries no pH or safety language
// is correct and stays green — this is a different surface answering a different question.
//
// SHAPE IS COPIED FROM SetStartDate IN GoingNowView.jsx, deliberately and down to the ink: a link-
// coloured action in the card's action slot, expanding IN PLACE rather than opening a Sheet. An
// inline reveal is not a dismissable layer, so it needs no DismissRegistry coordination — which is
// exactly why it is the cheaper shape on a card.
//
// Adjudication: project-state/_build-inflight-20260904/FOODSAFETY-RULING-V101.md §2 (gardening-docs).
// Every threshold in the evidence behind it carries a scope condition; none of them is in this file.
import React, { useState, useCallback } from 'react'
import { P } from '../../lib/constants.js'
import { T } from '../../lib/tokens.js'
import {
  PH_RECORD_CTA, PH_INSTRUMENT_NOTE, PH_LINK_URL, PH_LINK_LABEL, PH_SCALE_HINT,
  PH_SCALE_MIN, PH_SCALE_MAX, phStagePatch,
} from './goingNow.js'

// The instrument note plus its link, rendered once inside the open editor rather than standing on the
// card. It is reference content for the person about to measure, and a permanent line on every
// ferment card would be the third thing competing with two questions.
function InstrumentNote() {
  return (
    <div data-testid="going-ph-instrument" style={{ marginTop: 8, color: P.light, fontSize: '0.78rem', lineHeight: 1.45 }}>
      {PH_INSTRUMENT_NOTE}{' '}
      <a href={PH_LINK_URL} target="_blank" rel="noreferrer noopener"
        data-testid="going-ph-link" style={{ color: P.green, whiteSpace: 'nowrap' }}>
        {PH_LINK_LABEL}
      </a>
    </div>
  )
}

// `now` is injected, never Date.now() inside the handler: the card already renders against ONE
// instant and a save that stamps a different one would put two clocks on one surface. It is also what
// lets a test pin ph_read_at to a fixed literal instead of to the wall clock.
export default function PhReadingField({ batch, fetch, onChanged, nowMs }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [typed, setTyped] = useState('')

  const save = useCallback(async () => {
    // The trimmed STRING the cook typed reaches the server, never a Number: a Number round-trip drops
    // a trailing zero the meter displayed. phStagePatch is the one place that rule lives.
    const patch = phStagePatch(typed, new Date(nowMs).toISOString())
    if (!patch) { setErr(PH_SCALE_HINT); return }
    setBusy(true); setErr(null)
    try {
      await fetch(`/api/kitchen-batches/${batch.id}/stages`, { method: 'POST', body: JSON.stringify(patch) })
      setOpen(false)
      setTyped('')
      onChanged?.()
    } catch {
      setErr("Couldn't save that — try again.")
    } finally { setBusy(false) }
  }, [batch.id, fetch, nowMs, onChanged, typed])

  if (!open) {
    return (
      <button type="button" data-testid="going-ph-open" onClick={() => setOpen(true)}
        style={{ display: 'inline-flex', alignItems: 'center', minHeight: T.tapMinHeight,
          background: 'none', border: 'none', padding: '2px 8px 2px 0', cursor: 'pointer',
          fontFamily: 'inherit', color: P.green, fontSize: '0.78rem' }}>
        {PH_RECORD_CTA}
      </button>
    )
  }

  return (
    <div data-testid="going-ph-editor" style={{ marginTop: 6 }}>
      {err && <div role="alert" data-testid="going-ph-error"
        style={{ color: P.terra, fontSize: '0.78rem', marginBottom: 6 }}>{err}</div>}
      <div style={{ display: 'flex', alignItems: 'center', gap: T.space.sm }}>
        {/* `text` with inputMode decimal, not type="number": a number input hands back a coerced
            value and drops a trailing zero, which is the one thing this field must not do. min/max
            are the pH SCALE, restating chk_ksl_ph_scale — not a food-safety band. */}
        <input type="text" inputMode="decimal" aria-label="pH reading" value={typed}
          data-testid="going-ph-input" placeholder={`${PH_SCALE_MIN}–${PH_SCALE_MAX}`}
          onChange={e => { setTyped(e.target.value); setErr(null) }}
          style={{ width: 86, minHeight: T.tapMinHeight, padding: '6px 10px', fontFamily: 'inherit',
            fontSize: T.type.sm, border: `1px solid ${P.border}`, borderRadius: T.radiusButton, background: P.white }} />
        <button type="button" disabled={busy || !typed} data-testid="going-ph-save" onClick={save}
          style={{ minHeight: T.tapMinHeight, padding: '6px 12px', cursor: busy || !typed ? 'default' : 'pointer',
            background: 'none', border: 'none', fontFamily: 'inherit', fontSize: '0.78rem',
            fontWeight: 700, color: typed ? P.green : P.light }}>
          Save
        </button>
        <button type="button" data-testid="going-ph-cancel"
          onClick={() => { setOpen(false); setErr(null); setTyped('') }}
          style={{ minHeight: T.tapMinHeight, padding: '6px 4px', cursor: 'pointer', background: 'none',
            border: 'none', fontFamily: 'inherit', fontSize: '0.78rem', color: P.light }}>
          Cancel
        </button>
      </div>
      <InstrumentNote />
    </div>
  )
}
