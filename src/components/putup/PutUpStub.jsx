// src/components/putup/PutUpStub.jsx
// Put-Up release 1b (V4 §2.3 "Undo that put-up", §2.4 "Completion") — what a sitting leaves behind in
// place: one status line with Undo and Open →, until the next visit. No timer and no toast.
//
// The same Undo sits on each sitting in batch detail's What came out, so the write lives here once:
// useUndoPutUp — POST /api/kitchen-batches/:id/put-up/:stageId/undo (contract-F §2.4). A second tap is
// a replay on the server (the void row's UNIQUE), and a synchronous ref refuses it here first. A
// refusal (409 put_up_in_use: a jar was used or drawn) is shown in the server's words and the sitting
// stays.
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { P, T } from '../../lib/tokens.js'
import { useApiFetch } from '../../lib/api.js'
import { describeRefusal } from '../../lib/putUpErrors.js'

export const UNDO_PUT_UP_CTA = 'Undo that put-up'
export const UNDONE_TEXT = 'Put-up undone — its jars are gone.'

export function useUndoPutUp({ batchId, stageId, onUndone }) {
  const { fetch } = useApiFetch()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [done, setDone] = useState(false)
  const writingRef = useRef(false)
  const undo = useCallback(async () => {
    if (writingRef.current || done || !batchId || !stageId) return
    writingRef.current = true
    setBusy(true); setErr(null)
    try {
      const answer = await fetch(`/api/kitchen-batches/${batchId}/put-up/${stageId}/undo`, { method: 'POST', body: '{}' })
      setDone(true)
      onUndone?.(answer)
    } catch (e) {
      const r = describeRefusal(e)
      setErr(r ? r.text : "Couldn't undo that — try again.")
    } finally {
      writingRef.current = false
      setBusy(false)
    }
  }, [batchId, done, fetch, onUndone, stageId])
  return { undo, busy, err, done }
}

const link = {
  display: 'inline-flex', alignItems: 'center', minHeight: T.tapMinHeight, background: 'none', border: 'none',
  padding: '2px 8px 2px 0', cursor: 'pointer', fontFamily: 'inherit', color: P.green, fontSize: '0.78rem',
}

// `stub` = { batchId, stageId, text, focus }. `focus` is set when the sitting FINISHED the batch and its
// card left the list: focus lands on the stub (V4 §6.6), so a screen reader is not dropped at the top.
export default function PutUpStub({ stub, onOpen, onUndone }) {
  const ref = useRef(null)
  const { undo, busy, err, done } = useUndoPutUp({ batchId: stub.batchId, stageId: stub.stageId, onUndone })
  useEffect(() => { if (stub.focus) ref.current?.focus() }, [stub.focus])
  return (
    <div ref={ref} tabIndex={-1} data-testid="going-putup-stub" data-batch-id={stub.batchId}
      style={{ marginBottom: T.space.sm, padding: '8px 0', outline: 'none' }}>
      <div role="status" style={{ color: P.mid, fontSize: '0.82rem', lineHeight: 1.45 }}>
        {done ? UNDONE_TEXT : stub.text}
      </div>
      {err && <div role="alert" data-alarm-ink-exempt="error" data-testid="going-putup-stub-error"
        style={{ color: P.terra, fontSize: '0.78rem', marginTop: 4 }}>{err}</div>}
      <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: T.space.md }}>
        {!done && stub.stageId && (
          <button type="button" data-testid="going-putup-undo" disabled={busy} onClick={undo} style={link}>Undo</button>
        )}
        <button type="button" data-testid="going-putup-open" onClick={() => onOpen?.(stub.batchId)} style={link}>Open →</button>
      </div>
    </div>
  )
}
