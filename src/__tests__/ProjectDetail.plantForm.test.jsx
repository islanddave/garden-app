// V1.2a-4 S1 (PROJ-RESCOPE / V102 §5.1 #4) — tests for the extended plantForm
// shape in ProjectDetail.jsx. Asserts new fields render under the disclosure,
// state updates, approximate-date checkbox toggles sown_at_approx, and POST
// body includes all new fields.

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

const { apiFetchSpy, navigateSpy, postCalls, paramsRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  postCalls: [],
  paramsRef: { id: 'proj-1' },
}))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: apiFetchSpy }),
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => (
    <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>
  ),
  useParams: () => paramsRef,
  useNavigate: () => navigateSpy,
}))

vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: vi.fn().mockResolvedValue({ photo: { id: 'p1' } }),
    isUploading: false, error: null, photo: null, preview: null, reset: vi.fn(),
  }),
}))

// Children that pull complex contexts/effects we don't need for the form test.
vi.mock('../components/PhotoUpload.jsx', () => ({ default: () => <div data-testid="photo-upload-stub" /> }))
vi.mock('../components/Breadcrumb.jsx', () => ({ default: () => <div data-testid="breadcrumb-stub" /> }))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <div data-testid="favorite-toggle-stub" /> }))
vi.mock('../lib/status.js', () => ({
  getStatusColors: () => ({ bg: '#fff', text: '#000', border: '#ccc' }),
}))

import ProjectDetail from '../pages/ProjectDetail.jsx'

const PROJECT = {
  id: 'proj-1',
  name: 'Tomatoes 2026',
  slug: 'tomatoes-2026',
  status: 'growing',
  is_public: true,
  start_date: '2026-03-15',
  parent_project_id: null,
  parent_project_name: null,
  variety: null, species: null, description: null,
  location_id: null,
}

function wireApiFetch({ postResult = { id: 'plant-new', name: 'Test plant' }, postError = null } = {}) {
  apiFetchSpy.mockImplementation((path, options = {}) => {
    if (options.method === 'POST' && path === '/api/plants') {
      postCalls.push(JSON.parse(options.body))
      if (postError) return Promise.reject(postError)
      return Promise.resolve(postResult)
    }
    if (path === '/api/projects/proj-1') return Promise.resolve(PROJECT)
    if (path.startsWith('/api/events')) return Promise.resolve([])
    if (path === '/api/locations/with-path') return Promise.resolve([])
    if (path === '/api/projects') return Promise.resolve([])
    if (path.startsWith('/api/plants')) return Promise.resolve([])
    return Promise.resolve(null)
  })
}

beforeEach(() => {
  apiFetchSpy.mockReset()
  navigateSpy.mockReset()
  postCalls.length = 0
})

async function openAddPlantForm() {
  await waitFor(() => expect(screen.getByText('+ Add plant')).toBeDefined())
  await act(async () => {
    fireEvent.click(screen.getByText('+ Add plant'))
  })
}

describe('ProjectDetail — V1.2a-4 S1 plantForm extension', () => {
  it('renders the "Planting details — optional" disclosure', async () => {
    wireApiFetch()
    await act(async () => { render(<ProjectDetail />) })
    await openAddPlantForm()
    expect(screen.getByTestId('planting-details')).toBeDefined()
    expect(screen.getByText('Planting details — optional')).toBeDefined()
  })

  it('renders all new optional fields', async () => {
    wireApiFetch()
    await act(async () => { render(<ProjectDetail />) })
    await openAddPlantForm()
    expect(screen.getByText('Sown date (optional)')).toBeDefined()
    expect(screen.getByText('Approximate date')).toBeDefined()
    expect(screen.getByText('Initial quantity')).toBeDefined()
    expect(screen.getByText('Source')).toBeDefined()
    expect(screen.getByText('Source reference (optional)')).toBeDefined()
    expect(screen.getByText('Generation (optional)')).toBeDefined()
    expect(screen.getByText('Lineage note (optional)')).toBeDefined()
  })

  it('Approximate-date checkbox toggles sown_at_approx in POST body', async () => {
    wireApiFetch()
    await act(async () => { render(<ProjectDetail />) })
    await openAddPlantForm()

    // Fill required name
    const nameInput = screen.getByPlaceholderText(/Megatron Jalapeno/)
    await act(async () => {
      fireEvent.change(nameInput, { target: { value: 'Test Plant' } })
    })

    // Toggle the approximate-date checkbox ON
    const approxCheckbox = screen.getByTestId('sown-at-approx')
    await act(async () => {
      fireEvent.click(approxCheckbox)
    })

    const form = nameInput.closest('form')
    await act(async () => { fireEvent.submit(form) })
    await waitFor(() => expect(postCalls.length).toBeGreaterThan(0))

    expect(postCalls[0]).toMatchObject({
      name: 'Test Plant',
      sown_at_approx: true,
    })
  })

  it('POST body includes all new fields with null/default values when blank', async () => {
    wireApiFetch()
    await act(async () => { render(<ProjectDetail />) })
    await openAddPlantForm()

    const nameInput = screen.getByPlaceholderText(/Megatron Jalapeno/)
    await act(async () => {
      fireEvent.change(nameInput, { target: { value: 'Test Plant' } })
    })

    const form = nameInput.closest('form')
    await act(async () => { fireEvent.submit(form) })
    await waitFor(() => expect(postCalls.length).toBeGreaterThan(0))

    const body = postCalls[0]
    expect(body).toMatchObject({
      name: 'Test Plant',
      project_id: 'proj-1',
      quantity: 1,
      sown_at: null,
      sown_at_approx: false,
      qty_initial: 1, // defaults to quantity
      source_type: null,
      source_ref: null,
      source_generation: null,
      lineage_note: null,
    })
  })

  it('POST body propagates filled lifecycle/source/lineage values', async () => {
    wireApiFetch()
    await act(async () => { render(<ProjectDetail />) })
    await openAddPlantForm()

    const nameInput = screen.getByPlaceholderText(/Megatron Jalapeno/)
    await act(async () => {
      fireEvent.change(nameInput, { target: { value: 'Glass Gem F4' } })
    })

    // sown_at — find the date input inside the planting-details disclosure
    const details = screen.getByTestId('planting-details')
    const dateInput = details.querySelector('input[type="date"]')
    await act(async () => {
      fireEvent.change(dateInput, { target: { value: '2026-04-01' } })
    })

    // qty_initial
    const qtyInitialInput = details.querySelector('input[type="number"]')
    await act(async () => {
      fireEvent.change(qtyInitialInput, { target: { value: '12' } })
    })

    // source_type
    const sourceSelect = details.querySelector('select')
    await act(async () => {
      fireEvent.change(sourceSelect, { target: { value: 'saved_seed' } })
    })

    // source_ref, source_generation, lineage_note via placeholders
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("e.g. Johnny's Lot 4421"), { target: { value: 'Home batch 2025' } })
    })
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('e.g. F2, third gen saved'), { target: { value: 'F4' } })
    })
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("e.g. Dave's Glass Gem F4 selection"), { target: { value: 'Selected for cob density' } })
    })

    const form = nameInput.closest('form')
    await act(async () => { fireEvent.submit(form) })
    await waitFor(() => expect(postCalls.length).toBeGreaterThan(0))

    expect(postCalls[0]).toMatchObject({
      name: 'Glass Gem F4',
      sown_at: '2026-04-01',
      qty_initial: 12,
      source_type: 'saved_seed',
      source_ref: 'Home batch 2025',
      source_generation: 'F4',
      lineage_note: 'Selected for cob density',
    })
  })
})
