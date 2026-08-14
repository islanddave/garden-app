/**
 * src/__tests__/ProjectDetail.scrollRestore.test.jsx
 * V4-SCROLLRESTORE-001 (BD0806-05) — ProjectDetail's half of the back-nav restore.
 *
 * Its own file, not an addition to ProjectDetail.eventPaging.test.jsx, for the reason the
 * PhotoLibrary suite states: the ProjectDetail suites are shared across lanes and editing a shared
 * file to add coverage is how two green lanes merge red.
 *
 * The page-level claim under test is the ORDERING one, and on this page it is sharper than anywhere
 * else in the app. The event log is SERVER-paged (Route 4 &offset=, BUG-PROJEVENTTRUNC-001) and a
 * remount fetches page 0 only, so a remount that restored only the offset would aim a deep target at
 * a document holding one page, be clamped by the browser, and lose the place regardless. jsdom
 * computes no layout, so what is proven here is that the right NUMBER OF ROWS is mounted BEFORE the
 * first scrollTo and that the right offset is requested — not that the pixels line up.
 *
 * Frame budgets: every POSITIVE assertion pumps frames until the restore lands, within the hook's
 * own ~20-frame budget, rather than spending an exact count. A fixed count is a stopwatch, not an
 * assertion — under worker-pool contention the restore effect has not armed yet and the suite goes
 * red on code that is fine. NEGATIVE assertions ("nothing moved the viewport") keep a fixed budget,
 * because there is no event to wait for.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react'

const { apiFetchSpy, navigateSpy, paramsRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  paramsRef: { id: 'proj-1' },
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => (<a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>),
  useParams: () => paramsRef,
  useNavigate: () => navigateSpy,
}))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: vi.fn(), isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))
vi.mock('../components/PhotoUpload.jsx', () => ({ default: () => <div data-testid="photo-upload-stub" /> }))
vi.mock('../components/Breadcrumb.jsx', () => ({ default: () => <div data-testid="breadcrumb-stub" /> }))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <div data-testid="favorite-toggle-stub" /> }))
vi.mock('../components/AssigneePicker.jsx', () => ({ default: () => <div data-testid="assignee-stub" /> }))
vi.mock('../lib/status.js', () => ({ getStatusColors: () => ({ bg: '#fff', text: '#000', border: '#ccc' }) }))

import ProjectDetail from '../pages/ProjectDetail.jsx'
import {
  __resetScrollRestoreStore,
  __seedScrollRestoreEntry,
  __peekScrollRestoreEntry,
} from '../hooks/useScrollRestore.js'

const PROJECT = {
  id: 'proj-1', name: 'Peppers', slug: 'peppers', status: 'growing',
  is_public: false, start_date: '2026-03-15', parent_project_id: null,
  version: 4, variety: null, species: null, description: null, location_id: null,
  event_count: 5257,
}

const ev = (n) => ({
  id: `ev-${n}`, event_type: 'observation', event_date: '2026-05-10T12:00:00.000Z',
  title: `Event ${n}`, notes: null, private_notes: null, quantity: null,
})
const page = (from, count) => Array.from({ length: count }, (_, i) => ev(from + i))

const rows = () => screen.queryAllByTitle('Delete event')
const listCalls = () => apiFetchSpy.mock.calls
  .filter(([p, o]) => p.startsWith('/api/events?project_id=proj-1') && (o?.method ?? 'GET') === 'GET')
  .map(([p]) => p)

// Rows mounted at the instant of each scrollTo. This is the ordering claim in a form jsdom can
// actually answer: it does not need layout, only "how much content existed when we aimed".
let rowsAtScroll = []

/**
 * @param pages   offset -> envelope
 * @param endless when true, every offset answers a full page with has_more, which is what a
 *                genuinely huge log looks like and what the walk's request bound has to survive.
 */
function wire({ pages = {}, endless = false, pageSize = 3 } = {}) {
  apiFetchSpy.mockImplementation((path, opts = {}) => {
    const method = opts.method ?? 'GET'
    if (path.startsWith('/api/events?project_id=proj-1') && method === 'GET') {
      const offset = Number(new URLSearchParams(path.split('?')[1]).get('offset'))
      if (endless) return Promise.resolve({ events: page(offset + 1, pageSize), limit: 200, offset, has_more: true })
      return Promise.resolve(pages[offset] ?? { events: [], limit: 200, offset, has_more: false })
    }
    if (path === '/api/projects/proj-1') return Promise.resolve(PROJECT)
    if (path.startsWith('/api/projects?parent_id=')) return Promise.resolve([])
    if (path === '/api/locations/with-path') return Promise.resolve([])
    if (path.startsWith('/api/projects')) return Promise.resolve([PROJECT])
    if (path.startsWith('/api/plants')) return Promise.resolve([])
    return Promise.resolve(null)
  })
}

let maxScroll = 0
let frameQueue = new Map()
let frameId = 0
function flushFrames(n = 1) {
  for (let i = 0; i < n; i++) {
    const due = [...frameQueue.values()]
    frameQueue.clear()
    for (const cb of due) cb()
  }
}
// See the header note: pump until the claim holds, bounded by real time, never by a frame count.
//
// WHERE IT IS CALLED IS PART OF THE ASSERTION. This drains frames in a loop while the page's fetch
// promises are still resolving, so the restore fires on the first frame after the effect arms —
// which is the whole point of the ordering tests below. Waiting for the content FIRST and pumping
// afterwards would let every frame land against the finished DOM and would pass against a page that
// restores far too early; that mistake made the first version of this file's ordering test survive
// its own mutation.
async function pumpFramesUntil(done) {
  await waitFor(() => {
    act(() => flushFrames(1))
    if (!done()) throw new Error('not yet restored')
  }, { timeout: 5000, interval: 0 })
}
function setScrollY(y) {
  Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: y })
}

beforeEach(() => {
  __resetScrollRestoreStore()
  apiFetchSpy.mockReset()
  navigateSpy.mockReset()
  maxScroll = 0
  frameQueue = new Map()
  frameId = 0
  rowsAtScroll = []
  setScrollY(0)
  window.scrollTo = vi.fn((x, y) => { rowsAtScroll.push(rows().length); setScrollY(Math.min(y, maxScroll)) })
  window.requestAnimationFrame = (cb) => { const id = ++frameId; frameQueue.set(id, cb); return id }
  window.cancelAnimationFrame = (id) => { frameQueue.delete(id) }
  window.history.replaceState({ key: 'project-entry' }, '')
})

afterEach(() => {
  cleanup()
  __resetScrollRestoreStore()
  window.history.replaceState(null, '')
})

describe('ProjectDetail — back-nav scroll restore', () => {
  it('does not touch the viewport on a history entry it has never seen', async () => {
    wire({ pages: { 0: { events: page(1, 3), has_more: false } } })
    render(<ProjectDetail />)
    await waitFor(() => expect(rows()).toHaveLength(3))
    // Fixed budget on purpose: this asserts an event that must NEVER arrive, so there is nothing
    // to wait for and a generous drain is the strongest form of the claim.
    act(() => flushFrames(5))
    expect(window.scrollTo).not.toHaveBeenCalled()
  })

  it('restores the offset once the log has landed, and not before', async () => {
    wire({ pages: { 0: { events: page(1, 3), has_more: false } } })
    __seedScrollRestoreEntry('project-detail', 900, 3)
    maxScroll = 4000
    render(<ProjectDetail />)
    await pumpFramesUntil(() => window.scrollTo.mock.calls.length > 0)
    expect(window.scrollTo).toHaveBeenCalledWith(0, 900)
    expect(window.scrollY).toBe(900)
    // Frames were being drained from the first render, so this says the restore waited for content
    // rather than firing at the spinner. MUTATION: pass `ready: true` -> RED at 0.
    expect(rowsAtScroll[0]).toBe(3)
  })

  // THE ORDERING CLAIM. The user was 5 rows deep across two server pages; page 0 alone is 3. The
  // second page must already be in the DOM the first time the viewport is aimed, or the browser
  // clamps the target to a document a fraction of its old height.
  // MUTATION: pass `ready: !loading && !eventsLoading` (drop depthRestored) -> RED, first aim at 3.
  it('re-walks the paging depth BEFORE the first restore attempt', async () => {
    wire({ pages: { 0: { events: page(1, 3), has_more: true }, 3: { events: page(4, 2), has_more: false } } })
    __seedScrollRestoreEntry('project-detail', 900, 5)
    maxScroll = 4000
    render(<ProjectDetail />)

    // Frames are drained from the first render, so the FIRST aim is taken as early as the page
    // allows it. It must still find both pages mounted.
    await pumpFramesUntil(() => window.scrollTo.mock.calls.length > 0)
    expect(rowsAtScroll[0]).toBe(5)
    // …and the second page arrived with no user gesture — no Show more click anywhere in this test.
    expect(listCalls()).toEqual([
      '/api/events?project_id=proj-1&limit=200&offset=0',
      '/api/events?project_id=proj-1&limit=200&offset=3',
    ])
  })

  it('asks for only the depth that was saved, not every page the server offers', async () => {
    wire({ pages: { 0: { events: page(1, 3), has_more: true }, 3: { events: page(4, 3), has_more: true } } })
    __seedScrollRestoreEntry('project-detail', 900, 4)
    maxScroll = 4000
    render(<ProjectDetail />)
    await pumpFramesUntil(() => window.scrollTo.mock.calls.length > 0)
    // Depth 4 is covered by two pages; the third is left for the user's own Show more.
    expect(rowsAtScroll[0]).toBe(6)
    expect(listCalls()).toHaveLength(2)
    expect(screen.queryByTestId('project-event-log-show-more')).not.toBeNull()
  })

  // The request bound, which is the one that actually protects the page: the row bound alone cannot,
  // because loadMoreEvents dedupes by id — a server re-serving rows the page already holds leaves
  // events.length flat and the walk would never reach its target.
  // MUTATION: delete the depthWalks.current >= MAX_RESTORE_PAGES arm -> the suite hangs/blows the
  // request count instead of settling at 3.
  it('stops after two extra requests however deep the saved position was', async () => {
    wire({ endless: true })
    __seedScrollRestoreEntry('project-detail', 900, 100000)
    maxScroll = 4000
    render(<ProjectDetail />)
    await pumpFramesUntil(() => window.scrollTo.mock.calls.length > 0)
    expect(rowsAtScroll[0]).toBe(9)
    expect(listCalls()).toHaveLength(3)          // page 0 + exactly MAX_RESTORE_PAGES walks
    expect(window.scrollTo).toHaveBeenCalledWith(0, 900)
  })

  // A dedupe-flat server: every walk answers with rows the page already holds, so events.length
  // never moves. Without the request bound this is an unbounded fetch loop on a Back.
  it('terminates against a server whose pages the log dedupes away entirely', async () => {
    apiFetchSpy.mockReset()
    wire({ pages: {} })
    const prev = apiFetchSpy.getMockImplementation()
    apiFetchSpy.mockImplementation((path, opts = {}) => (
      path.startsWith('/api/events?project_id=proj-1') && (opts.method ?? 'GET') === 'GET'
        ? Promise.resolve({ events: page(1, 3), limit: 200, offset: 0, has_more: true })
        : prev(path, opts)
    ))
    __seedScrollRestoreEntry('project-detail', 900, 500)
    maxScroll = 4000
    render(<ProjectDetail />)
    await pumpFramesUntil(() => window.scrollTo.mock.calls.length > 0)
    expect(listCalls()).toHaveLength(3)
  })

  it('records the depth it was showing when the user navigated away', async () => {
    wire({ pages: { 0: { events: page(1, 3), has_more: true }, 3: { events: page(4, 2), has_more: false } } })
    const { unmount } = render(<ProjectDetail />)
    await waitFor(() => expect(rows()).toHaveLength(3))
    fireEvent.click(screen.getByTestId('project-event-log-show-more'))
    await waitFor(() => expect(rows()).toHaveLength(5))
    act(() => { setScrollY(1440); window.dispatchEvent(new Event('scroll')) })
    unmount()
    expect(__peekScrollRestoreEntry('project-detail')).toEqual({ y: 1440, s: 5 })
  })

  // Two projects are two history entries, so per-project scoping is structural rather than something
  // this page has to spell. Pinned because the failure mode — one project's offset applied to
  // another's log — is silent and looks like a scroll bug rather than a keying bug.
  it('does not apply one project entry\'s offset to a different entry', async () => {
    wire({ pages: { 0: { events: page(1, 3), has_more: false } } })
    __seedScrollRestoreEntry('project-detail', 900, 3)
    window.history.replaceState({ key: 'a-different-project-entry' }, '')
    maxScroll = 4000
    render(<ProjectDetail />)
    await waitFor(() => expect(rows()).toHaveLength(3))
    act(() => flushFrames(5))
    expect(window.scrollTo).not.toHaveBeenCalled()
  })
})
