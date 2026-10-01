// src/components/putup/LikeBatchPicker.jsx
// B′ release 3 — "Like <batch>, except…" (V4 §2.2): a quiet door that lists past batches and, on a tap,
// reads that batch and hands its lines and kind to the host as a draft (likeBatch.js likeDraft). Used by
// Start a batch and by How it was made →. Plain markup; no new visual design.
//
// Props: onPick({ kind, lines, from }) · picked (the current { from, lines } or null) · onClear ·
// exceptId (never offer this batch) · disabled · idPrefix.
//
// Put-Up UX pass R1 (PLAN-V3 D10, "Start from · a past batch") adds two OPTIONAL props, for a host that
// owns the door itself: `open` (a boolean) and `onOpenChange(next)`. With `open` given the picker is
// CONTROLLED: it draws no toggle of its own, lists the batches while `open`, reads them the first time it
// opens, and after a pick calls `onPick` and then `onOpenChange(false)`. What was picked still shows, with
// "Don't copy", and the list can open under it to pick another. With `open` absent nothing here changes:
// How it was made → renders the same door, list and picked line it always has.
import React, { useEffect, useState } from 'react'
import { P, T } from '../../lib/tokens.js'
import { useApiFetch } from '../../lib/api.js'
import SelectChip from '../forms/SelectChip.jsx'
import { mintKey } from '../kitchen/idempotencyKey.js'
import { likeDraft, likeChoices, likeWords } from './likeBatch.js'

// 48px tall (Put-Up UX pass R1, F16: height only — the size and weight are as they were).
const link = {
  display: 'inline-flex', alignItems: 'center', minHeight: T.buttonMinHeight, background: 'none', border: 'none',
  padding: '2px 8px 2px 0', cursor: 'pointer', fontFamily: 'inherit', color: P.green, fontSize: T.type.sm, fontWeight: 600,
}

export default function LikeBatchPicker({
  onPick, picked = null, onClear, exceptId = null, disabled = false, idPrefix = 'like', open: openProp, onOpenChange,
}) {
  const controlled = typeof openProp === 'boolean'
  const { fetch } = useApiFetch()
  const [openState, setOpen] = useState(false)
  const open = controlled ? openProp : openState
  const [choices, setChoices] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  const load = async () => {
    if (!controlled) setOpen(true)
    setErr(null)
    if (choices) return
    try {
      const r = await fetch('/api/kitchen-batches?state=all')
      setChoices(likeChoices(r?.batches, exceptId))
    } catch { setErr("Couldn't load past batches just now.") }
  }
  // Controlled: the host opened the list, so read it now. `load` is left out of the deps on purpose — it
  // is a new function every render, and the read belongs to the list OPENING, not to each repaint (a
  // list that failed to load is read again the next time it is opened).
  useEffect(() => {
    if (controlled && openProp) load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controlled, openProp])

  const choose = async (b) => {
    setBusy(true); setErr(null)
    try {
      const detail = await fetch(`/api/kitchen-batches/${b.id}`)
      onPick?.(likeDraft(detail, mintKey))
      if (controlled) onOpenChange?.(false); else setOpen(false)
    } catch { setErr("Couldn't read that batch just now.") }
    setBusy(false)
  }

  const pickedLine = picked?.from ? (
    <div data-testid={`${idPrefix}-picked`} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', color: P.mid, fontSize: T.type.sm }}>
      <span>{likeWords(picked.from, picked.lines?.length ?? 0)}</span>
      <button type="button" style={{ ...link, fontWeight: 400 }} disabled={disabled}
        data-testid={`${idPrefix}-clear`} onClick={() => onClear?.()}>Don’t copy</button>
    </div>
  ) : null

  const list = open ? (
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
  ) : null

  // The host owns the door: what was picked, then the list while it is open — and nothing at all otherwise.
  if (controlled) {
    if (!pickedLine && !list) return null
    return <div data-testid={idPrefix}>{pickedLine}{list}</div>
  }

  if (pickedLine) return pickedLine

  return (
    <div data-testid={idPrefix}>
      <button type="button" style={link} aria-expanded={open} disabled={disabled} data-testid={`${idPrefix}-open`}
        onClick={() => (open ? setOpen(false) : load())}>
        Like a past batch, except…
        <span style={{ color: P.light, fontWeight: 400, fontSize: '0.78rem', marginLeft: 6 }}>optional</span>
      </button>
      {list}
    </div>
  )
}
