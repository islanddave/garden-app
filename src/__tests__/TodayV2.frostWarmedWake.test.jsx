// V5-TODAYFROSTWARMEDADVISORY-001 — the frost line through Today's REAL plan load and wake refetches.
//
// V5-TODAYREDESIGN-001 S8c (L8): ported from TodayFrostWarmedWake.test.jsx (the v4.158.0 pre-promote QA probe Q4)
// when the old Today page was removed. Its point carries over unchanged, because TodayV2 holds the same memo: a
// page whose `current` memo lost its `plan` dependency (QA mutant N10: `[]`) froze `current` at the first render's
// plan. A test that hands the page its plan on the FIRST render cannot see that; in the app the first render is the
// LOADING render, `plan` is null, and a frozen `current` is null forever — the card and the cue retire to the plan's
// 44 while the line still says "Frost possible tonight". So here the REAL useDailyPlan loads the plan and each wake
// refetches it, and the glance card must re-decide from every row: warm -> cold again -> warm.
//
// The plan carries no cold cards, so no Protect tonight section takes the cue and the frost line (finish plan §3.3):
// both sit under the glance card. The plan GET is matched with ^/api/daily-plan(\?|$), NOT startsWith: the weather
// cue's /api/daily-plan/cue-impressions beacon also starts with it and would be handed a queued plan.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { planFor, tonight, imminent, DRY } from './helpers/twoLowsFixtures.js'

const { fetchMock, prefsState, auth } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  prefsState: { current: { prefs: null, prefsLoaded: true, refreshPrefs: async () => null } },
  auth: { user: { id: 'u' }, profile: { id: 'u' } },
}))
const api = vi.hoisted(() => ({ value: { fetch: (...a) => fetchMock(...a), getToken: async () => 't' } }))
vi.mock('../lib/api.js', async (orig) => ({ ...(await orig()), useApiFetch: () => api.value }))
vi.mock('../context/PrefsContext.jsx', () => ({ usePrefs: () => prefsState.current }))
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => auth }))
vi.mock('../lib/notificationPrefsClient.js', async (orig) => ({ ...(await orig()), fetchNotificationPrefs: vi.fn(async () => null), saveTodaySkipped: vi.fn(async () => null) }))
vi.mock('../hooks/useCachedFetch.js', () => ({ useCachedFetch: (path) => ({ data: path === '/api/plants' ? [] : { locations: [] }, loading: false, error: null }) }))
// The plan-independent bands are not what this file is about: settled and empty at once.
vi.mock('../components/today/v2/useTodayBands.js', () => ({
  useTodayBands: () => ({ settled: true, watch: { data: null, failed: false, reload() {} }, compose: { data: null, settled: true, reload() {} }, soon: { data: null, failed: false, reload() {} }, sow: { items: null, settled: true }, harvest: { present: false, summary: null }, putup: { present: false, summary: null } }),
}))

import TodayV2 from '../pages/TodayV2.jsx'

const isPlan = (p) => typeof p === 'string' && /^\/api\/daily-plan(\?|$)/.test(p)   // NOT /api/daily-plan/cue-impressions
const planCalls = () => fetchMock.mock.calls.filter(c => isPlan(c[0])).length

let plans, skew
beforeEach(() => {
  plans = []
  skew = 0
  const realNow = Date.now.bind(Date)
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skew)
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
  fetchMock.mockReset()
  fetchMock.mockImplementation((path) => {
    if (isPlan(path)) return Promise.resolve(plans.shift())
    if (path === '/api/members') return Promise.resolve({ members: [] })
    return Promise.resolve([])
  })
  sessionStorage.clear()
  localStorage.clear()
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

// A wake past useDailyPlan's 60 s revalidation floor: exactly one more plan GET.
async function wake() {
  const before = planCalls()
  skew += 61_000
  await act(async () => { window.dispatchEvent(new Event('focus')) })
  await waitFor(() => expect(planCalls()).toBe(before + 1))
}

// The I2 ladder (twoLowsFixtures, plan date Fri 10-09): "Frost possible tonight" at 2:05 PM on the second model's 37.6,
// then "Frost protect tonight" at 3 PM. Each hourly row stores that run's second-model D1 (hydrology.forecast_lows).
const at = (hhmm) => `2026-10-09T${hhmm}:00.000Z`
const ADV = tonight(37.6, { at: at('18:05') })                                           // 2:05 PM EDT
const PROTECT = { ...imminent(38), run: 'intraday-pm', at: at('19:00') }                 // 3 PM EDT
const LADDER = [ADV, PROTECT]
const hyLows = (d1) => ({ ...DRY, forecast_lows: [d1, 45.3, 47.1], forecast_dates: ['2026-10-10', '2026-10-11', '2026-10-12'] })
const frostEnv = (low, d1, gen) => ({
  schema_version: 1, plan_date: '2026-10-09', generated_at: gen, has_plan: true,
  plan: { ...planFor(low, LADDER, hyLows(d1)), cold: [] },
})
// Row A's bare temperatures (high, then the ONE low for tonight), the cue line and the frost lines under the card.
const bareTemps = (root) => [...root.querySelectorAll('*')].filter((el) => !el.children.length && /^-?\d+°$/.test((el.textContent || '').trim())).map((el) => el.textContent.trim())
const screenNow = () => ({
  low: bareTemps(screen.getByTestId('today-glance').querySelector('[aria-expanded]'))[1] ?? null,
  cue: screen.queryByTestId('weather-cue-line')?.dataset.cue ?? null,
  lines: screen.queryAllByTestId('frost-alert-line').map(el => el.textContent),
})

describe('Today — a warm-up that reverses while the page stays open (QA probe Q4)', () => {
  it('warm -> cold again -> warm: each hourly refetch decides, card, cue and line together', async () => {
    plans.push(frostEnv(44, 41.2, '2026-10-09T23:00:00Z'))                                // 7 PM run: both models warm
    render(<MemoryRouter><TodayV2 /></MemoryRouter>)
    await waitFor(() => expect(screen.queryAllByTestId('frost-alert-line').length).toBe(1))
    expect(screenNow()).toEqual({ low: '44°', cue: 'cold', lines: [expect.stringMatching(/^Forecast warmed to 44°F since the 3 PM frost email\./)] })
    plans.push(frostEnv(44, 38.9, '2026-10-10T00:00:00Z'))                                // 8 PM run: second model cold again
    await wake()
    await waitFor(() => expect(screenNow().lines).toEqual([expect.stringMatching(/^Frost possible tonight/)]))
    expect(screenNow()).toEqual({ low: '38°', cue: 'freeze', lines: [expect.stringMatching(/^Frost possible tonight/)] })
    plans.push(frostEnv(44, 41.2, '2026-10-10T01:00:00Z'))                                // 9 PM run: warm again
    await wake()
    await waitFor(() => expect(screenNow().lines).toEqual([expect.stringMatching(/^Forecast warmed to 44°F/)]))
    expect(screenNow()).toEqual({ low: '44°', cue: 'cold', lines: [expect.stringMatching(/^Forecast warmed to 44°F/)] })
  })
})
