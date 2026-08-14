/**
 * src/__tests__/PhotoLibrary.scrollRestore.test.jsx
 * V4-SCROLLRESTORE-001 (BD0806-05) — PhotoLibrary's half of the back-nav restore.
 *
 * Kept in its own file deliberately: PhotoLibrary.test.jsx / .pickerclip / .projhide / .selectstale
 * are shared with the picker-a11y lane this round, and editing a shared file to add coverage is how
 * two green lanes merge red.
 *
 * The page-level claim under test is the ORDERING one. PhotoLibrary windows its grid at 24 tiles
 * (BUG-PHOTOTHUMB-001) and refetches on mount, so a remount that restored only the scroll offset
 * would aim a 1,200px target at a document holding 24 tiles' worth of height, get clamped, and lose
 * the place anyway. The window size is therefore restored at first render, in the same commit the
 * photos land in. jsdom computes no layout, so what is proven here is that the right NUMBER OF TILES
 * is mounted and the right offset is requested — not that the pixels line up.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))

// Pinned FALSE for the same reason PhotoLibrary.test.jsx pins it: this suite asserts the
// projects-VISIBLE configuration, and the flag-ON world has its own *.projhide suites.
vi.mock('../lib/featureFlags.js', async (importActual) => ({
  ...(await importActual()),
  PROJECTS_HIDDEN: false,
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))

vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: vi.fn(), isUploading: false, error: null, photo: null, preview: null,
    stage: null, progress: null, reset: vi.fn(),
  }),
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))

import PhotoLibrary from '../pages/PhotoLibrary.jsx'
import {
  __resetScrollRestoreStore,
  __seedScrollRestoreEntry,
  __peekScrollRestoreEntry,
} from '../hooks/useScrollRestore.js'

const PAGE = 24
const photos = (n) => Array.from({ length: n }, (_, i) => ({
  id: `photo-${i}`, storage_path: `p/${i}.jpg`, view_url: `https://x/${i}.jpg`, caption: null,
  project_id: null, location_id: null, plant_id: null, event_id: null, space_id: null,
  inventory_item_id: null, created_at: '2026-08-01T00:00:00Z',
}))

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
// Pump frames until `done()` holds, instead of betting on a fixed count.
//
// These tests originally spent an exact budget (`flushFrames(2)`), which made them a stopwatch
// rather than an assertion: the restore effect arms asynchronously, so on a loaded worker pool it
// had not armed by frame 2, `window.scrollTo` was never called, and the suite went red on a file
// that passes 8/8 in isolation. That is the worst kind of red — it looks like broken code, it moves
// between files run to run, and the reflex is to re-run rather than to look, which is exactly how a
// real failure gets laundered into "flaky". `build-and-test` gates the promote, so a randomly-red
// suite randomly blocks shipping.
//
// The hook budgets ~20 frames for late layout, so draining to that bound asserts the claim that
// actually matters — it restores WITHIN its own budget — without pinning which frame it lands on.
// The ordering claim is unaffected: it is asserted before the pump, on mounted tile count.
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
  fetchSpy.mockReset()
  maxScroll = 0
  frameQueue = new Map()
  frameId = 0
  setScrollY(0)
  window.scrollTo = vi.fn((x, y) => setScrollY(Math.min(y, maxScroll)))
  window.requestAnimationFrame = (cb) => { const id = ++frameId; frameQueue.set(id, cb); return id }
  window.cancelAnimationFrame = (id) => { frameQueue.delete(id) }
  window.history.replaceState({ key: 'photos-entry' }, '')
  // jsdom reports scrollHeight 0, which puts the page's own "grow the window near the bottom"
  // listener permanently in range and makes every tile count drift by a PAGE. Pin a tall document
  // so growth happens only where a test asks for it.
  Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 20000 })
  if (typeof URL.createObjectURL !== 'function') URL.createObjectURL = vi.fn(() => 'blob:stub')
  if (typeof URL.revokeObjectURL !== 'function') URL.revokeObjectURL = vi.fn()
})

afterEach(() => {
  __resetScrollRestoreStore()
  window.history.replaceState(null, '')
})

function prime(n) {
  const rows = photos(n)
  fetchSpy.mockImplementation((url) => {
    if (url === '/api/projects') return Promise.resolve([])
    if (url === '/api/locations/with-path') return Promise.resolve([])
    if (String(url).startsWith('/api/photos')) return Promise.resolve(rows)
    if (String(url).startsWith('/api/plants')) return Promise.resolve([])
    return Promise.resolve([])
  })
  return rows
}

const tiles = () => document.querySelectorAll('img[alt="Garden photo"]').length

describe('PhotoLibrary — back-nav scroll restore', () => {
  it('opens at one page on a history entry it has never seen', async () => {
    prime(120)
    render(<PhotoLibrary />)
    await waitFor(() => expect(screen.getByText(/Show more \(96 left\)/)).toBeDefined())
    expect(window.scrollTo).not.toHaveBeenCalled()
  })

  // THE ORDERING CLAIM: the window is back to its old size in the SAME commit the photos land in,
  // so the height the offset needs exists before the first restore attempt rather than after it.
  it('re-opens the tile window it had when the user left, before restoring the offset', async () => {
    prime(120)
    __seedScrollRestoreEntry('photos', 1200, 72)
    render(<PhotoLibrary />)
    await waitFor(() => expect(screen.getByText(/Show more \(48 left\)/)).toBeDefined())
    expect(tiles()).toBe(72)
    maxScroll = 4000
    await pumpFramesUntil(() => window.scrollTo.mock.calls.length > 0)
    expect(window.scrollTo).toHaveBeenCalledWith(0, 1200)
    expect(window.scrollY).toBe(1200)
  })

  it('clamps an implausible stored window rather than mounting an unbounded number of images', async () => {
    prime(120)
    __seedScrollRestoreEntry('photos', 1200, 99999)
    render(<PhotoLibrary />)
    // Wait on the POSITIVE signal (the tiles are mounted), never on the absence of "Show more".
    //
    // This originally awaited `queryByText(/Show more/)` being null — but that is ALSO true before
    // anything has rendered, so the wait resolved instantly against the empty first paint and the
    // next line then read 0 tiles. It passed on a fast machine and failed in CI's America/New_York
    // TZ job (a second, differently-timed run of the same suite), which is why three consecutive
    // green local runs did not catch it. An absence assertion cannot distinguish "finished" from
    // "not started"; only a positive one can.
    await waitFor(() => expect(tiles()).toBe(120))  // bounded by the photo count, not the poisoned value
    // NOW the absence is meaningful: everything is mounted, so there is genuinely no more to show.
    expect(screen.queryByText(/Show more/)).toBeNull()
  })

  it.each([null, 'lots', -5])('falls back to one page for a nonsense stored window (%p)', async (bad) => {
    prime(120)
    __seedScrollRestoreEntry('photos', 1200, bad)
    render(<PhotoLibrary />)
    await waitFor(() => expect(screen.getByText(/Show more \(96 left\)/)).toBeDefined())
    expect(tiles()).toBe(PAGE)
  })

  it('records the window it was showing when the user navigated away', async () => {
    prime(120)
    const { unmount } = render(<PhotoLibrary />)
    await waitFor(() => expect(screen.getByText(/Show more \(96 left\)/)).toBeDefined())
    fireEvent.click(screen.getByText(/Show more \(96 left\)/))
    await waitFor(() => expect(tiles()).toBe(48))
    act(() => { setScrollY(880); window.dispatchEvent(new Event('scroll')) })
    unmount()
    expect(__peekScrollRestoreEntry('photos')).toEqual({ y: 880, s: 48 })
  })

  // Non-regression on BUG-PHOTOSELSTALE-001's effect, whose mount run this change now skips: a real
  // filter change must still collapse the window.
  it('still collapses the window back to one page on a filter change', async () => {
    prime(120)
    __seedScrollRestoreEntry('photos', 1200, 72)
    render(<PhotoLibrary />)
    await waitFor(() => expect(tiles()).toBe(72))
    fireEvent.click(screen.getByText('No event'))
    await waitFor(() => expect(tiles()).toBe(PAGE))
  })
})
