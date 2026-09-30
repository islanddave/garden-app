// V5-TODAYREDESIGN-001 S4g — flipping the per-device switch V1 ↔ V2 (TodayRoute) keeps what Dave already did today.
// Plan-v2 §8 S4 "Flag flip V1 ↔ V2 keeps skips and logs", on Dave's real 2026-09-24 plan, through the real chooser,
// the real V1 Today, the real TodayV2 and the real useDailyPlan; only the wire is stubbed. Neither page keeps the
// other's in-memory state (V1's fades and V2's today-logged store both die with their page), so each path is:
//   · SKIPS — the ONE shared careStore set ('today-skipped:<date>', src/components/today/careStore.js), which both
//     lists read through useCareActions: a skip on either page is gone from the other the moment it mounts.
//   · LOGS  — the plan read's `done` annotation: the stub server keeps every POSTed event and folds them into the
//     next GET /api/daily-plan with the read path's own applyDone (lambda/daily-plan-read/doneEvents.js), and
//     buildCareNeeded drops `done` items on both pages.
// Each is proved red with its path broken (build-s4g.md). No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act, cleanup, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { applyDone } from '../../lambda/daily-plan-read/doneEvents.js'

const F = (f) => JSON.parse(readFileSync(resolve(process.cwd(), 'tests/harness/_todaymeasure', f), 'utf8'))
const { server, fixtures } = vi.hoisted(() => ({
  server: { events: new Map(), seq: 0, planReads: 0 },
  fixtures: { payload: null, plants: null, locations: null, withPath: null },
}))
vi.mock('../lib/featureFlags.js', async (orig) => ({ ...(await orig()), TODAY_V2_PREVIEW_ROW: true }))
vi.mock('../context/PrefsContext.jsx', () => ({ usePrefs: () => ({ prefs: null, prefsLoaded: true, refreshPrefs: async () => null }) }))
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => ({ user: { id: 'u' } }) }))
vi.mock('../context/ToastContext.jsx', () => ({ useOptionalToast: () => ({ show: () => {}, showUndo: () => {}, dismiss: () => {} }) }))
vi.mock('../hooks/useLiveRain.js', () => ({ useLiveRain: () => ({ liveHydrology: null, refreshedAt: null, loading: false }) }))
vi.mock('../lib/notificationPrefsClient.js', async (orig) => ({ ...(await orig()), fetchNotificationPrefs: vi.fn(async () => null), saveTodaySkipped: vi.fn(async () => null) }))
vi.mock('../hooks/useCachedFetch.js', () => ({
  useCachedFetch: (path) => ({
    data: path === '/api/plants' ? fixtures.plants : path === '/api/locations' ? fixtures.locations : path === '/api/locations/with-path' ? fixtures.withPath : [],
    loading: false, error: null, refresh: () => {},
  }),
}))
// The stub server: events are kept by id; the plan read folds them in with the read path's own applyDone. ONE
// fetch function for the whole file (hoisted): useDailyPlan's run is keyed on its identity, so a new one per call
// would refetch on every render.
const { api } = vi.hoisted(() => {
  const fetch = async (path, init = {}) => {
    const method = (init.method || 'GET').toUpperCase()
    if (/^\/api\/daily-plan(\?|$)/.test(path)) {
      server.planReads++
      const sat = new Set([...server.events.values()].map((e) => `${e.plant_id}|${e.event_type}`))
      return { ...fixtures.payload, plan: server.applyDone(fixtures.payload.plan, sat) }
    }
    if (path === '/api/events' && method === 'POST') { const id = 'ev' + (++server.seq); server.events.set(id, JSON.parse(init.body)); return { id } }
    if (path.startsWith('/api/events/') && method === 'DELETE') { server.events.delete(path.split('/').pop()); return {} }
    if (path === '/api/members') return { members: [] }
    return []
  }
  return { api: { fetch, getToken: async () => 't' } }
})
vi.mock('../lib/api.js', async (orig) => ({ ...(await orig()), useApiFetch: () => api }))

import TodayRoute from '../components/today/v2/TodayRoute.jsx'
import { writeTodayV2Flag } from '../lib/todayV2Flag.js'
import { __resetDailyPlanSeed } from '../hooks/useDailyPlan.js'
import { readSkipped } from '../components/today/careStore.js'

const PAYLOAD = F('dailyplan.dave.json')
const TODAY = PAYLOAD.plan_date
const settle = () => act(async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0)) })

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear()
  __resetDailyPlanSeed()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(TODAY + 'T14:30:00.000Z'))
  server.events = new Map(); server.seq = 0; server.planReads = 0; server.applyDone = applyDone
  const p = F('plants.json')
  fixtures.payload = PAYLOAD; fixtures.plants = Array.isArray(p) ? p : p.plants
  fixtures.locations = F('locations.full.json'); fixtures.withPath = F('locations.json')
})
afterEach(() => { cleanup(); vi.useRealTimers() })

// V1: its own list's "Log all watering (N)" — N = the active water rows V1 shows. V2: the Needs care count.
const v1Water = () => {
  const b = screen.queryAllByRole('button').find((x) => /^Log all watering \(\d+\)$/.test(x.getAttribute('aria-label') || ''))
  return b ? Number(b.getAttribute('aria-label').match(/\((\d+)\)/)[1]) : null
}
const v2Count = () => Number(screen.getByTestId('today-sec-care').getAttribute('data-count'))
const flip = async (on) => { act(() => writeTodayV2Flag(on)); await settle() }
const onV1 = () => !document.querySelector('[data-today-version="2"]') && screen.queryAllByTestId('today-care').length > 0
const onV2 = () => !!document.querySelector('[data-today-version="2"][data-today-ready="true"]')
// V1's first WATER row on screen (its lead group opens by itself), and one of its controls.
const firstWaterRow = () => screen.getAllByTestId('care-row').find((r) => r.querySelector('button[aria-label^="Log Water for "]'))
const control = (row, prefix) => [...row.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '').startsWith(prefix))

describe('flipping V1 ↔ V2 keeps what was done today (plan-v2 §8 S4)', () => {
  it('SKIPS: a V1 Skip is gone in V2, and a V2 Not today is gone in V1 — the one shared careStore set', async () => {
    render(<MemoryRouter><TodayRoute /></MemoryRouter>)
    await settle()
    expect(onV1()).toBe(true)
    const water0 = v1Water()
    expect(water0).toBe(168)
    fireEvent.click(control(firstWaterRow(), 'Skip '))
    await settle()
    expect(v1Water()).toBe(167)
    expect(readSkipped().size).toBe(1)

    await flip(true)
    expect(onV2()).toBe(true)
    expect(v2Count()).toBe(232)
    const spot = (n) => document.querySelector(`[data-testid="care-spot"][data-spot="${n}"]`)
    fireEvent.click(within(spot('Drive-Shade')).getByRole('button', { name: 'Not today: Drive-Shade' }))
    await settle()
    expect(v2Count()).toBe(227)

    await flip(false)
    expect(onV1()).toBe(true)
    expect(v1Water()).toBe(162)
    expect(server.events.size).toBe(0)
  })

  it('LOGS: a V1 log is gone in V2 and a V2 Water all is gone in V1 — each page reads the plan the read path annotated done', async () => {
    render(<MemoryRouter><TodayRoute /></MemoryRouter>)
    await settle()
    expect(onV1()).toBe(true)
    expect(v1Water()).toBe(168)
    fireEvent.click(control(firstWaterRow(), 'Log Water for '))
    await settle()
    expect(server.events.size).toBe(1)
    expect(v1Water()).toBe(167)

    const reads = server.planReads
    await flip(true)
    expect(onV2()).toBe(true)
    expect(server.planReads).toBe(reads + 1)
    expect(v2Count()).toBe(232)
    const spot = (n) => document.querySelector(`[data-testid="care-spot"][data-spot="${n}"]`)
    fireEvent.click(within(spot('Drive-Shade')).getByRole('button', { name: 'Water all 5 in Drive-Shade' }))
    await settle()
    expect(server.events.size).toBe(6)
    expect(v2Count()).toBe(227)

    await flip(false)
    expect(onV1()).toBe(true)
    expect(v1Water()).toBe(162)
    expect(readSkipped().size).toBe(0)
  })
})
