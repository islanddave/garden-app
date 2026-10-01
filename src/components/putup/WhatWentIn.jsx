// src/components/putup/WhatWentIn.jsx
// Put-Up release F — "What went in", reworked (06 §4 item 3; contract-F §2.2). Replaces the shipped
// BatchInputsField as the body of batch detail's section. BatchInputsField is still mounted, but only
// for LEGACY bulk pick rows (the shipped predicate path's "whole pick" rows, ordinal NULL), which keep
// their count-and-reveal; every line written from release F on is always visible here.
//
// TOP TO BOTTOM:
//   · "From the garden: Megatron, Serranos" — AMBIENT, a reward surface under gardening.md's Reward UX
//     rule: words only, no badge, count, sum, %, animation or celebratory copy; the leaf is aria-hidden
//     and the words carry the meaning. Shown only when there is something from the garden.
//   · the lines, one full-width 48px row each with a 1px divider (salt lines live in the Salt block
//     below, not here). Tap → the line sheet. After a Save, "Saved · Undo" in place — no timer, until
//     the next write or navigation. A line taken out stays in the list struck through as
//     "<name> · Taken out · Undo" until navigation (client-held: the server returns only live lines).
//   · quick chips [Water] [Salt] — Water opens the add row prefilled (role water, ml); Salt hands focus
//     to the Salt block's % field and NEVER writes a line by itself (UX-I4).
//   · the add row (LineAdder) — or, on a batch that already has something written down, the door to it.
// The Salt block is the host's (BatchDetailView), rendered between the chips' row and the add row via
// `saltSlot`, so it stays "inside What went in" and always reachable.
//
// THE ADD ROW COLLAPSES, the chips never do (Put-Up UX pass R1, D2). A batch with nothing written down
// opens with the add row shown; one that has lines opens with "+ Add what went in" where the add row
// sits. A tap on that door opens it and focuses the name; a tap on [Water] opens it with the Water preset
// and focuses the amount. WHICH of the two is read ONCE, when this batch's detail first renders here, and
// REMEMBERED: once the add row is open it stays open across every Add and the re-read that follows it.
// Deriving it from the lines on each render would shut the add row under the cook after the first line —
// the ferment walks add several lines in a row and stop at their second (mutation M4).
// `asWrittenSlot` is the host's too: a recipe batch's "Made it as written", shown in the empty block.
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { P } from '../../lib/constants.js'
import { T } from '../../lib/tokens.js'
import { useApiFetch } from '../../lib/api.js'
import { describeRefusal } from '../../lib/putUpErrors.js'
import { mintKey } from '../kitchen/idempotencyKey.js'
import BatchInputsField from './BatchInputsField.jsx'
import LineAdder from './LineAdder.jsx'
import LineSheet from './LineSheet.jsx'
import { lineWords, isLegacyPick, nextOrdinal, addedWords, FROM_GARDEN_WORDS } from './lines.js'
import { isMassUnit } from './fermentMath.js'

const rowBtn = {
  display: 'flex', alignItems: 'center', width: '100%', minHeight: T.buttonMinHeight, padding: '6px 0', background: 'none',
  border: 'none', borderBottom: `1px solid ${P.border}`, textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit',
  fontSize: T.type.sm, color: P.dark,
}
const quiet = {
  display: 'inline-flex', alignItems: 'center', minHeight: T.buttonMinHeight, minWidth: 44, background: 'none', border: 'none',
  padding: '2px 8px', cursor: 'pointer', fontFamily: 'inherit', color: P.green, fontSize: '0.78rem', fontWeight: 600,
}
const chip = {
  minHeight: T.buttonMinHeight, minWidth: 64, padding: '8px 16px', borderRadius: T.radiusPill, border: `1px solid ${P.border}`,
  background: P.white, color: P.dark, fontFamily: 'inherit', fontSize: T.type.sm2, fontWeight: 600, cursor: 'pointer',
}

// The words a garden line wears. The leaf is decoration; the words are the meaning.
export function FromGarden({ testId }) {
  return (
    <span data-testid={testId} style={{ color: P.mid }}>
      {' · '}<span aria-hidden="true">🌿 </span>{FROM_GARDEN_WORDS}
    </span>
  )
}

// A line is a weighed draw when it came from a jar and has no count (the draw moved grams, not a count).
const isWeighedDraw = (l) => l?.input_kind === 'put_up' && l.count_drawn == null && isMassUnit(l.qty_unit)

export default function WhatWentIn({ batch, lines, gardenNames = [], onChanged, saltSlot = null, asWrittenSlot = null, onSaltTap, onLineStart, disabled = false }) {
  const { fetch } = useApiFetch()
  const all = Array.isArray(lines) ? lines : []
  const legacy = all.filter(isLegacyPick)
  // Sitting and row additions (put_up_stage_id set) are said under their put-up in What came out, and
  // salt lines in the Salt block — neither is listed twice.
  const shown = all.filter(l => !isLegacyPick(l) && l.role !== 'salt' && l.put_up_stage_id == null)
  const [sheetFor, setSheetFor] = useState(null)
  const [saved, setSaved] = useState(null)             // { lineId, undo }
  const [takenOut, setTakenOut] = useState([])         // client-held: [{ line }]
  const [status, setStatus] = useState(null)
  const [rowErr, setRowErr] = useState(null)
  const [preset, setPreset] = useState({ seq: 0, value: null })
  const [newId, setNewId] = useState(null)
  // The add row, shown or behind its door. The initialiser is the ONE read of the lines (this component
  // mounts when the batch's detail has loaded, never before); after it the answer only ever goes to open.
  const [adderOpen, setAdderOpen] = useState(() => shown.length === 0 && legacy.length === 0)
  const [nameFocus, setNameFocus] = useState(0)        // bumped by the door: focus the name once it is there
  const writingRef = useRef(false)
  const listRef = useRef(null)
  const adderRef = useRef(null)

  // The new line scrolls into view once the re-read carries it (06 §4 item 3).
  useEffect(() => {
    if (!newId) return
    const el = listRef.current?.querySelector(`[data-line-id="${newId}"]`)
    if (el) { el.scrollIntoView?.({ block: 'nearest' }); setNewId(null) }
  }, [lines, newId])

  // The door's tap lands in the name field (the adder's first input), ready to type.
  useEffect(() => {
    if (nameFocus) adderRef.current?.querySelector('input')?.focus()
  }, [nameFocus])

  const add = useCallback(async (body) => {
    setStatus(null); setRowErr(null)
    try {
      const answer = await fetch(`/api/kitchen-batches/${batch.id}/inputs`, { method: 'POST', body: JSON.stringify({
        inputs: [{ ...body, ordinal: body.ordinal ?? nextOrdinal(all) }],
      }) })
      setStatus(addedWords(body))
      setSaved(null)
      const id = answer?.inputs?.[0]?.id
      if (id) setNewId(id)
      onChanged?.()
      return true
    } catch (e) {
      const r = describeRefusal(e)
      setRowErr(r ? r.text : "Couldn't add that — try again. What you typed is still here.")
      return false
    }
  }, [all, batch.id, fetch, onChanged])

  const undoSave = useCallback(async () => {
    if (!saved || writingRef.current) return
    writingRef.current = true
    try {
      await fetch(`/api/kitchen-batches/${batch.id}/inputs/${saved.lineId}`, { method: 'PATCH', body: JSON.stringify(saved.undo) })
      setSaved(null); setStatus('Put back as it was.')
      onChanged?.()
    } catch (e) {
      setRowErr(describeRefusal(e)?.text ?? "Couldn't undo that — try again.")
    } finally { writingRef.current = false }
  }, [batch.id, fetch, onChanged, saved])

  // Undo a take-out: a soft-deleted line is restored (its draw re-made in the same statement); a pick
  // line was hard-deleted (uq_kbi_batch_harvest), so it is re-added with every stored field under a
  // fresh key (06 §3.11).
  const undoTakeOut = useCallback(async (line) => {
    if (writingRef.current) return
    writingRef.current = true
    setRowErr(null)
    try {
      if (line.input_kind === 'harvest') {
        const body = { input_kind: 'harvest', idempotency_key: mintKey(), harvest_log_id: line.harvest_log_id }
        for (const k of ['label', 'qty', 'qty_unit', 'form', 'brand', 'note', 'source_label', 'shu_rating_low', 'shu_rating_high', 'ordinal', 'plant_id']) {
          if (line[k] != null) body[k] = line[k]
        }
        await fetch(`/api/kitchen-batches/${batch.id}/inputs`, { method: 'POST', body: JSON.stringify({ inputs: [body] }) })
      } else {
        await fetch(`/api/kitchen-batches/${batch.id}/inputs/${line.id}/restore`, { method: 'POST', body: '{}' })
      }
      setTakenOut(t => t.filter(x => x.line.id !== line.id))
      setStatus(`Put back · ${line.label ?? 'it'}`)
      onChanged?.()
    } catch (e) {
      setRowErr(describeRefusal(e)?.text ?? "Couldn't put it back — try again.")
    } finally { writingRef.current = false }
  }, [batch.id, fetch, onChanged])

  const gardenLine = gardenNames.length > 0 && (
    <p data-testid="what-went-in-garden" style={{ margin: '0 0 4px', color: P.mid, fontSize: '0.82rem' }}>
      <span aria-hidden="true">🌿 </span>From the garden: {gardenNames.join(', ')}
    </p>
  )

  return (
    <div data-testid="what-went-in" style={{ marginTop: 4 }}>
      {gardenLine}
      {shown.length === 0 && takenOut.length === 0 && legacy.length === 0 && (
        <p data-testid="what-went-in-empty" style={{ margin: 0, color: P.light, fontSize: T.type.sm }}>Nothing written down yet.</p>
      )}
      {asWrittenSlot}
      <ul ref={listRef} data-testid="what-went-in-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {shown.map(l => (
          <li key={l.id} data-line-id={l.id}>
            <button type="button" style={rowBtn} data-testid={`line-row-${l.id}`} disabled={disabled}
              onClick={() => setSheetFor(l)}>
              <span style={{ flex: 1 }}>
                <span data-testid="line-row-text">{lineWords(l)}</span>
                {l.from_garden === true && <FromGarden testId="line-row-garden" />}
                {l.edited_at && <span style={{ color: P.light }}> · edited</span>}
              </span>
            </button>
            {saved?.lineId === l.id && (
              <div role="status" data-testid="line-saved" style={{ color: P.mid, fontSize: '0.78rem' }}>
                Saved<button type="button" style={quiet} data-testid="line-saved-undo" onClick={undoSave}>Undo</button>
              </div>
            )}
          </li>
        ))}
        {takenOut.map(({ line }) => (
          <li key={`out-${line.id}`} data-testid="line-taken-out" style={{ display: 'flex', alignItems: 'center', minHeight: T.buttonMinHeight,
            borderBottom: `1px solid ${P.border}`, color: P.light, fontSize: T.type.sm }}>
            <span style={{ flex: 1 }}><s>{line.label ?? 'It'}</s> · Taken out</span>
            <button type="button" style={quiet} data-testid={`line-taken-out-undo-${line.id}`} onClick={() => undoTakeOut(line)}>Undo</button>
          </li>
        ))}
      </ul>

      {/* Legacy bulk pick rows keep the shipped count-and-reveal (06 §4 item 3). */}
      {legacy.length > 0 && (
        <BatchInputsField batchId={batch.id} inputs={legacy} onChanged={onChanged} legacyOnly />
      )}

      <div style={{ display: 'flex', gap: 8, margin: `${T.space.sm}px 0 0` }}>
        {/* Water opens the add row when it is behind its door: the adder mounts holding the preset, and
            its own preset step puts the cursor in the amount. */}
        <button type="button" style={chip} data-testid="what-went-in-water" disabled={disabled}
          onClick={() => { setPreset(p => ({ seq: p.seq + 1, value: { role: 'water', label: 'Water' } })); setAdderOpen(true); onLineStart?.() }}>Water</button>
        <button type="button" style={chip} data-testid="what-went-in-salt" disabled={disabled}
          onClick={() => onSaltTap?.()}>Salt</button>
      </div>

      {saltSlot}

      <div ref={adderRef}>
        {adderOpen ? (
          <LineAdder lines={all} onAdd={add} idPrefix="line-add" disabled={disabled}
            preset={preset.value} presetSeq={preset.seq} onStarted={() => { setStatus(null); setSaved(null); onLineStart?.() }} />
        ) : (
          <button type="button" style={{ ...quiet, padding: '2px 8px 2px 0', marginTop: T.space.sm }} data-testid="line-add-open" disabled={disabled}
            onClick={() => { setAdderOpen(true); setNameFocus(n => n + 1); onLineStart?.() }}>
            + Add what went in
          </button>
        )}
      </div>

      {status && <p role="status" data-testid="what-went-in-status" style={{ margin: '6px 0 0', color: P.mid, fontSize: '0.82rem' }}>{status}</p>}
      {rowErr && <p role="alert" data-alarm-ink-exempt="error" data-testid="what-went-in-error" style={{ margin: '6px 0 0', color: P.terra, fontSize: T.type.sm, fontWeight: 600 }}>{rowErr}</p>}

      <LineSheet open={!!sheetFor} batchId={batch.id} line={sheetFor} weighed={isWeighedDraw(sheetFor)}
        onClose={() => setSheetFor(null)}
        onSaved={({ line, undo }) => { setSheetFor(null); setSaved({ lineId: line.id, undo }); setStatus(null); onChanged?.() }}
        onTakenOut={({ line }) => { setSheetFor(null); setTakenOut(t => [...t.filter(x => x.line.id !== line.id), { line }]); setSaved(null); onChanged?.() }} />
    </div>
  )
}
