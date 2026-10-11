// BUG-GARDENTAGGROUPREPAINT-001 — Garden grouped by a TAG facet (Heat, Determinacy, …) repainted once on every
// return and lost the scroll spot.
//
// THE CAUSE, as this file reproduces it. A tag grouping is offered only once the whole-garden tag map has landed
// (useEntityTagsBulk), and that map is fetched fresh on every mount while the list paints from the cache. So on a
// return the remembered grouping was not offerable for the first paint: Garden fell back to Type, painted that as
// the user's grouping, ran its scroll restore on that page, and regrouped when the map arrived. Now a remembered
// tag grouping HOLDS the list and the restore — the page is its loading state — until the visit's first tag load
// settles or the hold's own deadline passes (the rule and its table: groupByAwaitsTags, gardenGroupBy.test.js).
//
// THE REAL TAGS HOOK RUNS: only `fetch` is faked, and the tag map is a request each test answers when it chooses,
// so "the map is still out" is a state the test holds open rather than a race. jsdom has no layout, so what the
// lost spot looked like (the fallback one screen tall, the restore clamped to it: 4264px off at 426x836) is
// gate:page-scroll's garden-taggroup flow; here the restore is shown not to be ATTEMPTED until the map lands.
// Mocks as Garden.scrollSpot.test.jsx.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'

vi.mock('react-router-dom', () => {
  const sp = new URLSearchParams()
  return {
    Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
    useLocation: () => ({ pathname: '/garden', search: '', state: null }),
    useNavigate: () => () => {},
    useSearchParams: () => [sp, () => {}],
  }
})
// Stable identities, as the real hook's are — and `api.fetch` is swapped by the one test that needs a NEW one
// (a new getToken gives useApiFetch a new fetch, which re-runs the tags hook's load).
const fetchMock = vi.fn()
const api = vi.hoisted(() => ({ fetch: null, getToken: async () => 't' }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: api.fetch, getToken: api.getToken }), apiFetch: (...a) => fetchMock(...a) }))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <span /> }))
vi.mock('../lib/critterClient.js', () => ({
  fetchActiveCritters: vi.fn().mockResolvedValue([]), markCrittersViewed: vi.fn(), patchSpeciesPrefs: vi.fn(),
}))
vi.mock('../lib/notificationPrefsClient.js', () => ({
  fetchNotificationPrefs: vi.fn().mockResolvedValue(null), recordGardenViewOpened: vi.fn(),
  recordCoachmarkDismissed: vi.fn(), recordOptInDismissed: vi.fn(),
  CRITTER_VISIT_VALUES: ['off', 'in_app_only', 'system'],
  GARDEN_GROUP_BY_VALUES: ['none', 'type', 'lifecycle', 'heat', 'determinacy', 'day_length', 'allium_type', 'basil_use', 'location', 'group', 'freeform', 'status'],
  GARDEN_SORT_ORDER_VALUES: ['alpha', 'recency'], GARDEN_EXPANDED_MAX: 2000,
  patchNotificationPrefs: vi.fn(), saveGardenGroupBy: vi.fn(), saveGardenSortOrder: vi.fn(), saveGardenExpanded: vi.fn(),
}))
vi.mock('../components/CritterSprite.jsx', () => ({ default: () => <span /> }))
vi.mock('../components/LoveMehPopover.jsx', () => ({ default: () => null }))

import Garden from '../pages/Garden.jsx'
import { PageScrollProvider } from '../hooks/usePageScrollManager.js'
import { saveGroupBy, saveGroupsExpanded } from '../lib/projectTree.js'
import { TAG_HOLD_MAX_MS } from '../lib/gardenGroupBy.js'
import { __resetDataCache } from '../lib/dataCache.js'

const PLANTS = [
  { id: 'p1', name: 'Sungold', project_id: null, status: 'growing', quantity: 1, variety_ref: { name: 'Sungold F1', crop_type_slug: 'tomato' } },
  { id: 'p2', name: 'Fish', project_id: null, status: 'growing', quantity: 1, variety_ref: { name: 'Fish pepper', crop_type_slug: 'pepper' } },
]
const heat = (slug, label) => ({ id: `t-${slug}`, facet: 'heat', label, slug, source: 'derived' })
const TAGS = { entities: { p1: { direct: [], projected: [heat('mild', 'Mild')] }, p2: { direct: [], projected: [heat('hot', 'Hot')] } } }

let tagMaps        // every tag-map request, in order: { resolve, reject }
let scrollCalls
let frames
const scrollApi = { claim: () => () => {}, yieldScroll: () => {} }
const setY = (y) => Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: y })
const scrollEvent = (y) => act(() => { setY(y); window.dispatchEvent(new Event('scroll')) })
const runFrames = (n) => act(() => { for (let i = 0; i < n; i++) { const due = frames; frames = []; due.forEach((cb) => cb()) } })
const control = () => document.querySelector('select#garden-groupby')
const answerTags = (body = TAGS) => act(async () => { tagMaps[tagMaps.length - 1].resolve(body) })
const tree = () => <PageScrollProvider value={{ api: scrollApi, isReturn: false }}><Garden /></PageScrollProvider>

beforeEach(() => {
  vi.stubEnv('VITE_API_TAGS', 'https://tags.test')
  tagMaps = []
  scrollCalls = []
  frames = []
  localStorage.clear()
  __resetDataCache()
  fetchMock.mockReset()
  fetchMock.mockImplementation((url) => {
    if (url.startsWith('/api/entity-tags')) return new Promise((resolve, reject) => { tagMaps.push({ resolve, reject }) })
    return Promise.resolve(url === '/api/plants?view=grid' ? PLANTS : [])
  })
  api.fetch = (...a) => fetchMock(...a)
  setY(0)
  // A tall enough page: every restore attempt lands where it aims.
  window.scrollTo = vi.fn((a, b) => { const y = a && typeof a === 'object' ? a.top : b; scrollCalls.push(y); setY(y) })
  window.requestAnimationFrame = (cb) => { frames.push(cb); return frames.length }
  window.cancelAnimationFrame = () => {}
  window.history.replaceState({ key: 'k-garden' }, '', '/garden')
  // Both groupings' groups open, so a planting's name on the page means its grouping painted the list.
  saveGroupsExpanded(new Set(['tomato', 'pepper', 'mild', 'hot']))
})
afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
  window.history.replaceState(null, '', '/')
})

// Mount, and let everything BUT the tag map land: the list is in hand, the map is the test's to answer.
const mountGarden = async () => {
  let utils
  await act(async () => { utils = render(tree()) })
  await act(async () => {})
  expect(tagMaps.length).toBeGreaterThan(0)
  return utils
}
// A visit that leaves a spot: the map answered, the restore resolved (the recorder opens), then a scroll to `y`.
const setSpot = async (y) => {
  const v = await mountGarden()
  await answerTags()
  runFrames(25)
  scrollEvent(y)
  v.unmount()
}

describe('a remembered tag grouping, the tag map still out', () => {
  beforeEach(() => { saveGroupBy('heat') })

  it('the Type fallback is never painted: the page is its loading state until the map lands, then the list is in Heat', async () => {
    await mountGarden()
    expect(fetchMock).toHaveBeenCalledWith('/api/entity-tags?entity_type=plant')
    // The list is in hand (the grid answered) and nothing of it is on the page: no control, no group, no planting.
    expect(screen.getByText('Loading…')).toBeTruthy()
    expect(control()).toBeNull()
    expect(screen.queryByText('Sungold')).toBeNull()
    expect(screen.queryByText(/Log many/)).toBeNull()

    await answerTags()
    expect(control().value).toBe('heat')
    expect([...control().options].map((o) => o.value)).toEqual(['crop_type', 'location', 'status', 'heat'])
    expect(screen.getByText('Sungold')).toBeTruthy()
    expect(screen.getByText('Mild')).toBeTruthy()
    expect(screen.getByText('Hot')).toBeTruthy()
    expect(screen.queryByText('Loading…')).toBeNull()
  })

  it('the scroll restore waits for the map too: it is spent on the list that was left, not on the fallback', async () => {
    await setSpot(900)
    scrollCalls = []
    await mountGarden()
    runFrames(25)                       // every frame the restore would have used
    expect(scrollCalls).toEqual([])     // …and it has not been attempted
    await answerTags()
    runFrames(3)
    expect(scrollCalls[0]).toBe(900)
    expect(window.scrollY).toBe(900)
  })

  it('a tag load that fails ends the hold: Garden falls back to Type, as it always has', async () => {
    await mountGarden()
    await act(async () => { tagMaps[0].reject(new Error('Request timed out')) })
    expect(control().value).toBe('crop_type')
    expect(screen.getByText('Sungold')).toBeTruthy()
    expect(screen.queryByText('Loading…')).toBeNull()
  })

  it('only the visit\'s first tag load holds: a later reload of the map never swaps the list for the spinner', async () => {
    const v = await mountGarden()
    await answerTags()
    expect(control().value).toBe('heat')
    // A new fetch identity (a new getToken): the tags hook loads again, and is loading until answered.
    api.fetch = (...a) => fetchMock(...a)
    await act(async () => { v.rerender(tree()) })
    await act(async () => {})
    expect(tagMaps.length).toBe(2)
    expect(control().value).toBe('heat')
    expect(screen.getByText('Sungold')).toBeTruthy()
    expect(screen.queryByText('Loading…')).toBeNull()
    await answerTags()
    expect(control().value).toBe('heat')
    expect(screen.getByText('Sungold')).toBeTruthy()
  })
})

// Review I-1 — the hold has its own deadline. Without one it ended only when the tag request settled, which on a
// radio that is connected but silent is the service worker's 12 s or the API's 15 s: "Loading…" for that long on
// every visit, over a list that was in the cache all along, and then the Type fallback anyway. Past
// TAG_HOLD_MAX_MS Garden is what it was before the hold: the fallback painted, the restore spent on it, a regroup
// when the map lands.
//
// THE CLOCK IS FAKED, setTimeout and clearTimeout ONLY. Garden.resumeGate.test.jsx avoids fake timers because this
// page's mount awaits real promises; those are microtasks and stay real here, as do setImmediate (React's act),
// Date and the frames (stubbed by hand above). So "2499 ms: held, 2500 ms: the list" is the timer itself firing with
// nothing else changing, and `vi.getTimerCount()` is whether it is still armed.
describe('the hold has its own deadline', () => {
  let armed          // how many times the deadline has been armed
  let timeouts
  beforeEach(() => {
    saveGroupBy('heat')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    timeouts = vi.spyOn(globalThis, 'setTimeout')
    armed = () => timeouts.mock.calls.filter(([, ms]) => ms === TAG_HOLD_MAX_MS).length
  })
  afterEach(() => {
    timeouts.mockRestore()
    vi.useRealTimers()
  })
  const pass = (ms) => act(async () => { vi.advanceTimersByTime(ms) })
  // Every grouping the control has shown, in order, read after each commit: a fallback on the page for one commit
  // only is still in the list.
  const watchGroupings = () => {
    const shown = []
    const note = () => { const c = control(); if (c && shown[shown.length - 1] !== c.value) shown.push(c.value) }
    const mo = new MutationObserver(note)
    mo.observe(document.body, { childList: true, subtree: true })
    return { shown, stop: () => { note(); mo.disconnect() } }
  }

  it('a tag load that never settles: at the deadline the list paints in the Type fallback and the restore is attempted', async () => {
    await setSpot(900)
    scrollCalls = []
    await mountGarden()
    expect(armed()).toBe(2)             // one per visit: setSpot's, and this one
    await pass(TAG_HOLD_MAX_MS - 1)
    runFrames(25)
    expect(screen.getByText('Loading…')).toBeTruthy()
    expect(control()).toBeNull()
    expect(scrollCalls).toEqual([])

    await pass(1)                       // nothing else changes: the tag request is still out
    expect(tagMaps.length).toBe(2)
    expect(control().value).toBe('crop_type')
    expect([...control().options].map((o) => o.value)).toEqual(['crop_type', 'location', 'status'])
    expect(screen.getByText('Sungold')).toBeTruthy()
    expect(screen.getByText(/Log many/)).toBeTruthy()
    expect(screen.queryByText('Loading…')).toBeNull()
    runFrames(3)
    expect(scrollCalls[0]).toBe(900)
  })

  it('a tag load that settles at 1 s: the fallback is never painted, and the deadline is cleared', async () => {
    const groupings = watchGroupings()
    await mountGarden()
    expect(vi.getTimerCount()).toBe(1)
    await pass(1000)
    expect(screen.getByText('Loading…')).toBeTruthy()
    await answerTags()
    expect(control().value).toBe('heat')
    expect(vi.getTimerCount()).toBe(0)
    await pass(TAG_HOLD_MAX_MS * 4)     // well past where it would have fired
    groupings.stop()
    expect(groupings.shown).toEqual(['heat'])
    expect(screen.getByText('Mild')).toBeTruthy()
  })

  it('a tag load that settles after the deadline: Garden regroups under the restored list, as it did before the hold', async () => {
    await setSpot(900)
    scrollCalls = []
    const groupings = watchGroupings()
    await mountGarden()
    await pass(TAG_HOLD_MAX_MS)
    runFrames(25)                       // the restore resolves on the fallback's page
    expect(scrollCalls[0]).toBe(900)
    const spent = scrollCalls.length

    await answerTags()
    runFrames(25)
    groupings.stop()
    expect(groupings.shown).toEqual(['crop_type', 'heat'])
    expect(screen.getByText('Mild')).toBeTruthy()
    expect(screen.getByText('Hot')).toBeTruthy()
    expect(scrollCalls.length).toBe(spent)   // the one restore went on the fallback: none for the regrouped list
  })

  it('one deadline per visit: a re-render does not start it again, nor does a later reload of the map', async () => {
    const v = await mountGarden()
    expect(armed()).toBe(1)
    await pass(1000)
    await act(async () => { v.rerender(tree()) })
    expect(armed()).toBe(1)
    await pass(TAG_HOLD_MAX_MS - 1001)  // 2499 ms after the mount, not after the re-render
    expect(screen.getByText('Loading…')).toBeTruthy()
    await pass(1)
    expect(control().value).toBe('crop_type')
    // The first load is STILL out and a new fetch identity starts another (review M-3): no spinner, no new clock.
    api.fetch = (...a) => fetchMock(...a)
    await act(async () => { v.rerender(tree()) })
    await act(async () => {})
    expect(tagMaps.length).toBe(2)
    expect(armed()).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(control().value).toBe('crop_type')
    expect(screen.queryByText('Loading…')).toBeNull()
    await answerTags()
    expect(control().value).toBe('heat')
  })

  it('leaving during the hold clears the deadline', async () => {
    const v = await mountGarden()
    expect(vi.getTimerCount()).toBe(1)
    v.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([['Type', 'crop_type'], ['Lifecycle', 'status'], ['Location', 'location']])('%s remembered: no deadline is armed, there is no hold to end', async (_name, stored) => {
    saveGroupBy(stored)
    await mountGarden()
    expect(armed()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    await pass(TAG_HOLD_MAX_MS * 2)
    expect(control().value).toBe(stored)
  })
})

describe('a structural grouping never waits for the tag map', () => {
  it.each([['Type', 'crop_type'], ['Lifecycle', 'status'], ['Location', 'location'], ['nothing stored', null]])('%s: the list and its restore go ahead with the map still out', async (_name, stored) => {
    if (stored) saveGroupBy(stored)
    await setSpot(640)
    scrollCalls = []
    await mountGarden()
    expect(control().value).toBe(stored ?? 'crop_type')
    expect(screen.getByText(/Log many/)).toBeTruthy()
    expect(screen.queryByText('Loading…')).toBeNull()
    runFrames(3)
    expect(scrollCalls[0]).toBe(640)
  })
})
