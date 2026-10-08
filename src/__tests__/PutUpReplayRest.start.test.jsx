// BUG-PUTUPREPLAYREST-001 — the Start sheet's create, POST /api/kitchen-batches. The rule is
// kitchen/idempotencyKey.js; the precedent on the same PUT is putup/HowItWasMadeSheet.jsx.
//
// Before this, a Start it whose answer was lost, a change, and Start it again came back `replayed: true` with
// the batch the FIRST tap made — and the sheet closed and landed on it as if the change were there.
//   • the name, the kind and the typed recipe reference ride the batch's own merge PUT → ONE PUT onto that
//     batch, when it is this sitting's, and the sheet lands on what the PUT answered;
//   • when it started, the recipe it was started from and its photo ride no route → nothing is written, and
//     the sheet says so;
//   • a batch that is not this sitting's (a restored draft, made a while ago, touched since) → nothing is written;
//   • an untouched retry → nothing is written, started;
//   • a refusal ends the STORED draft (the first tap landed): the sheet opened next is a clean one;
//   • the PUT fails, or lands with its answer lost → said as that, and Start it again finishes it;
//   • NEVER a second batch: one key across every POST.
// The fake's PUT is judged by the Lambda's own validateBatchUpdate. CI lane: `npm test` plus the TZ re-run.
import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const { fetchSpy, uploadSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn(), uploadSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: uploadSpy, isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))
const auth = { user: { id: 'user_dave' } }
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => auth }))

import StartBatchSheet, {
  isStartDraft, START_REPLAY_NOT_ON_IT, START_CHANGE_UNSAVED, START_CHANGE_MAYBE,
} from '../components/kitchen/StartBatchSheet.jsx'
import { validateBatchUpdate } from '../../lambda/preservation/kitchenBatch.js'
import { clearReloadBlocks } from '../lib/reloadGate.js'

const NOW = new Date(2026, 8, 29, 21, 30, 0, 0)          // 2026-09-29 21:30 local
const DRAFT_KEY = 'garden:putup-draft:v1:user_dave:start:new'
const BANNED = /\b(safe|shelf life|shelf-stable|keeps|good|ready|done|expired|table|default|basis)\b/i
const LONG_AGO = 11 * 60 * 1000                          // a minute past REPLAY_FRESH_MS
const RECIPE = { id: '11111111-1111-4111-8111-111111111111', name: 'Fermented hot sauce', kind: 'ferment' }
const GENERIC = "Couldn't start it — try again. What you typed is still here."
const stamps = (madeAgoMs = 30 * 1000, touchedAgoMs = madeAgoMs) => {
  const now = Date.now()
  return { created_at: new Date(now - madeAgoMs).toISOString(), updated_at: new Date(now - touchedAgoMs).toISOString() }
}
const lost = () => Promise.reject(new TypeError('Failed to fetch'))   // it may have landed; its answer did not come back
const apiError = (status, error) => Object.assign(new Error(error), { status, body: { error } })

// The batch a create makes, as the route answers a replay with it (SELECT * over v_kitchen_batch_current).
const rowOf = (body, over = {}) => ({
  id: 'kb-first', user_id: 'user_dave', label: body.label, kind: body.kind ?? null, kind_other: body.kind_other ?? null,
  started_at: body.started_at ?? null, start_precision: body.start_precision ?? null, start_anchor_kind: body.start_anchor_kind ?? null,
  start_anchor_id: null, cover_photo_id: body.cover_photo_id ?? null, recipe_id: body.recipe_id ?? null, recipe_ref: body.recipe_ref ?? null,
  idempotency_key: body.idempotency_key, closed_at: null, deleted_at: null, ...stamps(), ...over,
})

// A table of one batch. The first POST that lands does so with its answer lost (`lands` — the ones before it
// never reached the server); every POST after is answered with the row, replayed. `onPut(n)` may throw (the PUT
// did NOT land) or return 'lost' (it landed, its answer did not come back).
function batchTable({ first = {}, lands = 1, onPut = null, onPost = null } = {}) {
  const state = { row: null, posts: 0, puts: 0 }
  fetchSpy.mockImplementation((path, o = {}) => {
    const method = o.method ?? 'GET'
    const body = o.body ? JSON.parse(o.body) : undefined
    if (path === '/api/recipes') return Promise.resolve({ recipes: [RECIPE] })
    if (path === '/api/kitchen-batches' && method === 'POST') {
      state.posts += 1
      const forced = onPost?.(state.posts, body)
      if (forced !== undefined) return forced
      if (!state.row) {
        if (state.posts < lands) return lost()
        state.row = rowOf(body, first)
        return lost()
      }
      return Promise.resolve({ ...state.row, replayed: true })
    }
    if (/^\/api\/kitchen-batches\/[^/]+$/.test(path) && method === 'PUT') {
      state.puts += 1
      const refused = validateBatchUpdate(body)
      if (refused) return Promise.reject(apiError(400, refused))
      let how
      try { how = onPut?.(state.puts, body) } catch (e) { return Promise.reject(e) }
      state.row = { ...state.row, ...body, updated_at: new Date().toISOString() }
      return how === 'lost' ? lost() : Promise.resolve({ ...state.row })
    }
    return Promise.resolve(null)
  })
  return state
}

const calls = (method, test) => fetchSpy.mock.calls.filter(([p, o]) => (o?.method ?? 'GET') === method && test(p))
const kbPosts = () => calls('POST', p => p === '/api/kitchen-batches')
const keys = () => kbPosts().map(([, o]) => JSON.parse(o.body).idempotency_key)
const puts = () => calls('PUT', () => true).map(([p, o]) => [p, JSON.parse(o.body)])
// Every write that is not the create.
const otherWrites = () => fetchSpy.mock.calls.filter(([p, o]) => (o?.method ?? 'GET') !== 'GET' && !(p === '/api/kitchen-batches' && o.method === 'POST')).map(([p, o]) => [o.method, p])

function Host({ onStarted, onExists }) {
  const [open, setOpen] = useState(true)
  return (
    <>
      <StartBatchSheet open={open} onClose={() => setOpen(false)} onStarted={onStarted} onExists={onExists} now={NOW.getTime()} />
      {!open && <button type="button" onClick={() => setOpen(true)}>reopen</button>}
    </>
  )
}
function open() {
  const handlers = { onStarted: vi.fn(), onExists: vi.fn() }
  const view = render(<Host {...handlers} />)
  return { ...view, ...handlers }
}
const type = (id, value) => fireEvent.change(screen.getByTestId(id), { target: { value } })
const tap = (id) => fireEvent.click(screen.getByTestId(id))
const startIt = async () => { await act(async () => { tap('start-submit') }) }
const errorText = () => screen.queryByTestId('start-error')?.textContent ?? null
const said = (text) => waitFor(() => expect(errorText()).toBe(text))
const stored = () => { const raw = localStorage.getItem(DRAFT_KEY); return raw ? JSON.parse(raw) : null }
function watchScrolls() {
  const on = []
  Element.prototype.scrollIntoView = function scrollIntoView() { on.push(this) }
  return on
}
// The nth create has been answered and the sheet is still.
const answered = async (nth) => {
  await waitFor(() => expect(kbPosts()).toHaveLength(nth))
  await waitFor(() => expect(screen.queryByTestId('start-submit')?.disabled ?? false).toBe(false))
}

beforeEach(() => {
  fetchSpy.mockReset(); uploadSpy.mockReset()
  uploadSpy.mockResolvedValue({ photo: { id: 'photo-1', taken_at: null } })
  localStorage.clear()
  clearReloadBlocks()
  auth.user = { id: 'user_dave' }
  window.history.replaceState({ __floor: 1 }, '')
  global.URL.createObjectURL = vi.fn(() => 'blob:mine')
  global.URL.revokeObjectURL = vi.fn()
})
afterEach(() => { clearReloadBlocks(); delete Element.prototype.scrollIntoView })

describe('the words', () => {
  it('are these, exactly — what is certain, and no banned word', () => {
    expect(START_REPLAY_NOT_ON_IT).toBe('This batch is already started — an earlier tap on Start it went through. This one changed nothing on it. Close this and open the batch to see it.')
    expect(START_CHANGE_UNSAVED).toBe('This batch is already started — an earlier tap on Start it went through. Your last change did not save. Try again, or close this and open the batch.')
    expect(START_CHANGE_MAYBE).toBe('This batch is already started — an earlier tap on Start it went through. Your last change may not have saved. Try again, or close this and check the batch.')
    for (const s of [START_REPLAY_NOT_ON_IT, START_CHANGE_UNSAVED, START_CHANGE_MAYBE]) expect(s).not.toMatch(BANNED)
    // It does not know which tap landed, so it never says the change is missing.
    expect(START_REPLAY_NOT_ON_IT).not.toMatch(/your change is not|is not on it|was lost/i)
  })
  it('a draft carries what went out under its key — optional, so a draft stored before this still restores', () => {
    const base = { label: 'Pepper mash', chip: 'today', earlier: null, pickedDate: '', kind: null, kindOther: '', key: 'k' }
    expect(isStartDraft(base)).toBe(true)
    expect(isStartDraft({ ...base, sent: ['a/b'] })).toBe(true)
    expect(isStartDraft({ ...base, sent: 'a/b' })).toBe(false)
  })
})

describe('Start a batch — a replayed create', () => {
  it('a lost answer, the name, the kind and the recipe reference changed, Start it: ONE batch — the same key, ONE PUT onto it; the batch holds the change and the sheet lands on it', async () => {
    const table = batchTable()
    const sheet = open()
    type('start-label', 'Pepper mash')
    await startIt(); await said(GENERIC)
    type('start-label', 'Pepper mash, red')
    tap('start-kind-toggle'); tap('start-kind-ferment')
    tap('following-recipe-toggle'); type('following-recipe-ref', 'Noma guide, p. 40')
    await startIt()
    await waitFor(() => expect(sheet.onStarted).toHaveBeenCalledTimes(1))
    expect(keys()).toHaveLength(2)
    expect(new Set(keys()).size).toBe(1)                                       // never a create under a new key
    expect(puts()).toEqual([['/api/kitchen-batches/kb-first', { label: 'Pepper mash, red', kind: 'ferment', kind_other: null, recipe_ref: 'Noma guide, p. 40' }]])
    expect(table.row).toMatchObject({ id: 'kb-first', label: 'Pepper mash, red', kind: 'ferment', recipe_ref: 'Noma guide, p. 40' })
    expect(sheet.onStarted.mock.calls[0][0]).toMatchObject({ id: 'kb-first', label: 'Pepper mash, red', kind: 'ferment', recipe_ref: 'Noma guide, p. 40' })
    expect(stored()).toBeNull()
  })

  it('a kind and a reference taken back off: the PUT clears them', async () => {
    const table = batchTable()
    const sheet = open()
    type('start-label', 'Pepper mash')
    tap('start-kind-toggle'); tap('start-kind-other'); type('start-kind-other-text', 'drinking vinegar')
    tap('following-recipe-toggle'); type('following-recipe-ref', 'Noma guide')
    await startIt(); await said(GENERIC)
    expect(table.row).toMatchObject({ kind: 'other', kind_other: 'drinking vinegar', recipe_ref: 'Noma guide' })
    tap('start-kind-ferment'); type('following-recipe-ref', '')
    await startIt()
    await waitFor(() => expect(sheet.onStarted).toHaveBeenCalledTimes(1))
    expect(puts().map(([, b]) => b)).toEqual([{ label: 'Pepper mash', kind: 'ferment', kind_other: null, recipe_ref: null }])
    expect(table.row).toMatchObject({ kind: 'ferment', kind_other: null, recipe_ref: null })
  })

  it('a lost answer, Start it again untouched: ONE batch, nothing written, landed on the server\'s row', async () => {
    const table = batchTable()
    const sheet = open()
    type('start-label', 'Pepper mash')
    await startIt(); await said(GENERIC)
    await startIt()
    await waitFor(() => expect(sheet.onStarted).toHaveBeenCalledTimes(1))
    expect(new Set(keys()).size).toBe(1)
    expect(otherWrites()).toEqual([])
    expect(sheet.onStarted.mock.calls[0][0]).toEqual({ ...table.row, replayed: true })
  })

  it('WHEN IT STARTED changed after a lost answer: NOTHING is written — not the name beside it either; the sheet says so, brings the line into view, tells the page, and the STORED draft ends; Start it again is refused again; the sheet opened next is a clean one', async () => {
    const on = watchScrolls()
    const table = batchTable()
    const sheet = open()
    type('start-label', 'Pepper mash')
    await startIt(); await said(GENERIC)
    await waitFor(() => expect(stored()?.data?.sent).toHaveLength(1))
    const before = { ...table.row }
    tap('start-when-yesterday'); type('start-label', 'Pepper mash, red')
    on.length = 0
    await startIt()
    await answered(2)
    await said(START_REPLAY_NOT_ON_IT)
    expect(screen.getByTestId('start-error').getAttribute('role')).toBe('alert')
    await waitFor(() => expect(on).toContain(screen.getByTestId('start-error')))
    expect(otherWrites()).toEqual([])
    expect(table.row).toEqual(before)                                          // one batch, as the first tap made it
    expect(sheet.onStarted).not.toHaveBeenCalled()
    expect(sheet.onExists).toHaveBeenCalledTimes(1)
    expect(sheet.onExists.mock.calls[0][0]).toMatchObject({ id: 'kb-first' })
    expect(screen.getByTestId('start-label').value).toBe('Pepper mash, red')
    await waitFor(() => expect(stored()).toBeNull())                           // the spent-key rule
    on.length = 0
    await startIt()
    await answered(3)
    expect(errorText()).toBe(START_REPLAY_NOT_ON_IT)                           // refused again
    await waitFor(() => expect(on).toContain(screen.getByTestId('start-error')))
    // Put back, it is still refused in this sheet: two different starts have gone out, and which landed is not known.
    tap('start-when-today')
    await startIt()
    await answered(4)
    expect(errorText()).toBe(START_REPLAY_NOT_ON_IT)
    expect(new Set(keys()).size).toBe(1)
    expect(otherWrites()).toEqual([])
    expect(table.row).toEqual(before)
    expect(stored()).toBeNull()
    sheet.unmount()
    open()
    expect(screen.getByTestId('start-label').value).toBe('')
  })

  it('THE RECIPE IT IS STARTED FROM picked after a lost answer: nothing is written, and the sheet says so', async () => {
    const table = batchTable()
    const sheet = open()
    type('start-label', 'Pepper mash')
    await startIt(); await said(GENERIC)
    const before = { ...table.row }
    tap('start-from-recipe')
    fireEvent.click(await screen.findByTestId('start-from-recipe-row'))
    await startIt()
    await answered(2)
    await said(START_REPLAY_NOT_ON_IT)
    expect(JSON.parse(kbPosts()[1][1].body).recipe_id).toBe(RECIPE.id)
    expect(otherWrites()).toEqual([])
    expect(table.row).toEqual(before)
    expect(sheet.onStarted).not.toHaveBeenCalled()
  })

  it('A PHOTO added after a lost answer: nothing is written, and the sheet says so', async () => {
    const table = batchTable()
    const sheet = open()
    type('start-label', 'Pepper mash')
    await startIt(); await said(GENERIC)
    const before = { ...table.row }
    fireEvent.change(screen.getByTestId('start-photo-input'), { target: { files: [new File(['x'], 'jar.jpg', { type: 'image/jpeg' })] } })
    await startIt()
    await answered(2)
    await said(START_REPLAY_NOT_ON_IT)
    expect(JSON.parse(kbPosts()[1][1].body).cover_photo_id).toBe('photo-1')
    expect(otherWrites()).toEqual([])
    expect(table.row).toEqual(before)
    expect(sheet.onStarted).not.toHaveBeenCalled()
  })

  it('a draft opened again with another name typed over it: NOTHING is written onto the batch the first tap made — refused, the stored draft ended, the key kept', async () => {
    const table = batchTable()
    const first = open()
    type('start-label', 'Pepper mash')
    await startIt(); await said(GENERIC)
    await waitFor(() => expect(stored()?.data?.sent).toHaveLength(1))
    const before = { ...table.row }
    first.unmount()
    const second = open()
    expect(screen.getByTestId('start-label').value).toBe('Pepper mash')
    type('start-label', 'Kraut')
    await startIt()
    await answered(2)
    await said(START_REPLAY_NOT_ON_IT)
    expect(otherWrites()).toEqual([])
    expect(table.row).toEqual(before)
    expect(second.onStarted).not.toHaveBeenCalled()
    expect(new Set(keys()).size).toBe(1)
    await waitFor(() => expect(stored()).toBeNull())
  })

  it.each([
    ['made longer ago than the bound', { ...stamps(LONG_AGO) }],
    ['touched since it was made', { ...stamps(60 * 1000, 5 * 1000) }],
    ['carrying neither stamp', { created_at: undefined, updated_at: undefined }],
  ])('a batch %s, the name changed, Start it: nothing is written, and the sheet says so', async (_name, first) => {
    const table = batchTable({ first })
    const sheet = open()
    type('start-label', 'Pepper mash')
    await startIt(); await said(GENERIC)
    const before = { ...table.row }
    type('start-label', 'Pepper mash, red')
    await startIt()
    await answered(2)
    await said(START_REPLAY_NOT_ON_IT)
    expect(otherWrites()).toEqual([])
    expect(table.row).toEqual(before)
    expect(sheet.onStarted).not.toHaveBeenCalled()
    expect(new Set(keys()).size).toBe(1)
  })

  it('the first body never arrived and the changed one landed with its answer lost: Start it again finds the batch already holding what is on screen — started, nothing written', async () => {
    const table = batchTable({ lands: 2 })
    const sheet = open()
    type('start-label', 'Pepper mash')
    await startIt(); await said(GENERIC)
    type('start-label', 'Pepper mash, red')
    await startIt()
    await answered(2)
    expect(errorText()).toBe(GENERIC)
    expect(table.row.label).toBe('Pepper mash, red')
    await startIt()
    await waitFor(() => expect(sheet.onStarted).toHaveBeenCalledTimes(1))
    expect(otherWrites()).toEqual([])
    expect(new Set(keys()).size).toBe(1)
    expect(sheet.onStarted.mock.calls[0][0]).toMatchObject({ id: 'kb-first', label: 'Pepper mash, red' })
  })

  it('the PUT fails (a 5xx): the sheet says the batch IS started and the change did not save, tells the page, keeps the form, the key and the draft — and Start it again finishes it on the one batch', async () => {
    const on = watchScrolls()
    let fail = true
    const table = batchTable({ onPut: () => { if (fail) throw apiError(503, 'boom') } })
    const sheet = open()
    type('start-label', 'Pepper mash')
    await startIt(); await said(GENERIC)
    type('start-label', 'Pepper mash, red')
    on.length = 0
    await startIt()
    await said(START_CHANGE_UNSAVED)
    await waitFor(() => expect(on).toContain(screen.getByTestId('start-error')))
    expect(sheet.onExists).toHaveBeenCalledTimes(1)
    expect(sheet.onStarted).not.toHaveBeenCalled()
    expect(table.row.label).toBe('Pepper mash')
    expect(stored().data).toMatchObject({ label: 'Pepper mash, red', key: keys()[0] })
    fail = false
    await startIt()
    await waitFor(() => expect(sheet.onStarted).toHaveBeenCalledTimes(1))
    expect(new Set(keys()).size).toBe(1)
    expect(keys()).toHaveLength(3)
    expect(puts().map(([, b]) => b.label)).toEqual(['Pepper mash, red', 'Pepper mash, red'])
    expect(table.row.label).toBe('Pepper mash, red')
  })

  // A PUT that was ANSWERED with a 4xx did not land: a stamp that has moved since is somebody else's.
  it('the PUT is refused with a 4xx and the batch is changed by someone else meanwhile: Start it again writes NOTHING over their change — refused', async () => {
    const table = batchTable({ onPut: () => {
      table.row = { ...table.row, label: 'Pepper mash (Jen)', updated_at: new Date().toISOString() }
      throw apiError(409, 'Take the salt line out first.')
    } })
    const sheet = open()
    type('start-label', 'Pepper mash')
    await startIt(); await said(GENERIC)
    type('start-label', 'Pepper mash, red')
    await startIt()
    await said(START_CHANGE_UNSAVED)
    await startIt()
    await answered(3)
    await said(START_REPLAY_NOT_ON_IT)
    expect(puts()).toHaveLength(1)                                             // no second PUT
    expect(table.row.label).toBe('Pepper mash (Jen)')
    expect(sheet.onStarted).not.toHaveBeenCalled()
    expect(new Set(keys()).size).toBe(1)
  })

  it('the PUT LANDED and only its answer was lost: the sheet says the change MAY not have saved; a FURTHER change, Start it: it still goes onto that batch (the moved stamp is this sheet\'s own)', async () => {
    const table = batchTable({ onPut: (n) => (n === 1 ? 'lost' : undefined) })
    const sheet = open()
    type('start-label', 'Pepper mash')
    await startIt(); await said(GENERIC)
    type('start-label', 'Pepper mash, red')
    await startIt()
    await said(START_CHANGE_MAYBE)
    expect(table.row.updated_at).not.toBe(table.row.created_at)
    type('start-label', 'Pepper mash, red and hot')
    await startIt()
    await waitFor(() => expect(sheet.onStarted).toHaveBeenCalledTimes(1))
    expect(new Set(keys()).size).toBe(1)
    expect(puts().map(([, b]) => b.label)).toEqual(['Pepper mash, red', 'Pepper mash, red and hot'])
    expect(sheet.onStarted.mock.calls[0][0]).toMatchObject({ label: 'Pepper mash, red and hot' })
  })

  it('… and untouched after that lost answer: the batch already holds it — started, with no second PUT', async () => {
    batchTable({ onPut: (n) => (n === 1 ? 'lost' : undefined) })
    const sheet = open()
    type('start-label', 'Pepper mash')
    await startIt(); await said(GENERIC)
    type('start-label', 'Pepper mash, red')
    await startIt()
    await said(START_CHANGE_MAYBE)
    await startIt()
    await waitFor(() => expect(sheet.onStarted).toHaveBeenCalledTimes(1))
    expect(puts()).toHaveLength(1)
    expect(new Set(keys()).size).toBe(1)
  })

  // An ANSWERED 4xx wrote nothing, so that body is not one that may have landed — and its start, which the
  // server never took, does not make every later Start it look like a change of start.
  it('a lost answer, then a changed start the server refuses with a 4xx; the start put back and the name changed, Start it: the key is kept, and the name goes onto the one batch', async () => {
    const table = batchTable({ onPost: (n) => (n === 2 ? Promise.reject(apiError(400, 'start_anchor_kind must be one of: memory')) : undefined) })
    const sheet = open()
    type('start-label', 'Pepper mash')
    await startIt(); await said(GENERIC)
    tap('start-when-yesterday')
    await startIt()
    await answered(2)
    expect(errorText()).toBe(GENERIC)
    await waitFor(() => expect(stored()?.data?.sent).toHaveLength(1))          // the refused body is not kept as one that went out
    tap('start-when-today'); type('start-label', 'Pepper mash, red')
    await startIt()
    await waitFor(() => expect(sheet.onStarted).toHaveBeenCalledTimes(1))
    expect(new Set(keys()).size).toBe(1)
    expect(keys()).toHaveLength(3)
    expect(puts().map(([, b]) => b.label)).toEqual(['Pepper mash, red'])
    expect(table.row.label).toBe('Pepper mash, red')
  })

  it('a double tap on Start it sends one request', async () => {
    batchTable()
    open()
    type('start-label', 'Pepper mash')
    await act(async () => { tap('start-submit'); tap('start-submit') })
    await said(GENERIC)
    expect(kbPosts()).toHaveLength(1)
  })
})
