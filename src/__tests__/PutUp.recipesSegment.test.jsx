// Put-Up release 4 (V4 §2.6 "The Recipes segment appears from release 4") — the segment on the real Put-Up
// page: one more option in the page's segmented control, and choosing it shows the recipe list, which reads
// only when chosen (a bare open issues no recipe read). Opening a batch from a recipe lands in the page's own
// ?batch= mode, exactly as Going now does. The harness is PutUp.landing.test.jsx's.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react'
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
vi.mock('../context/AuthContext.jsx', async (importActual) => ({
  ...(await importActual()),
  useAuthOptional: () => ({ user: { id: 'user_dave' }, profile: null, loading: false, identity: 'signed-in' }),
}))

import PutUp from '../pages/PutUp.jsx'

const RECIPE = { id: 'r1', name: 'Roll for Initiative', recipe_type_id: null, type_label: null, batch_count: 1 }
const DETAIL = { ...RECIPE, notes: 'as written', lines: [], batches: [{ id: 'kb-7', label: 'Mojo Oct', started_at: '2026-10-01T16:00:00Z', closed_at: null, outcome: null }] }

function wire() {
  fetchMock.mockImplementation((path) => {
    if (path.startsWith('/api/kitchen-batches?state=going')) return Promise.resolve({ state: 'going', batches: [] })
    if (path.startsWith('/api/preservation/whats-put-up')) return Promise.resolve({ group_by: 'storage', groups: [] })
    if (path === '/api/recipes') return Promise.resolve({ recipes: [RECIPE] })
    if (path === '/api/recipes/types') return Promise.resolve({ types: [] })
    if (path === '/api/recipes/r1') return Promise.resolve({ recipe: DETAIL })
    if (path.startsWith('/api/kitchen-batches/kb-7')) return Promise.resolve({ id: 'kb-7', label: 'Mojo Oct', inputs: [], stages: [], outputs: [] })
    if (path === '/api/storage-locations') return Promise.resolve([])
    return Promise.resolve(null)
  })
}
const radios = () => within(screen.getByRole('radiogroup', { name: 'Put-Up view' })).getAllByRole('radio')

beforeEach(() => { fetchMock.mockReset(); wire(); sessionStorage.clear() })

describe('the Recipes segment on the Put-Up page', () => {
  it('is one more option; a bare open reads no recipes', async () => {
    render(<MemoryRouter initialEntries={['/put-up']}><PutUp /></MemoryRouter>)
    await waitFor(() => expect(radios().map(r => r.textContent)).toContain('Recipes'))
    expect(fetchMock.mock.calls.some(([p]) => String(p).startsWith('/api/recipes'))).toBe(false)
  })

  it('choosing it shows the recipe list; a batch made from a recipe opens in the page\'s batch mode', async () => {
    render(<MemoryRouter initialEntries={['/put-up']}><PutUp /></MemoryRouter>)
    await waitFor(() => expect(radios().map(r => r.textContent)).toContain('Recipes'))
    fireEvent.click(radios().find(r => r.textContent === 'Recipes'))
    await waitFor(() => expect(screen.getByTestId('recipes-view')).toBeTruthy())
    await waitFor(() => expect(screen.getAllByTestId('recipes-row')).toHaveLength(1))
    fireEvent.click(screen.getAllByTestId('recipes-row')[0])
    await waitFor(() => expect(screen.getByTestId('recipe-detail-batch-open')).toBeTruthy())
    fireEvent.click(screen.getByTestId('recipe-detail-batch-open'))
    await waitFor(() => expect(screen.getByTestId('putup-batch-mode')).toBeTruthy())
    expect(fetchMock).toHaveBeenCalledWith('/api/kitchen-batches/kb-7')
  })
})
