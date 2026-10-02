// src/components/pantry/PlacesSheet.jsx
// Put-Up R2a (lane P) — the Pantry's Places sheet: rename a place, change what kind of place it is, delete
// one that holds nothing. Opened by "Edit places" on the Pantry's Group-by row.
//
// THE LIST is the places read (GET /api/storage-locations), read when the sheet opens — an EMPTY place
// included: it has no heading on the Pantry, and a mistyped place is usually exactly that. Under each name:
// its kind's word, then how many things are stored there, counted from the UNFILTERED Pantry rows the host
// hands in (`rows`; never the list on screen, which Use soon may have narrowed). Until those rows have
// answered (`rows` null) nothing is said about the count and no Delete is offered.
//
// FLAT, on purpose. Edit opens UNDER its row; Delete's second step is inline. There is no sub-state for the
// sheet's Back to step out of (no backIntercept): Back, and Escape on the list, close the sheet from any
// state, and nothing here pushes history. One row is open at a time. No pinned footer: Save sits in the
// editor, so the browser's own scroll-to-field is enough with the keyboard up.
//
// EDIT sends ONLY WHAT CHANGED. The server refuses a change of KIND while the place holds put-ups whose
// dates were worked out for its kind; a body with no `kind` cannot meet that refusal, so a rename always
// saves. A stored kind outside the six is drawn as its own chosen chip and is never sent unless another is
// picked: opening a place to fix a typo must not re-file it.
//
// THE TWO REFUSALS are built here from the answer's code and `n` (lib/putUpErrors.js holds no words for
// them): a re-kind refused says how many put-ups and which kind, in two lines, with the kind's word read
// from putup/placeKinds.js; a delete refused (something was stored there since this sheet's count) says the
// server's own sentence, and the Pantry is re-read so the count catches up.
//
// IN PLACE, no timer, no toast: "Saved." on the row after a save, 'Deleted "<name>".' where the row was.
// Testids keep the form's `pu-location-*` family (the two are never mounted together).
import React, { useCallback, useEffect, useId, useRef, useState } from 'react'
import { P } from '../../lib/constants.js'
import { T } from '../../lib/tokens.js'
import { REFUSAL_CODES } from '../../lib/putUpErrors.js'
import { listPlaces, updatePlace, deletePlace } from '../../lib/pantryApi.js'
import Sheet from '../forms/Sheet.jsx'
import Button from '../forms/Button.jsx'
import SelectChip from '../forms/SelectChip.jsx'
import { labelChrome, inputChrome } from '../forms/formStyles.js'
import { PLACE_KINDS, placeKindLabel } from '../putup/placeKinds.js'
import RefusalLine, { refusalOf } from './RefusalLine.jsx'

export const EDIT_PLACES_LABEL = 'Edit places'
export const PLACES_TITLE = 'Places'
export const PLACE_KIND_QUESTION = 'What kind of place?'
export const PLACE_NAME_REQUIRED_TEXT = 'Give the place a name.'
export const PLACE_NAME_TAKEN_TEXT = 'You already have a place with that name and kind. Use a different name.'
export const PLACE_SAVED_TEXT = 'Saved.'
export const NO_PLACES_TEXT = 'No places yet. A place is made the first time you put something in it.'
export const PLACES_LOAD_FAILED_TEXT = "Couldn't load your places."
export const PLACE_SAVE_FAILED_TEXT = "Couldn't save that — try again."
export const PLACE_DELETE_FAILED_TEXT = "Couldn't delete that — try again."
// The length "＋ Somewhere else" allows a new place's name (DoorParts.PlaceChipRow, PutItUpSheet's PlacePicker).
const PLACE_NAME_MAX = 60

// How many things the Pantry lists in this place: put-ups and bought items alike, one per row. `rows` is the
// UNFILTERED list; null (not answered yet) is "not known", never zero.
export function storedIn(rows, placeId) {
  if (!Array.isArray(rows)) return null
  return rows.filter(r => r?.place?.id != null && String(r.place.id) === String(placeId)).length
}
export function storedWords(n) {
  return n === 0 ? 'nothing stored here' : `${n} stored here`
}
// In Delete's position on a place that holds something.
export function storedBlocksDeleteWords(n) {
  return `${storedWords(n)} — move ${n === 1 ? 'it' : 'them'} to delete this place.`
}
// The kind's word as it is said inside a sentence, from the ONE list of kinds; a stored kind outside the
// list is said as it is stored.
export function kindWords(kind) {
  return placeKindLabel(kind) ?? String(kind ?? '')
}
export function deleteQuestion(label) {
  return `Delete "${label}"? Nothing is stored there. It stops being offered as a place.`
}
export function deletedWords(label) {
  return `Deleted "${label}".`
}
// The re-kind refusal, from the ANSWER's count — never a count made here, and never the server's sentence
// (which is written for a bundle that has no words of its own). `kind` is the kind the place IS.
export function rekindRefusedLines(n, kind) {
  const word = kindWords(kind).toLowerCase()
  return n === 1
    ? [`Can't change the kind: 1 put-up here has a date worked out for this kind of place (${word}).`,
      'Set its date by hand from Edit, or move it somewhere else, then change the kind.']
    : [`Can't change the kind: ${n} put-ups here have dates worked out for this kind of place (${word}).`,
      'Set those dates by hand from Edit, or move them somewhere else, then change the kind.']
}
// The `n` of a place refusal, or null when the answer carried none it can count with.
function refusalCount(e) {
  const n = e?.body?.n
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null
}
const codeOf = (e) => (typeof e?.body?.code === 'string' ? e.body.code : null)

const quiet = {
  minHeight: T.buttonMinHeight, minWidth: 48, background: 'none', border: 'none', padding: '0 6px', color: P.green,
  fontWeight: 700, fontFamily: 'inherit', fontSize: T.type.sm, textDecoration: 'underline', cursor: 'pointer',
}

// `rows`: the Pantry's unfiltered rows (null until the list has answered). `onChanged()`: something the
// Pantry list shows changed (a save; a delete the server refused), re-read it. `onPlaces(list)`: the live
// places as this sheet now knows them, for the host's door.
export default function PlacesSheet({ open, onClose, fetch, rows = null, onChanged = null, onPlaces = null }) {
  if (!open) return null
  return <PlacesOpen onClose={onClose} fetch={fetch} rows={rows} onChanged={onChanged} onPlaces={onPlaces} />
}

function PlacesOpen({ onClose, fetch, rows, onChanged, onPlaces }) {
  // The list as it is drawn: live places, and a place deleted in this sitting kept where it was as
  // { id, deleted: its name }.
  const [list, setList] = useState(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [confirmingId, setConfirmingId] = useState(null)
  const [name, setName] = useState('')
  const [kind, setKind] = useState(null)
  const [busy, setBusy] = useState(false)
  // What the open row says went wrong: a string or refusalOf's { text, refresh }, or the re-kind refusal's
  // two lines as { lines }. `errId` is the row it belongs to.
  const [err, setErr] = useState(null)
  const [errId, setErrId] = useState(null)
  const [savedId, setSavedId] = useState(null)
  const writingRef = useRef(false)
  const base = useId()
  const nameRef = useRef(null)
  const editorRef = useRef(null)
  // Where focus goes once an editor or a confirm closes: the row's own Edit…, or the line a deleted row left.
  const focusAfterRef = useRef(null)
  const rowRefs = useRef(new Map())

  const onPlacesRef = useRef(onPlaces)
  useEffect(() => { onPlacesRef.current = onPlaces }, [onPlaces])
  const publish = useCallback((next) => {
    setList(next)
    onPlacesRef.current?.(next.filter(p => !p.deleted))
  }, [])

  const load = useCallback(() => {
    let alive = true
    setLoadFailed(false)
    Promise.resolve().then(() => listPlaces(fetch))
      .then(r => { if (alive) publish(r) })
      .catch(() => { if (alive) setLoadFailed(true) })
    return () => { alive = false }
  }, [fetch, publish])
  useEffect(() => load(), [load])

  // Edit opens with its top at the top of the panel, so the name, the kinds and Save are all on screen with
  // the keyboard up; the name takes focus (the row's Edit… has just left the screen).
  useEffect(() => {
    if (editingId == null) return
    const el = editorRef.current
    nameRef.current?.focus({ preventScroll: true })
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'start' })
  }, [editingId])
  useEffect(() => {
    const id = focusAfterRef.current
    if (id == null || editingId != null || confirmingId != null) return
    focusAfterRef.current = null
    rowRefs.current.get(String(id))?.focus()
  }, [editingId, confirmingId, list])

  const clearRow = () => { setErr(null); setErrId(null) }
  function startEdit(place) {
    if (busy) return
    clearRow(); setSavedId(null); setConfirmingId(null)
    setName(String(place.label ?? ''))
    setKind(place.kind ?? null)
    setEditingId(place.id)
  }
  function cancelEdit(place) {
    if (busy) return
    clearRow()
    focusAfterRef.current = place.id
    setEditingId(null)
  }
  function startDelete(place) {
    if (busy) return
    clearRow(); setSavedId(null); setEditingId(null)
    setConfirmingId(place.id)
  }
  function cancelDelete(place) {
    if (busy) return
    focusAfterRef.current = place.id
    setConfirmingId(null)
  }

  async function save(place) {
    if (writingRef.current) return
    const trimmed = name.trim()
    if (!trimmed) { setErr(PLACE_NAME_REQUIRED_TEXT); setErrId(place.id); nameRef.current?.focus(); return }
    const patch = {}
    if (trimmed !== String(place.label ?? '')) patch.label = trimmed
    if (kind !== (place.kind ?? null)) patch.kind = kind
    if (!Object.keys(patch).length) { cancelEdit(place); return }
    writingRef.current = true
    setBusy(true); clearRow()
    try {
      const row = await updatePlace(fetch, place.id, patch)
      const next = { ...place, ...patch, ...(row && typeof row === 'object' ? row : {}), id: place.id }
      publish((list ?? []).map(p => (String(p.id) === String(place.id) ? next : p)))
      focusAfterRef.current = place.id
      setEditingId(null)
      setSavedId(place.id)
      onChanged?.()
    } catch (e) {
      const code = codeOf(e)
      const n = refusalCount(e)
      if (code === REFUSAL_CODES.PLACE_HAS_DATED_JARS && n != null) setErr({ lines: rekindRefusedLines(n, place.kind) })
      else if (code === REFUSAL_CODES.PLACE_EXISTS) setErr(PLACE_NAME_TAKEN_TEXT)
      else setErr(refusalOf(e, PLACE_SAVE_FAILED_TEXT))
      setErrId(place.id)
    } finally {
      writingRef.current = false
      setBusy(false)
    }
  }

  async function remove(place) {
    if (writingRef.current) return
    writingRef.current = true
    setBusy(true); clearRow()
    try {
      await deletePlace(fetch, place.id)
      focusAfterRef.current = place.id
      setConfirmingId(null)
      publish((list ?? []).map(p => (String(p.id) === String(place.id) ? { id: place.id, deleted: String(place.label ?? '') } : p)))
    } catch (e) {
      setErr(refusalOf(e, PLACE_DELETE_FAILED_TEXT))
      setErrId(place.id)
      setConfirmingId(null)
      // Something is stored there that this sheet's count did not know of: the Pantry is re-read, the
      // count catches up and Delete… leaves the row.
      if (codeOf(e) === REFUSAL_CODES.PLACE_IN_USE) onChanged?.()
    } finally {
      writingRef.current = false
      setBusy(false)
    }
  }

  const editing = editingId != null ? (list ?? []).find(p => String(p.id) === String(editingId)) : null
  const dirty = !!editing && (name !== String(editing.label ?? '') || kind !== (editing.kind ?? null))

  return (
    <Sheet open onClose={onClose} title={PLACES_TITLE} size="full" armsBack dirty={dirty} busy={busy}>
      <div data-testid="places-sheet" style={{ padding: '0 18px 18px' }}>
        {list == null && !loadFailed && <div style={{ padding: 16, color: P.light }}>Loading&hellip;</div>}
        {loadFailed && (
          <div role="alert" data-testid="places-load-failed" style={{ color: P.terra, fontSize: T.type.sm, fontWeight: 600 }}>
            {PLACES_LOAD_FAILED_TEXT}{' '}
            <button type="button" data-testid="places-retry" onClick={load} style={{ ...quiet, color: 'inherit' }}>Try again</button>
          </div>
        )}
        {list != null && list.length === 0 && (
          <p data-testid="places-empty" style={{ margin: 0, color: P.mid, fontSize: T.type.sm }}>{NO_PLACES_TEXT}</p>
        )}
        {list != null && list.length > 0 && (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {list.map(place => {
              const id = String(place.id)
              if (place.deleted != null) {
                return (
                  <li key={id} style={{ padding: '14px 0', borderTop: `1px solid ${P.cream}` }}>
                    <div data-testid="pu-location-deleted" data-loc-id={id} role="status" tabIndex={-1}
                      ref={el => { if (el) rowRefs.current.set(id, el); else rowRefs.current.delete(id) }}
                      style={{ color: P.mid, fontSize: T.type.sm, outline: 'none' }}>
                      {deletedWords(place.deleted)}
                    </div>
                  </li>
                )
              }
              const isEditing = String(editingId) === id
              const isConfirming = String(confirmingId) === id
              const stored = storedIn(rows, place.id)
              const rowErr = String(errId) === id ? err : null
              return (
                <li key={id} data-testid="pu-location-row" data-loc-id={id} style={{ padding: '8px 0', borderTop: `1px solid ${P.cream}` }}>
                  <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: T.space.sm }}>
                    <div style={{ flex: '1 1 160px', minWidth: 0 }}>
                      <div style={{ fontWeight: 600, color: P.dark, overflowWrap: 'anywhere' }}>{place.label}</div>
                      <div data-testid="pu-location-detail" style={{ fontSize: T.type.sm, color: P.mid }}>
                        {[kindWords(place.kind), stored != null ? storedWords(stored) : null].filter(Boolean).join(' · ')}
                      </div>
                    </div>
                    {!isEditing && (
                      <button type="button" data-testid="pu-location-rename" disabled={busy} onClick={() => startEdit(place)}
                        ref={el => { if (el) rowRefs.current.set(id, el); else rowRefs.current.delete(id) }}
                        aria-label={`Edit… — ${place.label}`} style={quiet}>Edit…</button>
                    )}
                    {!isEditing && stored === 0 && (
                      <button type="button" data-testid="pu-location-delete" disabled={busy} onClick={() => startDelete(place)}
                        aria-label={`Delete… — ${place.label}`} style={{ ...quiet, color: P.terra }}>Delete…</button>
                    )}
                    {!isEditing && stored > 0 && (
                      <span data-testid="pu-location-in-use" style={{ flex: '1 1 100%', fontSize: T.type.sm, color: P.mid }}>
                        {storedBlocksDeleteWords(stored)}
                      </span>
                    )}
                  </div>
                  {String(savedId) === id && !isEditing && (
                    <div role="status" data-testid="pu-location-saved" style={{ fontSize: T.type.sm, color: P.green }}>{PLACE_SAVED_TEXT}</div>
                  )}

                  {isEditing && (
                    <div ref={editorRef} data-testid="pu-location-editor" style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 8 }}
                      onKeyDown={e => { if (e.key === 'Escape' && !busy) { e.preventDefault(); e.stopPropagation(); cancelEdit(place) } }}>
                      <div>
                        <label htmlFor={`${base}-name`} style={labelChrome}>Name</label>
                        <input id={`${base}-name`} ref={nameRef} data-testid="pu-location-name" type="text" value={name} disabled={busy}
                          maxLength={PLACE_NAME_MAX} enterKeyHint="done" autoComplete="off"
                          aria-invalid={rowErr === PLACE_NAME_REQUIRED_TEXT || undefined}
                          onChange={e => setName(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() } }}
                          style={{ ...inputChrome(rowErr === PLACE_NAME_REQUIRED_TEXT), width: '100%', minHeight: T.buttonMinHeight }} />
                      </div>
                      <div>
                        <span style={labelChrome} aria-hidden="true">{PLACE_KIND_QUESTION}</span>
                        <div role="radiogroup" aria-label={PLACE_KIND_QUESTION} data-testid="pu-location-kinds"
                          style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                          {[...PLACE_KINDS, ...(place.kind != null && placeKindLabel(place.kind) == null ? [{ kind: place.kind, label: String(place.kind) }] : [])].map(k => (
                            <SelectChip key={k.kind} touch active={kind === k.kind} disabled={busy} role="radio" aria-checked={kind === k.kind}
                              aria-pressed={undefined} data-testid={`pu-location-kind-${k.kind}`} onClick={() => setKind(k.kind)}>{k.label}</SelectChip>
                          ))}
                        </div>
                      </div>
                      <PlaceError err={rowErr} />
                      <div style={{ display: 'flex', gap: 8 }}>
                        <Button variant="primary" data-testid="pu-location-save" loading={busy} loadingLabel="Saving…" onClick={() => save(place)}>Save</Button>
                        <Button variant="secondary" data-testid="pu-location-cancel" disabled={busy} onClick={() => cancelEdit(place)}>Cancel</Button>
                      </div>
                    </div>
                  )}

                  {isConfirming && !isEditing && (
                    <div data-testid="pu-location-confirm-delete" style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 8 }}>
                      <span data-testid="pu-location-delete-consequence" style={{ fontSize: T.type.sm, color: P.mid }}>{deleteQuestion(place.label)}</span>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <Button variant="danger" data-testid="pu-location-delete-confirm" loading={busy} loadingLabel="Deleting…" onClick={() => remove(place)}>Yes, delete</Button>
                        <Button variant="secondary" data-testid="pu-location-delete-cancel" disabled={busy} onClick={() => cancelDelete(place)}>Keep it</Button>
                      </div>
                    </div>
                  )}
                  {!isEditing && <PlaceError err={rowErr} />}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Sheet>
  )
}

// A row's refusal. The re-kind refusal is two lines: what was refused (said to a reader's software as an
// alert), then the two ways out.
function PlaceError({ err }) {
  if (!err) return null
  if (err.lines) {
    return (
      <div data-testid="pu-location-refusal">
        <div role="alert" data-testid="pu-location-error" style={{ color: P.terra, fontSize: T.type.sm, fontWeight: 600 }}>{err.lines[0]}</div>
        <div data-testid="pu-location-refusal-next" style={{ color: P.mid, fontSize: T.type.sm, marginTop: 2 }}>{err.lines[1]}</div>
      </div>
    )
  }
  return <RefusalLine err={err} testId="pu-location-error" />
}
