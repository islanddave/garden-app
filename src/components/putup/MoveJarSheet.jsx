// src/components/putup/MoveJarSheet.jsx
// Put-Up release 1b (V4 §2.5 "Move it", §3.4, §5.1; contract-F §2.6) — the one door that changes where a
// jar lives. From 1b the list row stops echoing its place through the legacy PUT (a differing place
// there is a 409 client_stale), so a move is its own write: POST /api/preservation/:id/move
// {place, when}. The server applies the move rule and stamps storage_moved_at; this panel says what that
// rule will do to THIS jar's date before Save and decides nothing.
//
// Required at open: 1 — the place (V4 §6.3). When starts at Today; Earlier… offers the §3.6 windows.
// A failed write keeps the choice and says why in the server's words (describeRefusal). No draft: two
// taps is the whole of it.
//
// B′ release 2 (the Pantry row sheet): a bought item moves too, by a PATCH of its storage_location_id
// that has no When. `onSubmit({place, when})` replaces the jar's move POST when a host passes it (the
// same chips, the same refusal handling), and `whenless` leaves the When rows out.
//
// Put-Up UX pass R1: A PANEL INSIDE THE ROW SHEET, like Edit and Gave it away — not a sheet of its own.
// A second sheet swapped in over the row sheet took the row sheet's Back entry with it, so the Back after
// a cancelled move left the page. As a panel it rides the row sheet's one entry: Back here returns to the
// row's action list (PantryRowSheet's backIntercept). The file keeps its path and its default export.
// `onBusyChange(saving)` tells the host sheet a write is in flight, so Back and the backdrop wait for it.
// `onMoved({ saved, place })` hands back what the write answered and the place that was tapped.
//
// THE RULE LINE says nothing until a destination is tapped, then what happens to this jar's date — from
// the jar's STORED basis and the two place kinds (moveRule below, the server's own rule). No date, no line.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { P, T } from '../../lib/tokens.js'
import { useApiFetch } from '../../lib/api.js'
import { describeRefusal } from '../../lib/putUpErrors.js'
import Button from '../forms/Button.jsx'
import SelectChip from '../forms/SelectChip.jsx'
import { labelChrome, requiredMarkChrome, inputChrome } from '../forms/formStyles.js'
import { placeChips, estimateChips, resolveWhen } from './putItUp.js'

export const MOVE_TITLE = 'Move it'
export const MOVE_RULE_TEXT = Object.freeze({
  stays: 'Its discard date stays.',
  clears: 'Its discard date was worked out for where it is now, so it clears with this move. You can set a new one after.',
  reworked: 'Its discard date is worked out again from the day it moves.',
})

// What a move to a place of kind `toKind` does to a discard date — a key of MOVE_RULE_TEXT, or null for
// "say nothing". THE SERVER'S RULE, mirrored branch for branch (lambda/preservation/jarRoutes.js moveUseBy):
// the same kind of place → the date stays; a typed date, or a row written before a basis was stored
// (`basis` null: its provenance is unknown, so the server treats it as typed) → stays; a house estimate
// (candied) → worked out again from the move day; anything else (the general figure, a recipe's) →
// cleared. `basis` is the STORED one, never the row's display fallback: a legacy candied row reads "house
// estimate" on the Pantry and still keeps its date on a move. A jar with no date has nothing to say.
export function moveRule({ date = null, basis = null, fromKind = null, toKind = null } = {}) {
  if (!date) return null
  if ((fromKind ?? null) === (toKind ?? null)) return 'stays'
  if (basis == null || basis === 'typed') return 'stays'
  if (basis === 'house') return 'reworked'
  return 'clears'
}

const MOVE_WHEN = [{ id: 'today', label: 'Today' }, { id: 'yesterday', label: 'Yesterday' }, { id: 'earlier', label: 'Earlier…' }]

// `jar`: { id, label, storage_location_id, storage_kind?, use_by_target?, use_by_basis? } — the last three
// are what the rule line reads (the place it is in now, and its stored date and basis).
export default function MoveJarSheet({ open, jar, onClose, onMoved, now, onSubmit = null, whenless = false, onBusyChange = null }) {
  if (!open || !jar) return null
  return <MoveOpen key={jar.id} jar={jar} onClose={onClose} onMoved={onMoved} now={now} onSubmit={onSubmit} whenless={whenless}
    onBusyChange={onBusyChange} />
}

function MoveOpen({ jar, onClose, onMoved, now, onSubmit, whenless, onBusyChange }) {
  const { fetch } = useApiFetch()
  const nowDate = useMemo(() => new Date(now ?? Date.now()), [now])
  const [places, setPlaces] = useState(null)
  const [place, setPlace] = useState(null)
  const [chip, setChip] = useState('today')
  const [estimate, setEstimate] = useState(null)
  const [pickedDate, setPickedDate] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)
  const writingRef = useRef(false)

  useEffect(() => {
    let alive = true
    Promise.resolve()
      .then(() => fetch('/api/storage-locations'))
      .then(r => { if (alive) setPlaces(Array.isArray(r) ? r : []) })
      .catch(() => { if (alive) setPlaces([]) })
    return () => { alive = false }
  }, [fetch])

  // The host sheet holds Back and its backdrop while the write is in flight; released if the panel goes.
  useEffect(() => {
    onBusyChange?.(saving)
    return () => { if (saving) onBusyChange?.(false) }
  }, [onBusyChange, saving])

  // The place it is in now is not a destination.
  const chips = useMemo(() => placeChips(places ?? []).filter(c => !c.id || c.id !== String(jar.storage_location_id ?? '')), [places, jar.storage_location_id])

  const save = useCallback(async () => {
    if (writingRef.current) return
    if (!place) { setErr('Where is it going? Pick a place.'); return }
    const w = resolveWhen({ chip, estimate, pickedDate, now: nowDate })
    if (w.error) { setErr(w.error); return }
    writingRef.current = true
    setSaving(true); setErr(null)
    try {
      const saved = onSubmit
        ? await onSubmit({ place, when: w.when })
        : await fetch(`/api/preservation/${jar.id}/move`, { method: 'POST', body: JSON.stringify({
          place: place.id ? { id: place.id } : { kind: place.kind, label: place.label }, when: w.when,
        }) })
      writingRef.current = false
      setSaving(false)
      onMoved?.({ saved: saved ?? null, place })
    } catch (e) {
      writingRef.current = false
      setSaving(false)
      setErr(describeRefusal(e)?.text ?? "Couldn't move it — try again.")
    }
  }, [chip, estimate, fetch, jar.id, nowDate, onMoved, onSubmit, pickedDate, place])

  const name = jar.label || 'this'
  const rule = place
    ? moveRule({ date: jar.use_by_target ?? null, basis: jar.use_by_basis ?? null, fromKind: jar.storage_kind ?? null, toKind: place.kind ?? null })
    : null
  return (
    <div role="group" aria-label={MOVE_TITLE} data-testid="move-panel" data-jar-id={jar.id} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div>
        <span style={labelChrome} aria-hidden="true">Where to?<span style={requiredMarkChrome}>*</span></span>
        <div role="radiogroup" aria-label={`Where is ${name} going?`} aria-required="true"
          style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {chips.map(c => (
            <SelectChip key={c.key} touch active={place?.key === c.key} disabled={saving} role="radio"
              aria-checked={place?.key === c.key} aria-pressed={undefined} data-testid={`move-place-${c.key}`}
              onClick={() => { setPlace(c); setErr(null) }}>{c.label}</SelectChip>
          ))}
        </div>
      </div>
      {!whenless && (
        <div>
          <span style={labelChrome} aria-hidden="true">When?</span>
          <div role="radiogroup" aria-label="When did it move?" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {MOVE_WHEN.map(c => (
              <SelectChip key={c.id} touch active={chip === c.id} disabled={saving} role="radio" aria-checked={chip === c.id}
                aria-pressed={undefined} data-testid={`move-when-${c.id}`}
                onClick={() => { setChip(c.id); if (c.id !== 'earlier') { setEstimate(null); setPickedDate('') } setErr(null) }}>{c.label}</SelectChip>
            ))}
          </div>
          {chip === 'earlier' && (
            <div role="radiogroup" aria-label="Roughly when?" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
              {estimateChips(nowDate).map(c => (
                <SelectChip key={c.id} touch active={estimate === c.id} disabled={saving} role="radio" aria-checked={estimate === c.id}
                  aria-pressed={undefined} data-testid={`move-when-${c.id}`}
                  onClick={() => { setEstimate(c.id); setErr(null) }}>{c.label}</SelectChip>
              ))}
            </div>
          )}
          {chip === 'earlier' && estimate === 'pickdate' && (
            <input type="date" aria-label="The day it moved" data-testid="move-when-date" value={pickedDate} disabled={saving}
              onChange={e => { setPickedDate(e.target.value); setErr(null) }}
              style={{ ...inputChrome(false), maxWidth: 220, marginTop: 8, minHeight: T.buttonMinHeight }} />
          )}
        </div>
      )}
      {/* Always in the tree, so a reader's software hears the line when a tap fills it; empty, it takes no room. */}
      <p role="status" data-testid="move-rule" style={{ margin: 0, color: P.mid, fontSize: T.type.sm }}>{rule ? MOVE_RULE_TEXT[rule] : ''}</p>
      {err && <div role="alert" data-testid="move-error" style={{ color: P.terra, fontSize: T.type.sm, fontWeight: 600 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button data-testid="move-save" variant="primary" loading={saving} loadingLabel="Moving…" onClick={save}>
          {place ? `Move to ${place.label}` : 'Move it'}
        </Button>
        <Button variant="secondary" data-testid="move-cancel" onClick={onClose} disabled={saving}>Cancel</Button>
      </div>
    </div>
  )
}
