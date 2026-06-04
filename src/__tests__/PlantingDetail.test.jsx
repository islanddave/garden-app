// PlantingDetail (V3-NAV-001 / Lane C, PR2) unit tests.
// Covers the four-state contract (loading / fetch-error / 404 / empty-but-exists), the
// ownership guard, the HS-2 server-side event filter URL, null-variety tolerance, and the
// multi-channel status badge. useApiFetch is mocked to a controllable fetch; react-router-dom
// is REAL (MemoryRouter supplies :id / :plantingId). uxEvents is stubbed (no telemetry network).

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const { apiFetchSpy } = vi.hoisted(() => ({ apiFetchSpy: vi.fn() }))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn() }),
}))
// Telemetry must not touch the network in tests.
vi.mock('../lib/uxEvents.js', () => ({
  FLOWS: { OPEN_PLANTING: 'open_planting' },
  useUxFlow: () => ({ step: vi.fn(), tap: vi.fn(), complete: vi.fn(), reset: vi.fn() }),
}))

import PlantingDetail from '../pages/PlantingDetail.jsx'

const PLANTING = {
  id: 'pl1', name: 'Megatron Jalapeno', project_id: 'proj1', project_name: 'Peppers 2026',
  status: 'fruiting', quantity: 3, qty_initial: 6,
  sown_at: '2026-02-01', transplanted_at: '2026-04-15',
  variety_ref: { name: 'Megatron F4', species: 'Capsicum annuum' },
  source_type: 'saved_seed', source_ref: 'Dave lot 12', lineage_note: 'F4 selection',
  location_path: 'Greenhouse / Bed 2', notes: 'Hot one',
  featured_photo_view_url: null,
}

const EVENTS = [
  { id: 'e2', event_type: 'harvest', event_date: '2026-06-01T12:00:00Z', plant_id: 'pl1', title: 'Big pick' },
  { id: 'e1', event_type: 'first_harvest', event_date: '2026-05-20T12:00:00Z', plant_id: 'pl1', title: null },
]

function renderAt(path = '/projects/proj1/plantings/pl1') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/projects/:id/plantings/:plantingId" element={<PlantingDetail />} />
        <Route path="/projects/:id" element={<div>PROJECT PAGE</div>} />
        <Route path="/garden" element={<div>GARDEN PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  apiFetchSpy.mockReset()
  window.scrollTo = vi.fn()
})

describe('PlantingDetail — four states', () => {
  it('shows a loading state before data resolves', async () => {
    let resolvePlanting
    apiFetchSpy.mockImplementation(() => new Promise(r => { resolvePlanting = () => r(PLANTING) }))
    renderAt()
    expect(screen.getByText('Loading…')).toBeTruthy()
    await act(async () => { resolvePlanting(); await Promise.resolve() })
  })

  it('renders the planting (loaded) with name, multi-channel status, and grower fields', async () => {
    apiFetchSpy.mockImplementation((path) => {
      if (path.startsWith('/api/plants/')) return Promise.resolve(PLANTING)
      if (path.startsWith('/api/events')) return Promise.resolve(EVENTS)
      return Promise.resolve(null)
    })
    renderAt()
    // Name appears in both the H1 and the breadcrumb — assert the heading specifically.
    await screen.findByRole('heading', { name: 'Megatron Jalapeno' })
    // Status: multi-channel — the label text is present AND aria-labelled (not color alone).
    const badge = screen.getByLabelText('Status: fruiting')
    expect(badge.textContent).toContain('fruiting')
    // Grower fields.
    expect(screen.getByText('Greenhouse / Bed 2', { exact: false })).toBeTruthy()
    expect(screen.getByText('Transplanted')).toBeTruthy()
    // First-harvest derived from the event log (earliest first_harvest) — appears only once
    // the async events fetch resolves, so wait for it rather than asserting synchronously.
    await screen.findByText('First harvest')
  })

  it('fetch-error (non-404) shows a friendly error + back link, not a thrown page', async () => {
    apiFetchSpy.mockImplementation((path) => {
      if (path.startsWith('/api/plants/')) return Promise.reject(Object.assign(new Error('boom'), { status: 500 }))
      return Promise.resolve(null)
    })
    renderAt()
    await screen.findByText('boom')
    expect(screen.getByText(/Back to project/)).toBeTruthy()
  })

  it('404 from the by-id endpoint shows the friendly "not found" state', async () => {
    apiFetchSpy.mockImplementation((path) => {
      if (path.startsWith('/api/plants/')) return Promise.reject(Object.assign(new Error('Not found'), { status: 404 }))
      return Promise.resolve(null)
    })
    renderAt()
    await screen.findByText('Planting not found')
    expect(screen.getByText(/Back to project/)).toBeTruthy()
  })

  it('empty-but-exists: planting loads but has zero events (distinct from a load failure)', async () => {
    apiFetchSpy.mockImplementation((path) => {
      if (path.startsWith('/api/plants/')) return Promise.resolve({ ...PLANTING, notes: null })
      if (path.startsWith('/api/events')) return Promise.resolve([])
      return Promise.resolve(null)
    })
    renderAt()
    await screen.findByRole('heading', { name: 'Megatron Jalapeno' })
    await screen.findByText('No events logged for this planting yet.')
  })
})

describe('PlantingDetail — ownership guard + HS-2 filter', () => {
  it('ownership mismatch (URL project != planting.project_id) → 404 semantics, no leak', async () => {
    apiFetchSpy.mockImplementation((path) => {
      // URL says proj-OTHER but the planting belongs to proj1.
      if (path.startsWith('/api/plants/')) return Promise.resolve(PLANTING)
      return Promise.resolve(null)
    })
    renderAt('/projects/proj-OTHER/plantings/pl1')
    await screen.findByText('Planting not found')
    // It must NOT render the planting name (no existence leak across projects).
    expect(screen.queryByText('Megatron Jalapeno')).toBeNull()
  })

  it('calls the events endpoint with the HS-2 server-side plant_id filter', async () => {
    apiFetchSpy.mockImplementation((path) => {
      if (path.startsWith('/api/plants/')) return Promise.resolve(PLANTING)
      if (path.startsWith('/api/events')) return Promise.resolve(EVENTS)
      return Promise.resolve(null)
    })
    renderAt()
    await waitFor(() =>
      expect(apiFetchSpy).toHaveBeenCalledWith('/api/events?project_id=proj1&plant_id=pl1'))
  })

  it('event-log error state is distinct from the page error (page still renders)', async () => {
    apiFetchSpy.mockImplementation((path) => {
      if (path.startsWith('/api/plants/')) return Promise.resolve(PLANTING)
      if (path.startsWith('/api/events')) return Promise.reject(new Error('events down'))
      return Promise.resolve(null)
    })
    renderAt()
    await screen.findByRole('heading', { name: 'Megatron Jalapeno' })  // page loaded fine
    await screen.findByText("Couldn't load this planting's events.")    // only the log failed
  })
})

describe('PlantingDetail — null tolerance', () => {
  it('renders without a variety (null variety_ref) and without a photo', async () => {
    apiFetchSpy.mockImplementation((path) => {
      if (path.startsWith('/api/plants/')) {
        return Promise.resolve({
          id: 'pl1', name: 'Bare Planting', project_id: 'proj1', project_name: 'P',
          status: null, quantity: 1, variety_ref: null,
          sown_at: null, transplanted_at: null, source_type: null,
          lineage_note: null, notes: null, location_path: null, featured_photo_view_url: null,
        })
      }
      if (path.startsWith('/api/events')) return Promise.resolve([])
      return Promise.resolve(null)
    })
    renderAt()
    await screen.findByRole('heading', { name: 'Bare Planting' })
    // No status badge when status is null; no crash on absent variety/photo.
    expect(screen.queryByLabelText(/^Status:/)).toBeNull()
    expect(screen.getByText('No additional details recorded yet.')).toBeTruthy()
  })
})
