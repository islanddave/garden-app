// BUG-DETAILPAGESCARRYSCROLL-001 — useScrollRestore's two additions for the app-level page-scroll manager,
// and nothing else: the per-ENTRY claim (rimpact-scrollmanager IMPORTANT-4) and the flush on
// visibilitychange → hidden and freeze (design-scrollmanager-pwa §2.4: Android discards a frozen tab with no
// pagehide, so a store flushed only on pagehide loses its records on a tab restore).
//
// The claim goes through the manager's React context, so the provider here carries a spy in place of the
// manager's api. Outside the provider (every other suite) the hook is exactly what it was.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, cleanup } from '@testing-library/react'
import useScrollRestore, { __resetScrollRestoreStore, __seedScrollRestoreEntry } from '../hooks/useScrollRestore.js'
import { PageScrollProvider } from '../hooks/usePageScrollManager.js'

const STORE_KEY = 'garden.scrollRestore.v1'
let claims
let unclaims
const api = {
  claim: (entry) => { claims.push(entry); return () => { unclaims.push(entry) } },
}
function Probe({ id = 'surf' }) {
  useScrollRestore({ id, ready: true })
  return null
}
const inProvider = (el) => <PageScrollProvider value={{ api, isReturn: false }}>{el}</PageScrollProvider>
const setY = (y) => Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: y })

beforeEach(() => {
  claims = []
  unclaims = []
  __resetScrollRestoreStore()
  setY(0)
  window.scrollTo = vi.fn()
  window.requestAnimationFrame = () => 1
  window.cancelAnimationFrame = () => {}
  window.history.replaceState({ key: 'entry-A' }, '')
})
afterEach(() => {
  cleanup()
  window.history.replaceState(null, '')
})

describe('the claim: per entry, only with a saved value', () => {
  it('a mount holding a saved value for its entry claims that entry, and releases it on unmount', () => {
    __seedScrollRestoreEntry('surf', 900)
    const { unmount } = render(inProvider(<Probe />))
    expect(claims).toEqual(['entry-A'])
    unmount()
    expect(unclaims).toEqual(['entry-A'])
  })

  it('a saved VIEW STATE at the top is a saved value too: the hook owns that entry (it restores the state)', () => {
    __seedScrollRestoreEntry('surf', 0, { expanded: 'x' })
    render(inProvider(<Probe />))
    expect(claims).toEqual(['entry-A'])
  })

  it('no saved value (a fresh push, or an entry this hook stopped writing after a same-page re-key): no claim — the manager restores it', () => {
    render(inProvider(<Probe />))
    expect(claims).toEqual([])
  })

  it('another surface\'s value for the same entry is not this surface\'s claim', () => {
    __seedScrollRestoreEntry('other', 900)
    render(inProvider(<Probe id="surf" />))
    expect(claims).toEqual([])
  })

  it('outside the manager\'s provider the hook claims nothing and throws nothing (every isolated suite)', () => {
    __seedScrollRestoreEntry('surf', 900)
    expect(() => render(<Probe />)).not.toThrow()
    expect(claims).toEqual([])
  })
})

describe('the flush: hidden and freeze, not only pagehide', () => {
  const stored = () => JSON.parse(window.sessionStorage.getItem(STORE_KEY) || '{}')['surf|entry-A']

  it('visibilitychange → hidden files the current offset and persists the store', () => {
    render(<Probe />)
    setY(1200)
    act(() => { window.dispatchEvent(new Event('scroll')) })
    expect(stored()).toBeUndefined()                 // a scroll event files in memory only
    const had = Object.getOwnPropertyDescriptor(document, 'visibilityState')
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    try { act(() => { document.dispatchEvent(new Event('visibilitychange')) }) } finally {
      delete document.visibilityState
      if (had) Object.defineProperty(document, 'visibilityState', had)
    }
    expect(stored()).toEqual({ y: 1200 })
  })

  it('visibilitychange → visible does not flush (only leaving the screen does)', () => {
    render(<Probe />)
    setY(1200)
    act(() => { window.dispatchEvent(new Event('scroll')) })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })   // jsdom reports 'visible'
    expect(stored()).toBeUndefined()
  })

  it('freeze persists the store', () => {
    render(<Probe />)
    setY(640)
    act(() => { window.dispatchEvent(new Event('scroll')) })
    act(() => { document.dispatchEvent(new Event('freeze')) })
    expect(stored()).toEqual({ y: 640 })
  })

  it('pagehide still persists it, as before', () => {
    render(<Probe />)
    setY(320)
    act(() => { window.dispatchEvent(new Event('scroll')) })
    act(() => { window.dispatchEvent(new Event('pagehide')) })
    expect(stored()).toEqual({ y: 320 })
  })
})
