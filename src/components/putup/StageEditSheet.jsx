// src/components/putup/StageEditSheet.jsx
// Put-Up release F (06 §3.7, §4 item 6; Dave 15:55: "each stage should allow me to make notes and
// add/edit the information … as we go", including at and after bottling) — tap an entry in the Log and
// change it. PATCH /api/kitchen-batches/:id/stages/:stageId (contract-F §2.3), presence-sentinel: ONLY
// what changed is sent, and the host shows "Saved · Undo" in place, Undo sending back what this sheet
// held. Accepted on a finished batch (06 §3.13).
//
// WHAT EACH ENTRY LETS YOU CHANGE is the route's allowlist, per kind:
//   every entry — the note;
//   a check-in (tended) — when it was, the brine / conditioning answer, what you did, the pH, the top-up;
//   a move — when it was, and where it moved to;
//   a noted entry — when it was;
//   a put-up — "Made ___ g in all" and "Mash in ___ g";
//   the start — "About ___ in it".
// An entry's kind, and when a start or put-up happened, never change here (the start's date is the
// batch's own, set on the batch; a put-up's is its jars'). A void row, or a row that was undone, is
// note-only (and is not in the Log anyway). Required at open: 0 (the census).
//
// WHEN (Dave: stage dates editable; contract-F §2.3 takes entered_at + entered_precision on tended,
// moved and noted) is asked with the SAME chips as Start a batch — Today · Yesterday · Earlier… · Not
// sure, the estimate windows under Earlier… — so one answer means one thing. The chip the stored date
// reads as is shown selected; the date is sent ONLY once a chip or the date is touched, as a pair.
//
// ⚠ Record, never assess: the pH is taken as typed through the shared PhReadingField and nothing reads
// it back into a decision.
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { P } from '../../lib/constants.js'
import { T } from '../../lib/tokens.js'
import { useApiFetch } from '../../lib/api.js'
import { describeRefusal } from '../../lib/putUpErrors.js'
import Sheet from '../forms/Sheet.jsx'
import Button from '../forms/Button.jsx'
import SelectChip from '../forms/SelectChip.jsx'
import { labelChrome, optionalMarkChrome, inputChrome, textareaChrome } from '../forms/formStyles.js'
import PhReadingField from './PhReadingField.jsx'
import { useFieldsClearOfFooter } from '../kitchen/sheetScroll.js'
import { SheetStartChips, resolveSheetStart, START_ERRORS } from '../kitchen/StartChips.jsx'
import { SUBMERSION_ANSWERS, CONDITIONING_ANSWERS, CHECK_IN_ACTS, TOP_UP_UNITS, phReadingText, PH_SCALE_HINT } from './goingNow.js'
import { estimateChips } from './putItUp.js'
import { ABOUT_UNITS } from './JarHeatRow.jsx'

const FOOTER_PX = 76
const eq = (a, b) => {
  if (a == null && b == null) return true
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
  const na = Number(a); const nb = Number(b)
  if (a != null && b != null && String(a).trim() !== '' && String(b).trim() !== '' && Number.isFinite(na) && Number.isFinite(nb)) return na === nb
  return String(a ?? '') === String(b ?? '')
}
const DATE_KEYS = ['entered_at', 'entered_precision']
const instant = (v) => (v == null ? null : new Date(v).getTime())

// What the sheet may send, per stored kind — the route's allowlist (06 §3.7; contract-F §2.3). The date
// pair is offered on a check-in, a move and a noted entry; a start and a put-up keep theirs.
export function editableKeys(stage) {
  if (!stage || stage.stage_kind === 'void' || stage.voided) return ['note']
  switch (stage.stage_kind) {
    case 'tended': return ['note', 'cue_observed', 'acts', 'ph_reading', 'ph_read_at', 'amount', 'amount_unit', ...DATE_KEYS]
    case 'moved': return ['note', 'storage_location_id', ...DATE_KEYS]
    case 'noted': return ['note', ...DATE_KEYS]
    case 'put_up': return ['note', 'amount', 'mash_in_g']
    case 'started': return ['note', 'amount', 'amount_unit']
    default: return ['note']
  }
}

// The chips a stored date reads as, so the sheet opens on the answer already given: Not sure (no date);
// Today (an exact time today); Yesterday (yesterday, day precision at local midnight — what that chip
// writes); an estimate window whose start and precision it matches; otherwise Pick a date, on its day.
const pad2 = (n) => String(n).padStart(2, '0')
const localYmd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
export function whenSeed(stage, now = new Date()) {
  const p = stage?.entered_precision ?? null
  const at = stage?.entered_at != null ? new Date(stage.entered_at) : null
  if (p === 'unknown' || !at || Number.isNaN(at.getTime())) return { chip: 'unsure', earlier: null, pickedDate: '' }
  const day = localYmd(at)
  const yesterday = new Date(now.getTime()); yesterday.setHours(0, 0, 0, 0); yesterday.setDate(yesterday.getDate() - 1)
  if ((p === 'exact' || p === 'hour') && day === localYmd(now)) return { chip: 'today', earlier: null, pickedDate: '' }
  if (p === 'day' && at.getTime() === yesterday.getTime()) return { chip: 'yesterday', earlier: null, pickedDate: '' }
  const win = estimateChips(now).find(w => w.id !== 'pickdate' && w.precision === p && w.start?.getTime() === at.getTime())
  if (win) return { chip: 'earlier', earlier: win.id, pickedDate: '' }
  return { chip: 'earlier', earlier: 'pickdate', pickedDate: day }
}
// The shared chips' refusals, said of an entry rather than of a start.
const WHEN_ERRORS = {
  [START_ERRORS.earlier]: 'Pick when it was — or tap Not sure.',
  [START_ERRORS.pickdate]: 'Pick the date it was — or tap Not sure.',
  [START_ERRORS.future]: START_ERRORS.future,
}

// { patch, undo, changed } — ONLY what differs from the stored row; pairs travel together.
export function stagePatch(stored, next, { nowIso }) {
  const keys = editableKeys(stored)
  const patch = {}
  const undo = {}
  for (const k of keys) {
    if (!(k in next) || DATE_KEYS.includes(k)) continue
    if (!eq(stored?.[k] ?? null, next[k] ?? null)) { patch[k] = next[k] ?? null; undo[k] = stored?.[k] ?? null }
  }
  // The date travels as a pair (the route refuses one alone) and is compared as an instant, so the same
  // moment in another spelling is not a change.
  // THE UNDO NAMES A PRECISION EVEN WHEN THE ROW HAS NONE (review I-N1). Every 1a-era row, and every
  // check-in or move written without one, stores entered_precision NULL — and the PATCH refuses a date
  // without its precision, so "Saved · Undo" sent back {entered_at, null} and got a 400 on exactly those
  // rows. A stored date with no word was stamped when it was written: 'exact'. No date is 'unknown'
  // (chk_ksl_entered_pairing: entered_at IS NULL ⇔ precision 'unknown'), so both branches are legal.
  if (keys.includes('entered_at') && ('entered_at' in next || 'entered_precision' in next)) {
    if (instant(stored.entered_at) !== instant(next.entered_at) || (stored.entered_precision ?? null) !== (next.entered_precision ?? null)) {
      patch.entered_at = next.entered_at ?? null; patch.entered_precision = next.entered_precision ?? null
      undo.entered_at = stored.entered_at ?? null
      undo.entered_precision = stored.entered_precision ?? (stored.entered_at != null ? 'exact' : 'unknown')
    }
  }
  // amount + amount_unit edit together (tended, started); a put-up's Made is always grams, no unit.
  if (stored.stage_kind !== 'put_up' && ('amount' in patch || 'amount_unit' in patch)) {
    patch.amount = next.amount ?? null; patch.amount_unit = next.amount != null ? (next.amount_unit ?? null) : null
    undo.amount = stored.amount ?? null; undo.amount_unit = stored.amount_unit ?? null
  }
  // A pH travels with the time it was read: the stored time if there was one, else now (the route
  // refuses a reading without it, and refuses a time in the future or before the batch started).
  if ('ph_reading' in patch || 'ph_read_at' in patch) {
    patch.ph_reading = next.ph_reading ?? null
    patch.ph_read_at = next.ph_reading != null ? (stored.ph_read_at ?? nowIso) : null
    undo.ph_reading = stored.ph_reading ?? null; undo.ph_read_at = stored.ph_read_at ?? null
  }
  return { patch, undo, changed: Object.keys(patch).length > 0 }
}

export default function StageEditSheet({ open, batch, stage, places = null, onClose, onSaved, now }) {
  if (!open || !stage || !batch) return null
  return <StageEditOpen key={stage.id} batch={batch} stage={stage} places={places} onClose={onClose} onSaved={onSaved} now={now} />
}

function StageEditOpen({ batch, stage, places: givenPlaces, onClose, onSaved, now }) {
  const { fetch } = useApiFetch()
  const kind = stage.stage_kind
  const keys = editableKeys(stage)
  const ferment = batch.kind === 'ferment'
  const answers = ferment ? SUBMERSION_ANSWERS : batch.kind === 'dehydrate' ? CONDITIONING_ANSWERS : []
  const [note, setNote] = useState(stage.note ?? '')
  const [cue, setCue] = useState(stage.cue_observed ?? null)
  const [acts, setActs] = useState(Array.isArray(stage.acts) ? stage.acts : [])
  const [ph, setPh] = useState(stage.ph_reading != null ? String(stage.ph_reading) : '')
  const [amount, setAmount] = useState(stage.amount != null ? String(Number(stage.amount)) : '')
  const [unit, setUnit] = useState(stage.amount_unit ?? (kind === 'started' ? 'g' : 'ml'))
  const [mash, setMash] = useState(stage.mash_in_g != null ? String(Number(stage.mash_in_g)) : '')
  const [placeId, setPlaceId] = useState(stage.storage_location_id ?? null)
  const [places, setPlaces] = useState(givenPlaces)
  // WHEN, on the shared chips; untouched, it is never sent.
  const dated = keys.includes('entered_at')
  const nowDate = useMemo(() => new Date(now ?? Date.now()), [now])
  const [seedWhen] = useState(() => (dated ? whenSeed(stage, nowDate) : { chip: null, earlier: null, pickedDate: '' }))
  const [whenChip, setWhenChip] = useState(seedWhen.chip)
  const [whenEarlier, setWhenEarlier] = useState(seedWhen.earlier)
  const [whenPicked, setWhenPicked] = useState(seedWhen.pickedDate)
  const [whenTouched, setWhenTouched] = useState(false)
  const touch = (fn) => (v) => { fn(v); setWhenTouched(true); setErr(null) }
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)
  const [phErr, setPhErr] = useState(null)
  const writingRef = useRef(false)
  const footerRef = useRef(null)
  const keepClear = useFieldsClearOfFooter(footerRef)
  const id = useId()

  useEffect(() => {
    if (kind !== 'moved' || places) return undefined
    let alive = true
    Promise.resolve().then(() => fetch('/api/storage-locations'))
      .then(r => { if (alive) setPlaces(Array.isArray(r) ? r : []) })
      .catch(() => { if (alive) setPlaces([]) })
    return () => { alive = false }
  }, [fetch, kind, places])

  const num = (t) => { const s = String(t ?? '').trim().replace(',', '.'); return s === '' ? null : s }

  const save = useCallback(async () => {
    if (writingRef.current) return
    const next = { note: note.trim() || null }
    if (keys.includes('cue_observed')) next.cue_observed = cue
    if (keys.includes('acts')) next.acts = ferment && acts.length ? CHECK_IN_ACTS.map(a => a.value).filter(v => acts.includes(v)) : null
    if (keys.includes('ph_reading') && ferment) {
      const typed = phReadingText(ph)
      if (typed != null && !(Number(typed) >= 0 && Number(typed) <= 14)) { setPhErr(PH_SCALE_HINT); return }
      next.ph_reading = typed
    }
    if (keys.includes('amount')) {
      const a = num(amount)
      if (a != null && !(Number.isFinite(Number(a)) && Number(a) > 0)) { setErr('That amount needs to be a number more than 0.'); return }
      next.amount = a
      if (kind !== 'put_up') next.amount_unit = a != null ? unit : null
    }
    if (keys.includes('mash_in_g')) {
      const m = num(mash)
      if (m != null && !(Number.isFinite(Number(m)) && Number(m) > 0)) { setErr('Mash in needs to be a number more than 0.'); return }
      next.mash_in_g = m
    }
    if (keys.includes('storage_location_id')) next.storage_location_id = placeId
    if (dated && whenTouched) {
      const r = resolveSheetStart({ chip: whenChip, earlier: whenEarlier, pickedDate: whenPicked, now: nowDate })
      if (r.error) { setErr(WHEN_ERRORS[r.error] ?? r.error); return }
      next.entered_at = r.start.started_at
      next.entered_precision = r.start.start_precision
    }
    const { patch, undo, changed } = stagePatch(stage, next, { nowIso: nowDate.toISOString() })
    if (!changed) { onClose?.(); return }
    writingRef.current = true
    setSaving(true); setErr(null); setPhErr(null)
    try {
      const answer = await fetch(`/api/kitchen-batches/${batch.id}/stages/${stage.id}`, { method: 'PATCH', body: JSON.stringify(patch) })
      writingRef.current = false
      setSaving(false)
      onSaved?.({ stage: { ...stage, ...patch, ...(answer?.stage ?? {}), id: stage.id }, patch, undo })
    } catch (e) {
      writingRef.current = false
      setSaving(false)
      setErr(describeRefusal(e)?.text ?? 'Couldn’t save that — try again. What you changed is still here.')
    }
  }, [acts, amount, batch.id, cue, dated, fetch, ferment, keys, kind, mash, note, nowDate, onClose, onSaved, ph, placeId, stage, unit,
    whenChip, whenEarlier, whenPicked, whenTouched])

  const title = kind === 'put_up' ? 'This put-up' : kind === 'started' ? 'The start' : kind === 'moved' ? 'This move' : 'This entry'
  return (
    <Sheet open onClose={onClose} title={title} size="full" busy={saving} armsBack>
      <div data-testid="stage-edit" data-stage-id={stage.id} data-kind={kind} onFocus={keepClear} style={{ padding: '0 18px' }}>
        {dated && (
          <div style={{ marginBottom: T.space.md }}>
            <SheetStartChips idPrefix="stage-edit-when" label="When was this?" dateLabel="The date it was" now={nowDate}
              value={whenChip} disabled={saving}
              onChange={touch(v => { setWhenChip(v); if (v !== 'earlier') { setWhenEarlier(null); setWhenPicked('') } })}
              earlier={whenEarlier} onEarlierChange={touch(v => { setWhenEarlier(v); if (v !== 'pickdate') setWhenPicked('') })}
              pickedDate={whenPicked} onPickedDateChange={touch(setWhenPicked)} />
          </div>
        )}
        {keys.includes('cue_observed') && answers.length > 0 && (
          <div style={{ marginBottom: T.space.md }}>
            <span style={labelChrome} aria-hidden="true">{ferment ? 'Is everything still under the brine?' : 'Conditioning'}<span style={optionalMarkChrome}>optional</span></span>
            <div role="group" aria-label="Answer" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {answers.map(a => (
                <SelectChip key={a.value} touch active={cue === a.label} disabled={saving} data-testid={`stage-edit-cue-${a.value}`}
                  onClick={() => setCue(cue === a.label ? null : a.label)}>{a.label}</SelectChip>
              ))}
            </div>
          </div>
        )}
        {keys.includes('acts') && ferment && (
          <div style={{ marginBottom: T.space.md }}>
            <span style={labelChrome} aria-hidden="true">What you did<span style={optionalMarkChrome}>optional</span></span>
            <div role="group" aria-label="What you did" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {CHECK_IN_ACTS.map(a => {
                const on = acts.includes(a.value)
                return (
                  <button key={a.value} type="button" aria-pressed={on} disabled={saving} data-testid={`stage-edit-act-${a.value}`}
                    onClick={() => setActs(on ? acts.filter(x => x !== a.value) : [...acts, a.value])}
                    style={{ minHeight: T.buttonMinHeight, padding: '8px 14px', borderRadius: T.radiusPill, cursor: 'pointer', fontFamily: 'inherit',
                      fontSize: T.type.sm2, fontWeight: on ? 700 : 600, border: `${on ? 2 : 1}px solid ${on ? P.green : P.border}`,
                      background: on ? P.greenPale : P.white, color: on ? P.green : P.dark }}>{a.label}</button>
                )
              })}
            </div>
          </div>
        )}
        {keys.includes('ph_reading') && ferment && (
          <div style={{ marginBottom: T.space.md }}>
            <PhReadingField value={ph} onChange={v => { setPh(v); setPhErr(null) }} error={phErr} disabled={saving}
              idPrefix="stage-edit-ph" inputStyle={{ scrollMarginBottom: FOOTER_PX }} />
          </div>
        )}
        {keys.includes('amount') && (
          <div style={{ marginBottom: T.space.md }}>
            <label htmlFor={`${id}-amount`} style={labelChrome}>
              {kind === 'put_up' ? 'Made ___ g in all' : kind === 'started' ? 'About ___ in it' : 'Topped up with'}
              <span style={optionalMarkChrome}>optional</span>
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <input id={`${id}-amount`} data-testid="stage-edit-amount" type="text" inputMode="decimal" value={amount} disabled={saving}
                onChange={e => { setAmount(e.target.value); setErr(null) }} style={{ ...inputChrome(false), width: 96, scrollMarginBottom: FOOTER_PX }} />
              {kind !== 'put_up' && (
                <div role="radiogroup" aria-label="Unit" style={{ display: 'flex', gap: 6 }}>
                  {(kind === 'started' ? ABOUT_UNITS : TOP_UP_UNITS).map(u => (
                    <SelectChip key={u} touch role="radio" aria-checked={unit === u} aria-pressed={undefined} active={unit === u}
                      disabled={saving} data-testid={`stage-edit-unit-${u}`} onClick={() => setUnit(u)}>{u}</SelectChip>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
        {keys.includes('mash_in_g') && ferment && (
          <div style={{ marginBottom: T.space.md }}>
            <label htmlFor={`${id}-mash`} style={labelChrome}>Mash in ___ g<span style={optionalMarkChrome}>optional</span></label>
            <input id={`${id}-mash`} data-testid="stage-edit-mash" type="text" inputMode="decimal" value={mash} disabled={saving}
              onChange={e => { setMash(e.target.value); setErr(null) }} style={{ ...inputChrome(false), width: 96, scrollMarginBottom: FOOTER_PX }} />
          </div>
        )}
        {keys.includes('storage_location_id') && Array.isArray(places) && places.length > 0 && (
          <div style={{ marginBottom: T.space.md }}>
            <span style={labelChrome} aria-hidden="true">Moved to</span>
            <div role="radiogroup" aria-label="Moved to" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {places.map(p => (
                <SelectChip key={p.id} touch role="radio" aria-checked={placeId === p.id} aria-pressed={undefined} active={placeId === p.id}
                  disabled={saving} data-testid={`stage-edit-place-${p.id}`} onClick={() => setPlaceId(p.id)}>{p.label}</SelectChip>
              ))}
            </div>
          </div>
        )}
        <div style={{ marginBottom: T.space.sm }}>
          <label htmlFor={`${id}-note`} style={labelChrome}>Note<span style={optionalMarkChrome}>optional</span></label>
          <textarea id={`${id}-note`} data-testid="stage-edit-note" rows={3} value={note} disabled={saving}
            onChange={e => { setNote(e.target.value); setErr(null) }}
            style={{ ...textareaChrome(false), minHeight: 72, scrollMarginBottom: FOOTER_PX }} />
          <div style={{ color: P.light, fontSize: '0.74rem', marginTop: 2 }}>Film, bubbling, smell, taste — whatever you noticed goes here.</div>
        </div>
        {err && <div role="alert" data-testid="stage-edit-error" style={{ marginBottom: T.space.sm, color: P.terra, fontSize: T.type.sm, fontWeight: 600 }}>{err}</div>}
      </div>
      <div ref={footerRef} style={{ position: 'sticky', bottom: 0, background: P.white, padding: `${T.space.sm}px 18px`, borderTop: `1px solid ${P.border}` }}>
        <Button data-testid="stage-edit-save" variant="primary" loading={saving} loadingLabel="Saving…" onClick={save} style={{ width: '100%' }}>Save</Button>
      </div>
    </Sheet>
  )
}
