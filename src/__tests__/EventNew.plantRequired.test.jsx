// V4-PLANTREQUIRED-001 (Lane 3) — EventNew required-planting gate with PLANTING_REQUIRED_ENABLED
// mocked TRUE. Proves the D2 gate actually BLOCKS a plant-predicated event logged with no planting,
// lets it through once a planting is chosen, and leaves an EXEMPT type unblocked. The default-off
// behavior (planting optional) is covered by EventNew.test.jsx; this file exercises the flag-ON path.
//
// The flag is spread over the REAL module (importActual) so every other flag keeps its real value —
// EventNew also reads OVERLAY_ROUTES_ENABLED, so a bare {PLANTING_REQUIRED_ENABLED:true} mock would
// blank it and change unrelated behavior. Harness mirrors EventNew.test.jsx. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

const { apiFetchSpy, navigateSpy, postCalls, dataRef, searchParamsRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  postCalls: [],
  dataRef: { projects: [], locations: [], plants: [], postResult: { id: 'evt-1' }, postError: null },
  searchParamsRef: { current: new URLSearchParams() },
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))

vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: vi.fn(() => Promise.resolve({ photo: { id: 'p1' } })),
    isUploading: false, error: null, photo: null, stage: null, progress: null, preview: null, reset: vi.fn(),
  }),
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => (<a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>),
  useNavigate: () => navigateSpy,
  useSearchParams: () => [searchParamsRef.current, vi.fn()],
}))

// Flag ON — spread the real module so OVERLAY_ROUTES_ENABLED (and any future flag) keeps its value.
vi.mock('../lib/featureFlags.js', async (importActual) => ({
  ...(await importActual()),
  PLANTING_REQUIRED_ENABLED: true,
}))

import EventNew from '../pages/EventNew.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

const PROJECT = { id: 'proj-1', name: 'Tomatoes 2026', status: 'growing' }
const PLANT = { id: 'plant-1', name: 'Sungold', project_id: 'proj-1' }

function wireApiFetch() {
  apiFetchSpy.mockImplementation((path, options = {}) => {
    if (options.method === 'POST' && path === '/api/events') {
      postCalls.push(JSON.parse(options.body))
      if (dataRef.postError) return Promise.reject(dataRef.postError)
      return Promise.resolve(dataRef.postResult)
    }
    if (path === '/api/projects') return Promise.resolve(dataRef.projects)
    if (path === '/api/locations/with-path') return Promise.resolve(dataRef.locations)
    if (path.startsWith('/api/plants')) return Promise.resolve(dataRef.plants)
    return Promise.resolve(null)
  })
}

function renderEventNew(query = '') {
  searchParamsRef.current = new URLSearchParams(query)
  return render(<ToastProvider><EventNew /></ToastProvider>)
}

async function flushLoad() {
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/projects'))
  await act(async () => { await Promise.resolve() })
}

async function pickPlanting(id) {
  fireEvent.focus(screen.getByLabelText('Plant or group'))
  fireEvent.click(await screen.findByTestId(`ps-opt-${id}`))
}

beforeEach(() => {
  apiFetchSpy.mockReset()
  navigateSpy.mockReset()
  postCalls.length = 0
  searchParamsRef.current = new URLSearchParams()
  dataRef.projects = [PROJECT]
  dataRef.locations = []
  dataRef.plants = [PLANT]
  dataRef.postResult = { id: 'evt-1' }
  dataRef.postError = null
  try { localStorage.clear() } catch { /* noop */ }
  wireApiFetch()
})

describe('EventNew — V4-PLANTREQUIRED-001 gate (flag ON)', () => {
  it('BLOCKS a plant-predicated type (watering) submitted with no planting — no POST, inline error', async () => {
    renderEventNew('event_type=watering&project=proj-1')
    await flushLoad()
    fireEvent.click(screen.getByText('Save'))
    await act(async () => { await Promise.resolve() })
    expect(postCalls.length).toBe(0)
    expect(screen.getByText(/Choose a planting for this event/i)).toBeTruthy()
  })

  it('ALLOWS a plant-predicated type once a planting is chosen — POST carries plant_id', async () => {
    renderEventNew('event_type=watering&project=proj-1')
    await flushLoad()
    await pickPlanting('plant-1')
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(postCalls.length).toBe(1))
    expect(postCalls[0].plant_id).toBe('plant-1')
  })

  it('leaves an EXEMPT type (observation) unblocked with no planting — POST fires, plant_id null', async () => {
    renderEventNew('event_type=observation&project=proj-1')
    await flushLoad()
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(postCalls.length).toBe(1))
    expect(postCalls[0].plant_id).toBeNull()
  })

  it('marks the planting field required (aria-required) for a plant-predicated type', async () => {
    renderEventNew('event_type=watering&project=proj-1')
    await flushLoad()
    expect(screen.getByLabelText('Plant or group').getAttribute('aria-required')).toBe('true')
  })
})
