// src/components/putup/CheckInSaved.jsx
// Put-Up release 1b (V4 §2.3: "from 1b every check-in shows 'Saved · Undo' in place (Undo writes a void
// row)"). One quiet line on the card after a check-in lands, until the next visit — no timer. Undo is
// POST /:id/stages {stage_kind: 'void', voids_id} (contract-F §2.3); a second void of the same row is a
// replay on the server (the UNIQUE on voids_id), and a synchronous ref refuses it here first. A
// duplicate check-in is one visible row with its own Undo (V4 §5.2): check-ins are not keyed.
import React, { useCallback, useRef, useState } from 'react'
import { P, T } from '../../lib/tokens.js'
import { useApiFetch } from '../../lib/api.js'
import { describeRefusal } from '../../lib/putUpErrors.js'

export const SAVED_TEXT = 'Saved'
export const UNDONE_CHECKIN_TEXT = 'Taken back — that check-in is off the log.'

export default function CheckInSaved({ batchId, stageId, onUndone }) {
  const { fetch } = useApiFetch()
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [err, setErr] = useState(null)
  const writingRef = useRef(false)
  const undo = useCallback(async () => {
    if (writingRef.current || done) return
    writingRef.current = true
    setBusy(true); setErr(null)
    try {
      await fetch(`/api/kitchen-batches/${batchId}/stages`, { method: 'POST', body: JSON.stringify({ stage_kind: 'void', voids_id: stageId }) })
      setDone(true)
      onUndone?.()
    } catch (e) {
      setErr(describeRefusal(e)?.text ?? "Couldn't undo that — try again.")
    } finally {
      writingRef.current = false
      setBusy(false)
    }
  }, [batchId, done, fetch, onUndone, stageId])
  return (
    <div data-testid="going-checkin-saved" style={{ marginTop: 3 }}>
      <span role="status" style={{ color: P.mid, fontSize: '0.78rem' }}>{done ? UNDONE_CHECKIN_TEXT : SAVED_TEXT}</span>
      {!done && (
        <button type="button" data-testid="going-checkin-undo" disabled={busy} onClick={undo}
          aria-label="Undo that check-in"
          style={{ display: 'inline-flex', alignItems: 'center', minHeight: T.tapMinHeight, minWidth: 48, marginLeft: 6,
            background: 'none', border: 'none', padding: '2px 8px', cursor: busy ? 'default' : 'pointer',
            fontFamily: 'inherit', color: P.green, fontSize: '0.78rem' }}>
          Undo
        </button>
      )}
      {err && <div role="alert" data-alarm-ink-exempt="error" style={{ color: P.terra, fontSize: '0.78rem' }}>{err}</div>}
    </div>
  )
}
