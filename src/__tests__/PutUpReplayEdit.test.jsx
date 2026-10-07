// BUG-PUTUPREPLAYDROPSEDIT-001 — a keyed create answered `replayed: true` is READ, and what the sheet holds
// is put on the row the first Save made.
// The server keeps a create's key and nothing of its body, and the key does not change with the body (plan
// R2 V2 "Retry key": a second row is worse than a lost change). So a Save whose answer was lost, a change, and
// Save again came back as a success that did not hold the change. The rule lives in
// components/kitchen/idempotencyKey.js (sendPrint, noteSent, afterReplay). This file holds the rule and three
// of the creates that follow it: the recipe sheet, Save as recipe, How it was made. The Put something up
// door and the Walk (the pantry item) are in PutUpReplayEdit.pantry.test.jsx.
//
// FOR EACH CREATE:
//   • a first-time create (not replayed) → no update call;
//   • the same body replayed → no update call, and it is saved;
//   • a changed body replayed → the SAME key, exactly one update call, to the id the replay answered with,
//     carrying the change; what the sheet hands on shows the changed values;
//   • the update fails → a not-saved error, the change still in the form, nothing handed on; Save again works;
//   • never a second create under a new key.
// MUTATIONS (each run, each red here): see the lane report putupreplay2-20261007.
// CI lane: `npm test` plus the TZ re-run. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy, getToken: vi.fn() }), apiFetch: (...a) => fetchSpy(...a) }))
const auth = { user: { id: 'user_dave' } }
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => auth, useAuth: () => auth }))

import { payloadPrint, sendPrint, noteSent, afterReplay } from '../components/kitchen/idempotencyKey.js'
import RecipeSheet, { isRecipeDraft } from '../components/recipes/RecipeSheet.jsx'
import BatchRecipeRow from '../components/recipes/BatchRecipeRow.jsx'
import HowItWasMadeSheet, { REPLAY_NOT_ON_IT } from '../components/putup/HowItWasMadeSheet.jsx'
import { SHEET_DRAFT_PREFIX } from '../components/kitchen/sheetDraft.js'
import { DismissRegistryProvider } from '../context/DismissRegistry.jsx'
import { clearReloadBlocks } from '../lib/reloadGate.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const BANNED = /\b(safe|shelf life|shelf-stable|keeps|good|ready|done|expired|table|default|basis)\b/i
const LOST = () => { throw new TypeError('Failed to fetch') }       // the request may have landed; its answer did not come back
const apiError = (status, body) => Object.assign(new Error(body?.error ?? `HTTP ${status}`), { status, body })

// `routes`: 'METHOD /path' → (body, nth call of that route) => answer. A route that throws is a rejected fetch.
function wire(routes = {}) {
  const seen = {}
  fetchSpy.mockImplementation((path, o = {}) => {
    const id = `${(o.method ?? 'GET').toUpperCase()} ${path}`
    const hit = routes[id]
    if (!hit) return Promise.resolve(null)
    seen[id] = (seen[id] ?? 0) + 1
    try { return Promise.resolve(hit(o.body ? JSON.parse(o.body) : null, seen[id])) } catch (e) { return Promise.reject(e) }
  })
}
const sentTo = (method, path) => fetchSpy.mock.calls.filter(([p, o]) => p === path && (o?.method ?? 'GET') === method).map(([, o]) => JSON.parse(o.body))
const posts = (path) => sentTo('POST', path)
const keys = (path) => posts(path).map(b => b.idempotency_key)
// Every write that is not a POST to `path`: [method, path] pairs.
const otherWrites = (path) => fetchSpy.mock.calls.filter(([p, o]) => o?.method && o.method !== 'GET' && !(p === path && o.method === 'POST')).map(([p, o]) => [o.method, p])
const tap = (id) => fireEvent.click(screen.getByTestId(id))
const type = (id, value) => fireEvent.change(screen.getByTestId(id), { target: { value } })

beforeEach(() => { fetchSpy.mockReset(); wire(); localStorage.clear(); clearReloadBlocks() })
afterEach(() => { cleanup(); clearReloadBlocks() })

describe('the rule — idempotencyKey.js', () => {
  const BODY = { idempotency_key: 'k', name: 'Corn', notes: 'two bags', plant_id: null }
  const FIXED = ['plant_id', 'crop_type_slug']

  it('the print: the same content whatever the key order, without the body\'s own key; any change changes it', () => {
    expect(payloadPrint({ notes: 'two bags', name: 'Corn', plant_id: null, idempotency_key: 'other' })).toBe(payloadPrint(BODY))
    expect(payloadPrint({ ...BODY, notes: 'three bags' })).not.toBe(payloadPrint(BODY))
    expect(payloadPrint(null)).toBe(payloadPrint({}))
  })

  it('a send\'s print has two halves: what the update route can carry, and the named keys it cannot', () => {
    const p = sendPrint(BODY, FIXED)
    expect(p).toMatch(/^[0-9a-z.]+\/[0-9a-z.]+$/)
    const half = (s, i) => s.split('/')[i]
    const noted = sendPrint({ ...BODY, notes: 'three bags' }, FIXED)
    expect([half(noted, 0) === half(p, 0), half(noted, 1) === half(p, 1)]).toEqual([false, true])
    const planted = sendPrint({ ...BODY, plant_id: 'p1' }, FIXED)
    expect([half(planted, 0) === half(p, 0), half(planted, 1) === half(p, 1)]).toEqual([true, false])
    // A fixed key the body leaves out prints as null: absent and null are the same thing to the row.
    const { plant_id: _gone, ...without } = BODY
    expect(sendPrint(without, FIXED)).toBe(p)
    expect(sendPrint(BODY)).toBe(`${payloadPrint(BODY)}/${payloadPrint({})}`)
  })

  it('noteSent keeps each different print once, in the order sent; a stored value that is not a list of strings is nothing sent', () => {
    expect(noteSent(undefined, 'a/x')).toEqual(['a/x'])
    expect(noteSent(['a/x'], 'a/x')).toEqual(['a/x'])
    expect(noteSent(['a/x'], 'b/x')).toEqual(['a/x', 'b/x'])
    expect(noteSent('a/x', 'b/x')).toEqual(['b/x'])
    expect(noteSent(['a/x', 7, null], 'b/x')).toEqual(['a/x', 'b/x'])
  })

  it('afterReplay: null unless the answer says replayed; null when no other body ever went out under the key', () => {
    expect(afterReplay({ id: 1 }, ['a/x', 'b/x'], 'b/x')).toBeNull()
    expect(afterReplay({ id: 1, replayed: false }, ['a/x', 'b/x'], 'b/x')).toBeNull()
    expect(afterReplay(null, ['a/x', 'b/x'], 'b/x')).toBeNull()
    expect(afterReplay({ replayed: true }, ['b/x'], 'b/x')).toBeNull()
    expect(afterReplay({ replayed: true }, [], 'b/x')).toBeNull()              // a key this client has no record for
    expect(afterReplay({ replayed: true }, undefined, 'b/x')).toBeNull()
  })

  it('afterReplay: another body went out → update; one that differs in a fixed part → fixed, whatever else differs', () => {
    expect(afterReplay({ replayed: true }, ['a/x', 'b/x'], 'b/x')).toBe('update')
    expect(afterReplay({ replayed: true }, ['a/x'], 'b/x')).toBe('update')     // the list not yet holding this print
    expect(afterReplay({ replayed: true }, ['b/y', 'b/x'], 'b/x')).toBe('fixed')
    expect(afterReplay({ replayed: true }, ['a/x', 'a/y', 'b/x'], 'b/x')).toBe('fixed')
    // Sent, changed, sent, put back: the row may hold either, so the body in hand goes onto it.
    expect(afterReplay({ replayed: true }, ['a/x', 'b/x'], 'a/x')).toBe('update')
  })
})

describe('the recipe sheet — POST /api/recipes, then PATCH /api/recipes/:id', () => {
  const PATH = '/api/recipes'
  const ROW = '/api/recipes/r-first'
  const draft = () => JSON.parse(localStorage.getItem(`${SHEET_DRAFT_PREFIX}user_dave:recipe:new`))?.data ?? null
  const mount = () => {
    const onSaved = vi.fn()
    render(<RecipeSheet open types={[]} fetch={fetchSpy} onClose={() => {}} onSaved={onSaved} />)
    return { onSaved }
  }
  const save = () => act(async () => { tap('recipe-save') })
  const failed = () => waitFor(() => expect(screen.getByTestId('recipe-sheet-error').textContent).toMatch(/Couldn't save it/))
  // The first POST lands and its answer is lost; every later one is answered with the recipe it made.
  const FIRST = { id: 'r-first', name: 'Mojo', notes: null, lines: [] }
  const lostThenReplayed = (patch = (b) => ({ recipe: { ...FIRST, ...b } })) => wire({
    [`POST ${PATH}`]: (b, n) => (n === 1 ? LOST() : { recipe: FIRST, replayed: true }),
    [`PATCH ${ROW}`]: patch,
  })

  it('a first-time create: one POST, no update call', async () => {
    wire({ [`POST ${PATH}`]: (b) => ({ recipe: { id: 'r-new', name: b.name, lines: [] } }) })
    const { onSaved } = mount()
    type('recipe-name', 'Mojo')
    await save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ id: 'r-new', name: 'Mojo', lines: [] }))
    expect(posts(PATH)).toHaveLength(1)
    expect(otherWrites(PATH)).toEqual([])
  })

  it('a lost answer, Save again untouched, answered replayed: the same key, no update call, saved', async () => {
    lostThenReplayed()
    const { onSaved } = mount()
    type('recipe-name', 'Mojo')
    await save(); await failed()
    await save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(FIRST))
    expect(keys(PATH)).toHaveLength(2)
    expect(keys(PATH)[0]).toMatch(UUID)
    expect(keys(PATH)[1]).toBe(keys(PATH)[0])
    expect(otherWrites(PATH)).toEqual([])
    expect(draft()).toBeNull()
  })

  it('a lost answer, the name and the notes changed, Save: the same key, ONE PATCH to the replayed recipe with the change, and the changed recipe handed on', async () => {
    lostThenReplayed()
    const { onSaved } = mount()
    type('recipe-name', 'Mojo')
    await save(); await failed()
    type('recipe-name', 'Mojo verde'); type('recipe-notes', 'pH 3.4')
    await save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(keys(PATH)).toHaveLength(2)
    expect(keys(PATH)[1]).toBe(keys(PATH)[0])                                  // never a second create under a new key
    expect(posts(PATH).map(b => b.name)).toEqual(['Mojo', 'Mojo verde'])
    expect(otherWrites(PATH)).toEqual([['PATCH', ROW]])
    // The PATCH is the body an edit sends: every field the sheet shows, so a field emptied since is cleared too.
    const [patch] = sentTo('PATCH', ROW)
    expect(patch).toMatchObject({ name: 'Mojo verde', notes: 'pH 3.4', link_url: null, keeps: null, lines: [] })
    expect(patch).not.toHaveProperty('idempotency_key')
    expect(onSaved.mock.calls[0][0]).toMatchObject({ id: 'r-first', name: 'Mojo verde', notes: 'pH 3.4' })
    expect(draft()).toBeNull()
  })

  it('the update fails: not saved is said, the change is still in the form and the draft, nothing is handed on — and Save again finishes it', async () => {
    let fail = true
    lostThenReplayed((b) => { if (fail) throw apiError(503, { error: 'boom' }); return { recipe: { ...FIRST, ...b } } })
    const { onSaved } = mount()
    type('recipe-name', 'Mojo')
    await save(); await failed()
    type('recipe-name', 'Mojo verde')
    await save()
    await waitFor(() => expect(sentTo('PATCH', ROW)).toHaveLength(1))
    await failed()
    expect(screen.getByTestId('recipe-sheet-error').textContent).toBe("Couldn't save it: boom")
    expect(onSaved).not.toHaveBeenCalled()
    expect(screen.getByTestId('recipe-name').value).toBe('Mojo verde')
    expect(draft()).toMatchObject({ name: 'Mojo verde', key: keys(PATH)[0] })
    fail = false
    await save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(new Set(keys(PATH)).size).toBe(1)
    expect(keys(PATH)).toHaveLength(3)
    expect(sentTo('PATCH', ROW).map(b => b.name)).toEqual(['Mojo verde', 'Mojo verde'])
    expect(onSaved.mock.calls[0][0]).toMatchObject({ id: 'r-first', name: 'Mojo verde' })
  })

  it('a PATCH with no answer at all (the connection again): the same not-saved line, what was typed still here', async () => {
    lostThenReplayed(LOST)
    const { onSaved } = mount()
    type('recipe-name', 'Mojo')
    await save(); await failed()
    type('recipe-name', 'Mojo verde')
    await save()
    await waitFor(() => expect(sentTo('PATCH', ROW)).toHaveLength(1))
    expect(screen.getByTestId('recipe-sheet-error').textContent).toBe("Couldn't save it — try again. What you typed is still here.")
    expect(onSaved).not.toHaveBeenCalled()
    expect(screen.getByTestId('recipe-name').value).toBe('Mojo verde')
  })

  it('dismissed and opened again between the lost answer and the retry: what went out rides in the draft, so the change still goes onto the recipe', async () => {
    lostThenReplayed()
    mount()
    type('recipe-name', 'Mojo')
    await save(); await failed()
    const stored = draft()
    expect(stored.sent).toEqual([sendPrint(posts(PATH)[0])])
    expect(isRecipeDraft(stored)).toBe(true)
    cleanup()
    const second = mount()
    expect(screen.getByTestId('recipe-name').value).toBe('Mojo')
    type('recipe-name', 'Mojo verde')
    await save()
    await waitFor(() => expect(second.onSaved).toHaveBeenCalledTimes(1))
    expect(keys(PATH)[1]).toBe(keys(PATH)[0])
    expect(sentTo('PATCH', ROW).map(b => b.name)).toEqual(['Mojo verde'])
  })

  it('a draft that has never been sent has no `sent`; a stored `sent` that is not a list is not a draft', async () => {
    mount()
    type('recipe-name', 'Mojo')
    await waitFor(() => expect(draft()?.key).toMatch(UUID))
    expect(draft()).not.toHaveProperty('sent')
    expect(isRecipeDraft({ ...draft(), sent: 'x' })).toBe(false)
    expect(isRecipeDraft({ ...draft(), sent: ['a/b'] })).toBe(true)
  })

  it('replayed on the only body this key ever went out with (a key sent by an older bundle, or by another tab): no update call', async () => {
    wire({ [`POST ${PATH}`]: () => ({ recipe: FIRST, replayed: true }), [`PATCH ${ROW}`]: (b) => ({ recipe: { ...FIRST, ...b } }) })
    const { onSaved } = mount()
    type('recipe-name', 'Mojo verde')
    await save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(FIRST))
    expect(otherWrites(PATH)).toEqual([])
  })

  it('a changed body that is NOT answered replayed (the first POST never landed): created as sent, no update call', async () => {
    wire({ [`POST ${PATH}`]: (b, n) => (n === 1 ? LOST() : { recipe: { id: 'r-new', name: b.name, lines: [] } }) })
    const { onSaved } = mount()
    type('recipe-name', 'Mojo')
    await save(); await failed()
    type('recipe-name', 'Mojo verde')
    await save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ id: 'r-new', name: 'Mojo verde', lines: [] }))
    expect(keys(PATH)[1]).toBe(keys(PATH)[0])
    expect(otherWrites(PATH)).toEqual([])
  })

  it('an edit of an existing recipe is its PATCH and nothing else, as it was', async () => {
    wire({ 'PATCH /api/recipes/r7': (b) => ({ recipe: { id: 'r7', ...b } }) })
    const onSaved = vi.fn()
    render(<RecipeSheet open recipe={{ id: 'r7', name: 'Mojo', lines: [] }} types={[]} fetch={fetchSpy} onClose={() => {}} onSaved={onSaved} />)
    type('recipe-name', 'Mojo verde')
    await save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(fetchSpy.mock.calls.filter(([, o]) => o?.method).map(([p, o]) => [o.method, p])).toEqual([['PATCH', '/api/recipes/r7']])
  })
})

describe('Save as recipe — POST /api/recipes/from-batch/:id, then PATCH /api/recipes/:id', () => {
  const BATCH = { id: 'kb1', label: 'Settlers of Cayenne', recipe_id: null }
  const PATH = '/api/recipes/from-batch/kb1'
  const ROW = '/api/recipes/r9'
  const FIRST = { id: 'r9', name: 'Settlers of Cayenne' }
  const mount = (batch = BATCH) => render(<BatchRecipeRow batch={batch} inputs={[]} onChanged={() => {}} />)
  const save = () => act(async () => { tap('batch-save-as-recipe-save') })
  const lostThenReplayed = (patch = (b) => ({ recipe: { ...FIRST, ...b } })) => wire({
    [`POST ${PATH}`]: (b, n) => (n === 1 ? LOST() : { recipe: FIRST, replayed: true }),
    [`PATCH ${ROW}`]: patch,
  })
  const failed = () => waitFor(() => expect(screen.getByTestId('batch-save-as-recipe-error').textContent).toMatch(/Couldn't save it as a recipe/))
  const saved = (name) => waitFor(() => expect(screen.getByTestId('batch-save-as-recipe-saved').textContent).toBe(`Saved as a recipe: ${name}`))

  it('a first-time Save: one POST, no update call', async () => {
    wire({ [`POST ${PATH}`]: (b) => ({ recipe: { id: 'r9', name: b.name }, batch_linked: true }) })
    mount()
    tap('batch-save-as-recipe')
    await save(); await saved('Settlers of Cayenne')
    expect(posts(PATH)).toHaveLength(1)
    expect(otherWrites(PATH)).toEqual([])
  })

  it('a lost answer, Save again untouched, answered replayed: the same key, no update call, saved', async () => {
    lostThenReplayed()
    mount()
    tap('batch-save-as-recipe')
    await save(); await failed()
    await save(); await saved('Settlers of Cayenne')
    expect(keys(PATH)).toHaveLength(2)
    expect(keys(PATH)[1]).toBe(keys(PATH)[0])
    expect(otherWrites(PATH)).toEqual([])
  })

  it('a lost answer, the name changed, Save: the same key, ONE PATCH of the name to the replayed recipe, and the new name is the one shown', async () => {
    lostThenReplayed()
    mount()
    tap('batch-save-as-recipe')
    await save(); await failed()
    type('batch-save-as-recipe-name', 'Settlers, the hot one')
    await save(); await saved('Settlers, the hot one')
    expect(keys(PATH)).toHaveLength(2)
    expect(keys(PATH)[1]).toBe(keys(PATH)[0])
    expect(otherWrites(PATH)).toEqual([['PATCH', ROW]])
    expect(sentTo('PATCH', ROW)).toEqual([{ name: 'Settlers, the hot one' }])
  })

  it('the update fails: not saved is said, the field is still open with the new name, nothing reads as saved — and Save again finishes it', async () => {
    let fail = true
    lostThenReplayed((b) => { if (fail) throw apiError(500, { error: 'boom' }); return { recipe: { ...FIRST, ...b } } })
    mount()
    tap('batch-save-as-recipe')
    await save(); await failed()
    type('batch-save-as-recipe-name', 'Settlers, the hot one')
    await save()
    await waitFor(() => expect(sentTo('PATCH', ROW)).toHaveLength(1))
    await failed()
    expect(screen.queryByTestId('batch-save-as-recipe-saved')).toBeNull()
    expect(screen.getByTestId('batch-save-as-recipe-name').value).toBe('Settlers, the hot one')
    fail = false
    await save(); await saved('Settlers, the hot one')
    expect(new Set(keys(PATH)).size).toBe(1)
    expect(sentTo('PATCH', ROW)).toHaveLength(2)
  })

  it('a lost answer, Cancel, opened again and renamed: still the same key, and the name goes onto the recipe', async () => {
    lostThenReplayed()
    mount()
    tap('batch-save-as-recipe')
    await save(); await failed()
    fireEvent.click(screen.getByText('Cancel'))
    tap('batch-save-as-recipe')
    type('batch-save-as-recipe-name', 'Settlers II')
    await save(); await saved('Settlers II')
    expect(keys(PATH)[1]).toBe(keys(PATH)[0])
    expect(sentTo('PATCH', ROW)).toEqual([{ name: 'Settlers II' }])
  })

  it('the key belongs to ONE batch: the row handed another batch sends a new key, and never writes to the first batch\'s recipe', async () => {
    wire({
      [`POST ${PATH}`]: LOST,
      'POST /api/recipes/from-batch/kb2': (b) => ({ recipe: { id: 'r10', name: b.name } }),
      [`PATCH ${ROW}`]: (b) => ({ recipe: { ...FIRST, ...b } }),
    })
    const view = mount()
    tap('batch-save-as-recipe')
    await save(); await failed()
    view.rerender(<BatchRecipeRow batch={{ ...BATCH, id: 'kb2' }} inputs={[]} onChanged={() => {}} />)
    type('batch-save-as-recipe-name', 'Another one')
    await save(); await saved('Another one')
    expect(keys('/api/recipes/from-batch/kb2')[0]).toMatch(UUID)
    expect(keys('/api/recipes/from-batch/kb2')[0]).not.toBe(keys(PATH)[0])
    expect(sentTo('PATCH', ROW)).toEqual([])
  })

  it('a save that lands drops the key: saving again goes out under a new one', async () => {
    wire({ [`POST ${PATH}`]: (b) => ({ recipe: { id: 'r9', name: b.name }, batch_linked: true }) })
    mount()
    tap('batch-save-as-recipe')
    await save(); await saved('Settlers of Cayenne')
    tap('batch-save-as-recipe')
    await save()
    await waitFor(() => expect(posts(PATH)).toHaveLength(2))
    expect(keys(PATH)[1]).not.toBe(keys(PATH)[0])
  })
})

describe('How it was made — POST /api/kitchen-batches/from-jars, then PUT /api/kitchen-batches/:id', () => {
  const PATH = '/api/kitchen-batches/from-jars'
  const ROW = '/api/kitchen-batches/kb-first'
  const JAR = {
    id: 'j-1', label: 'Megatron plain', batch_id: null, harvest_log_id: null, storage_location_id: 'loc-fridge',
    preserved_at: '2026-09-08', preserved_at_precision: 'day', package_count: 2, remaining_count: 2, stock_mode: 'counted', notes: '',
  }
  // What the route answers a replay with: the batch detail (GET /:id's shape) and the flag.
  const FIRST = { id: 'kb-first', label: 'Megatron plain', kind: null, kind_other: null, inputs: [], stages: [{ id: 's1', stage_kind: 'started' }] }
  const mount = (props = {}) => {
    const handlers = { onClose: vi.fn(), onSaved: vi.fn(), ...props }
    render(<DismissRegistryProvider><HowItWasMadeSheet jar={JAR} open {...handlers} /></DismissRegistryProvider>)
    return handlers
  }
  const lostThenReplayed = (put = (b) => ({ id: 'kb-first', label: b.label, kind: b.kind, kind_other: b.kind_other, updated_at: 'later' })) => wire({
    'GET /api/preservation/whats-put-up': () => ({ groups: [{ label: 'Fridge', records: [JAR] }] }),
    [`POST ${PATH}`]: (b, n) => (n === 1 ? LOST() : { ...FIRST, replayed: true }),
    [`PUT ${ROW}`]: put,
  })
  const save = () => act(async () => { tap('how-submit') })
  const failed = () => waitFor(() => expect(screen.getByTestId('how-error').textContent.length).toBeGreaterThan(0))
  const loaded = () => waitFor(() => expect(screen.getByTestId('how-made')).toBeTruthy())

  it('a first-time Save: one POST, no update call, the sheet closes', async () => {
    wire({ [`POST ${PATH}`]: (b) => ({ id: 'kb-new', label: b.label }) })
    const { onClose, onSaved } = mount()
    await save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ id: 'kb-new', label: 'Megatron plain' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(otherWrites(PATH)).toEqual([])
  })

  it('a lost answer, Save again untouched, answered replayed: the same key, no update call, saved and closed', async () => {
    lostThenReplayed()
    const { onClose, onSaved } = mount()
    await loaded()
    await save(); await failed()
    await save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ ...FIRST, replayed: true }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(keys(PATH)).toHaveLength(2)
    expect(keys(PATH)[1]).toBe(keys(PATH)[0])
    expect(otherWrites(PATH)).toEqual([])
  })

  it('a lost answer, the name changed, Save: the same key, ONE PUT of the name and kind to the replayed batch, and the renamed batch handed on', async () => {
    lostThenReplayed()
    const { onClose, onSaved } = mount()
    await loaded()
    await save(); await failed()
    type('how-label', 'Megatron plain, 2026')
    await save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(keys(PATH)).toHaveLength(2)
    expect(keys(PATH)[1]).toBe(keys(PATH)[0])
    expect(otherWrites(PATH)).toEqual([['PUT', ROW]])
    expect(sentTo('PUT', ROW)).toEqual([{ label: 'Megatron plain, 2026', kind: null, kind_other: null }])
    // The detail the replay answered with, the batch's own columns as the PUT answered them.
    expect(onSaved.mock.calls[0][0]).toMatchObject({ id: 'kb-first', label: 'Megatron plain, 2026', stages: FIRST.stages, updated_at: 'later' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('the update fails: not saved is said, the sheet stays open with the new name, nothing is handed on — and Save again finishes it', async () => {
    let fail = true
    lostThenReplayed((b) => { if (fail) throw apiError(500, { error: 'boom' }); return { id: 'kb-first', label: b.label } })
    const { onClose, onSaved } = mount()
    await loaded()
    await save(); await failed()
    type('how-label', 'Megatron plain, 2026')
    await save()
    await waitFor(() => expect(sentTo('PUT', ROW)).toHaveLength(1))
    await waitFor(() => expect(screen.getByTestId('how-error').textContent).toBe('boom'))
    expect([onClose.mock.calls.length, onSaved.mock.calls.length]).toEqual([0, 0])
    expect(screen.getByTestId('how-label').value).toBe('Megatron plain, 2026')
    fail = false
    await save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(new Set(keys(PATH)).size).toBe(1)
    expect(onSaved.mock.calls[0][0]).toMatchObject({ id: 'kb-first', label: 'Megatron plain, 2026' })
  })

  it('a lost answer, How many typed, Save: no route carries that, so NOTHING is written — the sheet stays open and says the batch exists without the change, and the page is told', async () => {
    lostThenReplayed()
    const { onClose, onSaved } = mount()
    await loaded()
    await save(); await failed()
    type('how-made', '6')
    await save()
    await waitFor(() => expect(screen.getByTestId('how-error').textContent).toBe(REPLAY_NOT_ON_IT))
    expect(posts(PATH).map(b => b.made_count ?? null)).toEqual([null, 6])
    expect(keys(PATH)[1]).toBe(keys(PATH)[0])
    expect(otherWrites(PATH)).toEqual([])
    expect(onClose).not.toHaveBeenCalled()
    expect(onSaved).toHaveBeenCalledWith({ ...FIRST, replayed: true })            // the lists behind re-read: the batch is there
    expect(screen.getByTestId('how-made').value).toBe('6')
    expect(screen.getByTestId('how-submit').disabled).toBe(false)
    expect(REPLAY_NOT_ON_IT).not.toMatch(BANNED)
  })

  it('a name AND How many changed: still nothing written (a part that cannot be carried is not half-applied)', async () => {
    lostThenReplayed()
    const { onClose } = mount()
    await loaded()
    await save(); await failed()
    type('how-label', 'Megatron plain, 2026'); type('how-made', '6')
    await save()
    await waitFor(() => expect(screen.getByTestId('how-error').textContent).toBe(REPLAY_NOT_ON_IT))
    expect(otherWrites(PATH)).toEqual([])
    expect(onClose).not.toHaveBeenCalled()
  })
})
