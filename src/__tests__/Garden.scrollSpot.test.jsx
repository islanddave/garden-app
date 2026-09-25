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
// jsdom cannot race a commit against a frame, so the race is written out: the zero's scroll event is dispatched
// between the mount and the restore's first frame. The real-Chrome half (1x and 4x CPU) is gate:page-scroll's
// garden-tab and garden-tab-4x. Mocks as Garden.resumeGate.test.jsx.
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
const api = { claim: (entry) => { claims.push(entry); return () => {} } }
const setY = (y) => Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: y })
// A scroll event at `y` — the user's, or the manager's zero landing a frame after the commit.
const scrollEvent = (y) => act(() => { setY(y); window.dispatchEvent(new Event('scroll')) })
const runFrames = (n) => act(() => { for (let i = 0; i < n; i++) { const due = frames; frames = []; due.forEach((cb) => cb()) } })

beforeEach(() => {
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
  window.history.replaceState({ key: 'k-garden' }, '')
})
afterEach(() => {
  cleanup()
  window.history.replaceState(null, '')
})

const mountGarden = async () => {
  let utils
  await act(async () => { utils = render(<PageScrollProvider value={{ api, isReturn: false }}><Garden /></PageScrollProvider>) })
  await screen.findByText(/Log many/)
  return utils
}

describe('Garden\'s spot under the page-scroll manager', () => {
  it('the zero that opens Garden never becomes its spot, a visit left before the restore resolves keeps the spot, and Garden claims its entry', async () => {
    // Visit 1: land (a spot of 0 or whatever an earlier test left is restored first), then scroll to 500.
    let v = await mountGarden()
    runFrames(25)                                       // any restore resolves; the recorder opens
    scrollEvent(500)
    v.unmount()

    // Visit 2: Garden has a spot, so it claims its entry. The manager's zero lands BEFORE the restore's
    // first frame — the race — and the visit ends before the restore resolves.
    claims = []
    v = await mountGarden()
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

  it('at the top, Garden claims nothing: the manager owns that entry like any other page\'s', async () => {
    // Bring the spot to 0: land, resolve, scroll to the top.
    let v = await mountGarden()
    runFrames(25)
    scrollEvent(0)
    v.unmount()
    claims = []
    v = await mountGarden()
    expect(claims).toEqual([])
  })
})
