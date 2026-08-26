// V4-PROJHIDE-001 — EventNew with PROJECTS_HIDDEN mocked TRUE. Proves the project chooser is gone,
// the planting picker is fed from the UNSCOPED /api/plants source, project_id is DERIVED from the
// chosen planting (not the default project), a plant-predicated type is required-implied by the flag,
// and an exempt type falls back to the default project_id. Flag-OFF behavior (project chooser present,
// project-scoped planting list) is covered by EventNew.test.jsx + EventNewStickyProject.test.jsx.
// importActual spread so every other flag (OVERLAY_ROUTES_ENABLED etc.) keeps its real value. No
// jest-dom (L-182). Harness mirrors EventNew.plantRequired.test.jsx.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react'

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

// Flag ON — spread the real module so every other flag keeps its value.
vi.mock('../lib/featureFlags.js', async (importActual) => ({
  ...(await importActual()),
  PROJECTS_HIDDEN: true,
}))

import EventNew from '../pages/EventNew.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

// Two projects: the DEFAULT (first loggable) is A; the plant lives in B. A derived project_id must be
// B (from the planting), never the default A — that gap is what distinguishes derivation from defaulting.
const PROJECT_A = { id: 'proj-A', name: 'Alpha', status: 'growing' }
const PROJECT_B = { id: 'proj-B', name: 'Bravo', status: 'growing' }
const PLANT = { id: 'plant-1', name: 'Sungold', project_id: 'proj-B' }

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
  dataRef.projects = [PROJECT_A, PROJECT_B]
  dataRef.locations = []
  dataRef.plants = [PLANT]
  dataRef.postResult = { id: 'evt-1' }
  dataRef.postError = null
  try { localStorage.clear() } catch { /* noop */ }
  wireApiFetch()
})

describe('EventNew — V4-PROJHIDE-001 (flag ON)', () => {
  it('hides the Project chooser entirely', async () => {
    renderEventNew('event_type=observation')
    await flushLoad()
    expect(screen.queryByLabelText('Project')).toBeNull()
  })

  it('feeds the planting picker from the UNSCOPED /api/plants source (no project step)', async () => {
    renderEventNew('event_type=observation')
    await flushLoad()
    // Under the flag the picker lists every planting via the bare endpoint, never /api/plants?project_id=.
    // V4-PICKERPAYLOAD-001: the bare endpoint now carries the chooser projection. The CLAIM of
    // this test is unscoped-vs-scoped, so the assertion keeps naming the exact URL rather than
    // loosening to a prefix — a prefix would also match the ?project_id= form it exists to exclude.
    expect(apiFetchSpy).toHaveBeenCalledWith('/api/plants?view=picker')
    const scoped = apiFetchSpy.mock.calls.filter(([p]) => typeof p === 'string' && p.includes('project_id='))
    expect(scoped.length).toBe(0)
  })

  it('derives project_id from the chosen planting (B), not the default project (A)', async () => {
    renderEventNew('event_type=observation')
    await flushLoad()
    await pickPlanting('plant-1')
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(postCalls.length).toBe(1))
    expect(postCalls[0].plant_id).toBe('plant-1')
    expect(postCalls[0].project_id).toBe('proj-B')
  })

  it('requires a planting for a plant-predicated type (watering) — implied by the flag', async () => {
    renderEventNew('event_type=watering')
    await flushLoad()
    fireEvent.click(screen.getByText('Save'))
    await act(async () => { await Promise.resolve() })
    expect(postCalls.length).toBe(0)
    expect(screen.getByText(/Choose a planting for this event/i)).toBeTruthy()
  })

  it('falls back to the default project_id (A) for an exempt type with no planting', async () => {
    renderEventNew('event_type=observation')
    await flushLoad()
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(postCalls.length).toBe(1))
    expect(postCalls[0].plant_id).toBeNull()
    expect(postCalls[0].project_id).toBe('proj-A')
  })
})

// BUG-LOGTARGETREQ-001 — FLAG-ON duplicates of the sticky-suite pins (design §1a "Flag-arm
// coverage"): the removed auto-seed executed in BOTH flag arms and prod runs flag-ON, so the
// never-pre-targets invariant and the ranked-first behavior are pinned here too, against the
// unscoped /api/plants source. Rollback-arm (flags FALSE) twins live in EventNewStickyProject.
describe('EventNew — sticky planting demoted to ranking, flag-ON arm (BUG-LOGTARGETREQ-001)', () => {
  const PLANT_2 = { id: 'plant-2', name: 'Cherokee', project_id: 'proj-B' }

  it('NEVER PRE-TARGETS: both logone.* keys set → bare cold mount (no draft, no deep-link) → no chip, empty combobox', async () => {
    localStorage.setItem('logone.lastProject', 'proj-B')
    localStorage.setItem('logone.lastPlant', 'plant-1')
    renderEventNew('')
    await flushLoad()
    expect(screen.queryByTestId('evtnew-planting-chip')).toBeNull()
    expect(screen.getByLabelText('Plant or group').value).toBe('')
  })

  it('RANKED FIRST: the remembered planting leads the opened picker with a visible "recent" marker', async () => {
    dataRef.plants = [PLANT, PLANT_2]
    localStorage.setItem('logone.lastProject', 'proj-B')
    localStorage.setItem('logone.lastPlant', 'plant-1')
    renderEventNew('')
    await flushLoad()
    fireEvent.focus(screen.getByLabelText('Plant or group'))
    await waitFor(() => {
      const rows = screen.getAllByRole('option')
      // Name sort would put Cherokee first; the recent hoist must beat it, visibly marked.
      expect(rows[0].textContent).toContain('Sungold')
      expect(within(rows[0]).getByText('recent')).toBeTruthy()
      expect(rows[1].textContent).toContain('Cherokee')
    })
  })
})
