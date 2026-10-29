// Today fetched /api/plants TWICE on one paint: the old page's StorageDeadlineAlert and CareNeeded each ran their own
// mount-time read of the same list, with no shared cache between them. For Dave that response is 243 rows carrying
// 225 presigned URLs (~0.5-1 MB), so the duplicate was the single largest avoidable payload on the app's
// highest-traffic surface. Every consumer reads through useCachedFetch, so dataCache's in-flight dedup collapses
// them to one request.
//
// V5-TODAYREDESIGN-001 S8c (L8): ported from todayPlantsDedupe.test.jsx when the old page was removed. The
// redesign has THREE readers of the list on one paint — Needs care (useNeedsCare), Protect tonight (useProtect) and
// Heads-up (useHeadsUp, the storage windows) — plus a section per household member, so the property matters more,
// not less. Mounted with a Clerk sub present: the PRODUCTION configuration and the only one where dedup is reachable
// (useCachedFetch falls back to a plain per-component fetch with no sub, so nothing is cached under an absent
// identity). The real useCachedFetch and dataCache; only the wire, the plan read and prefs are stubbed.
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act, cleanup, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { planState, prefsState, auth, wire } = vi.hoisted(() => ({
  planState: { current: null },
  prefsState: { current: { prefs: null, prefsLoaded: true, refreshPrefs: async () => null } },
  auth: { user: { id: 'user_dave' }, profile: { id: 'user_dave' } },
  wire: (globalThis.__dedupewire = { calls: [], seq: 0 }),
}))
const api = vi.hoisted(() => ({
  value: {
    getToken: async () => 't',
    fetch: async (path, init = {}) => {
      const w = globalThis.__dedupewire
      w.calls.push([path, init])
      if (init.method === 'POST' && path === '/api/events') return { id: 'ev' + (++w.seq) }
      if (path === '/api/plants') return [
        { id: 'p1', name: 'Bhut Jolokia', status: 'vegetative', location_id: 'loc1', container_type: 'pot', featured_photo_id: null, featured_photo_view_url: null, variety_ref: { id: 'v1', name: 'Bhut Jolokia', crop_type_slug: 'pepper' } },
        { id: 'p2', name: 'Habanero', status: 'vegetative', location_id: 'loc1', container_type: 'pot', featured_photo_id: null, featured_photo_view_url: null, variety_ref: { id: 'v3', name: 'Habanero', crop_type_slug: 'pepper' } },
        { id: 'p-sp1', name: 'Beauregard', status: 'vegetative', location_id: 'loc1', container_type: 'in_ground', featured_photo_id: null, featured_photo_view_url: null, variety_ref: { id: 'v2', name: 'Beauregard', crop_type_slug: 'sweet_potato' } },
        { id: 'j1', name: 'Jen Basil', status: 'vegetative', location_id: 'loc1', container_type: 'pot', featured_photo_id: null, featured_photo_view_url: null, variety_ref: { id: 'v4', name: 'Basil', crop_type_slug: 'basil' } },
      ]
      if (path === '/api/locations') return { locations: [{ id: 'loc1', name: w.locName || 'Bed 3', parent_id: null, covered: false }] }
      if (path === '/api/members') return { members: [{ id: 'user_dave', display_name: 'Dave' }, { id: 'member_jen', display_name: 'Jen' }] }
      if (path === '/api/harvests/watch?limit=200') return { candidates: [], snoozed: [] }
      if (String(path).startsWith('/api/harvests?')) return { entries: [], aggregates: null }
      if (path === '/api/preservation/use-soon') return { items: [] }
      return null
    },
  },
}))
vi.mock('../hooks/useDailyPlan.js', () => ({ useDailyPlan: () => planState.current }))
vi.mock('../context/PrefsContext.jsx', () => ({ usePrefs: () => prefsState.current }))
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => auth }))
vi.mock('../lib/notificationPrefsClient.js', async (orig) => ({ ...(await orig()), fetchNotificationPrefs: vi.fn(async () => null), saveTodaySkipped: vi.fn(async () => null) }))
vi.mock('../lib/api.js', async (orig) => ({ ...(await orig()), useApiFetch: () => api.value }))

import TodayV2 from '../pages/TodayV2.jsx'
import { __resetDataCache, refreshAll } from '../lib/dataCache.js'
import { writeShowOthers } from '../lib/householdView.js'
import * as store from '../components/today/v2/needsCareStore.js'

// 2026-10-01: inside the sweet-potato check window (09-28 … 10-10), so Heads-up has its window to read off the list.
const TODAY = '2026-10-01'
const row = (id, name, extra = {}) => ({ id, name, crop: 'pepper', project: 'Peppers', project_id: 'prP', overdue_by: 3, in_ground: false, ...extra })
const plan = () => ({
  hydrology: { tomorrow_precip_in: 0.05, tomorrow_pop: 10 },
  rain_skipped: [],
  water_due: [row('p1', 'Bhut Jolokia'), row('p2', 'Habanero')],
  no_history: [], fertilize: [], pest: [], dormant: [],
  cold: [{ id: 'p1', name: 'Bhut Jolokia', crop: 'pepper', project: 'Peppers', project_id: 'prP', level: 'protect', text: 'Protect tonight (≤ 45°F)' }],
})
const JEN = { water_due: [{ id: 'j1', name: 'Jen Basil', crop: 'basil', project: 'Herbs', project_id: 'prH', overdue_by: 1, in_ground: false }], no_history: [], fertilize: [], pest: [], cold: [], dormant: [] }
const callsTo = (path) => wire.calls.filter((c) => c[0] === path && !(c[1] && c[1].method)).length
const settle = () => act(async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)) })
const mount = async () => { const v = render(<MemoryRouter><TodayV2 /></MemoryRouter>); await settle(); return v }

beforeEach(() => {
  __resetDataCache()
  localStorage.clear(); sessionStorage.clear()
  store.__resetTodayLogged()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(TODAY + 'T14:30:00.000Z'))
  wire.calls = []; wire.seq = 0; wire.locName = null
  planState.current = { data: { has_plan: true, plan_date: TODAY, plan: plan(), household_plans: [] }, loading: false, error: null, reload: vi.fn() }
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('Today — /api/plants is fetched once per paint, not once per section', () => {
  it('Needs care, Protect tonight and Heads-up, all on one page, issue ONE /api/plants request', async () => {
    await mount()
    // All three reached their data off the shared list...
    expect(screen.getByTestId('today-sec-care')).toBeTruthy()
    expect(screen.getByTestId('today-sec-protect')).toBeTruthy()
    expect(screen.getByTestId('today-sec-headsup').textContent).toMatch(/sweet potato/i)
    // ...off a single request.
    expect(callsTo('/api/plants')).toBe(1)
  })

  // BUG-TODAYHOUSEHOLDREFETCH-001 (found at S8c, the port of the old file's "household lens still issues ONE
  // request"): a member's section (HouseholdSection → useNeedsCare) mounts at the ready point, after the page's own
  // reads have settled, and useCachedFetch revalidates on every mount, so the in-flight dedup could not collapse it —
  // TWO /api/plants and two /api/locations per paint with the household view on. The section now takes the page's
  // reads (useNeedsCare `lists`). Her section is asserted present AND joined to spots off those reads (Bed 3 is a
  // location; with no locations her spot would be the project, Herbs), so a section that simply read nothing cannot
  // pass. Opening it mounts her Needs care body, which must not read either.
  it('with the household view on, a member\'s section adds no /api/plants or /api/locations request', async () => {
    writeShowOthers(true)
    planState.current = { data: { ...planState.current.data, household_plans: [{ user_id: 'member_jen', plan: JEN }] }, loading: false, error: null, reload: vi.fn() }
    await mount()
    const hh = screen.getByTestId('today-household')
    expect(callsTo('/api/plants')).toBe(1)
    expect(callsTo('/api/locations')).toBe(1)
    fireEvent.click(hh.querySelector('[aria-expanded]'))
    await settle()
    expect(hh.querySelector('[data-testid="care-spot"]').getAttribute('data-spot')).toBe('Bed 3')
    expect(callsTo('/api/plants')).toBe(1)
    expect(callsTo('/api/locations')).toBe(1)
  })

  // The other half of the fix: her section no longer subscribes to the two lists itself, so a background refresh
  // reaches it only through the page's re-render. A memoised section, or `lists` captured once in a ref or state,
  // would freeze her spots and still pass the count above (review-hhrefetch MINOR 2).
  it('a background refresh still reaches a member\'s open section through the page\'s reads', async () => {
    writeShowOthers(true)
    planState.current = { data: { ...planState.current.data, household_plans: [{ user_id: 'member_jen', plan: JEN }] }, loading: false, error: null, reload: vi.fn() }
    await mount()
    const hh = screen.getByTestId('today-household')
    fireEvent.click(hh.querySelector('[aria-expanded]'))
    await settle()
    expect(hh.querySelector('[data-testid="care-spot"]').getAttribute('data-spot')).toBe('Bed 3')
    wire.locName = 'Bed 9'
    await act(async () => { refreshAll() })
    await settle()
    expect(callsTo('/api/locations')).toBe(2)
    expect(hh.querySelector('[data-testid="care-spot"]').getAttribute('data-spot')).toBe('Bed 9')
  })

  it('a revisit paints from the cache and revalidates once, not once per section', async () => {
    const first = await mount()
    expect(callsTo('/api/plants')).toBe(1)
    first.unmount()
    await mount()
    expect(screen.getByTestId('today-sec-care')).toBeTruthy()
    expect(callsTo('/api/plants')).toBe(2)
  })
})

describe('Today — the shared cache cannot mislead a write', () => {
  it('a spot\'s Water all takes its ids from the plan, never from the cached plants list', async () => {
    await mount()
    const care = screen.getByTestId('today-sec-care')
    if (care.querySelector('[aria-expanded]').getAttribute('aria-expanded') !== 'true') fireEvent.click(care.querySelector('[aria-expanded]'))
    const spotRow = document.querySelector('[data-testid="care-spot"][data-spot="Bed 3"]')
    fireEvent.click(within(spotRow).getByRole('button', { name: 'Water all 2 in Bed 3' }))
    await settle()
    const bodies = wire.calls.filter((c) => c[0] === '/api/events' && c[1].method === 'POST').map((c) => JSON.parse(c[1].body))
    // Both ids come from buildCareNeeded(plan) — the uncached daily-plan read — so no staleness in the shared plants
    // cache can route a log at the wrong planting. This is the property that makes caching safe on a surface Dave
    // logs against.
    expect(bodies.map((b) => [b.plant_id, b.project_id]).sort()).toEqual([['p1', 'prP'], ['p2', 'prP']])
  })
})
