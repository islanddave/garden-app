// Put-Up UX pass R1, lane B — the add row's collapse, THROUGH THE REAL PAGE (the seam with lane A's file).
//
// WHY A PAGE TEST. The component tests hand BatchDetailView its lines at mount. The page does not: it mounts
// on `?batch=<id>` with nothing, shows the opening shell, and the detail lands a round trip later — and
// after every write it re-reads the SAME mounted batch. "Read once the detail has loaded" and "stays open
// across the re-read" are both statements about that sequence, so they are asserted against it here:
// PutUp itself, its own detail GET, its own onChanged → re-read.
//   MUTATION M4: derive the add row's visibility from `lines.length === 0` on every render -> the third
//   test reds when the page's re-read lands (the row shuts after the first line), which is where
//   `gate:putup-ferment` stops four of its five walks.
//   MUTATION: read the lines before the detail has loaded (an initialiser over an empty prop on a view
//   that is mounted during the read) -> the first test finds the add row open on a batch that has lines.
// CI LANE: `npm test` plus the TZ re-run. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
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
vi.mock('../hooks/useCropTypes.js', () => ({
  useCropTypes: () => ({ cropTypes: [{ slug: 'pepper', display_name: 'Peppers', category: 'vegetable' }], loading: false }),
}))
vi.mock('../context/AuthContext.jsx', async (orig) => ({
  ...(await orig()),
  useAuthOptional: () => ({ user: { id: 'user_dave' }, profile: null, loading: false, identity: 'signed-in' }),
}))

import PutUp from '../pages/PutUp.jsx'

const local = (s) => new Date(s).toISOString()
const BATCH = {
  id: 'kb-1', user_id: 'user_dave', label: 'Megatron mash', kind: 'ferment', kind_other: null,
  started_at: local('2026-10-01T09:00:00'), start_precision: 'day', first_recorded_at: local('2026-10-01T09:00:00'),
  suspended_at: null, closed_at: null, outcome: null, outcome_note: null, current_stage_kind: 'started',
  current_stage_entered_at: local('2026-10-01T09:00:00'), input_count: '0', output_count: '0', garden_names: [],
}
const LINE = (id, label) => ({ id, batch_id: 'kb-1', input_kind: 'other', label, qty: null, qty_unit: null, role: null,
  put_up_stage_id: null, output_id: null, ordinal: 1, from_garden: false, count_drawn: null })
// GET /:id answers the view row with its inputs, stages and outputs on it.
const detailOf = (inputs) => ({ ...BATCH, inputs, stages: [], outputs: [] })

const DETAIL_ROUTE = /^\/api\/kitchen-batches\/[^/?]+$/
// `detail()` is called per GET, so a test can change what the next read returns.
function wire(detail) {
  fetchMock.mockImplementation((path, options = {}) => {
    const method = options.method || 'GET'
    if (DETAIL_ROUTE.test(path) && method === 'GET') return detail()
    if (String(path).startsWith('/api/kitchen-batches/line-search')) return Promise.resolve({ plantings: [], put_ups: [] })
    if (method === 'POST' && /\/inputs$/.test(path)) return Promise.resolve({ inserted: 1, requested: 1, inputs: [{ id: 'kbi-new' }] })
    if (String(path).startsWith('/api/kitchen-batches')) return Promise.resolve({ state: 'going', batches: [BATCH] })
    if (path === '/api/storage-locations') return Promise.resolve([])
    return Promise.resolve(null)
  })
}
const detailGets = () => fetchMock.mock.calls.filter(([p, o]) => DETAIL_ROUTE.test(p) && (o?.method ?? 'GET') === 'GET').length
const renderPage = () => render(<MemoryRouter initialEntries={['/put-up?batch=kb-1']}><PutUp /></MemoryRouter>)

beforeEach(() => { fetchMock.mockReset(); localStorage.clear() })

describe('the add row is read once the batch\'s detail has LOADED, never before', () => {
  it('a batch whose detail arrives WITH lines shows the add row collapsed once the read lands', async () => {
    let land
    wire(() => new Promise(r => { land = r }))
    renderPage()
    // The read is still out: the opening shell, and nothing of the batch — so nothing has been read yet.
    await waitFor(() => expect(screen.getByTestId('batch-detail-loading')).toBeTruthy())
    expect(screen.queryByTestId('what-went-in')).toBeNull()
    await act(async () => { land(detailOf([LINE('kbi-1', 'Megatron jalapeño')])) })
    await waitFor(() => expect(screen.getByTestId('what-went-in')).toBeTruthy())
    expect(screen.getByTestId('line-add-open').textContent).toBe('+ Add what went in')
    expect(screen.queryByTestId('line-add-name')).toBeNull()
    expect(screen.getAllByTestId('line-row-text').map(n => n.textContent)).toEqual(['Megatron jalapeño'])
  })

  it('a batch whose detail arrives with NO lines opens with the add row shown', async () => {
    wire(() => Promise.resolve(detailOf([])))
    renderPage()
    await waitFor(() => expect(screen.getByTestId('line-add-name')).toBeTruthy())
    expect(screen.queryByTestId('line-add-open')).toBeNull()
  })
})

describe('…and it stays open across each Add and the page\'s own re-read', () => {
  it('two lines in a row on a new batch, with no door to tap between them', async () => {
    let inputs = []
    wire(() => Promise.resolve(detailOf(inputs)))
    renderPage()
    await waitFor(() => expect(screen.getByTestId('line-add-name')).toBeTruthy())
    expect(detailGets()).toBe(1)

    // The first line. The stand-in server has it from now on, so the page's re-read carries it back.
    fireEvent.change(screen.getByTestId('line-add-name'), { target: { value: 'onion' } })
    inputs = [LINE('kbi-new', 'onion')]
    await act(async () => { fireEvent.click(screen.getByTestId('line-add-submit')) })
    // INSTRUMENT: the page really did re-read, and the batch on screen really has a line now.
    await waitFor(() => expect(detailGets()).toBe(2))
    await waitFor(() => expect(screen.getAllByTestId('line-row-text').map(n => n.textContent)).toEqual(['onion']))

    // The add row is still there — not behind its door — and takes the second line.
    expect(screen.queryByTestId('line-add-open')).toBeNull()
    fireEvent.change(screen.getByTestId('line-add-name'), { target: { value: 'garlic' } })
    inputs = [LINE('kbi-new', 'onion'), LINE('kbi-2', 'garlic')]
    await act(async () => { fireEvent.click(screen.getByTestId('line-add-submit')) })
    await waitFor(() => expect(detailGets()).toBe(3))
    await waitFor(() => expect(screen.getAllByTestId('line-row-text').map(n => n.textContent)).toEqual(['onion', 'garlic']))
    expect(screen.getByTestId('line-add-name')).toBeTruthy()
    expect(screen.queryByTestId('line-add-open')).toBeNull()
  })
})
