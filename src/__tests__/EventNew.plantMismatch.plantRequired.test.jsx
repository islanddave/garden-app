// BUG-PLANTMISMATCH-001 under V4-PLANTREQUIRED-001 flag ON — the interaction the flip actually changes.
//
// WHY THIS FILE EXISTS. EventNew.test.jsx's mismatch block pins the invariant "a project switch must
// drop the planting, and the POST must never carry a mismatched (project_id, plant_id) pair." It
// proves that by asserting the POST fires with plant_id null. With PLANTING_REQUIRED_ENABLED flipped
// TRUE (2026-08-10), a plant-predicated type can no longer POST with a null planting at all — so the
// REMEDY changed shape even though the invariant did not. The old assertions still hold flag-OFF
// (that suite now pins the flag false); this file pins the flag-ON shape of the same invariant.
//
// The distinction that matters, and the reason this is not just a rewritten assertion: flag-OFF the
// user silently logs a watering against no planting; flag-ON the user is stopped and told to choose
// one. Both satisfy "never write a mismatched pair." Only one of them loses the planting silently.
//
// importActual spread so every other flag (OVERLAY_ROUTES_ENABLED etc.) keeps its real value.
// Harness mirrors EventNew.plantRequired.test.jsx. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

const { apiFetchSpy, navigateSpy, postCalls, dataRef, searchParamsRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  postCalls: [],
  dataRef: { postResult: { id: 'evt-1' } },
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

vi.mock('../lib/featureFlags.js', async (importActual) => ({
  ...(await importActual()),
  PROJECTS_HIDDEN: false,
  PLANTING_REQUIRED_ENABLED: true,
}))

import EventNew from '../pages/EventNew.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

const PROJ_A = { id: 'proj-a', name: 'Project A', status: 'growing' }
const PROJ_B = { id: 'proj-b', name: 'Project B', status: 'growing' }
const PLANT_A = { id: 'plant-a', name: 'Tomato A', project_id: 'proj-a' }
const PLANT_B = { id: 'plant-b', name: 'Pepper B', project_id: 'proj-b' }

// Each project must answer with its OWN plantings — the pair bug is only observable that way.
function wireTwoProjects() {
  apiFetchSpy.mockImplementation((path, options = {}) => {
    if (options.method === 'POST' && path === '/api/events') {
      postCalls.push(JSON.parse(options.body))
      return Promise.resolve(dataRef.postResult)
    }
    if (path === '/api/projects') return Promise.resolve([PROJ_A, PROJ_B])
    if (path === '/api/locations/with-path') return Promise.resolve([])
    if (path === '/api/plants?project_id=proj-a') return Promise.resolve([PLANT_A])
    if (path === '/api/plants?project_id=proj-b') return Promise.resolve([PLANT_B])
    if (path.startsWith('/api/plants')) return Promise.resolve([])
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

async function switchTo(projectId) {
  fireEvent.change(screen.getByLabelText('Project'), { target: { value: projectId } })
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
  dataRef.postResult = { id: 'evt-1' }
  try { localStorage.clear() } catch { /* noop */ }
})

describe('BUG-PLANTMISMATCH-001 × V4-PLANTREQUIRED-001 (flag ON)', () => {
  it('a project switch that drops the planting now BLOCKS the save instead of posting a null planting', async () => {
    wireTwoProjects()
    renderEventNew('project=proj-a&plant=plant-a&event_type=watering')
    await flushLoad()
    await act(async () => { await Promise.resolve() })
    await switchTo('proj-b')
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    await act(async () => { await Promise.resolve() })
    // The invariant is unchanged — no mismatched pair reaches the wire. The remedy changed:
    // flag-OFF this posted {proj-b, null}; flag-ON nothing is written and the user is told why.
    expect(postCalls.length).toBe(0)
    expect(screen.getByText(/Choose a planting for this event/i)).toBeTruthy()
  })

  it('after the switch, choosing a planting from the NEW project posts a matched pair', async () => {
    wireTwoProjects()
    renderEventNew('project=proj-a&plant=plant-a&event_type=watering')
    await flushLoad()
    await act(async () => { await Promise.resolve() })
    await switchTo('proj-b')
    await pickPlanting('plant-b')
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    await waitFor(() => expect(postCalls.length).toBe(1))
    expect(postCalls[0].project_id).toBe('proj-b')
    expect(postCalls[0].plant_id).toBe('plant-b')
  })

  it('re-selecting the SAME project is still not a silent reset — the planting survives and posts', async () => {
    wireTwoProjects()
    renderEventNew('project=proj-a&plant=plant-a&event_type=watering')
    await flushLoad()
    await act(async () => { await Promise.resolve() })
    await switchTo('proj-a')
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    await waitFor(() => expect(postCalls.length).toBe(1))
    expect(postCalls[0].plant_id).toBe('plant-a')
  })

  it('a deep-linked plant that does not belong to the deep-linked project is blocked, not posted null', async () => {
    // The load-effect stale-guard case: proj-b never contains plant-a, whatever route selected it.
    apiFetchSpy.mockImplementation((path, options = {}) => {
      if (options.method === 'POST' && path === '/api/events') {
        postCalls.push(JSON.parse(options.body)); return Promise.resolve(dataRef.postResult)
      }
      if (path === '/api/projects') return Promise.resolve([PROJ_A, PROJ_B])
      if (path === '/api/locations/with-path') return Promise.resolve([])
      if (path === '/api/plants?project_id=proj-b') return Promise.resolve([PLANT_B])
      if (path.startsWith('/api/plants')) return Promise.resolve([PLANT_A])
      return Promise.resolve(null)
    })
    renderEventNew('project=proj-b&plant=plant-a&event_type=watering')
    await flushLoad()
    await act(async () => { await Promise.resolve() })
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    await act(async () => { await Promise.resolve() })
    expect(postCalls.length).toBe(0)
  })

  it('an EXEMPT type is unaffected by the switch — still posts with a null planting', async () => {
    // Guards against over-reach: the gate must not block types that never predicate on a plant.
    wireTwoProjects()
    renderEventNew('project=proj-a&plant=plant-a&event_type=observation')
    await flushLoad()
    await act(async () => { await Promise.resolve() })
    await switchTo('proj-b')
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    await waitFor(() => expect(postCalls.length).toBe(1))
    expect(postCalls[0].project_id).toBe('proj-b')
    expect(postCalls[0].plant_id).toBeNull()
  })
})
