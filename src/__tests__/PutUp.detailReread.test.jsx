// Put-Up release F — the batch page's re-read after a write keeps the batch on screen (found by the
// ferment walks, tests/harness/putupferment.jsx). "Opening that batch…" is for a batch not on screen
// yet; on the re-read that follows every write it swapped the whole body out and back, remounting
// everything under it, so the write's own answer — "Saved · Undo", "Taken out · Undo", a half-typed
// salt step — was gone by the time the re-read landed.
// MUTATION: PutUp.jsx passes `loading={detailLoading}` again -> both arms red.
// CI LANE: `npm test` + TZ re-run. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'
import { clearReloadBlocks } from '../lib/reloadGate.js'

installStoragePolyfill()

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  apiFetch: (...args) => fetchMock(...args),
}))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: vi.fn(), isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))
vi.mock('../hooks/useCropTypes.js', () => ({
  useCropTypes: () => ({ cropTypes: [], loading: false }),
}))

import PutUp from '../pages/PutUp.jsx'

const BATCH = {
  id: 'kb-1', user_id: 'user_dave', label: 'Petri Dish', kind: 'ferment', kind_other: null,
  started_at: '2026-09-25T13:00:00.000Z', start_precision: 'day', first_recorded_at: '2026-09-25T13:00:00.000Z',
  suspended_at: null, closed_at: null, outcome: null, outcome_note: null, current_stage_kind: 'started',
  current_stage_entered_at: '2026-09-25T13:00:00.000Z', input_count: '1', output_count: '0', garden_names: [],
  vessel_label: null, vessel_size: null, vessel_unit: null, vessel_count: null, no_salt: null,
  shu_est_low: null, shu_est_high: null, shu_est_basis: null, recipe_ref: null,
}
const LINE = { id: 'kbi-1', batch_id: 'kb-1', input_kind: 'other', label: 'garlic', qty: '8', qty_unit: 'g', role: null,
  put_up_stage_id: null, output_id: null, ordinal: 1, from_garden: false, count_drawn: null, note: null, edited_at: null }
const STARTED = { id: 'ksl-start', batch_id: 'kb-1', stage_kind: 'started', entered_at: '2026-09-25T13:00:00.000Z', entered_precision: 'day' }

let detailGets = 0
let heldReread = null
function wire() {
  detailGets = 0
  heldReread = null
  fetchMock.mockImplementation((path, o = {}) => {
    const method = o.method ?? 'GET'
    if (path === '/api/kitchen-batches/kb-1' && method === 'GET') {
      detailGets += 1
      const body = { ...BATCH, inputs: [{ ...LINE, ...(detailGets > 1 ? { note: 'from the bed', edited_at: 'x' } : {}) }], stages: [STARTED], outputs: [] }
      // The first read answers at once; the re-read is HELD, so the test can look at the page while it is in flight.
      if (detailGets === 1) return Promise.resolve(body)
      return new Promise(res => { heldReread = () => res(body) })
    }
    if (path.startsWith('/api/kitchen-batches?state=')) return Promise.resolve({ state: 'going', batches: [BATCH] })
    if (path === '/api/kitchen-batches/kb-1/inputs/kbi-1' && method === 'PATCH') return Promise.resolve({ input: { ...LINE, note: 'from the bed' } })
    return Promise.resolve(null)
  })
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/put-up?batch=kb-1']}>
      <Routes><Route path="/put-up" element={<PutUp />} /></Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => { fetchMock.mockReset(); wire(); localStorage.clear(); clearReloadBlocks() })

describe('the batch page re-reads under the batch, never over it', () => {
  it('first load says it is opening; the re-read after a write keeps the body, and the write\'s "Saved · Undo"', async () => {
    renderPage()
    expect(screen.getByTestId('batch-detail-loading')).toBeTruthy()
    await waitFor(() => expect(screen.getByTestId('line-row-kbi-1')).toBeTruthy())

    fireEvent.click(screen.getByTestId('line-row-kbi-1'))
    fireEvent.change(screen.getByTestId('line-sheet-note'), { target: { value: 'from the bed' } })
    await act(async () => { fireEvent.click(screen.getByTestId('line-sheet-save')) })
    await waitFor(() => expect(heldReread).toBeTypeOf('function'))

    // In flight: the batch is still on screen and so is the answer to the write.
    expect(screen.queryByTestId('batch-detail-loading')).toBeNull()
    expect(screen.getByTestId('line-saved').textContent).toBe('SavedUndo')

    await act(async () => { heldReread() })
    expect(detailGets).toBe(2)
    expect(screen.getByTestId('line-row-kbi-1').textContent).toContain('edited')
    expect(screen.getByTestId('line-saved').textContent).toBe('SavedUndo')
  })
})
