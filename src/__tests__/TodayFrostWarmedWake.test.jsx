// V5-TODAYFROSTWARMEDADVISORY-001 — the frost line through Today's REAL plan load and wake refetches.
//
// Adopted from the v4.158.0 pre-promote QA review (review-v4158-qa.md, probe Q4). The mount tests in frostWatchLine.test.jsx
// mock useDailyPlan and hand Today its plan on the FIRST render, so a Today whose `current` memo lost its `plan` dependency
// (QA mutant N10: `[]`) froze `current` at the right plan there and stayed green across all 767 lane tests. In the app
// the first render is the LOADING render, `plan` is null, and the frozen `current` is null forever: the card and the cue
// retire to the plan's 44 while the line still says "Frost possible tonight — low 38°F" — the two-lows screen this item
// exists to remove. eslint cannot see it either (the react-hooks rule is a stub, eslint.config.js). Here the real hook
// loads the plan and each wake refetches it; the page must re-decide from every row: warm -> cold again -> warm.
//
// Harness from QA's probe (itself from TodayGroupOrderWake.test.jsx): REAL Today + REAL useDailyPlan, only fetch mocked.
// The plan GET is matched with ^/api/daily-plan(\?|$), NOT startsWith: the weather cue's /api/daily-plan/cue-impressions
// beacon also starts with it and would be handed a queued plan.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, act } from '@testing-library/react'
import { planFor, tonight, imminent, DRY, coldText, freezeText } from './helpers/twoLowsFixtures.js'

const { fetchMock, toastMock, getTokenMock, prefsMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  toastMock: { show: vi.fn(), showUndo: vi.fn(), dismiss: vi.fn() },
  getTokenMock: vi.fn(async () => 'tok'),
  prefsMock: {
    fetchNotificationPrefs: vi.fn(async () => null),
    saveTodaySkipped: vi.fn(async () => null),
  },
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useLocation: () => ({ pathname: '/today' }),
  useNavigate: () => vi.fn(),
}))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock, getToken: getTokenMock }) }))
vi.mock('../context/ToastContext.jsx', () => ({ useOptionalToast: () => toastMock }))
vi.mock('../lib/notificationPrefsClient.js', async (orig) => ({
  ...(await orig()),
  fetchNotificationPrefs: prefsMock.fetchNotificationPrefs,
  saveTodaySkipped: prefsMock.saveTodaySkipped,
}))

import Today from '../pages/Today.jsx'

const isPlan = (p) => typeof p === 'string' && /^\/api\/daily-plan(\?|$)/.test(p)   // NOT /api/daily-plan/cue-impressions
const planCalls = () => fetchMock.mock.calls.filter(c => isPlan(c[0])).length

let plans, skew
beforeEach(() => {
  plans = []
  skew = 0
  const realNow = Date.now.bind(Date)
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skew)
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
  fetchMock.mockReset(); toastMock.show.mockReset(); toastMock.showUndo.mockReset()
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
const WARMED = 'Forecast warmed to 44°F since the 3 PM frost email.'
const POSSIBLE38 = 'Frost possible tonight — low 38°F. Plan cover for tender plants.'
const frostEnv = (low, d1, gen) => ({
  schema_version: 1, plan_date: '2026-10-09', generated_at: gen, has_plan: true, plan: planFor(low, LADDER, hyLows(d1)),
})
const screenNow = () => ({
  card: screen.getByTestId('weather-night-low').textContent,
  cue: screen.queryByTestId('weather-cue-line')?.textContent ?? null,
  lines: screen.queryAllByTestId('frost-alert-line').map(el => el.textContent),
})

describe('Today — a warm-up that reverses while the page stays open (QA probe Q4)', () => {
  it('warm -> cold again -> warm: each hourly refetch decides, card, cue and line together', async () => {
    plans.push(frostEnv(44, 41.2, '2026-10-09T23:00:00Z'))                                // 7 PM run: both models warm
    render(<Today />)
    await waitFor(() => expect(screen.queryAllByTestId('frost-alert-line').length).toBe(1))
    expect(screenNow()).toEqual({ card: '44°', cue: coldText(44), lines: [WARMED] })
    plans.push(frostEnv(44, 38.9, '2026-10-10T00:00:00Z'))                                // 8 PM run: second model cold again
    await wake()
    await waitFor(() => expect(screenNow().lines).toEqual([POSSIBLE38]))
    expect(screenNow()).toEqual({ card: '38°', cue: freezeText(38), lines: [POSSIBLE38] })
    plans.push(frostEnv(44, 41.2, '2026-10-10T01:00:00Z'))                                // 9 PM run: warm again
    await wake()
    await waitFor(() => expect(screenNow().lines).toEqual([WARMED]))
    expect(screenNow()).toEqual({ card: '44°', cue: coldText(44), lines: [WARMED] })
  })
})
