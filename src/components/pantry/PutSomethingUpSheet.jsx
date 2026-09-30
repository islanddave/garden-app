// src/components/pantry/PutSomethingUpSheet.jsx
// Put-Up B′ release 2 (V4 §2.2 "Put something up", §3.1, §6.3–§6.6) — the one page-level door that adds
// ONE thing to the Pantry per save.
//
// Required at open: 3 — What is it? (the shipped name search) · Where does it live? (place chips) ·
// How was it put up? (method chips that fit the place + As is + More…; nothing preselected). Save is
// NEVER disabled: tapped with no method it moves focus to the method row with one line (V4 §2.2).
// How many (a stepper starting at 1) appears once a method is chosen; the rest sits under More (when,
// discard by, notes).
//
// THE WRITE, by the method chip (V4 §2.1's one table rule): a method → POST /api/preservation (the 1b
// create; a template place is made first); As is / Fresh, as picked → POST /api/pantry/items (a planting
// hit keeps plant_id and crop). One key per draft, minted when the sheet first becomes dirty, kept in the
// draft and reused on every retry (V4 §5.2, §6.5). Before Save, one role=status line previews the date it
// uses and the discard-by with its basis (the shared engine, putItUp.previewDiscard).
//
// <Sheet armsBack>; `busy` while writing; the draft (kitchen/sheetDraft.js, sheet 'putsomethingup') keeps
// what was typed across Android Back and a deploy reload; the reload gate is held while dirty or saving.
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { P } from '../../lib/constants.js'
import { T } from '../../lib/tokens.js'
import { useApiFetch } from '../../lib/api.js'
import { setReloadBlocked } from '../../lib/reloadGate.js'
import RefusalLine, { refusalOf } from './RefusalLine.jsx'
import { createPantryItem, ensurePlaceId } from '../../lib/pantryApi.js'
import Sheet from '../forms/Sheet.jsx'
import Button from '../forms/Button.jsx'
import SelectChip from '../forms/SelectChip.jsx'
import { labelChrome } from '../forms/formStyles.js'
import { readSheetDraft, writeSheetDraft, clearSheetDraft } from '../kitchen/sheetDraft.js'
import { useSheetDraftKey } from '../kitchen/useSheetDraftKey.js'
import { mintKey } from '../kitchen/idempotencyKey.js'
import { placeChips, estimateChips } from '../putup/putItUp.js'
import NameSearchField from './NameSearchField.jsx'
import Stepper, { stepperCount } from './Stepper.jsx'
import { PlaceChipRow, MethodRow, DiscardChoice, focusFirstRadio } from './DoorParts.jsx'
import {
  AS_IS, DOOR_TITLE, DOOR_SHEET, METHOD_REQUIRED_TEXT, methodChoices, routeFor, saveLabel, doorWhen,
  previewLine, doorError, jarBody, itemBody,
} from './putSomethingUp.js'

const WHEN_CHIPS = [{ id: 'today', label: 'Today' }, { id: 'yesterday', label: 'Yesterday' }, { id: 'earlier', label: 'Earlier…' }]

// The draft's shape, checked on read (sheetDraft.js: a record that fails is dropped, never half-restored).
export function isDoorDraft(d) {
  return !!d && typeof d === 'object'
    && (d.key == null || typeof d.key === 'string')
    && (d.what == null || (typeof d.what === 'object' && typeof d.what.name === 'string'))
    && (d.method == null || typeof d.method === 'string')
    && typeof d.count === 'string'
    && (d.place == null || (typeof d.place === 'object' && typeof d.place.key === 'string'))
}

export default function PutSomethingUpSheet({ open, onClose, onSaved, initialName = '', initialWhat = null, stockRows = null, now }) {
  if (!open) return null
  return <DoorOpen onClose={onClose} onSaved={onSaved} initialName={initialName} initialWhat={initialWhat}
    stockRows={stockRows} now={now} />
}

function DoorOpen({ onClose, onSaved, initialName, initialWhat, stockRows, now }) {
  const { fetch } = useApiFetch()
  const nowDate = useMemo(() => new Date(now ?? Date.now()), [now])
  const draftKey = useSheetDraftKey(DOOR_SHEET, 'new')
  // A door opened WITH a What (a search's "Put something up: <text> →", a planting's door) is a fresh
  // intent and wins over an older draft, the rule every prefill door on this page follows.
  const seeded = !!(initialWhat || String(initialName ?? '').trim())
  const [initial] = useState(() => (seeded ? null : readSheetDraft(draftKey, DOOR_SHEET, isDoorDraft)) ?? {
    key: null, what: initialWhat ?? (initialName ? { source: 'typed', name: String(initialName) } : null),
    place: null, method: null, count: '1', whenChip: 'today', estimate: null, pickedDate: '',
    discard: { mode: 'auto', date: '' }, notes: '',
  })
  const [key, setKey] = useState(initial.key)
  const [what, setWhat] = useState(initial.what)
  const [place, setPlace] = useState(initial.place)
  const [method, setMethod] = useState(initial.method)
  const [count, setCount] = useState(initial.count)
  const [whenChip, setWhenChip] = useState(initial.whenChip ?? 'today')
  const [estimate, setEstimate] = useState(initial.estimate ?? null)
  const [pickedDate, setPickedDate] = useState(initial.pickedDate ?? '')
  const [discard, setDiscard] = useState(initial.discard ?? { mode: 'auto', date: '' })
  const [notes, setNotes] = useState(initial.notes ?? '')
  const [moreOpen, setMoreOpen] = useState(false)
  const [places, setPlaces] = useState(null)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)
  const [field, setField] = useState(null)
  const writingRef = useRef(false)
  // Set once a save lands: the draft is cleared then, and nothing may write it back before the door
  // unmounts (a render between the clear and the close would otherwise re-stash a spent draft).
  const savedRef = useRef(false)
  const methodRef = useRef(null)
  const whatRef = useRef(null)
  const notesId = `door-notes-${useId()}`

  useEffect(() => {
    let alive = true
    Promise.resolve().then(() => fetch('/api/storage-locations'))
      .then(r => { if (alive) setPlaces(Array.isArray(r) ? r : []) })
      .catch(() => { if (alive) setPlaces([]) })
    return () => { alive = false }
  }, [fetch])
  const chips = useMemo(() => placeChips(places ?? []), [places])

  const choices = useMemo(() => methodChoices({ placeKind: place?.kind ?? null, what }), [place, what])
  // A method the new place or What no longer offers (a planting at a freezer drops As is) is cleared,
  // never kept silently.
  useEffect(() => {
    if (method === AS_IS && !choices.asIs) setMethod(null)
  }, [choices, method])

  const dirty = !!(String(what?.name ?? '').trim() || place || method || count !== '1' || notes.trim()
    || discard.mode !== 'auto' || whenChip !== 'today')
  useEffect(() => { if (dirty && !key) setKey(mintKey()) }, [dirty, key])
  useEffect(() => {
    if (!draftKey || savedRef.current) return
    if (dirty) writeSheetDraft(draftKey, DOOR_SHEET, { key, what, place, method, count, whenChip, estimate, pickedDate, discard, notes })
    else clearSheetDraft(draftKey)
  }, [draftKey, dirty, key, what, place, method, count, whenChip, estimate, pickedDate, discard, notes])

  const holdReload = dirty || saving
  const gateKey = `put-something-up:${useId()}`
  useEffect(() => {
    setReloadBlocked(gateKey, holdReload)
    return () => setReloadBlocked(gateKey, false)
  }, [gateKey, holdReload])

  const w = doorWhen({ chip: whenChip, estimate, pickedDate, now: nowDate })
  const preview = w.when ? previewLine({ method, place, when: w.when, discard, now: nowDate }) : null

  const save = useCallback(async () => {
    if (writingRef.current) return
    const e = doorError({ what, place, method, discard })
    if (e) {
      setErr(e.error); setField(e.field)
      if (e.field === 'method') focusFirstRadio(methodRef)
      else if (e.field === 'what') whatRef.current?.focus?.()
      else if (e.field === 'discard') setMoreOpen(true)
      return
    }
    if (w.error) { setErr(w.error); setField('when'); setMoreOpen(true); return }
    const useKey = key || mintKey()
    if (!key) setKey(useKey)
    writingRef.current = true
    setSaving(true); setErr(null); setField(null)
    const route = routeFor(method)
    try {
      let saved
      if (route === 'jar') {
        const storageLocationId = await ensurePlaceId(fetch, place)
        saved = await fetch('/api/preservation', { method: 'POST', body: JSON.stringify(jarBody({
          key: useKey, what, storageLocationId, method, when: w.when, count: stepperCount(count), discard, notes,
        })) })
      } else {
        const r = await createPantryItem(fetch, itemBody({ key: useKey, what, place, when: w.when, discard, notes }))
        saved = r?.item ?? r
      }
      savedRef.current = true
      clearSheetDraft(draftKey)
      writingRef.current = false
      setSaving(false)
      onSaved?.({ route, saved, place, what })
    } catch (ex) {
      writingRef.current = false
      setSaving(false)
      setErr(refusalOf(ex, "Couldn't save it — nothing was lost. Try again."))
    }
  }, [count, discard, draftKey, fetch, key, method, notes, onSaved, place, w, what])

  const name = String(what?.name ?? '').trim() || 'this'
  return (
    <Sheet open onClose={onClose} title={DOOR_TITLE} size="full" busy={saving} armsBack>
      <div data-testid="door-sheet" style={{ padding: '0 18px', display: 'flex', flexDirection: 'column', gap: T.space.md }}>
        <NameSearchField value={what} onChange={v => { setWhat(v); if (field === 'what') { setErr(null); setField(null) } }}
          fetch={fetch} stockRows={stockRows} idPrefix="door-what" invalid={field === 'what'} inputRef={whatRef} disabled={saving} />
        <PlaceChipRow chips={chips} value={place} idPrefix="door" disabled={saving} invalid={field === 'where'}
          onChange={c => { setPlace(c); if (field === 'where') { setErr(null); setField(null) } }} />
        <MethodRow choices={choices} value={method} what={what} idPrefix="door" disabled={saving} invalid={field === 'method'}
          groupRef={methodRef} onChange={m => { setMethod(m); if (field === 'method') { setErr(null); setField(null) } }} />
        {field === 'method' && (
          <div role="alert" data-testid="door-method-required" style={{ color: P.terra, fontSize: T.type.sm, fontWeight: 600 }}>
            {METHOD_REQUIRED_TEXT}
          </div>
        )}
        {method && method !== AS_IS && (
          <div>
            <span style={labelChrome} aria-hidden="true">How many?</span>
            <Stepper value={count} onChange={setCount} name={name} idPrefix="door-count" disabled={saving} />
          </div>
        )}

        <button type="button" aria-expanded={moreOpen} data-testid="door-more" onClick={() => setMoreOpen(o => !o)}
          style={{ alignSelf: 'flex-start', minHeight: 48, background: 'none', border: 'none', padding: 0, color: P.green,
            fontWeight: 600, fontFamily: 'inherit', fontSize: T.type.sm, cursor: 'pointer' }}>
          <span aria-hidden="true">{moreOpen ? '▾ ' : '▸ '}</span>More
        </button>
        {moreOpen && (
          <div data-testid="door-more-panel" style={{ display: 'flex', flexDirection: 'column', gap: T.space.md }}>
            <div>
              <span style={labelChrome} aria-hidden="true">When?</span>
              <div role="radiogroup" aria-label="When?" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {WHEN_CHIPS.map(c => (
                  <SelectChip key={c.id} touch active={whenChip === c.id} disabled={saving} role="radio" aria-checked={whenChip === c.id}
                    aria-pressed={undefined} data-testid={`door-when-${c.id}`}
                    onClick={() => { setWhenChip(c.id); if (c.id !== 'earlier') { setEstimate(null); setPickedDate('') } }}>{c.label}</SelectChip>
                ))}
              </div>
              {whenChip === 'earlier' && (
                <div role="radiogroup" aria-label="Roughly when?" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                  {estimateChips(nowDate).map(c => (
                    <SelectChip key={c.id} touch active={estimate === c.id} disabled={saving} role="radio" aria-checked={estimate === c.id}
                      aria-pressed={undefined} data-testid={`door-when-${c.id}`} onClick={() => setEstimate(c.id)}>{c.label}</SelectChip>
                  ))}
                </div>
              )}
              {whenChip === 'earlier' && estimate === 'pickdate' && (
                <input type="date" aria-label="The day" data-testid="door-when-date" value={pickedDate} disabled={saving}
                  onChange={e => setPickedDate(e.target.value)} style={{ marginTop: 8, minHeight: 44 }} />
              )}
            </div>
            <DiscardChoice value={discard} onChange={setDiscard} idPrefix="door" itemMode={method === AS_IS} disabled={saving} />
            <div>
              <label htmlFor={notesId} style={labelChrome}>Notes</label>
              <textarea id={notesId} data-testid="door-notes" value={notes} disabled={saving} onChange={e => setNotes(e.target.value)}
                style={{ width: '100%', minHeight: 60, fontFamily: 'inherit', fontSize: T.type.base }} />
            </div>
          </div>
        )}

        {preview && (
          <p role="status" data-testid="door-preview" style={{ margin: 0, color: P.mid, fontSize: T.type.sm }}>{preview}</p>
        )}
        {field !== 'method' && <RefusalLine err={err} testId="door-error" />}
      </div>
      <div style={{ position: 'sticky', bottom: 0, background: P.white, padding: `${T.space.sm}px 18px`, borderTop: `1px solid ${P.border}` }}>
        <Button data-testid="door-save" variant="primary" loading={saving} loadingLabel="Saving…" onClick={save} style={{ width: '100%' }}>
          {saveLabel(method, what)}
        </Button>
      </div>
    </Sheet>
  )
}
