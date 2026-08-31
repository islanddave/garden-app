// V4-WATERMATH-001 F0 — the amount class on event history: readable always, editable behind
// WATER_DEPTH_EDIT_ENABLED (see featureFlags.js — PUT /api/events/:id does not yet persist or
// return `metadata`, so shipping the editor unflagged would silently discard corrections).
//
// Both flag states are asserted. A flag-gated feature tested in only one state is a feature whose
// other state ships untested — and here the OFF state is the one currently in production.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, waitFor, fireEvent, cleanup } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const { apiFetchSpy, navigateSpy, dataRef, flagRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  dataRef: { event: null, project: { id: 'p1', name: 'Tomatoes 2026' } },
  flagRef: { current: false },
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))
// V4-REANCHORFLAG-001: useAuthOptional is owed because EventDetail's edit form now mounts
// PlantingSelect, which self-fetches through useCachedFetch. Null user on purpose — that puts
// the hook on its plain fetch branch rather than the module-level dataCache, so one test's
// plantings cannot leak into the next.
vi.mock('../context/AuthContext.jsx', () => ({
  useAuth: () => ({ user: { id: 'u1' } }),
  useAuthOptional: () => ({ user: null }),
}))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: vi.fn(), isUploading: false, error: null, photo: null, preview: null, reset: vi.fn(),
  }),
}))
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, useNavigate: () => navigateSpy }
})
// A getter so a single module instance can serve both flag states without re-importing the page.
vi.mock('../lib/featureFlags.js', async (importActual) => {
  const actual = await importActual()
  return { ...actual, get WATER_DEPTH_EDIT_ENABLED() { return flagRef.current } }
})

import EventDetail from '../pages/EventDetail.jsx'

const wateringEvent = {
  id: 'e1', project_id: 'p1', plant_id: 'pl1', location_id: null,
  event_type: 'watering', event_date: '2026-08-01T00:00:00Z',
  title: '', notes: '', private_notes: '', quantity: '', is_public: false,
  flagged_as_issue: false, severity: null, harvest: null,
  metadata: { water_depth: 'deep', water_depth_source: 'user' },
}

const putBodies = []

function setup(ev = wateringEvent) {
  dataRef.event = { ...ev }
  apiFetchSpy.mockReset()
  apiFetchSpy.mockImplementation((path, opts) => {
    if (path === '/api/events/e1') {
      if (opts?.method === 'PUT') { putBodies.push(JSON.parse(opts.body)); return Promise.resolve({ ...dataRef.event }) }
      return Promise.resolve(dataRef.event)
    }
    if (path === '/api/projects/p1') return Promise.resolve(dataRef.project)
    return Promise.resolve(null)
  })
  return render(
    <MemoryRouter initialEntries={['/projects/p1/events/e1']}>
      <Routes><Route path="/projects/:id/events/:eventId" element={<EventDetail />} /></Routes>
    </MemoryRouter>,
  )
}

async function flushLoad() {
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/events/e1'))
  await act(async () => { await Promise.resolve() })
}

beforeEach(() => { putBodies.length = 0; flagRef.current = false })

describe('EventDetail — the stored class is READABLE (unflagged)', () => {
  it('renders the class in plain words, not the stored code', async () => {
    setup()
    await flushLoad()
    expect(screen.getByText('Water amount')).toBeTruthy()
    expect(screen.getByText('Deep')).toBeTruthy()
    expect(screen.queryByText('deep')).toBeNull()
  })

  it('does not render the machine provenance key', async () => {
    setup()
    await flushLoad()
    expect(screen.queryByText('water_depth_source')).toBeNull()
    expect(screen.queryByText('user')).toBeNull()
  })
})

describe('EventDetail — editing the class is flag-gated', () => {
  it('flag OFF: no chips in the edit form, and the PUT carries no metadata', async () => {
    flagRef.current = false
    setup()
    await flushLoad()
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }))
    expect(screen.queryByTestId('ev-water-depth-group')).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /save changes|save/i })) })
    await waitFor(() => expect(putBodies.length).toBe(1))
    expect(putBodies[0].metadata).toBeUndefined()
  })

  it('flag ON: chips render seeded from the SAVED row', async () => {
    flagRef.current = true
    setup()
    await flushLoad()
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }))
    expect(screen.getByTestId('ev-water-depth-group')).toBeTruthy()
    expect(screen.getByTestId('ev-water-depth-deep').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('ev-water-depth-normal').getAttribute('aria-pressed')).toBe('false')
  })

  it('flag ON: a corrected class reaches the PUT as source=user and MERGES over existing metadata', async () => {
    flagRef.current = true
    setup({ ...wateringEvent, metadata: { water_depth: 'deep', water_depth_source: 'user', amount_ml: 500 } })
    await flushLoad()
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }))
    fireEvent.click(screen.getByTestId('ev-water-depth-light'))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /save changes|save/i })) })
    await waitFor(() => expect(putBodies.length).toBe(1))
    expect(putBodies[0].metadata).toEqual({
      amount_ml: 500, water_depth: 'light', water_depth_source: 'user',
    })
  })

  it('flag ON: a class-less historical row seeds to the default rather than to nothing', async () => {
    flagRef.current = true
    setup({ ...wateringEvent, metadata: null })
    await flushLoad()
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }))
    expect(screen.getByTestId('ev-water-depth-normal').getAttribute('aria-pressed')).toBe('true')
  })

  it('flag ON: a non-watering event gets no chips', async () => {
    flagRef.current = true
    setup({ ...wateringEvent, event_type: 'observation', metadata: null })
    await flushLoad()
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }))
    expect(screen.queryByTestId('ev-water-depth-group')).toBeNull()
  })
})
