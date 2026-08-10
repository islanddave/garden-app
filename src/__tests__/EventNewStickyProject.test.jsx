// V4-LOGTARGET-001 (Lane 2, sticky option b) — Log One (EventNew) sticky memory
// inverted to the PLANTING level. MIGRATED from the V4-STICKY-001 project-sticky
// suite: every project-sticky behavior has a planting-sticky equivalent here, plus
// the key-migration fallback (old logone.lastProject key alone → project-level
// pre-fill) and the seeding INVARIANT (plant_id present ⇒ project_id present — a
// remembered plant is never seeded without its remembered parent project, so a
// POST can never leave as {project_id:'', plant_id:X}, which would 500 on the
// server's exactly_one_parent CHECK).
//
// Keys: logone.lastPlant (new, planting) + logone.lastProject (old, kept — written
// on every save, honored as the project-level fallback). LogMany's quicklog.* keys
// are a separate system and untouched.
//
// Harness mirrors EventNew.test.jsx: useApiFetch → controllable fetch, and
// react-router-dom fully mocked with a hoisted searchParams ref.

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

const { apiFetchSpy, navigateSpy, postCalls, dataRef, searchParamsRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  postCalls: [],
  dataRef: {
    projects: [],
    locations: [],
    plants: [],
    postResult: { id: 'evt-1', updated_streak: 1, xp_gained: 10, newly_earned_achievements: [] },
    postError: null,
  },
  searchParamsRef: { current: new URLSearchParams() },
}))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: apiFetchSpy }),
}))

vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: vi.fn().mockResolvedValue({ photo: { id: 'p1' } }),
    isUploading: false,
    error: null,
    photo: null,
    preview: null,
    reset: vi.fn(),
  }),
}))

// V4-PLANTREQUIRED-001: the flag flipped TRUE in source on 2026-08-10. This suite predates the flip
// and its assertions describe the planting-OPTIONAL behavior, which remains a live configuration
// (rollback = one-line revert). Mocked FALSE so every assertion below keeps covering what it was
// written to cover, rather than being rewritten to the flag-ON world. Flag-ON is covered by
// EventNew.plantRequired.test.jsx and EventNew.plantMismatch.plantRequired.test.jsx.
// importActual spread so every other flag (OVERLAY_ROUTES_ENABLED etc.) keeps its real value.
vi.mock('../lib/featureFlags.js', async (importActual) => ({
  ...(await importActual()),
  PLANTING_REQUIRED_ENABLED: false,
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => (
    <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>
  ),
  useNavigate: () => navigateSpy,
  useSearchParams: () => [searchParamsRef.current, vi.fn()],
}))

import EventNew from '../pages/EventNew.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

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

const PROJECT_A = { id: 'proj-1', name: 'Tomatoes 2026', status: 'growing' }
const PROJECT_B = { id: 'proj-2', name: 'Peppers 2026', status: 'growing' }
const PLANT_A = { id: 'pl-A', name: 'Sungold #1' }
const PLANT_B = { id: 'pl-B', name: 'Sungold #2' }

async function flushLoad() {
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/projects'))
  await act(async () => { await Promise.resolve() })
}

// V4-PLANTPICKER-001: the planting control is the shared PlantingSelect combobox. Picking = focus
// (opens the listbox) + click the ps-opt-<id> row; a made selection renders as the chip
// (evtnew-planting-chip) showing the plant NAME — the raw select .value is gone. An EMPTY
// selection still renders the combobox input, so `.value === ''` assertions remain valid.
async function pickPlanting(id) {
  fireEvent.focus(screen.getByLabelText('Plant or group'))
  fireEvent.click(await screen.findByTestId(`ps-opt-${id}`))
}
const plantingChip = () => screen.getByTestId('evtnew-planting-chip')

beforeEach(() => {
  apiFetchSpy.mockReset()
  navigateSpy.mockReset()
  postCalls.length = 0
  searchParamsRef.current = new URLSearchParams()
  dataRef.projects = [PROJECT_A, PROJECT_B]
  dataRef.locations = []
  dataRef.plants = [PLANT_A, PLANT_B]
  dataRef.postResult = { id: 'evt-1', updated_streak: 1, xp_gained: 10, newly_earned_achievements: [] }
  dataRef.postError = null
  try { localStorage.clear() } catch { /* noop */ }
  wireApiFetch()
})

describe('EventNew — sticky planting (V4-LOGTARGET-001, supersedes V4-STICKY-001 project stickiness)', () => {
  it('writes the chosen planting (and its project) to localStorage on save', async () => {
    renderEventNew('event_type=watering')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-2' } })
    await pickPlanting('pl-B')
    await act(async () => { fireEvent.click(screen.getByText('Save')) })

    expect(postCalls.length).toBe(1)
    expect(postCalls[0].project_id).toBe('proj-2')
    expect(postCalls[0].plant_id).toBe('pl-B')
    expect(localStorage.getItem('logone.lastPlant')).toBe('pl-B')
    expect(localStorage.getItem('logone.lastProject')).toBe('proj-2')
  })

  it('pre-fills the planting and its project on a fresh cold mount (remount) from localStorage', async () => {
    // First session: pick proj-2 + a planting and save (persists both keys).
    const first = renderEventNew('event_type=watering')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-2' } })
    await pickPlanting('pl-B')
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    expect(localStorage.getItem('logone.lastPlant')).toBe('pl-B')
    first.unmount()

    // Cold remount, no deep link: project AND planting pre-fill without interaction.
    renderEventNew('event_type=watering')
    await flushLoad()
    await waitFor(() => {
      expect(screen.getByLabelText('Project').value).toBe('proj-2')
      expect(plantingChip().textContent).toContain('Sungold #2')
    })
    expect(screen.queryByText('Project not found — pick one.')).toBeNull()
    expect(apiFetchSpy).toHaveBeenCalledWith('/api/plants?project_id=proj-2')
  })

  it('pre-fills planting and project directly when localStorage holds valid ids', async () => {
    localStorage.setItem('logone.lastProject', 'proj-1')
    localStorage.setItem('logone.lastPlant', 'pl-A')
    renderEventNew('event_type=watering')
    await flushLoad()
    expect(screen.getByLabelText('Project').value).toBe('proj-1')
    await waitFor(() => {
      expect(plantingChip().textContent).toContain('Sungold #1')
    })
  })

  it('KEY MIGRATION: the old logone.lastProject key alone still pre-fills the project (project-level fallback, no planting)', async () => {
    // Pre-migration device: only the old key exists. The project pre-fills exactly as
    // V4-STICKY-001 did; the planting stays unset (neutral placeholder, no invention).
    localStorage.setItem('logone.lastProject', 'proj-1')
    renderEventNew('event_type=watering')
    await flushLoad()
    expect(screen.getByLabelText('Project').value).toBe('proj-1')
    await waitFor(() => {
      expect(screen.getByLabelText('Plant or group').value).toBe('')
    })
  })

  it('a save without a planting clears logone.lastPlant — remembered is always the LAST save', async () => {
    localStorage.setItem('logone.lastProject', 'proj-1')
    localStorage.setItem('logone.lastPlant', 'pl-A')
    renderEventNew('event_type=watering')
    await flushLoad()
    await waitFor(() => expect(plantingChip().textContent).toContain('Sungold #1'))
    // Deliberately clear the planting, then save at project level.
    fireEvent.click(screen.getByRole('button', { name: 'Clear planting selection' }))
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    expect(postCalls.length).toBe(1)
    expect(postCalls[0].plant_id).toBeNull()
    expect(localStorage.getItem('logone.lastPlant')).toBeNull()
    expect(localStorage.getItem('logone.lastProject')).toBe('proj-1')
  })

  it('deep-linked ?project= wins over the remembered project and suppresses the remembered planting', async () => {
    localStorage.setItem('logone.lastProject', 'proj-1')
    localStorage.setItem('logone.lastPlant', 'pl-A')
    renderEventNew('event_type=watering&project=proj-2')
    await flushLoad()
    await waitFor(() => {
      expect(screen.getByLabelText('Project').value).toBe('proj-2')
    })
    // The remembered planting belongs to the REMEMBERED project — never seeded under
    // a deep-linked project (explicit intent wins; no cross-project plant pairing).
    expect(screen.getByLabelText('Plant or group').value).toBe('')
  })

  it('falls back to no selection (silently) — project AND planting — when the remembered project no longer exists', async () => {
    localStorage.setItem('logone.lastProject', 'ghost-project')
    localStorage.setItem('logone.lastPlant', 'pl-A')
    renderEventNew('event_type=watering')
    await flushLoad()
    await waitFor(() => {
      expect(screen.getByLabelText('Project').value).toBe('')
    })
    // The planting falls WITH its parent project (plant_id ⇒ project_id invariant).
    expect(screen.getByLabelText('Plant or group').value).toBe('')
    // Stale-remembered is NOT the deep-link case — no "Project not found" notice.
    expect(screen.queryByText('Project not found — pick one.')).toBeNull()
  })

  it('a remembered planting that is archived or missing from the live plants is cleared (project kept)', async () => {
    localStorage.setItem('logone.lastProject', 'proj-1')
    localStorage.setItem('logone.lastPlant', 'pl-old')
    dataRef.plants = [{ id: 'pl-old', name: 'Old Sungold', archived_at: '2026-01-01' }, PLANT_A]
    renderEventNew('event_type=watering')
    await flushLoad()
    expect(screen.getByLabelText('Project').value).toBe('proj-1')
    await waitFor(() => {
      expect(screen.getByLabelText('Plant or group').value).toBe('')
    })
  })

  it('does not override an explicit in-session project change', async () => {
    localStorage.setItem('logone.lastProject', 'proj-1')
    localStorage.setItem('logone.lastPlant', 'pl-A')
    renderEventNew('event_type=watering')
    await flushLoad()
    expect(screen.getByLabelText('Project').value).toBe('proj-1')
    // User switches project this session; the load effect must not clobber it.
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-2' } })
    await act(async () => { await Promise.resolve() })
    expect(screen.getByLabelText('Project').value).toBe('proj-2')
  })

  // ── INVARIANT: plant_id present ⇒ project_id present (server exactly_one_parent) ──

  it('INVARIANT: cold-mount sticky seeding always carries the parent project — the POST has BOTH plant_id and project_id', async () => {
    localStorage.setItem('logone.lastProject', 'proj-1')
    localStorage.setItem('logone.lastPlant', 'pl-A')
    renderEventNew('event_type=watering')
    await flushLoad()
    await waitFor(() => expect(plantingChip().textContent).toContain('Sungold #1'))
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    expect(postCalls.length).toBe(1)
    // The seeded submit must NEVER be {project_id:'', plant_id:X} — that 500s server-side.
    expect(postCalls[0].plant_id).toBe('pl-A')
    expect(postCalls[0].project_id).toBe('proj-1')
    expect(postCalls[0].project_id).toBeTruthy()
  })

  it('INVARIANT: a remembered planting with no remembered project is never seeded — no POST can carry a plant without a project', async () => {
    // Corrupt/partial storage state: plant key present, project key absent.
    localStorage.setItem('logone.lastPlant', 'pl-A')
    renderEventNew('event_type=watering')
    await flushLoad()
    // Not seeded: seeding a plant without its parent project is forbidden.
    expect(screen.getByLabelText('Plant or group').value).toBe('')
    // And the submit gate blocks a project-less POST outright.
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    expect(postCalls.length).toBe(0)
    expect(screen.getByText('Select a project.')).toBeTruthy()
  })
})
