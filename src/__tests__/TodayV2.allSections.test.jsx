// V5-TODAYREDESIGN-001 — integration 2 (S4g x S5 x S6, seam 3): the redesigned Today with EVERY section it can hold
// on one page — Protect tonight + Heads-up (S5), Needs care (S4/S4g), Harvest + From your Put-Up + Resting's rows +
// a household member's section (S6) — through the real TodayV2 and the real band hooks on the harness fixtures
// (tests/harness/_todaymeasure), only the wire stubbed. Three lanes each wrote their half of TodayV2's `present`
// line and of Expand / Collapse all; this pins the union: every section in the fixed order (SECTION_ORDER, then the
// household), and Expand all / Collapse all moving every one of them, the household's included. The day is 09-28,
// the first day of the sweet-potato storage window (Heads-up), on Dave's 09-24 plan re-dated to it. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const F = (f) => JSON.parse(readFileSync(resolve(process.cwd(), 'tests/harness/_todaymeasure', f), 'utf8'))
const { planState, prefsState, auth, wire } = vi.hoisted(() => ({
  planState: { current: null },
  prefsState: { current: { prefs: null, prefsLoaded: true, refreshPrefs: async () => null } },
  auth: { user: { id: 'harness_user' }, profile: { id: 'harness_user' } },
  wire: (globalThis.__int2wire = { watch: null, soon: null, plants: null, locations: null, members: null }),
}))
// ONE api object for the file, as the real useApiFetch memoises its own: the band hooks keep `fetch` in their
// effects' deps, so a new function per render would refetch forever.
const api = vi.hoisted(() => {
  const fetch = async (path, init = {}) => {
    const w = globalThis.__int2wire
    if (init.method === 'POST') return { id: 'ev' }
    if (path === '/api/harvests/watch?limit=200') return w.watch
    if (path.startsWith('/api/harvests?')) return { entries: [], aggregates: null }
    if (path === '/api/preservation/use-soon') return w.soon
    return null
  }
  return { value: { getToken: async () => 't', fetch } }
})
vi.mock('../hooks/useDailyPlan.js', () => ({ useDailyPlan: () => planState.current }))
vi.mock('../context/PrefsContext.jsx', () => ({ usePrefs: () => prefsState.current }))
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => auth }))
vi.mock('../lib/notificationPrefsClient.js', async (orig) => ({ ...(await orig()), fetchNotificationPrefs: vi.fn(async () => null), saveTodaySkipped: vi.fn(async () => null) }))
vi.mock('../lib/api.js', async (orig) => ({ ...(await orig()), useApiFetch: () => api.value }))
vi.mock('../hooks/useCachedFetch.js', () => ({
  useCachedFetch: (path) => ({ data: path === '/api/plants' ? wire.plants : path === '/api/members' ? wire.members : wire.locations, loading: false, error: null }),
}))

import TodayV2, { SECTION_ORDER } from '../pages/TodayV2.jsx'

const DAVE = F('dailyplan.dave.json')
const JEN = F('dailyplan.jen.json')
const SG = F('storage-grafts.json')
// The storage state's one SYNTHETIC field (storage-grafts.json): the real 'Sweet Potatoes' planting moved from ended
// to its graft status, so the storage window has a planting to speak for.
const PLANTS = (() => { const p = F('plants.json'); return (Array.isArray(p) ? p : p.plants).map((x) => (x.id === SG.sweet_potato_planting.id ? { ...x, status: SG.sweet_potato_planting.status } : x)) })()
const LOCS = F('locations.full.json')
const DAY = '2026-09-28'
const ALL = ['protect', 'headsup', 'care', 'harvest', 'putup', 'resting', 'hh-member_j']

const settle = () => act(async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)) })
const mount = async () => { render(<MemoryRouter><TodayV2 /></MemoryRouter>); await settle() }
const keys = () => [...document.querySelectorAll('[data-testid^="today-sec-"]')].map((s) => s.getAttribute('data-section'))
const states = () => keys().map((k) => screen.getByTestId(`today-sec-${k}`).querySelector('[aria-expanded]').getAttribute('aria-expanded'))

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(DAY + 'T14:30:00.000Z'))
  localStorage.setItem('garden.today.showOthers', '1')
  planState.current = {
    data: { ...DAVE, plan_date: DAY, generated_at: DAY + 'T14:00:25.318Z', household_plans: [{ user_id: 'member_jen', generated_at: DAY + 'T14:00:25.318Z', plan: JEN }] },
    loading: false, error: null, reload: vi.fn(),
  }
  prefsState.current = { prefs: null, prefsLoaded: true, refreshPrefs: async () => null }
  wire.watch = F('harvestwatch.json'); wire.soon = SG.use_soon.value
  wire.plants = PLANTS; wire.locations = LOCS
  wire.members = { members: [{ id: 'harness_user', display_name: 'Dave' }, { id: 'member_jen', display_name: 'Jen' }] }
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('every section on one page (integration 2, seam 3)', () => {
  it('renders all seven, in the fixed order: SECTION_ORDER, then the household', async () => {
    await mount()
    expect(ALL.slice(0, 6)).toEqual(SECTION_ORDER)
    expect(keys()).toEqual(ALL)
    expect(screen.getByTestId('today-sec-hh-member_j').textContent).toContain('Jen’s care')
  })

  it('Collapse all closes every one of them, and Expand all opens every one — the household\'s included', async () => {
    await mount()
    // The triggers opened some at the visit start (Protect's first chill night here, Heads-up's first window day).
    expect(states()).toContain('true')
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }))
    await settle()
    expect(keys()).toEqual(ALL)
    expect(states()).toEqual(ALL.map(() => 'false'))
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }))
    await settle()
    expect(keys()).toEqual(ALL)
    expect(states()).toEqual(ALL.map(() => 'true'))
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }))
    await settle()
    expect(states()).toEqual(ALL.map(() => 'false'))
    // The household section alone open still counts as "something open": the button offers Collapse all.
    fireEvent.click(screen.getByTestId('today-sec-hh-member_j').querySelector('[aria-expanded]'))
    await settle()
    expect(states()).toEqual(ALL.map((k) => (k === 'hh-member_j' ? 'true' : 'false')))
    expect(screen.getByTestId('today-expand-all').textContent).toBe('Collapse all')
  })
})
