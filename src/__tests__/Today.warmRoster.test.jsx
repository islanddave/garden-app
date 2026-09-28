// BUG-GARDENSPOTCREEP-001 (4.158.1) — Today with the household roster WARM in the SWR store, in CACHED mode
// (a Clerk sub is supplied). Today's other suites run without AuthProvider, so useCachedFetch runs PLAIN and
// their roster is always cold; since useMembers moved onto the store, every return to Today within a session is
// the warm case, and nothing else in the suite enters it (prepromote-v4158_1.md MINOR-1).
// Adopted from that review's probe cases B-E, which were green on the fix and red on the uncached hook for B, D
// and E (C is the toggle-OFF path, unchanged by the fix, kept as its regression guard). The cold-roster race
// (BUG-TODAYHOUSEHOLDRELOADDROP-001) is deliberately NOT pinned here: it is a known bug, and a test encoding it
// would go red the day it is fixed.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act, within } from '@testing-library/react'

const { fetchMock, toastMock, getTokenMock, identity, prefsMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  toastMock: { show: vi.fn(), showUndo: vi.fn(), dismiss: vi.fn() },
  getTokenMock: vi.fn(async () => 'tok'),
  identity: { current: { user: { id: 'sub-A' }, profile: { id: 'sub-A' }, loading: false } },
  prefsMock: { fetchNotificationPrefs: vi.fn(async () => null), saveTodaySkipped: vi.fn(async () => null) },
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
  fetchNotificationPrefs: prefsMock.fetchNotificationPrefs,
  saveTodaySkipped: prefsMock.saveTodaySkipped,
}))

import Today from '../pages/Today.jsx'
import * as cache from '../lib/dataCache.js'

const w = (id, name, project, projectId, overdue) => ({ id, name, crop: 'pepper', project, project_id: projectId, overdue_by: overdue, in_ground: false })
const bug = (id, name, project, projectId) => ({ id, name, crop: 'pepper', project, project_id: projectId })
const ARRIVAL = ['Drive Rows', 'Bag Area', 'Pasture']
function todayISO() { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10) }
function planBody() {
  const water = [
    w('d1', 'Drive One', 'Drive Rows', 'prD', 1), w('d2', 'Drive Two', 'Drive Rows', 'prD', 1),
    w('d3', 'Drive Three', 'Drive Rows', 'prD', 1), w('d4', 'Drive Four', 'Drive Rows', 'prD', 1),
    w('b1', 'Bag One', 'Bag Area', 'prB', 0), w('b2', 'Bag Two', 'Bag Area', 'prB', 0),
    w('b3', 'Bag Three', 'Bag Area', 'prB', 0), w('b4', 'Bag Four', 'Bag Area', 'prB', 0),
    w('b5', 'Bag Five', 'Bag Area', 'prB', 0),
    w('c1', 'Pasture One', 'Pasture', 'prC', 0), w('c2', 'Pasture Two', 'Pasture', 'prC', 0),
    w('c3', 'Pasture Three', 'Pasture', 'prC', 0),
  ]
  return {
    hydrology: { tomorrow_precip_in: 0.05, tomorrow_pop: 10 }, rain_skipped: [],
    water_due: water, no_history: [], fertilize: [],
    pest: [bug('dp1', 'Drive Bug', 'Drive Rows', 'prD'), bug('cp1', 'Pasture Bug', 'Pasture', 'prC'), bug('cp2', 'Pasture Bug Two', 'Pasture', 'prC')],
    cold: [], dormant: [],
  }
}
// The read Lambda's contract (daily-plan-read/index.js): the caller's plan is the same either way;
// ?include=household only ADDS household_plans.
function envelopeFor(path) {
  const env = { schema_version: 1, plan_date: todayISO(), generated_at: '2026-09-28T13:00:00Z', has_plan: true, plan: planBody() }
  if (includesHousehold(path)) env.household_plans = [{ user_id: 'jen', plan: planBody() }]
  return env
}
const HOUSEHOLD = () => ({ schema_version: 1, members: [{ id: 'sub-A', display_name: 'Dave N' }, { id: 'jen', display_name: 'Jen Example' }] })
const includesHousehold = (p) => new URL(p, 'http://x').searchParams.getAll('include').includes('household')
const isPlan = (p) => typeof p === 'string' && /^\/api\/daily-plan(\?|$)/.test(p)
const planPaths = () => fetchMock.mock.calls.map(c => c[0]).filter(isPlan)
const memberCalls = () => fetchMock.mock.calls.filter(c => c[0] === '/api/members').length
const lists = () => screen.getAllByTestId('today-care')
const ownList = () => lists()[0]
const headersIn = (list) => within(list).queryAllByTestId('care-group').map(g => g.querySelector('button[aria-expanded]'))
const headerLabels = () => headersIn(ownList()).map(b => b.querySelector('span').textContent)
const expandedLabels = () => headersIn(ownList()).filter(b => b.getAttribute('aria-expanded') === 'true').map(b => b.querySelector('span').textContent)
const expand = (label) => fireEvent.click(headersIn(ownList()).find(b => b.querySelector('span').textContent === label))
const settle = async () => { for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve() }) }
const KEY = () => cache.keyFor('sub-A', '/api/members')

let skew, loadingSeen
beforeEach(() => {
  cache.__resetDataCache()
  skew = 0; loadingSeen = 0
  const realNow = Date.now.bind(Date)
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skew)
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
  fetchMock.mockReset()
  fetchMock.mockImplementation((path) => {
    if (isPlan(path)) return Promise.resolve(envelopeFor(path))
    if (path === '/api/members') return Promise.resolve(HOUSEHOLD())
    return Promise.resolve([])
  })
  localStorage.clear(); sessionStorage.clear()
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

async function warmRoster() {
  await cache.warm(KEY(), () => Promise.resolve(HOUSEHOLD()))
  await waitFor(() => expect(cache.peek(KEY())).toMatchObject({ status: 'value', isValidating: false }))
}
// Counts REMOVALS of the plan block (a useDailyPlan reload blanks it to "Loading…" and remounts it). Records are
// flushed with takeRecords(), so a blank that React replaces within the same flush is still counted.
function watchLoading() {
  const handle = (records) => {
    for (const r of records) for (const n of r.removedNodes) {
      if (n.nodeType === 1 && (n.matches?.('[data-testid="today-plan-stack"]') || n.querySelector?.('[data-testid="today-plan-stack"]'))) loadingSeen++
    }
  }
  const mo = new MutationObserver(handle)
  mo.observe(document.body, { childList: true, subtree: true })
  return { disconnect: () => { handle(mo.takeRecords()); mo.disconnect() } }
}

describe('Today with a warm household roster (BUG-GARDENSPOTCREEP-001)', () => {
  it('toggle ON: ONE plan request, with the household; no blank or remount when the roster revalidate lands; the held order stands', async () => {
    localStorage.setItem('garden.today.showOthers', '1')
    await warmRoster()
    render(<Today />)
    await waitFor(() => expect(screen.queryByTestId('today-plan-stack')).toBeTruthy())
    const stack = screen.getByTestId('today-plan-stack')
    const mo = watchLoading()                         // started AFTER the first plan paint: the initial load is not a blank
    await waitFor(() => expect(screen.queryAllByTestId('today-care').length).toBe(2))
    await waitFor(() => expect(memberCalls()).toBeGreaterThan(0))
    await settle()
    mo.disconnect()
    expect(planPaths().map(includesHousehold)).toEqual([true])
    expect(screen.getByTestId('today-plan-stack') === stack).toBe(true)
    expect(loadingSeen).toBe(0)
    expect(headerLabels()).toEqual(ARRIVAL)
  })

  it('toggle OFF: ONE plan request WITHOUT the household (unchanged from 4.156.0); the toggle is on the first plan paint', async () => {
    await warmRoster()
    render(<Today />)
    await waitFor(() => expect(screen.queryByTestId('today-plan-stack')).toBeTruthy())
    expect(screen.queryByTestId('today-household-toggle')).toBeTruthy()
    await settle()
    expect(planPaths().map(includesHousehold)).toEqual([false])
    expect(screen.getByTestId('today-household-toggle').getAttribute('aria-pressed')).toBe('false')
  })

  it('a wake: the store re-validating the roster (same household) with the plan wake refresh moves no section and keeps a manual expand', async () => {
    localStorage.setItem('garden.today.showOthers', '1')
    await warmRoster()
    render(<Today />)
    await waitFor(() => expect(screen.queryAllByTestId('today-care').length).toBe(2))
    await waitFor(() => expect(headerLabels()).toEqual(ARRIVAL))
    await settle()
    expand('Pasture')
    expect(expandedLabels()).toEqual(['Drive Rows', 'Pasture'])
    const stack = screen.getByTestId('today-plan-stack')
    const beforeMembers = memberCalls()
    const mo = watchLoading()
    skew += 6 * 60_000
    await act(async () => {
      cache.revalidateLive(0)                         // useCacheLifecycle's wake — the roster key is watched now
      window.dispatchEvent(new Event('focus'))        // useDailyPlan's own wake refresh (its 60 s floor passed)
    })
    await waitFor(() => expect(memberCalls()).toBe(beforeMembers + 1))
    await waitFor(() => expect(planPaths().length).toBe(2))
    await settle()
    mo.disconnect()
    expect(planPaths().map(includesHousehold)).toEqual([true, true])
    expect(screen.getByTestId('today-plan-stack') === stack).toBe(true)
    expect(loadingSeen).toBe(0)
    expect(headerLabels()).toEqual(ARRIVAL)
    expect(expandedLabels()).toEqual(['Drive Rows', 'Pasture'])
  })

  it('the roster revalidate FAILS (toggle ON): the cached household is kept, no flip, one plan request, no error text', async () => {
    localStorage.setItem('garden.today.showOthers', '1')
    await warmRoster()
    fetchMock.mockImplementation((path) => {
      if (isPlan(path)) return Promise.resolve(envelopeFor(path))
      if (path === '/api/members') return Promise.reject(new Error('Request timed out'))
      return Promise.resolve([])
    })
    render(<Today />)
    await waitFor(() => expect(screen.queryAllByTestId('today-care').length).toBe(2))
    await settle()
    expect(planPaths().map(includesHousehold)).toEqual([true])
    expect(document.body.textContent.includes('Request timed out')).toBe(false)
    expect(document.body.textContent.includes('Failed to load caretakers')).toBe(false)
  })
})
