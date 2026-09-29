// src/components/putup/CheckOnItSheet.jsx
// Put-Up 1a item 3 (V4 §2.3 "Check on it", §6.2–§6.6) — looking at a batch, and writing down what you
// saw. Every kind: Moved it (the household's places) and a note. Ferment: also the ruled brine
// question (All under · Something poking out) and the pH field. Dry (not Candy): also "In jars to
// condition" · "Condensation → back in the dryer".
//
// ONE SAVE, ONE ROW (goingNow.js checkInBody): a `tended` row, or a `moved` row when a place was
// picked, through the shipped POST /:id/stages. It is the same row kind the card's questions are
// answered by, so the shipped brine/pH/stall clocks clear exactly as they always have, and the card's
// "last touched" line moves. The sheet saves on its Save button — never on a chip tap — and there is
// no Undo in 1a (V4 §2.3: "Saved · Undo" arrives with void rows in 1b). A check-in carries no
// idempotency key in 1a (V4 §5.2); the synchronous `writingRef` plus Sheet `busy` refuse a second
// Save while the first is in flight, and `busy` also refuses Back and the backdrop mid-write.
//
// ⚠ THE LINE, inherited from PhReadingField and binding here: record, prompt, link — never derive,
// score, colour, gate or compare a reading. The answers are stored as the words the cook tapped, in
// cue_observed, and nothing reads them back into a decision. No failure-sign checklist is offered
// beside the brine question, for the reason SUBMERSION_PROMPT's header gives.
//
// <Sheet armsBack>: Android Back closes the sheet and the DRAFT SURVIVES (kitchen/sheetDraft.js,
// keyed per person per batch, 24 h). confirmOnDirty stays OFF — the draft is what protects the input,
// so there is nothing to ask. The reload gate is held while anything is typed or a write is in flight.
//
// Mounted by the PAGE-LEVEL GoingNowView once, never per card: one check-in is open at a time.
import React, { useCallback, useEffect, useId, useRef, useState } from 'react'
import { P, T } from '../../lib/tokens.js'
import { useApiFetch } from '../../lib/api.js'
import { setReloadBlocked } from '../../lib/reloadGate.js'
import Sheet from '../forms/Sheet.jsx'
import Button from '../forms/Button.jsx'
import SelectChip from '../forms/SelectChip.jsx'
import { labelChrome, optionalMarkChrome, textareaChrome } from '../forms/formStyles.js'
import PhReadingField from './PhReadingField.jsx'
import { useSheetDraftKey, readSheetDraft, writeSheetDraft, clearSheetDraft } from '../kitchen/sheetDraft.js'
import {
  CHECK_ON_IT_CTA, SUBMERSION_PROMPT, SUBMERSION_ANSWERS, CONDITIONING_ANSWERS, PH_SCALE_HINT,
  checkInFields, checkInBody,
} from './goingNow.js'

export const CHECK_IN_SHEET = 'checkin'
export const CHECK_IN_HINT = 'One thing is enough — an answer, a reading, a place or a note.'
// The sticky footer's height. Every field carries it as scroll-margin-bottom, so focusing a field
// scrolls it clear of the pinned Save rather than under it.
const FOOTER_PX = 76

const EMPTY = { ph: '', submersion: null, conditioning: null, placeId: null, note: '' }

// The draft's shape, checked on read: a record that fails any arm is dropped, never half-restored.
export function isCheckInDraft(d) {
  return !!d && typeof d === 'object' && !Array.isArray(d)
    && typeof d.ph === 'string' && typeof d.note === 'string'
    && (d.submersion === null || SUBMERSION_ANSWERS.some(a => a.value === d.submersion))
    && (d.conditioning === null || CONDITIONING_ANSWERS.some(a => a.value === d.conditioning))
    && (d.placeId === null || typeof d.placeId === 'string')
}

// An OPTIONAL single-select: role="group" + aria-pressed (V4 §6.4), 48px touch chips, 8px gaps. A
// second tap on the chosen chip un-chooses it, so an answer tapped by mistake is not a trap.
function ChipAnswers({ label, answers, value, onChange, disabled, idPrefix }) {
  return (
    <div style={{ marginBottom: T.space.md }}>
      <span style={labelChrome} aria-hidden="true">
        {label}<span style={optionalMarkChrome}>optional</span>
      </span>
      <div role="group" aria-label={label} style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {answers.map(a => (
          <SelectChip key={a.value} touch active={value === a.value} disabled={disabled}
            data-testid={`${idPrefix}-${a.value}`}
            onClick={() => onChange(value === a.value ? null : a.value)}>
            {a.label}
          </SelectChip>
        ))}
      </div>
    </div>
  )
}

export default function CheckOnItSheet({ open, batch, onClose, onSaved, now }) {
  if (!open || !batch) return null
  // Keyed on the batch so a switch from one crock straight to another can never carry state across.
  return <CheckOnItOpen key={batch.id} batch={batch} onClose={onClose} onSaved={onSaved} now={now} />
}

function CheckOnItOpen({ batch, onClose, onSaved, now }) {
  const { fetch } = useApiFetch()
  const fields = checkInFields(batch)
  const draftKey = useSheetDraftKey(CHECK_IN_SHEET, batch.id)
  // Read ONCE, at open. The draft is written back on every change below, so the first commit must
  // already hold the restored values — a write effect that ran over the pristine state first would
  // clear the very draft it was about to restore.
  const [initial] = useState(() => readSheetDraft(draftKey, CHECK_IN_SHEET, isCheckInDraft) ?? EMPTY)
  const [ph, setPh] = useState(initial.ph)
  const [submersion, setSubmersion] = useState(initial.submersion)
  const [conditioning, setConditioning] = useState(initial.conditioning)
  const [placeId, setPlaceId] = useState(initial.placeId)
  const [note, setNote] = useState(initial.note)
  const [places, setPlaces] = useState(null)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)
  const [phErr, setPhErr] = useState(null)
  // Synchronous exclusion. `saving` disables Save only after React commits; two taps inside one frame
  // would both read it false, and a check-in is not keyed in 1a, so both would land as two rows.
  const writingRef = useRef(false)
  const noteId = `checkin-note-${useId()}`
  const hintId = `checkin-hint-${useId()}`

  // Started inside a promise chain, so a synchronous throw from the fetch layer lands in the catch
  // below as "no places" rather than taking the sheet down.
  useEffect(() => {
    let alive = true
    Promise.resolve()
      .then(() => fetch('/api/storage-locations'))
      .then(rows => { if (alive) setPlaces(Array.isArray(rows) ? rows : []) })
      .catch(() => { if (alive) setPlaces([]) })
    return () => { alive = false }
  }, [fetch])

  // A restored place that no longer exists is dropped rather than sent: the server would refuse it.
  useEffect(() => {
    if (places && placeId && !places.some(p => p.id === placeId)) setPlaceId(null)
  }, [places, placeId])

  const dirty = ph.trim() !== '' || submersion != null || conditioning != null || placeId != null || note.trim() !== ''

  useEffect(() => {
    if (!draftKey) return
    if (dirty) writeSheetDraft(draftKey, CHECK_IN_SHEET, { ph, submersion, conditioning, placeId, note })
    else clearSheetDraft(draftKey)
  }, [draftKey, dirty, ph, submersion, conditioning, placeId, note])

  // ONE boolean dependency, deliberately: the gate fires a deferred reload on its release transition,
  // so an effect keyed on two values would release-and-re-hold (and could reload mid-write) whenever
  // one of them changed under the other.
  const holdReload = dirty || saving
  const gateKey = `checkin-sheet:${useId()}`
  useEffect(() => {
    setReloadBlocked(gateKey, holdReload)
    return () => setReloadBlocked(gateKey, false)
  }, [gateKey, holdReload])

  const save = useCallback(async () => {
    if (writingRef.current) return
    const place = placeId ? (places ?? []).find(p => p.id === placeId) ?? null : null
    const at = new Date(now ?? Date.now()).toISOString()
    const res = checkInBody({ batch, ph, submersion, conditioning, place, note, atIso: at })
    if (res.error) {
      if (res.error === PH_SCALE_HINT) { setPhErr(PH_SCALE_HINT); setErr(null) } else { setErr(res.error); setPhErr(null) }
      return
    }
    writingRef.current = true
    setSaving(true); setErr(null); setPhErr(null)
    try {
      await fetch(`/api/kitchen-batches/${batch.id}/stages`, { method: 'POST', body: JSON.stringify(res.body) })
      clearSheetDraft(draftKey)
      writingRef.current = false
      setSaving(false)
      onSaved?.(res.body)
    } catch {
      // Nothing is cleared: there is no offline queue in this app, so a clear failure that keeps what
      // was noted is the honest answer.
      writingRef.current = false
      setSaving(false)
      setErr("Couldn't save that — try again. What you noted is still here.")
    }
  }, [batch, conditioning, draftKey, fetch, note, now, onSaved, ph, placeId, places, submersion])

  // The "1 observation" required at open (V4 §6.3) rides on the note, because the note is the one
  // observation every kind has: while nothing else is given, the note is what is needed.
  const nothingElse = !(ph.trim() || submersion || conditioning || placeId)

  return (
    <Sheet open onClose={onClose} title={CHECK_ON_IT_CTA} size="full" busy={saving} armsBack>
      <div data-testid="checkin-sheet" data-batch-id={batch.id} style={{ padding: '0 18px' }}>
        <p data-testid="checkin-batch" style={{ margin: '0 0 2px', color: P.mid, fontSize: '0.86rem', fontWeight: 600 }}>
          {batch.label}
        </p>
        <p id={hintId} data-testid="checkin-hint" style={{ margin: `0 0 ${T.space.md}px`, color: P.light, fontSize: '0.78rem' }}>
          {CHECK_IN_HINT}
        </p>

        {/* Chips before any text field, on purpose: the sheet focuses its first control on open,
            and a text field there would put the keyboard over half the sheet before anything is
            asked (the a11y seat's initial-focus finding). */}
        {fields.submersion && (
          <ChipAnswers label={SUBMERSION_PROMPT} answers={SUBMERSION_ANSWERS} value={submersion}
            onChange={v => { setSubmersion(v); setErr(null) }} disabled={saving} idPrefix="checkin-submersion" />
        )}
        {fields.conditioning && (
          <ChipAnswers label="Conditioning" answers={CONDITIONING_ANSWERS} value={conditioning}
            onChange={v => { setConditioning(v); setErr(null) }} disabled={saving} idPrefix="checkin-conditioning" />
        )}
        {fields.ph && (
          <div style={{ marginBottom: T.space.md }}>
            <PhReadingField value={ph} onChange={v => { setPh(v); setPhErr(null); setErr(null) }} error={phErr}
              disabled={saving} inputStyle={{ scrollMarginBottom: FOOTER_PX }} />
          </div>
        )}

        <div style={{ marginBottom: T.space.md }}>
          <span style={labelChrome} aria-hidden="true">
            Moved it<span style={optionalMarkChrome}>optional</span>
          </span>
          {Array.isArray(places) && places.length === 0 && (
            <p data-testid="checkin-no-places" style={{ margin: 0, color: P.light, fontSize: '0.78rem' }}>
              No places saved yet.
            </p>
          )}
          {Array.isArray(places) && places.length > 0 && (
            <div role="group" aria-label="Moved it" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {[...places].sort((a, b) => String(a.label).localeCompare(String(b.label))).map(p => (
                <SelectChip key={p.id} touch active={placeId === p.id} disabled={saving}
                  data-testid={`checkin-place-${p.id}`}
                  onClick={() => { setPlaceId(placeId === p.id ? null : p.id); setErr(null) }}>
                  {p.label}
                </SelectChip>
              ))}
            </div>
          )}
        </div>

        <div style={{ marginBottom: T.space.sm }}>
          <label htmlFor={noteId} style={labelChrome}>Note</label>
          <textarea id={noteId} data-testid="checkin-note" rows={2} value={note} disabled={saving}
            aria-required={nothingElse ? true : undefined} aria-describedby={hintId}
            onChange={e => { setNote(e.target.value); setErr(null) }}
            style={{ ...textareaChrome(false), minHeight: 64, scrollMarginBottom: FOOTER_PX }} />
        </div>

        {err && (
          <div role="alert" data-testid="checkin-error"
            style={{ marginBottom: T.space.sm, color: P.terra, fontSize: T.type.sm, fontWeight: 600 }}>{err}</div>
        )}
      </div>

      {/* Pinned: the Save stays on screen however far the fields scroll, and with the keyboard up it
          sits directly above it (the app's viewport meta resizes content for the keyboard). */}
      <div data-testid="checkin-footer" style={{ position: 'sticky', bottom: 0, background: P.white,
        padding: `${T.space.sm}px 18px`, borderTop: `1px solid ${P.border}` }}>
        <Button data-testid="checkin-save" variant="primary" loading={saving} loadingLabel="Saving…"
          onClick={save} style={{ width: '100%' }}>
          Save
        </Button>
      </div>
    </Sheet>
  )
}
