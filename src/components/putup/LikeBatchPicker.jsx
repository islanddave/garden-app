// src/components/putup/LikeBatchPicker.jsx
// B′ release 3 — "Like <batch>, except…" (V4 §2.2): a quiet door that lists past batches and, on a tap,
// reads that batch and hands its lines and kind to the host as a draft (likeBatch.js likeDraft). Used by
// Start a batch and by How it was made →. Plain markup; no new visual design.
//
// Props: onPick({ kind, lines, from }) · picked (the current { from, lines } or null) · onClear ·
// exceptId (never offer this batch) · disabled · idPrefix.
import React, { useState } from 'react'
import { P, T } from '../../lib/tokens.js'
import { useApiFetch } from '../../lib/api.js'
import SelectChip from '../forms/SelectChip.jsx'
import { mintKey } from '../kitchen/idempotencyKey.js'
import { likeDraft, likeChoices, likeWords } from './likeBatch.js'

const link = {
  display: 'inline-flex', alignItems: 'center', minHeight: T.tapMinHeight, background: 'none', border: 'none',
  padding: '2px 8px 2px 0', cursor: 'pointer', fontFamily: 'inherit', color: P.green, fontSize: T.type.sm, fontWeight: 600,
}

export default function LikeBatchPicker({ onPick, picked = null, onClear, exceptId = null, disabled = false, idPrefix = 'like' }) {
  const { fetch } = useApiFetch()
  const [open, setOpen] = useState(false)
  const [choices, setChoices] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  const load = async () => {
    setOpen(true); setErr(null)
    if (choices) return
    try {
      const r = await fetch('/api/kitchen-batches?state=all')
      setChoices(likeChoices(r?.batches, exceptId))
    } catch { setErr("Couldn't load past batches just now.") }
  }

  const choose = async (b) => {
    setBusy(true); setErr(null)
    try {
      const detail = await fetch(`/api/kitchen-batches/${b.id}`)
      onPick?.(likeDraft(detail, mintKey))
      setOpen(false)
    } catch { setErr("Couldn't read that batch just now.") }
    setBusy(false)
  }

  if (picked?.from) {
    return (
      <div data-testid={`${idPrefix}-picked`} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', color: P.mid, fontSize: T.type.sm }}>
        <span>{likeWords(picked.from, picked.lines?.length ?? 0)}</span>
        <button type="button" style={{ ...link, fontWeight: 400 }} disabled={disabled}
          data-testid={`${idPrefix}-clear`} onClick={() => onClear?.()}>Don’t copy</button>
      </div>
    )
  }

  return (
    <div data-testid={idPrefix}>
      <button type="button" style={link} aria-expanded={open} disabled={disabled} data-testid={`${idPrefix}-open`}
        onClick={() => (open ? setOpen(false) : load())}>
        Like a past batch, except…
        <span style={{ color: P.light, fontWeight: 400, fontSize: '0.78rem', marginLeft: 6 }}>optional</span>
      </button>
      {open && (
        <div style={{ marginTop: 6 }}>
          {choices == null && !err && <div style={{ color: P.light, fontSize: T.type.sm }}>Loading…</div>}
          {choices && choices.length === 0 && (
            <div data-testid={`${idPrefix}-none`} style={{ color: P.light, fontSize: T.type.sm }}>No past batches yet.</div>
          )}
          {choices && choices.length > 0 && (
            <div role="group" aria-label="Like which batch?" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {choices.map(b => (
                <SelectChip key={b.id} touch disabled={busy || disabled} data-testid={`${idPrefix}-batch-${b.id}`}
                  onClick={() => choose(b)}>{b.label}</SelectChip>
              ))}
            </div>
          )}
          {err && <div role="alert" data-testid={`${idPrefix}-error`} style={{ color: P.terra, fontSize: T.type.sm, marginTop: 4 }}>{err}</div>}
        </div>
      )}
    </div>
  )
}
