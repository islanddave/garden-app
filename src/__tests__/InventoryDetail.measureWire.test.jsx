// The saved-lot measure on the WIRE: the wide PUT never carries it, even when the list row does.
//
// Drives the REAL useInventory, like InventoryDetail.seedPut.test.jsx and for its reason: updateItem
// does not send the page's changes as they are — it merges `{ ...currentListRow, ...changes }` whenever
// the lot is in its own /api/inventory-items list, and the list row is `i.*`, measure columns included.
// Until 2026-09-25 that merge put the list row's seed_count / seed_weight_g / seed_count_estimated into
// every save from this page (inert only because the handler's SET list names none of them). Now that
// the page also writes a new count through PUT /seed-measure, the merged value is STALE by construction
// — the count as it stood when the list loaded, re-sent beside the new one — so the hook strips them.
// A mocked updateItem cannot see any of this; that is why this file exists beside the page suite.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, renderHook } from '@testing-library/react'

const { fetchSpy, navigateSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn(), navigateSpy: vi.fn() }))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useParams: () => ({ id: 'inv-lot-1' }),
  useNavigate: () => navigateSpy,
}))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <span /> }))
vi.mock('../components/PhotoUpload.jsx', () => ({ default: () => <span data-testid="photo-upload" /> }))
vi.mock('../components/forms/PlantingSelect.jsx', () => ({ default: () => <span data-testid="planting-select" /> }))

import InventoryDetail from '../pages/InventoryDetail.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import { useInventory } from '../hooks/useInventory.js'
import { CHANGED_ELSEWHERE } from '../components/seed/SavedFromCard.jsx'
import { measureChangedRefusal } from './fixtures/seedMix.fixture.js'

// A saved lot as GET /:id and the list both return it — the list row is the same `i.*`.
const LOT = {
  id: 'inv-lot-1', name: 'Thai Dragon — saved 2026', type: 'consumable', category: 'seeds', status: 'active',
  quantity_on_hand: '1.000', unit: 'packet', notes: null, source: null, source_url: null,
  source_id: null, acquired_from_source_id: null, year_harvested: 2026,
  variety_id: 'var-thai', variety_name: 'Thai Dragon', seed_stage: 'stored', seed_process: 'fresh',
  source_plant_id: 'pl-thai', source_kind: null,
  seed_count: 175, seed_count_estimated: false, seed_weight_g: '3.200',
}
const MEASURE_KEYS = ['seed_count', 'seed_count_estimated', 'seed_weight_g']

function wire() {
  fetchSpy.mockImplementation((path, opts) => {
    if (path === '/api/inventory-items/inv-lot-1' && !opts) return Promise.resolve({ ...LOT })
    if (path === '/api/inventory-items' && !opts) return Promise.resolve([{ ...LOT }])
    if (path === '/api/inventory-items/inv-lot-1' && opts?.method === 'PUT') {
      return Promise.resolve({ ...LOT, ...JSON.parse(opts.body) })
    }
    if (path === '/api/inventory-items/inv-lot-1/seed-measure' && opts?.method === 'PUT') {
      return Promise.resolve({ id: 'inv-lot-1', seed_count: 180, seed_count_estimated: false, seed_weight_g: '3.200' })
    }
    return Promise.resolve([])
  })
}

const writes = () => fetchSpy.mock.calls.filter(([, o]) => o?.method === 'PUT')
  .map(([p, o]) => ({ path: String(p), body: JSON.parse(o.body) }))
const widePuts = () => writes().filter(w => w.path === '/api/inventory-items/inv-lot-1')
const measurePuts = () => writes().filter(w => w.path === '/api/inventory-items/inv-lot-1/seed-measure')

beforeEach(() => { fetchSpy.mockReset(); navigateSpy.mockReset(); wire() })

describe('the wide PUT from /inventory/:id never carries the seed measure', () => {
  it('re-count + rename: the count goes to /seed-measure, the wide PUT carries the rename and none of the three', async () => {
    await act(async () => { render(<ToastProvider><InventoryDetail /></ToastProvider>) })
    await waitFor(() => expect(screen.getByLabelText('Name')).toBeTruthy())
    // The list has landed, so updateItem WILL merge the list row — the case that carried them.
    await waitFor(() => expect(fetchSpy.mock.calls.some(([p]) => p === '/api/inventory-items')).toBe(true))

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Thai Dragon — tin 2' } })
    fireEvent.change(screen.getByTestId('inv-seed-count'), { target: { value: '180' } })
    await act(async () => { fireEvent.click(screen.getByText('Save changes')) })
    await waitFor(() => expect(measurePuts()).toHaveLength(1))

    const [wide] = widePuts()
    expect(widePuts()).toHaveLength(1)
    // Positive: the merge still happened (unit comes only from the list row) and the edit travelled.
    // variety_id was the witness until release 2a; a seeds row no longer echoes it (useInventory).
    expect(wide.body.unit).toBe(LOT.unit)
    expect(wide.body).not.toHaveProperty('variety_id')
    expect(wide.body.name).toBe('Thai Dragon — tin 2')
    for (const k of MEASURE_KEYS) expect(Object.prototype.hasOwnProperty.call(wide.body, k), `wide PUT carried ${k}`).toBe(false)
    // V5-SEEDLOTADDITION-001 — and what this page loaded rides with it: the count, its basis, and the
    // weight as a NUMBER (the row arrives with the string '3.200', which the route would refuse).
    expect(measurePuts()[0].body).toEqual({
      seed_count: 180, seed_count_estimated: false,
      expected_seed_count: 175, expected_seed_count_estimated: false, expected_seed_weight_g: 3.2,
    })
    // The wide PUT first, the measure after it.
    const order = writes().map(w => w.path)
    expect(order).toEqual(['/api/inventory-items/inv-lot-1', '/api/inventory-items/inv-lot-1/seed-measure'])
  })

  it('a later save that touches only the name sends no measure and still carries none of the three', async () => {
    await act(async () => { render(<ToastProvider><InventoryDetail /></ToastProvider>) })
    await waitFor(() => expect(screen.getByLabelText('Name')).toBeTruthy())
    fireEvent.change(screen.getByTestId('inv-seed-count'), { target: { value: '180' } })
    await act(async () => { fireEvent.click(screen.getByText('Save changes')) })
    await waitFor(() => expect(measurePuts()).toHaveLength(1))

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Thai Dragon — tin 3' } })
    await act(async () => { fireEvent.click(screen.getByText('Save changes')) })
    await waitFor(() => expect(widePuts()).toHaveLength(2))
    expect(measurePuts()).toHaveLength(1)
    for (const w of widePuts()) {
      for (const k of MEASURE_KEYS) expect(Object.prototype.hasOwnProperty.call(w.body, k), `wide PUT carried ${k}`).toBe(false)
    }
  })
})

describe('useInventory.updateItem — the merge keeps the row, drops the measure', () => {
  it('merges the list row (variety_id) but never its seed_count / seed_weight_g / seed_count_estimated', async () => {
    fetchSpy.mockReset()
    fetchSpy.mockResolvedValueOnce([{ ...LOT }])
    const { result } = renderHook(() => useInventory())
    await waitFor(() => expect(result.current.loading).toBe(false))
    fetchSpy.mockResolvedValueOnce({ ...LOT, name: 'X' })
    // Even a caller that NAMES them does not get them onto the wide PUT.
    await act(async () => { await result.current.updateItem('inv-lot-1', { name: 'X', seed_count: 1 }) })
    const body = JSON.parse(fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1][1].body)
    expect(body.name).toBe('X')
    expect(body.unit).toBe(LOT.unit)
    expect(body).not.toHaveProperty('variety_id')
    for (const k of MEASURE_KEYS) expect(Object.prototype.hasOwnProperty.call(body, k), `wide PUT carried ${k}`).toBe(false)
  })

  it('does not mutate the caller\'s payload when there is no list row to merge', async () => {
    fetchSpy.mockReset()
    fetchSpy.mockResolvedValueOnce([])
    const { result } = renderHook(() => useInventory())
    await waitFor(() => expect(result.current.loading).toBe(false))
    fetchSpy.mockResolvedValueOnce({ ...LOT })
    const payload = { name: 'Y', type: 'consumable', seed_weight_g: 2 }
    await act(async () => { await result.current.updateItem('inv-lot-1', payload) })
    const body = JSON.parse(fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1][1].body)
    expect(body).toEqual({ name: 'Y', type: 'consumable' })
    expect(payload.seed_weight_g).toBe(2)
  })
})

// V5-SEEDLOTADDITION-001 (seed release 3, contract T26) — the form writes an ABSOLUTE count from a lot
// loaded a while ago, and seed can now be added to that lot from a planting in between. Every measure
// PUT says what the page loaded; the route refuses a write the lot has moved under, and the page then
// shows the latest, keeps what was typed, and compares the next Save with the latest.
describe('the measure PUT from /inventory/:id is compare-and-set', () => {
  const mount = async (lot = LOT) => {
    fetchSpy.mockImplementation((path, opts) => {
      if (path === '/api/inventory-items/inv-lot-1' && !opts) return Promise.resolve({ ...lot })
      if (path === '/api/inventory-items' && !opts) return Promise.resolve([{ ...lot }])
      if (path === '/api/inventory-items/inv-lot-1' && opts?.method === 'PUT') return Promise.resolve({ ...lot, ...JSON.parse(opts.body) })
      if (path === '/api/inventory-items/inv-lot-1/seed-measure' && opts?.method === 'PUT') return measureAnswer(JSON.parse(opts.body))
      return Promise.resolve([])
    })
    await act(async () => { render(<ToastProvider><InventoryDetail /></ToastProvider>) })
    await waitFor(() => expect(screen.getByTestId('inv-seed-count')).toBeTruthy())
    await waitFor(() => expect(fetchSpy.mock.calls.some(([p]) => p === '/api/inventory-items')).toBe(true))
  }
  let measureAnswer
  const save = () => act(async () => { fireEvent.click(screen.getByText('Save changes')) })
  beforeEach(() => {
    measureAnswer = (body) => Promise.resolve({
      id: 'inv-lot-1', seed_count: body.seed_count ?? null, seed_count_estimated: body.seed_count_estimated ?? null,
      seed_weight_g: null, seed_parent_plant_count: null,
    })
  })

  it('a lot that had no count and no weight says so with nulls, all three keys still present', async () => {
    await mount({ ...LOT, seed_count: null, seed_count_estimated: null, seed_weight_g: null })
    fireEvent.change(screen.getByTestId('inv-seed-count'), { target: { value: '40' } })
    await save()
    await waitFor(() => expect(measurePuts()).toHaveLength(1))
    expect(measurePuts()[0].body).toEqual({
      seed_count: 40, seed_count_estimated: false,
      expected_seed_count: null, expected_seed_count_estimated: null, expected_seed_weight_g: null,
    })
  })

  it('an approximate count is expected as approximate, and a weight change carries the three keys too', async () => {
    await mount({ ...LOT, seed_count: 120, seed_count_estimated: true })
    fireEvent.change(screen.getByTestId('inv-seed-weight'), { target: { value: '4' } })
    await save()
    await waitFor(() => expect(measurePuts()).toHaveLength(1))
    expect(measurePuts()[0].body).toEqual({
      seed_weight_g: 4,
      expected_seed_count: 120, expected_seed_count_estimated: true, expected_seed_weight_g: 3.2,
    })
    expect(typeof measurePuts()[0].body.expected_seed_weight_g).toBe('number')
  })

  it('a save that does not touch the measure still sends no request at all', async () => {
    await mount()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } })
    await save()
    await waitFor(() => expect(widePuts()).toHaveLength(1))
    expect(measurePuts()).toEqual([])
  })

  it('409 lot_changed: says it changed somewhere else, keeps what was typed, and the next Save is compared with the latest', async () => {
    // The lot took 30 more seeds from a planting after this page loaded it: 175 counted -> 205 counted.
    const refused = measureChangedRefusal({ seed_count: 205, seed_count_estimated: false, seed_weight_g: '3.700', seed_parent_plant_count: 2 })
    let first = true
    measureAnswer = (body) => {
      if (first) { first = false; return Promise.reject(Object.assign(new Error(refused.body.error), { status: refused.status, body: refused.body })) }
      return Promise.resolve({ id: 'inv-lot-1', seed_count: body.seed_count, seed_count_estimated: body.seed_count_estimated, seed_weight_g: '3.700', seed_parent_plant_count: 2 })
    }
    await mount()
    fireEvent.change(screen.getByTestId('inv-seed-count'), { target: { value: '180' } })
    await save()
    await waitFor(() => expect(screen.getByText(CHANGED_ELSEWHERE)).toBeTruthy())
    // The server's own sentence is never printed, and no "Saved" claims the count.
    expect(document.body.textContent).not.toContain(refused.body.error)
    expect(screen.queryByText('✓ Saved')).toBeNull()
    // What he typed is still in the field; the weight he did not touch is as it was.
    expect(screen.getByTestId('inv-seed-count').value).toBe('180')
    // The weight he did not touch follows the lot, so the next Save cannot write the old one back.
    expect(screen.getByTestId('inv-seed-weight').value).toBe('3.7')
    expect(measurePuts()).toHaveLength(1)
    expect(measurePuts()[0].body.expected_seed_count).toBe(175)

    // He looks, still means 180, and saves again: compared with what the lot answered.
    await save()
    await waitFor(() => expect(measurePuts()).toHaveLength(2))
    expect(measurePuts()[1].body).toEqual({
      seed_count: 180, seed_count_estimated: false,
      expected_seed_count: 205, expected_seed_count_estimated: false, expected_seed_weight_g: 3.7,
    })
    await waitFor(() => expect(screen.queryByText(CHANGED_ELSEWHERE)).toBeNull())
  })

  it('any other failure of the measure is the old toast, and the next Save is still compared with what was loaded', async () => {
    let first = true
    measureAnswer = (body) => {
      if (first) { first = false; return Promise.reject(Object.assign(new Error('boom'), { status: 500, body: { error: 'boom' } })) }
      return Promise.resolve({ id: 'inv-lot-1', seed_count: body.seed_count, seed_count_estimated: false, seed_weight_g: '3.200', seed_parent_plant_count: null })
    }
    await mount()
    fireEvent.change(screen.getByTestId('inv-seed-count'), { target: { value: '180' } })
    await save()
    await waitFor(() => expect(screen.getByText("Saved — couldn't record the count")).toBeTruthy())
    expect(screen.queryByText(CHANGED_ELSEWHERE)).toBeNull()
    await save()
    await waitFor(() => expect(measurePuts()).toHaveLength(2))
    expect(measurePuts()[1].body.expected_seed_count).toBe(175)
  })
})
