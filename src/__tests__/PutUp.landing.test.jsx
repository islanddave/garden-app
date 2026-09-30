// Put-Up release 1a — Jen's landing (design V4 §6.1, §10.2 "A bare open of Put-Up"): a bare open
// lands on Going now only when a listed batch is the VIEWER's own; otherwise on the put-up list.
//
// Ownership is kitchen_batch.user_id — the Clerk subject of whoever started the batch
// (lambda/preservation/kitchenRoutes.js createBatch inserts ${userId}, the verified JWT `sub`), which
// the list already carries (SELECT * over v_kitchen_batch_current; kitchen-columns.test.js pins
// user_id on the view). The viewer is AuthContext's user.id — the same Clerk id. A TWO-USER household
// in every fixture: a single-owner fixture cannot fail an ownership bug.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

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
// The signed-in user, set per test. The real hook shape: { user, profile, loading, identity }.
const { viewer } = vi.hoisted(() => ({ viewer: { id: null } }))
vi.mock('../context/AuthContext.jsx', async (importActual) => ({
  ...(await importActual()),
  useAuthOptional: () => ({ user: viewer.id ? { id: viewer.id } : null, profile: null, loading: false, identity: viewer.id ? 'signed-in' : 'signed-out' }),
}))

// B′ release 2: the put-up list segment is renamed "Pantry" (V4 §2.5, §6.1) — the landing rule is
// unchanged; only the segment's name in these assertions moved with it.
import PutUp from '../pages/PutUp.jsx'

const batch = (id, user_id, over = {}) => ({
  id, user_id, label: id, kind: 'ferment', kind_other: null, started_at: null, start_precision: null,
  first_recorded_at: '2026-09-03T12:00:00.000Z', expected_days_min: null, expected_days_max: null,
  suspended_at: null, closed_at: null, current_stage_kind: 'started', current_stage_label: null,
  current_stage_entered_at: '2026-09-03T12:00:00.000Z', input_count: 0, output_count: 0, ...over,
})
const DAVES = batch('kb-dave', 'user_dave')
const DAVES_2 = batch('kb-dave-2', 'user_dave')
const JENS = batch('kb-jen', 'user_jen')
const JENS_PAUSED = batch('kb-jen-paused', 'user_jen', { suspended_at: '2026-09-10T12:00:00.000Z' })

function wire(batches) {
  fetchMock.mockImplementation((path, options = {}) => {
    const method = options.method || 'GET'
    if (path.startsWith('/api/kitchen-batches?state=going')) return Promise.resolve({ state: 'going', batches })
    if (path.startsWith('/api/preservation/whats-put-up')) return Promise.resolve({ group_by: 'storage', groups: [] })
    if (path === '/api/storage-locations' && method === 'GET') return Promise.resolve([])
    if (path.startsWith('/api/plants')) return Promise.resolve([])
    return Promise.resolve(null)
  })
}
function renderAs(viewerId, entry = '/put-up') {
  viewer.id = viewerId
  return render(<MemoryRouter initialEntries={[entry]}><PutUp /></MemoryRouter>)
}
const activeSegment = () => within(screen.getByRole('radiogroup', { name: 'Put-Up view' }))
  .getAllByRole('radio').find(r => r.getAttribute('aria-checked') === 'true')?.textContent
// The promote runs once, on the first answer; wait for that answer before reading a non-promote.
async function settled() {
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/kitchen-batches?state=going'))
  await new Promise(r => setTimeout(r, 0))
}

beforeEach(() => { fetchMock.mockReset(); viewer.id = null; sessionStorage.clear() })

describe('a bare open lands on Going now only for the viewer’s own batch', () => {
  it('Dave, with his batch going → Going now', async () => {
    wire([DAVES])
    renderAs('user_dave')
    await waitFor(() => expect(activeSegment()).toBe('Going now'))
  })

  it('Jen, with only Dave’s batches going → the put-up list', async () => {
    wire([DAVES, DAVES_2])
    renderAs('user_jen')
    await settled()
    expect(activeSegment()).toBe('Pantry')
  })

  it('Jen, with one of her own among Dave’s → Going now', async () => {
    wire([DAVES, JENS, DAVES_2])
    renderAs('user_jen')
    await waitFor(() => expect(activeSegment()).toBe('Going now'))
  })

  it('a paused batch of her own is still hers — paused is still open', async () => {
    wire([DAVES, JENS_PAUSED])
    renderAs('user_jen')
    await waitFor(() => expect(activeSegment()).toBe('Going now'))
  })

  it('Dave, with only Jen’s batch going → the put-up list (the rule is symmetric, not "Dave sees Going now")', async () => {
    wire([JENS])
    renderAs('user_dave')
    await settled()
    expect(activeSegment()).toBe('Pantry')
  })

  it('an unknown viewer owns nothing → the put-up list (even a row that has lost its owner)', async () => {
    wire([DAVES, JENS, { ...DAVES_2, user_id: null }])
    renderAs(null)
    await settled()
    expect(activeSegment()).toBe('Pantry')
  })

  it('ownership is user_id and nothing else — a row with no user_id is nobody’s', async () => {
    wire([{ ...DAVES, user_id: undefined, created_by: 'user_jen' }])
    renderAs('user_jen')
    await settled()
    expect(activeSegment()).toBe('Pantry')
  })

  it('the band’s destination still wins over the viewer’s own batch', async () => {
    wire([JENS])
    renderAs('user_jen', '/put-up?view=pantry&filter=use-soon')
    await settled()
    expect(activeSegment()).toBe('Pantry')
  })

  it('a harvest-prefilled open still lands on the form', async () => {
    wire([JENS])
    renderAs('user_jen', { pathname: '/put-up', state: { prefill: { crop_type_slug: 'pepper', harvest_log_id: 'h-1' } } })
    await settled()
    expect(activeSegment()).toBe('Log a put-up')
  })
})
