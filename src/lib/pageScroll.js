// src/lib/pageScroll.js
// BUG-DETAILPAGESCARRYSCROLL-001 — the app-level page-scroll manager's DECISIONS, kept pure.
//
// THE BUG. BrowserRouter never resets window scroll on a push. The arriving page paints a one-screen
// loading shell, Chrome clamps the old offset to it, and scroll anchoring re-applies the old offset when
// the content lands: 9 of 10 pages measured in real Chrome opened part-way down, most at their bottom
// (Projects/Gardening/_seedstab12_20260925/measure-detailscroll.md). A reset alone breaks Back, because
// today's "Back keeps my place" on async pages rides the SAME anchoring carry. So the fix is a pair: a
// reset when the page tree arrives at a different page, and a restore on POP, under
// history.scrollRestoration = 'manual' (set once in main.jsx).
//
// Same discipline as scrollRestore.js and backNav.js: no DOM, no React, no history here. The wiring (a
// layout effect, a scroll listener, the rAF driver) is src/hooks/usePageScrollManager.js; everything it
// decides is decided below, where it can be table-tested. The decision table is design-scrollmanager-
// pwa.md §1 as amended by build-spec-scrollmanager.md (both in Projects/Gardening/_seedstab12_20260925/).
import { RESTORE_TOLERANCE_PX, hasRestoreTarget } from './scrollRestore.js'

// The mirror's OWN sessionStorage key. Never useScrollRestore's 'garden.scrollRestore.v1': the two stores
// are keyed differently and owned by different writers, and one blob read by both would let either one
// clobber the other's shape. Declared expedient per the Cross-Device State rule, as that hook's store is:
// tab-scoped view state, capped, read by nothing but the manager.
export const PAGE_SCROLL_STORE_KEY = 'garden.pageScroll.v1'
// Chromium keeps ~50 back/forward entries per tab (UNVERIFIED constant); twice that is ~5 KB of JSON.
// Least-recently-WRITTEN goes first (Map insertion order, re-inserted on every write).
export const PAGE_SCROLL_MAX_ENTRIES = 100
// The restore is DONE once the target has held this long with no change in document height. A page that
// loads in stages (PlantingDetail: header, then the Event log) changes height between stages, which resets
// the clock, so the driver keeps re-applying until the LAST stage has landed.
export const RESTORE_HOLD_MS = 1000
// VISIBLE time, not wall clock. At or above the app's own content bounds: the service worker gives an API
// read 12 s (public/sw.js SW_TIMEOUT_MS) and src/lib/api.js allows 15 s for a cold Neon + Lambda start.
// A change to either of those should bring someone here. Measured: a 4 s wall-clock budget lost Zones
// (1645 → 56) at 5 s latency and the Event log (4658 → 2070) at 3 s per request.
export const RESTORE_BUDGET_MS = 15000
// Per-frame cap on elapsed time. rAF does not tick while the page is hidden or frozen, so the first frame
// after a resume would otherwise spend the whole gap at once — a pocketed phone would come back to a
// restore that had already given up.
export const RESTORE_DT_CAP_MS = 100
// The budget above starts only once the user is resolved (Protected's skeleton holds the page for ~2.5 s at
// a cold start). This bounds the wait itself, in the same visible time: identity can stay 'unknown' for as
// long as the IdentityUnavailable screen is up, and a restore must not spin a frame loop under it forever.
export const RESTORE_WAIT_MAX_MS = 60000

// The store key: the page's path AND its history entry. A document's first entry has no router key
// ('default'), so without the path a keyless first entry in a later document of the same tab (a PWA
// shortcut, a typed URL) would read whatever page last filed under 'default'.
export function pageScrollKey(pathname, entryKey) {
  return `${pathname || ''}|${entryKey || 'default'}`
}

/**
 * What the manager does when the page tree commits a location.
 *
 * K is the PAGE's history entry (locationEntryKey of the page tree's location: the overlay's background
 * while one is open, and the entry a replace-close continues when stamped). P is its pathname.
 *
 *   row  change               nav            owner  action
 *   0    K unchanged          PUSH/REPLACE   any    NONE — overlay open/peek/swap, stamped replace-close,
 *                                                   +LOG replace into the marker slot, LogMany '.'
 *   0b   K unchanged          POP            any    RESTORE the snapshot if the page moved while covered
 *                                                   (walk-back close, marker pop), else NONE
 *   1    first commit         POP            app    RESTORE the mirror's record, else NONE; NONE for a
 *                                                   document that arrived by a fresh navigation
 *   1b   first commit         POP            page   NONE (the page restores itself)
 *   2    K and P changed      PUSH/REPLACE   any    TOP — a different page opens at its top
 *   3    K changed, P same    PUSH/REPLACE   any    KEEP — same-page writes never jump; refile under new K
 *   4    K and P changed      POP            app    RESTORE the record, else TOP
 *   5    K and P changed      POP            page   TOP (once, in the commit); the page restores itself
 *   6    K changed, P same    POP            app    RESTORE the record, else TOP
 *   7    K changed, P same    POP            page   NONE
 *
 * TOP is ONE scrollTo(0, 0) in the commit, never held and never re-applied, so it cannot beat a hook's or
 * Garden's later restore (rimpact-scrollmanager BLOCKING-2). It is needed at all only because 'manual'
 * leaves a POP with no defined offset (HTML spec), and a zero is the one offset scroll anchoring never
 * carries (css-scroll-anchoring §2.1). The store never mints a 0, so "no record" on a POP means the entry
 * was left at the top (or was never seen): rows 4 and 6 both put it there. Row 6 is the same-page case —
 * Put-Up's list left at the top → a batch (a same-path push) → Back used to keep the batch's offset
 * (rimpact-scrollmanager-built N1: y56 where the pre-manager app lands at 0).
 * An entry whose mode is 'auto' gets NO zero on rows 4, 5 and 6: the browser restores it natively. That
 * happens only where the mode cannot be set (main.jsx's write threw or the property is missing) — every
 * same-document entry this bundle writes copies the 'manual' mode, and an entry the previous bundle wrote
 * belongs to the previous document, so Back into it is a first commit (row 1), never rows 4-6.
 *
 * @param {object}  i
 * @param {boolean} i.enabled    SCROLL_MANAGER_ENABLED.
 * @param {boolean} i.first      The document's first commit (launch, reload, SW reload, tab restore).
 * @param {boolean} [i.fresh]    That document arrived by a fresh navigation (a launch, a typed URL, a PWA
 *                               shortcut into a running app) — not a reload, a Back or a tab restore — so
 *                               an offset its path filed in an earlier document is not its place
 *                               (rimpact-scrollmanager-built N3).
 * @param {{key:string,path:string}|null} i.prev  The page entry of the previous commit.
 * @param {{key:string,path:string}}      i.next  The page entry now committing.
 * @param {'POP'|'PUSH'|'REPLACE'} i.navType  react-router's navigation type for this commit.
 * @param {boolean} i.claimed    The mounted page claimed its own restore for next.key.
 * @param {number}  [i.record]   The offset filed for next, if any.
 * @param {string}  [i.entryMode] history.scrollRestoration of the active entry ('auto' | 'manual').
 * @param {boolean} [i.covered]  The active history entry is an overlay's or a Back marker's (row 0b).
 * @param {number}  [i.y]        The current offset (row 0b).
 * @param {number}  [i.snapshot] Where the page was before it was covered (row 0b).
 * @returns {{row:string, action:'NONE'|'TOP'|'RESTORE'|'KEEP', y?:number}}
 */
export function decidePageScroll({
  enabled, first, fresh = false, prev, next, navType, claimed, record, entryMode, covered = false, y, snapshot,
}) {
  if (!enabled) return { row: 'off', action: 'NONE' }
  const pop = navType === 'POP'
  if (first || !prev) {
    if (claimed) return { row: '1b', action: 'NONE' }
    if (fresh) return { row: '1', action: 'NONE' }
    return hasRestoreTarget(record) ? { row: '1', action: 'RESTORE', y: record } : { row: '1', action: 'NONE' }
  }
  if (prev.key === next.key) {
    if (pop && !covered && Number.isFinite(snapshot) && Number.isFinite(y)
      && Math.abs(y - snapshot) > RESTORE_TOLERANCE_PX) {
      return { row: '0b', action: 'RESTORE', y: snapshot }
    }
    return { row: '0', action: 'NONE' }
  }
  const samePage = prev.path === next.path
  if (!pop) return samePage ? { row: '3', action: 'KEEP' } : { row: '2', action: 'TOP' }
  const native = entryMode === 'auto'
  if (samePage) {
    if (claimed) return { row: '7', action: 'NONE' }
    if (hasRestoreTarget(record)) return { row: '6', action: 'RESTORE', y: record }
    return { row: '6', action: native ? 'NONE' : 'TOP' }
  }
  if (claimed) return { row: '5', action: native ? 'NONE' : 'TOP' }
  if (hasRestoreTarget(record)) return { row: '4', action: 'RESTORE', y: record }
  return { row: '4', action: native ? 'NONE' : 'TOP' }
}

// A driver armed at `target` at time `now`.
export function startDriver(target, now) {
  return { target, visibleMs: 0, waitedMs: 0, heldMs: 0, settledMs: 0, lastNow: Number.isFinite(now) ? now : null, lastHeight: null }
}

/**
 * The restore driver, one frame at a time. The wiring calls scrollTo(target) whenever `scroll` is true
 * and stops on DONE or EXHAUSTED; user input, a new page entry and a late claim by the page stop it from
 * outside.
 *
 * Why re-apply at all: a clamped scrollTo does not survive the way Chrome's own history restore does, so
 * the content landing later (a cold Lambda, weak signal, a page that loads in two stages) finds nothing
 * putting the offset back. Each attempt also grows windowed lists (see scrollRestore.js).
 *
 * OUT OF REACH (qa-scrollmanager-built, the Event log past "Show more"). A target can be beyond what the
 * page will ever show again — PlantingDetail forgets how many events were shown, so Back to event 55 finds
 * a page of 50. Once the page has SETTLED — its height unchanged and no API request in flight, both for
 * RESTORE_HOLD_MS of visible time — with the target still below its max, the driver stops (EXHAUSTED,
 * reason 'unreachable') at the closest reachable point instead of pulling for the whole budget. "No request
 * in flight" is load-bearing, not a nicety: a loading shell and the first stage of a two-stage page also
 * hold their height with the target beyond reach, for as long as the network takes (measured: stopping on
 * the height alone loses Zones at 5 s latency and the Event log at 3 s per stage, exactly as the 4 s
 * prototype did).
 *
 * @param {{target:number, visibleMs:number, heldMs:number, settledMs:number, lastNow:number|null, lastHeight:number|null}} s
 * @param {{now:number, y:number, height:number, max?:number, ready?:boolean, quiet?:boolean}} f
 *   max   — the page's maximum scroll now (scrollHeight − viewport height).
 *   ready — the user is resolved. Before that the page tree is Protected's skeleton, so no time counts:
 *           not the budget, not the hold, not the settling (a skeleton proves nothing). The wait itself is
 *           capped at RESTORE_WAIT_MAX_MS of that unresolved time.
 *   quiet — no API request is in flight (src/lib/netActivity.js). Absent → quiet.
 * @returns {{state:object, outcome:'RETRY'|'DONE'|'EXHAUSTED', scroll:boolean, reason?:string}}
 */
export function driverStep(s, { now, y, height, max, ready = true, quiet = true }) {
  if (!Number.isFinite(s.target) || !Number.isFinite(now) || !Number.isFinite(y) || !Number.isFinite(height)) {
    // A reading we cannot trust: stop rather than loop on garbage. EXHAUSTED re-opens writes, as a
    // finished restore does.
    return { state: s, outcome: 'EXHAUSTED', scroll: false, reason: 'unreadable' }
  }
  const dt = s.lastNow == null ? 0 : Math.min(Math.max(0, now - s.lastNow), RESTORE_DT_CAP_MS)
  const counted = ready ? dt : 0
  const visibleMs = s.visibleMs + counted
  // Only the unresolved time counts toward the wait cap: after a long skeleton the restore still gets its
  // whole budget (rimpact-scrollmanager-built N5).
  const waitedMs = (s.waitedMs || 0) + (ready ? 0 : dt)
  const at = Math.abs(y - s.target) <= RESTORE_TOLERANCE_PX
  const sameHeight = s.lastHeight == null || height === s.lastHeight
  const heldMs = at && sameHeight ? s.heldMs + counted : 0
  const settledMs = sameHeight && quiet ? (s.settledMs || 0) + counted : 0
  const state = { ...s, visibleMs, waitedMs, heldMs, settledMs, lastNow: now, lastHeight: height }
  if (at && heldMs >= RESTORE_HOLD_MS) return { state, outcome: 'DONE', scroll: false }
  if (!at && Number.isFinite(max) && s.target > max + RESTORE_TOLERANCE_PX && settledMs >= RESTORE_HOLD_MS) {
    return { state, outcome: 'EXHAUSTED', scroll: false, reason: 'unreachable' }
  }
  if (visibleMs >= RESTORE_BUDGET_MS) return { state, outcome: 'EXHAUSTED', scroll: false, reason: 'budget' }
  if (waitedMs >= RESTORE_WAIT_MAX_MS) return { state, outcome: 'EXHAUSTED', scroll: false, reason: 'wait' }
  return { state, outcome: 'RETRY', scroll: !at }
}

// ─── The store: a Map, mirrored best-effort into sessionStorage ───────────────────────────────────────
//
// One per module (the app has one page tree). Read once, lazily; written on every filed offset; flushed
// to sessionStorage by the wiring on visibilitychange → hidden, freeze, pagehide and after each committed
// navigation — hidden is the last event Chrome guarantees before a discard (Page Lifecycle).
let mem = null

function storage() {
  try { return window.sessionStorage } catch { return null }
}

function load() {
  if (mem) return mem
  mem = new Map()
  try {
    const raw = storage()?.getItem(PAGE_SCROLL_STORE_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed)) {
        // A hand-edited or half-written blob must never feed a non-numeric or negative offset to the driver.
        if (typeof k === 'string' && Number.isFinite(v) && v >= 0) mem.set(k, v)
      }
    }
  } catch { /* private mode, quota, a corrupt blob — the in-memory half still works */ }
  while (mem.size > PAGE_SCROLL_MAX_ENTRIES) mem.delete(mem.keys().next().value)
  return mem
}

export function readPageScroll(key) {
  return load().get(key)
}

// Never mints a record for an offset of 0 (nothing to restore), but does overwrite an EXISTING record
// with 0: that is the user scrolling back to the top.
export function filePageScroll(key, y) {
  if (!Number.isFinite(y) || y < 0) return
  const m = load()
  if (!hasRestoreTarget(y) && !m.has(key)) return
  m.delete(key)
  m.set(key, y)
  while (m.size > PAGE_SCROLL_MAX_ENTRIES) m.delete(m.keys().next().value)
}

export function flushPageScroll() {
  if (!mem) return
  try { storage()?.setItem(PAGE_SCROLL_STORE_KEY, JSON.stringify(Object.fromEntries(mem))) }
  catch { /* best effort, never load-bearing */ }
}

// Test seam only (src/__tests__/setup.ts calls it before every test, next to __resetScrollRestoreStore):
// every jsdom entry is 'default', so without it one test's filed offset is the next test's record.
export function __resetPageScrollStore() {
  mem = null
  try { storage()?.removeItem(PAGE_SCROLL_STORE_KEY) } catch { /* ignore */ }
}
export function __pageScrollEntries() {
  return [...load().entries()]
}
