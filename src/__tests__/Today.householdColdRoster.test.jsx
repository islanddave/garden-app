// BUG-TODAYHOUSEHOLDRELOADDROP-001 — Today opened with "Show the rest of the household's care" saved ON and the
// roster COLD (launch or sign-in: nothing in the SWR store yet). useMembers starts at [], so Today's first plan
// request cannot ask for the household (includeHousehold = showOthers && canShowOthers). The roster lands while
// that request is still open and flips includeHousehold; useDailyPlan's in-flight guard used to drop the reload
// that flip asked for, so the household plan was never requested and Today showed the toggle ON over "No one else
// has care needs today." although Jen is a member, until the next wake refresh or a toggle off/on (QA probe P13,
// _mainsync12_20260925/T-todayorder/review-qa.md). The warm case is Today.householdWarmRoster.test.jsx, where the
// first request already asks for the household.
//
// CACHED mode (a Clerk sub is supplied), with the store reset: the path a real launch takes since 4.158.1. Plan
// requests stay open until the test answers them; a request is read by its parsed query, never by its string.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, act } from '@testing-library/react'

const { fetchMock, toastMock, getTokenMock, identity } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  toastMock: { show: vi.fn(), showUndo: vi.fn(), dismiss: vi.fn() },
  getTokenMock: vi.fn(async () => 'tok'),
  identity: { current: { user: { id: 'sub-A' }, profile: { id: 'sub-A' }, loading: false } },
}))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useLocation: () => ({ pathname: '/today' }),
  useNavigate: () => vi.fn(),
}))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock, getToken: getTokenMock }) }))
vi.mock('../context/ToastContext.jsx', () => ({ useOptionalToast: () => toastMock }))
vi.mock('../context/AuthContext.jsx', async (orig) => ({ ...(await orig()), useAuthOptional: () => identity.current }))
vi.mock('../lib/notificationPrefsClient.js', async (orig) => ({
  ...(await orig()),
  fetchNotificationPrefs: vi.fn(async () => null),
  saveTodaySkipped: vi.fn(async () => null),
}))

import Today from '../pages/Today.jsx'
import * as cache from '../lib/dataCache.js'
import { IMAGE_LIST_CACHE_ENABLED } from '../lib/featureFlags.js'

function todayISO() { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10) }
const planBody = () => ({
  water_due: [{ id: 'd1', name: 'Drive One', crop: 'pepper', project: 'Drive Rows', project_id: 'prD', overdue_by: 1, in_ground: false }],
  no_history: [], fertilize: [], pest: [], cold: [], dormant: [], rain_skipped: [], hydrology: {},
})
const includesHousehold = (p) => new URL(p, 'http://x').searchParams.getAll('include').includes('household')
// The read Lambda's contract (daily-plan-read/index.js): the caller's plan is the same either way;
// ?include=household only ADDS household_plans.
function envelopeFor(path) {
  const env = { schema_version: 1, plan_date: todayISO(), generated_at: '2026-09-28T13:00:00Z', has_plan: true, plan: planBody() }
  if (includesHousehold(path)) env.household_plans = [{ user_id: 'jen', plan: planBody() }]
  return env
}
const HOUSEHOLD = () => ({ members: [{ id: 'sub-A', display_name: 'Dave N' }, { id: 'jen', display_name: 'Jen Example' }] })
const isPlan = (p) => typeof p === 'string' && /^\/api\/daily-plan(\?|$)/.test(p)
const planPaths = () => fetchMock.mock.calls.map((c) => c[0]).filter(isPlan)
const settle = async () => { for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve() }) }
const KEY = () => cache.keyFor('sub-A', '/api/members')

let open, removed
beforeEach(() => {
  cache.__resetDataCache()                                   // COLD: no roster in the store
  open = []
  removed = 0
  fetchMock.mockReset()
  fetchMock.mockImplementation((path) => {
    if (isPlan(path)) return new Promise((resolve) => { open.push({ path, resolve }) })
    if (path === '/api/members') return Promise.resolve(HOUSEHOLD())
    return Promise.resolve([])
  })
  localStorage.clear(); sessionStorage.clear()
  localStorage.setItem('garden.today.showOthers', '1')
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

// Counts REMOVALS of the plan block (a reload blanks it to "Loading…" and remounts it). Records are flushed with
// takeRecords(), so a blank that React replaces within the same flush is still counted.
function watchRemovals() {
  const handle = (records) => {
    for (const r of records) for (const n of r.removedNodes) {
      if (n.nodeType === 1 && (n.matches?.('[data-testid="today-plan-stack"]') || n.querySelector?.('[data-testid="today-plan-stack"]'))) removed++
    }
  }
  const mo = new MutationObserver(handle)
  mo.observe(document.body, { childList: true, subtree: true })
  return { disconnect: () => { handle(mo.takeRecords()); mo.disconnect() } }
}

describe('Today, household toggle saved ON, the roster COLD and landing while the first plan request is open', () => {
  it('the flag under test is on, or the roster is never cached and this is the plain-fetch path', () => {
    expect(IMAGE_LIST_CACHE_ENABLED).toBe(true)
  })

  it('asks for the household once the first request settles, then shows Jen\'s care; the own plan paints on the first answer and never blanks', async () => {
    render(<Today />)
    // The roster lands in the store while the one plan request is still open (it asked without the household).
    await waitFor(() => expect(cache.peek(KEY())).toMatchObject({ status: 'value' }))
    await settle()
    expect(planPaths().map(includesHousehold)).toEqual([false])
    expect(open).toHaveLength(1)

    await act(async () => { open[0].resolve(envelopeFor(open[0].path)) })
    const stack = screen.getByTestId('today-plan-stack')      // the own plan is on screen from the first answer
    const mo = watchRemovals()
    await waitFor(() => expect(planPaths().map(includesHousehold)).toEqual([false, true]))
    expect(new URL(planPaths()[1], 'http://x').pathname).toBe('/api/daily-plan')

    await act(async () => { open[1].resolve(envelopeFor(open[1].path)) })
    await waitFor(() => expect(screen.queryAllByTestId('today-care').length).toBe(2))
    await settle()
    mo.disconnect()
    expect(planPaths()).toHaveLength(2)
    expect(screen.getByTestId('today-household-toggle').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText(/^Jen.s care today$/)).toBeTruthy()
    expect(screen.queryByText('No one else has care needs today.')).toBeNull()
    expect(screen.getByTestId('today-plan-stack') === stack).toBe(true)
    expect(removed).toBe(0)
  })
})
