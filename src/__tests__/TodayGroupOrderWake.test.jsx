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
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'

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
function envelope({ done = [], gen = '2026-09-28T13:00:00Z' } = {}) {
  const water = [
    w('d1', 'Drive One', 'Drive Rows', 'prD', 1), w('d2', 'Drive Two', 'Drive Rows', 'prD', 1),
    w('d3', 'Drive Three', 'Drive Rows', 'prD', 1), w('d4', 'Drive Four', 'Drive Rows', 'prD', 1),
    w('b1', 'Bag One', 'Bag Area', 'prB', 0), w('b2', 'Bag Two', 'Bag Area', 'prB', 0),
    w('b3', 'Bag Three', 'Bag Area', 'prB', 0), w('b4', 'Bag Four', 'Bag Area', 'prB', 0),
    w('b5', 'Bag Five', 'Bag Area', 'prB', 0),
    w('c1', 'Pasture One', 'Pasture', 'prC', 0), w('c2', 'Pasture Two', 'Pasture', 'prC', 0),
    w('c3', 'Pasture Three', 'Pasture', 'prC', 0),
  ].map(it => (done.includes(it.id) ? { ...it, done: true } : it))
  return {
    schema_version: 1, plan_date: todayISO(), generated_at: gen, has_plan: true,
    plan: {
      hydrology: { tomorrow_precip_in: 0.05, tomorrow_pop: 10 }, rain_skipped: [],
      water_due: water, no_history: [], fertilize: [],
      pest: [bug('dp1', 'Drive Bug', 'Drive Rows', 'prD'), bug('cp1', 'Pasture Bug', 'Pasture', 'prC'), bug('cp2', 'Pasture Bug Two', 'Pasture', 'prC')],
      cold: [], dormant: [],
    },
  }
}

const headers = () => screen.queryAllByTestId('care-group').map(g => g.querySelector('button[aria-expanded]'))
const headerLabels = () => headers().map(b => b.querySelector('span').textContent)
const expandedLabels = () => headers().filter(b => b.getAttribute('aria-expanded') === 'true').map(b => b.querySelector('span').textContent)
const countOf = (label) => {
  const b = headers().find(x => x.querySelector('span').textContent === label)
  return b ? b.querySelectorAll('span')[1].textContent : null
}
const planCalls = () => fetchMock.mock.calls.filter(c => typeof c[0] === 'string' && c[0].startsWith('/api/daily-plan')).length

let plans, skew
beforeEach(() => {
  plans = []
  skew = 0
  const realNow = Date.now.bind(Date)
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skew)
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
  fetchMock.mockReset(); toastMock.show.mockReset(); toastMock.showUndo.mockReset()
  let n = 0
  fetchMock.mockImplementation((path, opts) => {
    if (typeof path === 'string' && path.startsWith('/api/daily-plan')) return Promise.resolve(plans.shift())
    if (path === '/api/events' && opts?.method === 'POST') return Promise.resolve({ id: 'ev-' + (++n) })
    return Promise.resolve([])
  })
  sessionStorage.clear()
  localStorage.clear()
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

async function openToday(env) {
  plans.push(env)
  const view = render(<Today />)
  await waitFor(() => expect(headerLabels().length > 0).toBe(true))
  await waitFor(() => expect(fetchMock.mock.calls.some(c => c[0] === '/api/locations/with-path')).toBe(true))
  await act(async () => { await Promise.resolve() })
  return view
}

describe('BUG-TODAYGROUPREORDER-001 — a wake refetch on Today moves no section', () => {
  it('log three Drive rows, wake the app: the plan comes back with them done and nothing moves', async () => {
    await openToday(envelope())
    await waitFor(() => expect(headerLabels()).toEqual(ARRIVAL))
    // A manual expand — state that only survives if the wake keeps the SAME CareNeeded mounted.
    fireEvent.click(headers().find(b => b.querySelector('span').textContent === 'Pasture'))
    expect(expandedLabels()).toEqual(['Drive Rows', 'Pasture'])

    for (const name of ['Drive One', 'Drive Two', 'Drive Three']) {
      fireEvent.click(screen.getByRole('button', { name: 'Log Water for ' + name }))
      await waitFor(() => expect(screen.queryByText(name)).toBeNull())
    }
    expect(headerLabels()).toEqual(ARRIVAL)

    // The wake: past the 60 s floor, a window focus (Android fires one on app return and on a
    // dismissed keyboard). The read path now stamps the three logged rows AND Bag One done.
    plans.push(envelope({ done: ['d1', 'd2', 'd3', 'b1'], gen: '2026-09-28T14:00:00Z' }))
    skew += 61_000
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => expect(planCalls()).toBe(2))
    // The refetched plan really landed (Bag Area's TRUE count dropped) ...
    await waitFor(() => expect(countOf('Bag Area')).toBe('4'))
    // ... on the same mounted list (the manual expand survived) ...
    expect(expandedLabels().includes('Pasture')).toBe(true)
    // ... and no section moved, or opened, or closed.
    expect(headerLabels()).toEqual(ARRIVAL)
    expect(expandedLabels()).toEqual(['Drive Rows', 'Pasture'])
  })

  it('leaving Today and opening it again ranks from the plan it opens on', async () => {
    const first = await openToday(envelope())
    await waitFor(() => expect(headerLabels()).toEqual(ARRIVAL))
    first.unmount()
    await openToday(envelope({ done: ['d1', 'd2', 'd3'] }))
    await waitFor(() => expect(headerLabels()).toEqual(RERANKED))
  })
})
