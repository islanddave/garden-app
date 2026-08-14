/**
 * src/__tests__/useScrollRestore.test.jsx
 * V4-SCROLLRESTORE-001 (BD0806-05) — the generalised back-nav scroll restore.
 *
 * WHAT THIS CAN AND CANNOT PROVE. jsdom computes no layout, so "the row the user was looking at is
 * back under their thumb" is not assertable here at any effort — that is a device check. What IS
 * assertable is every decision and every ordering guarantee around it, and those are what the bug
 * was made of: when the loop starts, how long it persists, what it does to a target it cannot
 * reach, who it yields to, which history entry an offset belongs to, and — the one that decides
 * whether the feature works at all — that the mount's own scroll position of 0 can never overwrite
 * the target before the restore has run.
 *
 * The scroll surface is modelled explicitly: `scrollTo` clamps to a `maxScroll` the test controls,
 * which is exactly what Chrome does to a document that came back shorter than it left.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'
import useScrollRestore, {
  __resetScrollRestoreStore,
  __seedScrollRestoreEntry,
  __peekScrollRestoreEntry,
} from '../hooks/useScrollRestore.js'
import { RESTORE_MAX_FRAMES } from '../lib/scrollRestore.js'

// ---- scroll model ----
let maxScroll = 0
let scrollToCalls = []
// Growth per attempt, in px. 0 = a document that will never be tall enough (content genuinely gone).
let growPerAttempt = 0

function setScrollY(y) {
  Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: y })
}

// ---- deterministic frames ----
let frameQueue = new Map()
let frameId = 0
function flushFrames(n = 1) {
  for (let i = 0; i < n; i++) {
    const due = [...frameQueue.values()]
    frameQueue.clear()
    for (const cb of due) cb()
  }
}

beforeEach(() => {
  __resetScrollRestoreStore()
  maxScroll = 0
  growPerAttempt = 0
  scrollToCalls = []
  frameQueue = new Map()
  frameId = 0
  setScrollY(0)
  window.scrollTo = vi.fn((x, y) => {
    scrollToCalls.push(y)
    setScrollY(Math.min(y, maxScroll))
    // A clamped scrollTo is itself the growth trigger on the real surfaces (the window listener
    // fires and renders another page of tiles). Model that as the document getting taller.
    if (growPerAttempt) maxScroll += growPerAttempt
  })
  window.requestAnimationFrame = (cb) => { const id = ++frameId; frameQueue.set(id, cb); return id }
  window.cancelAnimationFrame = (id) => { frameQueue.delete(id) }
  // react-router keeps its history-entry key here; jsdom starts with no history state.
  window.history.replaceState({ key: 'entry-A' }, '')
})

afterEach(() => {
  __resetScrollRestoreStore()
  window.history.replaceState(null, '')
})

function Probe({ id = 'surf', ready = true, state }) {
  const { restoredState, saveState } = useScrollRestore({ id, ready })
  React.useEffect(() => { if (state !== undefined) saveState(state) }, [state, saveState])
  return <div data-testid="restored">{JSON.stringify(restoredState ?? null)}</div>
}

describe('useScrollRestore — when it fires', () => {
  it('is inert on a history entry it has never seen', () => {
    render(<Probe />)
    act(() => flushFrames(3))
    expect(window.scrollTo).not.toHaveBeenCalled()
  })

  it('is inert for a stored offset of 0 — there is nothing to restore', () => {
    __seedScrollRestoreEntry('surf', 0)
    render(<Probe />)
    act(() => flushFrames(3))
    expect(window.scrollTo).not.toHaveBeenCalled()
  })

  // The coupling the ticket names: restoring before the content lands aims at a spinner.
  it('does not touch the scroll position while the surface is still loading', () => {
    __seedScrollRestoreEntry('surf', 900)
    maxScroll = 4000
    render(<Probe ready={false} />)
    act(() => flushFrames(5))
    expect(window.scrollTo).not.toHaveBeenCalled()
  })

  it('restores once ready flips true, and stops as soon as it has landed', () => {
    __seedScrollRestoreEntry('surf', 900)
    maxScroll = 4000
    const { rerender } = render(<Probe ready={false} />)
    act(() => flushFrames(2))
    rerender(<Probe ready />)
    act(() => flushFrames(1))
    expect(window.scrollY).toBe(900)
    expect(scrollToCalls).toEqual([900])
    act(() => flushFrames(5))
    expect(scrollToCalls).toEqual([900])   // one-shot: it does not keep re-asserting the offset
  })
})

describe('useScrollRestore — a document that came back shorter', () => {
  // The restored offset EXCEEDS the new content height. The browser clamps silently; the loop keeps
  // trying because on the real surfaces each clamped attempt grows the document.
  it('converges on the target as the document grows under it', () => {
    __seedScrollRestoreEntry('surf', 2000)
    maxScroll = 400          // came back one page tall
    growPerAttempt = 600     // each clamped landing renders another page
    render(<Probe ready />)
    act(() => flushFrames(RESTORE_MAX_FRAMES))
    expect(window.scrollY).toBe(2000)
    expect(scrollToCalls.length).toBeLessThan(RESTORE_MAX_FRAMES)
  })

  it('gives up after the frame budget when the height never arrives, leaving the user at the closest reachable point', () => {
    __seedScrollRestoreEntry('surf', 5000)
    maxScroll = 700          // the content is genuinely gone; it will never be tall enough
    render(<Probe ready />)
    act(() => flushFrames(RESTORE_MAX_FRAMES + 10))
    expect(scrollToCalls).toHaveLength(RESTORE_MAX_FRAMES)
    expect(window.scrollY).toBe(700)
  })

  it('never throws when scrollTo is a stub that throws (jsdom, and any locked-down surface)', () => {
    __seedScrollRestoreEntry('surf', 900)
    window.scrollTo = vi.fn(() => { throw new Error('Not implemented: window.scrollTo') })
    expect(() => {
      render(<Probe ready />)
      act(() => flushFrames(RESTORE_MAX_FRAMES + 2))
    }).not.toThrow()
  })
})

describe('useScrollRestore — never fight the user', () => {
  it.each(['touchstart', 'wheel', 'keydown'])('abandons the restore on %s and does not scroll again', (evt) => {
    __seedScrollRestoreEntry('surf', 5000)
    maxScroll = 300
    render(<Probe ready />)
    act(() => flushFrames(2))
    const before = scrollToCalls.length
    expect(before).toBeGreaterThan(0)
    act(() => { window.dispatchEvent(new Event(evt)) })
    act(() => flushFrames(RESTORE_MAX_FRAMES))
    expect(scrollToCalls).toHaveLength(before)
  })
})

describe('useScrollRestore — which entry an offset belongs to', () => {
  it('does not restore an offset saved under a different history entry', () => {
    __seedScrollRestoreEntry('surf', 900)          // saved under entry-A
    window.history.replaceState({ key: 'entry-B' }, '')
    maxScroll = 4000
    render(<Probe ready />)
    act(() => flushFrames(3))
    expect(window.scrollTo).not.toHaveBeenCalled()
  })

  it('does not leak an offset between two surfaces on the same entry', () => {
    __seedScrollRestoreEntry('photos', 900)
    maxScroll = 4000
    render(<Probe id="feed" ready />)
    act(() => flushFrames(3))
    expect(window.scrollTo).not.toHaveBeenCalled()
  })
})

describe('useScrollRestore — saving', () => {
  it('records the offset on scroll and on unmount', () => {
    const { unmount } = render(<Probe ready />)
    act(() => { setScrollY(640); window.dispatchEvent(new Event('scroll')) })
    expect(__peekScrollRestoreEntry('surf').y).toBe(640)
    act(() => { setScrollY(700) })
    unmount()
    expect(__peekScrollRestoreEntry('surf').y).toBe(700)
  })

  // THE ONE THAT DECIDES WHETHER ANY OF THIS WORKS. Every one of these surfaces mounts at scrollY 0
  // and only then fetches. If the save path were open from mount, the mount's own 0 — or a clamped
  // intermediate offset from the restore's own scrollTo — would overwrite the target before it was
  // ever used, and the second Back would land at the top.
  it('will not overwrite a stored target with the mount position before the restore has resolved', () => {
    __seedScrollRestoreEntry('surf', 5000)
    const { unmount } = render(<Probe ready={false} />)
    act(() => { window.dispatchEvent(new Event('scroll')) })
    expect(__peekScrollRestoreEntry('surf').y).toBe(5000)
    unmount()
    expect(__peekScrollRestoreEntry('surf').y).toBe(5000)
  })

  it('re-opens saving once the restore has resolved', () => {
    __seedScrollRestoreEntry('surf', 900)
    maxScroll = 4000
    render(<Probe ready />)
    act(() => flushFrames(2))
    act(() => { setScrollY(120); window.dispatchEvent(new Event('scroll')) })
    expect(__peekScrollRestoreEntry('surf').y).toBe(120)
  })

  it('re-opens saving when the user takes over, even if the restore never resolved', () => {
    __seedScrollRestoreEntry('surf', 5000)
    render(<Probe ready={false} />)
    act(() => { window.dispatchEvent(new Event('touchstart')) })
    act(() => { setScrollY(88); window.dispatchEvent(new Event('scroll')) })
    expect(__peekScrollRestoreEntry('surf').y).toBe(88)
  })
})

describe('useScrollRestore — the view-state channel', () => {
  it('returns the state saved with the offset, at first render', () => {
    __seedScrollRestoreEntry('surf', 900, 96)
    const { getByTestId } = render(<Probe ready={false} />)
    expect(getByTestId('restored').textContent).toBe('96')
  })

  it('withholds it when there is no offset to restore — a user at the top has no view to rebuild', () => {
    __seedScrollRestoreEntry('surf', 0, 96)
    const { getByTestId } = render(<Probe ready={false} />)
    expect(getByTestId('restored').textContent).toBe('null')
  })

  it('round-trips state through a save and a remount of the same entry', () => {
    const first = render(<Probe ready state={72} />)
    act(() => { setScrollY(640); window.dispatchEvent(new Event('scroll')) })
    first.unmount()
    const second = render(<Probe ready={false} />)
    expect(second.getByTestId('restored').textContent).toBe('72')
  })

  it('keeps restoredState stable after the page starts reporting newer state', () => {
    __seedScrollRestoreEntry('surf', 900, 24)
    const { getByTestId, rerender } = render(<Probe ready={false} state={24} />)
    rerender(<Probe ready={false} state={480} />)
    expect(getByTestId('restored').textContent).toBe('24')
  })
})

describe('useScrollRestore — persistence across a document swap', () => {
  it('flushes to sessionStorage so the position survives a PWA service-worker reload', () => {
    const { unmount } = render(<Probe ready state={48} />)
    act(() => { setScrollY(640); window.dispatchEvent(new Event('scroll')) })
    unmount()
    const blob = JSON.parse(window.sessionStorage.getItem('garden.scrollRestore.v1'))
    expect(blob['surf|entry-A']).toEqual({ y: 640, s: 48 })
  })

  it('hydrates from sessionStorage on a cold module load', () => {
    window.sessionStorage.setItem('garden.scrollRestore.v1',
      JSON.stringify({ 'surf|entry-A': { y: 900, s: 48 } }))
    maxScroll = 4000
    const { getByTestId } = render(<Probe ready />)
    act(() => flushFrames(2))
    expect(window.scrollY).toBe(900)
    expect(getByTestId('restored').textContent).toBe('48')
  })

  it.each([
    ['not JSON', '{{{'],
    ['not an object', '42'],
    ['an entry with a non-numeric offset', JSON.stringify({ 'surf|entry-A': { y: 'up' } })],
    ['an entry that is not an object', JSON.stringify({ 'surf|entry-A': 900 })],
  ])('ignores a corrupt store (%s) rather than faulting the page', (_label, raw) => {
    window.sessionStorage.setItem('garden.scrollRestore.v1', raw)
    maxScroll = 4000
    expect(() => {
      render(<Probe ready />)
      act(() => flushFrames(3))
    }).not.toThrow()
    expect(window.scrollTo).not.toHaveBeenCalled()
  })
})
