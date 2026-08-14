// V4-HARVSESSION-002 — pre-flight queue + auto-advance + Enter-flow in weigh-in session mode.
// Runs under the REAL prod flag config (PROJECTS_HIDDEN=true, PLANTING_REQUIRED_ENABLED=true):
// the chip must satisfy the required-planting gate AND the plant_id ⇒ project_id invariant with
// no project step rendered. rankHarvestReady is mocked to identity so these tests exercise the
// queue mechanics, not the readiness model (which has its own suite).

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

// ── Hoisted mock plumbing ───────────────────────────────────────────────
const { apiFetchSpy, navigateSpy, postCalls, dataRef, searchParamsRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  postCalls: [],
  dataRef: {
    projects: [],
    locations: [],
    plants: [],
    ready: { candidates: [], et_doy: 226 },
    readyError: null,
  },
  searchParamsRef: { current: new URLSearchParams() },
}))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: apiFetchSpy }),
}))

vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: vi.fn(() => Promise.resolve({ photo: { id: 'p1' } })),
    isUploading: false, error: null, photo: null, stage: null, progress: null, preview: null,
    reset: vi.fn(),
  }),
}))

vi.mock('../lib/featureFlags.js', async (importActual) => ({
  ...(await importActual()),
  PROJECTS_HIDDEN: true,
  PLANTING_REQUIRED_ENABLED: true,
}))

// Identity ranking: tray order == fixture order, no readiness math in scope here.
vi.mock('../lib/harvestReadiness.js', async (importActual) => ({
  ...(await importActual()),
  rankHarvestReady: (candidates) => candidates ?? [],
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
      return Promise.resolve({
        id: `evt-${postCalls.length}`,
        project_id: postCalls[postCalls.length - 1].project_id,
        plant_id: postCalls[postCalls.length - 1].plant_id,
        updated_streak: 1, xp_gained: 10, newly_earned_achievements: [],
      })
    }
    if (options.method === 'DELETE' && path.startsWith('/api/events/')) return Promise.resolve({ ok: true })
    if (path === '/api/events/harvest-ready') {
      return dataRef.readyError ? Promise.reject(dataRef.readyError) : Promise.resolve(dataRef.ready)
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

const PROJECT = { id: 'proj-1', name: 'Tomatoes 2026', status: 'growing' }
const PLANTS = [
  { id: 'plant-1', name: 'Black Cherry #1', project_id: 'proj-1', variety_ref: { crop_type_slug: 'tomato' } },
  { id: 'plant-2', name: 'Sun Sugar #1', project_id: 'proj-1', variety_ref: { crop_type_slug: 'tomato' } },
  { id: 'plant-3', name: 'Pineapple Tomatillo', project_id: 'proj-1', variety_ref: { crop_type_slug: 'tomatillo' } },
]
const CHIPS = {
  candidates: [
    { plant_id: 'plant-1', project_id: 'proj-1', name: 'Black Cherry #1', crop_display_name: 'Tomato' },
    { plant_id: 'plant-2', project_id: 'proj-1', name: 'Sun Sugar #1', crop_display_name: 'Tomato' },
    { plant_id: 'plant-3', project_id: 'proj-1', name: 'Pineapple Tomatillo', crop_display_name: 'Tomatillo' },
  ],
  et_doy: 226,
}

beforeEach(() => {
  apiFetchSpy.mockReset()
  navigateSpy.mockReset()
  postCalls.length = 0
  searchParamsRef.current = new URLSearchParams()
  dataRef.projects = [PROJECT]
  dataRef.locations = []
  dataRef.plants = PLANTS
  dataRef.ready = CHIPS
  dataRef.readyError = null
  localStorage.clear()
  wireApiFetch()
})

async function saveViaButton({ qty, weight }) {
  fireEvent.change(screen.getByLabelText('Harvest quantity'), { target: { value: qty } })
  if (weight != null) fireEvent.change(screen.getByLabelText('Harvest weight'), { target: { value: weight } })
  await act(async () => { fireEvent.click(screen.getByText('Save')) })
}

describe('EventNew — weigh-in pre-flight queue (V4-HARVSESSION-002)', () => {
  it('renders the tray from harvest-ready in rank order, session mode only', async () => {
    renderEventNew('session=harvest')
    await flushLoad()
    await waitFor(() => expect(screen.getByTestId('harvest-session-tray')).toBeTruthy())
    const tray = screen.getByTestId('harvest-session-tray')
    expect(tray.textContent).toContain('Black Cherry #1')
    expect(tray.textContent).toContain('Sun Sugar #1')
    expect(tray.textContent).toContain('Pineapple Tomatillo')
  })

  it('does not fetch harvest-ready outside session mode', async () => {
    renderEventNew('event_type=harvest')
    await flushLoad()
    expect(apiFetchSpy).not.toHaveBeenCalledWith('/api/events/harvest-ready')
    expect(screen.queryByTestId('harvest-session-tray')).toBeNull()
  })

  it('a failed ready fetch renders no tray and leaves the form usable', async () => {
    dataRef.readyError = new Error('boom')
    renderEventNew('session=harvest')
    await flushLoad()
    expect(screen.queryByTestId('harvest-session-tray')).toBeNull()
    expect(screen.getByLabelText('Harvest quantity')).toBeTruthy()
  })

  it('first chip tap becomes CURRENT: fills planting+project, focuses qty, and the save carries both ids', async () => {
    renderEventNew('session=harvest')
    await flushLoad()
    await waitFor(() => expect(screen.getByTestId('session-chip-plant-1')).toBeTruthy())

    await act(async () => { fireEvent.click(screen.getByTestId('session-chip-plant-1')) })
    expect(screen.getByTestId('session-chip-plant-1').getAttribute('aria-label')).toContain('weighing now')
    expect(document.activeElement?.id).toBe('harvest-quantity')

    await saveViaButton({ qty: '12', weight: '340' })
    expect(postCalls.length).toBe(1)
    expect(postCalls[0].plant_id).toBe('plant-1')
    expect(postCalls[0].project_id).toBe('proj-1')
    expect(screen.getByTestId('harvest-session-strip').textContent).toContain('Black Cherry #1 — 12 count · 340 g')
  })

  it('second tap queues with a position suffix; Save auto-advances to it with qty focused', async () => {
    renderEventNew('session=harvest')
    await flushLoad()
    await waitFor(() => expect(screen.getByTestId('session-chip-plant-1')).toBeTruthy())

    await act(async () => { fireEvent.click(screen.getByTestId('session-chip-plant-1')) })
    await act(async () => { fireEvent.click(screen.getByTestId('session-chip-plant-2')) })
    expect(screen.getByTestId('session-chip-plant-2').getAttribute('aria-label')).toContain('queued 1')

    ;(document.activeElement)?.blur?.()
    await saveViaButton({ qty: '12', weight: '340' })

    // chip1 done, chip2 now current, queue drained, qty focused for the next pile
    expect(screen.getByTestId('session-chip-plant-1').textContent).toContain('✓')
    expect(screen.getByTestId('session-chip-plant-2').getAttribute('aria-label')).toContain('weighing now')
    expect(screen.getByTestId('session-chip-plant-2').textContent).not.toContain('· 1')
    expect(document.activeElement?.id).toBe('harvest-quantity')

    await saveViaButton({ qty: '5', weight: '160' })
    expect(postCalls[1].plant_id).toBe('plant-2')
    expect(screen.getByTestId('harvest-session-strip').textContent).toContain('Sun Sugar #1 — 5 count · 160 g')
  })

  it('tapping a queued chip untoggles it', async () => {
    renderEventNew('session=harvest')
    await flushLoad()
    await waitFor(() => expect(screen.getByTestId('session-chip-plant-1')).toBeTruthy())

    await act(async () => { fireEvent.click(screen.getByTestId('session-chip-plant-1')) })
    await act(async () => { fireEvent.click(screen.getByTestId('session-chip-plant-3')) })
    expect(screen.getByTestId('session-chip-plant-3').getAttribute('aria-label')).toContain('queued 1')
    await act(async () => { fireEvent.click(screen.getByTestId('session-chip-plant-3')) })
    expect(screen.getByTestId('session-chip-plant-3').getAttribute('aria-label')).not.toContain('queued')
  })

  it('a done chip can be tapped again for a second picking (separate row, additive totals)', async () => {
    renderEventNew('session=harvest')
    await flushLoad()
    await waitFor(() => expect(screen.getByTestId('session-chip-plant-1')).toBeTruthy())

    await act(async () => { fireEvent.click(screen.getByTestId('session-chip-plant-1')) })
    await saveViaButton({ qty: '12', weight: '340' })
    expect(screen.getByTestId('session-chip-plant-1').textContent).toContain('✓')

    // queue was empty → planting cleared; the done chip becomes current again on tap
    await act(async () => { fireEvent.click(screen.getByTestId('session-chip-plant-1')) })
    expect(screen.getByTestId('session-chip-plant-1').getAttribute('aria-label')).toContain('weighing now')
    await saveViaButton({ qty: '4', weight: '110' })

    expect(postCalls.length).toBe(2)
    expect(postCalls[1].plant_id).toBe('plant-1')
    const strip = screen.getByTestId('harvest-session-strip')
    expect(strip.textContent).toContain('This session: 2 harvests')
    expect(strip.textContent).toContain('450 g')
  })

  it('Enter in qty hops focus to weight; Enter in weight saves (explicit handler, no implicit submission)', async () => {
    renderEventNew('session=harvest')
    await flushLoad()
    await waitFor(() => expect(screen.getByTestId('session-chip-plant-1')).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByTestId('session-chip-plant-1')) })

    const qty = screen.getByLabelText('Harvest quantity')
    const weight = screen.getByLabelText('Harvest weight')
    expect(qty.getAttribute('enterkeyhint')).toBe('next')
    expect(weight.getAttribute('enterkeyhint')).toBe('done')

    fireEvent.change(qty, { target: { value: '12' } })
    fireEvent.keyDown(qty, { key: 'Enter' })
    expect(document.activeElement?.id).toBe('harvest-weight')

    fireEvent.change(weight, { target: { value: '340' } })
    await act(async () => { fireEvent.keyDown(weight, { key: 'Enter' }) })
    expect(postCalls.length).toBe(1)
    expect(postCalls[0].harvest.weight).toBe(340)
  })

  it('outside session mode the Enter hints are absent and Enter in qty does not move focus', async () => {
    renderEventNew('event_type=harvest')
    await flushLoad()
    const qty = screen.getByLabelText('Harvest quantity')
    expect(qty.getAttribute('enterkeyhint')).toBeNull()
    fireEvent.keyDown(qty, { key: 'Enter' })
    expect(document.activeElement?.id).not.toBe('harvest-weight')
  })
})
