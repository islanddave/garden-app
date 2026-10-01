// Put-Up B′ release 2 — the Pantry segment, its page search, the Put something up door and the rename
// bridge, through the real PutUp page against a fake shaped EXACTLY like the pinned pantry contract
// (helpers/pantryFake.js). Each assertion is on what the person sees or on the wire.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'
import { pantryFetch, jarRow, itemRow, apiError, PLACES } from './helpers/pantryFake.js'

installStoragePolyfill()

let fake
const { stableFetch, viewer } = vi.hoisted(() => ({ stableFetch: { fn: null }, viewer: { id: 'user_dave' } }))
vi.mock('../lib/api.js', () => {
  const f = (...a) => stableFetch.fn(...a)
  return { useApiFetch: () => ({ fetch: f, getToken: () => Promise.resolve('t') }), apiFetch: f }
})
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: vi.fn(), isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))
vi.mock('../hooks/useCropTypes.js', () => ({ useCropTypes: () => ({ cropTypes: [], loading: false }) }))
vi.mock('../context/AuthContext.jsx', async (importActual) => ({
  ...(await importActual()),
  useAuthOptional: () => ({ user: viewer.id ? { id: viewer.id } : null, profile: null, loading: false, identity: 'signed-in' }),
}))

import PutUp from '../pages/PutUp.jsx'
import { BRIDGE_TEXT } from '../components/pantry/pantryBridge.js'

const CF1 = PLACES[0]
const FRIDGE = PLACES[2]
const REAPER = jarRow({ stock_id: 'jar-reaper', name: 'Megatron reaper', place: FRIDGE, group_key: 'loc-3', group_label: 'Kitchen fridge',
  method: 'hot_sauce', count_left: 4, count_made: 6, batch_id: 'kb-1', from_garden: true, where_from: 'Petri Dish',
  discard: { date: '2027-02-01', basis: 'table', status: 'ok' } })
const LAST_JAR = jarRow({ stock_id: 'jar-last', name: 'Pesto cubes', place: FRIDGE, group_key: 'loc-3', group_label: 'Kitchen fridge',
  method: 'pesto', count_left: 1, discard: { date: '2026-10-03', basis: 'typed', status: 'soon' } })
const BAG = jarRow({ stock_id: 'jar-bag', name: 'Reaper, frozen', place: CF1, group_key: 'loc-1', group_label: 'Chest Freezer 1',
  stock_mode: 'weighed', count_left: null, count_made: null, grams_left: 92, method: 'whole_freeze' })
const MILK = itemRow({ stock_id: 'item-milk', name: 'Oat milk', place: FRIDGE, group_key: 'loc-3', group_label: 'Kitchen fridge',
  acquired_at: '2026-09-18', acquired_precision: 'day', where_from: 'Aldi', notes: 'the barista one' })
const ROWS = [BAG, REAPER, LAST_JAR, MILK]

function wire(opts = {}) {
  fake = pantryFetch({ rows: ROWS, ...opts })
  stableFetch.fn = fake
}
function Probe() {
  const loc = useLocation()
  const navigate = useNavigate()
  return (<><div data-testid="probe-loc">{loc.pathname + loc.search}</div><button type="button" onClick={() => navigate(-1)}>probe-back</button></>)
}
function renderPantry(entries = ['/put-up?view=pantry'], props = {}) {
  return render(<MemoryRouter initialEntries={entries}><Probe /><PutUp {...props} /></MemoryRouter>)
}
const rowEl = (key) => screen.findByTestId(`pantry-row-${key}`)
const posts = (path) => fake.calls('POST').filter(c => c.path === path)

beforeEach(() => {
  viewer.id = 'user_dave'
  wire()
  localStorage.clear(); sessionStorage.clear()
})

describe('the Pantry segment (V4 §2.5, §6.1)', () => {
  it('is named Pantry, lands a bare open, and reads GET /api/pantry grouped By place', async () => {
    renderPantry(['/put-up'])
    const seg = screen.getByRole('radiogroup', { name: 'Put-Up view' })
    expect(within(seg).getAllByRole('radio').map(r => r.textContent)).toEqual(['Going now', 'Log a put-up', 'Pantry', 'Recipes'])
    expect(within(seg).getByRole('radio', { name: 'Pantry' }).getAttribute('aria-checked')).toBe('true')
    await screen.findByRole('heading', { name: 'Kitchen fridge' })
    expect(fake.calls('GET').some(c => c.path === '/api/pantry?group=place')).toBe(true)
    // The old name survives only inside the bridge line that explains the rename.
    expect(document.body.textContent.replace(BRIDGE_TEXT, '')).not.toMatch(/What.s put up|stores/)
  })

  it('groups the server\'s rows in its order, and regroups By what it is', async () => {
    renderPantry()
    await screen.findByRole('heading', { name: 'Kitchen fridge' })
    expect(screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent)).toEqual(['Chest Freezer 1', 'Kitchen fridge'])
    const fridge = within(screen.getByRole('region', { name: 'Kitchen fridge' }))
    expect(fridge.getAllByTestId(/^pantry-row-open-/).map(b => b.querySelector('span').textContent)).toEqual(['Megatron reaper', 'Pesto cubes', 'Oat milk'])
    fireEvent.click(screen.getByRole('radio', { name: 'By what it is' }))
    await waitFor(() => expect(fake.calls('GET').some(c => c.path === '/api/pantry?group=kind')).toBe(true))
  })

  // AMENDED (Put-Up UX pass R1, F22): grouped By place a row sits under its place's heading and does not
  // repeat it. The detail line is asserted from the name's end, so nothing may stand before "where from".
  it('a row says name · where from · what is left · the discard chip · From the garden — its place is the heading above it', async () => {
    renderPantry()
    const open = await screen.findByTestId('pantry-row-open-put_up:jar-reaper')
    expect(open.textContent).toContain('Megatron reaper')
    expect(open.textContent).toContain('Megatron reaper' + 'Petri Dish · 4 left')
    expect(open.textContent).not.toContain('Kitchen fridge')
    expect(within(screen.getByRole('region', { name: 'Kitchen fridge' })).getByTestId('pantry-row-open-put_up:jar-reaper')).toBe(open)
    expect(open.textContent).toContain('discard by Feb 1, 2027 · general figure: hot sauce, fridge')
    expect(open.textContent).toContain('From the garden')
    expect((await screen.findByTestId('pantry-row-open-put_up:jar-bag')).textContent).toContain('about 92 g left')
    const milk = screen.getByTestId('pantry-row-open-pantry_item:item-milk').textContent
    expect(milk).toContain('Oat milk' + 'Aldi · had it')
    expect(milk).not.toContain('Kitchen fridge')
    expect(milk).toContain('the barista one')
    expect(milk).not.toMatch(/left|discard/)
    expect(screen.getByTestId('pantry-row-open-put_up:jar-last').textContent).toContain('discard by Oct 3 · set by hand · soon')
  })

  it('offers ONE inline action: Used one while more than one is left, Used it up otherwise', async () => {
    renderPantry()
    await rowEl('put_up:jar-reaper')
    const names = screen.getAllByRole('button', { name: /^Used (one|it up) — / }).map(b => b.getAttribute('aria-label'))
    expect(names).toEqual(['Used it up — Reaper, frozen', 'Used one — Megatron reaper', 'Used it up — Pesto cubes', 'Used it up — Oat milk'])
  })
})

describe('Used one / Used it up, in place, with Undo for the person who acted (no timer)', () => {
  it('Used one → "3 left · used one · Undo"; Undo posts the undo route with its own key', async () => {
    renderPantry()
    fireEvent.click(await screen.findByRole('button', { name: 'Used one — Megatron reaper' }))
    await waitFor(() => expect(posts('/api/pantry/uses')).toHaveLength(1))
    expect(posts('/api/pantry/uses')[0].body).toMatchObject({ preservation_log_id: 'jar-reaper', count_used: 1 })
    const done = await screen.findByTestId('pantry-row-done-put_up:jar-reaper')
    expect(done.textContent).toBe('3 left · used one' + 'Undo')
    expect(done.getAttribute('role')).toBe('status')
    fireEvent.click(within(done).getByRole('button', { name: 'Undo — Megatron reaper' }))
    await waitFor(() => expect(fake.calls('POST').filter(c => /\/undo$/.test(c.path))).toHaveLength(1))
    const undo = fake.calls('POST').find(c => /\/undo$/.test(c.path))
    expect(undo.path).toMatch(/^\/api\/pantry\/uses\/use-\d+\/undo$/)
    expect(Object.keys(undo.body)).toEqual(['idempotency_key'])
    await waitFor(() => expect(screen.queryByTestId('pantry-row-done-put_up:jar-reaper')).toBeNull())
  })

  it('Used it up on the last jar keeps the row on screen for its Undo after the server stops listing it', async () => {
    renderPantry()
    fireEvent.click(await screen.findByRole('button', { name: 'Used it up — Pesto cubes' }))
    await waitFor(() => expect(posts('/api/pantry/uses')).toHaveLength(1))
    expect(posts('/api/pantry/uses')[0].body).toMatchObject({ preservation_log_id: 'jar-last', all_remaining: true })
    // The server no longer lists it; the page re-reads, and the actor still sees it with its Undo.
    fake.state.rows = fake.state.rows.filter(r => r.stock_id !== 'jar-last')
    const done = await screen.findByTestId('pantry-row-done-put_up:jar-last')
    expect(done.textContent).toContain('used it up')
    expect(screen.queryByRole('button', { name: 'Used it up — Pesto cubes' })).toBeNull()
    expect(within(done).getByRole('button', { name: 'Undo — Pesto cubes' })).toBeTruthy()
  })

  it('a bought item: Used it up is a PATCH used_up_at "now"; Undo is null', async () => {
    renderPantry()
    fireEvent.click(await screen.findByRole('button', { name: 'Used it up — Oat milk' }))
    await waitFor(() => expect(fake.calls('PATCH', '/api/pantry/items/item-milk')).toHaveLength(1))
    expect(fake.calls('PATCH')[0].body).toEqual({ used_up_at: 'now' })
    const done = await screen.findByTestId('pantry-row-done-pantry_item:item-milk')
    fireEvent.click(within(done).getByRole('button', { name: 'Undo — Oat milk' }))
    await waitFor(() => expect(fake.calls('PATCH')).toHaveLength(2))
    expect(fake.calls('PATCH')[1].body).toEqual({ used_up_at: null })
  })

  it('a refused Undo says why in plain words (the server\'s code) and keeps the Undo', async () => {
    wire({ overrides: { 'POST /api/pantry/uses/*': ({ path }) => {
      if (path.endsWith('/undo')) throw apiError(409, { error: 'That was already undone.', code: 'already_undone' })
      return { use: { id: 'use-9' }, jar: { remaining_count: 3 } }
    } } })
    renderPantry()
    fireEvent.click(await screen.findByRole('button', { name: 'Used one — Megatron reaper' }))
    const done = await screen.findByTestId('pantry-row-done-put_up:jar-reaper')
    fireEvent.click(within(done).getByRole('button', { name: 'Undo — Megatron reaper' }))
    expect((await screen.findByTestId('pantry-row-error-put_up:jar-reaper')).textContent).toBe('That was already undone — nothing was changed.')
    expect(within(screen.getByTestId('pantry-row-done-put_up:jar-reaper')).getByRole('button', { name: /^Undo/ })).toBeTruthy()
  })

  it('the in-place line lasts until the next visit — a fresh visit shows the plain row', async () => {
    const first = renderPantry()
    fireEvent.click(await screen.findByRole('button', { name: 'Used one — Megatron reaper' }))
    await screen.findByTestId('pantry-row-done-put_up:jar-reaper')
    first.unmount()
    renderPantry()
    await rowEl('put_up:jar-reaper')
    expect(screen.queryByTestId('pantry-row-done-put_up:jar-reaper')).toBeNull()
  })
})

describe('the page search (V4 §2.5)', () => {
  it('results replace the segment body; name match only; × clears', async () => {
    renderPantry()
    await rowEl('put_up:jar-reaper')
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search the pantry' }), { target: { value: 'reaper' } })
    const results = await screen.findByTestId('pantry-search-results')
    expect(screen.queryByTestId('pantry-view')).toBeNull()
    expect(screen.queryByRole('radiogroup', { name: 'Put-Up view' })).toBeNull()
    expect(within(results).getAllByRole('button').map(b => b.textContent)).toEqual([
      'Reaper, frozen · Chest Freezer 1 · about 92 g left', 'Megatron reaper · Kitchen fridge · 4 left'])
    fireEvent.click(screen.getByRole('button', { name: 'Clear the search' }))
    await screen.findByTestId('pantry-view')
    expect(screen.getByTestId('probe-loc').textContent).toBe('/put-up?view=pantry')
  })

  it('is a name search: a crop, a place or a method is not a match', async () => {
    renderPantry()
    await rowEl('put_up:jar-reaper')
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search the pantry' }), { target: { value: 'fridge' } })
    expect(await screen.findByTestId('pantry-search-putup')).toBeTruthy()
  })

  it('Back clears it: the first keystroke pushed one entry, the rest replaced it', async () => {
    renderPantry(['/today', '/put-up?view=pantry'])
    await rowEl('put_up:jar-reaper')
    const box = screen.getByRole('searchbox', { name: 'Search the pantry' })
    fireEvent.change(box, { target: { value: 'p' } })
    fireEvent.change(box, { target: { value: 'pe' } })
    fireEvent.change(box, { target: { value: 'pes' } })
    await waitFor(() => expect(screen.getByTestId('probe-loc').textContent).toBe('/put-up?view=pantry&find=pes'))
    fireEvent.click(screen.getByRole('button', { name: 'probe-back' }))
    await waitFor(() => expect(screen.getByTestId('probe-loc').textContent).toBe('/put-up?view=pantry'))
    expect(await screen.findByTestId('pantry-view')).toBeTruthy()
  })

  it('a tap opens the row\'s sheet; no hit offers "Put something up: <text> →", which opens the door with it', async () => {
    renderPantry()
    await rowEl('put_up:jar-reaper')
    const box = screen.getByRole('searchbox', { name: 'Search the pantry' })
    fireEvent.change(box, { target: { value: 'oat' } })
    fireEvent.click(await screen.findByTestId('pantry-search-hit-pantry_item:item-milk'))
    expect((await screen.findByTestId('row-sheet')).getAttribute('data-row-key')).toBe('pantry_item:item-milk')
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.change(box, { target: { value: 'sourdough' } })
    const putUp = await screen.findByTestId('pantry-search-putup')
    expect(putUp.textContent).toBe('Put something up: sourdough →')
    fireEvent.click(putUp)
    expect(await screen.findByRole('dialog', { name: 'Put something up' })).toBeTruthy()
    expect(screen.getByTestId('door-what-name').value).toBe('sourdough')
  })

  it('takes an extra corpus (the recipes lane\'s loaded recipes) and opens one through its own onOpen', async () => {
    const onOpen = vi.fn()
    renderPantry(['/put-up?view=pantry'], { extraSearchItems: [{ key: 'r1', name: 'Reaper sauce #4', kindLabel: 'recipe', onOpen }] })
    await rowEl('put_up:jar-reaper')
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search the pantry' }), { target: { value: 'sauce' } })
    const hit = await screen.findByTestId('pantry-search-hit-extra:r1')
    expect(hit.textContent).toBe('Reaper sauce #4 · recipe')
    fireEvent.click(hit)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })
})

describe('the recipes lane\'s items in the page search', () => {
  it('a recipe item ({kind, id, name, type_label}) with no onOpen opens recipe detail (?recipe=), search dropped', async () => {
    renderPantry(['/put-up?view=pantry'], { extraSearchItems: [{ kind: 'recipe', id: 'rc-4', name: 'Reaper sauce #4', type_label: 'Hot sauce', keeps: null }] })
    await rowEl('put_up:jar-reaper')
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search the pantry' }), { target: { value: 'sauce #' } })
    const hit = await screen.findByTestId('pantry-search-hit-extra:recipe:rc-4')
    expect(hit.textContent).toBe('Reaper sauce #4 · Hot sauce')
    fireEvent.click(hit)
    await waitFor(() => expect(screen.getByTestId('probe-loc').textContent).toBe('/put-up?view=pantry&recipe=rc-4'))
  })
})

describe('Put something up — one door, routed by the method chip (V4 §2.1, §2.2)', () => {
  async function openDoor() {
    renderPantry()
    await rowEl('put_up:jar-reaper')
    fireEvent.click(screen.getByTestId('putup-door'))
    return screen.findByRole('dialog', { name: 'Put something up' })
  }
  const typeWhat = (v) => fireEvent.change(screen.getByTestId('door-what-name'), { target: { value: v } })

  it('asks three things at open (what · where · how), nothing preselected', async () => {
    const dialog = await openDoor()
    await within(dialog).findByTestId('door-place-id:loc-1')
    const req = [...dialog.querySelectorAll('[aria-required="true"]')]
    expect(req.map(e => e.getAttribute('aria-label') ?? e.getAttribute('data-testid'))).toEqual(['door-what-name', 'Where does it live?', 'How was it put up?'])
    expect(within(dialog).queryAllByRole('radio').filter(r => r.getAttribute('aria-checked') === 'true')).toHaveLength(0)
  })

  it('Save is never disabled: with no method it moves focus to the method row with one line, and writes nothing', async () => {
    await openDoor()
    typeWhat('Frozen peas')
    fireEvent.click(await screen.findByTestId('door-place-id:loc-1'))
    const saveBtn = screen.getByTestId('door-save')
    expect(saveBtn.disabled).toBe(false)
    fireEvent.click(saveBtn)
    expect(screen.getByTestId('door-method-required').textContent).toBe('How was it put up? Pick one — or As is.')
    expect(document.activeElement).toBe(screen.getByTestId('door-method-whole_freeze'))
    expect(posts('/api/preservation')).toHaveLength(0)
    expect(posts('/api/pantry/items')).toHaveLength(0)
  })

  it('a method is a put-up (POST /api/preservation), with the preview and the completion in place', async () => {
    await openDoor()
    typeWhat('Corn')
    fireEvent.click(await screen.findByTestId('door-place-id:loc-1'))
    fireEvent.click(screen.getByTestId('door-method-blanch_freeze'))
    fireEvent.click(screen.getByTestId('door-count-plus'))
    expect(screen.getByTestId('door-preview').textContent).toMatch(/^put up .+ · discard by .+ · general figure: blanch & freeze, deep freezer$/)
    expect(screen.getByTestId('door-save').textContent).toBe('Save · frozen')
    fireEvent.click(screen.getByTestId('door-save'))
    await waitFor(() => expect(posts('/api/preservation')).toHaveLength(1))
    const b = posts('/api/preservation')[0].body
    expect(b).toMatchObject({ label: 'Corn', method: 'blanch_freeze', package_count: 2, storage_location_id: 'loc-1', preserved_at_precision: 'day' })
    expect(posts('/api/pantry/items')).toHaveLength(0)
    const done = await screen.findByTestId('pantry-completion')
    expect(done.textContent).toContain('Corn — put up · Chest Freezer 1')
    fireEvent.click(within(done).getByTestId('pantry-completion-undo'))
    await waitFor(() => expect(fake.calls('DELETE').map(c => c.path)).toEqual(['/api/preservation/jar-new-1']))
  })

  it('As is is a bought item (POST /api/pantry/items), with no count, and a template place goes as {kind,label}', async () => {
    await openDoor()
    typeWhat('Sourdough')
    fireEvent.click(await screen.findByTestId('door-place-new:pantry:pantry shelf'))
    fireEvent.click(screen.getByTestId('door-method-as_is'))
    expect(screen.queryByTestId('door-count-count')).toBeNull()
    expect(screen.getByTestId('door-save').textContent).toBe('Save · as is')
    fireEvent.click(screen.getByTestId('door-save'))
    await waitFor(() => expect(posts('/api/pantry/items')).toHaveLength(1))
    const b = posts('/api/pantry/items')[0].body
    expect(b).toMatchObject({ name: 'Sourdough', place: { kind: 'pantry', label: 'Pantry shelf' }, acquired_precision: 'day' })
    expect(b.idempotency_key).toMatch(/^[0-9a-f-]{36}$/)
    expect(posts('/api/preservation')).toHaveLength(0)
    expect((await screen.findByTestId('pantry-completion')).textContent).toContain('Sourdough — in the pantry · Pantry shelf')
  })

  it('a planting hit reads "Fresh, as picked" and keeps its planting and crop; at a freezer it offers methods only', async () => {
    wire({ lineSearch: { plantings: [{ plant_id: 'p-mj', label: 'Megatron jalapeño', crop_type_slug: 'pepper', variety_id: 'v-mj', recent_picks: [] }], put_ups: [] } })
    await openDoor()
    typeWhat('mega')
    fireEvent.click(await screen.findByTestId('door-what-hit-planting:p-mj', {}, { timeout: 2000 }))
    fireEvent.click(await screen.findByTestId('door-place-id:loc-1'))
    expect(screen.queryByTestId('door-method-as_is')).toBeNull()
    fireEvent.click(screen.getByTestId('door-place-id:loc-3'))
    expect(screen.getByTestId('door-method-as_is').textContent).toBe('Fresh, as picked')
    fireEvent.click(screen.getByTestId('door-method-as_is'))
    fireEvent.click(screen.getByTestId('door-save'))
    await waitFor(() => expect(posts('/api/pantry/items')).toHaveLength(1))
    expect(posts('/api/pantry/items')[0].body).toMatchObject({ name: 'Megatron jalapeño', storage_location_id: 'loc-3', plant_id: 'p-mj', crop_type_slug: 'pepper' })
  })

  it('a refused save keeps everything and its key; the retry sends the same key', async () => {
    let n = 0
    wire({ overrides: { 'POST /api/pantry/items': ({ body }) => { n += 1; if (n === 1) throw apiError(500, { error: 'boom' }); return { item: { id: 'i-9', ...body } } } } })
    await openDoor()
    typeWhat('Tofu')
    fireEvent.click(await screen.findByTestId('door-place-id:loc-3'))
    fireEvent.click(screen.getByTestId('door-method-as_is'))
    fireEvent.click(screen.getByTestId('door-save'))
    expect((await screen.findByTestId('door-error')).textContent).toBe("Couldn't save it — nothing was lost. Try again.")
    expect(screen.getByTestId('door-what-name').value).toBe('Tofu')
    fireEvent.click(screen.getByTestId('door-save'))
    await screen.findByTestId('pantry-completion')
    const keys = fake.calls('POST', '/api/pantry/items').map(c => c.body.idempotency_key)
    expect(keys).toHaveLength(2)
    expect(keys[0]).toBe(keys[1])
  })

  it('the draft survives a close (Back) and its key with it; a landed save leaves nothing to restore', async () => {
    await openDoor()
    typeWhat('Kale')
    fireEvent.click(await screen.findByTestId('door-place-id:loc-3'))
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Put something up' })).toBeNull())
    const stashed = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))
    expect(stashed).toContain('garden:putup-draft:v1:user_dave:putsomethingup:new')
    fireEvent.click(screen.getByTestId('putup-door'))
    await screen.findByRole('dialog', { name: 'Put something up' })
    expect(screen.getByTestId('door-what-name').value).toBe('Kale')
    expect(screen.getByTestId('door-place-id:loc-3').getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByTestId('door-method-as_is'))
    fireEvent.click(screen.getByTestId('door-save'))
    await screen.findByTestId('pantry-completion')
    fireEvent.click(screen.getByTestId('putup-door'))
    await screen.findByRole('dialog', { name: 'Put something up' })
    expect(screen.getByTestId('door-what-name').value).toBe('')
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))
    expect(keys.filter(k => k.includes('putsomethingup'))).toEqual([])
  })

  // The batch-builder lane's seam: useHowItWasMade({ onSaved }) → { open(rowOrJar), sheet }.
  function useFakeHow() {
    const [jar, setJar] = React.useState(null)
    return { open: (r) => setJar(r), sheet: jar ? <div data-testid="how-sheet">{jar.stock_id}</div> : null }
  }
  const HOW = { useHowItWasMade: useFakeHow, canSay: (j) => j.batch_id == null }

  it('How it was made → is offered on a put-up\'s completion, and opens the seam\'s sheet with it', async () => {
    renderPantry(['/put-up?view=pantry'], { howItWasMade: HOW })
    await rowEl('put_up:jar-reaper')
    fireEvent.click(screen.getByTestId('putup-door'))
    fireEvent.change(await screen.findByTestId('door-what-name'), { target: { value: 'Corn' } })
    fireEvent.click(await screen.findByTestId('door-place-id:loc-1'))
    fireEvent.click(screen.getByTestId('door-method-whole_freeze'))
    fireEvent.click(screen.getByTestId('door-save'))
    fireEvent.click(await screen.findByTestId('pantry-completion-how'))
    expect((await screen.findByTestId('how-sheet')).textContent).toBe('jar-new-1')
  })

  it('the row sheet offers it on a batchless put-up only — not on a batch jar, not on a bought item', async () => {
    renderPantry(['/put-up?view=pantry'], { howItWasMade: HOW })
    fireEvent.click(await screen.findByTestId('pantry-row-open-put_up:jar-reaper'))     // batch_id kb-1
    await screen.findByTestId('row-sheet')
    expect(screen.queryByTestId('row-how')).toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('row-sheet')).toBeNull())
    fireEvent.click(screen.getByTestId('pantry-row-open-pantry_item:item-milk'))
    await screen.findByTestId('row-sheet')
    expect(screen.queryByTestId('row-how')).toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('row-sheet')).toBeNull())
    fireEvent.click(screen.getByTestId('pantry-row-open-put_up:jar-last'))
    fireEvent.click(await screen.findByTestId('row-how'))
    expect((await screen.findByTestId('how-sheet')).textContent).toBe('jar-last')
  })

  it('without the seam there is no How it was made → anywhere', async () => {
    renderPantry(['/put-up?view=pantry'], { howItWasMade: null })
    fireEvent.click(await screen.findByTestId('pantry-row-open-put_up:jar-last'))
    await screen.findByTestId('row-sheet')
    expect(screen.queryByTestId('row-how')).toBeNull()
  })
})

describe('the rename bridge (V4 §2.5)', () => {
  it('shows on the first two visits and not the third', async () => {
    for (const expected of [true, true, false]) {
      const v = renderPantry()
      await rowEl('put_up:jar-reaper')
      expect(!!screen.queryByTestId('pantry-bridge')).toBe(expected)
      if (expected) expect(screen.getByTestId('pantry-bridge').textContent).toContain(BRIDGE_TEXT)
      v.unmount()
    }
  })

  it('a dismissal retires it at once and for good, for that viewer only', async () => {
    const v = renderPantry()
    await rowEl('put_up:jar-reaper')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Dismiss — the Pantry note' })) })
    expect(screen.queryByTestId('pantry-bridge')).toBeNull()
    v.unmount()
    const again = renderPantry()
    await rowEl('put_up:jar-reaper')
    expect(screen.queryByTestId('pantry-bridge')).toBeNull()
    again.unmount()
    viewer.id = 'user_jen'
    renderPantry()
    await rowEl('put_up:jar-reaper')
    expect(screen.getByTestId('pantry-bridge')).toBeTruthy()
  })
})
