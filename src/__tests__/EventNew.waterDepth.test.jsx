// V4-WATERMATH-001 F0 — depth-chip capture on the single-event log flow.
//
// These assertions are deliberately RENDER + PAYLOAD assertions, never source-text or import
// assertions. This codebase has twice shipped an inert feature whose suite asserted a module
// imported something (the colour-window family): a test that reads the source cannot tell a
// wired chip from a dead one. Every test here mounts the real form, queries what a user would
// see, taps what a user would tap, and reads the body that actually reached POST /api/events.

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react'

const { apiFetchSpy, navigateSpy, postCalls, dataRef, searchParamsRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  postCalls: [],
  dataRef: {
    projects: [],
    locations: [],
    plants: [],
    postResult: { id: 'evt-1', project_id: 'proj-1', plant_id: null },
    postError: null,
  },
  searchParamsRef: { current: new URLSearchParams() },
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))

vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: vi.fn(() => Promise.resolve({ photo: { id: 'p1' } })),
    isUploading: false, error: null, photo: null, stage: null, progress: null, preview: null,
    reset: vi.fn(),
  }),
}))

vi.mock('../lib/featureFlags.js', async (importActual) => ({
  ...(await importActual()),
  PROJECTS_HIDDEN: false,
  PLANTING_REQUIRED_ENABLED: false,
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useNavigate: () => navigateSpy,
  useSearchParams: () => [searchParamsRef.current, vi.fn()],
}))

import EventNew from '../pages/EventNew.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

const PROJECT = { id: 'proj-1', name: 'Tomatoes 2026', status: 'growing' }

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

beforeEach(() => {
  apiFetchSpy.mockReset(); navigateSpy.mockReset(); postCalls.length = 0
  searchParamsRef.current = new URLSearchParams()
  dataRef.projects = [PROJECT]; dataRef.locations = []; dataRef.plants = []
  dataRef.postResult = { id: 'evt-1', project_id: 'proj-1', plant_id: null }
  dataRef.postError = null
  try { localStorage.clear() } catch { /* noop */ }
  wireApiFetch()
})

async function flushLoad() {
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/projects'))
  await act(async () => {})
}

async function save() {
  await act(async () => { fireEvent.click(screen.getByText('Save')) })
}

describe('EventNew — water depth chips RENDER', () => {
  it('renders all three chips with their anchors on a watering event', async () => {
    renderEventNew('event_type=watering')
    await flushLoad()
    expect(screen.getByTestId('water-depth-group')).toBeTruthy()
    for (const id of ['water-depth-light', 'water-depth-normal', 'water-depth-deep']) {
      expect(screen.getByTestId(id)).toBeTruthy()
    }
    // The anchor copy is ON the chip — canon Part 3. Rendered, not merely defined.
    expect(screen.getByText('a quick pass')).toBeTruthy()
    expect(screen.getByText('what it needed')).toBeTruthy()
    expect(screen.getByText('soaked to runoff')).toBeTruthy()
  })

  it('preselects Normal — and only Normal', async () => {
    renderEventNew('event_type=watering')
    await flushLoad()
    expect(screen.getByTestId('water-depth-normal').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('water-depth-light').getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByTestId('water-depth-deep').getAttribute('aria-pressed')).toBe('false')
  })

  it('a tap moves the pressed state to the tapped chip', async () => {
    renderEventNew('event_type=watering')
    await flushLoad()
    fireEvent.click(screen.getByTestId('water-depth-deep'))
    expect(screen.getByTestId('water-depth-deep').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('water-depth-normal').getAttribute('aria-pressed')).toBe('false')
  })

  it('does NOT render on a non-watering event type', async () => {
    renderEventNew('event_type=observation')
    await flushLoad()
    expect(screen.queryByTestId('water-depth-group')).toBeNull()
  })
})

describe('EventNew — water depth reaches the POST body', () => {
  it('the untouched default path posts normal/default — zero added taps', async () => {
    renderEventNew('event_type=watering')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await save()
    expect(postCalls.length).toBe(1)
    expect(postCalls[0].metadata).toMatchObject({ water_depth: 'normal', water_depth_source: 'default' })
  })

  it('a tapped chip posts that class with source=user', async () => {
    renderEventNew('event_type=watering')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    fireEvent.click(screen.getByTestId('water-depth-deep'))
    await save()
    expect(postCalls[0].metadata).toMatchObject({ water_depth: 'deep', water_depth_source: 'user' })
  })

  it('re-tapping Normal after Deep records the USER choice, not the default', async () => {
    renderEventNew('event_type=watering')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    fireEvent.click(screen.getByTestId('water-depth-deep'))
    fireEvent.click(screen.getByTestId('water-depth-normal'))
    await save()
    expect(postCalls[0].metadata).toMatchObject({ water_depth: 'normal', water_depth_source: 'user' })
  })

  it('a non-watering event carries no water_depth keys at all', async () => {
    renderEventNew('event_type=observation')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await save()
    expect(postCalls[0].metadata?.water_depth).toBeUndefined()
    expect(postCalls[0].metadata?.water_depth_source).toBeUndefined()
  })

  it('the next entry in a burst resets to the preselected default', async () => {
    dataRef.plants = [{ id: 'pl-1', name: 'Cayenne #1' }, { id: 'pl-2', name: 'Cayenne #2' }]
    renderEventNew('event_type=watering')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    fireEvent.click(screen.getByTestId('water-depth-deep'))
    await save()
    expect(postCalls[0].metadata.water_depth).toBe('deep')
    // Same type kept (V4-EVENTSAVE-001 next-of-type). The class must NOT stick: a silently
    // carried-over Deep would record an amount the user never chose for the next planting.
    await waitFor(() => expect(screen.getByTestId('water-depth-normal').getAttribute('aria-pressed')).toBe('true'))
    await save()
    expect(postCalls[1].metadata).toMatchObject({ water_depth: 'normal', water_depth_source: 'default' })
  })
})

describe('EventNew — the undo toast names the recorded class', () => {
  it('shows the class on the full-page undo toast', async () => {
    renderEventNew('event_type=watering')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    fireEvent.click(screen.getByTestId('water-depth-deep'))
    await save()
    const status = await screen.findByRole('status')
    expect(status.textContent).toMatch(/Deep/)
    expect(status.textContent).toMatch(/soaked to runoff/)
    // Still an OPERATIONAL toast — undo present, no celebration copy (Reward-UX V101).
    expect(screen.getByText('Undo')).toBeTruthy()
  })

  it('names the default class too, so the row is never silently classified', async () => {
    renderEventNew('event_type=watering')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await save()
    const status = await screen.findByRole('status')
    expect(status.textContent).toMatch(/Normal/)
  })

  it('a non-watering save carries no class line', async () => {
    renderEventNew('event_type=observation')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await save()
    const status = await screen.findByRole('status')
    expect(status.textContent).not.toMatch(/soaked to runoff/)
  })
})
