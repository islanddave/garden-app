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
  isStartDraft, START_REPLAY_NOT_ON_IT, START_CHANGE_UNSAVED, START_CHANGE_MAYBE, startRefusalText, startUnsavedText,
} from '../components/kitchen/StartBatchSheet.jsx'
import { validateBatchUpdate } from '../../lambda/preservation/kitchenBatch.js'
import { clearReloadBlocks } from '../lib/reloadGate.js'

const NOW = new Date(2026, 8, 29, 21, 30, 0, 0)          // 2026-09-29 21:30 local
const DRAFT_KEY = 'garden:putup-draft:v1:user_dave:start:new'
const BANNED = /\b(safe|shelf life|shelf-stable|keeps|good|ready|done|expired|table|default|basis)\b/i
const LONG_AGO = 11 * 60 * 1000                          // a minute past REPLAY_FRESH_MS
const RECIPE = { id: '11111111-1111-4111-8111-111111111111', name: 'Fermented hot sauce', kind: 'ferment' }
const GENERIC = "Couldn't start it — try again. What you typed is still here."
// QA I-3: a recipe that names its process jar (Make this), and a past batch with two lines to copy.
const JAR_RECIPE = { id: '22222222-2222-4222-8222-222222222222', name: 'Roll for Initiative', kind: 'ferment', vessel_label: 'Half-gallon jar', vessel_size: '2', vessel_unit: 'qt', vessel_count: 1 }
const JAR_DRAFT_KEY = `garden:putup-draft:v1:user_dave:start:recipe-${JAR_RECIPE.id}`
const PAST = [{ id: 'kb-past', label: 'Megatron mash 2025', kind: 'ferment', closed_at: '2025-10-01T12:00:00.000Z' }]
const PAST_DETAIL = { id: 'kb-past', label: 'Megatron mash 2025', kind: 'ferment', inputs: [
  { id: 'l1', input_kind: 'other', label: 'Megatron jalapeño', qty: '170', qty_unit: 'g', ordinal: 1, put_up_stage_id: null },
  { id: 'l2', input_kind: 'other', label: 'Salt', qty: '12', qty_unit: 'g', role: 'salt', ordinal: 2, put_up_stage_id: null },
] }
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
function batchTable({ first = {}, lands = 1, onPut = null, onPost = null, onLines = null } = {}) {
  const state = { row: null, posts: 0, puts: 0, lines: [] }
  fetchSpy.mockImplementation((path, o = {}) => {
    const method = o.method ?? 'GET'
    const body = o.body ? JSON.parse(o.body) : undefined
    if (path === '/api/recipes') return Promise.resolve({ recipes: [RECIPE] })
    if (path === '/api/kitchen-batches?state=all') return Promise.resolve({ state: 'all', batches: PAST })
    if (path === '/api/kitchen-batches/kb-past' && method === 'GET') return Promise.resolve(PAST_DETAIL)
    // POST /:id/inputs, the keyed form (lambda/preservation/lineRoutes.js addKeyedLines): a key already on this
    // batch is a replay — nothing is added twice.
    if (/^\/api\/kitchen-batches\/[^/]+\/inputs$/.test(path) && method === 'POST') {
      let how
      try { how = onLines?.(body) } catch (e) { return Promise.reject(e) }
      const fresh = body.inputs.filter(l => !state.lines.some(x => x.idempotency_key === l.idempotency_key))
      state.lines.push(...fresh)
      return how === 'lost' ? lost() : Promise.resolve(fresh.length ? { inserted: fresh.length, inputs: fresh } : { replayed: true, inputs: body.inputs })
    }
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

function Host({ onStarted, onExists, ...rest }) {
  const [open, setOpen] = useState(true)
  return (
    <>
      <StartBatchSheet open={open} onClose={() => setOpen(false)} onStarted={onStarted} onExists={onExists} now={NOW.getTime()} {...rest} />
      {!open && <button type="button" onClick={() => setOpen(true)}>reopen</button>}
    </>
  )
}
function open(props = {}) {
  const handlers = { onStarted: vi.fn(), onExists: vi.fn() }
  const view = render(<Host {...handlers} {...props} />)
  return { ...view, ...handlers }
}
const linePosts = () => calls('POST', p => /\/inputs$/.test(p)).map(([p, o]) => [p, JSON.parse(o.body)])
const pickPast = async () => {
  if (!screen.queryByTestId('start-like-batch-kb-past')) tap('start-from-batch')
  const chip = await screen.findByTestId('start-like-batch-kb-past')
  await act(async () => { fireEvent.click(chip) })
  await screen.findByTestId('start-like-picked')
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
    expect(START_REPLAY_NOT_ON_IT).toBe('This batch is already started — an earlier tap on “Start it” went through. This tap changed nothing on it. Close this and open the batch to see it.')
    expect(START_CHANGE_UNSAVED).toBe('This batch is already started — an earlier tap on “Start it” went through. Your last change did not save. Try again, or close this and open the batch.')
    expect(START_CHANGE_MAYBE).toBe('This batch is already started — an earlier tap on “Start it” went through. Your last change may not have saved. Try again, or close this and check the batch.')
    for (const s of [START_REPLAY_NOT_ON_IT, START_CHANGE_UNSAVED, START_CHANGE_MAYBE]) expect(s).not.toMatch(BANNED)
    // It does not know which tap landed, so it never says the change is missing.
    expect(START_REPLAY_NOT_ON_IT).not.toMatch(/your change is not|is not on it|was lost/i)
  })
  it('QA I-3 — a refused start says what became of the lines copied in and the recipe\'s jar: added by this tap, not added, or not known — in these words', () => {
    const HEAD = 'This batch is already started — an earlier tap on “Start it” went through.'
    const all = [
      [startRefusalText(), START_REPLAY_NOT_ON_IT],
      [startRefusalText({ lines: null, jar: null }), START_REPLAY_NOT_ON_IT],
      [startRefusalText({ jar: 'added' }), `${HEAD} This tap added the recipe's jar and nothing else. Close this and open the batch to see it.`],
      [startRefusalText({ lines: 'added' }), `${HEAD} This tap added what was copied in from the past batch and nothing else. Close this and open the batch to see it.`],
      [startRefusalText({ lines: 'added', jar: 'added' }), `${HEAD} This tap added what was copied in from the past batch and the recipe's jar and nothing else. Close this and open the batch to see it.`],
      [startRefusalText({ jar: 'not' }), `${HEAD} This tap changed nothing on it. The recipe's jar was not added. Close this and open the batch to add it.`],
      [startRefusalText({ lines: 'not', jar: 'not' }), `${HEAD} This tap changed nothing on it. What was copied in from the past batch and the recipe's jar were not added. Close this and open the batch to add them.`],
      [startRefusalText({ lines: 'added', jar: 'not' }), `${HEAD} This tap added what was copied in from the past batch and nothing else. The recipe's jar was not added. Close this and open the batch to add it.`],
      // An answer that never came back: it may be on the batch, so nothing says this tap changed nothing.
      [startRefusalText({ lines: 'maybe' }), `${HEAD} What was copied in from the past batch may not have been added. Close this and open the batch to check.`],
      [startUnsavedText(), START_CHANGE_UNSAVED],
      [startUnsavedText({ lost: true }), START_CHANGE_MAYBE],
      [startUnsavedText({ lines: 'not', jar: 'not' }), `${HEAD} Your last change did not save, and what was copied in from the past batch and the recipe's jar were not added. Try again, or close this and open the batch.`],
      [startUnsavedText({ lost: true, jar: 'not' }), `${HEAD} Your last change may not have saved, and the recipe's jar was not added. Try again, or close this and check the batch.`],
    ]
    for (const [said, words] of all) { expect(said).toBe(words); expect(said).not.toMatch(BANNED) }
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
    ['stamped two minutes later than this phone\'s clock', { ...stamps(-2 * 60 * 1000) }],
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

  // QA I-2 (the sequence the review ran as ST2). A PUT whose answer was lost may never have reached the server.
  // Someone else then renames the batch: its stamp has moved — by THEM, and the batch does not hold what the PUT sent.
  it('QA I-2 — the PUT never reached the server and the batch is renamed by someone else meanwhile: Start it again writes NOTHING over their name — refused', async () => {
    const table = batchTable({ onPut: () => {
      table.row = { ...table.row, label: 'Jen’s mash', updated_at: new Date().toISOString() }
      throw new TypeError('Failed to fetch')                                    // it did not land
    } })
    const sheet = open()
    type('start-label', 'Pepper mash')
    await startIt(); await said(GENERIC)
    type('start-label', 'Pepper mash, red')
    await startIt()
    await said(START_CHANGE_MAYBE)
    expect(table.row.label).toBe('Jen’s mash')
    await startIt()
    await answered(3)
    await said(START_REPLAY_NOT_ON_IT)
    expect(puts()).toHaveLength(1)                                             // no second PUT
    expect(table.row.label).toBe('Jen’s mash')
    expect(sheet.onStarted).not.toHaveBeenCalled()
    expect(new Set(keys()).size).toBe(1)
    await waitFor(() => expect(stored()).toBeNull())                           // the refusal ends the stored draft
  })

  it('QA I-2 — the PUT LANDED with its answer lost, and someone else then changes the kind it sent: a further change is NOT written over theirs', async () => {
    const table = batchTable({ onPut: (n) => (n === 1 ? 'lost' : undefined) })
    const sheet = open()
    type('start-label', 'Pepper mash')
    await startIt(); await said(GENERIC)
    type('start-label', 'Pepper mash, red')
    await startIt()
    await said(START_CHANGE_MAYBE)
    table.row = { ...table.row, kind: 'ferment', updated_at: new Date().toISOString() }
    type('start-label', 'Pepper mash, red and hot')
    await startIt()
    await answered(3)
    await said(START_REPLAY_NOT_ON_IT)
    expect(puts()).toHaveLength(1)
    expect(table.row).toMatchObject({ label: 'Pepper mash, red', kind: 'ferment' })
    expect(sheet.onStarted).not.toHaveBeenCalled()
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

  // QA I-3. A start is followed by two more writes — the lines copied from a past batch, the recipe's jar — and
  // they are SEPARATE requests, sent only once the create has been answered (the create itself writes the batch
  // and its started row in one statement, nothing else). So a tap whose answer was lost never sent them, and a
  // refusal that returns before them leaves the batch without what the start that went through was made with.
  const JAR_PUT = ['/api/kitchen-batches/kb-first', { vessel_label: 'Half-gallon jar', vessel_size: '2', vessel_unit: 'qt', vessel_count: 1 }]
  it('QA I-3 (ST1) — made from a recipe that names its jar; the first tap lands with its answer lost, the start is changed, Start it: REFUSED — and the recipe\'s jar is put on the batch (it belongs to the start that went through); the sentence says what this tap did. Tapped again: refused again, the jar not sent twice', async () => {
    const table = batchTable()
    const sheet = open({ recipe: JAR_RECIPE })
    await startIt(); await said(GENERIC)
    tap('start-when-yesterday')
    await startIt()
    await answered(2)
    await said(startRefusalText({ jar: 'added' }))
    expect(puts()).toEqual([JAR_PUT])
    expect(table.row).toMatchObject({ label: 'Roll for Initiative', recipe_id: JAR_RECIPE.id, vessel_label: 'Half-gallon jar' })
    expect(table.row.started_at).not.toBeNull()
    expect(sheet.onStarted).not.toHaveBeenCalled()
    expect(sheet.onExists).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(localStorage.getItem(JAR_DRAFT_KEY)).toBeNull())
    await startIt()
    await answered(3)
    await said(START_REPLAY_NOT_ON_IT)                                         // nothing left to add: this tap changed nothing
    expect(puts()).toEqual([JAR_PUT])
    expect(new Set(keys()).size).toBe(1)
  })

  it('QA I-3 — the jar goes by what the BATCH says it was started from, never by the form: a batch that went through with no recipe on it gets no jar, and nothing is said of one', async () => {
    const table = batchTable({ first: { recipe_id: null } })
    open({ recipe: JAR_RECIPE })
    await startIt(); await said(GENERIC)
    tap('start-when-yesterday')
    await startIt()
    await answered(2)
    await said(START_REPLAY_NOT_ON_IT)
    expect(puts()).toEqual([])
    expect(table.row.vessel_label ?? null).toBeNull()
  })

  it('QA I-3 — copied from a past batch; the first tap lands lost, the start is changed, Start it: REFUSED — the copied lines (keyed, and never sent by the tap that went through) are added, as the first tap described them, and the sentence says so', async () => {
    const table = batchTable()
    open()
    await pickPast()
    await startIt(); await said(GENERIC)
    expect(linePosts()).toHaveLength(0)                                        // the lost tap never got as far as its lines
    tap('start-when-yesterday')
    await startIt()
    await answered(2)
    await said(startRefusalText({ lines: 'added' }))
    expect(linePosts()).toHaveLength(1)
    expect(linePosts()[0][0]).toBe('/api/kitchen-batches/kb-first/inputs')
    expect(linePosts()[0][1].inputs.map(l => l.label)).toEqual(['Megatron jalapeño', 'Salt'])
    expect(linePosts()[0][1].inputs.every(l => typeof l.idempotency_key === 'string' && l.idempotency_key.length > 0)).toBe(true)
    expect(table.lines).toHaveLength(2)
    await startIt()
    await answered(3)
    await said(START_REPLAY_NOT_ON_IT)
    expect(linePosts()).toHaveLength(1)                                        // not sent twice
    expect(table.lines).toHaveLength(2)
  })

  it('QA I-3 — the copy changed between the taps (another pick is on the form): which one the start that went through had is not known — NO lines are sent, and the sentence says they were not added', async () => {
    const table = batchTable()
    open()
    await pickPast()
    await startIt(); await said(GENERIC)
    tap('start-like-clear')
    await pickPast()                                                            // the same batch, picked again: new line keys — another pick
    tap('start-when-yesterday')
    await startIt()
    await answered(2)
    await said(startRefusalText({ lines: 'not' }))
    expect(linePosts()).toHaveLength(0)
    expect(table.lines).toHaveLength(0)
  })

  // Delta F-4. What follows a start is this sheet's to add whatever the batch's age — the lines are keyed and the
  // jar goes only onto a batch with none — while the batch's OWN fields keep the ten-minute bound.
  it('QA I-3, delta F-4 — this sheet\'s own batch, made a while ago, with the name changed: the NAME is not written onto it (the age bound stands for the batch\'s own fields) — and the lines and the jar the start that went through was made with are added, once, and the sentence says so', async () => {
    const table = batchTable({ first: { ...stamps(LONG_AGO) } })
    const sheet = open({ recipe: JAR_RECIPE })
    await pickPast()
    await startIt(); await said(GENERIC)
    type('start-label', 'Roll for Initiative, again')
    await startIt()
    await answered(2)
    await said(startRefusalText({ lines: 'added', jar: 'added' }))
    expect(puts()).toEqual([JAR_PUT])
    expect(table.lines).toHaveLength(2)
    expect(table.row).toMatchObject({ label: 'Roll for Initiative', vessel_label: 'Half-gallon jar' })
    expect(sheet.onStarted).not.toHaveBeenCalled()
    await startIt()
    await answered(3)
    await said(START_REPLAY_NOT_ON_IT)
    expect(puts()).toEqual([JAR_PUT])
    expect(linePosts()).toHaveLength(1)
    expect(new Set(keys()).size).toBe(1)
  })

  it('delta F-4 (C5) — Make this with a past batch copied in, Start it lands with its answer lost; ELEVEN MINUTES pass; Start it again from the SAME sheet, untouched: the copied lines and the recipe\'s jar are added, once each, and it lands', async () => {
    const table = batchTable({ first: { ...stamps(LONG_AGO) } })
    const sheet = open({ recipe: JAR_RECIPE })
    await pickPast()
    await startIt(); await said(GENERIC)
    expect(otherWrites()).toEqual([])
    await startIt()
    await waitFor(() => expect(sheet.onStarted).toHaveBeenCalledTimes(1))
    expect(errorText()).toBeNull()
    expect(puts()).toEqual([JAR_PUT])
    expect(linePosts()).toHaveLength(1)
    expect(linePosts()[0][1].inputs.map(l => l.label)).toEqual(['Megatron jalapeño', 'Salt'])
    expect(table.lines).toHaveLength(2)
    expect(table.row).toMatchObject({ label: 'Roll for Initiative', vessel_label: 'Half-gallon jar', vessel_count: 1 })
    expect(new Set(keys()).size).toBe(1)
  })

  it('delta F-4 — … but TOUCHED by someone else meanwhile (no jar set): neither the lines nor the jar is sent, at any age, and the sentence says both were left off', async () => {
    const table = batchTable({ first: { ...stamps(LONG_AGO) } })
    const sheet = open({ recipe: JAR_RECIPE })
    await pickPast()
    await startIt(); await said(GENERIC)
    table.row = { ...table.row, cover_photo_id: 'photo-jen', updated_at: new Date().toISOString() }
    await startIt()
    await answered(2)
    await said(startRefusalText({ lines: 'not', jar: 'not' }))
    expect(otherWrites()).toEqual([])
    expect(sheet.onStarted).not.toHaveBeenCalled()
  })

  it('delta F-4 — a RESTORED Make this draft (not this sitting\'s) whose batch holds no jar, minutes old and untouched: still nothing is sent, and the sentence says the jar was not added', async () => {
    const table = batchTable()
    const first = open({ recipe: JAR_RECIPE })
    await startIt(); await said(GENERIC)
    await waitFor(() => expect(JSON.parse(localStorage.getItem(JAR_DRAFT_KEY))?.data?.sent).toHaveLength(1))
    first.unmount()
    const before = { ...table.row }
    const second = open({ recipe: JAR_RECIPE })
    await startIt()
    await answered(2)
    await said(startRefusalText({ jar: 'not' }))
    expect(otherWrites()).toEqual([])
    expect(table.row).toEqual(before)
    expect(second.onStarted).not.toHaveBeenCalled()
  })

  it('QA I-3 — the lines\' answer is lost: the sentence says they MAY not have been added, and the next tap sends them again under their keys — added once', async () => {
    let n = 0
    const table = batchTable({ onLines: () => (++n === 1 ? 'lost' : undefined) })
    open()
    await pickPast()
    await startIt(); await said(GENERIC)
    tap('start-when-yesterday')
    await startIt()
    await answered(2)
    await said(startRefusalText({ lines: 'maybe' }))
    await startIt()
    await answered(3)
    await said(startRefusalText({ lines: 'added' }))
    expect(linePosts()).toHaveLength(2)
    expect(table.lines).toHaveLength(2)
  })

  it('QA I-3 — the PUT of a changed name fails: the lines and the jar that would have followed it were not sent, and the sentence says so beside "did not save"', async () => {
    batchTable({ onPut: () => { throw apiError(503, 'boom') } })
    open({ recipe: JAR_RECIPE })
    await pickPast()
    await startIt(); await said(GENERIC)
    type('start-label', 'Roll for Initiative, hot')
    await startIt()
    await said(startUnsavedText({ lines: 'not', jar: 'not' }))
    expect(linePosts()).toHaveLength(0)
    expect(puts()).toHaveLength(1)                                             // the one that failed
  })

  // Re-review I-C (the reviewer's S6; live before this work). A replay the rule reads as "saved as sent" — ONE body
  // under the key, or a batch that already holds the form — went on to send the copied lines and the recipe's jar
  // from the form with no check that the batch is this sitting's. Now it has the check the refused path has.
  const HIS_JAR = { vessel_label: 'Quart jar', vessel_size: '1', vessel_unit: 'qt', vessel_count: 2 }
  const jarDraft = () => { const raw = localStorage.getItem(JAR_DRAFT_KEY); return raw ? JSON.parse(raw) : null }
  it('re-review I-C (S6) — Make this lands with its answer lost and the sheet is closed; the cook sets ANOTHER jar on that batch; Make this again most of a day later (the stored draft comes back), Start it: the recipe\'s jar is NOT put over his — nothing is written, and nothing is said of the recipe\'s jar (delta F-3: the batch holds one he chose): it lands on the batch, and the stored draft is ended', async () => {
    const table = batchTable()
    const first = open({ recipe: JAR_RECIPE })
    await startIt(); await said(GENERIC)
    await waitFor(() => expect(jarDraft()?.data?.sent).toHaveLength(1))
    first.unmount()
    table.row = { ...table.row, ...HIS_JAR, ...stamps(20 * 60 * 60 * 1000, 19 * 60 * 60 * 1000) }
    const before = { ...table.row }
    const second = open({ recipe: JAR_RECIPE })
    expect(screen.getByTestId('start-label').value).toBe('Roll for Initiative')  // it looks like a fresh Make this
    await startIt()
    await waitFor(() => expect(second.onStarted).toHaveBeenCalledTimes(1))
    expect(second.onStarted.mock.calls[0][0]).toMatchObject({ id: 'kb-first', ...HIS_JAR })
    expect(errorText()).toBeNull()
    expect(otherWrites()).toEqual([])
    expect(table.row).toEqual(before)
    expect(new Set(keys()).size).toBe(1)
    await waitFor(() => expect(jarDraft()).toBeNull())
  })

  it('re-review I-C — the same sheet, minutes later, but the batch was TOUCHED by someone else meanwhile (they set a jar): one body under the key, so nothing to refuse on the form — and still the recipe\'s jar is not put over theirs, nor said to be missing (delta F-3): it lands', async () => {
    const table = batchTable()
    const sheet = open({ recipe: JAR_RECIPE })
    await startIt(); await said(GENERIC)
    table.row = { ...table.row, ...HIS_JAR, updated_at: new Date().toISOString() }
    const before = { ...table.row }
    await startIt()
    await waitFor(() => expect(sheet.onStarted).toHaveBeenCalledTimes(1))
    expect(errorText()).toBeNull()
    expect(otherWrites()).toEqual([])
    expect(table.row).toEqual(before)
  })

  it('re-review I-C — a restored draft with a past batch picked over it: the copied lines are NOT added to a batch that is not this sitting\'s, and the sheet says so', async () => {
    const table = batchTable()
    const first = open()
    type('start-label', 'Pepper mash')
    tap('start-kind-toggle'); tap('start-kind-ferment')
    await startIt(); await said(GENERIC)
    await waitFor(() => expect(stored()?.data?.sent).toHaveLength(1))
    first.unmount()
    const second = open()
    await pickPast()                                                            // fills nothing (the name and the kind are there): the form is the body that went out
    await startIt()
    await answered(2)
    await said(startRefusalText({ lines: 'not' }))
    expect(linePosts()).toHaveLength(0)
    expect(table.lines).toHaveLength(0)
    expect(puts()).toEqual([])
    expect(second.onStarted).not.toHaveBeenCalled()
  })

  it('re-review I-C — the ordinary retry is unchanged: Make this, the answer lost, Start it again from the SAME sheet — this sitting\'s batch, untouched: it lands, with the recipe\'s jar on it', async () => {
    const table = batchTable()
    const sheet = open({ recipe: JAR_RECIPE })
    await startIt(); await said(GENERIC)
    await startIt()
    await waitFor(() => expect(sheet.onStarted).toHaveBeenCalledTimes(1))
    expect(puts()).toEqual([JAR_PUT])
    expect(table.row).toMatchObject({ vessel_label: 'Half-gallon jar', vessel_count: 1 })
    expect(new Set(keys()).size).toBe(1)
  })

  it('re-review I-C — and a first-time Make this (no replay at all) puts the recipe\'s jar on, as it always has', async () => {
    fetchSpy.mockImplementation((path, o = {}) => {
      if (path === '/api/kitchen-batches' && o.method === 'POST') return Promise.resolve(rowOf(JSON.parse(o.body)))
      if (o.method === 'PUT') return Promise.resolve({ ...JSON.parse(o.body) })
      return Promise.resolve(null)
    })
    const sheet = open({ recipe: JAR_RECIPE })
    await startIt()
    await waitFor(() => expect(sheet.onStarted).toHaveBeenCalledTimes(1))
    expect(puts()).toEqual([JAR_PUT])
  })

  it('re-review I-C — a restored draft with NOTHING to follow (a plain start), Start it untouched: it lands on the batch as before — nothing written, nothing to say', async () => {
    const table = batchTable()
    const first = open()
    type('start-label', 'Pepper mash')
    await startIt(); await said(GENERIC)
    await waitFor(() => expect(stored()?.data?.sent).toHaveLength(1))
    first.unmount()
    table.row = { ...table.row, ...stamps(20 * 60 * 60 * 1000, 19 * 60 * 60 * 1000) }
    const second = open()
    await startIt()
    await waitFor(() => expect(second.onStarted).toHaveBeenCalledTimes(1))
    expect(otherWrites()).toEqual([])
    expect(second.onStarted.mock.calls[0][0]).toMatchObject({ id: 'kb-first', replayed: true })
  })

  it('re-review I-C — a restored Make this draft whose batch ALREADY holds the recipe\'s jar: nothing to send and nothing to say — it lands', async () => {
    const table = batchTable()
    const first = open({ recipe: JAR_RECIPE })
    await startIt(); await said(GENERIC)
    await waitFor(() => expect(jarDraft()?.data?.sent).toHaveLength(1))
    first.unmount()
    table.row = { ...table.row, ...JAR_PUT[1], ...stamps(20 * 60 * 60 * 1000, 19 * 60 * 60 * 1000) }
    const second = open({ recipe: JAR_RECIPE })
    await startIt()
    await waitFor(() => expect(second.onStarted).toHaveBeenCalledTimes(1))
    expect(otherWrites()).toEqual([])
  })

  // Delta F-3 (the reviewer's C1, C2). "This sheet's own PUT" vouches for the four fields that PUT sends, not for
  // the jar: with that PUT landed and its answer lost, a jar somebody set meanwhile was read as this sitting's
  // batch and the recipe's jar was PUT over it. The recipe's jar now goes only onto a batch that holds no jar.
  const ownPutLandsLost = async (props = { recipe: JAR_RECIPE }) => {
    const sheet = open(props)
    await startIt(); await said(GENERIC)
    type('start-label', 'Roll for Initiative, hot')
    await startIt()
    await said(startUnsavedText({ lost: true, jar: 'not' }))
    return sheet
  }
  it('delta F-3 (C1) — Make this lands lost; the name changed, its PUT lands lost; someone sets ANOTHER jar on the batch; Start it: the recipe\'s jar is NOT put over theirs — no jar PUT, the batch as they left it, and the sheet lands', async () => {
    const table = batchTable({ onPut: (n) => (n === 1 ? 'lost' : undefined) })
    const sheet = await ownPutLandsLost()
    table.row = { ...table.row, ...HIS_JAR, updated_at: new Date().toISOString() }
    const before = { ...table.row }
    await startIt()
    await waitFor(() => expect(sheet.onStarted).toHaveBeenCalledTimes(1))
    expect(puts().map(([, b]) => b)).toEqual([{ label: 'Roll for Initiative, hot', kind: 'ferment', kind_other: null, recipe_ref: null }])
    expect(table.row).toEqual(before)
    expect(new Set(keys()).size).toBe(1)
  })

  it('delta F-3 (C2) — … and with the name changed again before that tap (the update path): the name goes on, the jar they set is intact, no jar PUT', async () => {
    const table = batchTable({ onPut: (n) => (n === 1 ? 'lost' : undefined) })
    const sheet = await ownPutLandsLost()
    table.row = { ...table.row, ...HIS_JAR, updated_at: new Date().toISOString() }
    type('start-label', 'Roll for Initiative, hotter')
    await startIt()
    await waitFor(() => expect(sheet.onStarted).toHaveBeenCalledTimes(1))
    expect(puts().map(([, b]) => Object.keys(b).some(k => k.startsWith('vessel_')))).toEqual([false, false])
    expect(table.row).toMatchObject({ label: 'Roll for Initiative, hotter', ...HIS_JAR })
  })

  it('delta F-3 — … and when that second PUT fails, nothing is said of the recipe\'s jar: the batch holds a jar somebody chose', async () => {
    const table = batchTable({ onPut: (n) => { if (n === 2) throw apiError(503, 'boom'); return n === 1 ? 'lost' : undefined } })
    const sheet = await ownPutLandsLost()
    table.row = { ...table.row, ...HIS_JAR, updated_at: new Date().toISOString() }
    type('start-label', 'Roll for Initiative, hotter')
    await startIt()
    await said(START_CHANGE_UNSAVED)
    expect(table.row).toMatchObject(HIS_JAR)
    expect(sheet.onStarted).not.toHaveBeenCalled()
  })

  it('delta F-3 — … and on the refused path (the start changed): this sitting\'s batch, but it holds their jar — no jar PUT, and the plain line', async () => {
    const table = batchTable({ onPut: (n) => (n === 1 ? 'lost' : undefined) })
    const sheet = await ownPutLandsLost()
    table.row = { ...table.row, ...HIS_JAR, updated_at: new Date().toISOString() }
    const before = { ...table.row }
    tap('start-when-yesterday')
    await startIt()
    await answered(3)
    await said(START_REPLAY_NOT_ON_IT)
    expect(puts()).toHaveLength(1)
    expect(table.row).toEqual(before)
    expect(sheet.onStarted).not.toHaveBeenCalled()
  })

  it('delta F-3 (C4) — nobody else: after the lost PUT, Start it puts the recipe\'s jar on, once, and lands', async () => {
    const table = batchTable({ onPut: (n) => (n === 1 ? 'lost' : undefined) })
    const sheet = await ownPutLandsLost()
    await startIt()
    await waitFor(() => expect(sheet.onStarted).toHaveBeenCalledTimes(1))
    expect(puts().slice(1)).toEqual([JAR_PUT])
    expect(table.row).toMatchObject({ label: 'Roll for Initiative, hot', vessel_label: 'Half-gallon jar' })
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
