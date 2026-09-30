// src/components/pantry/putSomethingUp.js
// Put-Up B′ release 2 (V4 §2.2 "Put something up" and "Walk a place", §3.1, §6.3, Appendix B) — the
// pure half of the two doors that add stock one thing at a time: which method chips a place offers,
// when "As is" is offered and what it is called, which table a save goes to, the preview line, and the
// one request body per route. PutSomethingUpSheet.jsx and WalkPlace.jsx paint these.
//
// THE ONE TABLE RULE (V4 §2.1): if the household applied a method it is a put-up (POST /api/preservation),
// whatever the source; As is — bought, fresh or leftovers — is a pantry item (POST /api/pantry/items).
// The person never picks a table; the method chip does.
//
// THE PREVIEW (§3.1): before Save, one line with the put-up date it uses and the discard date with its
// basis, computed by putItUp.js previewDiscard — the SAME engine module (lambda/preservation/shelfLife.js)
// the create route resolves with, so the date shown is the date stored. The completion line afterwards
// is built from what the server answered, never from this preview.
import {
  ALL_PUT_UP_METHODS, METHOD_LABELS, estimateChips, previewDiscard, resolveWhen,
} from '../putup/putItUp.js'
import { putUpDateWords, shortDay, parseYmd, toYmd, discardWords, ESTIMATED_PRECISIONS } from '../putup/jarWords.js'

export const AS_IS = 'as_is'
export const AS_IS_LABEL = 'As is'
export const FRESH_LABEL = 'Fresh, as picked'
export const DOOR_TITLE = 'Put something up'
export const DOOR_CTA = 'Put something up'
export const DOOR_SHEET = 'putsomethingup'
export const METHOD_REQUIRED_TEXT = 'How was it put up? Pick one — or As is.'
export const WHAT_REQUIRED_TEXT = 'What is it? Type a name.'
export const WHERE_REQUIRED_TEXT = 'Where does it live? Pick a place.'

const FREEZER_KINDS = new Set(['deep_freezer', 'fridge_freezer'])

// Appendix B "Method chips on Put something up and the Walk, by place kind" — ≤ 4, a fixed seed order.
export const PLACE_KIND_METHODS = Object.freeze({
  deep_freezer: ['whole_freeze', 'blanch_freeze', 'roast_freeze', 'pesto'],
  fridge_freezer: ['whole_freeze', 'blanch_freeze', 'roast_freeze', 'pesto'],
  fridge: ['quick_pickle', 'hot_sauce', 'ferment', 'pesto'],
  pantry: ['can_water_bath', 'jam_preserve', 'dehydrate', 'cure_store'],
  cold_storage: ['cold_store', 'cure_store', 'can_water_bath', 'ferment'],
  other: ['cure_store', 'dehydrate', 'candy'],
})

export function isPlantingHit(what) { return what?.source === 'planting' && !!what?.plant_id }

// { chips, more, asIs } for a place kind and a What. `asIs` is the no-method chip's label, or null when
// it is not offered: at a freezer a planting hit shows methods and More… only (the first chip is Freeze
// whole), while "As is" stays there for other hits (bought frozen food). For a planting hit anywhere
// else it reads "Fresh, as picked". No place yet → no seeded chips; everything is under More….
export function methodChoices({ placeKind = null, what = null } = {}) {
  const chips = PLACE_KIND_METHODS[placeKind] ?? []
  const more = ALL_PUT_UP_METHODS.filter(m => !chips.includes(m))
  const planting = isPlantingHit(what)
  const asIs = planting && FREEZER_KINDS.has(placeKind) ? null : (planting ? FRESH_LABEL : AS_IS_LABEL)
  return { chips, more, asIs }
}

export function methodLabel(method, what = null) {
  if (method === AS_IS) return isPlantingHit(what) ? FRESH_LABEL : AS_IS_LABEL
  return METHOD_LABELS[method] ?? method
}

export function routeFor(method) {
  if (!method) return null
  return method === AS_IS ? 'item' : 'jar'
}

// "Save · frozen", "Save · as is" — the button names the result (V4 §2.2).
const SAVE_WORDS = {
  whole_freeze: 'frozen', blanch_freeze: 'frozen', roast_freeze: 'frozen', dehydrate: 'dried', powder: 'dried',
  can_water_bath: 'canned', can_pressure: 'canned', ferment: 'fermenting', ferment_mash: 'fermenting',
  quick_pickle: 'pickled', candy: 'candied', cure_store: 'curing', cold_store: 'in cold store',
}
export function saveLabel(method, what = null) {
  if (!method) return 'Save'
  if (method === AS_IS) return isPlantingHit(what) ? 'Save · fresh' : 'Save · as is'
  return `Save · ${SAVE_WORDS[method] ?? (METHOD_LABELS[method] ?? method).toLowerCase()}`
}

// ── When ─────────────────────────────────────────────────────────────────────────────────────────
// The door: Today by default; Yesterday / Earlier… under More (putItUp.resolveWhen, §3.6 windows).
export function doorWhen({ chip = 'today', estimate = null, pickedDate = '', now = new Date() } = {}) {
  return resolveWhen({ chip, estimate, pickedDate, now })
}

// The Walk: one date per sitting from the §3.6 estimate chips, Not sure included. Not sure stores the
// walk day with precision `unknown` (§3.6) — that jar gets no table or house date (§3.1).
export const WALK_NOT_SURE = { id: 'unsure', label: 'Not sure' }
export function walkWhenChips(now = new Date()) {
  return [...estimateChips(now), WALK_NOT_SURE]
}
export function walkWhen({ choice, pickedDate = '', now = new Date() } = {}) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (!choice) return { error: 'Roughly when? Pick one — or Not sure.' }
  if (choice === 'unsure') return { when: { date: toYmd(today), precision: 'unknown' }, words: 'not sure' }
  if (choice === 'pickdate') {
    const d = parseYmd(pickedDate)
    if (!d) return { error: 'Pick the date — or tap Not sure.' }
    if (d.getTime() > today.getTime()) return { error: "That date hasn't happened yet — pick another." }
    return { when: { date: toYmd(d), precision: 'day' }, words: shortDay(d, now) }
  }
  const c = estimateChips(now).find(x => x.id === choice)
  if (!c || !c.start) return { error: 'Roughly when? Pick one — or Not sure.' }
  return { when: { date: toYmd(c.start), precision: c.precision }, words: putUpDateWords(toYmd(c.start), c.precision, { now }) }
}

// ── The preview line (§3.1) ──────────────────────────────────────────────────────────────────────
// `discard`: { mode: 'auto' | 'none' | 'date', date }. A put-up resolves auto through the engine; a
// bought item has a discard date only if one is typed.
export function previewLine({ method, place, when, discard = { mode: 'auto', date: '' }, now = new Date() }) {
  if (!method || !when) return null
  const dateWords = when.precision === 'unknown' ? 'put up: not sure' : `${method === AS_IS ? 'got it' : 'put up'} ${putUpDateWords(when.date, when.precision, { now })}`
  if (method === AS_IS) {
    if (discard?.mode === 'date') {
      const d = parseYmd(discard.date)
      return d ? `${dateWords} · discard by ${shortDay(d, now)} · set by hand` : `${dateWords} · pick the date from the label`
    }
    return dateWords
  }
  const p = previewDiscard({ row: { place, discard }, method, when: { date: when.date, precision: when.precision }, now })
  return p ? `${dateWords} · ${p.words}` : dateWords
}

// ── Bodies ───────────────────────────────────────────────────────────────────────────────────────
// `what`: { source: 'typed'|'planting'|'put_up'|'pantry_item', name, plant_id?, crop_type_slug?,
// variety_id? }. `place`: a place chip ({id?, kind, label}). `when`: {date, precision}.
function placeKeys(place) {
  if (place?.id) return { storage_location_id: String(place.id) }
  return { place: { kind: place?.kind, label: String(place?.label ?? '').trim() } }
}

// { error, field } for the three required answers (§6.3: what · where · how), else null. A "date from
// the label" chosen with no date is refused rather than silently saved as the worked-out one.
export const DISCARD_DATE_TEXT = 'Pick the date from the label — or tap Work it out.'
export function doorError({ what, place, method, discard = null }) {
  if (!String(what?.name ?? '').trim()) return { error: WHAT_REQUIRED_TEXT, field: 'what' }
  if (!place) return { error: WHERE_REQUIRED_TEXT, field: 'where' }
  if (!method) return { error: METHOD_REQUIRED_TEXT, field: 'method' }
  if (discard?.mode === 'date' && !parseYmd(discard.date)) return { error: DISCARD_DATE_TEXT, field: 'discard' }
  return null
}

// POST /api/preservation (the 1b create). `storageLocationId` is the place's id (a template chip is made
// first, pantryApi.ensurePlaceId). An absent use_by_target is the engine's date; null is "no date · set
// by hand"; a date is his (§3.1, key presence).
export function jarBody({ key, what, storageLocationId, method, when, count = 1, discard, notes = '' }) {
  const n = Number(count)
  const body = {
    idempotency_key: key,
    label: String(what.name).trim(),
    method,
    preserved_at: when.date,
    preserved_at_precision: when.precision,
    preserved_at_approx: when.precision !== 'day' && when.precision !== 'exact',
    package_count: Number.isInteger(n) && n >= 1 ? n : 1,
    storage_location_id: String(storageLocationId),
  }
  if (what.crop_type_slug) body.crop_type_slug = what.crop_type_slug
  if (what.variety_id) body.variety_id = what.variety_id
  if (isPlantingHit(what)) { body.plant_id = what.plant_id; body.source_kind = 'own_garden' }
  if (discard?.mode === 'none') body.use_by_target = null
  else if (discard?.mode === 'date' && parseYmd(discard.date)) body.use_by_target = toYmd(parseYmd(discard.date))
  const nt = String(notes ?? '').trim()
  if (nt) body.notes = nt
  return body
}

// POST /api/pantry/items (the contract shape). A planting hit keeps its planting and crop.
export function itemBody({ key, what, place, when, discard, notes = '' }) {
  const body = { idempotency_key: key, name: String(what.name).trim(), ...placeKeys(place) }
  if (when?.precision === 'unknown') body.acquired_precision = 'unknown'
  else if (when?.date) { body.acquired_at = when.date; body.acquired_precision = when.precision }
  if (discard?.mode === 'date' && parseYmd(discard.date)) body.use_by_target = toYmd(parseYmd(discard.date))
  if (isPlantingHit(what)) body.plant_id = what.plant_id
  if (what.crop_type_slug) body.crop_type_slug = what.crop_type_slug
  const nt = String(notes ?? '').trim()
  if (nt) body.notes = nt
  return body
}

// The completion line, from what the server answered (V4 §2.2 "completion in place on the Pantry"):
// a put-up is the created row (POST /api/preservation answers the row itself); an item is `{item}`'s.
export function completionWords({ route, saved, place = null, now = new Date() }) {
  const name = String((route === 'item' ? saved?.name : saved?.label) ?? '').trim() || 'It'
  const parts = [`${name} — ${route === 'item' ? 'in the pantry' : 'put up'}`]
  if (place?.label) parts.push(place.label)
  if (route === 'item') {
    if (saved?.use_by_target) parts.push(`discard by ${shortDay(saved.use_by_target, now)} · set by hand`)
  } else {
    const w = discardWords({
      date: saved?.use_by_target ?? null, basis: saved?.use_by_basis ?? null, method: saved?.method ?? null,
      kind: place?.kind ?? null, estimated: ESTIMATED_PRECISIONS.has(saved?.preserved_at_precision), now,
    })
    if (w) parts.push(w)
  }
  return parts.join(' · ')
}
