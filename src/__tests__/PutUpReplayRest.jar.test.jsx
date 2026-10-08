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
  replayStaleText, replayUnsavedText,
} from '../components/pantry/putSomethingUp.js'
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
const fixedText = (name, part) => `Already in the Pantry as “${name}” — an earlier Save went through. ${part} Put that back as it was and tap Save to put your other changes on it.`
const WHEN_PART = "The date it was put up can't be changed once it is saved."
const PLACE_PART = "Where it lives can't be changed from here — to move it, open it in the Pantry."
const WHAT_PART = "What it is can't be changed once it is saved."
const SIZE_PART = "Its size and how many can't be changed from here."
const STALE = '“Corn” was already saved earlier — it is in the Pantry. This Save did not change it. To change it, open it in the Pantry.'
const UNSAVED = '“Corn” is already in the Pantry — the first Save went through. This change did not save — try again.'
const MAYBE = '“Corn” is already in the Pantry — the first Save went through. This change may not have saved — try again.'

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
    expect(jarFixedPart({ ...BODY, label: 'Peppers', crop_type_slug: 'pepper' }, { ...JAR, crop_type_slug: 'corn' }, { ...TYPED, name: 'Peppers' })).toBe('what')
    expect(jarFixedPart({ ...BODY, label: 'Salsa' }, { ...JAR, crop_type_slug: 'corn' }, { ...TYPED, name: 'Salsa' })).toBe('what')
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
  it('names the jar as it was saved, says the one part that cannot change, and how to go on — in these words, and no banned one', () => {
    const jar = rawJar(BODY)
    expect(replayJarFixedText(jar, 'when')).toBe(fixedText('Corn', WHEN_PART))
    expect(replayJarFixedText(jar, 'place')).toBe(fixedText('Corn', PLACE_PART))
    expect(replayJarFixedText(jar, 'what')).toBe(fixedText('Corn', WHAT_PART))
    expect(replayJarFixedText(jar, 'size')).toBe(fixedText('Corn', SIZE_PART))
    expect(replayJarFixedText({ ...jar, label: null }, 'when')).toBe(`Already in the Pantry — an earlier Save went through. ${WHEN_PART} Put that back as it was and tap Save to put your other changes on it.`)
    for (const part of ['when', 'place', 'what', 'size']) {
      expect(replayJarFixedText(jar, part)).not.toMatch(BANNED)
      expect(replayJarFixedText(jar, part)).not.toMatch(/your change is not|is not on it|was lost/i)
    }
    // The two the item route already says read a jar's name (its label) the same way.
    expect(replayStaleText(jar)).toBe(STALE)
    expect(replayStaleText({ ...jar, deleted_at: '2026-10-01T18:00:00Z' })).toBe('“Corn” was saved earlier and has been removed since. This Save did not change that.')
    expect(replayUnsavedText(jar)).toBe(UNSAVED)
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
    on.length = 0
    save()
    await answered(door, 2)
    expect(errorText()).toBe(fixedText('Corn', WHEN_PART))
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
    expect(errorText()).toBe(fixedText('Corn', WHEN_PART))                     // refused again
    await waitFor(() => expect(broughtIntoView(on, 'door-error')).toBe(true))
    expect(otherWrites()).toEqual([])
    tap('door-when-today')
    save()
    await waitFor(() => expect(door.onSaved).toHaveBeenCalledTimes(1))
    expect(new Set(keys()).size).toBe(1)
    expect(patches().map(c => [c.path, c.body.notes])).toEqual([[ROW, 'the second tray']])
    expect(told(door).saved).toMatchObject({ id: 'jar-first', notes: 'the second tray', preserved_at: '2026-10-01' })
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
    expect(errorText()).toBe(fixedText('Corn', PLACE_PART))
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
    expect(errorText()).toBe(fixedText('Corn', SIZE_PART))
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

  it('the PATCH fails (a 5xx): the door says the jar IS in the Pantry and this change did not save, tells the page, keeps the form and the key — and Save again finishes it, on the one jar', async () => {
    let fail = true
    const table = jarTable({ onPatch: () => { if (fail) throw apiError(503, { error: 'boom' }) } })
    const door = await openDoor()
    corn()
    save(); await failed()
    tap('door-from'); typeInto('door-notes', 'the second tray')
    save()
    await waitFor(() => expect(patches()).toHaveLength(1))
    await failed(UNSAVED)
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
    await failed('“Corn” is already in the Pantry — the first Save went through. This change did not save: This was changed somewhere else — close and open it again.')
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
    await failed('“Corn” is already in the Pantry — the first Save went through. This change did not save: This was changed somewhere else — close and open it again.')
    save()
    await answered(door, 3)
    expect(errorText()).toBe(STALE)
    expect(patches()).toHaveLength(1)                                          // no second PATCH
    expect(table.row.notes).toBe('Jen: top shelf')
    expect(door.onSaved).not.toHaveBeenCalled()
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

  // Found twice on 2026-10-08 (the spent-key lane's S4): As is, lost; a change; refused "saved earlier"; a
  // method chip, and the put-up route answers a 4xx — which minted a NEW key although item Saves had gone out
  // under the old one; back to As is, Save: a second item.
  it('after a "saved earlier" refusal on As is, a 4xx on the put-up route does NOT mint a new key: back on As is, Save is refused again — one item', async () => {
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
    save(); await failed('no')
    tap('door-method-as_is')
    save()
    await waitFor(() => expect(posts(ITEMS)).toHaveLength(3))
    await failed(ITEM_STALE)
    expect(new Set([...keys(ITEMS), ...keys(JARS)]).size).toBe(1)             // ONE key, on both routes
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
    on.length = 0
    save()
    await answered(2)
    expect(errorText()).toBe(fixedText('Corn', WHEN_PART))
    await waitFor(() => expect(broughtIntoView(on, 'walk-error')).toBe(true))
    expect(otherWrites()).toEqual([])
    expect(table.row).toEqual(before)
    expect(band()).toBeNull()                                                  // nothing is said as saved
    expect(screen.getByTestId('walk-what-name').value).toBe('Corn')
    save()
    await answered(3)
    expect(errorText()).toBe(fixedText('Corn', WHEN_PART))
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
    expect(errorText()).toBe(STALE)
    await waitFor(() => expect(broughtIntoView(on, 'walk-error')).toBe(true))
    expect(otherWrites()).toEqual([])
    expect(table.row).toEqual(before)
    expect(band()).toBeNull()
    save()
    await answered(3)
    expect(errorText()).toBe(STALE)
    expect(new Set(keys()).size).toBe(1)
    expect(screen.getByTestId('walk-what-name').value).toBe('Peas')
  })

  it('the PATCH fails: the walk says the jar IS in the Pantry and this change did not save, reads the place again — and Save again finishes it on the one jar', async () => {
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
    await failed(UNSAVED)
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
    expect(errorText()).toBe('“Corn (Jen)” was already saved earlier — it is in the Pantry. This Save did not change it. To change it, open it in the Pantry.')
    expect(patches()).toHaveLength(1)
    expect(table.row.label).toBe('Corn (Jen)')
    expect(band()).toBeNull()
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
