// src/components/planting/AddToLot.jsx — V5-SEEDLOTADDITION-001 (seed release 3). "Put it in a seed lot
// I already started": the lot list and the add form. Both render INSIDE SaveSeedSheet's <Sheet>, in the
// place of the new-lot form, and only while seedAdditions.addToLotAvailable() answers on.
//
// More seed off a plant used to mean a second lot, or a count typed over the first one. This puts
// today's seed into the lot that is already drying: one POST that adds the plant to the lot if it is
// new there, re-files the lot as a mix when the plant is another variety, raises the count, and keeps
// its own row for the picking.
//
// THE WRITES, each awaited before the next:
//   0. POST /api/varieties/blend { create: true } — only when the plant is another variety than the lot
//      holds. It is idempotent and writes no lot, so a failure after it leaves nothing to undo.
//   1. POST /api/inventory-items/:id/seed-additions, carrying ONE key minted when the form opened on
//      this lot. Every tap, the automatic second try and "Try again" send that same key, so the server
//      can answer "already added" instead of adding twice.
//   2. POST /api/events, once, never retried: the timeline's copy of the act. The picking row is the
//      record; a missed entry changes the toast and nothing else.
//
// ONLY A 2xx THAT NAMES ITS ADDITION IS A SAVE. An older Lambda answers this path with its create
// arm (400, no code), which is why the body never carries a name.
//
// A REQUEST THAT NEVER ANSWERED IS NOT A REFUSAL. Once it has left, a timeout, a dropped connection
// and a 5xx all mean "may have landed". The same body goes once more; the key makes that safe and its
// answer says which it was. Until there is a definite answer every field stays locked, so a later tap
// can never send a different amount under a key that may already be spent.
//
// Every sentence is the client's own (seedAdditions.js). The server's string is never printed.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { T } from '../forms/formStyles.js'
import { useApiFetch } from '../../lib/api.js'
import { useOptionalToast } from '../../context/ToastContext.jsx'
import { todayLocalISO } from '../../lib/dateLocal.js'
import { P } from '../../lib/constants.js'
import { mintKey } from '../kitchen/idempotencyKey.js'
import { sourcePlantFromPlanting, parentSetFacts, lotNotice, previewMixName } from '../seed/seedParents.js'
import {
  lotFactsLine, lotRowLine, parseAddCount, parseAddWeight, buildAdditionBody, additionSaved,
  additionEventBody, outcomeLine, refileSentence, sentenceForRefusal, isChangedRefusal, addedToast,
  cropWords, lotsLoadingLine, lotsNoneLine, otherLotsDivider,
  STORED_LOT_LINE, ADD_OFFLINE, ADD_REFUSED, ADD_USED_UP, ADD_CHECKING, ADD_UNKNOWN, LOTS_FAILED, LOTS_FROM_CACHE,
} from '../seed/seedAdditions.js'

// The service worker's mark on a reply it served from its offline copy (src/lib/api.js). Such a copy
// is never "the latest", so nothing is added on the strength of it.
const FROM_CACHE = Symbol.for('garden-app.fromCache')

const sid = (v) => String(v ?? '')

// The year of a lot name that is still the automatic one ("<variety> — saved <year>" or "Saved seed
// <year>"), else null. A name he typed is his and is never changed by a re-file.
function automaticYear(varietyName, name) {
  const shown = String(name ?? '').trim()
  const variety = String(varietyName ?? '').trim()
  if (/^Saved seed \d{4}$/.test(shown)) return shown.slice(-4)
  if (variety && shown.startsWith(`${variety} — saved `) && /^\d{4}$/.test(shown.slice(variety.length + 9))) {
    return shown.slice(-4)
  }
  return null
}

// One of the plant's own lots (GET /api/plants/:id/seed-lots) as a list row. That read names the
// OTHER plants on the lot, so the whole set is this plant and those. This plant is on it, so adding
// changes neither the set nor the filing.
function rowFromOwnLot(lot, plantId) {
  const others = Array.isArray(lot.other_parents) ? lot.other_parents.filter(Boolean) : []
  return {
    ...lot,
    is_member: true,
    same_variety: true,
    source_plants: [{ id: plantId }, ...others.map((p) => ({ id: p.id, name: p.name ?? '' }))],
  }
}

// Whether adding this plant leaves the lot filed as it is, by the read's own definition: the plant is
// on the lot, or the lot's variety is the plant's, or a plant on the lot has the plant's variety.
function sameVariety(lot, plant) {
  const parents = Array.isArray(lot.source_plants) ? lot.source_plants.filter(Boolean) : []
  if (parents.some((p) => sid(p.id) === sid(plant.id))) return true
  if (plant.variety_id == null) return false
  return sid(lot.variety_id) === sid(plant.variety_id) || parents.some((p) => sid(p.variety_id) === sid(plant.variety_id))
}

/**
 * `planting` is the page's planting (the one row in From). `ownLots` are its open lots as the sheet
 * read them when it opened. `startLot` is the one named on the link, or null for the list.
 * `Basis` is the sheet's own count-basis switch, passed in so the two forms cannot drift apart.
 * `onState({ dirty, busy })` tells the sheet what its close control should do; `onBack` returns to the
 * new-lot form; `onAdded(reply)` ends the sheet after a save.
 */
export default function AddToLot({ planting, ownLots = [], startLot = null, Basis, onState, onBack, onAdded }) {
  const { fetch } = useApiFetch()
  const toast = useOptionalToast()
  const plant = useMemo(() => sourcePlantFromPlanting(planting), [planting])

  // ── The list ───────────────────────────────────────────────────────────────────────────────────────
  // The plant's own open lots draw at once; the read's rows take their place when it answers. Own lots
  // keep their places at the top, so nothing moves under the thumb.
  const ownRows = useMemo(() => ownLots.map((l) => rowFromOwnLot(l, planting.id)), [ownLots, planting.id])
  const [read, setRead] = useState({ state: 'idle', rows: null, crop: null })
  const rows = useMemo(() => {
    if (!read.rows) return ownRows
    const byId = new Map(read.rows.map((r) => [sid(r.id), r]))
    const first = ownRows.map((r) => byId.get(sid(r.id))).filter(Boolean)
    const taken = new Set(first.map((r) => sid(r.id)))
    return [...first, ...read.rows.filter((r) => !taken.has(sid(r.id)))]
  }, [ownRows, read.rows])
  const crop = cropWords(read.crop ?? plant.crop_slug)

  const aliveRef = useRef(true)
  useEffect(() => () => { aliveRef.current = false }, [])

  // GET /seed-lots-open. Anything but a fresh 2xx whose open_lots is an array is not a list: an older
  // Lambda answers this path 500, and a copy kept for offline use may name a lot that has since moved.
  const loadLots = useCallback(async () => {
    setRead((cur) => ({ ...cur, state: 'loading' }))
    try {
      const reply = await fetch(`/api/inventory-items/seed-lots-open?plant_id=${encodeURIComponent(planting.id)}`)
      if (!reply || !Array.isArray(reply.open_lots)) throw new Error('not a list')
      const stale = reply[FROM_CACHE] === true
      const next = { state: stale ? 'cached' : 'ready', rows: reply.open_lots.filter(Boolean), crop: reply.crop_slug ?? null }
      if (aliveRef.current) setRead(next)
      return stale ? null : next.rows
    } catch {
      if (aliveRef.current) setRead((cur) => ({ ...cur, state: 'failed' }))
      return null
    }
  }, [fetch, planting.id])

  // ── The form ───────────────────────────────────────────────────────────────────────────────────────
  // `lot` is the row the form is on; `key` was minted when it opened there and is that form's for good.
  const [lot, setLot] = useState(() => (startLot ? rowFromOwnLot(startLot, planting.id) : null))
  const keyRef = useRef(startLot ? mintKey() : null)
  const [count, setCount] = useState('')
  const [estimated, setEstimated] = useState(false)
  const [weight, setWeight] = useState('')
  // 'idle' | 'sending' | 'checking' | 'unknown'. The last three lock the form.
  const [phase, setPhase] = useState('idle')
  const [error, setError] = useState(null)
  // The lot could not be read again after it changed: nothing may be added until a read lands.
  const [needsRead, setNeedsRead] = useState(false)
  const sentRef = useRef(null)
  const inFlightRef = useRef(false)

  const locked = phase !== 'idle'
  useEffect(() => {
    onState?.({ dirty: !!lot, busy: phase === 'sending' || phase === 'checking' })
  }, [lot, phase]) // eslint-disable-line react-hooks/exhaustive-deps

  // The list is read when it is first shown, and not at all on the named link's straight path.
  const listShown = !lot
  useEffect(() => {
    if (listShown && read.state === 'idle') loadLots()
  }, [listShown, read.state, loadLots])

  // Focus follows the change of view: the list's heading, the form's "Going into".
  const headingRef = useRef(null)
  const goingRef = useRef(null)
  const lotId = lot?.id ?? null
  useEffect(() => {
    (lotId ? goingRef : headingRef).current?.focus?.()
  }, [lotId])

  function pick(row) {
    keyRef.current = mintKey()
    sentRef.current = null
    setCount(''); setEstimated(false); setWeight('')
    setError(null); setNeedsRead(false); setPhase('idle')
    setLot(row)
  }

  function changeLot() {
    if (locked) return
    keyRef.current = null
    setLot(null)
    setError(null); setNeedsRead(false)
  }

  // What the set will be, and what it will be filed under, when this plant is another variety.
  const refile = useMemo(() => {
    if (!lot || lot.same_variety !== false) return null
    const parents = Array.isArray(lot.source_plants) ? lot.source_plants.filter(Boolean) : []
    const next = [...parents, plant]
    const facts = parentSetFacts(next)
    const mixName = previewMixName(facts.varieties)
    const year = automaticYear(lot.variety_name, lot.name)
    const newLotName = year && mixName ? `${mixName} — saved ${year}` : null
    return {
      varietyIds: facts.varietyIds, year, mixName,
      sentence: refileSentence({ plantingName: planting.name, mixName, newLotName }),
      notice: lotNotice({
        source_plants: next, source_plant_id: lot.source_plant_id ?? null,
        breeding_system: null, variety_rank: 'blend', variety_name: mixName,
      }).sentences,
    }
  }, [lot, plant, planting.name])

  // The lot as an answer drew it. A 409 that carries the set is the latest by itself; one that does
  // not is read again from the list's route.
  function redraw(fields) {
    setLot((cur) => {
      const next = { ...cur, ...fields }
      return { ...next, is_member: (next.source_plants ?? []).some((p) => sid(p?.id) === sid(plant.id)), same_variety: sameVariety(next, plant) }
    })
  }

  async function reread() {
    const fresh = await loadLots()
    if (!aliveRef.current) return
    if (!fresh) { setNeedsRead(true); setError(LOTS_FAILED); return }
    const row = fresh.find((r) => sid(r.id) === sid(lotId))
    // The read lists only lots that can still take seed. Gone from it, this one no longer can.
    if (!row) { setNeedsRead(true); setError(ADD_USED_UP); return }
    setNeedsRead(false)
    setLot(row)
  }

  async function retryRead() {
    setError(null)
    await reread()
    if (aliveRef.current) setError((cur) => cur ?? sentenceForRefusal('lot_changed'))
  }

  // A definite no. Nothing was written and nothing landed under the key, so the form unlocks as typed.
  async function refused(err) {
    const code = err?.body?.code
    setError(sentenceForRefusal(code))
    if (isChangedRefusal(code)) {
      const b = err.body ?? {}
      if (Array.isArray(b.source_plants)) {
        const fields = {}
        for (const k of ['source_plant_id', 'source_plants', 'variety_id', 'name', 'seed_count',
          'seed_count_estimated', 'seed_weight_g', 'seed_parent_plant_count', 'quantity_on_hand']) {
          if (Object.prototype.hasOwnProperty.call(b, k)) fields[k] = b[k]
        }
        redraw(fields)
      } else {
        await reread()
      }
    }
    if (aliveRef.current) setPhase('idle')
  }

  async function saved(reply, sent, shownName) {
    let eventFailed = false
    try {
      await fetch('/api/events', { method: 'POST', body: JSON.stringify(additionEventBody(sent, reply)) })
    } catch {
      eventFailed = true
    }
    toast.show(addedToast(shownName, reply.name, eventFailed))
    onAdded?.(reply)
  }

  const post = (sent) => fetch(`/api/inventory-items/${lotId}/seed-additions`, {
    method: 'POST', body: JSON.stringify(sent),
  })
  // api.js throws these two before any request is made: no connection, or no sign-in token.
  const neverLeft = (err) => err?.offline === true || err?.authPending === true
  const isRefusal = (err) => typeof err?.status === 'number' && err.status >= 400 && err.status < 500

  // The same body and key again. Its answer is the read that says whether the first one landed.
  async function ask(sent, shownName) {
    setPhase('checking')
    setError(null)
    try {
      const reply = await post(sent)
      if (additionSaved(reply)) { await saved(reply, sent, shownName); return }
    } catch (err) {
      if (isRefusal(err) && err.body?.code) { await refused(err); return }
    }
    if (!aliveRef.current) return
    setPhase('unknown')
    setError(ADD_UNKNOWN)
  }

  async function submit() {
    if (locked || needsRead || inFlightRef.current || !lot) return
    const counted = parseAddCount(count)
    if (counted.error) { setError(counted.error); return }
    const weighed = parseAddWeight(weight)
    if (weighed.error) { setError(weighed.error); return }
    // Decided BEFORE anything is sent: with no connection there is nothing to be unsure about.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) { setError(ADD_OFFLINE); return }
    inFlightRef.current = true
    setPhase('sending')
    setError(null)
    const shownName = lot.name
    try {
      // STEP 0, only for a plant of another variety: find or make the mix the lot will be filed under.
      // `filing` rides only when that mix is not what the lot is filed under already. Fewer than two
      // varieties is not a mix; the request goes without one and the server judges the set.
      let filing = null
      if (refile && refile.varietyIds.length >= 2) {
        let mix
        try {
          mix = await fetch('/api/varieties/blend', {
            method: 'POST',
            body: JSON.stringify({ component_variety_ids: refile.varietyIds, create: true }),
          })
          if (!mix?.id) throw new Error('the mix route answered without a variety id')
        } catch (err) {
          setError(err?.offline === true ? ADD_OFFLINE : ADD_REFUSED)
          setPhase('idle')
          return
        }
        if (sid(mix.id) !== sid(lot.variety_id)) {
          filing = { variety_id: mix.id, expect_variety_id: lot.variety_id }
          const named = String(mix.name ?? '').trim()
          if (refile.year && named) filing.name = `${named} — saved ${refile.year}`
        }
      }
      const sent = buildAdditionBody({
        key: keyRef.current,
        plantId: planting.id,
        expectedIds: (lot.source_plants ?? []).filter(Boolean).map((p) => p.id),
        pickedOn: todayLocalISO(),
        count: counted.value, estimated, weight: weighed.value, filing,
      })
      sentRef.current = { sent, shownName }
      let reply
      try {
        reply = await post(sent)
      } catch (err) {
        if (err?.offline === true) { setError(ADD_OFFLINE); setPhase('idle'); return }
        if (neverLeft(err)) { setError(ADD_REFUSED); setPhase('idle'); return }
        if (isRefusal(err)) { await refused(err); return }
        await ask(sent, shownName)
        return
      }
      if (additionSaved(reply)) { await saved(reply, sent, shownName); return }
      setError(ADD_REFUSED)
      setPhase('idle')
    } finally {
      inFlightRef.current = false
    }
  }

  async function tryAgain() {
    if (phase !== 'unknown' || inFlightRef.current || !sentRef.current) return
    inFlightRef.current = true
    try {
      await ask(sentRef.current.sent, sentRef.current.shownName)
    } finally {
      inFlightRef.current = false
    }
  }

  // ── The list view ──────────────────────────────────────────────────────────────────────────────────
  if (!lot) {
    const stale = read.state === 'cached'
    const stateLine = read.state === 'loading' ? { role: 'status', text: lotsLoadingLine(crop) }
      : read.state === 'failed' ? { role: 'alert', text: LOTS_FAILED, retry: true }
      : stale ? { role: 'status', text: LOTS_FROM_CACHE, retry: true }
      : read.state === 'ready' && rows.length === 0 ? { role: 'status', text: lotsNoneLine(crop) }
      : null
    const dividerAt = rows.findIndex((r) => r.same_variety === false)
    return (
      <div data-testid="seed-lot-list">
        <h3 ref={headingRef} tabIndex={-1} data-testid="seed-lot-list-heading" style={headingStyle}>
          Which seed lot?
        </h3>
        {rows.map((row, i) => {
          const line = lotRowLine(row, planting.id)
          return (
            <React.Fragment key={sid(row.id)}>
              {i === dividerAt && (
                <p data-testid="seed-lot-list-divider" style={dividerStyle}>{otherLotsDivider(crop)}</p>
              )}
              <button
                type="button" data-testid="seed-lot-row" disabled={stale}
                onClick={() => pick(row)} style={lotRowStyle(stale)}
              >
                <span style={lotNameStyle}>{row.name || 'Untitled seed lot'}</span>
                {line && <span style={lotLineStyle}>{line}</span>}
              </button>
            </React.Fragment>
          )
        })}
        {stateLine && (
          <div data-testid="seed-lot-list-state" role={stateLine.role} style={stateStyle}>
            <span>{stateLine.text}</span>
            {stateLine.retry && (
              <button type="button" data-testid="seed-lot-list-retry" onClick={loadLots} style={retryStyle}>
                Try again
              </button>
            )}
          </div>
        )}
        <button type="button" data-testid="seed-lot-list-back" onClick={onBack} style={linkRowStyle}>
          ← Start a new seed lot instead
        </button>
      </div>
    )
  }

  // ── The add form ───────────────────────────────────────────────────────────────────────────────────
  const facts = lotFactsLine(lot)
  const typed = parseAddCount(count)
  const outcome = outcomeLine(lot, typed.error ? null : typed.value, estimated)
  const working = phase === 'sending'
  return (
    <div data-testid="seed-add-form">
      <div ref={goingRef} tabIndex={-1} data-testid="seed-add-going-into" style={goingStyle}>
        <div style={smallLabelStyle}>Going into</div>
        <div style={goingNameStyle}>{lot.name || 'Untitled seed lot'}</div>
        {facts && <div style={lotLineStyle}>{facts}</div>}
        <button
          type="button" data-testid="seed-add-change-lot" disabled={locked}
          onClick={changeLot} style={{ ...linkRowStyle, opacity: locked ? 0.5 : 1 }}
        >
          Change lot
        </button>
      </div>

      {refile && (
        <div data-testid="seed-add-refile" style={noteStyle}>
          <span style={{ display: 'block' }}>{refile.sentence}</span>
          {refile.notice.map((sentence) => (
            <span key={sentence} style={{ display: 'block', marginTop: 6 }}>{sentence}</span>
          ))}
        </div>
      )}
      {lot.seed_stage === 'stored' && (
        <p data-testid="seed-add-stored" style={noteStyle}>{STORED_LOT_LINE}</p>
      )}

      <label style={{ ...fieldLabelStyle, marginBottom: 0 }}>
        How many seeds are you adding today? <span style={optionalStyle}>(optional)</span>
        {/* No placeholder digit: a grey number reads as an amount already typed. */}
        <input
          type="text" inputMode="numeric" value={count} disabled={locked}
          onChange={(e) => setCount(e.target.value)}
          aria-describedby={outcome ? 'seed-add-outcome' : undefined}
          data-testid="seed-add-count" style={inputStyle}
        />
      </label>
      <div style={locked ? lockedStyle : undefined}>
        <Basis estimated={estimated} onChange={(v) => { if (!locked) setEstimated(v) }} testId="seed-add-estimated" />
      </div>
      {outcome && (
        <p id="seed-add-outcome" data-testid="seed-add-outcome" style={{ ...hintStyle, margin: '0 0 14px' }}>{outcome}</p>
      )}

      <label style={fieldLabelStyle}>
        What does today&apos;s seed weigh? <span style={optionalStyle}>(optional)</span>
        <input
          type="text" inputMode="decimal" value={weight} disabled={locked}
          onChange={(e) => setWeight(e.target.value)}
          aria-describedby="seed-add-weight-note"
          data-testid="seed-add-weight" style={inputStyle}
        />
        <span id="seed-add-weight-note" style={{ ...hintStyle, display: 'block', fontWeight: 400 }}>
          Grams. Type &ldquo;mg&rdquo; after the number for milligrams.
        </span>
      </label>

      {phase === 'checking' && (
        <p role="status" data-testid="seed-add-checking" style={noteStyle}>{ADD_CHECKING}</p>
      )}
      {error && (
        <div role="alert" data-testid="seed-add-error" style={errorStyle}>
          <span>{error}</span>
          {phase === 'unknown' && (
            <button type="button" data-testid="seed-add-retry" onClick={tryAgain} style={retryStyle}>
              Try again
            </button>
          )}
          {needsRead && error === LOTS_FAILED && (
            <button type="button" data-testid="seed-add-reread" onClick={retryRead} style={retryStyle}>
              Try again
            </button>
          )}
        </div>
      )}

      <button
        type="button" onClick={submit} disabled={locked || needsRead}
        data-testid="save-seed-submit" style={primaryBtnStyle(locked || needsRead)}
      >
        {working ? 'Adding…' : 'Add to this lot'}
      </button>
    </div>
  )
}

// Every control is at least T.tapMinHeight tall, read from the token; a lot row is 56, the height the
// sheet's own two-line choices use.
const headingStyle = { margin: '0 0 10px', fontSize: '1rem', fontWeight: 700, color: P.dark, outline: 'none' }
const lotRowStyle = (off) => ({
  display: 'block', width: '100%', textAlign: 'left', marginBottom: 8,
  minHeight: 56, padding: '10px 12px', borderRadius: 10,
  border: `1px solid ${P.border}`, backgroundColor: P.white,
  cursor: off ? 'default' : 'pointer', opacity: off ? 0.55 : 1,
})
const lotNameStyle = { display: 'block', fontWeight: 600, color: P.dark, fontSize: '0.92rem', overflowWrap: 'anywhere' }
const lotLineStyle = { display: 'block', color: P.mid, fontSize: '0.78rem', marginTop: 2, overflowWrap: 'anywhere' }
const dividerStyle = { margin: '6px 0 8px', color: P.mid, fontSize: '0.78rem', lineHeight: 1.5 }
const stateStyle = { margin: '0 0 8px', color: P.mid, fontSize: '0.82rem', lineHeight: 1.5 }
const retryStyle = {
  display: 'block', minHeight: T.tapMinHeight, marginTop: 6, padding: '0 14px', borderRadius: 8,
  border: `1px solid ${P.border}`, backgroundColor: P.white, color: P.green,
  fontSize: '0.86rem', fontWeight: 600, cursor: 'pointer',
}
const linkRowStyle = {
  display: 'block', width: '100%', textAlign: 'left', minHeight: T.tapMinHeight, padding: '0 2px',
  background: 'none', border: 'none', cursor: 'pointer', color: P.green, fontSize: '0.9rem', fontWeight: 600,
}
const goingStyle = { margin: '0 0 14px', outline: 'none' }
const smallLabelStyle = { fontSize: '0.82rem', fontWeight: 600, color: P.mid }
const goingNameStyle = { marginTop: 2, fontSize: '1rem', fontWeight: 600, color: P.dark, overflowWrap: 'anywhere' }
const fieldLabelStyle = { display: 'block', marginBottom: 14, fontSize: '0.82rem', fontWeight: 600, color: P.mid }
const optionalStyle = { color: P.light, fontWeight: 400 }
const inputStyle = {
  display: 'block', width: '100%', minHeight: 48, marginTop: 6, padding: '0 12px',
  borderRadius: 8, border: `1px solid ${P.border}`, fontSize: '1rem', backgroundColor: P.white,
}
const lockedStyle = { opacity: 0.5, pointerEvents: 'none' }
const hintStyle = { margin: '6px 0 0', color: P.mid, fontSize: '0.78rem', lineHeight: 1.5 }
const noteStyle = { margin: '0 0 12px', color: P.mid, fontSize: '0.82rem', lineHeight: 1.5 }
const errorStyle = {
  margin: '0 0 12px', padding: '8px 10px', borderRadius: 8,
  border: `1px solid ${P.alertBorder}`, backgroundColor: P.alert, color: P.dark, fontSize: '0.82rem',
}
const primaryBtnStyle = (disabled) => ({
  width: '100%', minHeight: 48, borderRadius: 10, border: 'none',
  backgroundColor: P.green, color: P.white, fontWeight: 700, fontSize: '0.95rem',
  cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1,
})
