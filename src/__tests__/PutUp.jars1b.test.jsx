// Put-Up release 1b on the put-up list (V4 §7 1b: "jars show their name, no-size form and date words
// everywhere"; §5.4 "From 1b": the editor stops echoing place/date/method/notes through the legacy
// PUT; §2.5 Move it). Each assertion names the mutation that reds it. CI LANE: `npm test` + TZ re-run.
//
// AMENDED for B′ release 2 (V4 §2.5, §10.1; brief §8.3 "characterization tests amended in the same
// commit"): the list is the Pantry (GET /api/pantry rows, the pinned contract) and a jar's Edit / Move
// are reached through its row sheet. The editor, the move sheet and the use route are the SAME code, so
// every wire literal below is unchanged; what moved is how the test reaches them. Removed with the
// retired RecordRow: the headline's size / date words (the Pantry row says name · place · what's left ·
// discard chip — the row contract carries no size or put-up date) and the "used-up bag" arm (the server
// no longer lists a used-up jar).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  apiFetch: (...args) => fetchMock(...args),
}))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: vi.fn(), isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))
vi.mock('../hooks/useCropTypes.js', () => ({ useCropTypes: () => ({ cropTypes: [], loading: false }) }))

import PutUp from '../pages/PutUp.jsx'
import { rowFromRecord } from './helpers/pantryFake.js'

// A 1b-shaped jar: a name, a container and no size, an estimated put-up date, a stored basis.
const JAR_1B = {
  id: 'rec-1b', crop_type_slug: null, variety_id: null, plant_id: null, harvest_log_id: null,
  preserved_at: '2026-08-01', preserved_at_precision: 'month', preserved_at_approx: true, method: 'hot_sauce',
  method_other_text: null, quantity_value: null, quantity_unit: null, container_label: '8 oz woozy', package_count: 2,
  storage_location_id: 'loc-fridge', use_by_target: '2027-02-01', use_by_basis: 'table', storage_kind: 'fridge',
  remaining_count: 2, consumed_at: null, notes: null, photo_id: null, use_by_status: 'ok', label: 'Megatron reaper',
  source_kind: null, source_label: null,
}
const PLACES = [{ id: 'loc-fridge', label: 'Fridge', kind: 'fridge' }, { id: 'loc-cf1', label: 'Chest Freezer 1', kind: 'deep_freezer' }]

const FRIDGE = { id: 'loc-fridge', label: 'Fridge', kind: 'fridge' }
function wire(rec = JAR_1B) {
  fetchMock.mockImplementation((path, options = {}) => {
    const method = options.method || 'GET'
    if (path === '/api/storage-locations' && method === 'GET') return Promise.resolve(PLACES)
    if (path.startsWith('/api/plants')) return Promise.resolve([])
    if (path.startsWith('/api/kitchen-batches')) return Promise.resolve({ batches: [] })
    if (path.startsWith('/api/pantry?')) return Promise.resolve({ rows: [rowFromRecord(rec, FRIDGE)] })
    if (path === `/api/preservation/${rec.id}` && method === 'GET') return Promise.resolve(rec)
    if (path.startsWith('/api/preservation/')) return Promise.resolve({ id: rec.id })
    if (path === '/api/pantry/uses') return Promise.resolve({ use: { id: 'u' }, jar: { remaining_count: 1 } })
    return Promise.resolve(null)
  })
}
const writes = () => fetchMock.mock.calls.filter(([p, o]) => p.startsWith('/api/preservation/') && o?.method && o.method !== 'GET')
  .map(([p, o]) => [o.method, p, JSON.parse(o.body)])
const rowOpen = (id = 'rec-1b') => screen.findByTestId(`pantry-row-open-put_up:${id}`)
async function renderList() {
  render(<MemoryRouter initialEntries={['/put-up?view=pantry']}><PutUp /></MemoryRouter>)
  await rowOpen()
}

beforeEach(() => {
  fetchMock.mockReset()
  wire()
  sessionStorage.clear(); localStorage.clear()
})

describe('the Pantry row says its name, its place, what is left and its discard words', () => {
  it('leads with the name, never "null"', async () => {
    await renderList()
    const row = await rowOpen()
    expect(row.textContent).toContain('Megatron reaper')
    // AMENDED (Put-Up UX pass R1, F22): grouped By place the row sits under its place's heading and does
    // not repeat it — the place is said once, by the heading; what is left is the row's.
    expect(screen.getByRole('heading', { name: 'Fridge' })).toBeTruthy()
    expect(row.textContent).toContain('Megatron reaper' + '2 left')
    expect(document.body.textContent).not.toMatch(/\bnull\b|undefined|NaN/)
  })

  // MUTATION: drop the basis words from the chip -> the literal loses "general figure" and reds.
  it('says the discard-by in the §3.2 words', async () => {
    await renderList()
    expect(document.body.textContent).toContain('discard by Feb 1, 2027 · general figure: hot sauce, fridge')
    expect(document.body.textContent).not.toContain('use by')
  })
})

// Contract-F A3 — the zucchini, pinned: 2afee2e3 is 2.5 qt IN TOTAL across 3 containers (Dave). The
// Pantry row does not carry the size; the editor still asks for the total.
describe('A3: the zucchini reads as a total', () => {
  const ZUCCHINI = { ...JAR_1B, id: 'rec-zuke', label: null, container_label: null, quantity_value: 2.5, quantity_unit: 'qt',
    package_count: 3, remaining_count: 3, method: 'whole_freeze', preserved_at_precision: null, use_by_basis: null,
    preserved_at: '2026-08-10', preserved_at_approx: null, use_by_target: null }
  it('the editor asks for the total', async () => {
    wire(ZUCCHINI)
    render(<MemoryRouter initialEntries={['/put-up?view=pantry']}><PutUp /></MemoryRouter>)
    fireEvent.click(await rowOpen('rec-zuke'))
    fireEvent.click(await screen.findByTestId('row-edit'))
    expect(await screen.findByText('How much in all')).toBeTruthy()
  })
})

describe('the row editor writes each field to its one writer (V4 §5.4 "From 1b")', () => {
  const openEditor = async () => {
    await renderList()
    fireEvent.click(await rowOpen())
    fireEvent.click(await screen.findByTestId('row-edit'))
    await screen.findByRole('button', { name: 'Save' })
  }
  it('a no-size jar opens on a blank unit, not "lbs"', async () => {
    await openEditor()
    expect(screen.getByRole('combobox', { name: 'Unit' }).value).toBe('')
  })

  // MUTATION: send the method through the PUT -> the PUT arm appears and this literal reds.
  it('a method, name or notes change is a PATCH carrying only what changed', async () => {
    await openEditor()
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Reaper, hot' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'How was it put up?' }), { target: { value: 'ferment' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Notes' }), { target: { value: 'the good one' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()).toEqual([['PATCH', '/api/preservation/rec-1b', { label: 'Reaper, hot', method: 'ferment', notes: 'the good one' }]])
  })

  // The size is the PATCH's, as a pair (train §6; jarRoutes.js JAR_PATCH_KEYS). MUTATION: send it
  // through the PUT again -> a PUT appears and this literal reds.
  it('a size change is a PATCH carrying the quantity pair, and nothing rides the PUT', async () => {
    await openEditor()
    fireEvent.change(screen.getByRole('textbox', { name: 'Quantity' }), { target: { value: '16' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Unit' }), { target: { value: 'oz' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()).toEqual([['PATCH', '/api/preservation/rec-1b', { quantity_value: '16', quantity_unit: 'oz' }]])
  })

  // The PATCH refuses method_other_text without method (validateJarPatch). MUTATION: send it alone ->
  // the literal loses `method` and reds.
  it('editing only the "other" description re-sends the method it describes', async () => {
    wire({ ...JAR_1B, method: 'other', method_other_text: 'Salt-cured' })
    await openEditor()
    fireEvent.change(screen.getByRole('textbox', { name: 'Method description' }), { target: { value: 'Salt-cured, dried' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0][2]).toEqual({ method: 'other', method_other_text: 'Salt-cured, dried' })
  })

  // Release F: the count rides the PATCH too (the ferment Lambda's delta rule), so an Edit is ONE
  // write. MUTATION: split the count back onto the PUT -> a PUT appears and this literal reds.
  it('a count change and a method change are ONE PATCH, and no PUT', async () => {
    await openEditor()
    fireEvent.change(screen.getByRole('spinbutton', { name: 'How many were put up?' }), { target: { value: '3' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'How was it put up?' }), { target: { value: 'ferment' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()).toEqual([['PATCH', '/api/preservation/rec-1b', { package_count: 3, method: 'ferment' }]])
  })
})

describe('Move it (V4 §2.5, §3.4)', () => {
  // MUTATION: send the move through the legacy PUT's storage_location_id -> the literal reds.
  it('requires a place, defaults When to Today, and posts the move route', async () => {
    await renderList()
    fireEvent.click(await rowOpen())
    fireEvent.click(await screen.findByTestId('row-move'))
    await screen.findByTestId('move-place-id:loc-cf1')
    expect(screen.queryByTestId('move-place-id:loc-fridge')).toBeNull()        // where it already is
    // Put-Up UX pass R1: Move it is a panel inside the row sheet; the same one-item list is read there.
    expect(screen.getByTestId('row-sheet').contains(screen.getByTestId('move-panel'))).toBe(true)
    const req = [...screen.getByTestId('move-panel').querySelectorAll('[aria-required="true"]')]
    expect(req.map(e => e.getAttribute('aria-label'))).toEqual(['Where is Megatron reaper going?'])
    await act(async () => { fireEvent.click(screen.getByTestId('move-save')) })
    expect(screen.getByTestId('move-error').textContent).toBe('Where is it going? Pick a place.')
    fireEvent.click(screen.getByTestId('move-place-id:loc-cf1'))
    await act(async () => { fireEvent.click(screen.getByTestId('move-save')) })
    await waitFor(() => expect(writes()).toHaveLength(1))
    const [method, path, body] = writes()[0]
    expect([method, path]).toEqual(['POST', '/api/preservation/rec-1b/move'])
    expect(body.place).toEqual({ id: 'loc-cf1' })
    expect(body.when.precision).toBe('day')
    await waitFor(() => expect(screen.queryByTestId('move-panel')).toBeNull())
    expect(screen.queryByTestId('row-sheet')).toBeNull()                       // the row sheet closes with the move
  })
})

// Release F (06 §1.3, §1.4; contract-F §2.6) — the jar row's uses and its grams.
describe('Used one / Used it up are uses on their own route', () => {
  const uses = () => fetchMock.mock.calls.filter(([p, o]) => p === '/api/pantry/uses' && o?.method === 'POST')
    .map(([, o]) => JSON.parse(o.body))
  const ONE_LEFT = { ...JAR_1B, remaining_count: 1 }

  // MUTATION: drop the synchronous ref -> two uses post.
  it('a double tap on Used it up posts one use of everything that is left', async () => {
    let settle
    wire(ONE_LEFT)
    const base = fetchMock.getMockImplementation()
    fetchMock.mockImplementation((path, options = {}) => (path === '/api/pantry/uses' ? new Promise(r => { settle = r }) : base(path, options)))
    await renderList()
    const btn = await screen.findByRole('button', { name: 'Used it up — Megatron reaper' })
    act(() => { fireEvent.click(btn); fireEvent.click(btn) })
    expect(uses()).toHaveLength(1)
    expect({ ...uses()[0], idempotency_key: 'K' }).toEqual({ idempotency_key: 'K', preservation_log_id: 'rec-1b', all_remaining: true })
    await act(async () => { settle({ use: {}, jar: {} }) })
  })

  it('each tap mints its own key', async () => {
    wire({ ...JAR_1B, remaining_count: 5 })
    await renderList()
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Used one — Megatron reaper' })) })
    await waitFor(() => expect(uses()).toHaveLength(1))
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Used one — Megatron reaper' })) })
    await waitFor(() => expect(uses()).toHaveLength(2))
    expect(uses()[0].idempotency_key).not.toBe(uses()[1].idempotency_key)
  })

  it('a refused use says how many are left, in the server\'s words, and writes nothing else', async () => {
    wire()
    const base = fetchMock.getMockImplementation()
    fetchMock.mockImplementation((path, options = {}) => (path === '/api/pantry/uses'
      ? Promise.reject(Object.assign(new Error('409'), { status: 409, body: { code: 'only_n_left', n: 0, error: 'None are left in that one.' } }))
      : base(path, options)))
    await renderList()
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Used one — Megatron reaper' })) })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('None are left — nothing was changed.'))
    expect(writes()).toEqual([])
  })
})

describe('weighed stock says its grams (06 §1.4, boss F2)', () => {
  const BAG = { ...JAR_1B, id: 'rec-1b', label: 'Reaper, frozen', container_label: 'bag', quantity_value: '100', quantity_unit: 'g',
    package_count: 1, remaining_count: 1, stock_mode: 'weighed', remaining_amount: '92.000', method: 'whole_freeze' }
  // MUTATION: drop the weighed arm of leftWords -> the counted words show and this reds.
  it('shows "about 92 g left" on a weighed bag (from grams_left), and not on a counted jar', async () => {
    wire(BAG)
    await renderList()
    expect(document.body.textContent).toContain('about 92 g left')
    cleanup()
    wire({ ...BAG, stock_mode: 'counted' })
    await renderList()
    expect(document.body.textContent).not.toContain('g left')
  })
})
