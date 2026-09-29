// src/components/putup/LineSheet.jsx
// Put-Up release F (06 §4 item 3, §3.7, §3.11; contract-F §2.2) — tap a line in What went in and edit it,
// or take it out. Every stage and every line is editable, including after the batch is finished (Dave
// 15:55, 06 §3.13).
//
// WHAT CAN CHANGE is the line PATCH's allowlist: the name, the amount (as a pair), the form, the listed
// heat, the brand, where from, the note, and — on a typed line only — whether it is the water. What
// the line IS (a pick, a draw from a jar, a planting) never changes here: take it out and add it again.
// A weighed draw keeps its amount in a mass unit (the server moves the bag's grams by the difference).
// Save sends ONLY what changed; the host shows "Saved · Undo" in place, and Undo sends back the values
// this sheet held (06 UX-I6). No timer anywhere.
//
// Required at open: 0 (the census). <Sheet armsBack>; the draft survives Back; busy while writing.
import React, { useCallback, useEffect, useId, useRef, useState } from 'react'
import { P } from '../../lib/constants.js'
import { T } from '../../lib/tokens.js'
import { useApiFetch } from '../../lib/api.js'
import { setReloadBlocked } from '../../lib/reloadGate.js'
import { describeRefusal } from '../../lib/putUpErrors.js'
import Sheet from '../forms/Sheet.jsx'
import Button from '../forms/Button.jsx'
import SelectChip from '../forms/SelectChip.jsx'
import { labelChrome, optionalMarkChrome, inputChrome } from '../forms/formStyles.js'
import { readSheetDraft, writeSheetDraft, clearSheetDraft } from '../kitchen/sheetDraft.js'
import { useSheetDraftKey } from '../kitchen/useSheetDraftKey.js'
import { useFieldsClearOfFooter } from '../kitchen/sheetScroll.js'
import { linePatch, QUICK_UNITS, DRIED_NOTE } from './lines.js'
import { KITCHEN_FORMS, FORM_LABELS, parseRating, ratingWords, saltLineWords } from './fermentMath.js'

export const LINE_SHEET = 'line'
const MASS_CHIPS = ['g', 'oz', 'lb', 'kg']
const FOOTER_PX = 76

function seedOf(line) {
  return {
    label: line.label ?? '', qty: line.qty != null ? String(Number(line.qty)) : '', unit: line.qty_unit ?? null,
    form: line.form ?? null, rating: line.shu_rating_low != null ? ratingWords(line.shu_rating_low, line.shu_rating_high).replace(/ SHU$/, '').replace(/,/g, '') : '',
    brand: line.brand ?? '', sourceLabel: line.source_label ?? '', note: line.note ?? '', water: line.role === 'water',
  }
}
function isShape(d) {
  return !!d && typeof d === 'object' && typeof d.label === 'string' && typeof d.qty === 'string'
    && typeof d.note === 'string' && typeof d.water === 'boolean'
}

export default function LineSheet({ open, batchId, line, weighed = false, onClose, onSaved, onTakenOut }) {
  if (!open || !line) return null
  return <LineSheetOpen key={line.id} batchId={batchId} line={line} weighed={weighed} onClose={onClose} onSaved={onSaved} onTakenOut={onTakenOut} />
}

function LineSheetOpen({ batchId, line, weighed, onClose, onSaved, onTakenOut }) {
  const { fetch } = useApiFetch()
  const draftKey = useSheetDraftKey(LINE_SHEET, line.id)
  const [seed] = useState(() => seedOf(line))
  const [v, setV] = useState(() => ({ ...seed, ...(readSheetDraft(draftKey, LINE_SHEET, isShape) ?? {}) }))
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)
  const writingRef = useRef(false)
  const footerRef = useRef(null)
  const keepClear = useFieldsClearOfFooter(footerRef)
  const id = useId()
  const isSalt = line.role === 'salt'
  const typed = line.input_kind === 'other' || line.input_kind === 'purchased'
  const roleLine = isSalt || v.water

  const dirty = JSON.stringify(v) !== JSON.stringify(seed)
  useEffect(() => {
    if (!draftKey) return
    if (dirty) writeSheetDraft(draftKey, LINE_SHEET, v); else clearSheetDraft(draftKey)
  }, [draftKey, dirty, v])
  const gateKey = `line-sheet:${useId()}`
  const hold = dirty || saving
  useEffect(() => { setReloadBlocked(gateKey, hold); return () => setReloadBlocked(gateKey, false) }, [gateKey, hold])

  const set = (patch) => { setV(x => ({ ...x, ...patch })); setErr(null) }

  const save = useCallback(async () => {
    if (writingRef.current) return
    const next = {}
    const label = v.label.trim()
    if (label !== (line.label ?? '')) {
      if (!label && line.input_kind !== 'harvest') { setErr('Give it a name.'); return }
      next.label = label || null
    }
    const qtyText = v.qty.trim().replace(',', '.')
    if (qtyText !== '' && !(Number.isFinite(Number(qtyText)) && Number(qtyText) > 0)) { setErr('That amount needs to be a number more than 0.'); return }
    if (qtyText !== '' && !v.unit) { setErr(`Pick a unit for ${qtyText}`); return }
    if (weighed && (qtyText === '' || !MASS_CHIPS.includes(v.unit))) { setErr('That one is weighed — give it in g, oz, lb or kg.'); return }
    next.qty = qtyText === '' ? null : qtyText
    next.qty_unit = qtyText === '' ? null : v.unit
    if (!roleLine) {
      next.form = v.form
      const r = parseRating(v.rating)
      if (r?.error) { setErr(r.error); return }
      next.shu_rating_low = r ? r.low : null
      next.shu_rating_high = r ? r.high : null
    }
    next.brand = v.brand.trim() || null
    next.source_label = v.sourceLabel.trim() || null
    next.note = v.note.trim() || null
    if (typed && !isSalt) next.role = v.water ? 'water' : null
    // A line becoming the water takes no form or heat (chk_kbi_form_not_on_role and its twin).
    if (next.role === 'water') { next.form = null; next.shu_rating_low = null; next.shu_rating_high = null }
    const { patch, undo, changed } = linePatch(line, next)
    if (!changed) { clearSheetDraft(draftKey); onClose?.(); return }
    writingRef.current = true
    setSaving(true); setErr(null)
    try {
      const answer = await fetch(`/api/kitchen-batches/${batchId}/inputs/${line.id}`, { method: 'PATCH', body: JSON.stringify(patch) })
      clearSheetDraft(draftKey)
      writingRef.current = false
      setSaving(false)
      onSaved?.({ line: { ...line, ...patch, ...(answer?.input ?? {}), id: line.id }, patch, undo })
    } catch (e) {
      writingRef.current = false
      setSaving(false)
      setErr(describeRefusal(e)?.text ?? "Couldn't save that — try again. What you changed is still here.")
    }
  }, [batchId, draftKey, fetch, isSalt, line, onClose, onSaved, roleLine, typed, v, weighed])

  const takeOut = useCallback(async () => {
    if (writingRef.current) return
    writingRef.current = true
    setSaving(true); setErr(null)
    try {
      const answer = await fetch(`/api/kitchen-batches/${batchId}/inputs/${line.id}`, { method: 'DELETE' })
      clearSheetDraft(draftKey)
      writingRef.current = false
      setSaving(false)
      onTakenOut?.({ line, answer })
    } catch (e) {
      writingRef.current = false
      setSaving(false)
      setErr(describeRefusal(e)?.text ?? "Couldn't take it out — try again.")
    }
  }, [batchId, draftKey, fetch, line, onTakenOut])

  const units = weighed ? MASS_CHIPS : (isSalt ? ['g'] : QUICK_UNITS)
  const field = (key, labelText, props = {}) => (
    <div style={{ marginBottom: T.space.sm }}>
      <label htmlFor={`${id}-${key}`} style={labelChrome}>{labelText}<span style={optionalMarkChrome}>optional</span></label>
      <input id={`${id}-${key}`} data-testid={`line-sheet-${key}`} type="text" value={v[key]} disabled={saving}
        onChange={e => set({ [key]: e.target.value })} style={{ ...inputChrome(false), scrollMarginBottom: FOOTER_PX }} {...props} />
    </div>
  )

  return (
    <Sheet open onClose={onClose} title={line.label || 'What went in'} size="full" busy={saving} armsBack>
      <div data-testid="line-sheet" data-line-id={line.id} onFocus={keepClear} style={{ padding: '0 18px' }}>
        {isSalt && (
          <p data-testid="line-sheet-salt" style={{ margin: '0 0 10px', color: P.mid, fontSize: '0.82rem' }}>{saltLineWords(line)}</p>
        )}
        {field('label', 'Name', { maxLength: 120 })}
        <div style={{ marginBottom: T.space.sm }}>
          <label htmlFor={`${id}-qty`} style={labelChrome}>{weighed ? 'How many g went in' : 'How much'}<span style={optionalMarkChrome}>{weighed ? '' : 'optional'}</span></label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <input id={`${id}-qty`} data-testid="line-sheet-qty" type="text" inputMode="decimal" value={v.qty} disabled={saving}
              onChange={e => set({ qty: e.target.value })} style={{ ...inputChrome(false), width: 96, scrollMarginBottom: FOOTER_PX }} />
            <div role="radiogroup" aria-label="Unit" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {[...new Set([...units, ...(v.unit && !units.includes(v.unit) ? [v.unit] : [])])].map(u => (
                <SelectChip key={u} touch role="radio" aria-checked={v.unit === u} aria-pressed={undefined} active={v.unit === u}
                  disabled={saving} data-testid={`line-sheet-unit-${u}`} onClick={() => set({ unit: u })}>{u}</SelectChip>
              ))}
            </div>
          </div>
        </div>
        {typed && !isSalt && (
          <div role="group" aria-label="Water" style={{ marginBottom: T.space.sm }}>
            <SelectChip touch active={v.water} disabled={saving} data-testid="line-sheet-water"
              onClick={() => set({ water: !v.water })}>This is the water</SelectChip>
            <div style={{ marginTop: 4, color: P.light, fontSize: '0.74rem' }}>Water counts at 1 g per ml; other liquids count only by weight.</div>
          </div>
        )}
        {!roleLine && (
          <>
            <span style={labelChrome} aria-hidden="true">Form<span style={optionalMarkChrome}>optional</span></span>
            <div role="group" aria-label="Form" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: T.space.sm }}>
              {KITCHEN_FORMS.map(f => (
                <SelectChip key={f} touch active={v.form === f} disabled={saving} data-testid={`line-sheet-form-${f}`}
                  onClick={() => set({ form: v.form === f ? null : f })}>{FORM_LABELS[f]}</SelectChip>
              ))}
            </div>
            <div style={{ marginBottom: T.space.sm }}>
              <label htmlFor={`${id}-rating`} style={labelChrome}>Listed heat (SHU)<span style={optionalMarkChrome}>optional</span></label>
              <input id={`${id}-rating`} data-testid="line-sheet-rating" type="text" value={v.rating} placeholder="e.g. 2500–8000"
                disabled={saving} onChange={e => set({ rating: e.target.value })} style={{ ...inputChrome(false), width: 180, scrollMarginBottom: FOOTER_PX }} />
              <div style={{ marginTop: 4, color: P.light, fontSize: '0.74rem' }}>
                The fresh pepper’s rating{v.form === 'dried' ? ` — ${DRIED_NOTE}` : ''}. Type 0 for a sweet pepper.
              </div>
            </div>
          </>
        )}
        {field('brand', 'Brand', { maxLength: 120 })}
        {field('sourceLabel', 'Where from', { maxLength: 120 })}
        {field('note', 'Note')}
        {err && <div role="alert" data-testid="line-sheet-error" style={{ marginBottom: T.space.sm, color: P.terra, fontSize: T.type.sm, fontWeight: 600 }}>{err}</div>}
        <button type="button" data-testid="line-sheet-take-out" disabled={saving} onClick={takeOut}
          style={{ minHeight: 48, background: 'none', border: 'none', padding: '4px 0', color: P.terra, cursor: 'pointer',
            fontFamily: 'inherit', fontSize: T.type.sm, fontWeight: 600, marginBottom: T.space.md }}>
          Take it out
        </button>
      </div>
      <div ref={footerRef} style={{ position: 'sticky', bottom: 0, background: P.white, padding: `${T.space.sm}px 18px`, borderTop: `1px solid ${P.border}` }}>
        <Button data-testid="line-sheet-save" variant="primary" loading={saving} loadingLabel="Saving…" onClick={save} style={{ width: '100%' }}>Save</Button>
      </div>
    </Sheet>
  )
}
