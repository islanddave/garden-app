// src/hooks/usePageScrollManager.js
// BUG-DETAILPAGESCARRYSCROLL-001 — the app-level page-scroll manager's WIRING. Every decision it acts on
// is src/lib/pageScroll.js (decidePageScroll, driverStep, the store), table-tested there; this file only
// connects them to the commit, the scroll event and the page lifecycle.
//
// ONE CALLER in the app: AppShell (src/App.jsx), right after useOverlay() and before the identity gate (a
// hook cannot sit after an early return). The two real-Chrome harnesses that model AppShell
// (tests/harness/seedsscroll.jsx, tests/harness/pagescroll.jsx) import THIS module rather than copying
// it, and gate:seeds-scroll's drift guard fails if AppShell stops calling it.
//
// NO ROUTER IMPORT, like useScrollRestore: the navigation type is passed in by the caller, and the pages
// that claim or read a return reach this module only through React context, so the suites that replace
// react-router-dom wholesale keep working. Outside the provider every page-side hook here is inert.
//
// WHAT IT DOES, per commit of the page tree (a LAYOUT effect: the reset must land in the swap commit, before
// first paint and before the next layout can let anchoring carry the old offset):
//   · a different page by PUSH or REPLACE → scrollTo(0, 0);
//   · the same page by PUSH or REPLACE (a query write, a tab re-tap) → nothing moves;
//   · a POP → the offset filed for that entry, re-applied until it holds (the driver), unless the page
//     claimed its own restore (useScrollRestore, Garden) — then one zero in the commit and the page does it.
// The full table is decidePageScroll's header.
//
// FILING follows useScrollRestore's two rules (rimpact-scrollmanager IMPORTANT-3): an offset is filed only
// while the history entry is still the committed page's (react-router has already written the next entry
// by the time a swap's clamp fires a scroll event), and never while a restore is armed for it (the
// driver's own clamped attempts would overwrite the target). Nothing is filed in an effect cleanup. And
// nothing is filed while the page is COVERED — the active entry is a route overlay's or a Back marker's:
// the body is scroll-locked under a sheet, so a scroll event there is the page rendering shorter behind
// it, never a place. The last offset filed before the cover is the snapshot a walk-back close or a marker
// pop re-applies if the page moved (IMPORTANT-2), which is what Chrome's own traversal restore did before
// 'manual' turned it off.
//
// WHO TAKES OVER A RESTORE, per owner (qa-scrollmanager-built M12). This manager's driver stops for good on
// real scrolling — a wheel, a moving finger (touchmove), a key — and on a deliberate act: a click, a
// mouse/pen press, focus arriving in a text field, or the page itself scrolling on purpose
// (usePageScrollYield, e.g. useLotOutline's outline). NOT on touchstart, and not on a TOUCH pointerdown,
// which is the same moment: a thumb resting on the glass while the page loads must not lose the place
// (rimpact-scrollmanager IMPORTANT-7); lifting it after a short tap is a click, which does count, and a long
// rest produces no click at all. The hook pages' own restore (useScrollRestore) and Garden's keep their
// older rule — wheel, touchstart, keydown — for their ~20-frame loops; those are not this driver.
import { createContext, createElement, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { SCROLL_MANAGER_ENABLED, OVERLAY_ROUTES_ENABLED } from '../lib/featureFlags.js'
import { locationEntryKey, pageEntryKey } from '../lib/pageEntry.js'
import { readAnyMarker } from '../lib/backNav.js'
import { requestsInFlight } from '../lib/netActivity.js'
import {
  decidePageScroll, startDriver, driverStep, pageScrollKey, readPageScroll, filePageScroll, flushPageScroll,
} from '../lib/pageScroll.js'

const ClaimContext = createContext(null)
const ReturnContext = createContext(false)

// The browser's own scroll restoration, set ONCE at boot, before createRoot (src/main.jsx; the real-Chrome
// harnesses call it too, so the gates measure the mode prod runs in). The mode belongs to each history entry
// and pushState/replaceState copy the active entry's mode into the new one (HTML spec), so setting it before
// BrowserRouter's boot replaceState makes every entry this bundle writes 'manual': the manager restores,
// because Chrome's restore cannot hold an offset on a page whose content lands after the traversal. NEVER
// flipped back while the flag is on — not on pagehide as react-router's <ScrollRestoration> does: a discard
// fires no pagehide, and after a bfcache restore it would leave 'auto' for every later push to copy. With the
// flag OFF it writes 'auto', because the mode survives a reload: an off bundle booting on an entry an on
// bundle marked 'manual' must put the browser's restore back.
export function applyBrowserScrollRestoration(enabled = SCROLL_MANAGER_ENABLED) {
  try {
    if ('scrollRestoration' in window.history) window.history.scrollRestoration = enabled ? 'manual' : 'auto'
  } catch { /* an opaque or locked-down history: the manager still resets and restores */ }
}

function historyState() {
  try { return window.history.state } catch { return null }
}

// The page entry the ACTIVE history entry answers to: pageEntryKey's rule (an overlay's entry answers to
// its background, a stamped replace-close to the entry it continues), with react-router's own 'default'
// for the entry it has not keyed — the document's first.
export function currentPageEntry() {
  return pageEntryKey(historyState()) || 'default'
}

// Covered: the active entry is a route overlay's (it carries a background OverlayProvider would honour) or
// a DismissRegistry Back marker's.
function isCovered(state) {
  if (!state || typeof state !== 'object') return false
  if (readAnyMarker(state)) return true
  const usr = state.usr && typeof state.usr === 'object' ? state.usr : null
  const bg = OVERLAY_ROUTES_ENABLED && usr ? usr.background : null
  return !!(bg && typeof bg === 'object' && typeof bg.pathname === 'string')
}

// 'instant', not the default: a future global `scroll-behavior: smooth` would otherwise animate the reset.
function scrollToY(y) {
  try { window.scrollTo({ top: y, left: 0, behavior: 'instant' }) } catch { /* jsdom, a locked-down surface */ }
}
function scrollMode() {
  try { return window.history.scrollRestoration } catch { return undefined }
}
function docHeight() {
  try { return document.documentElement.scrollHeight } catch { return NaN }
}
function maxScroll() {
  try { return document.documentElement.scrollHeight - window.innerHeight } catch { return NaN }
}
const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

// Did this DOCUMENT arrive by a fresh navigation — a launch, a typed URL, a PWA shortcut into a running app —
// rather than a reload, a Back/Forward or a tab restore? Then the offset its path filed in an earlier document
// is not its place (rimpact-scrollmanager-built N3), and a door's arrival hint (`?lot=`) is an arrival, not a
// return (N6). A discarded tab brought back counts as a restore whatever type it reports. Read once: the
// answer belongs to the document. No navigation timing → not fresh (restore, as before).
let freshDocument
export function documentArrivedFresh() {
  if (freshDocument !== undefined) return freshDocument
  freshDocument = false
  try {
    const nav = performance.getEntriesByType('navigation')[0]
    freshDocument = !!nav && nav.type === 'navigate' && !document.wasDiscarded
  } catch { /* no navigation timing */ }
  return freshDocument
}
// Test seam only.
export function __setDocumentArrivedFresh(value) { freshDocument = value }

// A text field taking focus opens the keyboard and resizes the viewport: the user is typing, not reading.
function isEditable(el) {
  if (!el || typeof el !== 'object') return false
  if (el.isContentEditable) return true
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true
  return el.tagName === 'INPUT' && !/^(button|checkbox|radio|submit|reset|range|color|file|image|hidden)$/i.test(el.type || '')
}

function stopDriver(s, outcome, reason) {
  if (s.raf) { try { cancelAnimationFrame(s.raf) } catch { /* ignore */ } }
  s.raf = 0
  const d = s.driver
  s.driver = null
  if (d && outcome) {
    s.lastOutcome = outcome
    if (s.observe && s.observe.current) {
      s.observe.current({ outcome, reason: reason || null, entry: d.entry, target: d.state.target, y: window.scrollY, max: maxScroll() })
    }
  }
}

// Arm the restore for `entry` at `target`: the first attempt in the commit, then one per frame until the
// target has held (DONE), it is out of the settled page's reach or the visible-time budget is spent
// (EXHAUSTED), or something outside stops it.
function arm(s, entry, storeKey, target) {
  stopDriver(s)
  s.driver = { entry, storeKey, state: startDriver(target, clock()) }
  s.expected = { key: storeKey, y: target }
  scrollToY(target)
  const tick = () => {
    const d = s.driver
    if (!d) return
    if (!s.alive) { stopDriver(s); return }
    const r = driverStep(d.state, {
      now: clock(), y: window.scrollY, height: docHeight(), max: maxScroll(), ready: s.ready,
      quiet: requestsInFlight() === 0,
    })
    d.state = r.state
    if (r.outcome !== 'RETRY') { stopDriver(s, r.outcome, r.reason); return }
    if (r.scroll) scrollToY(target)
    s.raf = requestAnimationFrame(tick)
  }
  s.raf = requestAnimationFrame(tick)
}

// One scroll event: file it under the committed page's entry if every write rule allows.
function file(s) {
  const p = s.prev
  if (!p) return
  if (s.driver && s.driver.entry === p.key) return                  // writes closed while armed
  const state = historyState()
  if ((pageEntryKey(state) || 'default') !== p.key) return          // the entry is no longer the page's
  if (isCovered(state)) return                                      // a clamp behind a sheet, not a place
  const key = pageScrollKey(p.path, p.key)
  const y = window.scrollY
  s.expected = { key, y }
  if (!s.claims.has(p.key)) filePageScroll(key, y)                  // a claimed entry is the page's to file
}

/**
 * @param {object}  opts
 * @param {object}  opts.pageLocation    OverlayProvider's pageLocation (the background while an overlay is open).
 * @param {object}  opts.location        The router's REAL location (OverlayProvider's overlayLocation). A new
 *                                       object on every router commit, a delta-0 POP included, which is how
 *                                       a commit is told from StrictMode re-running the effect. pageLocation
 *                                       cannot tell: under an overlay it is the stored background, and a door
 *                                       may store the very object the page was already rendered at.
 * @param {string}  opts.navigationType  react-router's useNavigationType() — 'POP' | 'PUSH' | 'REPLACE'.
 * @param {boolean} [opts.ready=true]    The user is resolved. Until then Protected renders its skeleton,
 *                                       so a boot restore arms but counts no time.
 * @param {boolean} [opts.enabled]       SCROLL_MANAGER_ENABLED; a parameter only so tests can pass it.
 * @param {(d:object)=>void} [opts.onDecision]  Observation only (the real-Chrome harness logs rows).
 * @param {(r:object)=>void} [opts.onRestore]   Observation only: how each restore ended (outcome, reason).
 * @returns {{api:object, isReturn:boolean}} for <PageScrollProvider value>.
 */
export function usePageScrollManager({ pageLocation, location, navigationType, ready = true, enabled = SCROLL_MANAGER_ENABLED, onDecision, onRestore }) {
  const entry = locationEntryKey(pageLocation) || 'default'
  const path = (pageLocation && pageLocation.pathname) || ''
  const ref = useRef(null)
  if (ref.current === null) {
    ref.current = {
      prev: null, first: true, loc: null, firstLoc: null, claims: new Map(), driver: null, raf: 0, expected: null,
      ready, alive: true, lastOutcome: null, observe: { current: null },
    }
  }
  const s = ref.current
  const onDecisionRef = useRef(onDecision)
  onDecisionRef.current = onDecision
  s.observe.current = onRestore || null

  useLayoutEffect(() => { s.ready = ready }, [s, ready])

  // A claim is PER ENTRY (rimpact-scrollmanager IMPORTANT-4): a page claims the entry it holds a saved
  // offset for, at its first render. A claim that lands after the commit that armed a restore for that
  // entry — a page that mounted late, behind Protected's skeleton at boot — cancels the driver: the page
  // restores itself. `yieldScroll` is a page about to scroll on purpose (an outline, a highlight): the
  // restore stops for good rather than pulling the page back (rimpact-scrollmanager-built N4).
  const api = useMemo(() => ({
    claim(key) {
      s.claims.set(key, (s.claims.get(key) || 0) + 1)
      if (s.driver && s.driver.entry === key) stopDriver(s, 'CLAIMED')
      return () => {
        const n = (s.claims.get(key) || 1) - 1
        if (n > 0) s.claims.set(key, n)
        else s.claims.delete(key)
      }
    },
    yieldScroll() {
      if (s.driver) stopDriver(s, 'TAKEOVER', 'page')
    },
  }), [s])

  const commit = location || pageLocation
  useLayoutEffect(() => {
    if (!enabled) return
    // Keyed on the router's location OBJECT: every router commit is a new one, including the delta-0 POP of
    // a marker pop or a walk-back close (same entry, row 0/0b). The same object again is StrictMode's second
    // run of this effect, or `enabled` changing — nothing new was committed, so nothing is decided twice.
    if (s.loc === commit) return
    s.loc = commit
    const next = { key: entry, path }
    const prev = s.prev
    const first = s.first
    if (first) s.firstLoc = commit
    s.first = false
    s.prev = next
    const storeKey = pageScrollKey(path, entry)
    const changed = !prev || prev.key !== entry
    // A new page entry cancels a restore in flight. Its target is what a same-page re-key carries (row 3).
    const carried = changed && s.driver ? s.driver.state.target : null
    if (changed) stopDriver(s, s.driver ? 'SUPERSEDED' : null)
    const armedHere = !!(s.driver && s.driver.entry === entry)
    const y = window.scrollY
    const d = decidePageScroll({
      enabled, first, fresh: first && documentArrivedFresh(), prev, next, navType: navigationType, claimed: s.claims.has(entry),
      record: readPageScroll(storeKey), entryMode: scrollMode(), covered: isCovered(historyState()), y,
      snapshot: !armedHere && s.expected && s.expected.key === storeKey ? s.expected.y : undefined,
    })
    if (d.action === 'TOP') {
      scrollToY(0)
      s.expected = { key: storeKey, y: 0 }
    } else if (d.action === 'RESTORE') {
      arm(s, entry, storeKey, d.y)
    } else if (d.action === 'KEEP') {
      const keep = carried != null ? carried : y
      if (!s.claims.has(entry)) filePageScroll(storeKey, keep)
      s.expected = { key: storeKey, y: keep }
    } else if (changed) {
      s.expected = { key: storeKey, y }
    }
    // A page that claimed its entry restores ITSELF, so where it will be is not the manager's zero: it is
    // wherever the page's own restore puts it, learnt from the next uncovered scroll. Recording the zero
    // here would make a walk-back close re-apply it — Search → a result → Back re-mounts Seeds under the
    // sheet, its hook restores 3195 there (covered, so unfiled), and the X would have taken it to the top.
    if (changed && s.claims.has(entry)) s.expected = null
    flushPageScroll()
    if (onDecisionRef.current) onDecisionRef.current({ ...d, entry, path, navType: navigationType, scrollY: y })
  }, [s, enabled, commit, navigationType, entry, path])

  // One passive listener each, installed once. The cleanup removes listeners and nothing else: it never
  // files (IMPORTANT-3), and it never cancels the driver, because StrictMode runs this cleanup and the
  // effect again inside one commit, and the layout effect above does not re-arm for a location it has
  // already seen. A real unmount marks the state dead, and the driver's next frame stops it.
  useEffect(() => {
    if (!enabled) return undefined
    s.alive = true
    // Who takes over: the file header's "WHO TAKES OVER A RESTORE". Click and press are listened for in the
    // CAPTURE phase, so the restore has stopped before the page's own handler runs — a "Show more" tap must
    // never be pulled back to the old place by the content it adds (qa-scrollmanager-built, Event log).
    const takeover = (reason) => { if (s.driver) stopDriver(s, 'TAKEOVER', reason) }
    const onWheel = () => takeover('wheel')
    const onTouchMove = () => takeover('touchmove')
    const onKey = () => takeover('keydown')
    const onClick = () => takeover('click')
    const onPress = (e) => { if (e && e.pointerType !== 'touch') takeover('pointerdown') }
    const onFocusIn = (e) => { if (isEditable(e && e.target)) takeover('focusin') }
    const onScroll = () => file(s)
    // Hidden is the last event Chrome guarantees before a discard; pagehide and freeze may never come.
    const onVisibility = () => { if (document.visibilityState === 'hidden') flushPageScroll() }
    const onFlush = () => flushPageScroll()
    const passive = { passive: true }
    const early = { passive: true, capture: true }
    window.addEventListener('wheel', onWheel, passive)
    window.addEventListener('touchmove', onTouchMove, passive)
    window.addEventListener('keydown', onKey, passive)
    window.addEventListener('click', onClick, early)
    window.addEventListener('pointerdown', onPress, early)
    window.addEventListener('focusin', onFocusIn, passive)
    window.addEventListener('scroll', onScroll, passive)
    document.addEventListener('visibilitychange', onVisibility)
    document.addEventListener('freeze', onFlush)
    window.addEventListener('pagehide', onFlush)
    return () => {
      s.alive = false
      window.removeEventListener('wheel', onWheel, passive)
      window.removeEventListener('touchmove', onTouchMove, passive)
      window.removeEventListener('keydown', onKey, passive)
      window.removeEventListener('click', onClick, early)
      window.removeEventListener('pointerdown', onPress, early)
      window.removeEventListener('focusin', onFocusIn, passive)
      window.removeEventListener('scroll', onScroll, passive)
      document.removeEventListener('visibilitychange', onVisibility)
      document.removeEventListener('freeze', onFlush)
      window.removeEventListener('pagehide', onFlush)
    }
  }, [s, enabled])

  // "This mount is a return": the page tree arrived by POP (Back, Forward, a reload, a tab restore) — except
  // the document's own first location when the document arrived by a fresh navigation (react-router's
  // initial action is POP for every load, a typed URL included): a door's arrival hint is honoured there
  // (rimpact-scrollmanager-built N6). Pages mount behind Protected's skeleton AFTER the first commit, so
  // this reads the location, not the commit count.
  const atFirstLocation = !s.firstLoc || s.firstLoc === commit
  const isReturn = !!enabled && navigationType === 'POP' && !(atFirstLocation && documentArrivedFresh())
  return useMemo(() => ({ api, isReturn }), [api, isReturn])
}

// Wraps the shell's children. Without it every hook below is inert, which is what the isolated suites get.
export function PageScrollProvider({ value, children }) {
  return createElement(ClaimContext.Provider, { value: value ? value.api : null },
    createElement(ReturnContext.Provider, { value: !!(value && value.isReturn) }, children))
}

// A page that restores its own offset claims its entry (null = no claim). Registered in a LAYOUT effect:
// React runs a child's layout effects before its parent's in the same commit, so AppShell's decision for a
// POP sees the arriving page's claim, and the page leaving unclaims (mutation phase) before it.
export function useClaimPageScroll(entry) {
  const api = useContext(ClaimContext)
  useLayoutEffect(() => {
    if (!api || !entry) return undefined
    return api.claim(entry)
  }, [api, entry])
}

// Whether the page tree's latest arrival was a POP (Back, Forward, a reload, a tab restore): "this is a
// return", which the manager restores, so a page's own arrival scroll must not fire against it
// (rimpact-scrollmanager IMPORTANT-5). LIVE — it follows every navigation; a caller that means "the
// navigation that mounted me" captures it at first render (usePageScrollReturnAtMount). False outside the
// provider and with the flag off, so both keep today's behaviour.
export function usePageScrollReturn() {
  return useContext(ReturnContext)
}
export function usePageScrollReturnAtMount() {
  const isReturn = useContext(ReturnContext)
  const [atMount] = useState(isReturn)
  return atMount
}

// For a page about to scroll on purpose (an outline or highlight it was asked to show): call the returned
// function first, and a restore still pulling toward the old place stops for good instead of fighting it.
// A stable no-op outside the provider.
export function usePageScrollYield() {
  const api = useContext(ClaimContext)
  return useCallback(() => { if (api && api.yieldScroll) api.yieldScroll() }, [api])
}
