// src/components/putup/KindQuestion.jsx
// "What kind of batch? →" — one inline question on a batch whose kind is NULL, answered in one tap and
// never asked again. Asked on the Going-now card (Put-Up 1a) and, from release F, on batch detail too —
// open or closed (06 §3.10): the Ferment fields appear there with no navigation once it is answered.
// `idPrefix` keeps the two hosts' testids apart; the card's are 'going-kind-*' as they always were.
import React, { useCallback, useRef, useState } from 'react'
import { P } from '../../lib/constants.js'
import { T } from '../../lib/tokens.js'
import KindChips, { kindBody } from '../kitchen/KindChips.jsx'
import { KIND_QUESTION } from './goingNow.js'

// Put-Up 1a (V4 §2.3). The same inline-expand shape as the start-date editor (now on the batch's
// own surface, BatchDetailView.jsx) and for the same reason: an inline reveal is not a dismissable
// layer. One tap on a chip IS the answer — it PUTs {kind} through
// the shipped merge PUT (an absent key is left alone, so nothing else on the row moves) and the
// question is never asked again. "Other" is the one two-step answer: it offers its short name before
// Save — optional from release 1b, where the CHECK no longer needs it (kindBody sends kind alone).
//
// The question hides itself the moment the write lands, rather than waiting for the list re-read to
// carry the new kind back: a question that re-appears for the length of a round trip after it was
// answered reads as "that didn't take", which invites a second tap.
export default function KindQuestion({ batch, fetch, onChanged, idPrefix = 'going-kind' }) {
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState(null)
  const [otherText, setOtherText] = useState('')
  const [answered, setAnswered] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  // Synchronous exclusion, the BatchInputsField idiom: `busy` only disables the chips after React
  // commits, so two taps inside one frame would both read it false and both PUT.
  const writingRef = useRef(false)

  // Resolves true when the kind landed. A refused or failed write leaves the question open with the
  // chips un-pressed, so the next tap is a retry rather than a toggle-off.
  const save = useCallback(async (kind, text) => {
    const body = kindBody(kind, text)
    if (!body || !Object.keys(body).length) { setErr('Give it a short name first.'); return false }
    if (writingRef.current) return false
    writingRef.current = true
    setBusy(true); setErr(null)
    try {
      await fetch(`/api/kitchen-batches/${batch.id}`, { method: 'PUT', body: JSON.stringify(body) })
      setAnswered(true)
      onChanged?.()
      return true
    } catch {
      setErr("Couldn't save that — try again.")
      return false
    } finally {
      writingRef.current = false
      setBusy(false)
    }
  }, [batch.id, fetch, onChanged])

  const choose = useCallback((kind) => {
    setErr(null)
    if (kind === 'other' || kind == null) { setPicked(kind); return }
    setPicked(kind)
    save(kind).then(ok => { if (!ok) setPicked(null) })
  }, [save])

  if (answered) return null

  if (!open) {
    return (
      <button type="button" data-testid={`${idPrefix}-question`} onClick={() => setOpen(true)}
        style={{ display: 'inline-flex', alignItems: 'center', minHeight: T.tapMinHeight,
          background: 'none', border: 'none', padding: '2px 8px 2px 0', cursor: 'pointer',
          fontFamily: 'inherit', color: P.green, fontSize: '0.78rem' }}>
        {KIND_QUESTION} →
      </button>
    )
  }

  return (
    <div data-testid={`${idPrefix}-editor`} style={{ marginTop: 6 }}>
      {err && <div role="alert" data-alarm-ink-exempt="error" data-testid={`${idPrefix}-error`}
        style={{ color: P.terra, fontSize: '0.78rem', marginBottom: 6 }}>{err}</div>}
      <KindChips idPrefix={idPrefix} value={picked} onChange={choose} disabled={busy}
        otherText={otherText} onOtherTextChange={setOtherText} ariaLabel={KIND_QUESTION} />
      <div style={{ display: 'flex', alignItems: 'center', gap: T.space.sm, marginTop: 6 }}>
        {picked === 'other' && (
          <button type="button" data-testid={`${idPrefix}-save`} disabled={busy}
            onClick={() => save('other', otherText)}
            style={{ minHeight: T.tapMinHeight, padding: '6px 12px', cursor: busy ? 'default' : 'pointer',
              background: 'none', border: 'none', fontFamily: 'inherit', fontSize: '0.78rem',
              fontWeight: 700, color: P.green }}>
            Save
          </button>
        )}
        <button type="button" data-testid={`${idPrefix}-cancel`} disabled={busy}
          onClick={() => { setOpen(false); setPicked(null); setOtherText(''); setErr(null) }}
          style={{ minHeight: T.tapMinHeight, padding: '6px 4px', cursor: 'pointer', background: 'none',
            border: 'none', fontFamily: 'inherit', fontSize: '0.78rem', color: P.light }}>
          Not now
        </button>
      </div>
    </div>
  )
}

