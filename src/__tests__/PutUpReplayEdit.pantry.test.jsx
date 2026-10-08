// BUG-PUTUPREPLAYDROPSEDIT-001 — the pantry item (POST /api/pantry/items), on its two doors: Put something
// up, and the Walk. The rule and the other creates are in PutUpReplayEdit.test.jsx.
//
// The key stays what it was (plan R2 V2 "Retry key"; PutUpR2Df.door.test.jsx "the retry key" pins the put-up
// route, untouched here). When the ITEM route answers `replayed: true`, another body went out under the key
// before, AND the item is this sitting's (sent from the door that is open, made minutes ago, untouched since),
// the door PATCHes what it holds onto the item the answer names, and completes from the PATCH's answer.
//   • a first-time create → no PATCH;                • the same body replayed → no PATCH, saved;
//   • a changed body replayed → the SAME key, ONE PATCH to that item, carrying the change (judged by the
//     Lambda's own validateItemPatch — the fake's default PATCH runs it), and the changed item handed on;
//   • the PATCH fails → the door says the item is in the Pantry and the change did not save, the form keeps it, the
//     page is told, the key is NOT minted again (even on a 4xx: the item exists), and Save again finishes it;
//   • What became another planting, or stopped being one: no PATCH can carry that, so nothing is written
//     and the door says so — and What put back lets the other changes through;
//   • what went out under the key rides in the draft — so a draft opened again knows its Save may have
//     landed, and NEVER writes what is typed over it onto that item (review B1): it says so, and KEEPS the
//     key — Save again is refused again, and no Save from there is ever a second item (QA Q3);
//   • an item made a while ago, or changed since: nothing is written either;
//   • an item that already holds exactly what is on screen is a save, with nothing written (QA Q3);
//   • every such refusal is brought into view above the pinned Save (QA Q2);
//   • an untouched retry is one body whatever the clock or the name search did meanwhile (review I2).
// CI lane: `npm test` plus the TZ re-run. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react'
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
import PutUpFromPlanting from '../components/planting/PutUpFromPlanting.jsx'
import {
  DOOR_SHEET, ITEM_FIXED_KEYS, itemPatchOf, itemPrint, itemHolds, plantingDiffers, replayFixedText, replayStaleText, replayUnsavedText,
} from '../components/pantry/putSomethingUp.js'
import { sheetDraftKey, readSheetDraft } from '../components/kitchen/sheetDraft.js'
import { validateItemPatch } from '../../lambda/preservation/pantryItems.js'
import { clearReloadBlocks } from '../lib/reloadGate.js'

const NOW = new Date(2026, 9, 1, 14, 0)               // Oct 1 2026, 2 pm, local
const DRAFT_KEY = sheetDraftKey('user_dave', DOOR_SHEET, 'new')
const PLANTING = { source: 'planting', name: 'Megatron jalapeño', plant_id: 'p1', crop_type_slug: 'pepper', variety_id: 'v1' }
const BANNED = /\b(safe|shelf life|shelf-stable|keeps|good|ready|done|expired|table|default|basis)\b/i
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const ITEMS = '/api/pantry/items'
const ROW = `${ITEMS}/item-first`
// A row's two stamps, as the routes answer them. The rule reads them against the real clock, so they are
// made from it: made half a minute ago and untouched (the two are one), unless a test says otherwise.
// The clock is read ONCE, so "untouched" is the same instant twice.
const stamps = (madeAgoMs = 30 * 1000, touchedAgoMs = madeAgoMs) => {
  const now = Date.now()
  return { created_at: new Date(now - madeAgoMs).toISOString(), updated_at: new Date(now - touchedAgoMs).toISOString() }
}
// The item the first POST made, as the route answers a replay with it.
const FIRST = {
  id: 'item-first', user_id: 'user_dave', name: 'Oat milk', storage_location_id: 'loc-3', place: { ...PLACES[2] },
  acquired_at: '2026-10-01', acquired_precision: 'day', use_by_target: null, plant_id: null, crop_type_slug: null,
  quantity_value: null, quantity_unit: null, source_kind: null, source_label: null, used_up_at: null, notes: null,
  ...stamps(), deleted_at: null,
}
// A minute past the bound (idempotencyKey.js REPLAY_FRESH_MS, pinned at ten minutes in PutUpReplayEdit.test.jsx).
const LONG_AGO = 11 * 60 * 1000
const UNSAVED = '“Oat milk” is already in the Pantry — the first Save went through. This change did not save — try again.'
const MAYBE = '“Oat milk” is already in the Pantry — the first Save went through. This change may not have saved — try again.'
const STALE = '“Oat milk” was already saved earlier — it is in the Pantry. This Save did not change it. To change it, open it in the Pantry.'
const LOST = () => { throw new TypeError('Failed to fetch') }       // it may have landed; its answer did not come back

const tap = (id) => fireEvent.click(screen.getByTestId(id))
const typeInto = (id, v) => fireEvent.change(screen.getByTestId(id), { target: { value: v } })
const posts = (path = ITEMS) => fake.calls('POST').filter(c => c.path === path)
const keys = () => posts().map(c => c.body.idempotency_key)
const patches = () => fake.calls('PATCH')
// Every write that is not the item POST (the place read is a GET): [method, path].
const otherWrites = () => fake.calls().filter(c => c.method !== 'GET' && !(c.method === 'POST' && c.path === ITEMS)).map(c => [c.method, c.path])

// The first item POST lands with its answer lost; every later one is answered with the item it made.
function lostThenReplayed(overrides = {}, first = FIRST) {
  let n = 0
  fake = pantryFetch({ rows: [], overrides: {
    [`POST ${ITEMS}`]: () => { if (++n === 1) LOST(); return { item: first, replayed: true } },
    ...overrides,
  } })
  stableFetch.fn = fake
}

beforeEach(() => {
  fake = pantryFetch({ rows: [] }); stableFetch.fn = fake
  localStorage.clear(); sessionStorage.clear(); clearReloadBlocks()
})
// jsdom has no scrollIntoView. A stand-in that records what it was called on, for the tests that ask whether
// a line was brought into view; taken away again after each.
function watchScrolls() {
  const on = []
  Element.prototype.scrollIntoView = function scrollIntoView() { on.push(this) }
  return on
}
afterEach(() => { delete Element.prototype.scrollIntoView; vi.restoreAllMocks() })
// Whether the line with this test id (or the block that holds it) was brought into view.
const broughtIntoView = (on, id) => on.some(el => el === screen.getByTestId(id) || el.contains(screen.getByTestId(id)))

describe('the item as its PATCH — putSomethingUp.js itemPatchOf', () => {
  const BODY = { idempotency_key: 'k', name: 'Oat milk', place: { kind: 'fridge', label: 'Fridge' }, acquired_at: '2026-10-01', acquired_precision: 'day' }

  it('every key the PATCH takes, an absent one as null, the place by id, no key of the create\'s own — and the Lambda takes it', () => {
    const patch = itemPatchOf(BODY, 'loc-9', FIRST)
    expect(patch).toEqual({
      name: 'Oat milk', storage_location_id: 'loc-9', acquired_at: '2026-10-01', acquired_precision: 'day', use_by_target: null,
      notes: null, quantity_value: null, quantity_unit: null, source_kind: null, source_label: null,
    })
    expect(validateItemPatch({ ...patch, storage_location_id: '99999999-aaaa-4bbb-8ccc-000000000002' })).toBeNull()
    const full = itemPatchOf({ ...BODY, acquired_at: undefined, acquired_precision: 'unknown', use_by_target: '2026-11-01', notes: 'big bag',
      quantity_value: 2.5, quantity_unit: 'lb', source_kind: 'store', source_label: 'Costco' }, 'loc-9', FIRST)
    expect(full).toMatchObject({ acquired_at: null, acquired_precision: 'unknown', use_by_target: '2026-11-01', notes: 'big bag',
      quantity_value: 2.5, quantity_unit: 'lb', source_kind: 'store', source_label: 'Costco' })
    expect(validateItemPatch({ ...full, storage_location_id: '99999999-aaaa-4bbb-8ccc-000000000002' })).toBeNull()
  })

  it('the crop goes only when it is not the item\'s already, null for none — and never for a planting', () => {
    expect(itemPatchOf({ ...BODY, crop_type_slug: 'tomato' }, 'loc-9', FIRST).crop_type_slug).toBe('tomato')
    expect(itemPatchOf(BODY, 'loc-9', { ...FIRST, crop_type_slug: 'tomato' }).crop_type_slug).toBeNull()
    expect(itemPatchOf({ ...BODY, crop_type_slug: 'tomato' }, 'loc-9', { ...FIRST, crop_type_slug: 'tomato' })).not.toHaveProperty('crop_type_slug')
    expect(itemPatchOf(BODY, 'loc-9', FIRST)).not.toHaveProperty('crop_type_slug')
    expect(itemPatchOf({ ...BODY, plant_id: 'p1', crop_type_slug: 'pepper' }, 'loc-9', { ...FIRST, plant_id: 'p1', crop_type_slug: null })).not.toHaveProperty('crop_type_slug')
    expect(validateItemPatch({ crop_type_slug: 'tomato' })).toBeNull()
    expect(validateItemPatch({ crop_type_slug: null })).toBeNull()
  })

  it('the planting is the one key no PATCH carries; whether it differs is read off the ROW; the sentence names the item, promises only what happens, and holds no banned word', () => {
    expect([...ITEM_FIXED_KEYS]).toEqual(['plant_id'])
    expect(validateItemPatch({ plant_id: '99999999-aaaa-4bbb-8ccc-000000000003' })).toMatch(/cannot be changed here: plant_id/)
    expect([plantingDiffers({}, FIRST), plantingDiffers({ plant_id: null }, FIRST), plantingDiffers({ plant_id: 'p1' }, FIRST)]).toEqual([false, false, true])
    expect([plantingDiffers({ plant_id: 'p1' }, { plant_id: 'p1' }), plantingDiffers({}, { plant_id: 'p1' }), plantingDiffers({ plant_id: 'p2' }, { plant_id: 'p1' })]).toEqual([false, true, true])
    expect(replayFixedText(FIRST)).toBe('Already in the Pantry as “Oat milk” — the first Save went through. Which planting it came from can\'t be changed once it is saved. Put “What is it?” back as it was and tap Save to put your other changes on it.')
    expect(replayFixedText(null)).toMatch(/^Already in the Pantry — the first Save went through\./)
    // The key is kept after a refusal, so no Save from the door adds it again: the sentence may not say one does.
    expect(replayFixedText(FIRST)).not.toMatch(/add it again|Save again/)
    // No route changes an item's planting, so the sentence may not send him to the Pantry to "fix" it.
    expect(replayFixedText(FIRST)).not.toMatch(/fix it in the Pantry/)
    expect(replayFixedText(FIRST)).not.toMatch(BANNED)
  })

  it('the two other sentences: saved earlier and not written onto (a removed one says so) — never "your change is not on it", which is not known; in the Pantry and the change did not save (the server\'s reason when it gave one; "may not have" when no answer came)', () => {
    expect(replayStaleText(FIRST)).toBe(STALE)
    expect(replayStaleText({ ...FIRST, deleted_at: '2026-10-01T15:00:00.000Z' })).toBe('“Oat milk” was saved earlier and has been removed since. This Save did not change that.')
    expect(replayStaleText(null)).toMatch(/^This was already saved earlier — it is in the Pantry\. This Save did not change it\./)
    expect(replayUnsavedText(FIRST)).toBe(UNSAVED)
    expect(replayUnsavedText(FIRST, { lost: true })).toBe(MAYBE)
    expect(replayUnsavedText(FIRST, { why: 'That crop is not one this app knows.', lost: true })).toBe('“Oat milk” is already in the Pantry — the first Save went through. This change did not save: That crop is not one this app knows.')
    expect(replayUnsavedText(null)).toMatch(/^This is already in the Pantry — the first Save went through\./)
    for (const text of [replayStaleText(FIRST), replayStaleText({ ...FIRST, deleted_at: 'x' }), replayUnsavedText(FIRST), MAYBE, replayUnsavedText(FIRST, { why: 'no' })]) {
      expect(text).not.toMatch(BANNED)
      expect(text).not.toMatch(/Couldn't save it/)
      expect(text).not.toMatch(/not (put )?on it/)
    }
    // QA Q3: a refusal keeps the key, so Save again is refused again — no sentence may promise that it adds.
    for (const text of [replayStaleText(FIRST), replayStaleText({ ...FIRST, deleted_at: 'x' }), replayStaleText(null)]) {
      expect(text).not.toMatch(/Save again|to add/i)
    }
  })

  it('Q3 — itemHolds: the item already holds what this body would put on it — every key he chose is read against the row, the date as it resolved; a typed name\'s crop and a planting\'s crop are not; a removed item holds nothing', () => {
    const TYPED = { source: 'typed', name: 'Oat milk' }
    const BODY2 = { idempotency_key: 'k', name: 'Oat milk', storage_location_id: 'loc-3', acquired_at: '2026-10-01', acquired_precision: 'day' }
    expect(itemHolds(BODY2, FIRST, TYPED)).toBe(true)
    expect(itemHolds({ ...BODY2, name: ' Oat milk ' }, FIRST, TYPED)).toBe(true)
    for (const change of [{ name: 'Oat milk, barista' }, { storage_location_id: 'loc-1' }, { acquired_at: '2026-10-02' }, { acquired_precision: 'month' },
      { use_by_target: '2026-11-01' }, { notes: 'x' }, { quantity_value: 2, quantity_unit: 'bag' }, { source_kind: 'store' }, { source_kind: 'store', source_label: 'Costco' },
      { plant_id: 'p1' }]) {
      expect(itemHolds({ ...BODY2, ...change }, FIRST, TYPED), JSON.stringify(change)).toBe(false)
      // … and the other way: the row has it and the body does not.
      expect(itemHolds(BODY2, { ...FIRST, ...change }, TYPED), `row ${JSON.stringify(change)}`).toBe(false)
    }
    const full = { use_by_target: '2026-11-01', notes: 'big bag', quantity_value: 2.5, quantity_unit: 'lb', source_kind: 'store', source_label: 'Costco' }
    expect(itemHolds({ ...BODY2, ...full }, { ...FIRST, ...full, quantity_value: '2.500' }, TYPED)).toBe(true)
    // "Not sure": no date on either side.
    expect(itemHolds({ ...BODY2, acquired_at: undefined, acquired_precision: 'unknown' }, { ...FIRST, acquired_at: null, acquired_precision: 'unknown' }, TYPED)).toBe(true)
    // A place with no id yet is the same place by kind and name, whatever its case.
    const typedPlace = { ...BODY2, storage_location_id: undefined, place: { kind: 'fridge', label: 'garage fridge' } }
    expect(itemHolds(typedPlace, { ...FIRST, place: { id: 'loc-9', kind: 'fridge', label: 'Garage fridge' } }, TYPED)).toBe(true)
    expect(itemHolds(typedPlace, { ...FIRST, place: { id: 'loc-9', kind: 'pantry', label: 'Garage fridge' } }, TYPED)).toBe(false)
    expect(itemHolds(typedPlace, { ...FIRST, place: null }, TYPED)).toBe(false)
    // The crop: a typed name's is the search's (not compared); a PICKED one is his; a planting's is the planting's.
    expect(itemHolds({ ...BODY2, crop_type_slug: 'oat' }, FIRST, { ...TYPED, crop_type_slug: 'oat' })).toBe(true)
    expect(itemHolds({ ...BODY2, crop_type_slug: 'oat' }, FIRST, { source: 'crop', name: 'Oat milk', crop_type_slug: 'oat' })).toBe(false)
    expect(itemHolds({ ...BODY2, crop_type_slug: 'oat' }, { ...FIRST, crop_type_slug: 'oat' }, { source: 'crop', name: 'Oat milk', crop_type_slug: 'oat' })).toBe(true)
    expect(itemHolds({ ...BODY2, plant_id: 'p1' }, { ...FIRST, plant_id: 'p1', crop_type_slug: 'pepper' }, { source: 'planting', name: 'Oat milk', plant_id: 'p1' })).toBe(true)
    expect(itemHolds(BODY2, { ...FIRST, deleted_at: '2026-10-01T15:00:00.000Z' }, TYPED)).toBe(false)
    expect([itemHolds(BODY2, null, TYPED), itemHolds(null, FIRST, TYPED)]).toEqual([false, false])
  })
})

describe('the print of an item Save — putSomethingUp.js itemPrint (review I2: what he chose, not what the clock or the search made of it)', () => {
  const TYPED = { source: 'typed', name: 'Tomatoes' }
  const BODY = { idempotency_key: 'k', name: 'Tomatoes', storage_location_id: 'loc-3', acquired_at: '2026-10-01', acquired_precision: 'day' }
  const TODAY = ['today']

  it('the date the chip came to is not in it: Today sent on two different days is one print — and another chip, or another picked day, is another', () => {
    const p = itemPrint(BODY, TYPED, TODAY)
    expect(itemPrint({ ...BODY, acquired_at: '2026-10-02' }, TYPED, TODAY)).toBe(p)
    expect(itemPrint({ ...BODY, acquired_at: '2026-09-01', acquired_precision: 'month' }, TYPED, TODAY)).toBe(p)
    expect(itemPrint(BODY, TYPED, ['yesterday'])).not.toBe(p)
    expect(itemPrint(BODY, TYPED, ['pickdate', '2026-10-01'])).not.toBe(itemPrint(BODY, TYPED, ['pickdate', '2026-09-30']))
    expect(itemPrint(BODY, TYPED, ['earlier', 'this_month'])).not.toBe(itemPrint(BODY, TYPED, ['earlier', 'last_month']))
  })

  it('a TYPED name\'s crop is the search\'s, and is not in it; a crop he PICKED is', () => {
    const p = itemPrint(BODY, TYPED, TODAY)
    expect(itemPrint({ ...BODY, crop_type_slug: 'tomato' }, { ...TYPED, crop_type_slug: 'tomato' }, TODAY)).toBe(p)
    expect(itemPrint({ ...BODY, crop_type_slug: 'tomato' }, { name: 'Tomatoes', crop_type_slug: 'tomato' }, TODAY)).toBe(p)   // a What with no source is a typed one
    const picked = itemPrint({ ...BODY, crop_type_slug: 'tomato' }, { source: 'crop', name: 'Tomatoes', crop_type_slug: 'tomato' }, TODAY)
    expect(picked).not.toBe(p)
    expect(itemPrint({ ...BODY, crop_type_slug: 'pepper' }, { source: 'crop', name: 'Tomatoes', crop_type_slug: 'pepper' }, TODAY)).not.toBe(picked)
  })

  it('everything else he can change is in it: the name, the place, the notes, the amount, the source, the discard date — and the planting', () => {
    const p = itemPrint(BODY, TYPED, TODAY)
    for (const change of [{ name: 'Tomatoes, cherry' }, { storage_location_id: 'loc-1' }, { notes: 'x' }, { quantity_value: 2, quantity_unit: 'lb' },
      { source_kind: 'store' }, { use_by_target: '2026-11-01' }, { plant_id: 'p1' }]) {
      expect(itemPrint({ ...BODY, ...change }, TYPED, TODAY), JSON.stringify(change)).not.toBe(p)
    }
    expect(itemPrint({ ...BODY, idempotency_key: 'other' }, TYPED, TODAY)).toBe(p)
  })
})

describe('Put something up — the item route', () => {
  async function openDoor(props = {}) {
    const handlers = { onClose: vi.fn(), onSaved: vi.fn(), onExists: vi.fn(), ...props }
    const view = render(<PutSomethingUpSheet open now={NOW.getTime()} {...handlers} />)
    await screen.findByTestId('door-place-id:loc-1')
    return { ...view, ...handlers }
  }
  const asIs = (name = 'Oat milk') => { typeInto('door-what-name', name); tap('door-place-id:loc-3'); tap('door-method-as_is') }
  const save = () => tap('door-save')
  const errorText = () => screen.queryByTestId('door-error')?.textContent ?? null
  const failed = (text = "Couldn't save it — nothing was lost. Try again.") => waitFor(() => expect(errorText()).toBe(text))
  // The nth item POST has been answered, one way or the other: the door says something, or hands the save on.
  const answered = async (h, nth) => {
    await waitFor(() => expect(posts()).toHaveLength(nth))
    await waitFor(() => expect(errorText() != null || h.onSaved.mock.calls.length > 0).toBe(true))
  }
  const draft = () => readSheetDraft(DRAFT_KEY, DOOR_SHEET, isDoorDraft)

  it('a first-time create: one POST, no PATCH', async () => {
    const { onSaved } = await openDoor()
    asIs()
    save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(posts()).toHaveLength(1)
    expect(otherWrites()).toEqual([])
    expect(onSaved.mock.calls[0][0]).toMatchObject({ route: 'item', saved: { name: 'Oat milk' } })
  })

  it('a lost answer, Save again untouched, answered replayed: the same key, no PATCH, the completion from the server\'s item', async () => {
    lostThenReplayed()
    const { onSaved } = await openDoor()
    asIs()
    save(); await failed()
    save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(keys()).toHaveLength(2)
    expect(keys()[0]).toMatch(UUID)
    expect(keys()[1]).toBe(keys()[0])
    expect(otherWrites()).toEqual([])
    expect(onSaved.mock.calls[0][0].saved).toEqual(FIRST)
  })

  it('a lost answer, the notes and the amount changed, Save: the same key, ONE PATCH to the replayed item with the change, and the changed item handed on', async () => {
    lostThenReplayed()
    const { onSaved } = await openDoor()
    asIs()
    save(); await failed()
    tap('door-from'); typeInto('door-notes', 'the second carton')
    tap('door-amount-open'); typeInto('door-amount-value', '2'); tap('door-amount-unit-bag')
    save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(keys()).toHaveLength(2)
    expect(keys()[1]).toBe(keys()[0])                                          // never a second create under a new key
    expect(otherWrites()).toEqual([['PATCH', ROW]])
    expect(patches()[0].body).toEqual({
      name: 'Oat milk', storage_location_id: 'loc-3', acquired_at: '2026-10-01', acquired_precision: 'day', use_by_target: null,
      notes: 'the second carton', quantity_value: 2, quantity_unit: 'bag', source_kind: null, source_label: null,
    })
    expect(onSaved.mock.calls[0][0]).toMatchObject({ route: 'item', saved: { id: 'item-first', notes: 'the second carton', quantity_value: 2, quantity_unit: 'bag' } })
    expect(draft()).toBeNull()
  })

  it('the name and the place changed: the PATCH moves it and renames it', async () => {
    lostThenReplayed()
    const { onSaved } = await openDoor()
    asIs()
    save(); await failed()
    typeInto('door-what-name', 'Oat milk, barista'); tap('door-place-id:loc-1')
    if (screen.getByTestId('door-method-as_is').getAttribute('aria-checked') !== 'true') tap('door-method-as_is')
    save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(keys()[1]).toBe(keys()[0])
    expect(patches().map(c => [c.path, c.body.name, c.body.storage_location_id])).toEqual([[ROW, 'Oat milk, barista', 'loc-1']])
    expect(onSaved.mock.calls[0][0]).toMatchObject({ saved: { name: 'Oat milk, barista' }, place: { id: 'loc-1' } })
  })

  it('I3 — the PATCH fails with no answer or a 5xx: the door says the item IS in the Pantry and this change did not save (never "Couldn\'t save it"), the page is told, the change is still in the form and the draft, nothing is handed on as saved — and Save again finishes it under the same key', async () => {
    let fail = true
    lostThenReplayed({ [`PATCH ${ITEMS}/*`]: ({ path, body }) => { if (fail) throw apiError(503, { error: 'boom' }); return { item: { id: path.split('/').pop(), ...body } } } })
    const { onSaved, onExists } = await openDoor()
    asIs()
    save(); await failed()
    expect(onExists).not.toHaveBeenCalled()                                    // a lost answer: nothing is known yet
    tap('door-from'); typeInto('door-notes', 'the second carton')
    save()
    await waitFor(() => expect(patches()).toHaveLength(1))
    await failed(UNSAVED)
    expect(onExists).toHaveBeenCalledTimes(1)                                  // the list behind re-reads: the item is there
    expect(onSaved).not.toHaveBeenCalled()
    expect(screen.getByTestId('door-notes').value).toBe('the second carton')
    expect(draft()).toMatchObject({ notes: 'the second carton', key: keys()[0] })
    fail = false
    save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(new Set(keys()).size).toBe(1)
    expect(keys()).toHaveLength(3)
    expect(patches().map(c => c.body.notes)).toEqual(['the second carton', 'the second carton'])
    expect(onSaved.mock.calls[0][0].saved).toMatchObject({ id: 'item-first', notes: 'the second carton' })
  })

  // The first item POST's answer is lost; the PATCH LANDS (the row holds it, its updated_at moves) and its
  // first answer is lost too. `state.row` is what the Pantry holds.
  function patchLandsAnswerLost() {
    const state = { row: FIRST }
    let n = 0
    let patchesSeen = 0
    fake = pantryFetch({ rows: [], overrides: {
      [`POST ${ITEMS}`]: () => { if (++n === 1) LOST(); return { item: state.row, replayed: true } },
      [`PATCH ${ITEMS}/*`]: ({ body }) => {
        state.row = { ...state.row, ...body, updated_at: new Date().toISOString() }   // it lands …
        if (++patchesSeen === 1) LOST()                                                // … and its answer does not come back
        return { item: state.row }
      },
    } })
    stableFetch.fn = fake
    return state
  }

  it('I3 / Q3 — the PATCH LANDED and only its answer was lost: the door says the change MAY not have saved; Save again finds the item already holding what is on screen and is a save — NO second PATCH, the same key', async () => {
    const state = patchLandsAnswerLost()
    const door = await openDoor()
    asIs()
    save(); await failed()
    tap('door-from'); typeInto('door-notes', 'the second carton')
    save()
    await waitFor(() => expect(patches()).toHaveLength(1))
    await failed(MAYBE)
    expect(door.onSaved).not.toHaveBeenCalled()
    expect(state.row.updated_at).not.toBe(state.row.created_at)
    save()
    await answered(door, 3)
    expect(errorText()).toBeNull()
    expect(door.onSaved).toHaveBeenCalledTimes(1)
    expect(new Set(keys()).size).toBe(1)
    expect(patches().map(c => [c.path, c.body.notes])).toEqual([[ROW, 'the second carton']])
    expect(door.onSaved.mock.calls[0][0].saved).toMatchObject({ id: 'item-first', notes: 'the second carton' })
    expect(draft()).toBeNull()
  })

  it('I3 — … and a FURTHER change made before that Save: the item\'s updated_at has moved, but by this door\'s own PATCH — so the second PATCH still goes onto it', async () => {
    patchLandsAnswerLost()
    const door = await openDoor()
    asIs()
    save(); await failed()
    tap('door-from'); typeInto('door-notes', 'the second carton')
    save()
    await failed(MAYBE)
    typeInto('door-notes', 'the second carton, opened')
    save()
    await answered(door, 3)
    expect(errorText()).toBeNull()
    expect(door.onSaved).toHaveBeenCalledTimes(1)
    expect(new Set(keys()).size).toBe(1)
    expect(patches().map(c => [c.path, c.body.notes])).toEqual([[ROW, 'the second carton'], [ROW, 'the second carton, opened']])
  })

  it('I3 — the PATCH is refused with a 4xx: its sentence is shown after "already in the Pantry" — and the key is NOT minted again (the item exists; a new key would make a second one)', async () => {
    lostThenReplayed({ [`PATCH ${ITEMS}/*`]: () => { throw apiError(400, { error: 'That crop is not one this app knows.' }) } })
    const { onSaved, onExists } = await openDoor()
    asIs()
    save(); await failed()
    tap('door-from'); typeInto('door-notes', 'the second carton')
    save()
    await failed('“Oat milk” is already in the Pantry — the first Save went through. This change did not save: That crop is not one this app knows.')
    expect(onExists).toHaveBeenCalledTimes(1)
    expect(onSaved).not.toHaveBeenCalled()
    save()
    await waitFor(() => expect(posts()).toHaveLength(3))
    expect(new Set(keys()).size).toBe(1)
    expect(draft().key).toBe(keys()[0])
  })

  it('an answered 4xx on the CREATE still mints a new key, and what went out under the old one goes with it', async () => {
    let n = 0
    fake = pantryFetch({ rows: [], overrides: { [`POST ${ITEMS}`]: () => { if (++n === 1) throw apiError(400, { error: 'no' }); return { item: FIRST, replayed: true } } } })
    stableFetch.fn = fake
    const { onSaved } = await openDoor()
    asIs()
    save(); await failed('no')
    tap('door-from'); typeInto('door-notes', 'the second carton')
    save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(keys()[1]).not.toBe(keys()[0])
    expect(otherWrites()).toEqual([])                                         // one body under the new key: nothing to put on the row
  })

  // QA Q3 (the 4xx half). The route validates a body BEFORE it looks the key up, so a refusal of a changed
  // body says nothing about the one that went out first: that one may be in the Pantry.
  it('Q3 — a lost answer, then a CHANGED body the server refuses with a 4xx: the key is KEPT (the first Save may have landed) — and the Save after goes onto that item, never a second one', async () => {
    let n = 0
    fake = pantryFetch({ rows: [], overrides: { [`POST ${ITEMS}`]: () => {
      n += 1
      if (n === 1) LOST()
      if (n === 2) throw apiError(400, { error: 'no' })
      return { item: FIRST, replayed: true }
    } } })
    stableFetch.fn = fake
    const door = await openDoor()
    asIs()
    save(); await failed()
    tap('door-from'); typeInto('door-notes', 'the second carton')
    save(); await failed('no')
    expect(draft()).toMatchObject({ key: keys()[0] })
    save()
    await answered(door, 3)
    expect(new Set(keys()).size).toBe(1)
    expect(door.onSaved).toHaveBeenCalledTimes(1)
    expect(patches().map(c => [c.path, c.body.notes])).toEqual([[ROW, 'the second carton']])
  })

  // REVIEW B1. The draft is in storage with its key and what went out under it. Opened again — minutes or
  // days later — what is typed over it may be another thing altogether, and the PATCH sends every field.
  // QA Q3: the refusal KEEPS the key. Save again is the same refusal, and no create ever goes out under a new key.
  it('B1 / Q3 — dismissed, opened again, a DIFFERENT thing typed over the restored draft, Save: NOTHING is written onto the item the first Save made (however new it is); the door says so, tells the page, keeps the form AND the key — Save again is refused again: no second item, no create under a new key', async () => {
    let n = 0
    fake = pantryFetch({ rows: [], overrides: { [`POST ${ITEMS}`]: () => {
      n += 1
      if (n === 1) LOST()
      return { item: FIRST, replayed: true }
    } } })
    stableFetch.fn = fake
    const first = await openDoor()
    asIs()
    save(); await failed()
    await waitFor(() => expect(draft()?.sent).toHaveLength(1))
    first.unmount()
    const second = await openDoor()
    expect(screen.getByTestId('door-what-name').value).toBe('Oat milk')
    typeInto('door-what-name', 'Eggs'); tap('door-place-id:loc-1')
    if (screen.getByTestId('door-method-as_is').getAttribute('aria-checked') !== 'true') tap('door-method-as_is')
    save()
    await answered(second, 2)
    expect(otherWrites()).toEqual([])                                          // the item "Oat milk" is as the first Save made it
    expect(errorText()).toBe(STALE)
    expect(keys()[1]).toBe(keys()[0])
    expect(second.onSaved).not.toHaveBeenCalled()
    expect(second.onExists).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('door-what-name').value).toBe('Eggs')
    expect(screen.getByTestId('door-save').disabled).toBe(false)
    // The key that names "Oat milk" is KEPT, with what went out under it: the draft still holds both.
    await waitFor(() => expect(draft()).toMatchObject({ key: keys()[0], what: { name: 'Eggs' } }))
    expect(draft().sent).toHaveLength(2)
    save()
    await waitFor(() => expect(posts()).toHaveLength(3))
    await waitFor(() => expect(screen.getByTestId('door-save').disabled).toBe(false))
    expect(errorText()).toBe(STALE)                                            // refused again
    save()
    await waitFor(() => expect(posts()).toHaveLength(4))
    await waitFor(() => expect(screen.getByTestId('door-save').disabled).toBe(false))
    expect(errorText()).toBe(STALE)
    expect(new Set(keys()).size).toBe(1)                                       // ZERO creates under a new key
    expect(otherWrites()).toEqual([])
    expect(second.onSaved).not.toHaveBeenCalled()
    expect(draft()).toMatchObject({ key: keys()[0], what: { name: 'Eggs' } })
  })

  // QA Q3 (D4). The first body never reached the server; the changed one landed with its answer lost; the door
  // was dismissed and opened again. The item holds EXACTLY what is on screen: there is nothing to refuse.
  it('Q3 — a restored draft whose item already holds exactly what is on screen: a SAVE, as any other — no PATCH, no refusal, the same key, the draft cleared (it used to be refused, and the Save after that made a second, identical item)', async () => {
    let n = 0
    let row = null
    fake = pantryFetch({ rows: [], overrides: { [`POST ${ITEMS}`]: ({ body }) => {
      n += 1
      if (n === 1) LOST()                                                      // never reached the server
      if (n === 2) { row = { ...FIRST, notes: body.notes }; LOST() }           // landed; its answer did not come back
      return { item: row, replayed: true }
    } } })
    stableFetch.fn = fake
    const first = await openDoor()
    asIs()
    save(); await failed()
    tap('door-from'); typeInto('door-notes', 'the second carton')
    save()
    await waitFor(() => expect(posts()).toHaveLength(2))
    await failed()
    await waitFor(() => expect(draft()?.sent).toHaveLength(2))
    first.unmount()
    const second = await openDoor()
    expect(screen.getByTestId('door-what-name').value).toBe('Oat milk')
    save()
    await answered(second, 3)
    expect(errorText()).toBeNull()
    expect(second.onSaved).toHaveBeenCalledTimes(1)
    expect(second.onSaved.mock.calls[0][0]).toMatchObject({ route: 'item', saved: { id: 'item-first', notes: 'the second carton' } })
    expect(second.onExists).not.toHaveBeenCalled()
    expect(otherWrites()).toEqual([])
    expect(new Set(keys()).size).toBe(1)
    expect(draft()).toBeNull()
  })

  it('Q3 — … but one field off (the notes on screen are not the item\'s): still refused, nothing written', async () => {
    let n = 0
    fake = pantryFetch({ rows: [], overrides: { [`POST ${ITEMS}`]: () => { if (++n < 3) LOST(); return { item: { ...FIRST, notes: 'the first carton' }, replayed: true } } } })
    stableFetch.fn = fake
    const first = await openDoor()
    asIs()
    save(); await failed()
    tap('door-from'); typeInto('door-notes', 'the second carton')
    save()
    await waitFor(() => expect(posts()).toHaveLength(2))
    await waitFor(() => expect(draft()?.sent).toHaveLength(2))
    first.unmount()
    const second = await openDoor()
    save()
    await answered(second, 3)
    expect(errorText()).toBe(STALE)
    expect(otherWrites()).toEqual([])
    expect(second.onSaved).not.toHaveBeenCalled()
  })

  // QA Q2. The refusal is the LAST line of the scroller and Save is pinned over the scroller's end.
  it('Q2 — a refusal is an alert that is brought into view, and scrolled clear of the pinned Save: saved earlier (stale), the planting (fixed), the change did not save', async () => {
    const on = watchScrolls()
    // The line sits 90 px under the top of the pinned footer: the panel has to scroll by that and the gap.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function rect() {
      const box = (top, bottom) => ({ top, bottom, left: 0, right: 400, width: 400, height: bottom - top, x: 0, y: top })
      if (this.getAttribute?.('data-testid') === 'door-footer') return box(700, 780)
      if ([...(this.children ?? [])].some(c => c.getAttribute('data-testid') === 'door-error')) return box(730, 790)
      return box(0, 0)
    })
    lostThenReplayed({ [`PATCH ${ITEMS}/*`]: () => { throw apiError(503, { error: 'boom' }) } }, { ...FIRST, ...stamps(LONG_AGO) })
    const door = await openDoor()
    const panel = screen.getByTestId('door-sheet').closest('[role=dialog]')
    let top = 0
    Object.defineProperty(panel, 'scrollTop', { configurable: true, get: () => top, set: (v) => { top = v } })
    asIs()
    save(); await failed()
    // BUG-PUTUPSAVEFAILHIDDEN-001: the ordinary failure is the same last line under the same pinned Save.
    await waitFor(() => expect(broughtIntoView(on, 'door-error')).toBe(true))
    expect(top).toBe(98)
    on.length = 0; top = 0
    tap('door-from'); typeInto('door-notes', 'the second carton')
    save()
    await answered(door, 2)
    expect(errorText()).toBe(STALE)
    expect(screen.getByTestId('door-error').getAttribute('role')).toBe('alert')
    await waitFor(() => expect(broughtIntoView(on, 'door-error')).toBe(true))
    expect(top).toBe(98)                                                       // 790 + the 8 px gap − 700
    // Refused again: brought into view again.
    on.length = 0
    save()
    await waitFor(() => expect(posts()).toHaveLength(3))
    await waitFor(() => expect(broughtIntoView(on, 'door-error')).toBe(true))
  })

  // BUG-PUTUPSAVEFAILHIDDEN-001, measured in Chrome at 426x836: the failure line sat at y771-786 under the
  // pinned Save (top y755), and nothing on screen changed after the tap.
  it('a Save that fails the ordinary way is brought into view, and so is the same failure again; the line keeps 8 px under it at the scroller\'s end', async () => {
    const on = watchScrolls()
    fake = pantryFetch({ rows: [], overrides: { [`POST ${ITEMS}`]: LOST } }); stableFetch.fn = fake
    await openDoor()
    asIs()
    save(); await failed()
    await waitFor(() => expect(broughtIntoView(on, 'door-error')).toBe(true))
    expect(screen.getByTestId('door-error').parentElement.style.marginBottom).toBe('8px')
    on.length = 0
    save()
    await waitFor(() => expect(posts()).toHaveLength(2))
    await failed()
    await waitFor(() => expect(broughtIntoView(on, 'door-error')).toBe(true))
  })

  it('Q2 — the planting refusal and a change that did not save are brought into view too', async () => {
    const on = watchScrolls()
    const PLANTED = { ...FIRST, name: 'Megatron jalapeño', plant_id: 'p1', crop_type_slug: 'pepper' }
    lostThenReplayed({}, PLANTED)
    await openDoor({ initialWhat: PLANTING })
    tap('door-place-id:loc-3'); tap('door-method-as_is')
    save(); await failed()
    tap('door-what-change'); typeInto('door-what-name', 'Jalapeños from the store')
    if (screen.getByTestId('door-method-as_is').getAttribute('aria-checked') !== 'true') tap('door-method-as_is')
    on.length = 0
    save()
    await failed(replayFixedText(PLANTED))
    await waitFor(() => expect(broughtIntoView(on, 'door-error')).toBe(true))
    cleanup()
    localStorage.clear(); clearReloadBlocks()
    lostThenReplayed({ [`PATCH ${ITEMS}/*`]: () => { throw apiError(503, { error: 'boom' }) } })
    await openDoor()
    asIs()
    save(); await failed()
    tap('door-from'); typeInto('door-notes', 'the second carton')
    on.length = 0
    save()
    await failed(UNSAVED)
    await waitFor(() => expect(broughtIntoView(on, 'door-error')).toBe(true))
  })

  it('what went out rides in the draft as a print of what was CHOSEN (itemPrint), from the first item Save on', async () => {
    lostThenReplayed()
    await openDoor()
    asIs()
    save(); await failed()
    await waitFor(() => expect(draft()?.sent).toHaveLength(1))
    expect(draft().sent).toEqual([itemPrint(posts()[0].body, { source: 'typed', name: 'Oat milk' }, ['today'])])
  })

  it('B1 — the same door, but the item was changed since the first Save made it (updated_at has moved): NOTHING is written over that change; the door says so and KEEPS the key', async () => {
    lostThenReplayed({}, { ...FIRST, name: 'Oat milk, barista', ...stamps(60 * 1000, 20 * 1000) })
    const door = await openDoor()
    const { onSaved, onExists } = door
    asIs()
    save(); await failed()
    tap('door-from'); typeInto('door-notes', 'the second carton')
    save()
    await answered(door, 2)
    expect(otherWrites()).toEqual([])
    expect(errorText()).toBe(STALE.replace('“Oat milk”', '“Oat milk, barista”'))
    expect(onSaved).not.toHaveBeenCalled()
    expect(onExists).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('door-notes').value).toBe('the second carton')
    await waitFor(() => expect(draft()).toMatchObject({ key: keys()[0], notes: 'the second carton' }))
    expect(draft().sent).toHaveLength(2)
  })

  it('B1 — the same door, but the item was made longer ago than the bound (the sheet sat open): NOTHING is written', async () => {
    lostThenReplayed({}, { ...FIRST, ...stamps(LONG_AGO) })
    const door = await openDoor()
    asIs()
    save(); await failed()
    tap('door-from'); typeInto('door-notes', 'the second carton')
    save()
    await answered(door, 2)
    expect(otherWrites()).toEqual([])
    expect(errorText()).toBe(STALE)
    expect(door.onSaved).not.toHaveBeenCalled()
  })

  it('B1 — an item whose answer carries no stamps at all is not this sitting\'s: NOTHING is written', async () => {
    const { created_at: _c, updated_at: _u, ...bare } = FIRST
    lostThenReplayed({}, bare)
    const door = await openDoor()
    asIs()
    save(); await failed()
    tap('door-from'); typeInto('door-notes', 'the second carton')
    save()
    await answered(door, 2)
    expect(otherWrites()).toEqual([])
    expect(errorText()).toBe(STALE)
    expect(door.onSaved).not.toHaveBeenCalled()
  })

  it('a restored draft saved UNTOUCHED is still one body: replayed, no PATCH, saved from the server\'s item (an edit made on it since is left alone)', async () => {
    lostThenReplayed({}, { ...FIRST, notes: 'edited in the Pantry since', ...stamps(3 * 60 * 60 * 1000, 60 * 1000) })
    const first = await openDoor()
    asIs()
    save(); await failed()
    await waitFor(() => expect(draft()?.sent).toHaveLength(1))
    first.unmount()
    const second = await openDoor()
    save()
    await waitFor(() => expect(second.onSaved).toHaveBeenCalledTimes(1))
    expect(otherWrites()).toEqual([])
    expect(second.onSaved.mock.calls[0][0].saved).toMatchObject({ notes: 'edited in the Pantry since' })
    expect(draft()).toBeNull()
  })

  // REVIEW I2. The body is not only what he typed: the date is the chip read against the clock, and a typed
  // name's crop is the search's answer. Neither is a change.
  it('I2 — Save at 11:58 pm (answer lost), the door opened again at 12:02 am, Save untouched: "Today" is now another date in the body, and still NOTHING is written — it is saved as the first Save made it', async () => {
    lostThenReplayed()
    const late = new Date(2026, 9, 1, 23, 58).getTime()
    const early = new Date(2026, 9, 2, 0, 2).getTime()
    const first = await openDoor({ now: late })
    asIs()
    save(); await failed()
    await waitFor(() => expect(draft()?.sent).toHaveLength(1))
    first.unmount()
    const second = await openDoor({ now: early })
    save()
    await answered(second, 2)
    expect(posts().map(c => c.body.acquired_at)).toEqual(['2026-10-01', '2026-10-02'])   // the clock moved the date
    expect(otherWrites()).toEqual([])
    expect(errorText()).toBeNull()
    expect(second.onSaved).toHaveBeenCalledTimes(1)
    expect(keys()[1]).toBe(keys()[0])
    expect(second.onSaved.mock.calls[0][0].saved).toMatchObject({ id: 'item-first', acquired_at: '2026-10-01' })
  })

  it('I2 — Save tapped before the name search has answered (answer lost), the search then puts a crop on the name, Save untouched: the body now carries the crop, and still NOTHING is written', async () => {
    const search = ({ path }) => ({ plantings: [], put_ups: [], pantry_items: [], crops: [], varieties: [], hits: [],
      resolved_crop: /q=Tomatoes/.test(path) ? 'tomato' : null })
    lostThenReplayed({ 'GET /api/kitchen-batches/line-search': search }, { ...FIRST, name: 'Tomatoes' })
    const door = await openDoor()
    asIs('Tomatoes')
    save(); await failed()
    expect(posts()[0].body).not.toHaveProperty('crop_type_slug')
    await waitFor(() => expect(fake.calls('GET', '/api/kitchen-batches/line-search').some(c => /q=Tomatoes/.test(c.path))).toBe(true), { timeout: 3000 })
    await act(async () => { await Promise.resolve() })
    save()
    await answered(door, 2)
    expect(posts()[1].body).toMatchObject({ name: 'Tomatoes', crop_type_slug: 'tomato' })
    expect(otherWrites()).toEqual([])
    expect(errorText()).toBeNull()
    expect(door.onSaved).toHaveBeenCalledTimes(1)
    expect(keys()[1]).toBe(keys()[0])
  })

  it('a date he CHANGED is a change: Yesterday picked after the lost answer rides the PATCH', async () => {
    lostThenReplayed()
    const { onSaved } = await openDoor()
    asIs()
    save(); await failed()
    tap('door-more'); tap('door-when-yesterday')
    save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(patches().map(c => [c.path, c.body.acquired_at])).toEqual([[ROW, '2026-09-30']])
  })

  it('a draft that has never been sent has no `sent`; a stored `sent` that is not a list is not a draft', async () => {
    await openDoor()
    asIs()
    await waitFor(() => expect(draft()?.key).toMatch(UUID))
    expect(draft()).not.toHaveProperty('sent')
    expect(isDoorDraft({ ...draft(), sent: 'x' })).toBe(false)
    expect(isDoorDraft({ ...draft(), sent: ['a/b'] })).toBe(true)
  })

  it('a planting\'s item renamed (the planting kept): the name rides the PATCH, and no crop key goes with it', async () => {
    const PLANTED = { ...FIRST, name: 'Megatron jalapeño', plant_id: 'p1', crop_type_slug: 'pepper' }
    lostThenReplayed({}, PLANTED)
    const { onSaved } = await openDoor({ initialWhat: PLANTING })
    tap('door-place-id:loc-3'); tap('door-method-as_is')
    save(); await failed()
    typeInto('door-what-name', 'Megatron jalapeño, the red ones')
    save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(posts().map(c => c.body.plant_id)).toEqual(['p1', 'p1'])
    expect(patches().map(c => [c.path, c.body.name])).toEqual([[ROW, 'Megatron jalapeño, the red ones']])
    expect(patches()[0].body).not.toHaveProperty('crop_type_slug')
    expect(patches()[0].body).not.toHaveProperty('plant_id')
  })

  it('a planting\'s item, then What changed to a typed name (no planting): no PATCH can carry that — nothing is written, the door says so, and the form stays', async () => {
    const PLANTED = { ...FIRST, name: 'Megatron jalapeño', plant_id: 'p1', crop_type_slug: 'pepper' }
    lostThenReplayed({}, PLANTED)
    const { onSaved } = await openDoor({ initialWhat: PLANTING })
    tap('door-place-id:loc-3'); tap('door-method-as_is')
    save(); await failed()
    expect(posts()[0].body).toMatchObject({ plant_id: 'p1', crop_type_slug: 'pepper' })
    // An edited name keeps its planting; "Change" is what lets go of it.
    tap('door-what-change'); typeInto('door-what-name', 'Jalapeños from the store')
    if (screen.getByTestId('door-method-as_is').getAttribute('aria-checked') !== 'true') tap('door-method-as_is')
    save()
    await failed(replayFixedText(PLANTED))
    expect(posts()[1].body).not.toHaveProperty('plant_id')
    expect(keys()[1]).toBe(keys()[0])
    expect(otherWrites()).toEqual([])
    expect(onSaved).not.toHaveBeenCalled()
    expect(screen.getByTestId('door-what-name').value).toBe('Jalapeños from the store')
    expect(screen.getByTestId('door-save').disabled).toBe(false)
    expect(draft()).toMatchObject({ key: keys()[0], what: { name: 'Jalapeños from the store' } })
  })

  // REVIEW I1. The sentence says "put it back as it was": that has to work, and carry what else changed.
  it('I1 — … and What PUT BACK to the planting, Save: ONE PATCH to the item, carrying the other changes; the planting is not sent, and nothing was written before it', async () => {
    const PLANTED = { ...FIRST, name: 'Megatron jalapeño', plant_id: 'p1', crop_type_slug: 'pepper' }
    const search = () => ({ plantings: [{ plant_id: 'p1', label: 'Megatron jalapeño', crop_type_slug: 'pepper', variety_id: 'v1', recent_picks: [] }], put_ups: [] })
    lostThenReplayed({ 'GET /api/kitchen-batches/line-search': search }, PLANTED)
    const door = await openDoor({ initialWhat: PLANTING })
    const { onSaved, onExists } = door
    tap('door-place-id:loc-3'); tap('door-method-as_is')
    save(); await failed()
    tap('door-what-change'); typeInto('door-what-name', 'Jalapeños from the store')
    if (screen.getByTestId('door-method-as_is').getAttribute('aria-checked') !== 'true') tap('door-method-as_is')
    tap('door-from'); typeInto('door-notes', 'the red ones')
    save()
    await failed(replayFixedText(PLANTED))
    expect(otherWrites()).toEqual([])
    // Put back: the planting is picked again from the search.
    typeInto('door-what-name', 'Megatron')
    fireEvent.click(await screen.findByTestId('door-what-hit-planting:p1', {}, { timeout: 3000 }))
    if (screen.getByTestId('door-method-as_is').getAttribute('aria-checked') !== 'true') tap('door-method-as_is')
    save()
    await answered(door, 3)
    expect(posts().map(c => c.body.plant_id ?? null)).toEqual(['p1', null, 'p1'])
    expect(otherWrites()).toEqual([['PATCH', ROW]])
    expect(errorText()).toBeNull()
    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(new Set(keys()).size).toBe(1)
    expect(patches()[0].body).toMatchObject({ name: 'Megatron jalapeño', notes: 'the red ones' })
    expect(patches()[0].body).not.toHaveProperty('plant_id')
    expect(patches()[0].body).not.toHaveProperty('crop_type_slug')
    expect(onSaved.mock.calls[0][0].saved).toMatchObject({ id: 'item-first', notes: 'the red ones' })
    expect(onExists).toHaveBeenCalledTimes(1)                                  // at the refusal: the item is in the Pantry
  })
})

// REVIEW I3 — "the page behind must learn the row exists". The door calls `onExists`; these are the two pages
// that hand it one, each read through its own list read with the door still open.
describe('the pages behind the door are told the item is there', () => {
  const errorText = () => screen.queryByTestId('door-error')?.textContent ?? null
  const refused = { [`PATCH ${ITEMS}/*`]: () => { throw apiError(503, { error: 'boom' }) } }

  it('the Put-Up page: a change that did not save reads the Pantry list again, the door still open', async () => {
    lostThenReplayed(refused)
    render(<MemoryRouter initialEntries={['/put-up']}><PutUp /></MemoryRouter>)
    fireEvent.click((await screen.findAllByTestId('putup-door'))[0])
    await screen.findByTestId('door-place-id:loc-1')
    typeInto('door-what-name', 'Oat milk'); tap('door-place-id:loc-3'); tap('door-method-as_is')
    tap('door-save')
    await waitFor(() => expect(errorText()).toBe("Couldn't save it — nothing was lost. Try again."))
    const reads = () => fake.calls('GET', '/api/pantry?').length
    const before = reads()
    tap('door-from'); typeInto('door-notes', 'the second carton')
    tap('door-save')
    await waitFor(() => expect(errorText()).toBe(UNSAVED))
    await waitFor(() => expect(reads()).toBeGreaterThan(before))
    expect(screen.getByTestId('door-notes').value).toBe('the second carton')
  })

  it('a planting\'s page: a change that did not save reads the planting\'s put-up list again, the door still open', async () => {
    const PLANTED = { ...FIRST, name: 'Megatron jalapeño', plant_id: 'p1', crop_type_slug: 'pepper' }
    lostThenReplayed(refused, PLANTED)
    const planting = { id: 'p1', name: 'Megatron jalapeño', variety_id: 'v1', variety_ref: { id: 'v1', name: 'Megatron jalapeño', crop_type_slug: 'pepper' } }
    render(<MemoryRouter><PutUpFromPlanting planting={planting} fetch={stableFetch.fn} now={NOW.getTime()} /></MemoryRouter>)
    fireEvent.click(await screen.findByTestId('putup-from-planting-door'))
    await screen.findByTestId('door-place-id:loc-1')
    tap('door-place-id:loc-3'); tap('door-method-as_is')
    tap('door-save')
    await waitFor(() => expect(errorText()).toBe("Couldn't save it — nothing was lost. Try again."))
    expect(posts()[0].body).toMatchObject({ plant_id: 'p1' })
    const reads = () => fake.calls('GET', '/api/preservation/whats-put-up?plant_id=p1').length
    const before = reads()
    typeInto('door-what-name', 'Megatron jalapeño, the red ones')
    tap('door-save')
    await waitFor(() => expect(errorText()).toBe('“Megatron jalapeño” is already in the Pantry — the first Save went through. This change did not save — try again.'))
    await waitFor(() => expect(reads()).toBeGreaterThan(before))
    expect(screen.getByTestId('door-what-name').value).toBe('Megatron jalapeño, the red ones')
  })
})

describe('the Walk — the item route', () => {
  const startWalk = async () => {
    render(<MemoryRouter initialEntries={['/put-up?session=putup']}><PutUp /></MemoryRouter>)
    fireEvent.click(await screen.findByRole('radio', { name: 'Kitchen fridge' }))
    fireEvent.click(screen.getByRole('radio', { name: 'This month' }))
    fireEvent.click(screen.getByTestId('putup-walk-start'))
    await screen.findByTestId('putup-walk-group')
  }
  const typeWhat = (v) => typeInto('walk-what-name', v)
  const save = () => tap('walk-save')
  const errorText = () => screen.queryByTestId('walk-error')?.textContent ?? null
  const failed = (text = "Couldn't save it — what you entered is kept. Try again.") => waitFor(() => expect(errorText()).toBe(text))
  // A saved group is a cleared one: the name field is empty again and nothing is said in red.
  const landed = () => waitFor(() => expect([screen.getByTestId('walk-what-name').value, errorText()]).toEqual(['', null]))

  it('a first-time create: one POST, no PATCH', async () => {
    await startWalk()
    typeWhat('Oat milk'); tap('walk-method-as_is')
    save(); await landed()
    expect(posts()).toHaveLength(1)
    expect(otherWrites()).toEqual([])
  })

  it('a lost answer, Save again untouched, answered replayed: the same key, no PATCH, saved', async () => {
    lostThenReplayed()
    await startWalk()
    typeWhat('Oat milk'); tap('walk-method-as_is')
    save(); await failed()
    save(); await landed()
    expect(keys()).toHaveLength(2)
    expect(keys()[1]).toBe(keys()[0])
    expect(otherWrites()).toEqual([])
  })

  it('a lost answer, the name changed, Save: the same key, ONE PATCH to the replayed item with the new name', async () => {
    lostThenReplayed()
    await startWalk()
    typeWhat('Oat milk'); tap('walk-method-as_is')
    save(); await failed()
    typeWhat('Oat milk, barista')
    save(); await landed()
    expect(keys()).toHaveLength(2)
    expect(keys()[1]).toBe(keys()[0])
    expect(otherWrites()).toEqual([['PATCH', ROW]])
    expect(patches()[0].body).toMatchObject({ name: 'Oat milk, barista', storage_location_id: 'loc-3', acquired_precision: 'month', notes: null })
    expect(patches()[0].body).not.toHaveProperty('crop_type_slug')
  })

  it('I3 — the PATCH fails: the walk says the item IS in the Pantry and this change did not save, and reads the place again (it is listed there); the name typed is still there — and Save again finishes it under the same key', async () => {
    let fail = true
    lostThenReplayed({ [`PATCH ${ITEMS}/*`]: ({ path, body }) => { if (fail) throw apiError(500, { error: 'boom' }); return { item: { id: path.split('/').pop(), ...body } } } })
    await startWalk()
    typeWhat('Oat milk'); tap('walk-method-as_is')
    save(); await failed()
    typeWhat('Oat milk, barista')
    const reads = () => fake.calls('GET', '/api/pantry?').length
    const before = reads()
    save()
    await waitFor(() => expect(patches()).toHaveLength(1))
    await failed(UNSAVED)
    await waitFor(() => expect(reads()).toBeGreaterThan(before))
    expect(screen.getByTestId('walk-what-name').value).toBe('Oat milk, barista')
    fail = false
    save(); await landed()
    expect(new Set(keys()).size).toBe(1)
    expect(patches()).toHaveLength(2)
  })

  it('BUG-PUTUPSAVEFAILHIDDEN-001 — a Save that fails the ordinary way is brought into view, and so is the same failure again', async () => {
    const on = watchScrolls()
    fake = pantryFetch({ rows: [], overrides: { [`POST ${ITEMS}`]: LOST } }); stableFetch.fn = fake
    await startWalk()
    typeWhat('Oat milk'); tap('walk-method-as_is')
    save(); await failed()
    await waitFor(() => expect(broughtIntoView(on, 'walk-error')).toBe(true))
    on.length = 0
    save()
    await waitFor(() => expect(posts()).toHaveLength(2))
    await failed()
    await waitFor(() => expect(broughtIntoView(on, 'walk-error')).toBe(true))
  })

  it('B1 / Q3 — an item made longer ago than the bound (the walk sat a while), the name changed, Save: NOTHING is written; the walk says so, brings the line into view and KEEPS the key — Save again is refused again: no second item, no create under a new key', async () => {
    const on = watchScrolls()
    lostThenReplayed({}, { ...FIRST, ...stamps(LONG_AGO) })
    await startWalk()
    typeWhat('Oat milk'); tap('walk-method-as_is')
    save(); await failed()
    typeWhat('Eggs')
    save()
    await waitFor(() => expect(posts()).toHaveLength(2))
    // Answered: the walk says something new, or the group is cleared (saved).
    await waitFor(() => expect([errorText(), screen.getByTestId('walk-what-name').value]).not.toEqual([null, 'Eggs']))
    expect(otherWrites()).toEqual([])
    expect(errorText()).toBe(STALE)
    expect(keys()[1]).toBe(keys()[0])
    expect(screen.getByTestId('walk-what-name').value).toBe('Eggs')
    expect(screen.getByTestId('walk-error').getAttribute('role')).toBe('alert')
    await waitFor(() => expect(broughtIntoView(on, 'walk-error')).toBe(true))
    // The line stops above the walk's fixed band, as the button under it does.
    expect(screen.getByTestId('walk-error').parentElement.style.scrollMarginBottom).toBe(screen.getByTestId('walk-save').style.scrollMarginBottom)
    expect(screen.getByTestId('walk-save').style.scrollMarginBottom).toMatch(/^\d+px$/)
    for (const nth of [3, 4]) {
      on.length = 0
      save()
      await waitFor(() => expect(posts()).toHaveLength(nth))
      await waitFor(() => expect(screen.getByTestId('walk-save').disabled).toBe(false))
      expect(errorText()).toBe(STALE)                                          // refused again
      await waitFor(() => expect(broughtIntoView(on, 'walk-error')).toBe(true))
    }
    expect(new Set(keys()).size).toBe(1)                                       // ZERO creates under a new key
    expect(otherWrites()).toEqual([])
    expect(screen.getByTestId('walk-what-name').value).toBe('Eggs')
  })

  // QA Q1 — the Walk's own wiring of the rule (appendix A of review-putupreplay3-qa-20261007).
  const PLANTED = { ...FIRST, name: 'Megatron jalapeño', plant_id: 'p1', crop_type_slug: 'pepper' }
  const plantingSearch = () => ({ plantings: [{ plant_id: 'p1', label: 'Megatron jalapeño', crop_type_slug: 'pepper', variety_id: 'v1', recent_picks: [] }], put_ups: [] })

  it('Q1 — a planting item, then What let go of the planting: nothing is written, the walk says so (in view) and keeps what was typed — never a "saved" and a cleared group', async () => {
    const on = watchScrolls()
    lostThenReplayed({ 'GET /api/kitchen-batches/line-search': plantingSearch }, PLANTED)
    await startWalk()
    typeWhat('Megatron')
    fireEvent.click(await screen.findByTestId('walk-what-hit-planting:p1', {}, { timeout: 3000 }))
    tap('walk-method-as_is')
    save(); await failed()
    tap('walk-what-change'); typeWhat('Jalapeños from the store')
    if (screen.getByTestId('walk-method-as_is').getAttribute('aria-checked') !== 'true') tap('walk-method-as_is')
    on.length = 0
    save()
    await waitFor(() => expect(errorText()).toBe(replayFixedText(PLANTED)))
    expect(posts().map(c => c.body.plant_id ?? null)).toEqual(['p1', null])
    expect(otherWrites()).toEqual([])
    expect(screen.getByTestId('walk-what-name').value).toBe('Jalapeños from the store')
    await waitFor(() => expect(broughtIntoView(on, 'walk-error')).toBe(true))
    expect(new Set(keys()).size).toBe(1)
  })

  it('Q1 — "A different date for this one" picked after the lost answer is a change: it rides the PATCH', async () => {
    lostThenReplayed()
    await startWalk()
    typeWhat('Oat milk'); tap('walk-method-as_is')
    save(); await failed()
    tap('walk-more'); tap('walk-own-last_month')
    save()
    await waitFor(() => expect(patches()).toHaveLength(1))
    await landed()
    // The walk's "This month" went out first; last month is the month before it, whatever month this runs in.
    const [first, second] = [posts()[0].body.acquired_at, patches()[0].body.acquired_at]
    expect(patches()[0].body).toMatchObject({ acquired_precision: 'month' })
    expect(second).toMatch(/^\d{4}-\d{2}-01$/)
    expect(second < first).toBe(true)
    expect(new Set(keys()).size).toBe(1)
  })

  // The walk's first item POST is lost; its PATCH LANDS and that answer is lost too.
  function walkPatchLandsAnswerLost() {
    let row = FIRST; let n = 0; let seen = 0
    fake = pantryFetch({ rows: [], overrides: {
      [`POST ${ITEMS}`]: () => { if (++n === 1) LOST(); return { item: row, replayed: true } },
      [`PATCH ${ITEMS}/*`]: ({ body }) => { row = { ...row, ...body, updated_at: new Date().toISOString() }; if (++seen === 1) LOST(); return { item: row } },
    } })
    stableFetch.fn = fake
  }

  it('Q1 / Q3 — the PATCH landed and only its answer was lost: Save again finds the item already holding it and is a save — no second PATCH, one key, the group cleared', async () => {
    walkPatchLandsAnswerLost()
    await startWalk()
    typeWhat('Oat milk'); tap('walk-method-as_is')
    save(); await failed()
    typeWhat('Oat milk, barista')
    save()
    await failed(MAYBE)
    save()
    await landed()
    expect(posts()).toHaveLength(3)
    expect(patches().map(c => c.body.name)).toEqual(['Oat milk, barista'])
    expect(new Set(keys()).size).toBe(1)
  })

  it('Q1 — … and the name changed AGAIN before that Save: the item\'s updated_at moved by this walk\'s own PATCH, so the second PATCH still goes onto it', async () => {
    walkPatchLandsAnswerLost()
    await startWalk()
    typeWhat('Oat milk'); tap('walk-method-as_is')
    save(); await failed()
    typeWhat('Oat milk, barista')
    save()
    await failed(MAYBE)
    typeWhat('Oat milk, barista blend')
    save()
    await landed()
    expect(patches().map(c => c.body.name)).toEqual(['Oat milk, barista', 'Oat milk, barista blend'])
    expect(new Set(keys()).size).toBe(1)
  })

  it('a name whose crop the search has since worked out: the crop rides the PATCH with the name', async () => {
    const search = ({ path }) => ({ plantings: [], put_ups: [], pantry_items: [], crops: [], varieties: [], hits: [],
      resolved_crop: /q=Tomatoes/.test(path) ? 'tomato' : null })
    lostThenReplayed({ 'GET /api/kitchen-batches/line-search': search }, { ...FIRST, name: 'Tomatos' })
    await startWalk()
    typeWhat('Tomatos'); tap('walk-method-as_is')
    save(); await failed()
    typeWhat('Tomatoes')
    // The search answers after its pause, and the answer puts the crop on the name.
    await waitFor(() => expect(fake.calls('GET', '/api/kitchen-batches/line-search').some(c => /q=Tomatoes/.test(c.path))).toBe(true), { timeout: 3000 })
    await act(async () => { await Promise.resolve() })
    save(); await landed()
    expect(posts()[1].body).toMatchObject({ name: 'Tomatoes', crop_type_slug: 'tomato' })
    expect(keys()[1]).toBe(keys()[0])
    expect(patches().map(c => [c.body.name, c.body.crop_type_slug])).toEqual([['Tomatoes', 'tomato']])
  })
})
