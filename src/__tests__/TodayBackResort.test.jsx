// BUG-TODAYBACKRESORT-001 — tap a plant on Today, press Back: the Needs-care sections come back in the
// order Dave left them, with the same sections open, for the rest of the plan day. Planting routes are
// not overlays, so Back REMOUNTS Today; before this the remount took a fresh layout from the refetched
// plan, which ranks his finished work out of the sections he was working down.
//
// Driven through the REAL Today + useDailyPlan (as TodayGroupOrderWake.test.jsx), with a SIGNED-IN user
// (the visit layout is keyed by user, so the Wake file — which mounts with no AuthProvider — still
// pins the old fresh take for a signed-out render). The plantings carry real location ids and names, so
// the first frame of each mount is keyed by PROJECT and the one the names bring by LOCATION, as on the
// phone: the held order is a location order and must survive that re-keying.
//
// No jest-dom (L-182): role/attr/text + toBe/toEqual/toBeTruthy/toBeNull only.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act, within } from '@testing-library/react'

const { fetchMock, toastMock, getTokenMock, prefsMock, identity } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  toastMock: { show: vi.fn(), showUndo: vi.fn(), dismiss: vi.fn() },
  getTokenMock: vi.fn(async () => 'tok'),
  prefsMock: {
    fetchNotificationPrefs: vi.fn(async () => null),
    saveTodaySkipped: vi.fn(async () => null),
  },
  identity: { current: null },
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
import { clearClientPrefs } from '../lib/clientPrefs.js'
import { VISIT_PREFIX } from '../components/today/visitLayout.js'

const DAVE = { user: { id: 'sub-dave' }, profile: { id: 'sub-dave' }, loading: false }

// Same ranking as TodayGroupOrderWake: Drive 8.5, Bag 5, Pasture 4 on arrival; with three Drive water
// rows done Drive is 2.5 and any fresh take puts it last.
const w = (id, name, project, projectId, overdue) => ({
  id, name, crop: 'pepper', project, project_id: projectId, overdue_by: overdue, in_ground: false,
})
const bug = (id, name, project, projectId) => ({ id, name, crop: 'pepper', project, project_id: projectId })
const LOC = { prD: 'locD', prB: 'locB', prC: 'locC' }
const PLACE = { locD: 'Drive Bed', locB: 'Bag Bed', locC: 'Pasture Bed' }
const ARRIVAL = ['Drive Bed', 'Bag Bed', 'Pasture Bed']
const RERANKED = ['Bag Bed', 'Pasture Bed', 'Drive Bed']
const PROJECT_LABELS = new Set(['Drive Rows', 'Bag Area', 'Pasture'])

function todayISO() {
  const d = new Date()
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}
function dayISO(offset) {
  const d = new Date(todayISO() + 'T12:00:00')
  d.setDate(d.getDate() + offset)
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}
function items({ done = [], over = {} } = {}) {
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
  const pest = [bug('dp1', 'Drive Bug', 'Drive Rows', 'prD'), bug('cp1', 'Pasture Bug', 'Pasture', 'prC'), bug('cp2', 'Pasture Bug Two', 'Pasture', 'prC')]
  return { water, pest }
}
function planBody(opts) {
  const { water, pest } = items(opts)
  return {
    hydrology: { tomorrow_precip_in: 0.05, tomorrow_pop: 10 }, rain_skipped: [],
    water_due: water, no_history: [], fertilize: [], pest, cold: [], dormant: [],
  }
}
function envelope({ done = [], date = todayISO(), over = {}, household = null } = {}) {
  return {
    schema_version: 1, plan_date: date, generated_at: '2026-09-28T13:00:00Z', has_plan: true, plan: planBody({ done, over }),
    ...(household ? { household_plans: household } : null),
  }
}
// /api/plants: every planting sits in its project's place; /api/locations/with-path names the places.
const PLANTS = (() => {
  const { water, pest } = items()
  return [...water, ...pest].map(it => ({ id: it.id, location_id: LOC[it.project_id], container_type: null }))
})()
const PATHS = Object.entries(PLACE).map(([id, full_path]) => ({ id, full_path, name: full_path }))

const lists = () => screen.getAllByTestId('today-care')
const ownList = () => lists()[0]
const headersIn = (list) => within(list).queryAllByTestId('care-group').map(g => g.querySelector('button[aria-expanded]'))
const labelsIn = (list) => headersIn(list).map(b => b.querySelector('span').textContent)
const openIn = (list) => headersIn(list).filter(b => b.getAttribute('aria-expanded') === 'true').map(b => b.querySelector('span').textContent)
const headerLabels = () => labelsIn(ownList())
const expandedLabels = () => openIn(ownList())
const toggleIn = (list, label) => fireEvent.click(headersIn(list).find(b => b.querySelector('span').textContent === label))
const toggle = (label) => toggleIn(ownList(), label)
const countIn = (list, label) => {
  const b = headersIn(list).find(x => x.querySelector('span').textContent === label)
  return b ? b.querySelectorAll('span')[1].textContent : null
}
const isPlan = (p) => typeof p === 'string' && /^\/api\/daily-plan(\?|$)/.test(p)
const planCalls = () => fetchMock.mock.calls.filter(c => isPlan(c[0])).length
const visitKeys = () => Object.keys(sessionStorage).filter(k => k.startsWith(VISIT_PREFIX)).sort()
const StrictWrap = (x) => <React.StrictMode>{x}</React.StrictMode>
const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve() }) }

let plans, members, holdPaths, pathWaiters
beforeEach(() => {
  cache.__resetDataCache()
  identity.current = DAVE
  plans = []
  members = { members: [] }
  holdPaths = false; pathWaiters = []
  fetchMock.mockReset(); toastMock.show.mockReset(); toastMock.showUndo.mockReset()
  let n = 0
  fetchMock.mockImplementation((path, opts) => {
    if (isPlan(path)) return Promise.resolve(plans.shift())
    if (path === '/api/members') return Promise.resolve(members)
    if (path === '/api/plants') return Promise.resolve(PLANTS)
    if (path === '/api/locations/with-path') {
      if (holdPaths) return new Promise(res => pathWaiters.push(() => res(PATHS)))
      return Promise.resolve(PATHS)
    }
    if (path === '/api/events' && opts?.method === 'POST') return Promise.resolve({ id: 'ev-' + (++n) })
    return Promise.resolve([])
  })
  sessionStorage.clear()
  localStorage.clear()
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

// Opens Today on `env` and waits for the location names: the settled, location-keyed list.
async function openToday(env, wrap = (x) => x) {
  plans.push(env)
  const view = render(wrap(<Today />))
  await waitFor(() => expect(screen.queryAllByTestId('today-care').length > 0).toBe(true))
  await waitFor(() => expect(headerLabels().length > 0 && headerLabels().every(l => !PROJECT_LABELS.has(l))).toBe(true))
  await settle()
  return view
}

// Every header sequence the own list COMMITS to the DOM, recorded as it happens — so a fresh take that
// is painted and then replaced cannot hide behind a later assertion.
function recordFrames() {
  const frames = []
  const snap = () => {
    const list = screen.queryAllByTestId('today-care')[0]
    if (list) frames.push(labelsIn(list).join(' | '))
  }
  const mo = new MutationObserver(snap)
  mo.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true })
  return { frames, stop: () => { snap(); mo.disconnect() } }
}

describe('BUG-TODAYBACKRESORT-001 — Back from a planting keeps the section order and the open sections', () => {
  it('remount on the same plan day: the held order and open set come back, though the refetched plan ranks differently', async () => {
    const first = await openToday(envelope())
    expect(headerLabels()).toEqual(ARRIVAL)
    expect(expandedLabels()).toEqual(['Drive Bed'])
    // A non-default open set: the lead closed by hand, a lower section opened by hand.
    toggle('Drive Bed')
    toggle('Pasture Bed')
    expect(expandedLabels()).toEqual(['Pasture Bed'])
    first.unmount()                                    // the tap into a planting

    // Back: the refetch has Dave's three Drive waterings done, which a fresh take ranks last.
    holdPaths = true
    const rec = recordFrames()
    plans.push(envelope({ done: ['d1', 'd2', 'd3'] }))
    render(<Today />)
    await waitFor(() => expect(pathWaiters.length).toBe(1))
    await settle()
    // Before the names land the rows are keyed by project — a different set of sections, which no held
    // location order can apply to; this frame is the one every open of Today has always shown.
    expect(headerLabels().every(l => PROJECT_LABELS.has(l))).toBe(true)
    await act(async () => { pathWaiters.shift()() })
    await settle()
    rec.stop()
    expect(headerLabels()).toEqual(ARRIVAL)
    expect(expandedLabels()).toEqual(['Pasture Bed'])
    // Rows are NOT held: the sections' contents follow the refetched plan.
    expect(countIn(ownList(), 'Drive Bed')).toBe('2')
    // No frame ever painted a location order other than the held one (no fresh take shown, then fixed).
    const placeFrames = [...new Set(rec.frames)].filter(f => f && f.split(' | ').every(l => !PROJECT_LABELS.has(l)))
    expect(placeFrames).toEqual([ARRIVAL.join(' | ')])

    // Control: the same refetched plan with the visit layout gone (a new tab) takes fresh — which is
    // the order the remount above would have shown without the store.
    cleanup()
    sessionStorage.clear()
    holdPaths = false
    await openToday(envelope({ done: ['d1', 'd2', 'd3'] }))
    expect(headerLabels()).toEqual(RERANKED)
    expect(expandedLabels()).toEqual(['Bag Bed'])
  })

  it('a section new in the refetched plan is appended, collapsed, behind the held ones', async () => {
    const first = await openToday(envelope())
    first.unmount()
    // Back: Pasture is now far overdue (a fresh take would lead with it) and a Shed section is new.
    const env = envelope({ over: { c1: 9, c2: 9, c3: 9 } })
    env.plan.water_due.push(w('s1', 'Shed One', 'Shed', 'prS', 12))
    plans.push(env)
    render(<Today />)
    await waitFor(() => expect(headerLabels()).toEqual([...ARRIVAL, 'Shed']))
    expect(expandedLabels()).toEqual(['Drive Bed'])
  })

  it('left again before the names land (Back, then straight into another plant): the held layout survives', async () => {
    const first = await openToday(envelope())
    toggle('Drive Bed')
    toggle('Pasture Bed')
    first.unmount()
    // Back, and gone again inside the round trip: the transient first take must not be written over it.
    holdPaths = true
    plans.push(envelope({ done: ['d1', 'd2', 'd3'] }))
    const second = render(<Today />)
    await waitFor(() => expect(pathWaiters.length).toBe(1))
    await settle()
    second.unmount()
    holdPaths = false
    await openToday(envelope({ done: ['d1', 'd2', 'd3'] }))
    expect(headerLabels()).toEqual(ARRIVAL)
    expect(expandedLabels()).toEqual(['Pasture Bed'])
  })

  it('a By type tap made before the names land re-takes, and that is what the next Back brings', async () => {
    const first = await openToday(envelope())
    first.unmount()
    holdPaths = true
    plans.push(envelope({ done: ['d1', 'd2', 'd3'] }))
    const second = render(<Today />)
    await waitFor(() => expect(pathWaiters.length).toBe(1))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'By type' }))
    await waitFor(() => expect(headerLabels()).toEqual(['Water', 'Check']))
    await act(async () => { pathWaiters.shift()() })
    await settle()
    expect(headerLabels()).toEqual(['Water', 'Check'])
    second.unmount()
    holdPaths = false
    plans.push(envelope())
    render(<Today />)
    await waitFor(() => expect(headerLabels()).toEqual(['Water', 'Check']))
    await settle()
    expect(screen.getByRole('button', { name: 'By type' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('a new plan day landing while a held layout still waits for the names: the new day starts fresh', async () => {
    // The wake path (as TodayGroupOrderWake): useDailyPlan revalidates on `focus` past its 60 s floor.
    let skew = 0
    const realNow = Date.now.bind(Date)
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skew)
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    const first = await openToday(envelope())
    toggle('Drive Bed')
    toggle('Pasture Bed')
    first.unmount()
    // Back, just before midnight's refetch: the names are still on their way ...
    holdPaths = true
    plans.push(envelope({ done: ['d1', 'd2', 'd3'] }))
    render(<Today />)
    await waitFor(() => expect(pathWaiters.length).toBe(1))
    await settle()
    const yesterday = screen.getByTestId('today-date').textContent
    // ... and the next day's plan lands first. Yesterday's held layout must not be adopted into it.
    plans.push(envelope({ date: dayISO(1), done: ['d1', 'd2', 'd3'] }))
    const before = planCalls()
    skew += 61_000
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => expect(planCalls()).toBe(before + 1))
    await waitFor(() => expect(screen.getByTestId('today-date').textContent).not.toBe(yesterday))
    await act(async () => { pathWaiters.shift()() })
    await settle()
    expect(headerLabels()).toEqual(RERANKED)
    expect(expandedLabels()).toEqual(['Bag Bed'])
  })

  it('under <StrictMode>: restored, with no render-loop error', async () => {
    const errs = vi.spyOn(console, 'error').mockImplementation(() => {})
    const first = await openToday(envelope(), StrictWrap)
    toggle('Bag Bed')
    expect(expandedLabels()).toEqual(['Drive Bed', 'Bag Bed'])
    first.unmount()
    await openToday(envelope({ done: ['d1', 'd2', 'd3'] }), StrictWrap)
    expect(headerLabels()).toEqual(ARRIVAL)
    expect(expandedLabels()).toEqual(['Drive Bed', 'Bag Bed'])
    const loopish = errs.mock.calls.map(c => String(c[0])).filter(m => /Too many re-renders|Cannot update a component|Maximum update depth/.test(m))
    expect(loopish).toEqual([])
  })

  it('a By type tap re-takes and is held; a By location tap re-takes again and THAT order is held', async () => {
    const first = await openToday(envelope())
    fireEvent.click(screen.getByRole('button', { name: 'By type' }))
    await waitFor(() => expect(headerLabels()).toEqual(['Water', 'Check']))
    toggle('Check')
    const typeOpen = expandedLabels()
    expect(typeOpen.includes('Check')).toBe(true)
    first.unmount()

    // Back: still By type, the same sections open.
    const second = await (async () => {
      plans.push(envelope({ done: ['d1', 'd2', 'd3'] }))
      const v = render(<Today />)
      await waitFor(() => expect(headerLabels()).toEqual(['Water', 'Check']))
      await settle()
      return v
    })()
    expect(screen.getByRole('button', { name: 'By type' }).getAttribute('aria-pressed')).toBe('true')
    await waitFor(() => expect(expandedLabels()).toEqual(typeOpen))

    // By location, on purpose: re-ranked over the work left (Drive has only 2 rows now) ...
    fireEvent.click(screen.getByRole('button', { name: 'By location' }))
    await waitFor(() => expect(headerLabels()).toEqual(RERANKED))
    second.unmount()
    // ... and that is what Back brings back, though this plan (nothing done) would lead with Drive.
    await openToday(envelope())
    expect(headerLabels()).toEqual(RERANKED)
    expect(screen.getByRole('button', { name: 'By location' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('a new plan day starts fresh, and the old day\'s entries are pruned', async () => {
    const first = await openToday(envelope())
    toggle('Drive Bed')
    toggle('Pasture Bed')
    expect(visitKeys()).toEqual([VISIT_PREFIX + 'sub-dave:' + todayISO() + ':own'])
    first.unmount()
    // Next morning's plan, with yesterday's Drive work done: a fresh take, the fresh open set.
    await openToday(envelope({ date: dayISO(1), done: ['d1', 'd2', 'd3'] }))
    expect(headerLabels()).toEqual(RERANKED)
    expect(expandedLabels()).toEqual(['Bag Bed'])
    expect(visitKeys()).toEqual([VISIT_PREFIX + 'sub-dave:' + dayISO(1) + ':own'])
  })

  it('the household list is held under its OWN key, apart from Dave\'s', async () => {
    members = { members: [{ id: 'sub-dave', display_name: 'Dave N' }, { id: 'jen', display_name: 'Jen Example' }] }
    await openToday(envelope())
    // Jen's plan leads with Pasture; Dave's with Drive.
    const jenPlan = (opts = {}) => planBody({ over: { c1: 9, c2: 9, c3: 9 }, ...opts })
    plans.push(envelope({ household: [{ user_id: 'jen', plan: jenPlan() }] }))
    fireEvent.click(await screen.findByTestId('today-household-toggle'))
    await waitFor(() => expect(lists().length).toBe(2))
    const hh = () => lists()[1]
    await waitFor(() => expect(labelsIn(hh())).toEqual(['Pasture Bed', 'Drive Bed', 'Bag Bed']))
    toggleIn(hh(), 'Bag Bed')
    const jenOpen = openIn(hh())
    expect(jenOpen).toEqual(['Pasture Bed', 'Bag Bed'])
    expect(headerLabels()).toEqual(ARRIVAL)
    expect(visitKeys()).toEqual([
      VISIT_PREFIX + 'sub-dave:' + todayISO() + ':jen',
      VISIT_PREFIX + 'sub-dave:' + todayISO() + ':own',
    ])
    cleanup()

    // Back: both refetched plans would rank differently (Jen's Pasture work done; Dave's Drive work done).
    plans.push(envelope({ done: ['d1', 'd2', 'd3'], household: [{ user_id: 'jen', plan: jenPlan({ done: ['c1', 'c2', 'c3'] }) }] }))
    render(<Today />)
    await waitFor(() => expect(lists().length).toBe(2))
    await waitFor(() => expect(labelsIn(lists()[1])).toEqual(['Pasture Bed', 'Drive Bed', 'Bag Bed']))
    await settle()
    expect(openIn(lists()[1])).toEqual(jenOpen)
    expect(headerLabels()).toEqual(ARRIVAL)
    expect(expandedLabels()).toEqual(['Drive Bed'])
  })
})

describe('BUG-TODAYBACKRESORT-001 — what the visit layout holds, and who can read it', () => {
  it('holds only the order and the open set: no fade, no pending key, no row', async () => {
    await openToday(envelope())
    fireEvent.click(within(ownList()).getByRole('button', { name: 'Log Water for Drive One' }))
    await waitFor(() => expect(within(ownList()).queryByText('Drive One')).toBeNull())
    fireEvent.click(within(ownList()).getByRole('button', { name: 'Skip Drive Two today' }))
    await settle()
    const [key] = visitKeys()
    const stored = JSON.parse(sessionStorage.getItem(key))
    expect(Object.keys(stored).sort()).toEqual(['enriched', 'mode', 'open', 'order', 'v'])
    expect(stored).toEqual({ v: 1, mode: 'location', enriched: true, order: ['locD', 'locB', 'locC'], open: ['locD'] })
    expect(sessionStorage.getItem(key).includes('d1')).toBe(false)
  })

  it('a logged row is NOT restored hidden: after Back it follows the refetched plan', async () => {
    const first = await openToday(envelope())
    fireEvent.click(within(ownList()).getByRole('button', { name: 'Log Water for Drive One' }))
    await waitFor(() => expect(within(ownList()).queryByText('Drive One')).toBeNull())
    first.unmount()
    // A refetch read before the write committed still lists Drive One as due: it shows, as before.
    await openToday(envelope())
    expect(headerLabels()).toEqual(ARRIVAL)
    expect(within(ownList()).queryByText('Drive One')).toBeTruthy()
  })

  it('no signed-in user: nothing is written and a remount takes fresh (the pre-fix behaviour)', async () => {
    identity.current = { user: null, profile: null, loading: false }
    const first = await openToday(envelope())
    toggle('Pasture Bed')
    expect(visitKeys()).toEqual([])
    first.unmount()
    await openToday(envelope({ done: ['d1', 'd2', 'd3'] }))
    expect(headerLabels()).toEqual(RERANKED)
  })

  it('another signed-in user on the same tab and day does not get Dave\'s layout', async () => {
    const first = await openToday(envelope())
    toggle('Pasture Bed')
    first.unmount()
    identity.current = { user: { id: 'jen' }, profile: { id: 'jen' }, loading: false }
    await openToday(envelope({ done: ['d1', 'd2', 'd3'] }))
    expect(headerLabels()).toEqual(RERANKED)
  })

  it('sign-out clears it: after clearClientPrefs the remount takes fresh', async () => {
    const first = await openToday(envelope())
    toggle('Pasture Bed')
    first.unmount()
    expect(visitKeys().length).toBe(1)
    clearClientPrefs()
    expect(visitKeys()).toEqual([])
    await openToday(envelope({ done: ['d1', 'd2', 'd3'] }))
    expect(headerLabels()).toEqual(RERANKED)
    expect(planCalls()).toBe(2)
  })
})
