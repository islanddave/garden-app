// src/components/pantry/WalkPlace.jsx
// Put-Up B′ release 2 (V4 §2.2 "Walk a place", §6.2, §6.3) — the shipped freezer walk, generalised to
// ANY place. Still a mode flag on /put-up (`?session=putup`, the shipped key kept — a phone mid-walk at
// deploy time lands back in it), now with `&place=<id>` naming the place.
//
// SETUP (required 2, nothing preselected): which place (the household's places by name, then a template
// chip for a kind with no place yet — made once, here, so every save names a real place) and ONE date for
// the sitting (the §3.6 estimate chips, Not sure included). The answers are stashed (putUpSession.js's
// localStorage walk stash) so a walk spread over evenings comes back on the same place and date.
//
// EACH GROUP (required 2): What is it? (the name search; a hit fills crop/variety/planting, a typed name
// stays a label) · method-or-As is · how many (after a method; a stepper starting at 1) · Save → next.
// Quiet More: discard by (from the label) and a different date for this group. One preview line per group.
// A method → a put-up (POST /api/preservation); As is → a pantry item (POST /api/pantry/items).
//
// DUPLICATE PREVENTION: a collapsed "Already logged here ▸" (GET /api/pantry?place_id=: names and what's
// left, no count, no buttons beyond opening the row); the name search marks a match at this place
// "already here" (opens it) and one at another place "That's this one → move it here".
// No worklist, no ticks, no running count ("Picked up where you left off", with no "— N logged so far").
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { P } from '../../lib/constants.js'
import { T } from '../../lib/tokens.js'
import { useApiFetch } from '../../lib/api.js'
import { setReloadBlocked } from '../../lib/reloadGate.js'
import { useSuppressBottomNav } from '../../hooks/useSuppressBottomNav.js'
import { readWalk, writeWalk, clearWalk, readDismissed, dismissCrop, unrecordedCrops, WALK_PARAM } from '../../lib/putUpSession.js'
import { createPantryItem, deletePantryItem, ensurePlaceId, listPantry, patchPantryItem } from '../../lib/pantryApi.js'
import Button from '../forms/Button.jsx'
import SelectChip from '../forms/SelectChip.jsx'
import { labelChrome, requiredMarkChrome } from '../forms/formStyles.js'
import { mintKey } from '../kitchen/idempotencyKey.js'
import { placeChips } from '../putup/putItUp.js'
import NameSearchField from './NameSearchField.jsx'
import Stepper, { stepperCount } from './Stepper.jsx'
import { PlaceChipRow, MethodRow, DiscardChoice, focusFirstRadio } from './DoorParts.jsx'
import PantryRowSheet from './PantryRowSheet.jsx'
import RefusalLine, { refusalOf, refusalText } from './RefusalLine.jsx'
import { leftWords, rowKey } from './pantryRows.js'
import {
  AS_IS, METHOD_REQUIRED_TEXT, methodChoices, routeFor, walkWhen, walkWhenChips, previewLine, jarBody, itemBody,
  methodLabel, doorError,
} from './putSomethingUp.js'

export const WALK_TITLE = 'Walk a place'
export const PLACE_PARAM = 'place'
const WALK_BAND_FALLBACK_PX = 96

// A stash this walk can resume: the generalised shape (a place with an id and a resolved `when`). The
// shipped freezer walk's stash ({storageId, date, dateApprox}) cannot — its coarse dates were midpoints
// with no precision word — so it only preselects its freezer on the setup screen.
export function resumableWalk(stash) {
  return stash && stash.place && stash.place.id != null && stash.when && typeof stash.when.date === 'string'
    && typeof stash.when.precision === 'string' ? stash : null
}

export default function WalkPlace({ JarEditor = null, onHowItWasMade = null, canHowItWasMade = null, now }) {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { fetch } = useApiFetch()
  useSuppressBottomNav(true)
  const nowDate = useMemo(() => new Date(now ?? Date.now()), [now])

  const [stash] = useState(() => readWalk())
  const [walk, setWalk] = useState(() => resumableWalk(stash))
  const [resumed] = useState(() => !!resumableWalk(stash))
  const [editingSetup, setEditingSetup] = useState(() => !resumableWalk(stash))
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false)
  const [places, setPlaces] = useState([])
  const [stock, setStock] = useState(null)       // every Pantry row, for the name search's "already here"
  const [lastSaved, setLastSaved] = useState(null)
  const [openRow, setOpenRow] = useState(null)
  const [bandH, setBandH] = useState(WALK_BAND_FALLBACK_PX)
  const [hereSeq, setHereSeq] = useState(0)
  const bandRef = useRef(null)

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])

  useEffect(() => {
    let live = true
    Promise.resolve().then(() => fetch('/api/storage-locations'))
      .then(rows => { if (live) setPlaces(Array.isArray(rows) ? rows : []) })
      .catch(() => { /* non-fatal — the template chips still offer somewhere */ })
    return () => { live = false }
  }, [fetch])

  const loadStock = useCallback(() => {
    Promise.resolve().then(() => listPantry(fetch, { group: 'place' }))
      .then(r => setStock(r))
      .catch(() => { /* the name search falls back to the line search's put-ups */ })
  }, [fetch])
  useEffect(() => { if (!editingSetup) loadStock() }, [editingSetup, loadStock])
  const changed = useCallback(() => { loadStock(); setHereSeq(n => n + 1) }, [loadStock])

  useEffect(() => {
    const el = bandRef.current
    if (!el) return undefined
    const measure = () => setBandH(Math.round(el.getBoundingClientRect().height) || WALK_BAND_FALLBACK_PX)
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [editingSetup, lastSaved])

  const exitWalk = useCallback(() => {
    clearWalk()
    navigate('/put-up', { replace: true })
  }, [navigate])

  const startWalk = useCallback((answers) => {
    writeWalk(answers)
    setWalk(answers)
    setEditingSetup(false)
    const next = new URLSearchParams(searchParams)
    next.set('session', WALK_PARAM); next.set(PLACE_PARAM, String(answers.place.id))
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])

  const onSaved = useCallback((saved) => {
    setLastSaved({ ...saved, undone: false, error: null })
    changed()
  }, [changed])

  const undoLast = useCallback(async () => {
    if (!lastSaved?.id || lastSaved.undone) return
    try {
      if (lastSaved.route === 'item') await deletePantryItem(fetch, lastSaved.id)
      else await fetch(`/api/preservation/${lastSaved.id}`, { method: 'DELETE' })
      setLastSaved(s => (s ? { ...s, undone: true, error: null } : s))
      changed()
    } catch (e) {
      setLastSaved(s => (s ? { ...s, error: refusalText(e, "Couldn't undo — try again.") } : s))
    }
  }, [changed, fetch, lastSaved])

  const moveHere = useCallback(async (row) => {
    if (!walk?.place) return
    try {
      if (row.stock_kind === 'pantry_item') {
        await patchPantryItem(fetch, row.stock_id, { storage_location_id: String(walk.place.id) })
      } else {
        await fetch(`/api/preservation/${row.stock_id}/move`, { method: 'POST', body: JSON.stringify({
          place: { id: String(walk.place.id) }, when: { date: toToday(nowDate), precision: 'day' },
        }) })
      }
      setLastSaved({ id: null, route: null, text: `Moved ${row.name} here`, undone: false, error: null })
      changed()
    } catch (e) {
      setLastSaved({ id: null, route: null, text: `${row.name} — not moved`, undone: false, error: refusalText(e, "Couldn't move it — try again.") })
    }
  }, [changed, fetch, nowDate, walk])

  const placeLabel = walk?.place?.label ?? 'this place'
  const whenWords = walk?.when ? (walk.when.precision === 'unknown' ? 'date not sure' : walk.whenWords) : ''

  return (
    <div style={{ minHeight: 'calc(100dvh - 52px)', backgroundColor: P.cream }}>
      <div style={{ maxWidth: 620, margin: '0 auto', padding: `16px 18px ${bandH + 28}px` }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: T.space.sm, marginBottom: 4 }}>
          <h1 style={{ margin: 0, flex: 1, color: P.green, fontSize: '1.2rem', fontWeight: 700 }}>
            {editingSetup || !walk ? WALK_TITLE : `Walk: ${placeLabel}`}
          </h1>
          {editingSetup && (
            <button type="button" onClick={exitWalk} data-testid="putup-walk-setup-exit"
              style={{ background: 'none', border: 'none', color: P.mid, fontSize: T.type.sm, fontWeight: 600, fontFamily: 'inherit',
                textDecoration: 'underline', padding: '4px 0', minHeight: 48, cursor: 'pointer' }}>
              Not now
            </button>
          )}
        </div>

        {editingSetup ? (
          <WalkSetup online={online} initial={walk} legacyPlaceId={stash?.storageId ?? null} urlPlaceId={searchParams.get(PLACE_PARAM)}
            resumed={resumed} places={places} fetch={fetch} now={nowDate}
            onPlaceCreated={(row) => setPlaces(list => (list.some(l => String(l.id) === String(row.id)) ? list : [...list, row]))}
            onStart={startWalk} />
        ) : (
          <>
            {resumed && (
              <div data-testid="putup-walk-resumed" role="status"
                style={{ marginBottom: 14, padding: '9px 12px', fontSize: T.type.sm, color: P.green, backgroundColor: P.greenPale,
                  border: `1px solid ${P.greenLight}`, borderRadius: T.radiusButton }}>
                Picked up where you left off.
              </div>
            )}
            <AlreadyHere fetch={fetch} placeId={walk.place.id} seq={hereSeq} onOpen={setOpenRow} />
            <UnrecordedLine fetch={fetch} />
            <WalkGroup walk={walk} fetch={fetch} online={online} stock={stock} now={nowDate}
              onSaved={onSaved} onOpenExisting={setOpenRow} onMoveHere={moveHere} />
          </>
        )}
      </div>

      {!editingSetup && walk && (
        <div ref={bandRef} data-testid="putup-walk-band"
          style={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 30, backgroundColor: P.white,
            borderTop: `1px solid ${P.border}`, padding: '10px 18px calc(10px + env(safe-area-inset-bottom))' }}>
          {lastSaved && (
            <div style={{ display: 'flex', alignItems: 'center', gap: T.space.sm, marginBottom: 6 }}>
              <span data-testid="putup-walk-last" role="status"
                style={{ flex: 1, minWidth: 0, fontSize: T.type.sm, color: lastSaved.undone ? P.light : P.dark,
                  textDecoration: lastSaved.undone ? 'line-through' : 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {lastSaved.undone ? 'Undone' : '✓'} {lastSaved.text}
              </span>
              {!lastSaved.undone && lastSaved.id && (
                <button type="button" onClick={undoLast} data-testid="putup-walk-undo"
                  style={{ background: 'none', border: 'none', color: P.terra, fontSize: T.type.sm, fontWeight: 700, fontFamily: 'inherit',
                    textDecoration: 'underline', padding: '4px 2px', minHeight: 48, minWidth: 48, cursor: 'pointer', flexShrink: 0 }}>
                  Undo
                </button>
              )}
            </div>
          )}
          {lastSaved?.error && <div role="alert" style={{ color: P.terra, fontSize: '0.78rem', marginBottom: 6 }}>{lastSaved.error}</div>}
          <div style={{ display: 'flex', alignItems: 'center', gap: T.space.sm }}>
            <span data-testid="putup-walk-where" style={{ flex: 1, minWidth: 0, fontSize: '0.78rem', color: P.light,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {placeLabel} · {whenWords}
            </span>
            <button type="button" onClick={() => setEditingSetup(true)} data-testid="putup-walk-change"
              style={{ background: 'none', border: 'none', color: P.green, fontSize: '0.78rem', fontWeight: 700, fontFamily: 'inherit',
                textDecoration: 'underline', padding: '4px 2px', minHeight: 48, cursor: 'pointer', flexShrink: 0 }}>
              Change
            </button>
            <button type="button" onClick={exitWalk} data-testid="putup-walk-exit"
              style={{ background: 'none', border: `1px solid ${P.border}`, borderRadius: T.radiusButton, color: P.mid, fontSize: '0.78rem',
                fontWeight: 700, fontFamily: 'inherit', padding: '6px 12px', minHeight: 48, cursor: 'pointer', flexShrink: 0 }}>
              Done
            </button>
          </div>
        </div>
      )}

      <PantryRowSheet row={openRow} fetch={fetch} onClose={() => setOpenRow(null)} now={now} JarEditor={JarEditor}
        onHowItWasMade={onHowItWasMade} canHowItWasMade={canHowItWasMade} onUsed={() => changed()} onChanged={() => changed()} />
    </div>
  )
}

function toToday(now) {
  const pad = n => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

// The two questions, asked ONCE per sitting.
function WalkSetup({ online, initial, legacyPlaceId, urlPlaceId, resumed, places, fetch, now, onPlaceCreated, onStart }) {
  const chips = useMemo(() => placeChips(places), [places])
  const wantId = initial?.place?.id ?? urlPlaceId ?? legacyPlaceId ?? null
  const [place, setPlace] = useState(initial?.place ?? null)
  const [choice, setChoice] = useState(initial?.whenChoice ?? null)
  const [pickedDate, setPickedDate] = useState(initial?.pickedDate ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  // A place named by the stash or the URL is preselected once the list has it.
  useEffect(() => {
    if (place || wantId == null) return
    const hit = chips.find(c => c.id != null && String(c.id) === String(wantId))
    if (hit) setPlace(hit)
  }, [chips, place, wantId])

  const w = choice ? walkWhen({ choice, pickedDate, now }) : null
  const canStart = online && !!place && !!w?.when && !busy

  async function start() {
    if (!canStart) return
    setBusy(true); setErr(null)
    try {
      const id = await ensurePlaceId(fetch, place)
      const resolved = { ...place, id, key: `id:${id}` }
      if (!place.id) onPlaceCreated({ id, label: place.label, kind: place.kind })
      onStart({ place: resolved, whenChoice: choice, pickedDate, when: w.when, whenWords: w.words, date: w.when.date })
    } catch (e) {
      setErr(refusalText(e, "Couldn't set up that place — try again."))
    } finally { setBusy(false) }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: T.space.md }}>
      {!online && (
        <div role="alert" data-testid="putup-walk-offline"
          style={{ padding: '12px 14px', fontSize: T.type.sm, lineHeight: 1.45, color: P.bannerInk, backgroundColor: P.warn,
            border: `1px solid ${P.warnBorder}`, borderRadius: T.radiusButton }}>
          <strong>You&rsquo;re offline — nothing you log here will save.</strong> Better to find out now than after a walk
          round the place. This clears itself the moment you&rsquo;re back on.
        </div>
      )}
      <PlaceChipRow chips={chips} value={place} onChange={setPlace} idPrefix="putup-walk" label="Which place are you at?" disabled={busy} />
      <div>
        <span style={labelChrome} aria-hidden="true">Roughly when did it go in?<span style={requiredMarkChrome}>*</span></span>
        <div role="radiogroup" aria-label="Roughly when did it go in?" aria-required="true" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {walkWhenChips(now).map(c => (
            <SelectChip key={c.id} touch active={choice === c.id} disabled={busy} role="radio" aria-checked={choice === c.id}
              aria-pressed={undefined} data-testid={`putup-walk-when-${c.id}`} onClick={() => setChoice(c.id)}>{c.label}</SelectChip>
          ))}
        </div>
        {choice === 'pickdate' && (
          <input type="date" aria-label="The day it went in" data-testid="putup-walk-when-date" value={pickedDate}
            onChange={e => setPickedDate(e.target.value)} style={{ marginTop: 8, minHeight: 44 }} />
        )}
        {w?.when && (
          <div data-testid="putup-walk-date-resolved" role="status" style={{ marginTop: 10, fontSize: T.type.sm, color: P.mid }}>
            {w.when.precision === 'unknown'
              ? 'Saved as “put up: not sure” — no discard date is worked out for these.'
              : <>Everything in this walk gets recorded as <strong>{w.words}</strong>.</>}
          </div>
        )}
      </div>
      {err && <div role="alert" style={{ color: P.terra, fontSize: T.type.sm }}>{err}</div>}
      <Button type="button" variant="primary" disabled={!canStart} loading={busy} data-testid="putup-walk-start" onClick={start}>
        {resumed ? 'Back to the walk' : 'Start the walk'}
      </Button>
    </div>
  )
}

// "Already logged here ▸" — collapsed; names and what's left, fetched when opened (and after each save).
function AlreadyHere({ fetch, placeId, seq, onOpen }) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!open) return undefined
    let live = true
    Promise.resolve().then(() => listPantry(fetch, { group: 'place', placeId }))
      .then(r => { if (live) { setRows(r); setFailed(false) } })
      .catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [fetch, open, placeId, seq])
  return (
    <div style={{ marginBottom: 8 }}>
      <button type="button" aria-expanded={open} data-testid="putup-walk-here-toggle" onClick={() => setOpen(o => !o)}
        style={{ background: 'none', border: 'none', padding: '6px 0', cursor: 'pointer', color: P.mid, fontSize: T.type.sm,
          fontWeight: 600, fontFamily: 'inherit', minHeight: 48 }}>
        Already logged here <span aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div data-testid="putup-walk-here">
          {failed && <div style={{ fontSize: T.type.sm, color: P.light }}>Couldn&rsquo;t check just now.</div>}
          {rows && rows.length === 0 && <div style={{ fontSize: T.type.sm, color: P.light }}>Nothing logged here yet.</div>}
          {rows && rows.length > 0 && (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {rows.map(r => (
                <li key={rowKey(r)}>
                  <button type="button" data-testid={`putup-walk-here-${rowKey(r)}`} onClick={() => onOpen(r)}
                    style={{ display: 'block', width: '100%', minHeight: 48, textAlign: 'left', background: 'none', border: 'none',
                      borderTop: `1px solid ${P.border}`, padding: '6px 4px', fontFamily: 'inherit', fontSize: T.type.sm, color: P.dark, cursor: 'pointer' }}>
                    {[r.name, leftWords(r)].filter(Boolean).join(' · ')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

// One group: what · method-or-As is · how many · Save → next.
function WalkGroup({ walk, fetch, online, stock, now, onSaved, onOpenExisting, onMoveHere }) {
  const [what, setWhat] = useState(null)
  const [method, setMethod] = useState(null)
  const [count, setCount] = useState('1')
  const [moreOpen, setMoreOpen] = useState(false)
  const [discard, setDiscard] = useState({ mode: 'auto', date: '' })
  const [ownChoice, setOwnChoice] = useState(null)   // a different date for this group
  const [ownPicked, setOwnPicked] = useState('')
  const [key, setKey] = useState(null)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)
  const [field, setField] = useState(null)
  const writingRef = useRef(false)
  const methodRef = useRef(null)
  const whatRef = useRef(null)

  const place = walk.place
  const choices = useMemo(() => methodChoices({ placeKind: place?.kind ?? null, what }), [place, what])
  useEffect(() => { if (method === AS_IS && !choices.asIs) setMethod(null) }, [choices, method])
  const own = ownChoice ? walkWhen({ choice: ownChoice, pickedDate: ownPicked, now }) : null
  const when = own?.when ?? walk.when
  const preview = method ? previewLine({ method, place, when, discard, now }) : null

  const dirty = !!(String(what?.name ?? '').trim() || method || count !== '1' || discard.mode !== 'auto' || ownChoice)
  useEffect(() => { if (dirty && !key) setKey(mintKey()) }, [dirty, key])
  const gateKey = `walk-group:${useId()}`
  const hold = dirty || saving
  useEffect(() => {
    setReloadBlocked(gateKey, hold)
    return () => setReloadBlocked(gateKey, false)
  }, [gateKey, hold])

  function reset() {
    setWhat(null); setMethod(null); setCount('1'); setDiscard({ mode: 'auto', date: '' }); setOwnChoice(null); setOwnPicked('')
    setMoreOpen(false); setKey(null); setErr(null); setField(null)
  }

  async function save() {
    if (writingRef.current) return
    if (!online) { setErr("You're offline — this can't be saved right now. What you entered is kept."); return }
    if (!String(what?.name ?? '').trim()) { setErr('What is it? Type a name.'); setField('what'); whatRef.current?.focus?.(); return }
    if (!method) { setErr(METHOD_REQUIRED_TEXT); setField('method'); focusFirstRadio(methodRef); return }
    if (own?.error) { setErr(own.error); setField('when'); setMoreOpen(true); return }
    const dErr = doorError({ what, place, method, discard })
    if (dErr) { setErr(dErr.error); setField(dErr.field); setMoreOpen(true); return }
    const useKey = key || mintKey()
    if (!key) setKey(useKey)
    writingRef.current = true
    setSaving(true); setErr(null); setField(null)
    const route = routeFor(method)
    try {
      let saved
      if (route === 'jar') {
        saved = await fetch('/api/preservation', { method: 'POST', body: JSON.stringify(jarBody({
          key: useKey, what, storageLocationId: place.id, method, when, count: stepperCount(count), discard,
        })) })
      } else {
        const r = await createPantryItem(fetch, itemBody({ key: useKey, what, place, when, discard }))
        saved = r?.item ?? r
      }
      const n = route === 'jar' ? stepperCount(count) : null
      onSaved({ id: saved?.id ?? null, route, text: [n ? `${n} × ${what.name.trim()}` : what.name.trim(), methodLabel(method, what)].join(' · ') })
      reset()
    } catch (e) {
      setErr(refusalOf(e, "Couldn't save it — what you entered is kept. Try again."))
    } finally {
      writingRef.current = false
      setSaving(false)
    }
  }

  const name = String(what?.name ?? '').trim() || 'this'
  return (
    <div data-testid="putup-walk-group" style={{ display: 'flex', flexDirection: 'column', gap: T.space.md, background: P.white,
      border: `1px solid ${P.border}`, borderRadius: T.radiusCard, padding: '14px 16px' }}>
      <NameSearchField value={what} onChange={v => { setWhat(v); if (field === 'what') { setErr(null); setField(null) } }} fetch={fetch}
        stockRows={stock} placeId={place.id} onOpenExisting={onOpenExisting} onMoveHere={onMoveHere}
        idPrefix="walk-what" invalid={field === 'what'} inputRef={whatRef} disabled={saving} />
      <MethodRow choices={choices} value={method} what={what} idPrefix="walk" disabled={saving} invalid={field === 'method'}
        groupRef={methodRef} onChange={m => { setMethod(m); if (field === 'method') { setErr(null); setField(null) } }}
        label="How was it put up?" />
      {method && method !== AS_IS && (
        <div>
          <span style={labelChrome} aria-hidden="true">How many?</span>
          <Stepper value={count} onChange={setCount} name={name} idPrefix="walk-count" disabled={saving} />
        </div>
      )}
      <button type="button" aria-expanded={moreOpen} data-testid="walk-more" onClick={() => setMoreOpen(o => !o)}
        style={{ alignSelf: 'flex-start', minHeight: 48, background: 'none', border: 'none', padding: 0, color: P.mid,
          fontWeight: 600, fontFamily: 'inherit', fontSize: T.type.sm, cursor: 'pointer' }}>
        <span aria-hidden="true">{moreOpen ? '▾ ' : '▸ '}</span>More
      </button>
      {moreOpen && (
        <div data-testid="walk-more-panel" style={{ display: 'flex', flexDirection: 'column', gap: T.space.md }}>
          <DiscardChoice value={discard} onChange={setDiscard} idPrefix="walk" itemMode={method === AS_IS} disabled={saving} />
          <div>
            <span style={labelChrome} aria-hidden="true">A different date for this one</span>
            <div role="radiogroup" aria-label="A different date for this one" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {walkWhenChips(now).map(c => (
                <SelectChip key={c.id} touch active={ownChoice === c.id} disabled={saving} role="radio" aria-checked={ownChoice === c.id}
                  aria-pressed={undefined} data-testid={`walk-own-${c.id}`}
                  onClick={() => setOwnChoice(ownChoice === c.id ? null : c.id)}>{c.label}</SelectChip>
              ))}
            </div>
            {ownChoice === 'pickdate' && (
              <input type="date" aria-label="The day this one went in" data-testid="walk-own-date" value={ownPicked}
                onChange={e => setOwnPicked(e.target.value)} style={{ marginTop: 8, minHeight: 44 }} />
            )}
          </div>
        </div>
      )}
      {preview && <p role="status" data-testid="walk-preview" style={{ margin: 0, color: P.mid, fontSize: T.type.sm }}>{preview}</p>}
      <RefusalLine err={err} testId="walk-error" />
      <Button variant="primary" data-testid="walk-save" loading={saving} loadingLabel="Saving…" onClick={save} style={{ width: '100%' }}>
        Save → next
      </Button>
    </div>
  )
}

// "What haven't I put up?" (the shipped walk's design §6 Q4, moved here unchanged in behaviour) — ONE
// collapsed line, no ticks, no denominator. Collapsed it makes no accusation and costs no season scan;
// every crop is dismissible and the dismissal sticks ("Not one I put up", never "done").
function UnrecordedLine({ fetch }) {
  const [open, setOpen] = useState(false)
  const [wanted, setWanted] = useState(false)
  const [state, setState] = useState({ loading: false, failed: false, crops: null })
  const [dismissed, setDismissed] = useState(() => readDismissed())

  useEffect(() => {
    if (!wanted) return undefined
    let live = true
    setState({ loading: true, failed: false, crops: null })
    Promise.all([
      fetch('/api/harvests?include=aggregates'),
      fetch('/api/preservation/whats-put-up?group=crop'),
    ])
      .then(([h, p]) => {
        if (!live) return
        const putUp = (p?.groups ?? []).flatMap(g => [g.group_key, ...(g.records ?? []).map(r => r.crop_type_slug)].filter(Boolean))
        setState({ loading: false, failed: false, crops: h?.aggregates?.crops ?? [], putUp })
      })
      .catch(() => { if (live) setState({ loading: false, failed: true, crops: null }) })
    return () => { live = false }
  }, [wanted, fetch])

  const rows = useMemo(
    () => unrecordedCrops({ harvestCrops: state.crops, putUpSlugs: state.putUp, dismissed }),
    [state.crops, state.putUp, dismissed],
  )

  return (
    <div style={{ marginBottom: 14 }}>
      <button type="button" onClick={() => { setOpen(o => !o); setWanted(true) }} aria-expanded={open}
        data-testid="putup-walk-unrecorded-toggle"
        style={{ background: 'none', border: 'none', padding: '6px 0', cursor: 'pointer', color: P.mid, fontSize: T.type.sm,
          fontWeight: 600, fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 6, minHeight: 48 }}>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span>What haven&rsquo;t I put up?</span>
      </button>
      {open && (
        <div data-testid="putup-walk-unrecorded" style={{ paddingLeft: 18 }}>
          {state.loading && <div style={{ fontSize: T.type.sm, color: P.light }}>Checking&hellip;</div>}
          {state.failed && <div style={{ fontSize: T.type.sm, color: P.light }}>Couldn&rsquo;t check just now.</div>}
          {!state.loading && !state.failed && state.crops && rows.length === 0 && (
            <div style={{ fontSize: T.type.sm, color: P.light }}>Nothing outstanding.</div>
          )}
          {rows.map(c => (
            <div key={c.slug} style={{ display: 'flex', alignItems: 'center', gap: T.space.sm, padding: '4px 0' }}>
              <span style={{ flex: 1, minWidth: 0, fontSize: T.type.sm, color: P.dark }}>{c.name}</span>
              <button type="button" onClick={() => setDismissed(dismissCrop(c.slug))} data-testid="putup-walk-not-mine"
                style={{ background: 'none', border: 'none', color: P.light, fontSize: '0.76rem', fontWeight: 600, fontFamily: 'inherit',
                  textDecoration: 'underline', padding: '4px 2px', minHeight: 44, cursor: 'pointer', flexShrink: 0 }}>
                Not one I put up
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
