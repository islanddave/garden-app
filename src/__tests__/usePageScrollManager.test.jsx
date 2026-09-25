// BUG-DETAILPAGESCARRYSCROLL-001 — the page-scroll manager's WIRING (src/hooks/usePageScrollManager.js),
// under the real BrowserRouter and OverlayProvider in App.jsx's two-tree shape.
//
// WHAT THIS CAN AND CANNOT PROVE. jsdom has no layout, no clamp and no anchoring, so "the page opens at its
// top" is not observable here — that is gate:page-scroll, in real Chrome. What IS observable is every call
// the manager makes and every offset it files, against a scroll surface modelled the way
// useScrollRestore.test.jsx models it: scrollTo clamps to a `maxScroll` the test controls, frames and the
// clock advance only when the test says so. The decisions themselves are table-tested in pageScroll.test.js;
// this suite pins how they are wired: the write rules, the claim ordering, the driver's exits, StrictMode.
import React, { useState } from 'react'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, cleanup, screen, waitFor } from '@testing-library/react'
import { BrowserRouter, Routes, Route, Link, useNavigate, useNavigationType } from 'react-router-dom'
import { OverlayProvider, useOverlay, OverlayLink, useOverlayDismiss } from '../context/OverlayContext.jsx'
import {
  usePageScrollManager, PageScrollProvider, useClaimPageScroll, usePageScrollReturn, usePageScrollReturnAtMount,
  currentPageEntry,
} from '../hooks/usePageScrollManager.js'
import { readPageScroll, PAGE_SCROLL_STORE_KEY, RESTORE_HOLD_MS, RESTORE_BUDGET_MS } from '../lib/pageScroll.js'
import { MARKER_KEY, MARKER_VERSION } from '../lib/backNav.js'

// ── scroll surface ──────────────────────────────────────────────────────────────────────────────────
let maxScroll = 10000
let scrollCalls = []
const setY = (y) => Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: y })
// The manager calls scrollTo({ top, behavior: 'instant' }); a page's own reset calls scrollTo(0, 0).
const yOf = (a, b) => (a && typeof a === 'object' ? a.top : b)
// The user (or a clamp) moving the page: the offset changes and a scroll event fires.
const scrollPage = (y) => act(() => { setY(y); window.dispatchEvent(new Event('scroll')) })

// ── frames and the clock ────────────────────────────────────────────────────────────────────────────
let queue = new Map()
let rafId = 0
let now = 1000
function frames(n, dt = 16) {
  act(() => {
    for (let i = 0; i < n; i++) {
      now += dt
      const due = [...queue.values()]
      queue.clear()
      for (const cb of due) cb()
    }
  })
}
const pending = () => queue.size

// ── the shell ───────────────────────────────────────────────────────────────────────────────────────
let decisions = []
let nav = null
let claimNext = false
function Nav() { nav = useNavigate(); return null }
function Page({ name }) {
  const returning = usePageScrollReturn()
  const atMount = usePageScrollReturnAtMount()
  return <div data-testid={`page-${name}`} data-return={String(returning)} data-return-at-mount={String(atMount)} />
}
// A page that restores its own offset, the way useScrollRestore and Garden claim: at first render, for the
// entry it mounted on, only when it has something to restore (`claimNext` stands in for "has a saved value").
function Claimer() {
  const [entry] = useState(() => (claimNext ? currentPageEntry() : null))
  useClaimPageScroll(entry)
  return <div data-testid="page-claimer" />
}
function SearchStub() {
  const dismiss = useOverlayDismiss()
  return (
    <>
      <button type="button" data-testid="close" onClick={dismiss}>close</button>
      {/* Search's results are plain links: a PUSH out of the overlay, as Search.jsx renders them. */}
      <Link to="/detail/result" data-testid="result">a result</Link>
    </>
  )
}
let commits = 0
function Shell({ enabled = true, hold = false }) {
  const { pageLocation, overlayLocation, background } = useOverlay()
  const navigationType = useNavigationType()
  const pageScroll = usePageScrollManager({ pageLocation, location: overlayLocation, navigationType, ready: !hold, enabled, onDecision: (d) => decisions.push(d) })
  // Every router commit, flag on or off: what `back` waits for (jsdom delivers popstate a task later).
  React.useLayoutEffect(() => { commits += 1 }, [pageLocation])
  return (
    <PageScrollProvider value={pageScroll}>
      <Nav />
      <OverlayLink to="/search" data-testid="open-search">search</OverlayLink>
      {hold ? <div data-testid="skeleton" /> : (
        <Routes location={pageLocation}>
          <Route path="/today" element={<Page name="today" />} />
          <Route path="/list" element={<Page name="list" />} />
          <Route path="/detail/:id" element={<Page name="detail" />} />
          <Route path="/claimer" element={<Claimer />} />
        </Routes>
      )}
      {background && (
        <Routes location={overlayLocation}>
          <Route path="/search" element={<SearchStub />} />
        </Routes>
      )}
    </PageScrollProvider>
  )
}
const mount = (props = {}, { strict = false } = {}) => {
  const tree = <BrowserRouter><OverlayProvider><Shell {...props} /></OverlayProvider></BrowserRouter>
  return render(strict ? <React.StrictMode>{tree}</React.StrictMode> : tree)
}
const go = (to, opts) => act(() => { nav(to, opts) })
// A real traversal: history.back(), then wait for the router to COMMIT the POP (a marker pop keeps the URL,
// so the wait is on the commit, not on the location).
const back = async () => {
  const n = commits
  await act(async () => { window.history.back() })
  await waitFor(() => { if (commits <= n) throw new Error('the POP has not committed yet') })
}
const key = () => window.history.state?.key
const last = () => decisions[decisions.length - 1]
const filed = (path, k) => readPageScroll(`${path}|${k}`)

beforeEach(() => {
  maxScroll = 10000
  scrollCalls = []
  decisions = []
  claimNext = false
  queue = new Map()
  rafId = 0
  now = 1000
  setY(0)
  window.scrollTo = vi.fn((a, b) => { const y = yOf(a, b); scrollCalls.push(y); setY(Math.min(Math.max(0, y), maxScroll)) })
  window.requestAnimationFrame = (cb) => { const id = ++rafId; queue.set(id, cb); return id }
  window.cancelAnimationFrame = (id) => { queue.delete(id) }
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  window.history.replaceState(null, '', '/today')
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.history.replaceState(null, '', '/')
})

describe('a different page opens at its top; Back returns to the place (rows 2 and 4)', () => {
  it('a push onto a different page is ONE scrollTo(0) in the commit — no frame, no driver', () => {
    mount()
    go('/list')
    scrollPage(1645)
    scrollCalls = []
    go('/detail/1')
    expect(last()).toMatchObject({ row: '2', action: 'TOP', path: '/detail/1' })
    expect(scrollCalls).toEqual([0])
    expect(pending()).toBe(0)
  })

  it('Back restores the offset filed for that entry, and holds it until it has held RESTORE_HOLD_MS', async () => {
    mount()
    go('/list')
    const kList = key()
    scrollPage(1645)
    expect(filed('/list', kList)).toBe(1645)
    go('/detail/1')
    maxScroll = 56                                    // the list comes back as a one-screen loading shell
    scrollCalls = []
    await back()
    expect(last()).toMatchObject({ row: '4', action: 'RESTORE', y: 1645 })
    expect(scrollCalls[0]).toBe(1645)                 // the first attempt, in the commit (clamped to 56)
    frames(30)
    expect(window.scrollY).toBe(56)                   // still loading: every frame re-applies
    expect(scrollCalls.length).toBeGreaterThan(20)
    maxScroll = 2481                                  // the content lands
    frames(1)
    expect(window.scrollY).toBe(1645)
    frames(Math.ceil(RESTORE_HOLD_MS / 16) + 2)
    expect(pending()).toBe(0)                         // DONE: the driver has stopped
    expect(filed('/list', kList)).toBe(1645)          // and the clamped attempts never overwrote the target
  })

  it('Back to an entry with nothing filed is one zero (\'manual\' leaves it undefined), never a hold', async () => {
    mount()
    go('/list')
    go('/detail/1')
    scrollPage(700)
    scrollCalls = []
    await back()
    expect(last()).toMatchObject({ row: '4', action: 'TOP' })
    expect(scrollCalls).toEqual([0])
    expect(pending()).toBe(0)
  })
})

describe('the write rules (rimpact IMPORTANT-3)', () => {
  it('files only while the history entry is still the committed page\'s: a scroll event after the push, before the commit, files nothing', () => {
    mount()
    go('/list')
    const kList = key()
    scrollPage(900)
    // react-router writes the next entry synchronously in the click; the commit comes later, in a transition.
    const st = window.history.state
    window.history.pushState({ usr: null, key: 'next-entry', idx: (st?.idx ?? 0) + 1 }, '')
    scrollPage(56)                                    // the clamp to the next page's loading shell
    expect(filed('/list', kList)).toBe(900)
    window.history.replaceState(st, '')
  })

  it('writes are closed while a restore is armed for the entry, and re-open when it resolves', async () => {
    mount()
    go('/list')
    const kList = key()
    scrollPage(1645)
    go('/detail/1')
    maxScroll = 56
    await back()
    scrollPage(56)                                    // a clamp while the driver is armed
    expect(filed('/list', kList)).toBe(1645)
    maxScroll = 2481
    frames(Math.ceil(RESTORE_HOLD_MS / 16) + 3)       // lands and holds: DONE
    expect(pending()).toBe(0)
    scrollPage(1800)                                  // the user scrolls on: filed again
    expect(filed('/list', kList)).toBe(1800)
  })

  it('writes re-open when the budget is spent (EXHAUSTED) — the content is genuinely shorter now', async () => {
    mount()
    go('/list')
    const kList = key()
    scrollPage(5000)
    go('/detail/1')
    maxScroll = 700
    await back()
    frames(Math.ceil(RESTORE_BUDGET_MS / 16) + 3)
    expect(pending()).toBe(0)
    scrollPage(650)
    expect(filed('/list', kList)).toBe(650)
  })

  it('nothing is filed while the page is covered by an overlay or a Back marker; the snapshot is what was there before', async () => {
    mount()
    go('/list')
    const kList = key()
    scrollPage(1645)
    await act(async () => { screen.getByTestId('open-search').click() })
    expect(window.location.pathname).toBe('/search')
    expect(last()).toMatchObject({ row: '0', action: 'NONE' })
    scrollPage(56)                                    // the list re-rendered shorter behind the sheet
    expect(filed('/list', kList)).toBe(1645)
    // The walk-back close: a POP onto the list's own entry, the page moved → the snapshot is re-applied.
    scrollCalls = []
    await act(async () => { screen.getByTestId('close').click() })
    await waitFor(() => expect(window.location.pathname).toBe('/list'))
    expect(key()).toBe(kList)
    expect(last()).toMatchObject({ row: '0b', action: 'RESTORE', y: 1645 })
    expect(scrollCalls[0]).toBe(1645)
  })

  it('a Back marker (DismissRegistry\'s pushState, which the router never sees) covers the page the same way; its pop re-applies', async () => {
    mount()
    go('/list')
    const kList = key()
    scrollPage(1200)
    // DismissRegistry.arm(): MERGE the marker into a pushed copy of the page's own state (same key).
    window.history.pushState({ ...window.history.state, [MARKER_KEY]: { v: MARKER_VERSION, seq: 1 } }, '')
    scrollPage(300)                                   // the page shrank under the armed sheet
    expect(filed('/list', kList)).toBe(1200)
    scrollCalls = []
    await back()                                      // the marker pop: POP, same key, delta 0
    expect(key()).toBe(kList)
    expect(last()).toMatchObject({ row: '0b', action: 'RESTORE', y: 1200 })
  })

  it('a marker pop with the page where it was does nothing at all (MINOR-5: keyed on the entry, not the location object)', async () => {
    mount()
    go('/list')
    scrollPage(1200)
    window.history.pushState({ ...window.history.state, [MARKER_KEY]: { v: MARKER_VERSION, seq: 1 } }, '')
    scrollCalls = []
    await back()
    expect(last()).toMatchObject({ row: '0', action: 'NONE' })
    expect(scrollCalls).toEqual([])
  })

  it('never deletes a record on a REPLACE, and refiles the current offset under the new key on a same-page write (row 3)', () => {
    mount()
    go('/list')
    const k1 = key()
    scrollPage(900)
    scrollCalls = []
    go('/list?view=b', { replace: true })             // a same-page write: new key, same path
    const k2 = key()
    expect(k2).not.toBe(k1)
    expect(last()).toMatchObject({ row: '3', action: 'KEEP' })
    expect(scrollCalls).toEqual([])                   // nothing moved
    expect(filed('/list', k2)).toBe(900)
    expect(filed('/list', k1)).toBe(900)              // the old record stands
  })

  it('flushes the mirror on visibilitychange → hidden, freeze and pagehide (a discard fires none of the last two)', () => {
    mount()
    go('/list')
    const kList = key()
    const read = () => JSON.parse(sessionStorage.getItem(PAGE_SCROLL_STORE_KEY) || '{}')[`/list|${kList}`]
    scrollPage(400)
    expect(read()).toBeUndefined()                    // a scroll event files in memory only
    const hidden = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState')
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    try { act(() => { document.dispatchEvent(new Event('visibilitychange')) }) } finally {
      delete document.visibilityState
      if (hidden) Object.defineProperty(Document.prototype, 'visibilityState', hidden)
    }
    expect(read()).toBe(400)
    scrollPage(500)
    act(() => { document.dispatchEvent(new Event('freeze')) })
    expect(read()).toBe(500)
    scrollPage(600)
    act(() => { window.dispatchEvent(new Event('pagehide')) })
    expect(read()).toBe(600)
  })

  it('flushes after each committed navigation, so a reload finds the page it left', () => {
    mount()
    go('/list')
    const kList = key()
    scrollPage(1645)
    go('/detail/1')
    expect(JSON.parse(sessionStorage.getItem(PAGE_SCROLL_STORE_KEY))[`/list|${kList}`]).toBe(1645)
  })
})

describe('the driver\'s exits', () => {
  const armBack = async () => {
    mount()
    go('/list')
    scrollPage(1645)
    go('/detail/1')
    maxScroll = 56
    await back()
    expect(pending()).toBe(1)
  }

  it.each(['wheel', 'touchmove', 'keydown'])('real scrolling hands control back: %s stops the driver', async (type) => {
    await armBack()
    act(() => { window.dispatchEvent(new Event(type)) })
    frames(3)
    expect(pending()).toBe(0)
  })

  it('a thumb resting on the glass does NOT: touchstart leaves the restore running (IMPORTANT-7)', async () => {
    await armBack()
    act(() => { window.dispatchEvent(new Event('touchstart')) })
    frames(3)
    expect(pending()).toBe(1)
  })

  it('a new page entry cancels it (the user left before the content landed)', async () => {
    await armBack()
    go('/detail/2')
    frames(3)
    expect(pending()).toBe(0)
  })
})

describe('ownership is per entry, and the claim is seen in the same commit (IMPORTANT-4)', () => {
  it('Back into a page that claimed its entry: one zero in the commit, no driver — the page restores itself (row 5)', async () => {
    mount()
    go('/claimer')
    const kC = key()
    scrollPage(3000)
    go('/detail/1')
    claimNext = true                                  // the page now holds a saved value for its entry
    scrollCalls = []
    await back()
    expect(key()).toBe(kC)
    expect(last()).toMatchObject({ row: '5', action: 'TOP' })
    expect(scrollCalls).toEqual([0])
    expect(pending()).toBe(0)
  })

  it('the same page WITHOUT a saved value is the manager\'s: restored from the manager\'s record (row 4)', async () => {
    mount()
    go('/claimer')
    scrollPage(3000)
    go('/detail/1')
    claimNext = false
    await back()
    expect(last()).toMatchObject({ row: '4', action: 'RESTORE', y: 3000 })
  })

  it('Search → a result → Back re-mounts a claimed page UNDER the sheet; it restores itself there, and the X leaves it there', async () => {
    mount()
    go('/claimer')
    const kC = key()
    scrollPage(3195)
    await act(async () => { screen.getByTestId('open-search').click() })
    await act(async () => { screen.getByTestId('result').click() })
    expect(window.location.pathname).toBe('/detail/result')
    claimNext = true                                  // the page now has a saved value for its entry
    await back()                                      // POP onto Search's entry: the page re-mounts under it
    expect(window.location.pathname).toBe('/search')
    expect(last()).toMatchObject({ row: '5', action: 'TOP', path: '/claimer' })
    scrollPage(3195)                                  // the page's own restore, under the sheet
    scrollCalls = []
    await act(async () => { screen.getByTestId('close').click() })
    await waitFor(() => expect(window.location.pathname).toBe('/claimer'))
    expect(key()).toBe(kC)
    // The manager never saw the page uncovered in this mount, so it has no snapshot to "re-apply": the
    // row-5 zero is not where the page is. (Recording it sent Seeds to the top here — gate:seeds-scroll h/j/k.)
    expect(last()).toMatchObject({ row: '0', action: 'NONE' })
    expect(scrollCalls).toEqual([])
  })

  it('a claimed entry is the page\'s to file: the manager files nothing for it', () => {
    claimNext = true
    mount()
    go('/claimer')
    const kC = key()
    scrollPage(2500)
    expect(filed('/claimer', kC)).toBeUndefined()
  })

  it('a LATE claim (the page mounted behind Protected\'s skeleton, after the boot commit) cancels the boot restore', () => {
    window.history.replaceState({ usr: null, key: 'kBoot', idx: 0 }, '', '/claimer')
    sessionStorage.setItem(PAGE_SCROLL_STORE_KEY, JSON.stringify({ '/claimer|kBoot': 900 }))
    maxScroll = 50                                    // the skeleton
    const { rerender } = mount({ hold: true })
    expect(last()).toMatchObject({ row: '1', action: 'RESTORE', y: 900 })
    frames(5)
    expect(pending()).toBe(1)
    claimNext = true
    rerender(<BrowserRouter><OverlayProvider><Shell hold={false} /></OverlayProvider></BrowserRouter>)
    expect(screen.getByTestId('page-claimer')).toBeTruthy()
    frames(2)
    expect(pending()).toBe(0)
  })

  it('behind the skeleton no time counts: a boot restore outlasts a slow sign-in and lands once the page does', () => {
    window.history.replaceState({ usr: null, key: 'kBoot', idx: 0 }, '', '/list')
    sessionStorage.setItem(PAGE_SCROLL_STORE_KEY, JSON.stringify({ '/list|kBoot': 900 }))
    maxScroll = 50
    const { rerender } = mount({ hold: true })
    frames(Math.ceil(RESTORE_BUDGET_MS / 16) + 50)    // longer than the whole budget, all of it unresolved
    expect(pending()).toBe(1)
    rerender(<BrowserRouter><OverlayProvider><Shell hold={false} /></OverlayProvider></BrowserRouter>)
    maxScroll = 2481
    frames(Math.ceil(RESTORE_HOLD_MS / 16) + 3)
    expect(window.scrollY).toBe(900)
    expect(pending()).toBe(0)
  })
})

describe('StrictMode (main.jsx renders under it in dev)', () => {
  it('the double-invoked effects neither arm the boot restore twice nor strand it', () => {
    window.history.replaceState({ usr: null, key: 'kBoot', idx: 0 }, '', '/list')
    sessionStorage.setItem(PAGE_SCROLL_STORE_KEY, JSON.stringify({ '/list|kBoot': 900 }))
    maxScroll = 50
    mount({}, { strict: true })
    expect(decisions.filter((d) => d.row === '1')).toHaveLength(1)
    expect(scrollCalls).toEqual([900])                // one arming
    maxScroll = 2481
    frames(Math.ceil(RESTORE_HOLD_MS / 16) + 3)
    expect(window.scrollY).toBe(900)                  // the driver survived the simulated unmount
    expect(pending()).toBe(0)
  })

  it('a push under StrictMode is one reset', () => {
    mount({}, { strict: true })
    go('/list')
    scrollPage(800)
    scrollCalls = []
    go('/detail/1')
    expect(scrollCalls).toEqual([0])
  })
})

describe('a return, for pages that must not scroll against the restore (IMPORTANT-5)', () => {
  it('true on a POP arrival, false on a push; the at-mount reading keeps describing the arrival', async () => {
    mount()
    go('/list')
    expect(screen.getByTestId('page-list').dataset.return).toBe('false')
    go('/detail/1')
    await back()
    const list = screen.getByTestId('page-list')
    expect(list.dataset.return).toBe('true')
    expect(list.dataset.returnAtMount).toBe('true')
  })

  it('false outside the provider and with the flag off (today\'s behaviour)', () => {
    render(<Page name="bare" />)
    expect(screen.getByTestId('page-bare').dataset.return).toBe('false')
    cleanup()
    mount({ enabled: false })
    go('/list')
    go('/detail/1')
    return back().then(() => { expect(screen.getByTestId('page-list').dataset.return).toBe('false') })
  })
})

describe('the flag off', () => {
  it('SCROLL_MANAGER_ENABLED false: the manager never scrolls, never files, never flushes', async () => {
    mount({ enabled: false })
    go('/list')
    const kList = key()
    scrollPage(900)
    go('/detail/1')
    await back()
    expect(scrollCalls).toEqual([])
    expect(filed('/list', kList)).toBeUndefined()
    expect(sessionStorage.getItem(PAGE_SCROLL_STORE_KEY)).toBeNull()
    expect(decisions).toEqual([])
  })
})

describe('static guards', () => {
  const src = (p) => readFileSync(resolve(__dirname, '..', p), 'utf8')
  // Code lines only, so a guard reads code rather than prose about code. Line-based on purpose: a regex
  // comment stripper is fooled by `accept="image/*"` and URLs; this codebase's comments start their line.
  const code = (p) => src(p).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join('\n')

  it('the manager never writes history.state (rimpact MINOR-4): no pushState, replaceState, go or back', () => {
    for (const f of ['hooks/usePageScrollManager.js', 'lib/pageScroll.js']) {
      expect(code(f)).not.toMatch(/\b(pushState|replaceState)\b|history\.(go|back|forward)\s*\(/)
    }
  })

  it('main.jsx sets history.scrollRestoration before createRoot, \'manual\' with the flag on and \'auto\' with it off', () => {
    const m = code('main.jsx')
    const set = m.indexOf("window.history.scrollRestoration = SCROLL_MANAGER_ENABLED ? 'manual' : 'auto'")
    expect(set).toBeGreaterThan(-1)
    expect(set).toBeLessThan(m.indexOf('createRoot('))
    expect(m).toMatch(/'scrollRestoration' in window\.history/)
    // Never flipped back while the flag is on: that one assignment is the only write.
    expect(m.match(/scrollRestoration\s*=/g)).toHaveLength(1)
  })

  it('AppShell calls the manager with the page tree\'s location and wraps the shell in its provider', () => {
    const a = code('App.jsx')
    expect(a).toMatch(/usePageScrollManager\(\{ pageLocation, location: overlayLocation, navigationType, ready: !loading \}\)/)
    expect(a).toMatch(/<PageScrollProvider value=\{pageScroll\}>/)
  })

  it('no page scrolls itself to the top outside the allow-list: the manager owns the reset', () => {
    // Garden's own restore driver, and the two per-page resets that come back when the flag is off.
    const allowed = { 'Garden.jsx': 1, 'PlantingDetail.jsx': 1, 'InventoryDetail.jsx': 1 }
    const dir = resolve(__dirname, '../pages')
    const found = {}
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.jsx'))) {
      const n = (code(`pages/${f}`).match(/window\.scrollTo\(/g) || []).length
      if (n) found[f] = n
    }
    expect(found).toEqual(allowed)
  })
})
