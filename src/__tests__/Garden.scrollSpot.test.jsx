// BUG-DETAILPAGESCARRYSCROLL-001 (rimpact-scrollmanager MINOR-2, design-scrollmanager-pwa §2.7) — Garden's
// "back to your spot" under the app-level page-scroll manager.
//
// The manager zeroes the scroll in every commit that opens Garden, and that zero fires a scroll event a frame
// later. Garden's recorder used to file EVERY scroll event, and its restore read the module-level spot only
// once its lists had loaded — so whether the zero reached the recorder first depended on how long the commit
// took, and when it did the spot was 0 and gone. Now the spot is SNAPSHOTTED at first render and the recorder
// files nothing until the restore has resolved; a visit left before that keeps the old spot. Garden also claims
// its entry from the manager when it has a spot, so a Back into Garden is Garden's to restore.
//
// THE DEPARTURE HALF (qa-scrollmanager-built BLOCKING): leaving Garden, the manager zeroes the scroll for the
// NEXT page, and that zero's scroll event can reach Garden's recorder before React's passive cleanup removes
// it — real Chrome, garden-tab-4x red 2/32 at 4x CPU, garden-tab 9/12 at 8x. The recorder now files nothing
// once the history no longer shows Garden; the repro below (QA's, adopted) fails without that guard.
//
// jsdom cannot race a commit against a frame, so each race is written out: the zero's scroll event is
// dispatched between the mount and the restore's first frame, or between the history write and the unmount.
// The real-Chrome half (1x, 4x, 8x CPU) is gate:page-scroll's garden-tab and garden-tab-4x.
//
// FLAG-AWARE (rimpact-scrollmanager-built N2): the flag is mocked live, and the manager-OFF block pins today's
// contract — Garden restores its last recorded spot on every mount and claims nothing — so a forward flag-off
// build passes this file. Mocks as Garden.resumeGate.test.jsx.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'

const { flags } = vi.hoisted(() => ({ flags: { manager: true } }))
vi.mock('../lib/featureFlags.js', async (importOriginal) => ({
  ...(await importOriginal()),
  get SCROLL_MANAGER_ENABLED() { return flags.manager },
}))
vi.mock('react-router-dom', () => {
  const sp = new URLSearchParams()
  return {
    Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
    useLocation: () => ({ pathname: '/garden', search: '', state: null }),
    useNavigate: () => () => {},
    useSearchParams: () => [sp, () => {}],
  }
})
const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn().mockResolvedValue('t') }), apiFetch: (...a) => fetchMock(...a) }))
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

const PROJECTS = [{ id: 'a', name: 'Tomatoes', status: 'active', parent_project_id: null, is_public: true }]
const PLANTS = [{ id: 'p1', name: 'Sungold', project_id: 'a', status: 'growing', quantity: 1 }]

let claims
let scrollCalls
let frames
const api = { claim: (entry) => { claims.push(entry); return () => {} }, yieldScroll: () => {} }
const setY = (y) => Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: y })
// A scroll event at `y` — the user's, or the manager's zero landing a frame after a commit.
const scrollEvent = (y) => act(() => { setY(y); window.dispatchEvent(new Event('scroll')) })
const runFrames = (n) => act(() => { for (let i = 0; i < n; i++) { const due = frames; frames = []; due.forEach((cb) => cb()) } })
// Garden's entry as BrowserRouter leaves it: its own URL and a router key.
const onGarden = (key) => window.history.replaceState({ key }, '', '/garden')

beforeEach(() => {
  flags.manager = true
  claims = []
  scrollCalls = []
  frames = []
  localStorage.clear()
  fetchMock.mockReset()
  fetchMock.mockImplementation((url) => Promise.resolve(url === '/api/projects' ? PROJECTS : url === '/api/plants?view=grid' ? PLANTS : []))
  setY(0)
  // A tall enough page: every restore attempt lands where it aims.
  window.scrollTo = vi.fn((a, b) => { const y = a && typeof a === 'object' ? a.top : b; scrollCalls.push(y); setY(y) })
  window.requestAnimationFrame = (cb) => { frames.push(cb); return frames.length }
  window.cancelAnimationFrame = () => {}
  onGarden('k-garden')
})
afterEach(() => {
  cleanup()
  window.history.replaceState(null, '', '/')
})

const mountGarden = async () => {
  let utils
  await act(async () => { utils = render(<PageScrollProvider value={{ api, isReturn: false }}><Garden /></PageScrollProvider>) })
  await screen.findByText(/Log many/)
  return utils
}
// Land on Garden, let any restore resolve (the recorder opens), then scroll to `y`: the spot is now `y`.
const setSpot = async (y) => {
  const v = await mountGarden()
  runFrames(25)
  scrollEvent(y)
  v.unmount()
}

describe('manager ON: Garden\'s spot', () => {
  it('the zero that opens Garden never becomes its spot, a visit left before the restore resolves keeps the spot, and Garden claims its entry', async () => {
    await setSpot(500)

    // Visit 2: Garden has a spot, so it claims its entry. The manager's zero lands BEFORE the restore's
    // first frame — the race — and the visit ends before the restore resolves.
    claims = []
    let v = await mountGarden()
    expect(claims).toEqual(['k-garden'])
    scrollEvent(0)
    v.unmount()

    // Visit 3: the spot is still 500.
    scrollCalls = []
    v = await mountGarden()
    runFrames(3)
    expect(scrollCalls[0]).toBe(500)
    expect(window.scrollY).toBe(500)
    // Once the restore has resolved the recorder is open again: a real scroll is the new spot.
    runFrames(25)
    scrollEvent(720)
    v.unmount()
    scrollCalls = []
    await mountGarden()
    runFrames(3)
    expect(scrollCalls[0]).toBe(720)
  })

  // QA's repro, adopted. The Today tab has written its entry; the manager's zero for Today lands while
  // Garden is still mounted (its passive cleanup has not run). Fails without the history guard: claims []
  // and a restore to nothing, because the spot became 0.
  it('LEAVING Garden: the next page\'s zero, landing before the unmount, never becomes the spot', async () => {
    await setSpot(500)
    let v = await mountGarden()
    runFrames(25)                                       // the restore resolves; the recorder is open
    window.history.pushState({ key: 'k-today' }, '', '/today')
    scrollEvent(0)                                      // the reset's event, cleanup not yet run
    v.unmount()
    onGarden('k-garden-2')                              // the Garden tab again: a new entry
    scrollCalls = []
    claims = []
    v = await mountGarden()
    runFrames(3)
    expect(claims).toEqual(['k-garden-2'])
    expect(scrollCalls[0]).toBe(500)
  })

  it('control: the same visit with no late event keeps the spot too (the guard only drops the next page\'s event)', async () => {
    await setSpot(500)
    const v = await mountGarden()
    runFrames(25)
    window.history.pushState({ key: 'k-today' }, '', '/today')
    v.unmount()
    onGarden('k-garden-2')
    scrollCalls = []
    await mountGarden()
    runFrames(3)
    expect(scrollCalls[0]).toBe(500)
  })

  it('Garden\'s own same-page writes keep recording: a scroll after an ?add strip (a new key, the same path) is the spot', async () => {
    await setSpot(300)
    const v = await mountGarden()
    runFrames(25)
    window.history.replaceState({ key: 'k-garden-stripped' }, '', '/garden')   // the ?add strip's REPLACE
    scrollEvent(640)
    v.unmount()
    scrollCalls = []
    await mountGarden()
    runFrames(3)
    expect(scrollCalls[0]).toBe(640)
  })

  it('under a route overlay over Garden (the entry\'s background is /garden) the recorder still records, as today', async () => {
    await setSpot(300)
    const v = await mountGarden()
    runFrames(25)
    window.history.pushState({ key: 'k-search', usr: { background: { pathname: '/garden', key: 'k-garden' } } }, '', '/search')
    scrollEvent(410)
    v.unmount()
    onGarden('k-garden')
    scrollCalls = []
    await mountGarden()
    runFrames(3)
    expect(scrollCalls[0]).toBe(410)
  })

  it('at the top, Garden claims nothing: the manager owns that entry like any other page\'s', async () => {
    await setSpot(0)
    claims = []
    await mountGarden()
    expect(claims).toEqual([])
  })
})

describe('manager OFF (the rollback bundle): today\'s contract', () => {
  beforeEach(() => { flags.manager = false })

  it('Garden restores its last recorded spot on every mount, and claims nothing', async () => {
    await setSpot(500)
    claims = []
    scrollCalls = []
    await mountGarden()
    runFrames(3)
    expect(scrollCalls[0]).toBe(500)
    expect(claims).toEqual([])
  })

  it('the recorder files every scroll event, as before the manager (no history guard, no write closure)', async () => {
    await setSpot(500)
    const v = await mountGarden()
    scrollEvent(260)                                    // before the restore resolves: today this IS the spot
    v.unmount()
    scrollCalls = []
    await mountGarden()
    runFrames(3)
    expect(scrollCalls[0]).toBe(260)
  })
})
