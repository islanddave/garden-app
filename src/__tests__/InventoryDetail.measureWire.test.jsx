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
    // Positive: the merge still happened (variety_id comes only from the list row) and the edit travelled.
    expect(wide.body.variety_id).toBe('var-thai')
    expect(wide.body.name).toBe('Thai Dragon — tin 2')
    for (const k of MEASURE_KEYS) expect(Object.prototype.hasOwnProperty.call(wide.body, k), `wide PUT carried ${k}`).toBe(false)
    expect(measurePuts()[0].body).toEqual({ seed_count: 180, seed_count_estimated: false })
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
    expect(body.variety_id).toBe('var-thai')
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
