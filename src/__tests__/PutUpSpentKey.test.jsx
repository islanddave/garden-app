// BUG-PUTUPREPLAYDROPSEDIT-001, pre-promote review I-1 — a "saved earlier" refusal ends the STORED draft.
//
// The rule (kitchen/idempotencyKey.js; PutUpReplayEdit*.test.jsx) is untouched: a retry never mints a new key
// for the same draft, a refused Save writes nothing, and the sheet that was refused keeps its key — Save again
// is refused again. What was missing is the way out. The refusal left the draft in storage with the key the
// first Save spent, so the door closed and opened again came back bound to it: an untouched Save and another
// thing altogether were both refused, each quoting the first item, and every open wrote the draft again, so
// its 24 h never ran out. Now a "saved earlier" refusal takes the draft out of storage:
//   • the sheet that is open is as it was — the same key, refused again, nothing written;
//   • closed and opened again, or reloaded without ever being closed: a clean sheet with no key, and what is
//     typed there is a new thing under a new key — one new row, the earlier one as it was;
//   • nothing is written back, so an open cannot keep the refused draft alive;
//   • a draft whose answer was lost and has NOT been refused still restores with its key (an untouched retry
//     is the same row, never a second);
//   • the door's put-up route is another create under the same key: a Save sent there after the refusal stores
//     the draft again, so a lost answer on it is still retried under that key.
// The Walk holds its key in memory only (it is the walk page's, never stored): leaving the walk already ends
// it. That is pinned here as it is, unchanged.
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

import PutSomethingUpSheet from '../components/pantry/PutSomethingUpSheet.jsx'
import PutUp from '../pages/PutUp.jsx'
import RecipeSheet from '../components/recipes/RecipeSheet.jsx'
import { DOOR_SHEET } from '../components/pantry/putSomethingUp.js'
import { sheetDraftKey, SHEET_DRAFT_TTL_MS } from '../components/kitchen/sheetDraft.js'
import { clearReloadBlocks } from '../lib/reloadGate.js'

const NOW = new Date(2026, 9, 1, 14, 0)               // Oct 1 2026, 2 pm, local
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const ITEMS = '/api/pantry/items'
const JARS = '/api/preservation'
const LONG_AGO = 11 * 60 * 1000                       // a minute past the bound (idempotencyKey.js REPLAY_FRESH_MS)
const HOUR = 60 * 60 * 1000
const LOST = () => { throw new TypeError('Failed to fetch') }       // it may have landed; its answer did not come back
const stamps = (madeAgoMs = 30 * 1000) => {
  const at = new Date(Date.now() - madeAgoMs).toISOString()
  return { created_at: at, updated_at: at }
}

const tap = (id) => fireEvent.click(screen.getByTestId(id))
const typeInto = (id, v) => fireEvent.change(screen.getByTestId(id), { target: { value: v } })
// A stored draft's whole record ({ v, sheet, savedAt, data }), or null: what a reload would find.
const record = (key) => JSON.parse(localStorage.getItem(key) ?? 'null')

// A create route's memory of keys, as the server keeps it: the first POST under a key makes the row; every
// later one under it is answered `replayed: true` with that row, whatever its body. `lose` names the POSTs
// (counted from 1) whose answer never comes back — the row is made all the same.
function keyed(rowOf, { lose = [1] } = {}) {
  const made = new Map()
  let n = 0
  const post = (body) => {
    n += 1
    const had = made.get(body.idempotency_key)
    const row = had ?? rowOf(body, made.size + 1)
    made.set(body.idempotency_key, row)
    if (lose.includes(n)) LOST()
    return { row, replayed: !!had }
  }
  return { post, rows: () => [...made.values()] }
}

beforeEach(() => {
  fake = pantryFetch({ rows: [] }); stableFetch.fn = fake
  localStorage.clear(); sessionStorage.clear(); clearReloadBlocks()
})
afterEach(() => { cleanup(); clearReloadBlocks(); vi.restoreAllMocks() })

describe('Put something up — a "saved earlier" refusal ends the stored draft', () => {
  const DRAFT_KEY = sheetDraftKey('user_dave', DOOR_SHEET, 'new')
  const STALE = '“Oat milk” was already saved earlier — it is in the Pantry. This Save did not change it. To change it, open it in the Pantry.'
  const stored = () => record(DRAFT_KEY)
  const posts = (path = ITEMS) => fake.calls('POST').filter(c => c.path === path)
  const keys = (path = ITEMS) => posts(path).map(c => c.body.idempotency_key)
  // Every write that is not a create on one of the door's two routes: [method, path].
  const otherWrites = () => fake.calls().filter(c => c.method !== 'GET' && !(c.method === 'POST' && (c.path === ITEMS || c.path === JARS))).map(c => [c.method, c.path])
  // The item route, keeping its keys. `madeAgoMs` is how long ago each row says it was made: past the bound,
  // the row is not this sitting's and a changed Save is refused in the door that sent the first one.
  function serve({ lose = [1], madeAgoMs = 30 * 1000, overrides = {} } = {}) {
    const items = keyed((body, nth) => ({
      id: `item-${nth}`, user_id: 'user_dave', name: body.name, storage_location_id: body.storage_location_id ?? null,
      acquired_at: body.acquired_at, acquired_precision: body.acquired_precision, use_by_target: null, plant_id: null, crop_type_slug: null,
      quantity_value: null, quantity_unit: null, source_kind: null, source_label: null, used_up_at: null, notes: body.notes ?? null,
      ...stamps(madeAgoMs), deleted_at: null,
    }), { lose })
    fake = pantryFetch({ rows: [], overrides: {
      [`POST ${ITEMS}`]: ({ body }) => { const { row, replayed } = items.post(body); return replayed ? { item: row, replayed: true } : { item: row } },
      ...overrides,
    } })
    stableFetch.fn = fake
    return items
  }
  async function openDoor(props = {}) {
    const handlers = { onClose: vi.fn(), onSaved: vi.fn(), onExists: vi.fn(), ...props }
    const view = render(<PutSomethingUpSheet open now={NOW.getTime()} {...handlers} />)
    await screen.findByTestId('door-place-id:loc-1')
    return { ...view, ...handlers }
  }
  const checked = (id) => screen.queryByTestId(id)?.getAttribute('aria-checked') === 'true'
  const asIs = (name) => {
    typeInto('door-what-name', name)
    if (!checked('door-place-id:loc-3')) tap('door-place-id:loc-3')
    if (!checked('door-method-as_is')) tap('door-method-as_is')
  }
  const save = () => tap('door-save')
  const errorText = () => screen.queryByTestId('door-error')?.textContent ?? null
  const failed = () => waitFor(() => expect(errorText()).toBe("Couldn't save it — nothing was lost. Try again."))
  // The nth create has been answered and the door is still: it says something, or it has handed the save on.
  const answered = async (h, nth, path = ITEMS) => {
    await waitFor(() => expect(posts(path)).toHaveLength(nth))
    await waitFor(() => expect(h.onSaved.mock.calls.length > 0 || (errorText() != null && !screen.getByTestId('door-save').disabled)).toBe(true))
  }
  // What the door shows of its three questions.
  const form = () => ({
    what: screen.getByTestId('door-what-name').value,
    places: PLACES.map(p => p.id).filter(id => checked(`door-place-id:${id}`)),
    asIs: checked('door-method-as_is'),
  })
  const CLEAN = { what: '', places: [], asIs: false }
  // One door: "Oat milk" saved with its answer lost, the notes changed, Save — refused, the row being older than
  // the bound (the sheet sat open). Leaves the refused door open.
  async function refusedInOneSitting(opts = {}) {
    const items = serve({ madeAgoMs: LONG_AGO, ...opts })
    const door = await openDoor()
    asIs('Oat milk')
    save(); await failed()
    tap('door-from'); typeInto('door-notes', 'the second carton')
    save(); await answered(door, 2)
    expect(errorText()).toBe(STALE)
    return { items, door }
  }

  it('Save (answer lost), a change, Save: refused as saved earlier — then closed and opened again: a clean door with nothing stored, and Rice saves under a NEW key: one new row, the first as it was', async () => {
    const { items, door } = await refusedInOneSitting()
    const first = JSON.stringify(items.rows())
    door.unmount()
    const again = await openDoor()
    expect(form()).toEqual(CLEAN)
    expect(errorText()).toBeNull()
    expect(stored()).toBeNull()                                               // the open wrote nothing back
    asIs('Rice')
    save()
    await waitFor(() => expect(again.onSaved).toHaveBeenCalledTimes(1))
    expect(keys()).toHaveLength(3)
    expect(keys()[1]).toBe(keys()[0])                                         // the refused retry kept its key
    expect(keys()[2]).toMatch(UUID)
    expect(keys()[2]).not.toBe(keys()[0])                                     // the new thing has its own
    expect(items.rows().map(r => r.name)).toEqual(['Oat milk', 'Rice'])
    expect(JSON.stringify(items.rows().slice(0, 1))).toBe(first)
    expect(otherWrites()).toEqual([])
    expect(again.onSaved.mock.calls[0][0]).toMatchObject({ route: 'item', saved: { id: 'item-2', name: 'Rice' } })
    expect(again.onExists).not.toHaveBeenCalled()
    expect(stored()).toBeNull()
  })

  it('while the refused door stays open nothing has changed: Save again is refused again under the same key, an edit there is not stored, nothing is written and no row is added', async () => {
    const { items, door } = await refusedInOneSitting()
    expect(stored()).toBeNull()
    for (const nth of [3, 4]) {
      save(); await answered(door, nth)
      expect(errorText()).toBe(STALE)
    }
    typeInto('door-what-name', 'Rice')
    expect(stored()).toBeNull()
    save(); await answered(door, 5)
    expect(errorText()).toBe(STALE)                                           // still the first item's key: it names Oat milk
    expect(new Set(keys()).size).toBe(1)
    expect(otherWrites()).toEqual([])
    expect(items.rows().map(r => r.name)).toEqual(['Oat milk'])
    expect(door.onSaved).not.toHaveBeenCalled()
    expect(form()).toEqual({ what: 'Rice', places: ['loc-3'], asIs: true })   // what was typed is still there
    expect(screen.getByTestId('door-notes').value).toBe('the second carton')
  })

  it('refused, and the app is reloaded with the door never closed: storage holds no draft from the refusal on, so the door that opens after it is clean', async () => {
    const { door } = await refusedInOneSitting()
    const atRefusal = localStorage.getItem(DRAFT_KEY)                         // read with the refused door still open
    expect(atRefusal).toBeNull()
    door.unmount()
    // A reload runs no unmount: storage is put back exactly as the refusal left it.
    if (atRefusal == null) localStorage.removeItem(DRAFT_KEY); else localStorage.setItem(DRAFT_KEY, atRefusal)
    await openDoor()
    expect(form()).toEqual(CLEAN)
    expect(stored()).toBeNull()
  })

  it('a draft restored from an earlier sitting, another thing typed over it: refused once (it may be the first item — B1, unchanged), then closed and opened: clean, and the other thing is a new item', async () => {
    const items = serve()
    const first = await openDoor()
    asIs('Oat milk')
    save(); await failed()
    await waitFor(() => expect(stored()?.data?.sent).toHaveLength(1))
    const key = stored().data.key
    first.unmount()
    const second = await openDoor()
    expect(form()).toEqual({ what: 'Oat milk', places: ['loc-3'], asIs: true })
    typeInto('door-what-name', 'Rice')
    save(); await answered(second, 2)
    expect(errorText()).toBe(STALE)
    expect(keys()).toEqual([key, key])
    expect(items.rows().map(r => r.name)).toEqual(['Oat milk'])
    expect(stored()).toBeNull()
    second.unmount()
    const third = await openDoor()
    expect(form()).toEqual(CLEAN)
    asIs('Rice')
    save()
    await waitFor(() => expect(third.onSaved).toHaveBeenCalledTimes(1))
    expect(keys()[2]).not.toBe(key)
    expect(items.rows().map(r => r.name)).toEqual(['Oat milk', 'Rice'])
    expect(otherWrites()).toEqual([])
  })

  it('NOT refused — a lost answer alone: closed and opened again, the draft is restored with its key, and an untouched Save is the first row again, never a second', async () => {
    const items = serve()
    const first = await openDoor()
    asIs('Oat milk')
    save(); await failed()
    await waitFor(() => expect(stored()?.data?.sent).toHaveLength(1))
    const key = stored().data.key
    expect(key).toMatch(UUID)
    first.unmount()
    expect(stored().data).toMatchObject({ key, what: { name: 'Oat milk' } })   // closing does not end it
    const second = await openDoor()
    expect(form()).toEqual({ what: 'Oat milk', places: ['loc-3'], asIs: true })
    expect(stored().data.key).toBe(key)
    save()
    await waitFor(() => expect(second.onSaved).toHaveBeenCalledTimes(1))
    expect(keys()).toEqual([key, key])
    expect(items.rows()).toHaveLength(1)
    expect(second.onSaved.mock.calls[0][0].saved).toEqual(items.rows()[0])
    expect(otherWrites()).toEqual([])
    expect(stored()).toBeNull()
  })

  it('an open cannot keep a refused draft alive: opened 23 h after the refusal and again 25 h after it, the door is clean both times and nothing is written', async () => {
    const real = Date.now.bind(Date)
    let ahead = 0
    vi.spyOn(Date, 'now').mockImplementation(() => real() + ahead)
    const { door } = await refusedInOneSitting()
    door.unmount()
    ahead = 23 * HOUR
    const next = await openDoor()
    expect(stored()).toBeNull()
    next.unmount()
    expect(25 * HOUR).toBeGreaterThan(SHEET_DRAFT_TTL_MS)
    ahead = 25 * HOUR
    await openDoor()
    expect(form()).toEqual(CLEAN)
    expect(stored()).toBeNull()
  })

  it('opened from a search with the very name the refused door held: a fresh seeded door, not the spent draft — and it saves as a new item', async () => {
    const { items, door } = await refusedInOneSitting()
    typeInto('door-what-name', 'Rice')
    door.unmount()
    const seeded = await openDoor({ initialName: 'Rice' })
    expect(form()).toEqual({ what: 'Rice', places: [], asIs: false })         // the seed alone: no place, no method, no notes
    tap('door-place-id:loc-3'); tap('door-method-as_is')
    save()
    await waitFor(() => expect(seeded.onSaved).toHaveBeenCalledTimes(1))
    expect(keys()[2]).not.toBe(keys()[0])
    expect(items.rows().map(r => r.name)).toEqual(['Oat milk', 'Rice'])
  })

  it('another tab that still shows the draft writes it back: it is restored with its key, refused once more, and that refusal ends it again', async () => {
    const items = serve()
    const first = await openDoor()
    asIs('Oat milk')
    save(); await failed()
    await waitFor(() => expect(stored()?.data?.sent).toHaveLength(1))
    const otherTab = localStorage.getItem(DRAFT_KEY)                          // what a second tab restored, and writes on its next change
    first.unmount()
    const second = await openDoor()
    typeInto('door-what-name', 'Rice')
    save(); await answered(second, 2)
    expect(errorText()).toBe(STALE)
    expect(stored()).toBeNull()
    localStorage.setItem(DRAFT_KEY, otherTab)
    second.unmount()
    const third = await openDoor()
    expect(form().what).toBe('Oat milk')
    typeInto('door-what-name', 'Rice')
    save(); await answered(third, 3)
    expect(errorText()).toBe(STALE)
    expect(new Set(keys()).size).toBe(1)
    expect(items.rows()).toHaveLength(1)
    expect(stored()).toBeNull()
    third.unmount()
    await openDoor()
    expect(form()).toEqual(CLEAN)
  })

  it('refused, then put up through a method chip instead — another create, under the same key — and THAT answer is lost: the draft is stored again with its key, and the door opened again retries it: one put-up, never two', async () => {
    let n = 0
    const { door } = await refusedInOneSitting({ overrides: { [`POST ${JARS}`]: ({ body }) => {
      if (++n === 1) LOST()                                                   // the put-up landed; its answer was lost
      return { id: 'jar-1', ...body, replayed: true }
    } } })
    const key = keys()[0]
    expect(stored()).toBeNull()
    if (!screen.queryByTestId('door-method-whole_freeze')) tap('door-method-more')
    tap('door-method-whole_freeze')
    save(); await answered(door, 1, JARS)
    await failed()
    await waitFor(() => expect(stored()?.data).toMatchObject({ key, method: 'whole_freeze', what: { name: 'Oat milk' } }))
    door.unmount()
    const again = await openDoor()
    expect(form().what).toBe('Oat milk')
    save()
    await waitFor(() => expect(again.onSaved).toHaveBeenCalledTimes(1))
    expect(keys(JARS)).toEqual([key, key])
    expect(again.onSaved.mock.calls[0][0]).toMatchObject({ route: 'jar', saved: { id: 'jar-1' } })
    expect(stored()).toBeNull()
  })

  // BUG-PUTUPREPLAYREST-001 (item 6). This test used to pin the opposite — "the new key it mints is stored
  // with the draft" — and that new key is what made a second item: item Saves had gone out under the old one,
  // the item is there, and the next As is Save went out under a key the server had never seen.
  it('… and when the put-up route answers that Save with a 4xx, the key is KEPT with what went out under it — back on As is, Save is refused again: one item, one key', async () => {
    const { items, door } = await refusedInOneSitting({ overrides: { [`POST ${JARS}`]: () => { throw apiError(400, { error: 'count must be a whole number' }) } } })
    const key = keys()[0]
    if (!screen.queryByTestId('door-method-whole_freeze')) tap('door-method-more')
    tap('door-method-whole_freeze')
    save(); await answered(door, 1, JARS)
    await waitFor(() => expect(stored()?.data?.method).toBe('whole_freeze'))
    expect(stored().data.key).toBe(key)
    expect(stored().data.sent).toHaveLength(3)                                // the two As is Saves, and this put-up
    expect(stored().data).toMatchObject({ what: { name: 'Oat milk' } })
    expect(keys(JARS)).toEqual([key])
    tap('door-method-as_is')
    save(); await answered(door, 3)
    expect(errorText()).toBe(STALE)
    expect(new Set(keys()).size).toBe(1)
    expect(items.rows()).toHaveLength(1)
  })

  it('the refused door, put back to exactly what the item holds: a save as before, with nothing written and nothing stored', async () => {
    const { items, door } = await refusedInOneSitting()
    typeInto('door-notes', '')
    save()
    await waitFor(() => expect(door.onSaved).toHaveBeenCalledTimes(1))
    expect(new Set(keys()).size).toBe(1)
    expect(items.rows()).toHaveLength(1)
    expect(otherWrites()).toEqual([])
    expect(door.onSaved.mock.calls[0][0].saved).toEqual(items.rows()[0])
    expect(stored()).toBeNull()
  })
})

describe('the recipe sheet — a "saved earlier" refusal ends the stored draft', () => {
  const PATH = '/api/recipes'
  const DRAFT_KEY = sheetDraftKey('user_dave', 'recipe', 'new')
  const STALE = '“Mojo” was already saved earlier — it is with your recipes. This Save did not change it. To change it, open the recipe.'
  const stored = () => record(DRAFT_KEY)
  let calls
  let recipes
  // POST /api/recipes keeping its keys; every call is recorded as [method, path, body].
  const fetch = (path, o = {}) => {
    const method = o.method ?? 'GET'
    const body = o.body ? JSON.parse(o.body) : null
    calls.push([method, path, body])
    if (method !== 'POST' || path !== PATH) return Promise.resolve(null)
    try {
      const { row, replayed } = recipes.post(body)
      return Promise.resolve(replayed ? { recipe: row, replayed: true } : { recipe: row })
    } catch (e) { return Promise.reject(e) }
  }
  beforeEach(() => {
    calls = []
    recipes = keyed((body, nth) => ({ id: `r-${nth}`, name: body.name, notes: body.notes ?? null, lines: [], ...stamps() }))
  })
  const keys = () => calls.filter(([m, p]) => m === 'POST' && p === PATH).map(([, , b]) => b.idempotency_key)
  const otherWrites = () => calls.filter(([m, p]) => m !== 'GET' && !(m === 'POST' && p === PATH)).map(([m, p]) => [m, p])
  const mount = () => {
    const h = { onSaved: vi.fn(), onExists: vi.fn() }
    return { ...render(<RecipeSheet open types={[]} fetch={fetch} onClose={() => {}} {...h} />), ...h }
  }
  const save = () => act(async () => { tap('recipe-save') })
  const errorText = () => screen.queryByTestId('recipe-sheet-error')?.textContent ?? null
  const failed = () => waitFor(() => expect(errorText()).toMatch(/Couldn't save it/))
  const answered = async (h, nth) => {
    await waitFor(() => expect(keys()).toHaveLength(nth))
    await waitFor(() => expect(h.onSaved.mock.calls.length > 0 || (errorText() != null && !screen.getByTestId('recipe-save').disabled)).toBe(true))
  }
  // "Mojo" saved with its answer lost, the sheet dismissed and opened again, another recipe typed over it, Save:
  // refused (B1). Leaves the refused sheet open.
  async function refused() {
    const first = mount()
    typeInto('recipe-name', 'Mojo')
    await save(); await failed()
    await waitFor(() => expect(stored()?.data?.sent).toHaveLength(1))
    const key = stored().data.key
    first.unmount()
    const sheet = mount()
    expect(screen.getByTestId('recipe-name').value).toBe('Mojo')
    typeInto('recipe-name', 'Chimichurri'); typeInto('recipe-notes', 'parsley, not cilantro')
    await save(); await answered(sheet, 2)
    expect(errorText()).toBe(STALE)
    return { sheet, key }
  }

  it('refused as saved earlier: the open sheet is refused again under the same key and stores nothing — then closed and opened again: an empty sheet, and Chimichurri saves under a NEW key: one new recipe, the first as it was', async () => {
    const { sheet, key } = await refused()
    const first = JSON.stringify(recipes.rows())
    expect(stored()).toBeNull()                                               // what a reload would find
    await save(); await answered(sheet, 3)
    expect(errorText()).toBe(STALE)
    typeInto('recipe-notes', 'flat-leaf parsley')
    expect(stored()).toBeNull()                                               // an edit in the refused sheet is not stored
    expect(keys()).toEqual([key, key, key])
    expect(recipes.rows()).toHaveLength(1)
    expect(screen.getByTestId('recipe-name').value).toBe('Chimichurri')
    sheet.unmount()
    const again = mount()
    expect(screen.getByTestId('recipe-name').value).toBe('')
    expect(screen.getByTestId('recipe-notes').value).toBe('')
    expect(errorText()).toBeNull()
    expect(stored()).toBeNull()
    typeInto('recipe-name', 'Chimichurri')
    await save()
    await waitFor(() => expect(again.onSaved).toHaveBeenCalledTimes(1))
    expect(keys()[3]).toMatch(UUID)
    expect(keys()[3]).not.toBe(key)
    expect(recipes.rows().map(r => r.name)).toEqual(['Mojo', 'Chimichurri'])
    expect(JSON.stringify(recipes.rows().slice(0, 1))).toBe(first)
    expect(otherWrites()).toEqual([])
    expect(again.onSaved.mock.calls[0][0]).toMatchObject({ id: 'r-2', name: 'Chimichurri' })
    expect(stored()).toBeNull()
  })

  it('NOT refused — a lost answer alone: opened again, the draft is restored with its key, and an untouched Save is the first recipe again, never a second', async () => {
    const first = mount()
    typeInto('recipe-name', 'Mojo')
    await save(); await failed()
    await waitFor(() => expect(stored()?.data?.sent).toHaveLength(1))
    const key = stored().data.key
    first.unmount()
    expect(stored().data).toMatchObject({ key, name: 'Mojo' })
    const sheet = mount()
    expect(screen.getByTestId('recipe-name').value).toBe('Mojo')
    await save()
    await waitFor(() => expect(sheet.onSaved).toHaveBeenCalledTimes(1))
    expect(keys()).toEqual([key, key])
    expect(recipes.rows()).toHaveLength(1)
    expect(otherWrites()).toEqual([])
    expect(stored()).toBeNull()
  })
})

// The Walk's key is the walk page's own, held in memory and never stored (WalkPlace.jsx heldRef): there is no
// draft for a refusal to leave behind. Leaving the walk ends the key, as it always has.
describe('the Walk — its key is never stored: leaving the walk ends it (unchanged)', () => {
  const STALE = '“Oat milk” was already saved earlier — it is in the Pantry. This Save did not change it. To change it, open it in the Pantry.'
  const keys = () => fake.calls('POST').filter(c => c.path === ITEMS).map(c => c.body.idempotency_key)
  const errorText = () => screen.queryByTestId('walk-error')?.textContent ?? null
  const walk = () => render(<MemoryRouter initialEntries={['/put-up?session=putup']}><PutUp /></MemoryRouter>)

  it('refused in the walk, the walk left and picked up again: a clean group, and Rice saves under a new key — one new row', async () => {
    const items = keyed((body, nth) => ({
      id: `item-${nth}`, user_id: 'user_dave', name: body.name, storage_location_id: body.storage_location_id ?? null,
      acquired_at: body.acquired_at, acquired_precision: body.acquired_precision, use_by_target: null, plant_id: null, crop_type_slug: null,
      quantity_value: null, quantity_unit: null, source_kind: null, source_label: null, used_up_at: null, notes: null,
      ...stamps(LONG_AGO), deleted_at: null,
    }))
    fake = pantryFetch({ rows: [], overrides: {
      [`POST ${ITEMS}`]: ({ body }) => { const { row, replayed } = items.post(body); return replayed ? { item: row, replayed: true } : { item: row } },
    } })
    stableFetch.fn = fake
    const first = walk()
    fireEvent.click(await screen.findByRole('radio', { name: 'Kitchen fridge' }))
    fireEvent.click(screen.getByRole('radio', { name: 'This month' }))
    tap('putup-walk-start')
    await screen.findByTestId('putup-walk-group')
    typeInto('walk-what-name', 'Oat milk'); tap('walk-method-as_is')
    tap('walk-save')
    await waitFor(() => expect(errorText()).toBe("Couldn't save it — what you entered is kept. Try again."))
    typeInto('walk-what-name', 'Eggs')
    tap('walk-save')
    await waitFor(() => expect(errorText()).toBe(STALE))
    first.unmount()
    walk()
    await screen.findByTestId('putup-walk-group')
    expect(screen.getByTestId('walk-what-name').value).toBe('')
    expect(errorText()).toBeNull()
    typeInto('walk-what-name', 'Rice'); tap('walk-method-as_is')
    tap('walk-save')
    await waitFor(() => expect(items.rows().map(r => r.name)).toEqual(['Oat milk', 'Rice']))
    expect(keys()).toHaveLength(3)
    expect(keys()[1]).toBe(keys()[0])
    expect(keys()[2]).not.toBe(keys()[0])
  })
})
