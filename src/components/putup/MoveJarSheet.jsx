// src/components/putup/MoveJarSheet.jsx
// Put-Up release 1b (V4 §2.5 "Move it", §3.4, §5.1; contract-F §2.6) — the one door that changes where a
// jar lives. From 1b the list row stops echoing its place through the legacy PUT (a differing place
// there is a 409 client_stale), so a move is its own write: POST /api/preservation/:id/move
// {place, when}. The server applies the move rule (a non-typed date is cleared, a house date re-derives
// from the move day) and stamps storage_moved_at; this sheet says so before Save and decides nothing.
//
// Required at open: 1 — the place (V4 §6.3). When starts at Today; Earlier… offers the §3.6 windows.
// <Sheet armsBack>, busy while writing; a failed write keeps the choice and says why in the server's
// words (describeRefusal). No draft: two taps is the whole of it.
//
// B′ release 2 (the Pantry row sheet): a bought item moves too, by a PATCH of its storage_location_id
// that has no When. `onSubmit({place, when})` replaces the jar's move POST when a host passes it (the
// same chips, the same refusal handling), and `whenless` leaves the When rows and the move-rule line out.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { P, T } from '../../lib/tokens.js'
import { useApiFetch } from '../../lib/api.js'
import { describeRefusal } from '../../lib/putUpErrors.js'
import Sheet from '../forms/Sheet.jsx'
import Button from '../forms/Button.jsx'
import SelectChip from '../forms/SelectChip.jsx'
import { labelChrome, requiredMarkChrome, inputChrome } from '../forms/formStyles.js'
import { placeChips, estimateChips, resolveWhen } from './putItUp.js'

export const MOVE_TITLE = 'Move it'
export const MOVE_RULE_TEXT = 'A discard date you set by hand stays. A worked-out one is cleared by a move — set a new one after.'

const MOVE_WHEN = [{ id: 'today', label: 'Today' }, { id: 'yesterday', label: 'Yesterday' }, { id: 'earlier', label: 'Earlier…' }]

export default function MoveJarSheet({ open, jar, onClose, onMoved, now, onSubmit = null, whenless = false }) {
  if (!open || !jar) return null
  return <MoveOpen key={jar.id} jar={jar} onClose={onClose} onMoved={onMoved} now={now} onSubmit={onSubmit} whenless={whenless} />
}

function MoveOpen({ jar, onClose, onMoved, now, onSubmit, whenless }) {
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
      if (onSubmit) await onSubmit({ place, when: w.when })
      else await fetch(`/api/preservation/${jar.id}/move`, { method: 'POST', body: JSON.stringify({
        place: place.id ? { id: place.id } : { kind: place.kind, label: place.label }, when: w.when,
      }) })
      writingRef.current = false
      setSaving(false)
      onMoved?.()
    } catch (e) {
      writingRef.current = false
      setSaving(false)
      setErr(describeRefusal(e)?.text ?? "Couldn't move it — try again.")
    }
  }, [chip, estimate, fetch, jar.id, nowDate, onMoved, onSubmit, pickedDate, place])

  const name = jar.label || 'this'
  return (
    <Sheet open onClose={onClose} title={MOVE_TITLE} size="full" busy={saving} armsBack>
      <div data-testid="move-sheet" data-jar-id={jar.id} style={{ padding: '0 18px' }}>
        <p style={{ margin: '0 0 10px', color: P.mid, fontSize: '0.86rem', fontWeight: 600 }}>{jar.label || 'This put-up'}</p>
        <span style={labelChrome} aria-hidden="true">Where to?<span style={requiredMarkChrome}>*</span></span>
        <div role="radiogroup" aria-label={`Where is ${name} going?`} aria-required="true"
          style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: T.space.md }}>
          {chips.map(c => (
            <SelectChip key={c.key} touch active={place?.key === c.key} disabled={saving} role="radio"
              aria-checked={place?.key === c.key} aria-pressed={undefined} data-testid={`move-place-${c.key}`}
              onClick={() => { setPlace(c); setErr(null) }}>{c.label}</SelectChip>
          ))}
        </div>
        {!whenless && <>
        <span style={labelChrome} aria-hidden="true">When?</span>
        <div role="radiogroup" aria-label="When did it move?" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
          {MOVE_WHEN.map(c => (
            <SelectChip key={c.id} touch active={chip === c.id} disabled={saving} role="radio" aria-checked={chip === c.id}
              aria-pressed={undefined} data-testid={`move-when-${c.id}`}
              onClick={() => { setChip(c.id); if (c.id !== 'earlier') { setEstimate(null); setPickedDate('') } setErr(null) }}>{c.label}</SelectChip>
          ))}
        </div>
        {chip === 'earlier' && (
          <div role="radiogroup" aria-label="Roughly when?" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
            {estimateChips(nowDate).map(c => (
              <SelectChip key={c.id} touch active={estimate === c.id} disabled={saving} role="radio" aria-checked={estimate === c.id}
                aria-pressed={undefined} data-testid={`move-when-${c.id}`}
                onClick={() => { setEstimate(c.id); setErr(null) }}>{c.label}</SelectChip>
            ))}
          </div>
        )}
        {chip === 'earlier' && estimate === 'pickdate' && (
          <input type="date" aria-label="The day it moved" data-testid="move-when-date" value={pickedDate} disabled={saving}
            onChange={e => { setPickedDate(e.target.value); setErr(null) }} style={{ ...inputChrome(false), maxWidth: 220, marginBottom: 8 }} />
        )}
        <p role="status" data-testid="move-rule" style={{ margin: `${T.space.sm}px 0`, color: P.mid, fontSize: '0.78rem' }}>{MOVE_RULE_TEXT}</p>
        </>}
        {err && <div role="alert" data-testid="move-error" style={{ marginBottom: T.space.sm, color: P.terra, fontSize: T.type.sm, fontWeight: 600 }}>{err}</div>}
      </div>
      <div style={{ position: 'sticky', bottom: 0, background: P.white, padding: `${T.space.sm}px 18px`, borderTop: `1px solid ${P.border}` }}>
        <Button data-testid="move-save" variant="primary" loading={saving} loadingLabel="Moving…" onClick={save} style={{ width: '100%' }}>
          {place ? `Move to ${place.label}` : 'Move it'}
        </Button>
      </div>
    </Sheet>
  )
}
