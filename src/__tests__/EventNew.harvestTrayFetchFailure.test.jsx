// BUG-TRAYFETCHSILENT-001 — a failed weigh-in-queue fetch must not read as an empty garden.
//
// Both tray loaders (/api/events/harvest-ready and /api/harvests?include=entries) used to
// `.catch(() => null)`, and the tray only rendered on `readyChips.length > 0` — so a 500, a dropped
// connection, or an expired token produced EXACTLY the pixels a correct "nothing is ready today"
// produces: no section, no message, nothing. Dave, standing in the garden with produce in hand, had
// no way to tell "the model has nothing for me" from "the app never asked".
//
// The discriminating assertion in this file is the PAIR: the failure case and the genuinely-empty
// case are asserted against each other, because either one alone is satisfied by the buggy code.
//
// Harness mirrors EventNew.harvestTrayViewport.test.jsx (same flags, same identity ranking) so the
// two files disagree about nothing except what the fetches do.

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

const { apiFetchSpy, navigateSpy, postCalls, dataRef, searchParamsRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  postCalls: [],
  dataRef: {
    projects: [], locations: [], plants: [],
    ready: { candidates: [], et_doy: 226 },
    harvests: { entries: [] },
    readyFails: false,
    harvestsFails: false,
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
  PROJECTS_HIDDEN: true,
  PLANTING_REQUIRED_ENABLED: true,
}))

// Identity ranking — the tray order IS the fixture order.
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

const PROJECT = { id: 'proj-1', name: 'Kitchen Garden', status: 'growing' }
const CANDIDATES = [
  { plant_id: 'plant-1', project_id: 'proj-1', name: 'Sungold' },
  { plant_id: 'plant-2', project_id: 'proj-1', name: 'Cherokee Purple' },
]
const ENTRIES = [
  { plant_id: 'plant-9', project_id: 'proj-1', planting_name: 'Volunteer squash' },
]
const PLANTS = [...CANDIDATES, { plant_id: 'plant-9', name: 'Volunteer squash' }].map(c => ({
  id: c.plant_id, name: c.name ?? 'Volunteer squash', project_id: 'proj-1',
  variety_ref: { crop_type_slug: 'tomato' },
}))

function wireApiFetch() {
  apiFetchSpy.mockImplementation((path, options = {}) => {
    if (options.method === 'POST' && path === '/api/events') {
      postCalls.push(JSON.parse(options.body))
      const last = postCalls[postCalls.length - 1]
      return Promise.resolve({
        id: `evt-${postCalls.length}`, project_id: last.project_id, plant_id: last.plant_id,
        updated_streak: 1, xp_gained: 10, newly_earned_achievements: [],
      })
    }
    if (path === '/api/events/harvest-ready') {
      return dataRef.readyFails
        ? Promise.reject(new Error('500 harvest-ready'))
        : Promise.resolve(dataRef.ready)
    }
    // The impression beacon POSTs to /api/harvests/ready-impressions — it must not be treated as
    // the entries GET, or a telemetry rejection would masquerade as a tray-load failure.
    if (path.startsWith('/api/harvests') && options.method !== 'POST') {
      return dataRef.harvestsFails
        ? Promise.reject(new Error('network down'))
        : Promise.resolve(dataRef.harvests)
    }
    if (path === '/api/projects') return Promise.resolve(dataRef.projects)
    if (path === '/api/locations/with-path') return Promise.resolve(dataRef.locations)
    if (path.startsWith('/api/plants')) return Promise.resolve(dataRef.plants)
    return Promise.resolve(null)
  })
}

function renderEventNew(query = 'session=harvest') {
  searchParamsRef.current = new URLSearchParams(query)
  return render(<ToastProvider><EventNew /></ToastProvider>)
}

// Both loaders have settled once the projects load has and a microtask flush has run — the same
// settle point EventNew.harvestTrayViewport.test.jsx uses, minus its wait on the tray itself (which
// is exactly the element under dispute here).
async function traySettled() {
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/projects'))
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

const notice = () => screen.queryByTestId('harvest-tray-load-failed')
const chips = () => screen.queryAllByTestId(/^session-chip-/)

beforeEach(() => {
  apiFetchSpy.mockReset()
  navigateSpy.mockReset()
  postCalls.length = 0
  searchParamsRef.current = new URLSearchParams()
  dataRef.projects = [PROJECT]
  dataRef.locations = []
  dataRef.plants = PLANTS
  dataRef.ready = { candidates: CANDIDATES, et_doy: 226 }
  dataRef.harvests = { entries: [] }
  dataRef.readyFails = false
  dataRef.harvestsFails = false
  localStorage.clear()
  wireApiFetch()
})

describe('EventNew — weigh-in tray fetch failure is visible (BUG-TRAYFETCHSILENT-001)', () => {
  // THE bug, stated as the contrast. Neither half proves anything alone: pre-fix, "empty renders
  // nothing" already passed, and the failure case rendered the same nothing.
  it('a total fetch failure and a genuinely empty queue do NOT render the same thing', async () => {
    dataRef.readyFails = true
    dataRef.harvestsFails = true
    const failed = renderEventNew()
    await traySettled()
    await waitFor(() => expect(notice()).toBeTruthy())
    expect(notice().textContent).toContain('Couldn’t load your weigh-in queue')
    expect(chips()).toHaveLength(0)
    failed.unmount()

    // Same surface, same flags, everything succeeds and there is simply nothing ready.
    dataRef.readyFails = false
    dataRef.harvestsFails = false
    dataRef.ready = { candidates: [], et_doy: 226 }
    dataRef.harvests = { entries: [] }
    renderEventNew()
    await traySettled()
    expect(notice()).toBeNull()
    expect(chips()).toHaveLength(0)
    // An empty garden shows no queue section at all — the pre-existing behavior, unchanged.
    expect(screen.queryByText('Weigh-in queue — tap in weighing order')).toBeNull()
  })

  it('the failure notice is announced, not merely drawn', async () => {
    dataRef.readyFails = true
    dataRef.harvestsFails = true
    renderEventNew()
    await traySettled()
    await waitFor(() => expect(notice()).toBeTruthy())
    // TalkBack is how Dave would hear this while holding a basket in both hands.
    expect(notice().getAttribute('role')).toBe('alert')
    // And it is inside the queue section, where the missing chips would have been.
    expect(screen.getByText('Weigh-in queue — tap in weighing order')).toBeTruthy()
  })

  it('a PARTIAL failure shows the surviving chips AND says the queue is incomplete', async () => {
    // Ready model is down; the recency fallback answers. Chips exist, but they are not the queue.
    dataRef.readyFails = true
    dataRef.harvests = { entries: ENTRIES }
    renderEventNew()
    await traySettled()
    await waitFor(() => expect(notice()).toBeTruthy())
    expect(chips().map(c => c.textContent.trim())).toEqual(['Volunteer squash'])
    expect(notice().textContent).toContain('some plantings may be missing')
  })

  it('a partial failure on the OTHER loader is surfaced too', async () => {
    dataRef.harvestsFails = true
    renderEventNew()
    await traySettled()
    await waitFor(() => expect(notice()).toBeTruthy())
    expect(chips().map(c => c.textContent.trim())).toEqual(['Sungold', 'Cherokee Purple'])
    expect(notice().textContent).toContain('some plantings may be missing')
  })

  it('Retry re-runs both loaders and clears the notice when they come back', async () => {
    dataRef.readyFails = true
    dataRef.harvestsFails = true
    renderEventNew()
    await traySettled()
    await waitFor(() => expect(notice()).toBeTruthy())

    dataRef.readyFails = false
    dataRef.harvestsFails = false
    await act(async () => { fireEvent.click(screen.getByTestId('harvest-tray-retry')) })
    await waitFor(() => expect(notice()).toBeNull())
    expect(chips().map(c => c.textContent.trim())).toEqual(['Sungold', 'Cherokee Purple'])
  })

  it('Retry is a button, never a submit — a failed queue must not POST an event', async () => {
    dataRef.readyFails = true
    dataRef.harvestsFails = true
    renderEventNew()
    await traySettled()
    await waitFor(() => expect(notice()).toBeTruthy())
    const retry = screen.getByTestId('harvest-tray-retry')
    expect(retry.getAttribute('type')).toBe('button')
    await act(async () => { fireEvent.click(retry) })
    expect(postCalls).toHaveLength(0)
  })

  it('a failed queue never throws into the weigh-in — the picker path still saves', async () => {
    dataRef.readyFails = true
    dataRef.harvestsFails = true
    renderEventNew()
    await traySettled()
    await waitFor(() => expect(notice()).toBeTruthy())
    // The picker below is the full path and is unaffected by the tray's failure.
    await act(async () => { fireEvent.click(screen.getByTestId('evtnew-planting')) })
    await act(async () => { fireEvent.click(await screen.findByText('Sungold')) })
    fireEvent.change(screen.getByLabelText('Harvest quantity'), { target: { value: '3' } })
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    await waitFor(() => expect(postCalls).toHaveLength(1))
    expect(postCalls[0].plant_id).toBe('plant-1')
  })
})
