// V4-HARVTRAYVIEWPORT-001 — the weigh-in tray against the keyboard-shrunk viewport.
//
// Dave, this session: "I use it regularly. I love it. I do have issues with the reduced viewport
// size." Measured from the source CSS at 390px, 14 chips wrap to 6-8 rows (14 for long planting
// names), rendering a 387-835px card against the ~500px layout viewport the soft keyboard leaves.
//
// WHAT THIS FILE CAN AND CANNOT PROVE. jsdom returns zero rects, so no assertion here is a pixel
// claim — the height bound is pinned as a style contract in harvestTray.test.js, and the on-device
// numbers need Dave's pass (lane report §device). What IS assertable, and is pinned below: the
// collapse/expand state machine, the cap, that rank ORDER survives the cap, that user-queued chips
// are never hidden, that toggling steals no focus, and the aria state a TalkBack user hears.
//
// Companion to EventNew.harvestSessionQueue.test.jsx, which pins the queue MECHANICS on a 3-chip
// fixture (deliberately under the cap, so it renders exactly as before this change).

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { HARVEST_TRAY_COLLAPSED_MAX } from '../lib/harvestTray.js'

const { apiFetchSpy, navigateSpy, postCalls, dataRef, searchParamsRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  postCalls: [],
  dataRef: {
    projects: [], locations: [], plants: [],
    ready: { candidates: [], et_doy: 226 },
    harvests: { entries: [] },
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

// Identity ranking — the tray order IS the fixture order, so "rank preserved" is checkable.
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
// 14 — the tray's own fetch cap (EventNew.jsx `.slice(0, 14)`), i.e. the worst case that ships.
const N = 14
const CANDIDATES = Array.from({ length: N }, (_, i) => ({
  plant_id: `plant-${i + 1}`, project_id: 'proj-1', name: `Planting ${i + 1}`,
}))
const PLANTS = CANDIDATES.map(c => ({
  id: c.plant_id, name: c.name, project_id: 'proj-1', variety_ref: { crop_type_slug: 'tomato' },
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
    if (path === '/api/events/harvest-ready') return Promise.resolve(dataRef.ready)
    if (path.startsWith('/api/harvests')) return Promise.resolve(dataRef.harvests)
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

async function trayReady() {
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/projects'))
  await act(async () => { await Promise.resolve() })
  await waitFor(() => expect(screen.getByTestId('harvest-session-tray')).toBeTruthy())
}

const chipNames = () => screen.getAllByTestId(/^session-chip-/).map(el => el.textContent.trim())
const tap = async (testId) => { await act(async () => { fireEvent.click(screen.getByTestId(testId)) }) }

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
  localStorage.clear()
  wireApiFetch()
})

describe('EventNew — weigh-in tray viewport bound (V4-HARVTRAYVIEWPORT-001)', () => {
  it('shows the top of the rank, not all 14, and states how many are hidden', async () => {
    renderEventNew()
    await trayReady()
    expect(screen.getAllByTestId(/^session-chip-/)).toHaveLength(HARVEST_TRAY_COLLAPSED_MAX)
    expect(chipNames()).toEqual(['Planting 1', 'Planting 2', 'Planting 3', 'Planting 4', 'Planting 5', 'Planting 6'])
    const toggle = screen.getByTestId('harvest-tray-toggle')
    expect(toggle.textContent).toContain(`Show ${N - HARVEST_TRAY_COLLAPSED_MAX} more`)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
  })

  it('the tray is STILL THERE and still one tap from every chip — collapsed is not hidden', async () => {
    renderEventNew()
    await trayReady()
    // The affordance Dave says he loves: tap a chip, it arms the form, qty takes focus. Unchanged.
    await tap('session-chip-plant-1')
    expect(screen.getByTestId('session-chip-plant-1').getAttribute('aria-label')).toContain('weighing now')
    expect(document.activeElement?.id).toBe('harvest-quantity')
    // And a chip below the cap is reachable in exactly one extra tap.
    await tap('harvest-tray-toggle')
    await tap('session-chip-plant-12')
    expect(screen.getByTestId('session-chip-plant-12').getAttribute('aria-label')).toContain('queued 1')
  })

  it('expanding reveals all 14 in rank order and flips the announced state', async () => {
    renderEventNew()
    await trayReady()
    await tap('harvest-tray-toggle')
    expect(screen.getAllByTestId(/^session-chip-/)).toHaveLength(N)
    expect(chipNames()[0]).toBe('Planting 1')
    expect(chipNames()[N - 1]).toBe('Planting 14')
    const toggle = screen.getByTestId('harvest-tray-toggle')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.textContent).toContain('Show fewer')
    // Round trip.
    await tap('harvest-tray-toggle')
    expect(screen.getAllByTestId(/^session-chip-/)).toHaveLength(HARVEST_TRAY_COLLAPSED_MAX)
  })

  it('a chip queued from the expanded tray survives the collapse', async () => {
    renderEventNew()
    await trayReady()
    await tap('session-chip-plant-1')          // current
    await tap('harvest-tray-toggle')
    await tap('session-chip-plant-13')         // queued, ranks well below the cap
    await tap('harvest-tray-toggle')           // collapse again
    const chip13 = screen.getByTestId('session-chip-plant-13')
    expect(chip13.getAttribute('aria-label')).toContain('queued 1')
    expect(chip13.textContent).toContain('· 1')
    // …and it did not displace the current chip.
    expect(screen.getByTestId('session-chip-plant-1').getAttribute('aria-label')).toContain('weighing now')
  })

  it('a logged chip yields its slot to a candidate that has not been picked yet', async () => {
    renderEventNew()
    await trayReady()
    await tap('session-chip-plant-1')
    fireEvent.change(screen.getByLabelText('Harvest quantity'), { target: { value: '3' } })
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    await waitFor(() => expect(postCalls).toHaveLength(1))
    // plant-1 is done and no longer current (empty queue clears the planting), so rank 7 moves up.
    await waitFor(() => expect(chipNames()).toContain('Planting 7'))
    expect(chipNames()).not.toContain('✓ Planting 1')
    expect(screen.getAllByTestId(/^session-chip-/)).toHaveLength(HARVEST_TRAY_COLLAPSED_MAX)
    // It is not lost — expanding still finds it, marked done.
    await tap('harvest-tray-toggle')
    expect(screen.getByTestId('session-chip-plant-1').textContent).toContain('✓')
  })

  it('toggling steals no focus and fires no save', async () => {
    renderEventNew()
    await trayReady()
    await tap('session-chip-plant-2')
    expect(document.activeElement?.id).toBe('harvest-quantity')
    await tap('harvest-tray-toggle')
    // The disclosure must not yank the caret out of the field Dave is typing a weight into.
    expect(document.activeElement?.id).toBe('harvest-quantity')
    expect(postCalls).toHaveLength(0)
  })

  it('the toggle is a real disclosure for AT: aria-expanded + aria-controls onto the tray', async () => {
    renderEventNew()
    await trayReady()
    const tray = screen.getByTestId('harvest-session-tray')
    const toggle = screen.getByTestId('harvest-tray-toggle')
    expect(toggle.getAttribute('type')).toBe('button')          // never submits the form
    expect(toggle.getAttribute('aria-controls')).toBe(tray.id)
    expect(tray.id).toBeTruthy()
    expect(tray.getAttribute('role')).toBe('group')
    expect(tray.getAttribute('aria-label')).toBe('Weigh-in queue')
    // Hidden chips are UNRENDERED, not visually hidden — no phantom tab stops, no AT ghosts.
    expect(screen.queryByTestId('session-chip-plant-14')).toBeNull()
  })

  it('the chip container is a bounded, contained scrollport', async () => {
    renderEventNew()
    await trayReady()
    const style = screen.getByTestId('harvest-session-tray').style
    // Style contract only — jsdom resolves no pixels. The device pass is what proves the height.
    expect(style.maxHeight).toContain('dvh')
    expect(style.overflowY).toBe('auto')
    expect(style.overscrollBehavior).toBe('contain')
  })

  it('no toggle at all when everything already fits', async () => {
    dataRef.ready = { candidates: CANDIDATES.slice(0, HARVEST_TRAY_COLLAPSED_MAX), et_doy: 226 }
    renderEventNew()
    await trayReady()
    expect(screen.getAllByTestId(/^session-chip-/)).toHaveLength(HARVEST_TRAY_COLLAPSED_MAX)
    expect(screen.queryByTestId('harvest-tray-toggle')).toBeNull()
  })

  it('the section label is the one-line copy (the two-line original cost ~15px of the fix)', async () => {
    renderEventNew()
    await trayReady()
    expect(screen.getByText('Weigh-in queue — tap in weighing order')).toBeTruthy()
  })
})
