// BUG-PUTUPREPLAYREST-001 — the put-up (jar) create, POST /api/preservation, on its two doors: Put something
// up, and the Walk. The rule is kitchen/idempotencyKey.js; the item route beside it is PutUpReplayEdit.pantry.
//
// Before this, a Save whose answer was lost, a change, and Save again came back `replayed: true` with the jar
// the FIRST Save made — and both doors completed as a save. The Walk went further: its band said the EDITED
// name and count, built from the form.
//   • a change every part of which PATCH /api/preservation/:id can carry (name, method, how many, size,
//     discard date, raw / in oil / how dry, notes, where from) → ONE PATCH onto that jar, when it is this
//     sitting's; the completion is the PATCH's answer;
//   • a change in a part it cannot carry (the date it was put up, the place, the crop / variety / planting, and
//     the size of a WEIGHED jar) → nothing is written, the door says which, and putting it back lets the rest through;
//   • a jar that is not this sitting's (a restored draft, made a while ago, touched since) → nothing is written;
//   • an untouched retry → nothing is written, saved;
//   • the PATCH fails, or lands with its answer lost → said as that, and Save again finishes it;
//   • NEVER a second jar: one key across every POST.
// The fake's PATCH is judged by the Lambda's own validateJarPatch. CI lane: `npm test` plus the TZ re-run.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'
import { pantryFetch, apiError, PLACES } from './helpers/pantryFake.js'

installStoragePolyfill()

let fake
const { stableFetch } = vi.hoisted(() => ({ stableFetch: { fn: null } }))
vi.mock('../lib/api.js', () => {
  const f = (...a) => stableFetch.fn(...a)
  return { useApiFetch: () => ({ fetch: f, getToken: () => Promise.resolve('t') }), apiFetch: f }
})
vi.mock('../context/AuthContext.jsx', () => {
  const auth = { user: { id: 'user_dave' } }
  return { useAuthOptional: () => auth, useAuth: () => auth }
})
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: vi.fn(), isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))
vi.mock('../hooks/useCropTypes.js', () => ({ useCropTypes: () => ({ cropTypes: [], loading: false }) }))

import PutSomethingUpSheet, { isDoorDraft } from '../components/pantry/PutSomethingUpSheet.jsx'
import PutUp from '../pages/PutUp.jsx'
import {
  DOOR_SHEET, completionWords, jarBody, jarPrint, jarWhenMoved, jarPatchOf, jarFixedPart, jarHolds, replayJarFixedText,
  replayStaleText, replayUnsavedText, printRoute, otherRouteSent, otherRouteText, WALK_NEXT_TEXT, METHOD_REQUIRED_TEXT, DISCARD_DATE_TEXT,
} from '../components/pantry/putSomethingUp.js'
import { putUpDateWords } from '../components/putup/jarWords.js'
import { START_REPLAY_NOT_ON_IT } from '../components/kitchen/StartBatchSheet.jsx'
import { sheetDraftKey, readSheetDraft } from '../components/kitchen/sheetDraft.js'
import { validateJarPatch } from '../../lambda/preservation/jarRoutes.js'
import { clearReloadBlocks } from '../lib/reloadGate.js'

const NOW = new Date(2026, 9, 1, 14, 0)               // Oct 1 2026, 2 pm, local
const DRAFT_KEY = sheetDraftKey('user_dave', DOOR_SHEET, 'new')
const BANNED = /\b(safe|shelf life|shelf-stable|keeps|good|ready|done|expired|table|default|basis)\b/i
const JARS = '/api/preservation'
const ITEMS = '/api/pantry/items'
const ROW = `${JARS}/jar-first`
const LONG_AGO = 11 * 60 * 1000                       // a minute past REPLAY_FRESH_MS
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
// The stamps a jar carries, BY SOURCE (QA B-1): created_at is `NOT NULL DEFAULT now()`; updated_at is nullable with
// no default (migrations/v4-putup-001/0a-additive-ddl.sql:96-97), the create's INSERT does not name it
// (lambda/preservation/index.js:765-772), and only the BEFORE UPDATE trigger writes it (v5-putupmake-001/0a:418-421).
// So a jar nobody has written to since its create carries updated_at NULL; `touchedAgoMs` is a write since.
const stamps = (madeAgoMs = 30 * 1000, touchedAgoMs = null) => {
  const now = Date.now()
  return { created_at: new Date(now - madeAgoMs).toISOString(), updated_at: touchedAgoMs == null ? null : new Date(now - touchedAgoMs).toISOString() }
}
const LOST = () => { throw new TypeError('Failed to fetch') }       // it may have landed; its answer did not come back
const MASS_G = { g: 1, kg: 1000, oz: 28.3495, lb: 453.592 }

// The jar a create makes, as the route answers a REPLAY with it: the raw row (SELECT *) — a DATE as the driver's
// instant, a numeric as text, the grams seeded for ONE container in a mass unit (lambda/preservation/index.js).
function rawJar(body, over = {}) {
  const typed = has(body, 'use_by_target')
  const day = (d) => (d == null ? null : `${d}T00:00:00.000Z`)
  const weighed = body.package_count === 1 && body.quantity_value != null && MASS_G[body.quantity_unit] != null
  return {
    id: 'jar-first', user_id: 'user_dave', label: body.label, method: body.method, method_other_text: null,
    package_count: body.package_count, remaining_count: body.package_count,
    quantity_value: body.quantity_value == null ? null : Number(body.quantity_value).toFixed(2), quantity_unit: body.quantity_unit ?? null,
    remaining_amount: weighed ? (body.quantity_value * MASS_G[body.quantity_unit]).toFixed(2) : null,
    storage_location_id: body.storage_location_id, plant_id: body.plant_id ?? null, crop_type_slug: body.crop_type_slug ?? null,
    variety_id: body.variety_id ?? null, harvest_log_id: null,
    preserved_at: day(body.preserved_at), preserved_at_precision: body.preserved_at_precision, preserved_at_approx: body.preserved_at_approx,
    use_by_target: typed ? day(body.use_by_target) : day('2027-10-01'), use_by_basis: typed ? 'typed' : 'table',
    is_raw: body.is_raw ?? null, in_oil: body.in_oil ?? null, texture: body.texture ?? null, notes: body.notes ?? null,
    source_kind: body.source_kind ?? null, source_label: body.source_label ?? null,
    idempotency_key: body.idempotency_key, ...stamps(), deleted_at: null, ...over,
  }
}
// PATCH /api/preservation/:id as the route applies it (jarRoutes.js patchJar): presence-sentinel, the count's
// delta rule, discard_by's three words — and every write moves updated_at.
function patched(row, b) {
  const next = { ...row }
  for (const k of ['label', 'method', 'is_raw', 'in_oil', 'texture', 'notes', 'source_kind', 'source_label']) if (has(b, k)) next[k] = b[k]
  if (has(b, 'package_count')) {
    next.remaining_count = (row.remaining_count ?? row.package_count) + (b.package_count - row.package_count)
    next.package_count = b.package_count
  }
  if (has(b, 'quantity_value')) { next.quantity_value = b.quantity_value == null ? null : Number(b.quantity_value).toFixed(2); next.quantity_unit = b.quantity_unit }
  if (has(b, 'discard_by')) {
    if (b.discard_by === 'none') Object.assign(next, { use_by_target: null, use_by_basis: 'typed' })
    else if (b.discard_by === 'clear') Object.assign(next, { use_by_target: '2027-10-01', use_by_basis: 'table' })
    else Object.assign(next, { use_by_target: b.discard_by, use_by_basis: 'typed' })
  }
  next.updated_at = new Date().toISOString()
  return next
}
// The answer a write gives: the projection (jarRules.projectRow) — a DATE as the day it is.
const projected = (row) => ({ ...row, preserved_at: String(row.preserved_at).slice(0, 10), use_by_target: row.use_by_target == null ? null : String(row.use_by_target).slice(0, 10) })

// A table of one jar. The first POST LANDS with its answer lost (`lose` of them are lost before any lands when
// `lands` is later); every POST after the row exists is answered with it, replayed. `first` is laid over the
// row the first landing makes; `onPatch(n)` may throw (the PATCH then did NOT land) or return 'lost' (it landed,
// its answer did not come back).
function jarTable({ first = {}, lands = 1, onPatch = null, onPost = null } = {}) {
  const state = { row: null, posts: 0, patches: 0 }
  fake = pantryFetch({ rows: [], overrides: {
    [`POST ${JARS}`]: ({ body }) => {
      state.posts += 1
      const forced = onPost?.(state.posts, body)
      if (forced !== undefined) return forced
      if (state.row == null) {
        if (state.posts < lands) LOST()                                        // never reached the server
        state.row = rawJar(body, first)
        LOST()                                                                 // landed; its answer did not come back
      }
      return { ...state.row, replayed: true }
    },
    [`PATCH ${JARS}/*`]: ({ body }) => {
      state.patches += 1
      const refused = validateJarPatch(body)
      if (refused) throw apiError(400, { error: refused })
      const how = onPatch?.(state.patches, body)
      state.row = patched(state.row, body)
      if (how === 'lost') LOST()
      return projected(state.row)
    },
  } })
  stableFetch.fn = fake
  return state
}

const tap = (id) => fireEvent.click(screen.getByTestId(id))
const typeInto = (id, v) => fireEvent.change(screen.getByTestId(id), { target: { value: v } })
const posts = (path = JARS) => fake.calls('POST').filter(c => c.path === path)
const keys = (path = JARS) => posts(path).map(c => c.body.idempotency_key)
const patches = () => fake.calls('PATCH')
// Every write that is not the jar POST: [method, path].
const otherWrites = () => fake.calls().filter(c => c.method !== 'GET' && !(c.method === 'POST' && c.path === JARS)).map(c => [c.method, c.path])

beforeEach(() => {
  fake = pantryFetch({ rows: [] }); stableFetch.fn = fake
  localStorage.clear(); sessionStorage.clear(); clearReloadBlocks()
})
function watchScrolls() {
  const on = []
  Element.prototype.scrollIntoView = function scrollIntoView() { on.push(this) }
  return on
}
afterEach(() => { delete Element.prototype.scrollIntoView; vi.restoreAllMocks(); cleanup() })
const broughtIntoView = (on, id) => on.some(el => el === screen.getByTestId(id) || el.contains(screen.getByTestId(id)))

const TYPED = { source: 'typed', name: 'Corn' }
const BODY = jarBody({ key: 'k', what: TYPED, storageLocationId: 'loc-1', method: 'whole_freeze', when: { date: '2026-10-01', precision: 'day' }, count: 2 })
// The jar refusals, as the door says them (QA I-6): each NAMES what the jar holds — that is what to put back.
const HEAD = (name, held = '') => `Already in the Pantry as “${name}”${held} — an earlier Save went through.`
const GO = 'and tap Save to put your other changes on it.'
const whenText = (name, day) => `${HEAD(name, `, put up ${day}`)} That date can't be changed once it is saved. Set the date back to ${day} ${GO}`
const placeText = (name, place) => `${HEAD(name, `, in ${place}`)} It can't be moved from here — to move it, open it in the Pantry. Pick ${place} again ${GO}`
const sizeText = (name, held) => `${HEAD(name, `, ${held}`)} Its size and how many can't be changed from here — to change them, open it in the Pantry. Set them back to ${held} ${GO}`
const whatText = (name) => `${HEAD(name)} Which planting or crop it is can't be changed once it is saved. Put “What is it?” back to “${name}” ${GO}`
// The walk's date is the real clock's ("This month"): what the jar holds, in the words the Pantry says it in.
const walkDay = (jar) => putUpDateWords(String(jar.preserved_at).slice(0, 10), jar.preserved_at_precision, { now: new Date() })
const nameText = (name) => `${HEAD(name)} That name can't be put on it from here — to rename it, open it in the Pantry. Put the name back to “${name}” ${GO}`
const STALE = '“Corn” was already saved earlier — it is in the Pantry. This Save did not change it. To change it, open it in the Pantry.'
const UNSAVED = '“Corn” is already in the Pantry — an earlier Save went through. This change did not save — try again.'
const MAYBE = '“Corn” is already in the Pantry — an earlier Save went through. This change may not have saved — try again.'
// Re-review I-E: in a walk a refusal that leaves the group spent ends with the way on — one wording, wherever the Walk says it.
const WALK_ON = ' To log more here, end this walk and start another.'

describe('a put-up as its PATCH — putSomethingUp.js jarPatchOf', () => {
  it('every part the PATCH can carry, an absent one as the word that clears it — and the Lambda takes it; no key of the create\'s own', () => {
    expect(jarPatchOf(BODY)).toEqual({
      label: 'Corn', method: 'whole_freeze', package_count: 2, quantity_value: null, quantity_unit: null, discard_by: 'clear',
      is_raw: null, in_oil: null, texture: null, notes: null, source_kind: null, source_label: null,
    })
    expect(validateJarPatch(jarPatchOf(BODY))).toBeNull()
    const full = jarBody({
      key: 'k', what: TYPED, storageLocationId: 'loc-1', method: 'dehydrate', when: { date: '2026-10-01', precision: 'day' }, count: 3,
      discard: { mode: 'date', date: '2027-01-15' }, notes: ' the dry ones ', inOil: true, size: { value: '8', unit: 'oz' },
      source: { kind: 'store', label: 'Costco' }, texture: 'snaps',
    })
    expect(jarPatchOf(full)).toEqual({
      label: 'Corn', method: 'dehydrate', package_count: 3, quantity_value: 24, quantity_unit: 'oz', discard_by: '2027-01-15',
      is_raw: null, in_oil: true, texture: 'snaps', notes: 'the dry ones', source_kind: 'store', source_label: 'Costco',
    })
    expect(validateJarPatch(jarPatchOf(full))).toBeNull()
    // "No date · set by hand" is the PATCH's own word for it.
    expect(jarPatchOf({ ...BODY, use_by_target: null }).discard_by).toBe('none')
    for (const k of ['idempotency_key', 'preserved_at', 'preserved_at_precision', 'preserved_at_approx', 'storage_location_id', 'plant_id', 'crop_type_slug', 'variety_id', 'use_by_target']) {
      expect(`${k}: ${has(jarPatchOf({ ...full, plant_id: 'p1', crop_type_slug: 'corn', variety_id: 'v1' }), k)}`).toBe(`${k}: false`)
    }
  })
})

describe('the print of a put-up Save — putSomethingUp.js jarPrint', () => {
  const TODAY = ['today']
  it('the date the chip came to is not in it; the chip is — and jarWhenMoved reads only that part', () => {
    const later = { ...BODY, preserved_at: '2026-10-02' }
    expect(jarPrint(later, TYPED, TODAY)).toBe(jarPrint(BODY, TYPED, TODAY))
    expect(jarPrint(BODY, TYPED, ['yesterday'])).not.toBe(jarPrint(BODY, TYPED, TODAY))
    const a = jarPrint(BODY, TYPED, TODAY)
    expect(jarWhenMoved([a], jarPrint({ ...BODY, notes: 'x' }, TYPED, TODAY))).toBe(false)
    expect(jarWhenMoved([a], jarPrint(BODY, TYPED, ['yesterday']))).toBe(true)
    expect(jarWhenMoved([], a)).toBe(false)
  })
  it('a TYPED name\'s crop is the search\'s, and is not in it; a crop he PICKED is; everything else he can change is', () => {
    expect(jarPrint({ ...BODY, crop_type_slug: 'corn' }, TYPED, TODAY)).toBe(jarPrint(BODY, TYPED, TODAY))
    const picked = { source: 'crop', name: 'Corn', crop_type_slug: 'corn' }
    expect(jarPrint({ ...BODY, crop_type_slug: 'corn' }, picked, TODAY)).not.toBe(jarPrint(BODY, picked, TODAY))
    for (const change of [{ label: 'Corn, cut' }, { method: 'blanch_freeze' }, { package_count: 3 }, { notes: 'x' }, { storage_location_id: 'loc-2' },
      { quantity_value: 2, quantity_unit: 'qt' }, { use_by_target: null }, { is_raw: true }, { in_oil: true }, { source_kind: 'store' }, { plant_id: 'p1' }]) {
      expect(`${JSON.stringify(change)}: ${jarPrint({ ...BODY, ...change }, TYPED, TODAY) === jarPrint(BODY, TYPED, TODAY)}`).toBe(`${JSON.stringify(change)}: false`)
    }
    // It is never an item's print (the two routes keep one `sent`).
    expect(jarPrint(BODY, TYPED, TODAY).startsWith('jar:')).toBe(true)
  })
})

describe('what a PATCH cannot carry, read off the jar — putSomethingUp.js jarFixedPart', () => {
  const JAR = rawJar(BODY)
  it('the same body: nothing; the place, the planting, a picked crop or variety: named', () => {
    expect(jarFixedPart(BODY, JAR, TYPED)).toBeNull()
    expect(jarFixedPart({ ...BODY, storage_location_id: 'loc-2' }, JAR, TYPED)).toBe('place')
    expect(jarFixedPart({ ...BODY, plant_id: 'p1' }, JAR, { source: 'planting', name: 'Corn', plant_id: 'p1' })).toBe('what')
    expect(jarFixedPart(BODY, { ...JAR, plant_id: 'p1' }, TYPED)).toBe('what')
    const picked = { source: 'crop', name: 'Corn', crop_type_slug: 'corn' }
    expect(jarFixedPart({ ...BODY, crop_type_slug: 'corn' }, JAR, picked)).toBe('what')
    expect(jarFixedPart({ ...BODY, crop_type_slug: 'corn', variety_id: 'v2' }, { ...JAR, crop_type_slug: 'corn', variety_id: 'v1' }, picked)).toBe('what')
    // A planting's crop and variety are the planting's own: the server fills them in, and they are not compared.
    expect(jarFixedPart({ ...BODY, plant_id: 'p1' }, { ...JAR, plant_id: 'p1', crop_type_slug: 'corn', variety_id: 'v1' }, { source: 'planting', name: 'Corn', plant_id: 'p1' })).toBeNull()
  })
  it('a TYPED name\'s crop is the search\'s reading: it counts only against a crop the jar holds, and only once the name is another', () => {
    expect(jarFixedPart({ ...BODY, crop_type_slug: 'corn' }, JAR, TYPED)).toBeNull()                       // answered late: the jar holds none
    expect(jarFixedPart(BODY, { ...JAR, crop_type_slug: 'corn' }, TYPED)).toBeNull()                       // the same name, not answered this time
    expect(jarFixedPart({ ...BODY, label: 'Corn, cut', crop_type_slug: 'corn' }, { ...JAR, crop_type_slug: 'corn' }, { ...TYPED, name: 'Corn, cut' })).toBeNull()
    // … and then it is the NAME that cannot ride (QA I-6): said apart from 'what', because a name can be changed in the Pantry.
    expect(jarFixedPart({ ...BODY, label: 'Peppers', crop_type_slug: 'pepper' }, { ...JAR, crop_type_slug: 'corn' }, { ...TYPED, name: 'Peppers' })).toBe('name')
    expect(jarFixedPart({ ...BODY, label: 'Salsa' }, { ...JAR, crop_type_slug: 'corn' }, { ...TYPED, name: 'Salsa' })).toBe('name')
    // A PICKED crop that differs is 'what' — nothing changes a jar's crop.
    expect(jarFixedPart({ ...BODY, label: 'Peppers', crop_type_slug: 'pepper' }, { ...JAR, crop_type_slug: 'corn' }, { source: 'crop', name: 'Peppers', crop_type_slug: 'pepper' })).toBe('what')
  })
  it('the date counts only once he has CHANGED it (whenMoved): a chip that now comes to another day is not a change', () => {
    const tomorrow = { ...BODY, preserved_at: '2026-10-02' }
    expect(jarFixedPart(tomorrow, JAR, TYPED)).toBeNull()
    expect(jarFixedPart(tomorrow, JAR, TYPED, { whenMoved: true })).toBe('when')
    expect(jarFixedPart(BODY, JAR, TYPED, { whenMoved: true })).toBeNull()                                 // changed, and put back
    expect(jarFixedPart({ ...BODY, preserved_at_precision: 'month', preserved_at_approx: true }, JAR, TYPED, { whenMoved: true })).toBe('when')
  })
  it('the size and the count of a WEIGHED jar (it carries its grams, which the PATCH never re-works): named; of any other jar: not', () => {
    const one = jarBody({ key: 'k', what: TYPED, storageLocationId: 'loc-1', method: 'whole_freeze', when: { date: '2026-10-01', precision: 'day' }, count: 1, size: { value: '2', unit: 'lb' } })
    const weighed = rawJar(one)
    expect(weighed.remaining_amount).toBe('907.18')
    expect(jarFixedPart(one, weighed, TYPED)).toBeNull()
    expect(jarFixedPart({ ...one, quantity_value: 3 }, weighed, TYPED)).toBe('size')
    expect(jarFixedPart({ ...one, quantity_unit: 'kg' }, weighed, TYPED)).toBe('size')
    expect(jarFixedPart({ ...one, package_count: 2, quantity_value: 4 }, weighed, TYPED)).toBe('size')
    const { quantity_value: _v, quantity_unit: _u, ...none } = one
    expect(jarFixedPart(none, weighed, TYPED)).toBe('size')
    expect(jarFixedPart({ ...BODY, package_count: 5, quantity_value: 10, quantity_unit: 'lb' }, JAR, TYPED)).toBeNull()
  })
})

describe('the jar already holds it — putSomethingUp.js jarHolds', () => {
  const JAR = rawJar(BODY)
  it('the row a create made from this body holds it — a numeric as text, a date as an instant, a flag never chosen as null', () => {
    expect(jarHolds(BODY, JAR, TYPED)).toBe(true)
    const full = jarBody({
      key: 'k', what: TYPED, storageLocationId: 'loc-1', method: 'dehydrate', when: { date: '2026-10-01', precision: 'day' }, count: 3,
      discard: { mode: 'date', date: '2027-01-15' }, notes: 'the dry ones', inOil: true, size: { value: '8', unit: 'oz' },
      source: { kind: 'store', label: 'Costco' }, texture: 'snaps',
    })
    expect(jarHolds(full, rawJar(full), TYPED)).toBe(true)
    expect(jarHolds({ ...BODY, use_by_target: null }, rawJar({ ...BODY, use_by_target: null }), TYPED)).toBe(true)
  })
  it('one part different: it does not — each part he can change; a removed jar holds nothing', () => {
    for (const change of [{ label: 'Corn, cut' }, { method: 'blanch_freeze' }, { package_count: 3 }, { notes: 'x' }, { quantity_value: 2, quantity_unit: 'qt' },
      { use_by_target: null }, { use_by_target: '2027-01-15' }, { is_raw: true }, { in_oil: true }, { texture: 'snaps' }, { source_kind: 'store' },
      { source_kind: 'store', source_label: 'Costco' }, { storage_location_id: 'loc-2' }, { plant_id: 'p1' }]) {
      expect(`${JSON.stringify(change)}: ${jarHolds({ ...BODY, ...change }, JAR, TYPED)}`).toBe(`${JSON.stringify(change)}: false`)
    }
    // A date he set by hand is not the worked-out one, even on the same day.
    expect(jarHolds({ ...BODY, use_by_target: '2027-10-01' }, JAR, TYPED)).toBe(false)
    expect(jarHolds(BODY, rawJar({ ...BODY, use_by_target: '2027-10-01' }), TYPED)).toBe(false)
    expect(jarHolds(BODY, { ...JAR, deleted_at: '2026-10-01T18:00:00Z' }, TYPED)).toBe(false)
    expect(jarHolds(BODY, null, TYPED)).toBe(false)
  })
})

describe('the sentence — putSomethingUp.js replayJarFixedText', () => {
  const OPTS = { now: NOW, placeLabel: 'Chest Freezer 1' }
  it('QA I-6 — names the jar AND what it holds in the part that cannot change — that is what to put back — and how to go on; in these words, and no banned one', () => {
    const jar = rawJar(BODY)
    expect(replayJarFixedText(jar, 'when', OPTS)).toBe('Already in the Pantry as “Corn”, put up Oct 1 — an earlier Save went through. That date can\'t be changed once it is saved. Set the date back to Oct 1 and tap Save to put your other changes on it.')
    expect(replayJarFixedText(jar, 'place', OPTS)).toBe('Already in the Pantry as “Corn”, in Chest Freezer 1 — an earlier Save went through. It can\'t be moved from here — to move it, open it in the Pantry. Pick Chest Freezer 1 again and tap Save to put your other changes on it.')
    expect(replayJarFixedText(jar, 'size', OPTS)).toBe('Already in the Pantry as “Corn”, 2 containers — an earlier Save went through. Its size and how many can\'t be changed from here — to change them, open it in the Pantry. Set them back to 2 containers and tap Save to put your other changes on it.')
    expect(replayJarFixedText(jar, 'what', OPTS)).toBe('Already in the Pantry as “Corn” — an earlier Save went through. Which planting or crop it is can\'t be changed once it is saved. Put “What is it?” back to “Corn” and tap Save to put your other changes on it.')
    // A TYPED name that reads as another crop: the name CAN be changed — in the Pantry — so it never says it cannot.
    expect(replayJarFixedText(jar, 'name', OPTS)).toBe('Already in the Pantry as “Corn” — an earlier Save went through. That name can\'t be put on it from here — to rename it, open it in the Pantry. Put the name back to “Corn” and tap Save to put your other changes on it.')
    expect([replayJarFixedText(jar, 'when', OPTS), replayJarFixedText(jar, 'place', OPTS), replayJarFixedText(jar, 'size', OPTS), replayJarFixedText(jar, 'what', OPTS), replayJarFixedText(jar, 'name', OPTS)])
      .toEqual([whenText('Corn', 'Oct 1'), placeText('Corn', 'Chest Freezer 1'), sizeText('Corn', '2 containers'), whatText('Corn'), nameText('Corn')])
    for (const part of ['when', 'place', 'what', 'name', 'size']) {
      expect(replayJarFixedText(jar, part, OPTS)).not.toMatch(BANNED)
      expect(replayJarFixedText(jar, part, OPTS)).not.toMatch(/your change is not|is not on it|was lost|as it was/i)
    }
  })
  it('QA I-6 — what the jar holds, as it holds it: a date in another year, a rough date, "Not sure"; one weighed container; a count with a size', () => {
    const jar = rawJar(BODY)
    expect(replayJarFixedText({ ...jar, preserved_at: '2025-09-30T00:00:00.000Z' }, 'when', OPTS)).toBe(whenText('Corn', 'Sep 30, 2025'))
    expect(replayJarFixedText({ ...jar, preserved_at: '2026-09-01T00:00:00.000Z', preserved_at_precision: 'month' }, 'when', OPTS)).toBe(whenText('Corn', 'sometime in September'))
    expect(replayJarFixedText({ ...jar, preserved_at_precision: 'unknown' }, 'when', OPTS))
      .toBe('Already in the Pantry as “Corn”, with the date “Not sure” — an earlier Save went through. That date can\'t be changed once it is saved. Set the date back to “Not sure” and tap Save to put your other changes on it.')
    expect(replayJarFixedText({ ...jar, package_count: 1, quantity_value: '2.00', quantity_unit: 'lb' }, 'size', OPTS)).toBe(sizeText('Corn', '1 container of 2 lb'))
    expect(replayJarFixedText({ ...jar, package_count: 3, quantity_value: '24.00', quantity_unit: 'oz' }, 'size', OPTS)).toBe(sizeText('Corn', '3 containers, 24 oz in all'))
    expect(replayJarFixedText({ ...jar, label: null }, 'when', OPTS)).toBe('Already in the Pantry, put up Oct 1 — an earlier Save went through. That date can\'t be changed once it is saved. Set the date back to Oct 1 and tap Save to put your other changes on it.')
  })
  it('QA I-6 — a part it cannot name is not asked for: a place this list does not hold (gone, or not read) cannot be picked here, so the sentence sends him to the Pantry instead of "put it back"', () => {
    const jar = rawJar(BODY)
    expect(replayJarFixedText(jar, 'place', { now: NOW })).toBe('Already in the Pantry as “Corn” — an earlier Save went through. It can\'t be moved from here, and where it is now can\'t be picked here. To change it, open it in the Pantry.')
    expect(replayJarFixedText({ ...jar, package_count: null }, 'size', OPTS)).toBe('Already in the Pantry as “Corn” — an earlier Save went through. Its size and how many can\'t be changed from here. To change it, open it in the Pantry.')
    expect(replayJarFixedText({ ...jar, preserved_at: null, preserved_at_precision: null }, 'when', OPTS)).toBe('Already in the Pantry as “Corn” — an earlier Save went through. The date it was put up can\'t be changed once it is saved. To change anything else on it, open it in the Pantry.')
  })
  it('the two the item route already says read a jar\'s name (its label) the same way — and say "an earlier Save", never "the first" (QA M-7)', () => {
    const jar = rawJar(BODY)
    expect(replayStaleText(jar)).toBe(STALE)
    expect(replayStaleText({ ...jar, deleted_at: '2026-10-01T18:00:00Z' })).toBe('“Corn” was saved earlier and has been removed since. This Save did not change that.')
    expect(replayUnsavedText(jar)).toBe(UNSAVED)
    expect(replayUnsavedText(jar, { lost: true })).toBe(MAYBE)
    for (const said of [replayUnsavedText(jar), replayUnsavedText(jar, { lost: true }), replayUnsavedText(jar, { why: 'no' }), replayUnsavedText(null)]) expect(said).not.toMatch(/the first Save/)
  })
  // Re-review I-E. A walk's group keeps its key until the walk is ended, so a refusal with no way through in the
  // group leaves it spent: the line ends with the way on, in ONE wording — the clause the other-route refusal has.
  it('re-review I-E — in a walk, every refusal that leaves the group spent ends with the way on, in one wording; a refusal that names what to put back already has its way on, and is as the door says it', () => {
    const jar = rawJar(BODY)
    const walk = { walk: true }
    expect(WALK_NEXT_TEXT).toBe('To log more here, end this walk and start another.')
    expect(WALK_ON).toBe(` ${WALK_NEXT_TEXT}`)
    expect(replayStaleText(jar, walk)).toBe(`${STALE}${WALK_ON}`)
    expect(replayStaleText({ ...jar, deleted_at: '2026-10-01T18:00:00Z' }, walk)).toBe(`“Corn” was saved earlier and has been removed since. This Save did not change that.${WALK_ON}`)
    expect(replayStaleText(null, walk)).toBe(`This was already saved earlier — it is in the Pantry. This Save did not change it. To change it, open it in the Pantry.${WALK_ON}`)
    // The three that cannot name what to put back.
    expect(replayJarFixedText(jar, 'place', { now: NOW, walk: true })).toBe(`Already in the Pantry as “Corn” — an earlier Save went through. It can't be moved from here, and where it is now can't be picked here. To change it, open it in the Pantry.${WALK_ON}`)
    expect(replayJarFixedText({ ...jar, package_count: null }, 'size', { ...OPTS, walk: true })).toBe(`Already in the Pantry as “Corn” — an earlier Save went through. Its size and how many can't be changed from here. To change it, open it in the Pantry.${WALK_ON}`)
    expect(replayJarFixedText({ ...jar, preserved_at: null, preserved_at_precision: null }, 'when', { ...OPTS, walk: true })).toBe(`Already in the Pantry as “Corn” — an earlier Save went through. The date it was put up can't be changed once it is saved. To change anything else on it, open it in the Pantry.${WALK_ON}`)
    // Those that say what to put back: the same line in a walk as in the door — "tap Save" is the way on.
    for (const part of ['when', 'place', 'size', 'name', 'what']) {
      expect(replayJarFixedText(jar, part, { ...OPTS, walk: true })).toBe(replayJarFixedText(jar, part, OPTS))
      expect(replayJarFixedText(jar, part, { ...OPTS, walk: true })).toMatch(/tap Save to put your other changes on it\.$/)
    }
    // One wording: the other-route refusal's clause is this one's.
    expect(otherRouteText({ first: 'jar', row: jar, what: TYPED, walk: true })).toMatch(/If you want both, end this walk and start another\.$/)
    // The door's lines are untouched.
    expect(replayStaleText(jar)).toBe(STALE)
    for (const said of [replayStaleText(jar, walk), replayStaleText({ ...jar, deleted_at: 'x' }, walk), replayJarFixedText(jar, 'place', { now: NOW, walk: true })]) expect(said).not.toMatch(BANNED)
  })
})

describe('one key, two tables — putSomethingUp.js otherRouteSent, otherRouteText (QA I-1)', () => {
  const JAR_PRINT = jarPrint(BODY, TYPED, ['today'])
  it('a key\'s route is the route its FIRST print went out on; a Save the other way is told which', () => {
    expect(printRoute(JAR_PRINT)).toBe('jar')
    expect(printRoute('1a.x.y/2.b.c')).toBe('item')
    expect(otherRouteSent([], 'jar')).toBeNull()
    expect(otherRouteSent(undefined, 'item')).toBeNull()
    expect(otherRouteSent([JAR_PRINT], 'jar')).toBeNull()
    expect(otherRouteSent([JAR_PRINT], 'item')).toBe('jar')
    expect(otherRouteSent(['1a.x.y/2.b.c'], 'item')).toBeNull()
    expect(otherRouteSent(['1a.x.y/2.b.c'], 'jar')).toBe('item')
    // A draft stored before this rule can hold both: it stays on its first route, so one way is always open.
    expect([otherRouteSent([JAR_PRINT, '1a.x.y/2.b.c'], 'jar'), otherRouteSent([JAR_PRINT, '1a.x.y/2.b.c'], 'item')]).toEqual([null, 'jar'])
    expect([otherRouteSent(['1a.x.y/2.b.c', JAR_PRINT], 'jar'), otherRouteSent(['1a.x.y/2.b.c', JAR_PRINT], 'item')]).toEqual(['item', null])
  })
  it('the sentence — in these words: what is certain, how to go on, and no banned word', () => {
    const jar = rawJar(BODY)
    const all = [
      [otherRouteText({ first: 'jar', row: jar, what: TYPED }), '“Corn” is already in the Pantry as a put-up — an earlier Save went through. It can\'t also be saved as “As is” from here. If you want both, close this and start a new one.'],
      [otherRouteText({ first: 'item', row: { name: 'Oat milk' }, what: TYPED }), '“Oat milk” is already in the Pantry as “As is” — an earlier Save went through. It can\'t also be saved as a put-up from here. If you want both, close this and start a new one.'],
      [otherRouteText({ first: 'jar', row: jar, what: TYPED, walk: true }), '“Corn” is already in the Pantry as a put-up — an earlier Save went through. It can\'t also be saved as “As is” from here. If you want both, end this walk and start another.'],
      [otherRouteText({ first: 'jar', row: {}, what: TYPED }), 'This is already in the Pantry as a put-up — an earlier Save went through. It can\'t also be saved as “As is” from here. If you want both, close this and start a new one.'],
      // Its answer never came back: nothing says it is in the Pantry — only that it may be, and how to settle it.
      [otherRouteText({ first: 'jar', what: TYPED }), 'An earlier Save of this as a put-up may have gone through. It can\'t also be saved as “As is” from here. Choose the method again and tap Save to finish that one.'],
      [otherRouteText({ first: 'item', what: TYPED }), 'An earlier Save of this as “As is” may have gone through. It can\'t also be saved as a put-up from here. Choose “As is” again and tap Save to finish that one.'],
      // A planting's as-is chip reads "Fresh, as picked", and the sentence says the chip's own words.
      [otherRouteText({ first: 'item', what: { source: 'planting', name: 'Megatron', plant_id: 'p1' } }), 'An earlier Save of this as “Fresh, as picked” may have gone through. It can\'t also be saved as a put-up from here. Choose “Fresh, as picked” again and tap Save to finish that one.'],
    ]
    for (const [said, words] of all) { expect(said).toBe(words); expect(said).not.toMatch(BANNED) }
    for (const [said] of all.slice(4)) expect(said).not.toMatch(/is already in the Pantry|is in the Pantry/)
  })
  // Re-review M-A. A planting has no “Fresh, as picked” at a freezer, so "choose it again" asked for a chip that
  // is not on screen. When the first way is not offered the line names a way that is: the place, in the door; in
  // a walk (whose place is the walk's) where to look, and the way on.
  it('re-review M-A — when the first way\'s chip is NOT offered where he is now, the line does not ask for it: the door names the place row, the walk says where to look and the way on', () => {
    const planting = { source: 'planting', name: 'Megatron', plant_id: 'p1' }
    const door = otherRouteText({ first: 'item', what: planting, offered: false })
    const walk = otherRouteText({ first: 'item', what: planting, offered: false, walk: true })
    expect(door).toBe('An earlier Save of this as “Fresh, as picked” may have gone through. It can\'t also be saved as a put-up from here. Pick the place it was saved to, then choose “Fresh, as picked” and tap Save to finish that one.')
    expect(walk).toBe(`An earlier Save of this as “Fresh, as picked” may have gone through. It can't also be saved as a put-up from here. Look for it in the Pantry.${WALK_ON}`)
    for (const said of [door, walk]) { expect(said).not.toMatch(BANNED); expect(said).not.toMatch(/is already in the Pantry|is in the Pantry|Choose “Fresh, as picked” again/) }
    // Offered (the default), or the first way was a put-up (a method is always offered), or the row is KNOWN: as before.
    expect(otherRouteText({ first: 'item', what: planting, offered: true })).toBe(otherRouteText({ first: 'item', what: planting }))
    expect(otherRouteText({ first: 'jar', what: planting, offered: false })).toBe(otherRouteText({ first: 'jar', what: planting }))
    expect(otherRouteText({ first: 'item', row: { name: 'Megatron' }, what: planting, offered: false })).toBe(otherRouteText({ first: 'item', row: { name: 'Megatron' }, what: planting }))
  })
})

describe('Put something up — the put-up route', () => {
  async function openDoor(props = {}) {
    const handlers = { onClose: vi.fn(), onSaved: vi.fn(), onExists: vi.fn(), ...props }
    const view = render(<PutSomethingUpSheet open now={NOW.getTime()} {...handlers} />)
    await screen.findByTestId('door-place-id:loc-1')
    return { ...view, ...handlers }
  }
  const method = (m) => { if (!screen.queryByTestId(`door-method-${m}`)) tap('door-method-more'); tap(`door-method-${m}`) }
  const corn = (name = 'Corn') => { typeInto('door-what-name', name); tap('door-place-id:loc-1'); method('whole_freeze') }
  const save = () => tap('door-save')
  const errorText = () => screen.queryByTestId('door-error')?.textContent ?? null
  const failed = (text = "Couldn't save it — nothing was lost. Try again.") => waitFor(() => expect(errorText()).toBe(text))
  // The nth jar POST has been answered, one way or the other: the door says something new, or hands the save on.
  const answered = async (h, nth) => {
    await waitFor(() => expect(posts()).toHaveLength(nth))
    await waitFor(() => expect(screen.getByTestId('door-save').disabled).toBe(false))
    await waitFor(() => expect(errorText() != null || h.onSaved.mock.calls.length > 0).toBe(true))
  }
  const draft = () => readSheetDraft(DRAFT_KEY, DOOR_SHEET, isDoorDraft)
  const told = (h) => h.onSaved.mock.calls[0][0]
  const words = (h) => completionWords({ route: told(h).route, saved: told(h).saved, place: told(h).place, now: NOW })

  it('a lost answer, the name, the count and the notes changed, Save: ONE jar — the same key, ONE PATCH onto it with the change; the jar holds it, and the completion is the jar\'s', async () => {
    const table = jarTable()
    const door = await openDoor()
    corn()
    save(); await failed()
    typeInto('door-what-name', 'Corn, cut'); tap('door-count-plus')
    tap('door-from'); typeInto('door-notes', 'the second tray')
    save()
    await waitFor(() => expect(door.onSaved).toHaveBeenCalledTimes(1))
    expect(keys()).toHaveLength(2)
    expect(new Set(keys()).size).toBe(1)                                       // never a create under a new key
    expect(otherWrites()).toEqual([['PATCH', ROW]])
    expect(patches()[0].body).toEqual({
      label: 'Corn, cut', method: 'whole_freeze', package_count: 2, quantity_value: null, quantity_unit: null, discard_by: 'clear',
      is_raw: null, in_oil: null, texture: null, notes: 'the second tray', source_kind: null, source_label: null,
    })
    expect(table.row).toMatchObject({ id: 'jar-first', label: 'Corn, cut', package_count: 2, notes: 'the second tray' })
    expect(told(door)).toMatchObject({ route: 'jar', saved: { id: 'jar-first', label: 'Corn, cut', package_count: 2, notes: 'the second tray' } })
    expect(words(door)).toBe('Corn, cut — put up · Chest Freezer 1 · discard by Oct 1, 2027 · general figure: whole freeze, deep freezer')
    expect(draft()).toBeNull()
  })

  it('the method, the size, the discard date and where it is from ride the same PATCH', async () => {
    const table = jarTable()
    const door = await openDoor()
    corn()
    save(); await failed()
    method('blanch_freeze')
    tap('door-size-open'); typeInto('door-size-value', '1'); tap('door-size-unit-qt')
    tap('door-more'); tap('door-discard-none')
    tap('door-from'); tap('door-source-store'); typeInto('door-source-label', 'Costco')
    save()
    await waitFor(() => expect(door.onSaved).toHaveBeenCalledTimes(1))
    expect(new Set(keys()).size).toBe(1)
    expect(patches().map(c => c.body)).toEqual([{
      label: 'Corn', method: 'blanch_freeze', package_count: 1, quantity_value: 1, quantity_unit: 'qt', discard_by: 'none',
      is_raw: null, in_oil: null, texture: null, notes: null, source_kind: 'store', source_label: 'Costco',
    }])
    expect(table.row).toMatchObject({ method: 'blanch_freeze', quantity_value: '1.00', quantity_unit: 'qt', use_by_target: null, use_by_basis: 'typed', source_kind: 'store' })
    expect(words(door)).toBe('Corn — put up · Chest Freezer 1 · no date · set by hand')
  })

  it('a lost answer, Save again untouched: ONE jar, nothing written, the completion from the server\'s row', async () => {
    const table = jarTable()
    const door = await openDoor()
    corn()
    save(); await failed()
    save()
    await waitFor(() => expect(door.onSaved).toHaveBeenCalledTimes(1))
    expect(keys()).toHaveLength(2)
    expect(new Set(keys()).size).toBe(1)
    expect(otherWrites()).toEqual([])
    expect(told(door).saved).toEqual({ ...table.row, replayed: true })
  })

  it('the DATE changed after a lost answer: NOTHING is written — the door says which part cannot change, brings the line into view, tells the page, keeps the form, the key and the draft; Save again is refused again; put back, the other change goes through', async () => {
    const on = watchScrolls()
    const table = jarTable()
    const door = await openDoor()
    corn()
    save(); await failed()
    const before = { ...table.row }
    tap('door-more'); tap('door-when-yesterday')
    tap('door-from'); typeInto('door-notes', 'the second tray')
    tap('door-more')                                                           // the options closed again: the date is out of sight
    expect(screen.queryByTestId('door-when-yesterday')).toBeNull()
    on.length = 0
    save()
    await answered(door, 2)
    expect(errorText()).toBe(whenText('Corn', 'Oct 1'))
    expect(screen.getByTestId('door-when-yesterday')).toBeTruthy()             // QA M-4: the refusal opens what it is about
    expect(screen.getByTestId('door-more').getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('door-error').getAttribute('role')).toBe('alert')
    await waitFor(() => expect(broughtIntoView(on, 'door-error')).toBe(true))
    expect(otherWrites()).toEqual([])
    expect(table.row).toEqual(before)                                          // one jar, as the first Save made it
    expect(door.onSaved).not.toHaveBeenCalled()
    expect(door.onExists).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('door-notes').value).toBe('the second tray')
    expect(draft()).toMatchObject({ key: keys()[0], notes: 'the second tray', whenChip: 'yesterday' })   // put back, it can still go through
    on.length = 0
    save()
    await answered(door, 3)
    expect(errorText()).toBe(whenText('Corn', 'Oct 1'))                     // refused again
    await waitFor(() => expect(broughtIntoView(on, 'door-error')).toBe(true))
    expect(otherWrites()).toEqual([])
    tap('door-when-today')
    save()
    await waitFor(() => expect(door.onSaved).toHaveBeenCalledTimes(1))
    expect(new Set(keys()).size).toBe(1)
    expect(patches().map(c => [c.path, c.body.notes])).toEqual([[ROW, 'the second tray']])
    expect(told(door).saved).toMatchObject({ id: 'jar-first', notes: 'the second tray', preserved_at: '2026-10-01' })
  })

  it('QA I-6 — a typed name changed to one the jar\'s crop would contradict: nothing is written, and the door does NOT say the name cannot be changed — it says where it can, and names the name to put back; put back, the rest goes through', async () => {
    const table = jarTable({ first: { crop_type_slug: 'corn' } })
    const door = await openDoor()
    corn()
    save(); await failed()
    typeInto('door-what-name', 'Salsa')
    tap('door-from'); typeInto('door-notes', 'the second tray')
    save()
    await answered(door, 2)
    expect(errorText()).toBe(nameText('Corn'))
    expect(errorText()).not.toMatch(/can't be changed once/)
    expect(otherWrites()).toEqual([])
    expect(table.row.label).toBe('Corn')
    typeInto('door-what-name', 'Corn')
    save()
    await waitFor(() => expect(door.onSaved).toHaveBeenCalledTimes(1))
    expect(patches().map(c => [c.body.label, c.body.notes])).toEqual([['Corn', 'the second tray']])
  })

  // QA I-6 (the sequence the review ran as J5). "As it was" is not always what the jar holds: the first Save
  // never arrived, the second — another place — landed. Put back to the FIRST place he is refused again; the
  // sentence names the place the jar is in, and picking that one goes through.
  it('QA I-6 (J5) — place 1 never arrives, place 2 lands with its answer lost, place put back to 1, Save: refused — and the sentence NAMES the place the jar is in (2); that place picked, the Save goes through', async () => {
    jarTable({ lands: 2 })
    const door = await openDoor()
    corn()
    save(); await failed()
    tap('door-place-id:loc-2')
    save(); await failed()
    tap('door-place-id:loc-1')
    tap('door-from'); typeInto('door-notes', 'the second tray')
    save()
    await answered(door, 3)
    expect(errorText()).toBe(placeText('Corn', PLACES[1].label))
    save()
    await answered(door, 4)
    expect(errorText()).toBe(placeText('Corn', PLACES[1].label))
    expect(otherWrites()).toEqual([])
    tap('door-place-id:loc-2')
    save()
    await waitFor(() => expect(door.onSaved).toHaveBeenCalledTimes(1))
    expect(told(door).saved).toMatchObject({ id: 'jar-first', storage_location_id: 'loc-2', notes: 'the second tray' })
    expect(new Set(keys()).size).toBe(1)
  })

  it('the PLACE changed after a lost answer: nothing is written, and the door says the place cannot change from here', async () => {
    const table = jarTable()
    const door = await openDoor()
    corn()
    save(); await failed()
    const before = { ...table.row }
    tap('door-place-id:loc-2')
    if (screen.getByTestId('door-method-whole_freeze').getAttribute('aria-checked') !== 'true') method('whole_freeze')
    save()
    await answered(door, 2)
    expect(errorText()).toBe(placeText('Corn', 'Chest Freezer 1'))
    expect(otherWrites()).toEqual([])
    expect(table.row).toEqual(before)
    expect(door.onSaved).not.toHaveBeenCalled()
    expect(new Set(keys()).size).toBe(1)
  })

  it('a WEIGHED jar (one container, 2 lb), the size changed after a lost answer: nothing is written — its grams would be left as they were', async () => {
    const table = jarTable()
    const door = await openDoor()
    corn()
    tap('door-size-open'); typeInto('door-size-value', '2'); tap('door-size-unit-lb')
    save(); await failed()
    expect(table.row.remaining_amount).toBe('907.18')
    const before = { ...table.row }
    typeInto('door-size-value', '3')
    save()
    await answered(door, 2)
    expect(errorText()).toBe(sizeText('Corn', '1 container of 2 lb'))
    expect(otherWrites()).toEqual([])
    expect(table.row).toEqual(before)
    expect(door.onSaved).not.toHaveBeenCalled()
    // … and a change that leaves the size alone still rides.
    typeInto('door-size-value', '2')
    tap('door-from'); typeInto('door-notes', 'the big bag')
    save()
    await waitFor(() => expect(door.onSaved).toHaveBeenCalledTimes(1))
    expect(patches().map(c => [c.body.quantity_value, c.body.quantity_unit, c.body.notes])).toEqual([[2, 'lb', 'the big bag']])
    expect(table.row.remaining_amount).toBe('907.18')
  })

  it('a draft opened again with something else typed over it: NOTHING is written onto the jar the first Save made — the door says it was saved earlier, the STORED draft ends, the key is kept and Save again is refused again', async () => {
    const on = watchScrolls()
    const table = jarTable()
    const first = await openDoor()
    corn()
    save(); await failed()
    await waitFor(() => expect(draft()?.sent).toHaveLength(1))
    const before = { ...table.row }
    first.unmount()
    const second = await openDoor()
    expect(screen.getByTestId('door-what-name').value).toBe('Corn')
    typeInto('door-what-name', 'Peas'); tap('door-count-plus')
    on.length = 0
    save()
    await answered(second, 2)
    expect(errorText()).toBe(STALE)
    await waitFor(() => expect(broughtIntoView(on, 'door-error')).toBe(true))
    expect(otherWrites()).toEqual([])
    expect(table.row).toEqual(before)
    expect(second.onSaved).not.toHaveBeenCalled()
    expect(second.onExists).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('door-what-name').value).toBe('Peas')
    await waitFor(() => expect(draft()).toBeNull())                            // the spent-key rule: the stored draft ended with the refusal
    save()
    await answered(second, 3)
    expect(errorText()).toBe(STALE)
    await waitFor(() => expect(draft()).toBeNull())
    expect(new Set(keys()).size).toBe(1)
    expect(otherWrites()).toEqual([])
    // The door opened next is a clean one.
    second.unmount()
    await openDoor()
    expect(screen.getByTestId('door-what-name').value).toBe('')
  })

  it.each([
    ['made longer ago than the bound', { ...stamps(LONG_AGO) }],
    ['touched since it was made', { ...stamps(60 * 1000, 5 * 1000) }],
    ['carrying neither stamp', { created_at: undefined, updated_at: undefined }],
    ['stamped two minutes later than this phone\'s clock (a slow clock is not one to judge "minutes ago" by)', { ...stamps(-2 * 60 * 1000) }],
  ])('a jar %s, the notes changed, Save: nothing is written, and the door says it was saved earlier', async (_name, first) => {
    const table = jarTable({ first })
    const door = await openDoor()
    corn()
    save(); await failed()
    const before = { ...table.row }
    tap('door-from'); typeInto('door-notes', 'the second tray')
    save()
    await answered(door, 2)
    expect(errorText()).toBe(STALE)
    expect(otherWrites()).toEqual([])
    expect(table.row).toEqual(before)
    expect(door.onSaved).not.toHaveBeenCalled()
    expect(new Set(keys()).size).toBe(1)
    await waitFor(() => expect(draft()).toBeNull())
  })

  // QA M-5 (the sequence the review ran as J7). The replay does not filter a removed jar, and an untouched retry
  // never looked: the door completed and handed the page a removed row as a put-up.
  it('QA M-5 — the put-up landed with its answer lost and the jar was REMOVED since; Save again untouched: not a save — the door says it was removed, tells the page, hands nothing on', async () => {
    const table = jarTable({ first: { deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() } })
    const door = await openDoor()
    corn()
    save(); await failed()
    save()
    await answered(door, 2)
    expect(errorText()).toBe('“Corn” was saved earlier and has been removed since. This Save did not change that.')
    expect(door.onSaved).not.toHaveBeenCalled()
    expect(door.onExists).toHaveBeenCalledTimes(1)
    expect(otherWrites()).toEqual([])
    expect(table.row.deleted_at).not.toBeNull()
    await waitFor(() => expect(draft()).toBeNull())
  })

  it('a jar removed since: the door says so, and writes nothing', async () => {
    const table = jarTable({ first: { ...stamps(60 * 1000, 5 * 1000), deleted_at: new Date().toISOString() } })
    const door = await openDoor()
    corn()
    save(); await failed()
    tap('door-from'); typeInto('door-notes', 'the second tray')
    save()
    await answered(door, 2)
    expect(errorText()).toBe('“Corn” was saved earlier and has been removed since. This Save did not change that.')
    expect(otherWrites()).toEqual([])
    expect(table.row.notes).toBeNull()
  })

  it('the first body never arrived and the changed one landed with its answer lost: Save again finds the jar already holding what is on screen — a save, nothing written', async () => {
    const table = jarTable({ lands: 2 })
    const door = await openDoor()
    corn()
    save(); await failed()
    tap('door-from'); typeInto('door-notes', 'the second tray')
    save()
    await waitFor(() => expect(posts()).toHaveLength(2))
    await failed()
    expect(table.row.notes).toBe('the second tray')
    save()
    await waitFor(() => expect(door.onSaved).toHaveBeenCalledTimes(1))
    expect(otherWrites()).toEqual([])
    expect(new Set(keys()).size).toBe(1)
    expect(told(door).saved).toMatchObject({ id: 'jar-first', notes: 'the second tray' })
  })

  it('the PATCH fails (a 5xx): the door says the jar IS in the Pantry and this change may not have saved, tells the page, keeps the form and the key — and Save again finishes it, on the one jar', async () => {
    let fail = true
    const table = jarTable({ onPatch: () => { if (fail) throw apiError(503, { error: 'boom' }) } })
    const door = await openDoor()
    corn()
    save(); await failed()
    tap('door-from'); typeInto('door-notes', 'the second tray')
    save()
    await waitFor(() => expect(patches()).toHaveLength(1))
    await failed(MAYBE)
    expect(door.onExists).toHaveBeenCalledTimes(1)
    expect(door.onSaved).not.toHaveBeenCalled()
    expect(table.row.notes).toBeNull()
    expect(draft()).toMatchObject({ notes: 'the second tray', key: keys()[0] })
    fail = false
    save()
    await waitFor(() => expect(door.onSaved).toHaveBeenCalledTimes(1))
    expect(new Set(keys()).size).toBe(1)
    expect(keys()).toHaveLength(3)
    expect(patches().map(c => c.body.notes)).toEqual(['the second tray', 'the second tray'])
    expect(table.row.notes).toBe('the second tray')
  })

  it('the PATCH is refused with a 4xx: its sentence follows "already in the Pantry" — and the key is NOT minted again (the jar exists)', async () => {
    jarTable({ onPatch: () => { throw apiError(409, { error: 'This was changed somewhere else — close and open it again.' }) } })
    const door = await openDoor()
    corn()
    save(); await failed()
    tap('door-from'); typeInto('door-notes', 'the second tray')
    save()
    await failed('“Corn” is already in the Pantry — an earlier Save went through. This change did not save: This was changed somewhere else — close and open it again.')
    expect(door.onSaved).not.toHaveBeenCalled()
    save()
    await waitFor(() => expect(posts()).toHaveLength(3))
    expect(new Set(keys()).size).toBe(1)
    expect(draft().key).toBe(keys()[0])
  })

  // The PATCH is refused because the jar was changed elsewhere (the route's own guard). Its stamp has moved —
  // by the other writer. A PATCH that was ANSWERED with a 4xx did not land, so that moved stamp is not this door's.
  it('the PATCH is refused with a 4xx and the jar is changed by someone else meanwhile: Save again writes NOTHING over their change — the door says it was saved earlier', async () => {
    const table = jarTable({ onPatch: () => {
      table.row = { ...table.row, notes: 'Jen: top shelf', updated_at: new Date().toISOString() }
      throw apiError(409, { error: 'This was changed somewhere else — close and open it again.' })
    } })
    const door = await openDoor()
    corn()
    save(); await failed()
    tap('door-from'); typeInto('door-notes', 'the second tray')
    save()
    await failed('“Corn” is already in the Pantry — an earlier Save went through. This change did not save: This was changed somewhere else — close and open it again.')
    save()
    await answered(door, 3)
    expect(errorText()).toBe(STALE)
    expect(patches()).toHaveLength(1)                                          // no second PATCH
    expect(table.row.notes).toBe('Jen: top shelf')
    expect(door.onSaved).not.toHaveBeenCalled()
    expect(new Set(keys()).size).toBe(1)
  })

  // QA I-2 (the sequence the review ran as J4). A PATCH whose answer was lost may never have reached the server.
  // Someone else then renames the jar and notes it: its stamp has moved — by THEM. "This door sent a PATCH to
  // this jar" is not enough to call that stamp its own: the jar does not hold what the PATCH sent.
  it('QA I-2 — the PATCH never reached the server and the jar is renamed and noted by someone else meanwhile: Save again writes NOTHING over their change — the door says it was saved earlier', async () => {
    const table = jarTable({ onPatch: () => {
      table.row = { ...table.row, label: 'Jen’s corn', notes: 'Jen: top shelf', updated_at: new Date().toISOString() }
      LOST()                                                                    // thrown before the table applies it: it did not land
    } })
    const door = await openDoor()
    corn()
    save(); await failed()
    tap('door-from'); typeInto('door-notes', 'mine')
    save()
    await failed(MAYBE)
    expect(table.row).toMatchObject({ label: 'Jen’s corn', notes: 'Jen: top shelf' })
    save()
    await answered(door, 3)
    expect(errorText()).toBe('“Jen’s corn” was already saved earlier — it is in the Pantry. This Save did not change it. To change it, open it in the Pantry.')
    expect(patches()).toHaveLength(1)                                          // no second PATCH
    expect(table.row).toMatchObject({ label: 'Jen’s corn', notes: 'Jen: top shelf' })
    expect(door.onSaved).not.toHaveBeenCalled()
    expect(new Set(keys()).size).toBe(1)
    await waitFor(() => expect(draft()).toBeNull())                            // "saved earlier" ends the stored draft
  })

  it('QA I-2 — the PATCH LANDED with its answer lost, and someone else then changes a part it sent: the jar no longer holds this door\'s PATCH, so a further change is NOT written over theirs', async () => {
    const table = jarTable({ onPatch: (n) => (n === 1 ? 'lost' : undefined) })
    const door = await openDoor()
    corn()
    save(); await failed()
    tap('door-from'); typeInto('door-notes', 'the second tray')
    save()
    await failed(MAYBE)
    expect(table.row.notes).toBe('the second tray')                            // it landed
    table.row = { ...table.row, notes: 'Jen: top shelf', updated_at: new Date().toISOString() }
    typeInto('door-notes', 'the second tray, blanched')
    save()
    await answered(door, 3)
    expect(errorText()).toBe(STALE)
    expect(patches()).toHaveLength(1)
    expect(table.row.notes).toBe('Jen: top shelf')
    expect(door.onSaved).not.toHaveBeenCalled()
  })

  it('QA I-2 — … but a part the PATCH did NOT send, changed by someone else, is not this door\'s to judge: the jar still holds every part it sent, and the further change goes onto it (their part is left as they set it)', async () => {
    const table = jarTable({ onPatch: (n) => (n === 1 ? 'lost' : undefined) })
    const door = await openDoor()
    corn()
    save(); await failed()
    tap('door-from'); typeInto('door-notes', 'the second tray')
    save()
    await failed(MAYBE)
    table.row = { ...table.row, container_label: 'Jen’s tub', updated_at: new Date().toISOString() }
    typeInto('door-notes', 'the second tray, blanched')
    save()
    await waitFor(() => expect(door.onSaved).toHaveBeenCalledTimes(1))
    expect(patches().map(c => c.body.notes)).toEqual(['the second tray', 'the second tray, blanched'])
    expect(table.row).toMatchObject({ notes: 'the second tray, blanched', container_label: 'Jen’s tub' })
  })

  // An answered 4xx did not land, so the update this door keeps goes back to the one before it — which did.
  it('QA I-2 — a PATCH that landed with its answer lost, then a second one the server refuses with a 4xx: the jar still holds the FIRST, which is this door\'s — Save again finishes on it', async () => {
    const table = jarTable({ onPatch: (n) => { if (n === 1) return 'lost'; if (n === 2) throw apiError(400, { error: 'That is not a method this app knows.' }); return undefined } })
    const door = await openDoor()
    corn()
    save(); await failed()
    tap('door-from'); typeInto('door-notes', 'the second tray')
    save()
    await failed(MAYBE)
    typeInto('door-notes', 'the second tray, blanched')
    save()
    await failed('“Corn” is already in the Pantry — an earlier Save went through. This change did not save: That is not a method this app knows.')
    expect(table.row.notes).toBe('the second tray')
    save()
    await waitFor(() => expect(door.onSaved).toHaveBeenCalledTimes(1))
    expect(patches()).toHaveLength(3)
    expect(table.row.notes).toBe('the second tray, blanched')
    expect(new Set(keys()).size).toBe(1)
  })

  it('the PATCH LANDED and only its answer was lost: the door says the change MAY not have saved; Save again finds the jar holding it — no second PATCH; and a FURTHER change before that Save still goes onto it (the moved stamp is this door\'s own)', async () => {
    const table = jarTable({ onPatch: (n) => (n === 1 ? 'lost' : undefined) })
    const door = await openDoor()
    corn()
    save(); await failed()
    tap('door-from'); typeInto('door-notes', 'the second tray')
    save()
    await waitFor(() => expect(patches()).toHaveLength(1))
    await failed(MAYBE)
    expect(table.row.updated_at).not.toBe(table.row.created_at)
    expect(door.onSaved).not.toHaveBeenCalled()
    typeInto('door-notes', 'the second tray, blanched')
    save()
    await waitFor(() => expect(door.onSaved).toHaveBeenCalledTimes(1))
    expect(new Set(keys()).size).toBe(1)
    expect(patches().map(c => [c.path, c.body.notes])).toEqual([[ROW, 'the second tray'], [ROW, 'the second tray, blanched']])
    expect(told(door).saved).toMatchObject({ id: 'jar-first', notes: 'the second tray, blanched' })
  })

  // Delta F-6 (the reviewer's T3, at this door's put-up route). Three bad answers in a row: the create's (it
  // landed), the first PATCH's (it landed), the second PATCH's (it never arrived). The jar holds this door's EARLIER
  // PATCH, and is still its own only because the door keeps every update it sent, not the last one alone.
  it('delta F-6 (T3) — Save lands lost; notes "a", its PATCH lands lost; notes "b", its PATCH never arrives; Save: the jar holds this door\'s EARLIER PATCH — still its own — so "b" goes on and it is saved: one jar, one key', async () => {
    const table = jarTable({ onPatch: (n) => { if (n === 2) LOST(); return n === 1 ? 'lost' : undefined } })
    const door = await openDoor()
    corn()
    save(); await failed()
    tap('door-from'); typeInto('door-notes', 'a')
    save()
    await waitFor(() => expect(patches()).toHaveLength(1))
    await failed(MAYBE)
    typeInto('door-notes', 'b')
    save()
    await waitFor(() => expect(patches()).toHaveLength(2))
    await failed(MAYBE)
    expect(table.row.notes).toBe('a')                                           // the second PATCH never arrived
    save()
    await waitFor(() => expect(door.onSaved).toHaveBeenCalledTimes(1))
    expect(errorText()).toBeNull()
    expect(patches().map(c => [c.path, c.body.notes])).toEqual([[ROW, 'a'], [ROW, 'b'], [ROW, 'b']])
    expect(table.row).toMatchObject({ id: 'jar-first', notes: 'b' })
    expect(told(door).saved).toMatchObject({ id: 'jar-first', notes: 'b' })
    expect(posts()).toHaveLength(4)
    expect(new Set(keys()).size).toBe(1)
    expect(draft()).toBeNull()
  })

  it('… and untouched after that lost answer: the jar already holds it — a save, with no second PATCH', async () => {
    jarTable({ onPatch: (n) => (n === 1 ? 'lost' : undefined) })
    const door = await openDoor()
    corn()
    save(); await failed()
    tap('door-from'); typeInto('door-notes', 'the second tray')
    save()
    await failed(MAYBE)
    save()
    await waitFor(() => expect(door.onSaved).toHaveBeenCalledTimes(1))
    expect(patches()).toHaveLength(1)
    expect(new Set(keys()).size).toBe(1)
    expect(told(door).saved).toMatchObject({ notes: 'the second tray' })
  })

  // QA I-1. One key goes to TWO tables: the put-up route keeps it in preservation_log, As is in pantry_item, and
  // neither looks in the other. So a Save on the other route under a key that has (or may have) already made a
  // row is a second thing for one sitting. It is refused BEFORE anything is sent — never under a new key either.
  const OTHER_WAY_MAYBE = 'An earlier Save of this as a put-up may have gone through. It can\'t also be saved as “As is” from here. Choose the method again and tap Save to finish that one.'
  const OTHER_WAY_KNOWN = '“Corn” is already in the Pantry as a put-up — an earlier Save went through. It can\'t also be saved as “As is” from here. If you want both, close this and start a new one.'
  it('QA I-1 (J1) — the put-up landed with its answer lost, then As is, Save: REFUSED, nothing sent — one key never makes a jar AND an item. Not known to have landed, so the draft and its key stay; the method chosen again finishes the one jar', async () => {
    const on = watchScrolls()
    const table = jarTable()
    const door = await openDoor()
    corn()
    save(); await failed()
    tap('door-method-as_is')
    on.length = 0
    save()
    await failed(OTHER_WAY_MAYBE)
    expect(screen.getByTestId('door-error').getAttribute('role')).toBe('alert')
    await waitFor(() => expect(broughtIntoView(on, 'door-error')).toBe(true))
    expect(posts(ITEMS)).toHaveLength(0)
    expect(posts()).toHaveLength(1)
    expect(door.onSaved).not.toHaveBeenCalled()
    expect(draft()).toMatchObject({ key: keys()[0], method: 'as_is' })
    save()
    await failed(OTHER_WAY_MAYBE)                                              // refused again, and still nothing sent
    expect(posts(ITEMS)).toHaveLength(0)
    method('whole_freeze')
    save()
    await waitFor(() => expect(door.onSaved).toHaveBeenCalledTimes(1))
    expect(told(door)).toMatchObject({ route: 'jar', saved: { id: 'jar-first' } })
    expect(new Set(keys()).size).toBe(1)
    expect(posts(ITEMS)).toHaveLength(0)
    expect(table.posts).toBe(2)
    expect(draft()).toBeNull()
  })

  it('QA I-1 (J2) — the put-up landed lost, the date changed, Save (refused: the date), then As is, Save: REFUSED — the jar is KNOWN to be in the Pantry. Nothing is sent, the page is told, the stored draft is ended, and the door opened next is a clean one', async () => {
    jarTable()
    const door = await openDoor()
    corn()
    save(); await failed()
    tap('door-more'); tap('door-when-yesterday')
    save()
    await answered(door, 2)
    expect(errorText()).toMatch(/^Already in the Pantry as “Corn”/)
    expect(draft()).toMatchObject({ key: keys()[0] })
    tap('door-method-as_is')
    save()
    await failed(OTHER_WAY_KNOWN)
    expect(posts(ITEMS)).toHaveLength(0)
    expect(posts()).toHaveLength(2)
    expect(door.onSaved).not.toHaveBeenCalled()
    expect(door.onExists).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(draft()).toBeNull())                            // the first Save landed: the stored draft has done its job
    tap('door-from'); typeInto('door-notes', 'still here')                     // … and nothing typed after writes it back
    expect(draft()).toBeNull()
    save()
    await failed(OTHER_WAY_KNOWN)
    expect(posts(ITEMS)).toHaveLength(0)
    door.unmount()
    await openDoor()
    expect(screen.getByTestId('door-what-name').value).toBe('')
    expect(draft()).toBeNull()
  })

  it('QA I-1 — after "saved earlier" on the put-up route, As is, Save: refused the same way (the jar is known), nothing sent', async () => {
    jarTable({ first: { ...stamps(LONG_AGO) } })
    const door = await openDoor()
    corn()
    save(); await failed()
    typeInto('door-what-name', 'Corn, cut')
    save()
    await failed(STALE)
    tap('door-method-as_is')
    save()
    await failed(OTHER_WAY_KNOWN)
    expect(posts(ITEMS)).toHaveLength(0)
    expect(door.onSaved).not.toHaveBeenCalled()
  })

  it('QA I-1 (J8) — As is landed with its answer lost, then a method chip, Save: REFUSED, no put-up sent; “As is” chosen again finishes the one item', async () => {
    let n = 0
    const item = { id: 'item-first', user_id: 'user_dave', name: 'Corn', storage_location_id: 'loc-1', place: { ...PLACES[0] },
      acquired_at: '2026-10-01', acquired_precision: 'day', use_by_target: null, plant_id: null, crop_type_slug: null,
      quantity_value: null, quantity_unit: null, source_kind: null, source_label: null, used_up_at: null, notes: null,
      created_at: new Date().toISOString(), updated_at: null, deleted_at: null }
    item.updated_at = item.created_at
    fake = pantryFetch({ rows: [], overrides: { [`POST ${ITEMS}`]: () => { if (++n === 1) LOST(); return { item, replayed: true } } } })
    stableFetch.fn = fake
    const door = await openDoor()
    typeInto('door-what-name', 'Corn'); tap('door-place-id:loc-1'); tap('door-method-as_is')
    save(); await failed()
    method('whole_freeze')
    save()
    await failed('An earlier Save of this as “As is” may have gone through. It can\'t also be saved as a put-up from here. Choose “As is” again and tap Save to finish that one.')
    expect(posts(JARS)).toHaveLength(0)
    expect(draft()).toMatchObject({ key: keys(ITEMS)[0] })
    tap('door-method-as_is')
    save()
    await waitFor(() => expect(door.onSaved).toHaveBeenCalledTimes(1))
    expect(told(door)).toMatchObject({ route: 'item', saved: { id: 'item-first' } })
    expect(posts(JARS)).toHaveLength(0)
    expect(new Set(keys(ITEMS)).size).toBe(1)
  })

  it('a double tap on Save sends one request', async () => {
    jarTable()
    const door = await openDoor()
    corn()
    save(); save()
    await failed()
    expect(posts()).toHaveLength(1)
    tap('door-from'); typeInto('door-notes', 'the second tray')
    save(); save()
    await waitFor(() => expect(door.onSaved).toHaveBeenCalledTimes(1))
    expect(posts()).toHaveLength(2)
    expect(patches()).toHaveLength(1)
  })

  // The route validates a body BEFORE it looks the key up, so a refusal of a changed body says nothing about
  // the one that went out first: that one may be in the Pantry. (The item route has kept its key here since
  // BUG-PUTUPREPLAYDROPSEDIT-001; the put-up route minted a new one, and the Save after made a second jar.)
  it('a lost answer, then a CHANGED body the server refuses with a 4xx: the key is KEPT — and the Save after goes onto that jar, never a second one', async () => {
    const table = jarTable({ onPost: (n) => { if (n === 2) throw apiError(400, { error: 'no' }); return undefined } })
    const door = await openDoor()
    corn()
    save(); await failed()
    tap('door-from'); typeInto('door-notes', 'the second tray')
    save(); await failed('no')
    expect(draft()).toMatchObject({ key: keys()[0] })
    save()
    await waitFor(() => expect(door.onSaved).toHaveBeenCalledTimes(1))
    expect(new Set(keys()).size).toBe(1)
    expect(patches().map(c => [c.path, c.body.notes])).toEqual([[ROW, 'the second tray']])
    expect(table.row.notes).toBe('the second tray')
  })

  it('an answered 4xx on the FIRST create still mints a new key (nothing went out before it)', async () => {
    let n = 0
    fake = pantryFetch({ rows: [], overrides: { [`POST ${JARS}`]: ({ body }) => { if (++n === 1) throw apiError(400, { error: 'no' }); return { id: 'jar-1', ...body } } } })
    stableFetch.fn = fake
    const door = await openDoor()
    corn()
    save(); await failed('no')
    save()
    await waitFor(() => expect(door.onSaved).toHaveBeenCalledTimes(1))
    expect(keys()[1]).not.toBe(keys()[0])
  })

  // Re-review I-A, the door's side (it already had this right; pinned so it stays so): an ANSWERED 4xx on the first
  // create binds the door to no route — the other way goes out, under the new key.
  it('re-review I-A — a put-up the server ANSWERED with a 400, then As is, Save: ONE item POST, saved — nothing says an earlier Save may have gone through', async () => {
    fake = pantryFetch({ rows: [], overrides: { [`POST ${JARS}`]: () => { throw apiError(400, { error: 'no' }) } } })
    stableFetch.fn = fake
    const door = await openDoor()
    corn()
    save(); await failed('no')
    tap('door-method-as_is')
    save()
    await waitFor(() => expect(door.onSaved).toHaveBeenCalledTimes(1))
    expect(told(door).route).toBe('item')
    expect(posts(ITEMS)).toHaveLength(1)
    expect(posts()).toHaveLength(1)
    expect(keys(ITEMS)[0]).not.toBe(keys()[0])
  })

  // Re-review M-A (the reviewer's S4a).
  it('re-review M-A (S4a) — a planting, “Fresh, as picked” at the fridge with its answer lost; the place changed to a freezer (no such chip there), a method, Save: refused — and the line names a way that IS on screen. Followed, the one item is finished: no put-up', async () => {
    const planting = { source: 'planting', name: 'Megatron jalapeño', plant_id: 'p1', crop_type_slug: 'pepper', variety_id: 'v1' }
    let n = 0
    fake = pantryFetch({ rows: [], overrides: { [`POST ${ITEMS}`]: ({ body }) => { if (++n === 1) LOST(); return { item: { id: 'item-new', ...body } } } } })
    stableFetch.fn = fake
    const door = await openDoor({ initialWhat: planting })
    tap('door-place-id:loc-3'); tap('door-method-as_is')
    save(); await failed()
    tap('door-place-id:loc-1')                                                 // a freezer: a planting has no “Fresh, as picked” there
    await waitFor(() => expect(screen.queryByTestId('door-method-as_is')).toBeNull())
    method('whole_freeze')
    save()
    await failed('An earlier Save of this as “Fresh, as picked” may have gone through. It can\'t also be saved as a put-up from here. Pick the place it was saved to, then choose “Fresh, as picked” and tap Save to finish that one.')
    expect(posts()).toHaveLength(0)
    tap('door-place-id:loc-3'); tap('door-method-as_is')                       // as the line says
    save()
    await waitFor(() => expect(door.onSaved).toHaveBeenCalledTimes(1))
    expect(told(door).route).toBe('item')
    expect(posts(ITEMS)).toHaveLength(2)
    expect(new Set(keys(ITEMS)).size).toBe(1)
    expect(posts()).toHaveLength(0)
  })

  // Found twice on 2026-10-08 (the spent-key lane's S4): As is, lost; a change; refused "saved earlier"; a
  // method chip, and the put-up route answers a 4xx — which minted a NEW key although item Saves had gone out
  // under the old one; back to As is, Save: a second item.
  it('QA I-1 — after a "saved earlier" refusal on As is, a method chip, Save: the put-up is NOT sent (the item is known) and no new key is minted: back on As is, Save is refused again — one item', async () => {
    const item = {
      id: 'item-first', user_id: 'user_dave', name: 'Oat milk', storage_location_id: 'loc-3', place: { ...PLACES[2] },
      acquired_at: '2026-10-01', acquired_precision: 'day', use_by_target: null, plant_id: null, crop_type_slug: null,
      quantity_value: null, quantity_unit: null, source_kind: null, source_label: null, used_up_at: null, notes: null,
      ...stamps(LONG_AGO), deleted_at: null,
    }
    let n = 0
    fake = pantryFetch({ rows: [], overrides: {
      [`POST ${ITEMS}`]: () => { if (++n === 1) LOST(); return { item, replayed: true } },
      [`POST ${JARS}`]: () => { throw apiError(400, { error: 'no' }) },
    } })
    stableFetch.fn = fake
    const door = await openDoor()
    typeInto('door-what-name', 'Oat milk'); tap('door-place-id:loc-3'); tap('door-method-as_is')
    save(); await failed()
    tap('door-from'); typeInto('door-notes', 'the second carton')
    save()
    const ITEM_STALE = '“Oat milk” was already saved earlier — it is in the Pantry. This Save did not change it. To change it, open it in the Pantry.'
    await failed(ITEM_STALE)
    method('quick_pickle')
    save()
    await failed('“Oat milk” is already in the Pantry as “As is” — an earlier Save went through. It can\'t also be saved as a put-up from here. If you want both, close this and start a new one.')
    expect(posts(JARS)).toHaveLength(0)
    tap('door-method-as_is')
    save()
    await waitFor(() => expect(posts(ITEMS)).toHaveLength(3))
    await failed(ITEM_STALE)
    expect(new Set(keys(ITEMS)).size).toBe(1)                                  // ONE key, and only ever on the item route
    expect(posts(JARS)).toHaveLength(0)
    expect(door.onSaved).not.toHaveBeenCalled()
  })
})

describe('the Walk — the put-up route', () => {
  const startWalk = async () => {
    render(<MemoryRouter initialEntries={['/put-up?session=putup']}><PutUp /></MemoryRouter>)
    fireEvent.click(await screen.findByRole('radio', { name: 'Chest Freezer 1' }))
    fireEvent.click(screen.getByRole('radio', { name: 'This month' }))
    fireEvent.click(screen.getByTestId('putup-walk-start'))
    await screen.findByTestId('putup-walk-group')
  }
  const typeWhat = (v) => typeInto('walk-what-name', v)
  const method = (m) => { if (!screen.queryByTestId(`walk-method-${m}`)) tap('walk-method-more'); tap(`walk-method-${m}`) }
  const corn = () => { typeWhat('Corn'); method('whole_freeze') }
  const save = () => tap('walk-save')
  const errorText = () => screen.queryByTestId('walk-error')?.textContent ?? null
  const failed = (text = "Couldn't save it — what you entered is kept. Try again.") => waitFor(() => expect(errorText()).toBe(text))
  const landed = () => waitFor(() => expect([screen.getByTestId('walk-what-name').value, errorText()]).toEqual(['', null]))
  const band = () => screen.queryByTestId('putup-walk-last')?.textContent ?? null
  const answered = async (nth) => {
    await waitFor(() => expect(posts()).toHaveLength(nth))
    await waitFor(() => expect(screen.getByTestId('walk-save').disabled).toBe(false))
  }

  it('a lost answer, the name and the count changed, Save: ONE jar — the same key, ONE PATCH onto it; the band says what the jar holds', async () => {
    const table = jarTable()
    await startWalk()
    corn()
    save(); await failed()
    typeWhat('Corn, cut'); tap('walk-count-plus'); tap('walk-count-plus')
    save(); await landed()
    expect(keys()).toHaveLength(2)
    expect(new Set(keys()).size).toBe(1)
    expect(otherWrites()).toEqual([['PATCH', ROW]])
    expect(patches()[0].body).toMatchObject({ label: 'Corn, cut', package_count: 3, method: 'whole_freeze', discard_by: 'clear', notes: null })
    expect(table.row).toMatchObject({ label: 'Corn, cut', package_count: 3 })
    expect(band()).toBe('✓ 3 × Corn, cut · Freeze whole')
  })

  it('the band is built from the server\'s jar, never from the form: a replay answered with a jar that reads otherwise is said as the jar reads', async () => {
    fake = pantryFetch({ rows: [], overrides: { [`POST ${JARS}`]: ({ body }) => ({ ...rawJar(body), label: 'Corn (as first saved)', package_count: 3, method: 'blanch_freeze', replayed: true }) } })
    stableFetch.fn = fake
    await startWalk()
    typeWhat('Corn, edited since'); method('whole_freeze')
    save(); await landed()
    expect(band()).toBe('✓ 3 × Corn (as first saved) · Blanch & freeze')
    expect(otherWrites()).toEqual([])
  })

  it('a lost answer, Save again untouched: one jar, nothing written, the band from the jar', async () => {
    jarTable()
    await startWalk()
    corn()
    save(); await failed()
    save(); await landed()
    expect(new Set(keys()).size).toBe(1)
    expect(otherWrites()).toEqual([])
    expect(band()).toBe('✓ 1 × Corn · Freeze whole')
  })

  it('"A different date for this one" changed after a lost answer: NOTHING is written — the walk says the date cannot change, brings the line into view above its band and keeps the key; Save again is refused again; put back, the rest goes through', async () => {
    const on = watchScrolls()
    const table = jarTable()
    await startWalk()
    corn()
    save(); await failed()
    const before = { ...table.row }
    tap('walk-more'); tap('walk-own-unsure'); tap('walk-count-plus')
    tap('walk-more')                                                           // the options closed again: this group's date is out of sight
    expect(screen.queryByTestId('walk-own-unsure')).toBeNull()
    on.length = 0
    save()
    await answered(2)
    expect(errorText()).toBe(whenText('Corn', walkDay(table.row)))
    expect(screen.getByTestId('walk-own-unsure')).toBeTruthy()                 // QA M-4: the refusal opens what it is about
    await waitFor(() => expect(broughtIntoView(on, 'walk-error')).toBe(true))
    expect(otherWrites()).toEqual([])
    expect(table.row).toEqual(before)
    expect(band()).toBeNull()                                                  // nothing is said as saved
    expect(screen.getByTestId('walk-what-name').value).toBe('Corn')
    save()
    await answered(3)
    expect(errorText()).toBe(whenText('Corn', walkDay(table.row)))
    tap('walk-own-unsure')                                                     // back to the walk's own date
    save(); await landed()
    expect(new Set(keys()).size).toBe(1)
    expect(patches().map(c => [c.path, c.body.package_count])).toEqual([[ROW, 2]])
    expect(band()).toBe('✓ 2 × Corn · Freeze whole')
  })

  it('a jar made longer ago than the bound (the walk sat a while), the name changed, Save: nothing is written; the walk says it was saved earlier and keeps the key — refused again, never a second jar', async () => {
    const on = watchScrolls()
    const table = jarTable({ first: { ...stamps(LONG_AGO) } })
    await startWalk()
    corn()
    save(); await failed()
    const before = { ...table.row }
    typeWhat('Peas')
    on.length = 0
    save()
    await answered(2)
    expect(errorText()).toBe(STALE + WALK_ON)
    await waitFor(() => expect(broughtIntoView(on, 'walk-error')).toBe(true))
    expect(otherWrites()).toEqual([])
    expect(table.row).toEqual(before)
    expect(band()).toBeNull()
    save()
    await answered(3)
    expect(errorText()).toBe(STALE + WALK_ON)
    expect(new Set(keys()).size).toBe(1)
    expect(screen.getByTestId('walk-what-name').value).toBe('Peas')
  })

  // BUG-WALKSAVEUNDERBAND-001. The line alone was brought clear of the band, and each row of it past the first
  // left the group's Save 15 px further under (delta F-7). What is scrolled is the ONE box that holds both.
  // jsdom lays nothing out: the pixels are scripts/layout-gate/putup-refusal-view.mjs --sheet walk.
  it('BUG-WALKSAVEUNDERBAND-001 — a refused Save brings the line AND the group\'s Save into view as one box, above the band: a failed Save, then a replay refusal', async () => {
    const on = watchScrolls()
    jarTable({ first: { ...stamps(LONG_AGO) } })
    await startWalk()
    corn()
    for (const [nth, text] of [[1, "Couldn't save it — what you entered is kept. Try again."], [2, STALE + WALK_ON]]) {
      if (nth === 2) tap('walk-count-plus')
      on.length = 0
      save()
      await answered(nth)
      expect(errorText()).toBe(text)
      await waitFor(() => expect(on).toHaveLength(1))
      const box = on[0]
      expect([box.contains(screen.getByTestId('walk-error')), box.contains(screen.getByTestId('walk-save'))]).toEqual([true, true])
      // Only those two: not the group, whose top would then be what `nearest` works from.
      expect([box === screen.getByTestId('putup-walk-group'), box.contains(screen.getByTestId('walk-what-name'))]).toEqual([false, false])
      expect(parseInt(box.style.scrollMarginBottom, 10)).toBeGreaterThan(12)
    }
  })

  // BUG-PUTUPRETRYCOPYRESIDUE-001 (b). The five refusals said before anything is sent set the line and returned;
  // only a server's refusal was brought into view.
  it('BUG-PUTUPRETRYCOPYRESIDUE-001 (b) — a refusal said before anything is sent is brought into view like any other: no name, no method, no date, no discard date, offline — and nothing goes out', async () => {
    const on = watchScrolls()
    await startWalk()
    const refused = async (text) => {
      on.length = 0
      save()
      expect(errorText()).toBe(text)
      await waitFor(() => expect(on).toHaveLength(1))
      expect([on[0].contains(screen.getByTestId('walk-error')), on[0].contains(screen.getByTestId('walk-save'))]).toEqual([true, true])
    }
    await refused('What is it? Type a name.')
    expect(document.activeElement).toBe(screen.getByTestId('walk-what-name'))  // the focus moves as it did
    typeWhat('Corn')
    await refused(METHOD_REQUIRED_TEXT)
    method('whole_freeze')
    tap('walk-more'); tap('walk-own-pickdate')
    await refused('Pick the date — or tap Not sure.')
    tap('walk-own-pickdate')                                                   // back to the walk's own date
    tap('walk-discard-date')
    await refused(DISCARD_DATE_TEXT)
    tap('walk-discard-auto')
    fireEvent(window, new Event('offline'))
    await refused("You're offline — this can't be saved right now. What you entered is kept.")
    expect(fake.calls().filter(c => c.method !== 'GET')).toEqual([])
  })

  it('the PATCH fails (a 5xx): the walk says the jar IS in the Pantry and this change may not have saved, reads the place again — and Save again finishes it on the one jar', async () => {
    let fail = true
    const table = jarTable({ onPatch: () => { if (fail) throw apiError(500, { error: 'boom' }) } })
    await startWalk()
    corn()
    save(); await failed()
    typeWhat('Corn, cut')
    const reads = () => fake.calls('GET', '/api/pantry?').length
    const before = reads()
    save()
    await waitFor(() => expect(patches()).toHaveLength(1))
    await failed(MAYBE)
    await waitFor(() => expect(reads()).toBeGreaterThan(before))
    expect(band()).toBeNull()
    fail = false
    save(); await landed()
    expect(new Set(keys()).size).toBe(1)
    expect(patches()).toHaveLength(2)
    expect(table.row.label).toBe('Corn, cut')
    expect(band()).toBe('✓ 1 × Corn, cut · Freeze whole')
  })

  it('the PATCH is refused with a 4xx and the jar is changed by someone else meanwhile: Save again writes nothing over their change', async () => {
    const table = jarTable({ onPatch: () => {
      table.row = { ...table.row, label: 'Corn (Jen)', updated_at: new Date().toISOString() }
      throw apiError(409, { error: 'This was changed somewhere else — close and open it again.' })
    } })
    await startWalk()
    corn()
    save(); await failed()
    typeWhat('Corn, cut')
    save()
    await waitFor(() => expect(patches()).toHaveLength(1))
    await waitFor(() => expect(errorText()).toMatch(/This change did not save: This was changed somewhere else/))
    save()
    await answered(3)
    expect(errorText()).toBe(`“Corn (Jen)” was already saved earlier — it is in the Pantry. This Save did not change it. To change it, open it in the Pantry.${WALK_ON}`)
    expect(patches()).toHaveLength(1)
    expect(table.row.label).toBe('Corn (Jen)')
    expect(band()).toBeNull()
  })

  it('QA M-5 — in the walk: the jar was removed since, Save again untouched — the band does not tick a removed jar; the walk says it was removed', async () => {
    jarTable({ first: { deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() } })
    await startWalk()
    corn()
    save(); await failed()
    save()
    await answered(2)
    expect(errorText()).toBe(`“Corn” was saved earlier and has been removed since. This Save did not change that.${WALK_ON}`)
    expect(band()).toBeNull()
    expect(otherWrites()).toEqual([])
  })

  it('QA I-1 — the put-up landed with its answer lost, then As is, Save: REFUSED in the walk too, nothing sent; the method chosen again finishes the one jar. And once the jar is KNOWN, the walk says how to have both', async () => {
    const table = jarTable()
    await startWalk()
    corn()
    save(); await failed()
    tap('walk-method-as_is')
    save()
    await failed('An earlier Save of this as a put-up may have gone through. It can\'t also be saved as “As is” from here. Choose the method again and tap Save to finish that one.')
    expect(posts(ITEMS)).toHaveLength(0)
    expect(posts()).toHaveLength(1)
    expect(band()).toBeNull()
    // The jar becomes KNOWN: a Save the first way, with a date of its own (a part no PATCH carries), is answered with it.
    method('whole_freeze'); tap('walk-more'); tap('walk-own-unsure')
    save()
    await answered(2)
    expect(errorText()).toMatch(/^Already in the Pantry as “Corn”/)
    tap('walk-method-as_is')
    save()
    await failed('“Corn” is already in the Pantry as a put-up — an earlier Save went through. It can\'t also be saved as “As is” from here. If you want both, end this walk and start another.')
    expect(posts(ITEMS)).toHaveLength(0)
    expect(posts()).toHaveLength(2)
    expect(new Set(keys()).size).toBe(1)
    expect(band()).toBeNull()
    expect(table.row.id).toBe('jar-first')
  })

  // Re-review I-A. A create the server ANSWERED with a 4xx did not land (idempotencyKey.js), so it is not a Save
  // that "may have gone through": the group is not bound to that route, and the other way goes out.
  it('re-review I-A — a put-up the server ANSWERED with a 400 did not land: As is, Save goes out — ONE item POST, saved, and nothing says an earlier Save may have gone through', async () => {
    fake = pantryFetch({ rows: [], overrides: { [`POST ${JARS}`]: () => { throw apiError(400, { error: 'That method is not one of ours.' }) } } })
    stableFetch.fn = fake
    await startWalk()
    corn()
    save()
    await answered(1)
    expect(errorText()).not.toBeNull()
    expect(band()).toBeNull()
    tap('walk-method-as_is')
    save(); await landed()
    expect(posts(ITEMS)).toHaveLength(1)
    expect(posts()).toHaveLength(1)
    expect(band()).toBe('✓ Corn · As is')
  })

  it('re-review I-A — the other way: As is ANSWERED with a 429, then a method, Save: ONE put-up POST, saved', async () => {
    fake = pantryFetch({ rows: [], overrides: { [`POST ${ITEMS}`]: () => { throw apiError(429, { error: 'Too many at once — try again in a moment.' }) } } })
    stableFetch.fn = fake
    await startWalk()
    typeWhat('Corn'); tap('walk-method-as_is')
    save()
    await waitFor(() => expect(posts(ITEMS)).toHaveLength(1))
    await waitFor(() => expect(screen.getByTestId('walk-save').disabled).toBe(false))
    expect(errorText()).not.toBeNull()
    method('whole_freeze')
    save(); await landed()
    expect(posts()).toHaveLength(1)
    expect(posts(ITEMS)).toHaveLength(1)
    expect(band()).toBe('✓ 1 × Corn · Freeze whole')
  })

  it('re-review I-A — only the ANSWERED one is taken back: a put-up whose answer was LOST, then a changed one answered 400, then As is — still refused (the first may have gone through), nothing sent', async () => {
    const table = jarTable({ onPost: (n) => { if (n === 2) throw apiError(400, { error: 'Not that one.' }); return undefined } })
    await startWalk()
    corn()
    save(); await failed()
    typeWhat('Corn, cut')
    save()
    await answered(2)
    expect(errorText()).not.toBeNull()
    tap('walk-method-as_is')
    save()
    await failed('An earlier Save of this as a put-up may have gone through. It can\'t also be saved as “As is” from here. Choose the method again and tap Save to finish that one.')
    expect(posts(ITEMS)).toHaveLength(0)
    expect(posts()).toHaveLength(2)
    expect(table.row.label).toBe('Corn')
  })

  it('QA I-2 — the PATCH never reached the server and the jar is renamed by someone else meanwhile: Save again writes nothing over their change — the walk says it was saved earlier', async () => {
    const table = jarTable({ onPatch: () => {
      table.row = { ...table.row, label: 'Corn (Jen)', updated_at: new Date().toISOString() }
      LOST()                                                                    // it did not land
    } })
    await startWalk()
    corn()
    save(); await failed()
    typeWhat('Corn, cut')
    save()
    await waitFor(() => expect(patches()).toHaveLength(1))
    await failed(MAYBE)
    save()
    await answered(3)
    expect(errorText()).toBe(`“Corn (Jen)” was already saved earlier — it is in the Pantry. This Save did not change it. To change it, open it in the Pantry.${WALK_ON}`)
    expect(patches()).toHaveLength(1)
    expect(table.row.label).toBe('Corn (Jen)')
    expect(band()).toBeNull()
    expect(new Set(keys()).size).toBe(1)
  })

  // Re-review I-E. The key is kept through a refusal (never a second row), so the group is spent — and the line
  // now says the way on. Followed: a clean group, and what is saved there goes out under a key of its own.
  it('re-review I-E — after "saved earlier" the group is refused for the next thing typed there too, under the one key; the line says the way on — End the walk, start another: a CLEAN group, and its Save goes out under a NEW key', async () => {
    let firstKey = null
    jarTable({ first: { ...stamps(LONG_AGO) }, onPost: (n, body) => {
      if (firstKey == null) firstKey = body.idempotency_key
      return body.idempotency_key === firstKey ? undefined : { ...rawJar(body), id: 'jar-second' }   // another key is another jar
    } })
    await startWalk()
    corn()
    save(); await failed()
    typeWhat('Peas')
    save()
    await answered(2)
    expect(errorText()).toBe(STALE + WALK_ON)
    typeWhat('Beans')                                                           // the next thing, typed in the same group
    save()
    await answered(3)
    expect(errorText()).toBe(STALE + WALK_ON)
    expect(keys()).toEqual([firstKey, firstKey, firstKey])
    expect(band()).toBeNull()
    tap('putup-walk-exit')                                                      // a name is typed, so the walk asks first
    tap('putup-walk-exit-anyway')
    fireEvent.click(await screen.findByTestId('putup-walk-door'))
    fireEvent.click(await screen.findByRole('radio', { name: 'Chest Freezer 1' }))
    fireEvent.click(screen.getByRole('radio', { name: 'This month' }))
    fireEvent.click(screen.getByTestId('putup-walk-start'))
    await screen.findByTestId('putup-walk-group')
    expect([screen.getByTestId('walk-what-name').value, errorText(), band()]).toEqual(['', null, null])
    typeWhat('Beans'); method('whole_freeze')
    save(); await landed()
    expect(posts()).toHaveLength(4)
    expect(keys()[3]).toMatch(/^[0-9a-f-]{36}$/)
    expect(keys()[3]).not.toBe(firstKey)
    expect(band()).toBe('✓ 1 × Beans · Freeze whole')
  })

  // Delta F-2 (the reviewer's W1). The refusal says the thing is in the Pantry and the way on is to end the walk;
  // End the walk then asked `"Corn" isn't saved.` · Save it · End without it — about the thing it had just said
  // is saved. A group spent on the name its refusal's row holds is not asked about: the walk ends.
  const ended = async () => {
    expect(screen.queryByTestId('putup-walk-unsaved')).toBeNull()
    await screen.findByTestId('putup-walk-door')
    expect(screen.queryByTestId('putup-walk-group')).toBeNull()
  }
  it('delta F-2 (W1) — Corn lands with its answer lost; the count changed, Save after ten minutes: "was already saved earlier … end this walk". End the walk: it ENDS — nothing asks whether “Corn” is saved, and no third POST goes out', async () => {
    jarTable({ first: { ...stamps(LONG_AGO) } })
    await startWalk()
    corn()
    save(); await failed()
    tap('walk-count-plus')
    save()
    await answered(2)
    expect(errorText()).toBe(STALE + WALK_ON)
    tap('putup-walk-exit')
    await ended()
    expect(posts()).toHaveLength(2)
    expect(otherWrites()).toEqual([])
  })

  it('delta F-2 — the jar was removed since: "has been removed since … end this walk". End the walk: it ends, with no question', async () => {
    jarTable({ first: { deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() } })
    await startWalk()
    corn()
    save(); await failed()
    save()
    await answered(2)
    expect(errorText()).toBe(`“Corn” was saved earlier and has been removed since. This Save did not change that.${WALK_ON}`)
    tap('putup-walk-exit')
    await ended()
  })

  it('delta F-2 — the spent group comes back whole after "Change": End the walk still ends, with no question', async () => {
    jarTable({ first: { ...stamps(LONG_AGO) } })
    await startWalk()
    corn()
    save(); await failed()
    tap('walk-count-plus')
    save()
    await answered(2)
    expect(errorText()).toBe(STALE + WALK_ON)
    tap('putup-walk-change')
    fireEvent.click(screen.getByTestId('putup-walk-start'))
    await screen.findByTestId('putup-walk-group')
    expect(screen.getByTestId('walk-what-name').value).toBe('Corn')
    tap('putup-walk-exit')
    await ended()
  })

  it('delta F-2 — unchanged for an entry that is NOT saved: a Save whose answer was lost (it may not have landed) is asked about, and “Save it” saves; and ANOTHER name typed into a spent group is asked about', async () => {
    jarTable({ lands: 2, first: { ...stamps(LONG_AGO) } })
    await startWalk()
    corn()
    save(); await failed()                                                      // never reached the server
    tap('putup-walk-exit')
    expect(screen.getByTestId('putup-walk-unsaved-text').textContent).toBe('"Corn" isn\'t saved.')
    tap('putup-walk-exit-save')                                                 // "Save it": landed; its answer did not come back
    await answered(2)
    await failed()
    tap('walk-count-plus')
    save()
    await answered(3)
    expect(errorText()).toBe(STALE + WALK_ON)
    typeWhat('Beans')
    tap('putup-walk-exit')
    expect(screen.getByTestId('putup-walk-unsaved-text').textContent).toBe('"Beans" isn\'t saved.')
    expect(screen.getByTestId('putup-walk-exit-save')).toBeTruthy()
    expect(screen.getByTestId('putup-walk-exit-anyway')).toBeTruthy()
  })

  it('re-review I-E — the walk\'s place changed ("Change") after a lost answer: the jar is where it was first saved, which this walk cannot pick — nothing is written, and the line ends with the way on', async () => {
    const table = jarTable()
    await startWalk()
    corn()
    save(); await failed()
    const before = { ...table.row }
    tap('putup-walk-change')
    fireEvent.click(await screen.findByRole('radio', { name: 'Chest Freezer 2' }))
    fireEvent.click(screen.getByTestId('putup-walk-start'))
    await screen.findByTestId('putup-walk-group')
    expect(screen.getByTestId('walk-what-name').value).toBe('Corn')             // the group came back whole, with its key
    save()
    await answered(2)
    expect(errorText()).toBe(`Already in the Pantry as “Corn” — an earlier Save went through. It can't be moved from here, and where it is now can't be picked here. To change it, open it in the Pantry.${WALK_ON}`)
    expect(otherWrites()).toEqual([])
    expect(table.row).toEqual(before)
    expect(band()).toBeNull()
    expect(new Set(keys()).size).toBe(1)
  })

  // Re-review M-A, in a walk: the place is the walk's, so the line cannot send him to the place row.
  it('re-review M-A — in a walk at a freezer: As is with a typed name, its answer lost; a PLANTING picked for it (no “Fresh, as picked” at a freezer), a method, Save: refused, nothing sent — the line asks for no chip that is not there', async () => {
    const hits = { plantings: [{ plant_id: 'p-blue', label: 'Blueberries', crop_type_slug: 'blueberry', variety_id: 'v-blue', recent_picks: [] }], put_ups: [] }
    fake = pantryFetch({ rows: [], lineSearch: hits, overrides: { [`POST ${ITEMS}`]: () => LOST() } })
    stableFetch.fn = fake
    await startWalk()
    typeWhat('Blue'); tap('walk-method-as_is')
    await screen.findByTestId('walk-what-hit-planting:p-blue', {}, { timeout: 2000 })   // the search has answered; he saves what he typed
    save(); await failed()
    fireEvent.click(await screen.findByTestId('walk-what-hit-planting:p-blue', {}, { timeout: 2000 }))
    await waitFor(() => expect(screen.queryByTestId('walk-method-as_is')).toBeNull())
    method('whole_freeze')
    save()
    await failed(`An earlier Save of this as “Fresh, as picked” may have gone through. It can't also be saved as a put-up from here. Look for it in the Pantry.${WALK_ON}`)
    expect(posts()).toHaveLength(0)
    expect(posts(ITEMS)).toHaveLength(1)
  })

  // Re-review M-B. The Walk's As is route had no case of its own for "the moved stamp is this group's only while
  // the item holds what it sent" or for a removed item: both lines could be put back to the old rule with every
  // test green. A table of one item, as the item route answers it.
  const itemTable = ({ first = {}, onPatch = null } = {}) => {
    const state = { row: null, patches: 0 }
    fake = pantryFetch({ rows: [], overrides: {
      [`POST ${ITEMS}`]: ({ body }) => {
        if (state.row == null) {
          const at = new Date(Date.now() - 30 * 1000).toISOString()
          state.row = {
            id: 'item-first', user_id: 'user_dave', name: body.name, storage_location_id: 'loc-1', place: { ...PLACES[0] },
            acquired_at: body.acquired_at ?? null, acquired_precision: body.acquired_precision ?? null, use_by_target: body.use_by_target ?? null,
            plant_id: null, crop_type_slug: body.crop_type_slug ?? null, quantity_value: null, quantity_unit: null, source_kind: null, source_label: null,
            used_up_at: null, notes: null, created_at: at, updated_at: at, deleted_at: null, ...first,
          }
          LOST()                                                                // landed; its answer did not come back
        }
        return { item: state.row, replayed: true }
      },
      [`PATCH ${ITEMS}/*`]: ({ body }) => {
        state.patches += 1
        const how = onPatch?.(state.patches, body, state)                       // may throw: the PATCH did not land
        state.row = { ...state.row, ...body, updated_at: new Date().toISOString() }
        if (how === 'lost') LOST()
        return { item: state.row }
      },
    } })
    stableFetch.fn = fake
    return state
  }
  const oatMilk = () => { typeWhat('Oat milk'); tap('walk-method-as_is') }
  const itemAnswered = async (nth) => {
    await waitFor(() => expect(posts(ITEMS)).toHaveLength(nth))
    await waitFor(() => expect(screen.getByTestId('walk-save').disabled).toBe(false))
  }
  const ITEM_MAYBE = '“Oat milk” is already in the Pantry — an earlier Save went through. This change may not have saved — try again.'
  it('re-review M-B — the walk, As is: the PATCH never reached the server and the item is renamed by someone else meanwhile: Save again writes NOTHING over their change — the walk says it was saved earlier', async () => {
    const state = itemTable({ onPatch: (n, body, st) => { if (n === 1) { st.row = { ...st.row, name: 'Oat milk (Jen)', updated_at: new Date().toISOString() }; LOST() } } })
    await startWalk()
    oatMilk()
    save(); await failed()
    typeWhat('Oat milk, barista')
    save()
    await waitFor(() => expect(patches()).toHaveLength(1))
    await failed(ITEM_MAYBE)
    save()
    await itemAnswered(3)
    expect(errorText()).toBe(`“Oat milk (Jen)” was already saved earlier — it is in the Pantry. This Save did not change it. To change it, open it in the Pantry.${WALK_ON}`)
    expect(patches()).toHaveLength(1)                                           // no second PATCH
    expect(state.row.name).toBe('Oat milk (Jen)')
    expect(band()).toBeNull()
    expect(new Set(keys(ITEMS)).size).toBe(1)
  })
  it('re-review M-B — … the PATCH LANDED with its answer lost, and someone else then renames it: a further change is NOT written over theirs', async () => {
    const state = itemTable({ onPatch: (n) => (n === 1 ? 'lost' : undefined) })
    await startWalk()
    oatMilk()
    save(); await failed()
    typeWhat('Oat milk, barista')
    save()
    await waitFor(() => expect(patches()).toHaveLength(1))
    await failed('“Oat milk” is already in the Pantry — an earlier Save went through. This change may not have saved — try again.')
    state.row = { ...state.row, name: 'Oat milk (Jen)', updated_at: new Date().toISOString() }
    typeWhat('Oat milk, barista, opened')
    save()
    await itemAnswered(3)
    expect(errorText()).toBe(`“Oat milk (Jen)” was already saved earlier — it is in the Pantry. This Save did not change it. To change it, open it in the Pantry.${WALK_ON}`)
    expect(patches()).toHaveLength(1)
    expect(state.row.name).toBe('Oat milk (Jen)')
  })
  it('re-review M-B — … and its own PATCH, landed with its answer lost, is still its own: a further change goes onto the item', async () => {
    const state = itemTable({ onPatch: (n) => (n === 1 ? 'lost' : undefined) })
    await startWalk()
    oatMilk()
    save(); await failed()
    typeWhat('Oat milk, barista')
    save()
    await waitFor(() => expect(patches()).toHaveLength(1))
    await failed(ITEM_MAYBE)
    typeWhat('Oat milk, barista, opened')
    save(); await landed()
    expect(patches().map(c => c.body.name)).toEqual(['Oat milk, barista', 'Oat milk, barista, opened'])
    expect(state.row.name).toBe('Oat milk, barista, opened')
    expect(band()).toBe('✓ Oat milk, barista, opened · As is')
    expect(new Set(keys(ITEMS)).size).toBe(1)
  })
  it('re-review M-B — the walk, As is: the item was REMOVED since, Save again untouched — the band does not tick a removed item; the walk says it was removed, and the way on', async () => {
    itemTable({ first: { deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() } })
    await startWalk()
    oatMilk()
    save(); await failed()
    save()
    await itemAnswered(2)
    expect(errorText()).toBe(`“Oat milk” was saved earlier and has been removed since. This Save did not change that.${WALK_ON}`)
    expect(band()).toBeNull()
    expect(patches()).toHaveLength(0)
  })

  it('the PATCH landed with its answer lost; a further change, Save: it still goes onto that jar', async () => {
    const table = jarTable({ onPatch: (n) => (n === 1 ? 'lost' : undefined) })
    await startWalk()
    corn()
    save(); await failed()
    typeWhat('Corn, cut')
    save()
    await failed(MAYBE)
    tap('walk-count-plus')
    save(); await landed()
    expect(new Set(keys()).size).toBe(1)
    expect(patches().map(c => [c.body.label, c.body.package_count])).toEqual([['Corn, cut', 1], ['Corn, cut', 2]])
    expect(table.row).toMatchObject({ label: 'Corn, cut', package_count: 2 })
  })
})

// QA M-3. The Start sheet's refusal says "close this and open the batch to see it" — the page it is on must have
// that batch in the list behind it. The wiring is ONE prop on the page (src/pages/PutUp.jsx: onExists={loadGoing}),
// and nothing else pinned it: with the prop gone every other test stayed green.
describe('the Put-Up page behind the Start sheet is told the batch is there (QA M-3)', () => {
  it('a refused Start it re-reads Going now, and the batch an earlier tap made is in the list behind the sheet', async () => {
    const at = new Date(Date.now() - 30 * 1000).toISOString()
    let row = null
    let n = 0
    fake = pantryFetch({ rows: [], overrides: {
      'GET /api/kitchen-batches': ({ path }) => ({ state: 'going', batches: row && path.includes('state=going') ? [row] : [] }),
      'POST /api/kitchen-batches': ({ body }) => {
        if (++n === 1) {
          row = { id: 'kb-first', user_id: 'user_dave', label: body.label, kind: null, kind_other: null, started_at: body.started_at ?? at, start_precision: body.start_precision ?? null,
            recipe_id: null, recipe_ref: null, current_stage_kind: 'started', current_stage_entered_at: at, input_count: 0, output_count: 0, closed_at: null, suspended_at: null,
            idempotency_key: body.idempotency_key, created_at: at, updated_at: at, deleted_at: null }
          LOST()                                                                // it landed; its answer did not come back
        }
        return { ...row, replayed: true }
      },
    } })
    stableFetch.fn = fake
    const goingReads = () => fake.calls('GET').filter(c => c.path === '/api/kitchen-batches?state=going').length
    render(<MemoryRouter initialEntries={['/put-up']}><PutUp /></MemoryRouter>)
    await waitFor(() => expect(goingReads()).toBeGreaterThan(0))
    fireEvent.click(await screen.findByRole('radio', { name: 'Going now' }))
    fireEvent.click(await screen.findByTestId('start-a-batch'))
    typeInto('start-label', 'Pepper mash')
    tap('start-submit')
    await waitFor(() => expect(screen.getByTestId('start-error').textContent).toMatch(/^Couldn't start it/))
    expect(screen.queryByTestId('going-batch')).toBeNull()                     // the list behind does not know of it yet
    tap('start-when-yesterday')
    const before = goingReads()
    tap('start-submit')
    await waitFor(() => expect(screen.getByTestId('start-error').textContent).toBe(START_REPLAY_NOT_ON_IT))
    await waitFor(() => expect(goingReads()).toBeGreaterThan(before))
    await waitFor(() => expect(screen.getByTestId('going-batch-title').textContent).toMatch(/Pepper mash/))
    expect(fake.calls('POST').filter(c => c.path === '/api/kitchen-batches')).toHaveLength(2)
  })
})
