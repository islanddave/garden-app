// BUG-PUTUPREPLAYDROPSEDIT-001 — the pantry item (POST /api/pantry/items), on its two doors: Put something
// up, and the Walk. The rule and the other creates are in PutUpReplayEdit.test.jsx.
//
// The key stays what it was (plan R2 V2 "Retry key"; PutUpR2Df.door.test.jsx "the retry key" pins the put-up
// route, untouched here). When the ITEM route answers `replayed: true` and another body went out under the key
// before, the door PATCHes what it holds onto the item the answer names, and completes from the PATCH's answer.
//   • a first-time create → no PATCH;                • the same body replayed → no PATCH, saved;
//   • a changed body replayed → the SAME key, ONE PATCH to that item, carrying the change (judged by the
//     Lambda's own validateItemPatch — the fake's default PATCH runs it), and the changed item handed on;
//   • the PATCH fails → not saved is said, the form keeps the change, the key is NOT minted again (even on a
//     4xx: the item exists), and Save again finishes it;
//   • What became another planting, or stopped being one: no PATCH can carry that, so nothing is written
//     and the door says so;
//   • what went out under the key rides in the draft, so a dismiss between the lost answer and the retry
//     changes nothing.
// CI lane: `npm test` plus the TZ re-run. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
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
import { DOOR_SHEET, ITEM_FIXED_KEYS, itemPatchOf, replayFixedText } from '../components/pantry/putSomethingUp.js'
import { sendPrint } from '../components/kitchen/idempotencyKey.js'
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
// The item the first POST made, as the route answers a replay with it.
const FIRST = {
  id: 'item-first', user_id: 'user_dave', name: 'Oat milk', storage_location_id: 'loc-3', place: { ...PLACES[2] },
  acquired_at: '2026-10-01', acquired_precision: 'day', use_by_target: null, plant_id: null, crop_type_slug: null,
  quantity_value: null, quantity_unit: null, source_kind: null, source_label: null, used_up_at: null, notes: null,
}
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

  it('the planting is the one key no PATCH carries; the sentence for it names the item and holds no banned word', () => {
    expect([...ITEM_FIXED_KEYS]).toEqual(['plant_id'])
    expect(validateItemPatch({ plant_id: '99999999-aaaa-4bbb-8ccc-000000000003' })).toMatch(/cannot be changed here: plant_id/)
    expect(replayFixedText(FIRST)).toBe('Already in the Pantry as “Oat milk” — the first Save went through. Which planting it came from can\'t be changed from here. Put it back as it was, or close this and fix it in the Pantry.')
    expect(replayFixedText(null)).toMatch(/^Already in the Pantry — the first Save went through\./)
    expect(replayFixedText(FIRST)).not.toMatch(BANNED)
  })
})

describe('Put something up — the item route', () => {
  async function openDoor(props = {}) {
    const handlers = { onClose: vi.fn(), onSaved: vi.fn(), ...props }
    const view = render(<PutSomethingUpSheet open now={NOW.getTime()} {...handlers} />)
    await screen.findByTestId('door-place-id:loc-1')
    return { ...view, ...handlers }
  }
  const asIs = (name = 'Oat milk') => { typeInto('door-what-name', name); tap('door-place-id:loc-3'); tap('door-method-as_is') }
  const save = () => tap('door-save')
  const errorText = () => screen.queryByTestId('door-error')?.textContent ?? null
  const failed = (text = "Couldn't save it — nothing was lost. Try again.") => waitFor(() => expect(errorText()).toBe(text))
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

  it('the PATCH fails with no answer or a 5xx: not saved is said, the change is still in the form and the draft, nothing is handed on — and Save again finishes it under the same key', async () => {
    let fail = true
    lostThenReplayed({ [`PATCH ${ITEMS}/*`]: ({ path, body }) => { if (fail) throw apiError(503, { error: 'boom' }); return { item: { id: path.split('/').pop(), ...body } } } })
    const { onSaved } = await openDoor()
    asIs()
    save(); await failed()
    tap('door-from'); typeInto('door-notes', 'the second carton')
    save()
    await waitFor(() => expect(patches()).toHaveLength(1))
    await failed()
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

  it('the PATCH is refused with a 4xx: its sentence is shown — and the key is NOT minted again (the item exists; a new key would make a second one)', async () => {
    lostThenReplayed({ [`PATCH ${ITEMS}/*`]: () => { throw apiError(400, { error: 'That crop is not one this app knows.' }) } })
    const { onSaved } = await openDoor()
    asIs()
    save(); await failed()
    tap('door-from'); typeInto('door-notes', 'the second carton')
    save()
    await failed('That crop is not one this app knows.')
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

  it('dismissed and opened again between the lost answer and the retry: what went out rides in the draft, so the change still goes onto the item', async () => {
    lostThenReplayed()
    const first = await openDoor()
    asIs()
    save(); await failed()
    await waitFor(() => expect(draft()?.sent).toHaveLength(1))
    expect(draft().sent).toEqual([sendPrint(posts()[0].body, ITEM_FIXED_KEYS)])
    first.unmount()
    const second = await openDoor()
    expect(screen.getByTestId('door-what-name').value).toBe('Oat milk')
    tap('door-from'); typeInto('door-notes', 'the second carton')
    save()
    await waitFor(() => expect(second.onSaved).toHaveBeenCalledTimes(1))
    expect(keys()[1]).toBe(keys()[0])
    expect(patches().map(c => c.body.notes)).toEqual(['the second carton'])
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

  it('the PATCH fails: not saved is said, the name typed is still there — and Save again finishes it under the same key', async () => {
    let fail = true
    lostThenReplayed({ [`PATCH ${ITEMS}/*`]: ({ path, body }) => { if (fail) throw apiError(500, { error: 'boom' }); return { item: { id: path.split('/').pop(), ...body } } } })
    await startWalk()
    typeWhat('Oat milk'); tap('walk-method-as_is')
    save(); await failed()
    typeWhat('Oat milk, barista')
    save()
    await waitFor(() => expect(patches()).toHaveLength(1))
    await failed()
    expect(screen.getByTestId('walk-what-name').value).toBe('Oat milk, barista')
    fail = false
    save(); await landed()
    expect(new Set(keys()).size).toBe(1)
    expect(patches()).toHaveLength(2)
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
