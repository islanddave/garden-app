// V4-RELOADGATEWIRE-001 — the jar's editor (Pantry row → Edit) holds a deploy's reload while it is dirty or
// saving (reloadGate), the way EventNew and LogMany do.
//
// Put-Up R2b: this file was written for the "Log a put-up" form's three-part guard — its sessionStorage
// draft, the Sheet backdrop-tap guard and the reload deferral. The form is gone and those tests with it; the
// Put something up door's guards are in PutUpR2Df.guard.test.jsx. What stays here is the page's other typed
// surface, the jar's editor.
//
// REAL reloadGate (isReloadBlocked/clearReloadBlocks) and REAL registerSW, no spy between them, as
// EventNew.reloadGateWire.test.jsx: a mocked setReloadBlocked would hide exactly the "shipped but never
// wired" blind spot that file exists to catch. Its makeSwEnv + the 'gate is not a disarm' negative control
// are ported in shape, because a gate with no proof it still LETS a clean reload through is a gate that can
// silently become a permanent disarm.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  apiFetch: (...args) => fetchMock(...args),
}))

import PutUp from '../pages/PutUp.jsx'
import { rowFromRecord } from './helpers/pantryFake.js'
import { isReloadBlocked, clearReloadBlocks } from '../lib/reloadGate.js'
import { registerServiceWorker } from '../lib/registerSW.js'

function renderFullPage() {
  return render(<MemoryRouter initialEntries={[{ pathname: '/put-up' }]}><PutUp /></MemoryRouter>)
}

const flush = () => new Promise((r) => setTimeout(r, 0))

// Mirrors registerSW.test.js makeEnv (via EventNew.reloadGateWire.test.jsx), with a prior
// controller so controllerchange counts as an UPDATE (the reload path), not a first install.
function makeSwEnv() {
  const registration = { update: vi.fn().mockResolvedValue(undefined) }
  const sw = new EventTarget()
  sw.controller = {}
  sw.register = vi.fn().mockResolvedValue(registration)
  const nav = { serviceWorker: sw }
  const win = Object.assign(new EventTarget(), { location: { reload: vi.fn() } })
  const doc = Object.assign(new EventTarget(), { readyState: 'complete', visibilityState: 'visible' })
  const reload = vi.fn()
  return { registration, sw, nav, win, doc, reload }
}

beforeEach(() => {
  fetchMock.mockReset()
  sessionStorage.clear()
  clearReloadBlocks()
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Put-Up release 1a (V4 §6.5 "Reload gate") — RecordRow's editor, the other typed surface on this
// page. Before this it held nothing: a deploy landing mid-Edit reloaded the page and the typed values
// went with it (review2 mobile-pwa R2 #6). The REAL reloadGate and, below, the real registerSW, nothing
// mocked between them.
const ROW = {
  id: 'rec-1', crop_type_slug: 'tomato', variety_id: null, plant_id: null, harvest_log_id: null,
  preserved_at: '2026-07-01', method: 'whole_freeze', method_other_text: null,
  quantity_value: 14, quantity_unit: 'bags', package_count: 3, storage_location_id: 'loc-1',
  use_by_target: null, remaining_count: 3, consumed_at: null, notes: null, photo_id: null, use_by_status: null,
  source_kind: 'own_garden', source_label: null,
}
// The two conditional fields each need a row that shows them: 'other' shows the method description,
// and (R2a) a date set by hand opens on "From the label", which shows the date field.
const OTHER_ROW = { ...ROW, method: 'other', method_other_text: 'Vinegar dill pickles' }
const DATED_ROW = { ...ROW, method: 'candy', use_by_target: '2027-01-01', use_by_basis: 'typed' }
// R2a lane E: a row with no planting whose where-from carries a name, so the name field is on screen.
const FARM_ROW = { ...ROW, source_kind: 'farm_stand', source_label: 'Warner Farms' }

// B′ release 2: the editor is reached through the Pantry row's sheet (row → Edit), which reads the full
// jar (GET /api/preservation/:id) before it opens the SAME editor; the list is GET /api/pantry.
function wireRow({ rec = ROW, onPut } = {}) {
  fetchMock.mockImplementation((path, options = {}) => {
    const method = options.method || 'GET'
    // Put-Up release 1b: the editor writes through the PUT (size, count) or the PATCH (name, method,
    // notes, discard-by); both are "the write" these tests hold the gate around.
    if (path.startsWith('/api/preservation/') && (method === 'PUT' || method === 'PATCH')) return onPut ? onPut(path, options) : Promise.resolve({ id: rec.id })
    if (path.startsWith('/api/pantry?')) return Promise.resolve({ rows: [rowFromRecord(rec)] })
    if (path === `/api/preservation/${rec.id}` && method === 'GET') return Promise.resolve(rec)
    if (path === '/api/storage-locations' && method === 'GET') return Promise.resolve([])
    if (path.startsWith('/api/plants')) return Promise.resolve([])
    return Promise.resolve(null)
  })
}
async function openEditorFromRow() {
  fireEvent.click(await screen.findByTestId('pantry-row-open-put_up:rec-1'))
  fireEvent.click(await screen.findByTestId('row-edit'))
  await screen.findByRole('button', { name: 'Save' })
}
async function openRowEditor() {
  const view = renderFullPage()
  await openEditorFromRow()
  return view
}
const typeNotes = (v) => fireEvent.change(screen.getByRole('textbox', { name: 'Notes' }), { target: { value: v } })
const putCount = () => fetchMock.mock.calls.filter(([, o]) => o?.method === 'PUT' || o?.method === 'PATCH').length

describe('the jar editor (Pantry row → Edit) — holds the reload gate while dirty or saving (Put-Up 1a)', () => {
  it('opening the editor holds nothing; an edit holds; putting it back releases', async () => {
    wireRow()
    await openRowEditor()
    expect(isReloadBlocked()).toBe(false)
    typeNotes('two went to Jen')
    expect(isReloadBlocked()).toBe(true)
    typeNotes('')
    expect(isReloadBlocked()).toBe(false)
  })

  // Every field the editor offers, one at a time, each changed and then put back. A field missing
  // from the predicate is a field a deploy can still erase.
  it.each([
    ['How much', ROW, () => screen.getByRole('textbox', { name: 'Quantity' }), '9'],
    ['Unit', ROW, () => screen.getByRole('combobox', { name: 'Unit' }), 'jars'],
    ['How many were put up?', ROW, () => screen.getByRole('spinbutton', { name: 'How many were put up?' }), '2'],
    ['How was it put up?', ROW, () => screen.getByRole('combobox', { name: 'How was it put up?' }), 'dehydrate'],
    ['What method?', OTHER_ROW, () => screen.getByRole('textbox', { name: 'Method description' }), 'Fridge pickles'],
    ['Discard by', DATED_ROW, () => screen.getByLabelText('Discard date from the label'), '2027-02-01'],
    // R2a lane E: a where-from change alone holds the reload gate (its name field; the chips are taps,
    // proven in PutUpR2E.edit.test.jsx).
    ['Made with produce from', FARM_ROW, () => screen.getByRole('textbox', { name: /^Which one\?/ }), 'Kimball Fruit Farm'],
    ['Notes', ROW, () => screen.getByRole('textbox', { name: 'Notes' }), 'two went to Jen'],
  ])('%s', async (_field, rec, control, changed) => {
    wireRow({ rec })
    await openRowEditor()
    const seeded = control().value
    expect(isReloadBlocked()).toBe(false)
    fireEvent.change(control(), { target: { value: changed } })
    expect(isReloadBlocked()).toBe(true)
    fireEvent.change(control(), { target: { value: seeded } })
    expect(isReloadBlocked()).toBe(false)
  })

  // Amended for release 1b (V4 §5.4 "From 1b", §8.3): the editor sends only what changed, so an
  // untouched Save writes NOTHING and closes; the in-flight hold is proven on a save that writes.
  it('an untouched Save writes nothing and closes; a save in flight holds, and releases when it lands', async () => {
    let land
    wireRow({ onPut: () => new Promise(r => { land = () => r({ id: 'rec-1' }) }) })
    await openRowEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save' })).toBeNull())
    expect(putCount()).toBe(0)
    fireEvent.click(screen.getByTestId('row-edit'))
    await screen.findByRole('button', { name: 'Save' })
    typeNotes('two went to Jen')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(putCount()).toBe(1))
    typeNotes('')
    expect(isReloadBlocked()).toBe(true)
    await act(async () => { land() })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save' })).toBeNull())
    expect(isReloadBlocked()).toBe(false)
  })

  it('a refused save keeps the hold, because the edit is still on screen; Cancel releases it', async () => {
    const refusal = Object.assign(new Error('below'), { status: 409, body: { error: 'below', code: 'count_below_used' } })
    wireRow({ onPut: () => Promise.reject(refusal) })
    await openRowEditor()
    typeNotes('two went to Jen')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByRole('alert')
    expect(screen.getByRole('textbox', { name: 'Notes' }).value).toBe('two went to Jen')
    expect(isReloadBlocked()).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(isReloadBlocked()).toBe(false)
  })

  it('unmounting a dirty editor releases the hold (never wedge updates)', async () => {
    wireRow()
    const { unmount } = await openRowEditor()
    typeNotes('two went to Jen')
    expect(isReloadBlocked()).toBe(true)
    unmount()
    expect(isReloadBlocked()).toBe(false)
  })
})

describe('the jar editor (Pantry row → Edit) ↔ registerSW end to end', () => {
  it('an edit in progress DEFERS the SW reload; Cancel lets it fire exactly once', async () => {
    wireRow()
    const env = makeSwEnv()
    const teardown = registerServiceWorker(env)
    await flush()
    await openRowEditor()
    typeNotes('two went to Jen')
    env.sw.dispatchEvent(new Event('controllerchange'))
    expect(env.reload).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(env.reload).toHaveBeenCalledTimes(1)
    teardown()
  })

  // The one-boolean dep, stated as the user would meet its absence: a deploy deferred while he typed
  // must not fire at the instant he taps Save, with the PUT still in the air.
  it('tapping Save on a dirty editor does not let a deferred reload through; the landed save does', async () => {
    let land
    wireRow({ onPut: () => new Promise(r => { land = () => r({ id: 'rec-1' }) }) })
    const env = makeSwEnv()
    const teardown = registerServiceWorker(env)
    await flush()
    await openRowEditor()
    typeNotes('two went to Jen')
    env.sw.dispatchEvent(new Event('controllerchange'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(putCount()).toBe(1))
    expect(env.reload).not.toHaveBeenCalled()
    await act(async () => { land() })
    await waitFor(() => expect(env.reload).toHaveBeenCalledTimes(1))
    teardown()
  })

  it('an untouched editor does not defer a deploy reload (the gate is not a disarm)', async () => {
    wireRow()
    const env = makeSwEnv()
    const teardown = registerServiceWorker(env)
    await flush()
    await openRowEditor()
    env.sw.dispatchEvent(new Event('controllerchange'))
    expect(env.reload).toHaveBeenCalledTimes(1)
    teardown()
  })
})
