// src/components/seed/SavedFromCard.jsx — V5-SEEDMULTIPARENT-001 release 2b. The lot page's "Saved from",
// for a jar whose PARENT SET is known.
//
// A jar can be gathered off several plantings, so this card lists every one of them (each a door to its
// planting), adds another, takes one away, and keeps the jar FILED under what the set now says: one
// cultivar, or the named mix of several. It renders INSIDE the page's `seed-source-plant` card; the page
// keeps the heading, the arrival ref and the origin select below.
//
// EVERY CHANGE IS ONE WRITE. PUT /api/inventory-items/:id/source-plants carries the whole set, the set
// this page last read (`expected_source_plant_ids`, always), and — when the change moves the set's
// cultivars — the `filing` that goes with it, in one transaction. A mix has to exist before it can be
// filed under, so POST /api/varieties/blend { create: true } runs first when the set spans more than one
// cultivar; it is idempotent, so a PUT refused after it leaves a row the next try reuses.
//
// ONE SET WRITE AT A TIME. While one runs no row control answers: the likeliest cause of the server's
// "changed at the same moment" is the user's own second tap, and this removes it.
//
// REMOVE IS FORGIVING, IN PLACE. The row stays where it was, struck, reading "<name> · Removed", with
// Undo where the ✕ was, until the page is left. Undo puts the planting back into the set as it stands
// now and asks for the cache the jar had before. A removed plant's `seed_saved` timeline entry is
// withdrawn only on LEAVING with the row still struck (see the unmount effect), so Undo never has an
// entry to restore.
//
// AN ADD WRITES THE PLANT ITS ENTRY (V5-SEEDLOTADDENTRY-001; Dave 2026-10-07). The Save seed sheet
// writes one `seed_saved` entry per parent; a plant added HERE got none, so a plant removed, withdrawn
// and added back had lost its line for good, and a corrected jar could have a line on no plant. A fresh
// add (never an Undo, whose entry was never withdrawn) now writes that plant one entry for this jar,
// dated the day the jar was started, unless it still has a live one. It runs after the set write and
// is never waited for, with one exception: a later change to THAT plant waits for it, because the
// server pays an entry's rewards per jar only while its plant is on the jar
// (lambda/events/seedLotRewards.js). Taking the add back takes the entry it wrote back too.
//
// `lot` is the page's item with `name` as the page's NAME FIELD SHOWS IT NOW: the jar is renamed with a
// re-file only while that name is still the automatic one (rowTitle's test), and a name being typed is
// left alone. `onLot(patch)` merges the stored answer into the page's item; `onName(name)` moves the
// page's name field and its baseline, so the page's own Save cannot write the old name back. `notice` is
// optional: one line the page wants said in this card's help slot (the legacy write's "changed somewhere
// else", from the moment the set first became readable). Anything this card has to say comes first.
// `storedName` is the jar's name as the server last confirmed it (at load, after the page's own Save,
// after a re-file, after a re-read): an entry's note is permanent, so it never quotes a name that is
// only typed, nor one a save or a change elsewhere has since replaced.
import React, { useState, useRef, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useApiFetch } from '../../lib/api.js'
import { useToast } from '../../context/ToastContext.jsx'
import { P } from '../../lib/constants.js'
import { toLocalISO, todayLocalISO } from '../../lib/dateLocal.js'
import { T, inputChrome } from '../forms/formStyles.js'
import PlantingSelect from '../forms/PlantingSelect.jsx'
import { parentSetFacts, sourcePlantFromPlanting } from './seedParents.js'
import { rowTitle } from './mySeedsModel.js'
import { seedCountLabel } from './seedLots.js'
import { addToLotAvailable } from './seedAdditions.js'

// Undo ignores taps this long after it appears, so a double tap on ✕ does not undo itself.
export const UNDO_ARM_MS = 400

// Exported: the page's one remaining legacy parent write says the same two things (InventoryDetail).
export const CHANGED_ELSEWHERE = 'This lot changed somewhere else just now. This is the latest. Try again if it still needs changing.'
export const NOT_SAVED = "Couldn't save that. Nothing was changed."
// A set write that never answered (a timeout, or a connection that dropped with the request already
// out) may have landed with only its reply lost, so "nothing was changed" would be a guess. The jar is
// read again; this is what is said when that read fails too.
const NOT_CONFIRMED = "That didn't finish, so the change may or may not have saved. Open this lot again to check before you try again."
// The service worker's mark on a reply it served from its offline copy (src/lib/api.js). Such a copy
// is never "the latest".
const FROM_CACHE = Symbol.for('garden-app.fromCache')
// The client's own sentence per refusal code. Never the server's string.
const NOT_ADDED = {
  mixed_crop_parents: "That planting is a different crop, so it wasn't added.",
  parent_without_variety: "That planting has no variety recorded, so it wasn't added.",
}
const COUNT_NOT_A_NUMBER = 'A plant count is a whole number, 1 or more.'
const COUNT_NOT_SAVED = "Couldn't record the plant count."
const EMPTY_HELP = 'The plant this seed was saved from. Leave it empty for bought seed.'
// The page's own sentence for a failed picker load, unchanged.
const LOAD_FAILED = "Couldn't load your plantings — the rest of this page still saves normally."

// What a refetch may move on the page's item: the parent set, its cache, the filing and the count.
export const LOT_KEYS = ['source_plant_id', 'source_plants', 'variety_id', 'variety_name', 'variety_rank',
  'breeding_system', 'name', 'seed_parent_plant_count']

const sid = (v) => String(v ?? '')
const sameIds = (a, b) => a.length === b.length && a.every((v, i) => sid(v) === sid(b[i]))
const insertAt = (list, item, at) => {
  const out = list.slice()
  out.splice(Math.max(0, Math.min(at, out.length)), 0, item)
  return out
}
// O-4: a planting whose variety is gone (no id, or an id whose row is soft-deleted and so has no name)
// is a planting with no variety.
const hasNoVariety = (p) => p.variety_id == null || p.variety_name == null

// The year of a name that is still the automatic one, else null. rowTitle answers the variety only for
// a saved lot still on its default name ("<variety> — saved <year>" or "Saved seed <year>"); the origin
// marker makes the question about the name alone. Both defaults end in the year.
function automaticYear(varietyName, name) {
  const variety = String(varietyName ?? '').trim()
  const shown = String(name ?? '').trim()
  if (!variety || !shown || shown === variety) return null
  if (rowTitle({ variety_name: variety, name: shown, source_kind: 'own_garden' }) !== variety) return null
  return shown.slice(-4)
}

// The planting's live entries, ALL of them. The route answers its newest 200 by entry date, and an
// entry an add writes is dated the jar's start day, so on a busy planting it sits past the first page
// from the moment it is written (prod 2026-10-08: two plantings over 200, the busiest at 246). The
// first request is the one this card has always sent (a bare array); only a full page asks for more,
// by `offset`, which the route answers as { events, has_more }. A failed FIRST read rejects. After
// that it answers what it has: `complete` is false when a later page failed, came from the offline
// copy (`fromCache`: such a copy is never the latest, on any page), or the cap was reached with more
// to read. The withdrawal acts on what was read; the add writes only on a complete list.
const EVENTS_PAGE = 200
// 5,000 entries: no planting is near it, and a route that kept answering full pages must not spin.
const EVENTS_MAX_PAGES = 25
async function plantEntries(fetch, plantId) {
  const base = `/api/events?plant_id=${encodeURIComponent(plantId)}&limit=${EVENTS_PAGE}`
  const first = await fetch(base)
  const list = (Array.isArray(first) ? first : Array.isArray(first?.events) ? first.events : []).slice()
  if (first?.[FROM_CACHE] === true) return { list, fromCache: true, complete: false }
  let more = list.length >= EVENTS_PAGE
  for (let page = 1; more; page += 1) {
    if (page >= EVENTS_MAX_PAGES) return { list, fromCache: false, complete: false }
    let next
    try {
      next = await fetch(`${base}&offset=${page * EVENTS_PAGE}`)
    } catch {
      return { list, fromCache: false, complete: false }
    }
    if (next?.[FROM_CACHE] === true) return { list, fromCache: true, complete: false }
    const rows = Array.isArray(next?.events) ? next.events : Array.isArray(next) ? next : []
    list.push(...rows)
    more = next?.has_more === true && rows.length > 0
  }
  return { list, fromCache: false, complete: true }
}

// O-11 — withdraw a removed plant's `seed_saved` entries for this jar. Fired once, never awaited, every
// failure silent: the entry links to the jar, which shows the live answer, so a missed withdrawal is a
// stale line and not a wrong one. None found is success.
function withdrawSeedSaved(fetch, plantId, lotId) {
  Promise.resolve()
    .then(() => plantEntries(fetch, plantId))
    .then(({ list }) => {
      for (const ev of list) {
        if (!isSeedSavedFor(ev, lotId)) continue
        Promise.resolve()
          .then(() => fetch(`/api/events/${ev.id}`, { method: 'DELETE' }))
          .catch(() => {})
      }
    })
    .catch(() => {})
}

const isSeedSavedFor = (ev, lotId) =>
  ev?.event_type === 'seed_saved' && sid(ev?.metadata?.seed_lot_id) === sid(lotId)

// The note on an entry an add from this page writes. Only what stays true: the sheet's own note also
// states a stage and "No count yet", which a jar met later may have left behind.
export const addedSeedSavedNote = (lotName) => `Seed lot "${String(lotName ?? '').trim()}".`

// The day the jar was started, as a local date: the day its seed came off the plants, and the date the
// sheet's entries for it carry. No readable created_at: today.
export function lotStartDay(lot) {
  const at = lot?.created_at ? new Date(lot.created_at) : null
  return at && !Number.isNaN(at.getTime()) ? toLocalISO(at) : todayLocalISO()
}

// V5-SEEDLOTADDENTRY-001 — the `seed_saved` entry for a plant added from this page. Resolves to the id
// of the entry it wrote, or null when it wrote none: the plant still has a live one for this jar, the
// list came from the offline copy (which cannot say, and with no network the write fails anyway), or
// anything failed (a list that is not `complete` cannot say, whichever page stopped it).
// Never rejects and says nothing: the plant is on the jar either way. Same list as the withdrawal.
function writeSeedSaved(fetch, plantId, lotId, day, note) {
  return Promise.resolve()
    .then(() => plantEntries(fetch, plantId))
    .then(({ list, complete }) => {
      if (!complete) return null
      if (list.some((ev) => isSeedSavedFor(ev, lotId))) return null
      return fetch('/api/events', {
        method: 'POST',
        body: JSON.stringify({
          plant_id: plantId,
          event_type: 'seed_saved',
          event_date: day,
          notes: note,
          metadata: { seed_lot_id: lotId },
        }),
      }).then((ev) => ev?.id ?? null)
    })
    .catch(() => null)
}

export default function SavedFromCard({ lot, onLot, onName, storedName = null, notice: pageNotice = null }) {
  const { fetch } = useApiFetch()
  const { show } = useToast()
  const lotId = lot.id

  const facts = useMemo(() => parentSetFacts(lot.source_plants), [lot.source_plants])
  const serverPlants = facts.plantings

  // One set write in flight. The ref is the guard (two taps in one tick read it before a render); the
  // state is what the card draws.
  const busyRef = useRef(false)
  const [busy, setBusy] = useState(false)
  // Plant id -> the entry write an add on this visit started (a promise of its id, or of null).
  const wroteRef = useRef(new Map())
  // The set the write in flight will leave, drawn at once; null between writes.
  const [pending, setPending] = useState(null)
  // Rows removed on this visit: { plant, index, liveIndex, before, filing, armedAt, confirmed }.
  const [struck, setStruck] = useState([])
  // The latest re-file: { name, act }. Lasts until the page is left, or its Undo.
  const [filed, setFiled] = useState(null)
  const [notice, setNotice] = useState(null)
  const [adding, setAdding] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  // The polite announcement: the word a struck row carries, said once when it appears.
  const [said, setSaid] = useState('')

  const storedCount = lot.seed_parent_plant_count == null ? null : Number(lot.seed_parent_plant_count)
  const [countText, setCountText] = useState(storedCount == null ? '' : String(storedCount))
  const [countBusy, setCountBusy] = useState(false)
  useEffect(() => { setCountText(storedCount == null ? '' : String(storedCount)) }, [storedCount])

  const live = pending ?? serverPlants
  // Live rows in the server's order, each struck row back where it stood.
  const rows = useMemo(() => {
    const out = live.map((plant) => ({ plant, gone: null }))
    const liveIds = new Set(live.map((p) => sid(p.id)))
    for (const s of struck.slice().sort((a, b) => a.index - b.index)) {
      if (liveIds.has(sid(s.plant.id))) continue
      out.splice(Math.min(s.index, out.length), 0, { plant: s.plant, gone: s })
    }
    return out
  }, [live, struck])

  // X7 — the adder's crop is the set's one shared crop. No crop (a planting with no variety, O-4
  // included) means every add would be refused, so the adder is not offered and the card says why.
  const orphan = live.find(hasNoVariety) ?? null
  const liveFacts = useMemo(() => parentSetFacts(live), [live])
  const cropSlug = !orphan && typeof liveFacts.cropSlug === 'string' ? liveFacts.cropSlug : null
  const rowKey = rows.map((r) => sid(r.plant.id)).join(',')
  // Stable while the rows are: PlantingSelect lists it in a memo's deps.
  const excludeIds = useMemo(() => (rowKey ? rowKey.split(',') : []), [rowKey])

  // ── Leaving with a row still struck (O-11) ─────────────────────────────────────────────────────────
  // Unmount only: a route change, the lot reloading, or an origin that takes the parent picker away.
  // A removal the server never confirmed is not withdrawn, and neither is a deleted planting's (its
  // event list answers 404).
  const leaveRef = useRef({ struck, fetch, lotId })
  leaveRef.current = { struck, fetch, lotId }
  useEffect(() => () => {
    const at = leaveRef.current
    for (const s of at.struck) {
      if (s.confirmed && !s.plant.deleted) withdrawSeedSaved(at.fetch, s.plant.id, at.lotId)
    }
  }, [])

  // Either 409, or a set write that never answered: read the jar again, in place, and draw what it
  // says. A struck row whose plant is back on the jar is no longer struck; a "Filed as" line described
  // a jar that has since moved.
  async function refresh() {
    try {
      const fresh = await fetch('/api/inventory-items/' + lotId)
      if (!fresh || !Array.isArray(fresh.source_plants) || fresh[FROM_CACHE] === true) return false
      const patch = {}
      for (const k of LOT_KEYS) if (Object.prototype.hasOwnProperty.call(fresh, k)) patch[k] = fresh[k]
      onLot(patch)
      // The name field follows only while it still shows an automatic name.
      if (typeof fresh.name === 'string' && fresh.name !== lot.name && automaticYear(lot.variety_name, lot.name)) {
        onName(fresh.name)
      }
      const back = new Set(fresh.source_plants.filter(Boolean).map((p) => sid(p.id)))
      setStruck((list) => list.filter((s) => !back.has(sid(s.plant.id))))
      setFiled(null)
      return true
    } catch {
      return false
    }
  }

  // ── The one set write ──────────────────────────────────────────────────────────────────────────────
  // `kind` is what happens to `plant`; `undo` is the earlier act this one reverses (a struck row's, or
  // the "Filed as" line's, which sets `fromFiled`), null for a fresh add or remove.
  async function run({ kind, plant, index = 0, undo = null, fromFiled = false }) {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setNotice(null)

    const cur = serverPlants
    const pid = sid(plant.id)
    const next = kind === 'remove'
      ? cur.filter((p) => sid(p.id) !== pid)
      : insertAt(cur, plant, undo ? undo.liveIndex : cur.length)
    const nextFacts = parentSetFacts(next)
    const before = {
      variety_id: lot.variety_id ?? null, variety_name: lot.variety_name ?? null,
      variety_rank: lot.variety_rank ?? null, breeding_system: lot.breeding_system ?? null,
      cache: lot.source_plant_id ?? null, varietyIds: facts.varietyIds,
    }
    const liveIndex = cur.findIndex((p) => sid(p.id) === pid)
    // A fresh removal strikes its row now; an Undo of an add simply takes the row away again.
    const strikes = kind === 'remove' && !undo
    if (strikes) {
      setStruck((list) => [...list.filter((s) => sid(s.plant.id) !== pid),
        { plant, index, liveIndex, before, filing: null, armedAt: Date.now() + UNDO_ARM_MS, confirmed: false }])
      setSaid(`${plant.name} · Removed`)
    }
    setPending(next)
    // True once the set write itself is out: only then can a failure have changed the jar.
    let sent = false

    try {
      // This plant's own entry write, when an add on this visit started one, settles before the set
      // moves under it (see the header). It never rejects.
      const own = wroteRef.current.get(pid)
      if (own) await own

      // ── The filing that rides with this change (O-3) ─────────────────────────────────────────────
      // An Undo of the very act that re-filed the jar goes back to what the server said was there
      // (`previous`), name included when that act renamed it and the field still shows that name.
      // Anything else is filed by what the resulting set says, and only when the set's cultivars moved.
      // A jar with no parents, before or after, is never sent a filing (PP-11), with one exception: an
      // Undo that puts a planting back onto a jar this visit emptied. The jar may by then be filed
      // under the OTHER removed planting's cultivar, and the server does not judge a one-plant set.
      let filing = null
      let target = null
      const shown = String(lot.name ?? '').trim()
      const exact = undo?.filing?.changed === true
        && sid(lot.variety_id) === sid(undo.filing.variety_id)
        && sameIds(nextFacts.varietyIds, undo.before.varietyIds)
      if (exact) {
        filing = { variety_id: undo.filing.previous.variety_id, expect_variety_id: lot.variety_id }
        if (undo.filing.name !== undo.filing.previous.name && shown === undo.filing.name) {
          filing.name = undo.filing.previous.name
        }
        target = undo.before
      } else if ((cur.length > 0 || undo) && next.length > 0 && nextFacts.varietyIds.length > 0
          && !sameIds(facts.varietyIds, nextFacts.varietyIds)) {
        if (nextFacts.varietyIds.length === 1) {
          // O-4: an id with no name is a variety since deleted. A jar cannot be filed under it (the
          // server refuses the whole edit), so the set changes alone and the filing stays as it is.
          const one = nextFacts.varieties.find((v) => v.variety_id != null)
          if (one.variety_name != null) {
            target = { variety_id: one.variety_id, variety_name: one.variety_name, breeding_system: one.breeding_system }
          }
        } else {
          const mix = await fetch('/api/varieties/blend', {
            method: 'POST',
            body: JSON.stringify({ component_variety_ids: nextFacts.varietyIds, create: true }),
          })
          target = { variety_id: mix.id, variety_name: mix.name, breeding_system: null }
        }
        if (target && sid(target.variety_id) !== sid(lot.variety_id)) {
          filing = { variety_id: target.variety_id, expect_variety_id: lot.variety_id }
          const year = automaticYear(lot.variety_name, shown)
          const named = String(target.variety_name ?? '').trim()
          if (year && named) filing.name = `${named} — saved ${year}`
        }
      }

      const body = {
        source_plant_ids: next.map((p) => p.id),
        expected_source_plant_ids: cur.map((p) => p.id),
      }
      // The cache hint must be a member of the set being written.
      if (undo && undo.before.cache != null && next.some((p) => sid(p.id) === sid(undo.before.cache))) {
        body.source_plant_id = undo.before.cache
      }
      if (filing) body.filing = filing

      sent = true
      const reply = await fetch(`/api/inventory-items/${lotId}/source-plants`, {
        method: 'PUT',
        body: JSON.stringify(body),
      })

      const stored = Array.isArray(reply?.source_plants) ? reply.source_plants.filter(Boolean) : next
      const patch = { source_plant_id: reply?.source_plant_id ?? null, source_plants: stored }
      const refiled = reply?.filing?.changed === true ? reply.filing : null
      if (refiled) {
        patch.variety_id = refiled.variety_id
        patch.variety_name = refiled.variety_name
        patch.variety_rank = refiled.variety_rank
        patch.name = refiled.name
        patch.breeding_system = target?.breeding_system ?? null
      }
      onLot(patch)
      // Only a name this write sent moves the page's field: a name being typed is the user's.
      if (refiled && filing?.name != null) onName(refiled.name)

      const storedIds = new Set(stored.map((p) => sid(p.id)))
      setStruck((list) => list
        .filter((s) => !storedIds.has(sid(s.plant.id)))
        .map((s) => (strikes && sid(s.plant.id) === pid ? { ...s, filing: refiled, confirmed: true } : s)))
      // A re-file this write made by itself is the new line. An exact reversal, or the line's own
      // Undo however it was filed, leaves nothing to say.
      if (refiled && !exact) setFiled({ name: refiled.variety_name, act: { kind, plant, liveIndex, before, filing: refiled } })
      else if (exact || fromFiled) setFiled(null)
      setAdding(false)
      if (kind === 'add' && !undo) show({ message: '✓ Saved' })

      // ── The plant's timeline entry (V5-SEEDLOTADDENTRY-001) ──────────────────────────────────────
      // Only once the server holds the plant on the jar. An add taken back (the "Filed as" line's
      // Undo: nothing is struck, so leaving would withdraw nothing) takes back the entry it wrote.
      if (kind === 'add' && !undo && storedIds.has(pid)) {
        wroteRef.current.set(pid, writeSeedSaved(fetch, plant.id, lotId, lotStartDay(lot),
          addedSeedSavedNote(refiled?.name ?? storedName ?? lot.name)))
      } else if (kind === 'remove' && undo && own && !storedIds.has(pid)) {
        // Kept in the map, settling to null: adding the plant again waits for the entry to be gone
        // before it looks for one.
        wroteRef.current.set(pid, own
          .then((id) => (id ? fetch(`/api/events/${id}`, { method: 'DELETE' }) : null))
          .then(() => null, () => null))
      }
    } catch (e) {
      // A refusal writes nothing (one transaction, one verdict), so the row goes back to how it was
      // before the tap. A reply lost on the way (api.js: `timeout` on its own 15 s limit, the
      // browser's TypeError with no `status` for a dropped connection) is the one case the page cannot
      // see, so it claims nothing: the jar is read again and drawn as stored. When that read fails
      // too, the next write's `expected_source_plant_ids` answers lot_changed and reads it then.
      if (strikes) setStruck((list) => list.filter((s) => sid(s.plant.id) !== pid))
      const code = e?.body?.code
      const unanswered = sent && (e?.timeout || (e?.status == null && e instanceof TypeError))
      if (e?.status === 409 && (code === 'lot_changed' || code === 'parents_changed')) {
        setNotice((await refresh()) ? CHANGED_ELSEWHERE : NOT_SAVED)
      } else if (unanswered) {
        setNotice((await refresh()) ? CHANGED_ELSEWHERE : NOT_CONFIRMED)
      } else {
        setNotice((kind === 'add' && NOT_ADDED[code]) || NOT_SAVED)
      }
    } finally {
      busyRef.current = false
      setBusy(false)
      setPending(null)
    }
  }

  function add(planting) {
    if (!planting || busyRef.current) return
    run({ kind: 'add', plant: sourcePlantFromPlanting(planting) })
  }

  function remove(row, index) {
    run({ kind: 'remove', plant: row.plant, index })
  }

  function undoRemove(s) {
    if (busyRef.current || Date.now() < s.armedAt) return
    run({ kind: 'add', plant: s.plant, undo: s })
  }

  // The "Filed as" line's Undo reverses the act that re-filed the jar: the planting it added comes off,
  // or the planting it removed goes back, with the filing in the same write. When that planting has
  // since moved by another route there is nothing left to reverse, and the line just goes.
  function undoFiled() {
    if (busyRef.current || !filed) return
    const { act } = filed
    const onJar = serverPlants.some((p) => sid(p.id) === sid(act.plant.id))
    if ((act.kind === 'add') !== onJar) { setFiled(null); return }
    run({ kind: act.kind === 'add' ? 'remove' : 'add', plant: act.plant, undo: act, fromFiled: true })
  }

  // ── The plant count: written when the field is left, on its own route ──────────────────────────────
  // Blank clears it. A 200 without the key is a Lambda from before the column: nothing was saved.
  async function saveCount() {
    const typed = countText.trim()
    const value = typed === '' ? null : /^\d+$/.test(typed) ? Number(typed) : NaN
    if (value !== null && !(value >= 1 && value <= 9999)) { setNotice(COUNT_NOT_A_NUMBER); return }
    if (value === storedCount) {
      setNotice((n) => (n === COUNT_NOT_A_NUMBER || n === COUNT_NOT_SAVED ? null : n))
      return
    }
    setCountBusy(true)
    setNotice(null)
    try {
      const reply = await fetch(`/api/inventory-items/${lotId}/seed-measure`, {
        method: 'PUT',
        body: JSON.stringify({ seed_parent_plant_count: value }),
      })
      if (!reply || !Object.prototype.hasOwnProperty.call(reply, 'seed_parent_plant_count')) throw new Error('not saved')
      onLot({ seed_parent_plant_count: reply.seed_parent_plant_count ?? null })
      show({ message: '✓ Saved' })
    } catch {
      setNotice(COUNT_NOT_SAVED)
    } finally {
      setCountBusy(false)
    }
  }

  const stillSays = addToLotAvailable() && struck.length > 0
    ? seedCountLabel(lot.seed_count, lot.seed_count_estimated) : ''
  const working = busy || countBusy
  const problem = notice ?? pageNotice ?? null
  const help = problem
    ?? (loadFailed ? LOAD_FAILED
      : working ? 'Saving…'
      : live.length === 0 ? EMPTY_HELP : null)
  const showCount = live.length > 0 || storedCount != null
  const held = busy ? { opacity: 0.5 } : null

  return (
    <>
      <span role="status" aria-live="polite" data-testid="saved-from-live" style={SR_ONLY}>{said}</span>

      {rows.length > 0 && (
        <div style={rowList}>
          {rows.map((row, i) => {
            const { plant, gone } = row
            if (gone) {
              return (
                <div key={sid(plant.id)} data-testid="saved-from-row" data-struck="true" style={rowChrome}>
                  <span style={struckText}>
                    <span style={{ textDecoration: 'line-through' }}>{plant.name}</span>{' · Removed'}
                  </span>
                  {/* A deleted planting cannot be put back: the server would only refuse it. */}
                  {!plant.deleted && (
                    <button
                      type="button" data-testid="saved-from-undo"
                      aria-label={`Undo removing ${plant.name}`} aria-disabled={busy || undefined}
                      onClick={() => undoRemove(gone)}
                      style={{ ...undoButton, ...held }}
                    >
                      Undo
                    </button>
                  )}
                </div>
              )
            }
            return (
              <div key={sid(plant.id)} data-testid="saved-from-row" style={rowChrome}>
                {/* A deleted planting is named but is not a door: its page is gone. */}
                {plant.deleted ? (
                  <span style={rowName}>{plant.name}</span>
                ) : (
                  <Link to={`/plantings/${plant.id}`} data-testid="saved-from-link" style={rowLink}>
                    <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{plant.name}</span>
                    <span aria-hidden="true" style={{ flexShrink: 0, fontSize: '1.1rem' }}>›</span>
                  </Link>
                )}
                <button
                  type="button" data-testid="saved-from-remove"
                  aria-label={`Remove ${plant.name}`} aria-disabled={busy || undefined}
                  onClick={() => remove(row, i)}
                  style={{ ...removeButton, ...held }}
                >
                  <span aria-hidden="true">✕</span>
                </button>
              </div>
            )
          })}
        </div>
      )}

      {/* V5-SEEDLOTADDITION-001 — taking a plant off the lot does not take its seed out of the count:
          the count is one number for the whole lot, and what was added off each plant is kept with
          the plant's link, not subtracted. So while a row is struck the card says what the lot still
          says and leaves the number to the person who knows. Nothing to say for a lot with no count;
          gone with the strike on Undo. */}
      {stillSays && (
        <p data-testid="saved-from-still-says" role="status" style={quietLine}>
          The lot still says {stillSays}. Change the count if that is no longer right.
        </p>
      )}

      {filed && (
        <div data-testid="saved-from-filed" role="status" style={filedLine}>
          <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>Filed as {filed.name}</span>
          <button
            type="button" data-testid="saved-from-filed-undo"
            aria-label={`Undo filing as ${filed.name}`} aria-disabled={busy || undefined}
            onClick={undoFiled}
            style={{ ...undoButton, ...held }}
          >
            Undo
          </button>
        </div>
      )}

      {/* No parents yet: the picker itself, pinned to the jar's own cultivar, as before this release. */}
      {live.length === 0 && (
        <PlantingSelect
          id="inv-source-plant"
          value=""
          onChange={(pid, planting) => { if (pid) add(planting) }}
          varietyId={lot.variety_id}
          labelFormat="wave"
          emptyMeaning="none"
          required={false}
          onLoadError={() => setLoadFailed(true)}
          aria-label="Saved from which plant"
          data-testid="source-plant-select"
        />
      )}

      {live.length > 0 && cropSlug && (adding ? (
        <PlantingSelect
          id="inv-source-plant-add"
          value=""
          onChange={(pid, planting) => { if (pid) add(planting) }}
          cropSlug={cropSlug}
          excludeIds={excludeIds}
          emptyText="No other plantings of this crop to add."
          labelFormat="wave"
          required={false}
          autoOpen
          onLoadError={() => setLoadFailed(true)}
          aria-label="Add seed from another plant"
          data-testid="saved-from-add-select"
        />
      ) : (
        <button
          type="button" data-testid="saved-from-add" aria-disabled={busy || undefined}
          onClick={() => { if (!busyRef.current) setAdding(true) }}
          style={{ ...addButton, ...held }}
        >
          + Add seed from another plant
        </button>
      ))}

      {live.length > 0 && orphan && (
        <p data-testid="saved-from-no-variety" style={quietLine}>
          {orphan.name} has no variety recorded, so another planting can&apos;t be added to this lot.
        </p>
      )}

      {live.length >= 2 && (
        <p data-testid="saved-from-mixed" style={quietLine}>
          {live.length === 2
            ? 'Mixed together. A seed from this lot could be from either planting.'
            : 'Mixed together. A seed from this lot could be from any of these plantings.'}
        </p>
      )}

      {showCount && (
        <label style={countLine}>
          <span>Seed off about</span>
          <input
            type="text" inputMode="numeric" maxLength={4}
            data-testid="saved-from-plant-count"
            aria-label="About how many plants"
            value={countText}
            onChange={(e) => setCountText(e.target.value)}
            onBlur={saveCount}
            style={countField}
          />
          <span>plants</span>
        </label>
      )}

      {help && (
        <p data-testid="source-plant-help" role="status" style={{ ...helpLine, color: problem ? P.terra : P.light }}>
          {help}
        </p>
      )}
    </>
  )
}

const SR_ONLY = {
  position: 'absolute', width: 1, height: 1, margin: -1, padding: 0,
  overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0,
}
const rowList = { display: 'flex', flexDirection: 'column', gap: T.space.xs }
const rowChrome = { display: 'flex', alignItems: 'center', gap: T.space.sm, minHeight: T.buttonMinHeight }
const rowLink = {
  flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: T.space.sm,
  minHeight: T.buttonMinHeight, color: P.green, fontWeight: 600, fontSize: T.type.base, textDecoration: 'none',
}
const rowName = { flex: 1, minWidth: 0, overflowWrap: 'anywhere', color: P.dark, fontWeight: 600, fontSize: T.type.base }
const struckText = { flex: 1, minWidth: 0, overflowWrap: 'anywhere', color: P.mid, fontSize: T.type.base }
const removeButton = {
  flexShrink: 0, width: T.buttonMinHeight, minHeight: T.buttonMinHeight,
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  backgroundColor: 'transparent', color: P.mid, border: `1px solid ${P.border}`,
  borderRadius: T.radiusButton, fontSize: T.type.lg, fontFamily: 'inherit', cursor: 'pointer',
}
const undoButton = {
  flexShrink: 0, minHeight: T.buttonMinHeight, padding: '0 14px',
  backgroundColor: 'transparent', color: P.green, border: `1px solid ${P.border}`,
  borderRadius: T.radiusButton, fontSize: T.type.base, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
}
const addButton = {
  width: '100%', minHeight: T.buttonMinHeight, padding: '0 14px', textAlign: 'left',
  backgroundColor: 'transparent', color: P.green, border: `1px dashed ${P.border}`,
  borderRadius: T.radiusButton, fontSize: T.type.base, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
}
const filedLine = {
  display: 'flex', alignItems: 'center', gap: T.space.sm, minHeight: T.buttonMinHeight,
  color: P.dark, fontSize: T.type.base, fontWeight: 600,
}
const quietLine = { margin: 0, color: P.mid, fontSize: T.type.sm, lineHeight: 1.5 }
const countLine = { display: 'flex', alignItems: 'center', gap: T.space.sm, color: P.dark, fontSize: T.type.base }
const countField = { ...inputChrome(false), width: 76, minHeight: T.buttonMinHeight, textAlign: 'center' }
const helpLine = { margin: 0, fontSize: '0.78rem', lineHeight: 1.5 }
