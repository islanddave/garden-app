// V4-READYTRAYIMPRESSION-001 — the weigh-in tray's impression beacon, wired end to end in EventNew.
//
// Dave, this session, on the tray this measures: "I use it regularly. I love it." — which is the
// precondition recon §"PROPOSED MINIMAL DESIGN" made blocking, now answered.
//
// WHAT THIS FILE PROVES that the two unit suites cannot: the beacon fires from the REAL merge
// (readiness candidates + recency fallback), carries the region split the REAL collapse produces,
// fires ONCE per tray load rather than once per interaction — and, the assertion that outranks all
// of the others, that a beacon which fails in every way available to it cannot touch the tray, the
// chip queue, or a harvest save.
//
// Companion suites: readyImpressions.test.js (the pure builder), lambda/harvests/
// ready-impression.test.js (the writer + day grain), EventNew.harvestSessionQueue.test.jsx (the
// queue mechanics this must not disturb).

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { HARVEST_TRAY_COLLAPSED_MAX } from '../lib/harvestTray.js'
import { READY_MODEL_VERSION } from '../lib/readyImpressions.js'

const { apiFetchSpy, navigateSpy, postCalls, impressionCalls, dataRef, searchParamsRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  postCalls: [],
  impressionCalls: [],
  dataRef: {
    projects: [], locations: [], plants: [],
    ready: { candidates: [], et_doy: 226 },
    harvests: { entries: [] },
    // How the impression endpoint misbehaves this test: 'ok' | 'reject' | 'throw'
    impressionMode: 'ok',
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

// Identity ranking — the tray order IS the fixture order, so region/slot claims are checkable
// without re-implementing the readiness model here (it has its own suite).
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
// 14 — the tray's own fetch cap, i.e. the worst case that ships, and the case where the collapse
// actually splits the list into shown vs behind-the-disclosure.
const N = 14
const CANDIDATES = Array.from({ length: N }, (_, i) => ({
  plant_id: `plant-${i + 1}`, project_id: 'proj-1', name: `Planting ${i + 1}`,
  // The frozen model claim the tray carries but never renders.
  overdue_ratio: 3 - i / 10, days_since_last_harvest: 9 - i, repeat_interval_days: 4,
}))
const PLANTS = CANDIDATES.map(c => ({
  id: c.plant_id, name: c.name, project_id: 'proj-1', variety_ref: { crop_type_slug: 'tomato' },
}))

function wireApiFetch() {
  apiFetchSpy.mockImplementation((path, options = {}) => {
    // BEFORE the /api/harvests prefix branch below — it would otherwise swallow this path.
    if (path === '/api/harvests/ready-impressions') {
      if (dataRef.impressionMode === 'throw') throw new Error('synchronous transport failure')
      impressionCalls.push(JSON.parse(options.body))
      return dataRef.impressionMode === 'reject'
        ? Promise.reject(Object.assign(new Error('Internal server error'), { status: 500 }))
        : Promise.resolve({ accepted: impressionCalls.at(-1).impressions.length })
    }
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

async function flushLoad() {
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/projects'))
  await act(async () => { await Promise.resolve() })
}

async function trayReady() {
  await flushLoad()
  await waitFor(() => expect(screen.getByTestId('harvest-session-tray')).toBeTruthy())
}

const tap = async (testId) => { await act(async () => { fireEvent.click(screen.getByTestId(testId)) }) }

async function saveViaButton({ qty, weight }) {
  fireEvent.change(screen.getByLabelText('Harvest quantity'), { target: { value: qty } })
  if (weight != null) fireEvent.change(screen.getByLabelText('Harvest weight'), { target: { value: weight } })
  await act(async () => { fireEvent.click(screen.getByText('Save')) })
}

beforeEach(() => {
  apiFetchSpy.mockReset()
  navigateSpy.mockReset()
  postCalls.length = 0
  impressionCalls.length = 0
  searchParamsRef.current = new URLSearchParams()
  dataRef.projects = [PROJECT]
  dataRef.locations = []
  dataRef.plants = PLANTS
  dataRef.ready = { candidates: CANDIDATES, et_doy: 226 }
  dataRef.harvests = { entries: [] }
  dataRef.impressionMode = 'ok'
  localStorage.clear()
  wireApiFetch()
})

describe('EventNew — weigh-in tray impression beacon (V4-READYTRAYIMPRESSION-001)', () => {
  it('records every offered chip once, split by what the COLLAPSED tray actually renders', async () => {
    renderEventNew()
    await trayReady()

    expect(impressionCalls).toHaveLength(1)
    const { model_version: modelVersion, impressions } = impressionCalls[0]
    expect(modelVersion).toBe(READY_MODEL_VERSION)
    expect(impressions).toHaveLength(N)

    // Exactly the chips on screen are region=tray; the rest are behind "Show N more".
    const rendered = screen.getAllByTestId(/^session-chip-/).map(el => el.dataset.testid.replace('session-chip-', ''))
    expect(rendered).toHaveLength(HARVEST_TRAY_COLLAPSED_MAX)
    expect(impressions.filter(r => r.region === 'tray').map(r => r.plant_id)).toEqual(rendered)
    expect(impressions.filter(r => r.region === 'tray_tail')).toHaveLength(N - HARVEST_TRAY_COLLAPSED_MAX)

    // Slots are 1-based within each region, in rank order.
    expect(impressions.filter(r => r.region === 'tray').map(r => r.slot)).toEqual([1, 2, 3, 4, 5, 6])
    expect(impressions.filter(r => r.region === 'tray_tail')[0].slot).toBe(1)
  })

  // RECON §7c — the prerequisite. Ready candidates and the BUG-HARVTRAYEMPTY-001 recency fallback
  // are one flat array on screen; without this flag every rate would average two populations.
  it('distinguishes a readiness-model chip from a recency-fallback chip, and freezes only the model claim', async () => {
    dataRef.ready = { candidates: [CANDIDATES[0]], et_doy: 226 }
    dataRef.harvests = { entries: [
      { plant_id: 'plant-9', project_id: 'proj-1', planting_name: 'Ground Cherry', planting_removed: false },
    ] }
    renderEventNew()
    await trayReady()

    const [model, fallback] = impressionCalls[0].impressions
    expect(model).toMatchObject({
      plant_id: 'plant-1', source: 'ready', region: 'tray', slot: 1,
      overdue_ratio: 3, days_since_last_harvest: 9, repeat_interval_days: 4,
    })
    expect(fallback).toMatchObject({ plant_id: 'plant-9', source: 'recent', region: 'tray', slot: 2 })
    expect(fallback.overdue_ratio).toBeNull()
    expect(fallback.days_since_last_harvest).toBeNull()
  })

  // THE DAY GRAIN, client half (watch-route.js:525-528's reasoning, adopted wholesale): one row per
  // card per day. The server's uq_ready_impression_day + ON CONFLICT is the enforcement; this pins
  // that the client does not spam it once per tap, which would turn the log into a measure of how
  // fast Dave weighs rather than what he was offered.
  it('fires ONCE per tray load — tapping, queueing and expanding do not re-fire it', async () => {
    renderEventNew()
    await trayReady()
    expect(impressionCalls).toHaveLength(1)

    await tap('session-chip-plant-1')
    await tap('session-chip-plant-2')
    await tap('harvest-tray-toggle')            // expand: all 14 now on screen
    await tap('harvest-tray-toggle')            // and collapse again
    expect(screen.getAllByTestId(/^session-chip-/).length).toBe(HARVEST_TRAY_COLLAPSED_MAX)
    expect(impressionCalls).toHaveLength(1)

    await saveViaButton({ qty: '12', weight: '340' })
    expect(postCalls).toHaveLength(1)
    expect(impressionCalls).toHaveLength(1)
  })

  // ── THE LOAD-BEARING ONE ────────────────────────────────────────────────────────────────────────
  // MUTATION TARGET: remove sendReadyImpressions' try/catch, or await it in the effect, and this
  // goes red — a telemetry failure would take out the tray that Dave says he uses regularly.
  it.each([['a rejected POST', 'reject'], ['a synchronously throwing transport', 'throw']])(
    'cannot break the weigh-in: %s still renders the tray, queues chips and saves the harvest',
    async (_label, mode) => {
      dataRef.impressionMode = mode
      const unhandled = vi.fn()
      process.on('unhandledRejection', unhandled)
      try {
        renderEventNew()
        await trayReady()

        // The tray is intact and the queue still works.
        expect(screen.getAllByTestId(/^session-chip-/).length).toBe(HARVEST_TRAY_COLLAPSED_MAX)
        await tap('session-chip-plant-1')
        await tap('session-chip-plant-2')
        expect(screen.getByTestId('session-chip-plant-2').getAttribute('aria-label')).toContain('queued 1')

        // And the harvest saves, with both ids, exactly as it does with a healthy beacon.
        await saveViaButton({ qty: '12', weight: '340' })
        expect(postCalls).toHaveLength(1)
        expect(postCalls[0].plant_id).toBe('plant-1')
        expect(postCalls[0].project_id).toBe('proj-1')
        expect(screen.getByTestId('harvest-session-strip').textContent).toContain('Planting 1 — 12 count · 340 g')

        // Auto-advance to the queued chip survived too.
        expect(screen.getByTestId('session-chip-plant-2').getAttribute('aria-label')).toContain('weighing now')

        await act(async () => { await Promise.resolve() })
        expect(unhandled).not.toHaveBeenCalled()
      } finally {
        process.off('unhandledRejection', unhandled)
      }
    })

  it('records nothing when there is no tray: outside session mode, and on an empty merge', async () => {
    renderEventNew('event_type=harvest')
    await flushLoad()
    expect(screen.queryByTestId('harvest-session-tray')).toBeNull()
    expect(impressionCalls).toHaveLength(0)

    impressionCalls.length = 0
    dataRef.ready = { candidates: [], et_doy: 226 }
    renderEventNew()
    await flushLoad()
    expect(screen.queryByTestId('harvest-session-tray')).toBeNull()
    expect(impressionCalls).toHaveLength(0)
  })
})
