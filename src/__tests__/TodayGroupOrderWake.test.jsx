// BUG-TODAYGROUPREORDER-001 — the same freeze, driven through the REAL entry point rather than a
// rerender. CareNeededGroupOrderFreeze.test.jsx proves CareNeeded holds its order when handed a new
// plan; this file proves that is the path a wake actually takes: the real useDailyPlan revalidates on
// `focus` past its 60 s floor (BUG-PLANNOREVALIDATE-001), Today keeps the SAME CareNeeded mounted
// (refresh never blanks the screen), and the list receives a new plan object whose logged rows now
// come back stamped `done`. Before the fix that one wake re-ranked the page with no tap at all.
//
// No jest-dom (L-182): role/attr/text + toBe/toEqual/toBeTruthy/toBeNull only.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act, within } from '@testing-library/react'

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

// Same ranking as CareNeededGroupOrderFreeze.test.jsx: Drive 8.5, Bag 5, Pasture 4 on arrival; with
// three Drive water rows gone Drive is 2.5 and any re-rank puts it last.
const w = (id, name, project, projectId, overdue) => ({
  id, name, crop: 'pepper', project, project_id: projectId, overdue_by: overdue, in_ground: false,
})
const bug = (id, name, project, projectId) => ({ id, name, crop: 'pepper', project, project_id: projectId })
const ARRIVAL = ['Drive Rows', 'Bag Area', 'Pasture']
const RERANKED = ['Bag Area', 'Pasture', 'Drive Rows']

function todayISO() {
  const d = new Date()
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}
function planBody({ done = [], over = {} } = {}) {
  const water = [
    w('d1', 'Drive One', 'Drive Rows', 'prD', 1), w('d2', 'Drive Two', 'Drive Rows', 'prD', 1),
    w('d3', 'Drive Three', 'Drive Rows', 'prD', 1), w('d4', 'Drive Four', 'Drive Rows', 'prD', 1),
    w('b1', 'Bag One', 'Bag Area', 'prB', 0), w('b2', 'Bag Two', 'Bag Area', 'prB', 0),
    w('b3', 'Bag Three', 'Bag Area', 'prB', 0), w('b4', 'Bag Four', 'Bag Area', 'prB', 0),
    w('b5', 'Bag Five', 'Bag Area', 'prB', 0),
    w('c1', 'Pasture One', 'Pasture', 'prC', 0), w('c2', 'Pasture Two', 'Pasture', 'prC', 0),
    w('c3', 'Pasture Three', 'Pasture', 'prC', 0),
  ].map(it => ({
    ...it,
    ...(it.id in over ? { overdue_by: over[it.id] } : null),
    ...(done.includes(it.id) ? { done: true } : null),
  }))
  return {
    hydrology: { tomorrow_precip_in: 0.05, tomorrow_pop: 10 }, rain_skipped: [],
    water_due: water, no_history: [], fertilize: [],
    pest: [bug('dp1', 'Drive Bug', 'Drive Rows', 'prD'), bug('cp1', 'Pasture Bug', 'Pasture', 'prC'), bug('cp2', 'Pasture Bug Two', 'Pasture', 'prC')],
    cold: [], dormant: [],
  }
}
function envelope({ done = [], gen = '2026-09-28T13:00:00Z', date = todayISO(), over = {}, household = null } = {}) {
  return {
    schema_version: 1, plan_date: date, generated_at: gen, has_plan: true, plan: planBody({ done, over }),
    ...(household ? { household_plans: household } : null),
  }
}

// Scoped to Dave's OWN list: the first `today-care` on the page (the household lens mounts more).
const ownList = () => screen.getAllByTestId('today-care')[0]
const headers = () => within(ownList()).queryAllByTestId('care-group').map(g => g.querySelector('button[aria-expanded]'))
const headerLabels = () => headers().map(b => b.querySelector('span').textContent)
const expandedLabels = () => headers().filter(b => b.getAttribute('aria-expanded') === 'true').map(b => b.querySelector('span').textContent)
const countOf = (label) => {
  const b = headers().find(x => x.querySelector('span').textContent === label)
  return b ? b.querySelectorAll('span')[1].textContent : null
}
const expand = (label) => fireEvent.click(headers().find(b => b.querySelector('span').textContent === label))
const planCalls = () => fetchMock.mock.calls.filter(c => typeof c[0] === 'string' && c[0].startsWith('/api/daily-plan')).length
const StrictWrap = (x) => <React.StrictMode>{x}</React.StrictMode>

let plans, skew, members
beforeEach(() => {
  plans = []
  skew = 0
  members = { members: [] }
  const realNow = Date.now.bind(Date)
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skew)
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
  fetchMock.mockReset(); toastMock.show.mockReset(); toastMock.showUndo.mockReset()
  let n = 0
  fetchMock.mockImplementation((path, opts) => {
    if (typeof path === 'string' && path.startsWith('/api/daily-plan')) return Promise.resolve(plans.shift())
    if (path === '/api/members') return Promise.resolve(members)
    if (path === '/api/events' && opts?.method === 'POST') return Promise.resolve({ id: 'ev-' + (++n) })
    if (typeof path === 'string' && path.startsWith('/api/events/') && opts?.method === 'DELETE') return Promise.resolve({ ok: true })
    return Promise.resolve([])
  })
  sessionStorage.clear()
  localStorage.clear()
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

async function openToday(env, wrap = (x) => x) {
  plans.push(env)
  const view = render(wrap(<Today />))
  await waitFor(() => expect(screen.queryAllByTestId('today-care').length > 0).toBe(true))
  await waitFor(() => expect(headerLabels().length > 0).toBe(true))
  await waitFor(() => expect(fetchMock.mock.calls.some(c => c[0] === '/api/locations/with-path')).toBe(true))
  await act(async () => { await Promise.resolve() })
  return view
}

// The wake: past the 60 s floor, a window focus (Android fires one on app return and on a dismissed
// keyboard), answered with the next plan queued in `plans`.
async function wake() {
  const before = planCalls()
  skew += 61_000
  await act(async () => { window.dispatchEvent(new Event('focus')) })
  await waitFor(() => expect(planCalls()).toBe(before + 1))
}

async function logThreeDriveRows() {
  for (const name of ['Drive One', 'Drive Two', 'Drive Three']) {
    fireEvent.click(within(ownList()).getByRole('button', { name: 'Log Water for ' + name }))
    await waitFor(() => expect(within(ownList()).queryByText(name)).toBeNull())
  }
}

describe('BUG-TODAYGROUPREORDER-001 — a wake refetch on Today moves no section', () => {
  it('log three Drive rows, wake the app: the plan comes back with them done and nothing moves', async () => {
    await openToday(envelope())
    await waitFor(() => expect(headerLabels()).toEqual(ARRIVAL))
    // A manual expand — state that only survives if the wake keeps the SAME CareNeeded mounted.
    expand('Pasture')
    expect(expandedLabels()).toEqual(['Drive Rows', 'Pasture'])
    await logThreeDriveRows()
    expect(headerLabels()).toEqual(ARRIVAL)

    // The read path now stamps the three logged rows AND Bag One done.
    plans.push(envelope({ done: ['d1', 'd2', 'd3', 'b1'], gen: '2026-09-28T14:00:00Z' }))
    await wake()
    // The refetched plan really landed (Bag Area's TRUE count dropped) ...
    await waitFor(() => expect(countOf('Bag Area')).toBe('4'))
    // ... on the same mounted list (the manual expand survived) ...
    expect(expandedLabels().includes('Pasture')).toBe(true)
    // ... and no section moved, or opened, or closed.
    expect(headerLabels()).toEqual(ARRIVAL)
    expect(expandedLabels()).toEqual(['Drive Rows', 'Pasture'])
  })

  it('the same wake under <StrictMode>: nothing moves and a manual expand survives [QA P10]', async () => {
    // Spied here, not read from the log: src/__tests__/setup.ts drops every console.error carrying
    // "Warning:", which is how React reports a render-phase update it objects to.
    const errs = vi.spyOn(console, 'error').mockImplementation(() => {})
    await openToday(envelope(), StrictWrap)
    await waitFor(() => expect(headerLabels()).toEqual(ARRIVAL))
    expand('Pasture')
    await logThreeDriveRows()
    plans.push(envelope({ done: ['d1', 'd2', 'd3', 'b1'], gen: '2026-09-28T14:00:00Z' }))
    await wake()
    await waitFor(() => expect(countOf('Bag Area')).toBe('4'))
    expect(headerLabels()).toEqual(ARRIVAL)
    expect(expandedLabels()).toEqual(['Drive Rows', 'Pasture'])
    const loopish = errs.mock.calls.map(c => String(c[0])).filter(m => /Too many re-renders|Cannot update a component|Maximum update depth/.test(m))
    expect(loopish).toEqual([])
  })

  it('leaving Today and opening it again ranks from the plan it opens on', async () => {
    const first = await openToday(envelope())
    await waitFor(() => expect(headerLabels()).toEqual(ARRIVAL))
    first.unmount()
    await openToday(envelope({ done: ['d1', 'd2', 'd3'] }))
    await waitFor(() => expect(headerLabels()).toEqual(RERANKED))
  })
})

// CHARACTERISATION of a known path, pinned on purpose, NOT a statement of what is wanted: tapping "Show
// the rest of the household's care" changes useDailyPlan's query, which runs `reload`, which blanks
// Today to "Loading…" and remounts Dave's OWN list — a fresh visit with no sort tap. It re-ranks and
// drops a manual expand. Pre-existing (the same on the pre-fix code), out of this item's scope.
describe('BUG-TODAYGROUPREORDER-001 — the household toggle reloads the page (characterisation)', () => {
  it('re-ranks Dave\'s own list and drops his manual expand [QA P8]', async () => {
    members = { members: [{ id: 'jen', display_name: 'Jen Example' }] }
    await openToday(envelope())
    await waitFor(() => expect(headerLabels()).toEqual(ARRIVAL))
    expand('Pasture')
    expect(expandedLabels()).toEqual(['Drive Rows', 'Pasture'])
    await logThreeDriveRows()
    expect(headerLabels()).toEqual(ARRIVAL)
    // The household toggle sits BELOW the list. The read path now stamps Dave's three logs done.
    plans.push(envelope({ done: ['d1', 'd2', 'd3'], household: [{ user_id: 'jen', plan: planBody() }] }))
    await waitFor(() => expect(screen.queryByTestId('today-household-toggle')).toBeTruthy())
    fireEvent.click(screen.getByTestId('today-household-toggle'))
    await waitFor(() => expect(planCalls()).toBe(2))
    await waitFor(() => expect(screen.queryAllByTestId('today-care').length).toBe(2))
    await waitFor(() => expect(headerLabels().length).toBe(3))
    expect({ order: headerLabels(), open: expandedLabels() }).toEqual({ order: RERANKED, open: ['Bag Area'] })
  })
})
