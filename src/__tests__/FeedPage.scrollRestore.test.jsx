/**
 * src/__tests__/FeedPage.scrollRestore.test.jsx
 * V4-SCROLLRESTORE-001 (BD0806-05) — FeedPage's half of the back-nav restore.
 *
 * FeedPage is the surface where "restore the scroll offset" is provably NOT enough on its own.
 * "Load more" pages are accumulated in client state and the mount fetch always starts at offset 0,
 * so a remount hands the browser a document a third of the height it had. The offset would be
 * clamped and the place lost however faithfully it was remembered. The depth the user had paged to
 * is therefore restored WITH the offset, in one request, before the restore loop runs.
 *
 * FeedPage had no component test before this file; these also stand as its first render coverage.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))

import FeedPage from '../pages/FeedPage.jsx'
import {
  __resetScrollRestoreStore,
  __seedScrollRestoreEntry,
  __peekScrollRestoreEntry,
} from '../hooks/useScrollRestore.js'

const events = (n, from = 0) => Array.from({ length: n }, (_, i) => ({
  id: `ev-${from + i}`, project_id: 'proj-1', plant_id: null, event_type: 'water',
  event_date: '2026-08-01', created_at: `2026-08-01T00:00:${String(i % 60).padStart(2, '0')}Z`,
  notes: null, project_name: 'Spring 2026',
}))

let feedCalls = []
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
// Pump frames until `done()` holds — see the long note in PhotoLibrary.scrollRestore.test.jsx.
// Short version: the restore effect arms asynchronously and the hook budgets ~20 frames, so an
// exact `flushFrames(2)` is a stopwatch that reds under worker-pool contention on code that is
// fine. Only POSITIVE assertions use this; a negative ("nothing moved the viewport") still spends
// a fixed budget, because you cannot wait for an event that must never arrive.
async function pumpFramesUntil(done) {
  await waitFor(() => {
    act(() => flushFrames(1))
    if (!done()) throw new Error('not yet restored')
  }, { timeout: 5000, interval: 0 })
}
function setScrollY(y) {
  Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: y })
}
const lastFeedLimit = () => Number(new URL(feedCalls.at(-1), 'https://x').searchParams.get('limit'))

beforeEach(() => {
  __resetScrollRestoreStore()
  fetchSpy.mockReset()
  feedCalls = []
  maxScroll = 0
  frameQueue = new Map()
  frameId = 0
  setScrollY(0)
  window.scrollTo = vi.fn((x, y) => setScrollY(Math.min(y, maxScroll)))
  window.requestAnimationFrame = (cb) => { const id = ++frameId; frameQueue.set(id, cb); return id }
  window.cancelAnimationFrame = (id) => { frameQueue.delete(id) }
  window.history.replaceState({ key: 'feed-entry' }, '')
  fetchSpy.mockImplementation((url) => {
    if (url === '/api/projects') return Promise.resolve([])
    // V4-BATCHUNDO-001: FeedPage also asks the server which bulk logs are still undoable. This mock
    // used to classify "not /api/projects" as "a feed page request", which was exhaustive when it
    // was written and is not any more — every assertion below counts feed PAGES, so the batches
    // request has to be routed explicitly rather than counted as one.
    if (url.startsWith('/api/events/batches')) return Promise.resolve({ batches: [] })
    feedCalls.push(url)
    const u = new URL(url, 'https://x')
    const limit = Number(u.searchParams.get('limit'))
    const offset = Number(u.searchParams.get('offset'))
    return Promise.resolve({ events: events(limit, offset), limit, offset, has_more: true })
  })
})

afterEach(() => {
  __resetScrollRestoreStore()
  window.history.replaceState(null, '')
})

describe('FeedPage — back-nav scroll restore', () => {
  it('asks for one page on a history entry it has never seen, and does not move the viewport', async () => {
    render(<FeedPage />)
    await waitFor(() => expect(feedCalls).toHaveLength(1))
    expect(lastFeedLimit()).toBe(30)
    act(() => flushFrames(3))
    expect(window.scrollTo).not.toHaveBeenCalled()
  })

  // THE COUPLING, stated as a test: the rows the offset needs are requested in the SAME round trip,
  // not left to a "Load more" the user would have to press again.
  it('re-requests the depth the user had paged to, in one request, then restores the offset', async () => {
    __seedScrollRestoreEntry('feed', 1800, 90)
    render(<FeedPage />)
    await waitFor(() => expect(feedCalls).toHaveLength(1))
    expect(lastFeedLimit()).toBe(90)
    await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull())
    maxScroll = 5000
    await pumpFramesUntil(() => window.scrollTo.mock.calls.length > 0)
    expect(window.scrollTo).toHaveBeenCalledWith(0, 1800)
    expect(window.scrollY).toBe(1800)
  })

  it('caps the re-request at the depth the feed route will serve in one call', async () => {
    __seedScrollRestoreEntry('feed', 4000, 600)
    render(<FeedPage />)
    await waitFor(() => expect(feedCalls).toHaveLength(1))
    expect(lastFeedLimit()).toBe(90)   // server clamps limit at 100; 90 is three whole pages
  })

  it('does not enlarge the query for a user who never scrolled', async () => {
    __seedScrollRestoreEntry('feed', 0, 90)
    render(<FeedPage />)
    await waitFor(() => expect(feedCalls).toHaveLength(1))
    expect(lastFeedLimit()).toBe(30)
  })

  it('starts a changed filter at one page — a filtered list is a different list', async () => {
    __seedScrollRestoreEntry('feed', 1800, 90)
    render(<FeedPage />)
    await waitFor(() => expect(feedCalls).toHaveLength(1))
    expect(lastFeedLimit()).toBe(90)
    fireEvent.change(screen.getByLabelText('Filter by event type'), { target: { value: 'harvest' } })
    await waitFor(() => expect(feedCalls).toHaveLength(2))
    expect(lastFeedLimit()).toBe(30)
    expect(feedCalls.at(-1)).toContain('event_type=harvest')
  })

  it('records the depth reached by Load more, alongside the offset', async () => {
    const { unmount } = render(<FeedPage />)
    await waitFor(() => expect(screen.getByText('Load more')).toBeDefined())
    await act(async () => { fireEvent.click(screen.getByText('Load more')) })
    await waitFor(() => expect(feedCalls).toHaveLength(2))
    act(() => { setScrollY(1800); window.dispatchEvent(new Event('scroll')) })
    unmount()
    expect(__peekScrollRestoreEntry('feed')).toEqual({ y: 1800, s: 60 })
  })

  it('keeps Load more paging from the restored depth rather than from page 1', async () => {
    __seedScrollRestoreEntry('feed', 1800, 90)
    render(<FeedPage />)
    await waitFor(() => expect(screen.getByText('Load more')).toBeDefined())
    await act(async () => { fireEvent.click(screen.getByText('Load more')) })
    await waitFor(() => expect(feedCalls).toHaveLength(2))
    const u = new URL(feedCalls.at(-1), 'https://x')
    expect(u.searchParams.get('offset')).toBe('90')
    expect(u.searchParams.get('limit')).toBe('30')
  })
})
