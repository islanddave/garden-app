// src/context/OverlayContext.jsx
// V4-OVERLAY-001 Slice 1 — route-backed overlays (design V102 §1, Architecture A).
// Navigate carrying state:{ background: location }; App renders the PAGE tree at
// `background ?? location` and an OVERLAY tree at the REAL location when a background exists.
// This context is the single source of the "effective page location" so App-level chrome
// (TopChrome/TodayBand/BottomNav/CritterArrivalController) follows the BACKGROUND, not the
// overlay URL (§2). Entirely inert when OVERLAY_ROUTES_ENABLED is false: no background is ever
// set, the overlay tree never renders, and every helper degrades to plain navigate/Link.
import React, { createContext, useContext, useMemo, useCallback, useEffect } from 'react'
import { useLocation, useNavigate, Link } from 'react-router-dom'
import { OVERLAY_ROUTES_ENABLED } from '../lib/featureFlags.js'
import { readAnyMarker } from '../lib/backNav.js'

const OverlayContext = createContext(null)

// ─── BUG-OVERLAYDISMISSREKEY-001 — close by walking back to the page's OWN history entry ──────────
//
// Closing by replace (the only close there was) put a NEW entry, with a new react-router key, where the
// overlay's entry had been: [.., k1:page, k2:/search] -> [.., k1:page, k3:page]. Two defects followed.
// The page stayed mounted under a key it never opened on, so useScrollRestore — which may write only
// while its own entry is current (BUG-SAVEDSEEDSBACKTOP-001) — saved nothing for the rest of the visit
// and Back from a detail landed at the top. And the stack held the page twice, so the first system Back
// after a close went k3 -> k1, the same URL: a press that did nothing. The system Back never had either
// problem, because it pops to k1.
//
// So a close now does what Back does, whenever the page's entry is PROVABLY behind us: the background
// carries where its entry sits (react-router's `idx`, which BrowserRouter writes into history.state and
// which EventNew's weigh-frame close already reads) and which document wrote it. The walk is refused —
// and the old replace stands — when any of that cannot be shown: an entry written before this release
// (no historyEntry), MemoryRouter (window.history never moves, so the distance is 0), a DismissRegistry
// Back marker on top (it copies the idx of the entry under it, so the arithmetic would stop one short
// and close a sheet instead), an entry from before a reload (history.go across documents is a full page
// load, not a close), or a distance past MAX_CLOSE_STEPS.
//
// ONE DOOR OPENS BY REPLACE: a row in an armed sheet (BottomNav's +LOG "Log an event" / "Log many",
// SheetRowLink) collapses the sheet's Back marker INTO the overlay rather than stranding it. The marker
// is its own entry one above the page's, but it copied the page's idx, and a replace keeps the idx — so
// that overlay sits one entry above the page while reading the page's idx. withHistoryEntry records
// that (markerSlot) and the walk counts it. A replace-open over anything that is NOT a marker has
// overwritten the page's own entry, so there is nothing to walk back to and nothing is recorded.
// (design review: Projects/Gardening/_seedstab11_20260925/design-critique-pwa.md F1.)

// Which document wrote an entry. `location.reload()` (the service worker's post-deploy controllerchange)
// keeps history.state but not this module, so a background from the old document is recognisable.
const DOC_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
// An overlay is one entry deep, two with a Search peek pushed inside it. Anything past this is not a
// stack this file built.
const MAX_CLOSE_STEPS = 10
// How long a started walk may take to land before a second close stops waiting for it and replaces.
// A same-document traversal lands in a frame or two; this only bounds a walk that never lands (a
// cancelled traversal, a truncated restored stack), which would otherwise leave X, Escape and Done dead.
const WALK_LANDS_WITHIN_MS = 1500

function historyState() {
  try { return window.history.state } catch { return null }
}
// react-router's own fallback for an entry that carries no key yet (createLocation: `state.key || 'default'`).
function routerKey(state) {
  return (state && state.key) || 'default'
}
// The location an overlay opens over, plus where its history entry sits. `replacing` is the open's own
// replace flag (see ONE DOOR OPENS BY REPLACE above).
function withHistoryEntry(location, replacing = false) {
  // Under an open overlay the page tree's location IS the background, historyEntry included, so a
  // branch that records nothing must also carry nothing stale forward.
  const { historyEntry: _stale, ...bare } = location
  const state = historyState()
  const idx = state?.idx
  if (!Number.isInteger(idx)) return bare
  if (!replacing) return { ...bare, historyEntry: { idx, doc: DOC_ID } }
  if (!readAnyMarker(state)) return bare
  return { ...bare, historyEntry: { idx, doc: DOC_ID, markerSlot: true } }
}

// How to close the overlay whose background is `background`, standing on history state `state`:
//   { kind: 'back', steps } — the page's own entry is `steps` behind us; go there.
//   { kind: 'none' }        — we are already standing on it (a walk or a system Back has landed and
//                             React has not committed yet — BrowserRouter commits every location in a
//                             transition — so the overlay is still on screen). Nothing to do.
//   { kind: 'replace' }     — cannot prove where it is; replace to the background URL, as before.
// Pure, and exported for its tests.
export function planOverlayClose(background, state, doc = DOC_ID) {
  const at = background && background.historyEntry
  const bgKey = background && background.key
  // Already home, checked FIRST: in that window the replace below would overwrite the page's OWN
  // entry — the very re-key this fix removes. A real router key only: a MemoryRouter or hand-built
  // background may carry none, and 'default' is shared by every entry react-router has not keyed.
  if (bgKey && bgKey !== 'default' && state && state.key === bgKey) return { kind: 'none' }
  const cur = state && Number.isInteger(state.idx) ? state.idx : null
  // Evidence next: without an entry this document recorded there is nothing to reason from.
  if (!at || at.doc !== doc || !Number.isInteger(at.idx) || cur == null) return { kind: 'replace' }
  if (routerKey(state) === (bgKey || 'default')) return { kind: 'none' }
  if (readAnyMarker(state)) return { kind: 'replace' }
  const steps = cur - at.idx + (at.markerSlot ? 1 : 0)
  if (steps < 1 || steps > MAX_CLOSE_STEPS) return { kind: 'replace' }
  return { kind: 'back', steps }
}

// The walk a close has already started: the entry it left and when. A replace was idempotent — pressing
// twice landed on the same URL — but a walk is not: a second press before the first lands would go back
// again, off the page. Cleared by OverlayProvider on every location change, so an entry re-entered by
// Forward can be closed again.
let closingFrom = null

// Signals to route content that it is rendering INSIDE an overlay Sheet (vs full-page). OverlayHost
// provides `true`; everywhere else it defaults false. Lets a route (e.g. Search) drop its full-page
// 100dvh floor and defer initial focus to the Sheet when it is shown as a flyover (§6/§7). Inert
// when the flag is off — OverlayHost never mounts, so this stays false.
const OverlaySurfaceContext = createContext(false)
export function OverlaySurfaceProvider({ children }) {
  return <OverlaySurfaceContext.Provider value={true}>{children}</OverlaySurfaceContext.Provider>
}
export function useInOverlaySurface() {
  return useContext(OverlaySurfaceContext)
}

// V4-DRAFTFULLPAGE-001 (b) — the missing half of Sheet §5.2: Sheet shipped a `dirty` prop (backdrop
// tap no-ops while dirty; Escape + the labelled Close stay live) with zero consumers. This channel
// lets overlay CONTENT report its dirty state UP to the hosting Sheet: OverlayHost owns the state
// and provides the setter; content calls useReportOverlayDirty(bool). Everywhere else (full page,
// isolated tests) the context is null and the hook is a strict no-op. Value is the setter function
// itself — stable from useState, so consumer effects keyed on it never re-fire.
const OverlayDirtyContext = createContext(null)
export function OverlayDirtyProvider({ onDirtyChange, children }) {
  return <OverlayDirtyContext.Provider value={onDirtyChange}>{children}</OverlayDirtyContext.Provider>
}
// Report in-progress (dirty) state to the hosting Sheet. Cleanup resets to false so an unmounting
// form (dismiss, route swap) can never strand the host dirty and lock the backdrop for the next
// content.
export function useReportOverlayDirty(dirty) {
  const report = useContext(OverlayDirtyContext)
  useEffect(() => {
    if (!report) return
    report(dirty)
    return () => report(false)
  }, [report, dirty])
}

// A background is honored only if the flag is on AND it looks like a real location. Guards the
// "stale background across reload/deploy" trap (§V102 failure mode b): an unparseable/legacy value
// degrades to full-page (background=undefined) instead of rendering a broken overlay tree.
function validBackground(bg) {
  return bg && typeof bg === 'object' && typeof bg.pathname === 'string' ? bg : undefined
}

export function OverlayProvider({ children }) {
  const location = useLocation()
  const background = OVERLAY_ROUTES_ENABLED ? validBackground(location.state?.background) : undefined

  useEffect(() => { closingFrom = null }, [location.key])

  const value = useMemo(
    () => ({
      background, // undefined unless an overlay is open (flag on)
      overlayLocation: location, // the REAL location — the overlay tree renders here
      pageLocation: background ?? location, // what chrome + the page tree render (§2, §3)
    }),
    [background, location]
  )

  return <OverlayContext.Provider value={value}>{children}</OverlayContext.Provider>
}

// Chrome hook: the EFFECTIVE page location. Drop-in for useLocation() in App-level chrome.
// When no overlay is open (incl. flag off) this IS the real location — byte-identical to today.
// Falls back to the real location when rendered OUTSIDE a provider (e.g. isolated chrome tests),
// so it is a safe drop-in that never throws.
export function useOverlayLocation() {
  const ctx = useContext(OverlayContext)
  const real = useLocation()
  return ctx ? ctx.pageLocation : real
}

// Full overlay state. Throws outside a provider — for intentional overlay consumers (OverlayHost).
export function useOverlay() {
  const ctx = useContext(OverlayContext)
  if (!ctx) throw new Error('useOverlay must be used inside OverlayProvider')
  return ctx
}

// Open an overlay: navigate carrying the current location as `background`.
// Flag off -> plain navigate -> full-page render, identical to today.
export function useOverlayNavigate() {
  const navigate = useNavigate()
  const location = useLocation()
  return useCallback(
    (to, opts = {}) => {
      if (!OVERLAY_ROUTES_ENABLED) { navigate(to, opts); return }
      navigate(to, { ...opts, state: { ...opts.state, background: withHistoryEntry(location, !!opts.replace) } })
    },
    [navigate, location]
  )
}

// Declarative equivalent of useOverlayNavigate. Flag off -> a plain <Link>, same DOM/props.
export function OverlayLink({ to, state, children, ...rest }) {
  const location = useLocation()
  // Read at render, not at click: OverlayLink re-renders on every location change (useLocation), and the
  // only thing that moves history.state between those renders is a Back marker, which copies the idx.
  const linkState = OVERLAY_ROUTES_ENABLED ? { ...state, background: withHistoryEntry(location, !!rest.replace) } : state
  return (
    <Link to={to} state={linkState} {...rest}>
      {children}
    </Link>
  )
}

// Dismiss (§4): NEVER a bare navigate(-1) (history.back() at idx 0 is a no-op — the overlay would
// stick open). Walk back to the page's own entry when planOverlayClose can prove where it is (see
// BUG-OVERLAYDISMISSREKEY-001 above); otherwise replace to the background URL, else /today.
// Resilient outside a provider (useContext, not useOverlay) so overlay route content (LogMany "Done")
// can call it in isolated unit tests that render without a provider — there background is simply
// undefined and it falls back to /today (same as flag-off / no overlay).
export function useOverlayDismiss() {
  const navigate = useNavigate()
  const ctx = useContext(OverlayContext)
  const background = ctx ? ctx.background : undefined
  return useCallback(() => {
    if (!background) { navigate('/today', { replace: true }); return }
    const state = historyState()
    const plan = planOverlayClose(background, state)
    if (plan.kind === 'none') return
    if (plan.kind === 'back') {
      const from = routerKey(state)
      const inFlight = closingFrom && closingFrom.from === from
      if (inFlight && Date.now() - closingFrom.at < WALK_LANDS_WITHIN_MS) return
      if (!inFlight) {
        closingFrom = { from, at: Date.now() }
        navigate(-plan.steps)
        return
      }
      // A walk started from this entry and never landed: stop waiting and close the old way.
      closingFrom = null
    }
    navigate(background.pathname + background.search, { replace: true })
  }, [navigate, background])
}

// Slice 2 — safe read of the current background (undefined when no overlay / flag off / outside a
// provider). Lets overlay content preserve `background` when it re-navigates to the SAME url with new
// state (LogMany's post-batch critterCheck push, §4) without pulling in useLocation() — which the
// bare-mock unit tests for these pages do not provide.
export function useOverlayBackground() {
  const ctx = useContext(OverlayContext)
  return ctx ? ctx.background : undefined
}

// Slice 2 — SWAP the overlay's content WITHOUT changing the background. For cross-links that live
// INSIDE an overlay (Log one <-> Log many, and Log Many's harvest→per-plant route): using
// useOverlayNavigate there would set background to the overlay's OWN url (/log or /log/many), which
// would render a form as the page-tree "background" and dismiss to the wrong place. Instead we carry
// the EXISTING background forward and `replace` (a content swap must not grow history). When no
// overlay is open (full-page, or flag off) this is a plain push navigate — identical to the old
// <Link>/navigate() the call site used before.
export function useOverlaySwap() {
  const navigate = useNavigate()
  const ctx = useContext(OverlayContext)
  const background = ctx ? ctx.background : undefined
  return useCallback(
    (to, opts = {}) => {
      if (OVERLAY_ROUTES_ENABLED && background) {
        navigate(to, { replace: true, ...opts, state: { ...opts.state, background } })
      } else {
        navigate(to, opts)
      }
    },
    [navigate, background]
  )
}

// Declarative equivalent of useOverlaySwap for cross-link <Link>s inside an overlay.
export function OverlaySwapLink({ to, state, replace: replaceProp, children, ...rest }) {
  const ctx = useContext(OverlayContext)
  const background = ctx ? ctx.background : undefined
  const inOverlay = OVERLAY_ROUTES_ENABLED && !!background
  const linkState = inOverlay ? { ...state, background } : state
  return (
    <Link to={to} state={linkState} replace={inOverlay || !!replaceProp} {...rest}>
      {children}
    </Link>
  )
}

// Slice 2 — safe read of the OPEN overlay's pathname (null when no overlay is open / outside a
// provider). Drives the CritterArrivalController suppress-and-queue: a reward must never pop over an
// open capture form (§7). Returns null (not-open) in isolated tests with no provider.
export function useOpenOverlayPath() {
  const ctx = useContext(OverlayContext)
  if (!ctx || !ctx.background) return null
  return ctx.overlayLocation?.pathname ?? null
}

// Slice 2 follow-up (Dave 2026-07-20) — the explicit reward signal LogMany pushes onto the REAL
// overlay location's state at the confirm→result moment (state.critterCheck). Unlike an ambient
// poll-surfaced critter, it means "a batch was just completed — show the reward NOW, on the result
// screen." The CritterArrivalController treats it as a show-now trigger that BYPASSES the §7 form-open
// suppression (which otherwise queues the reward to dismiss, deferring it off the accomplishment
// moment onto the underlying page). It reads the REAL overlay location — NOT background/pageLocation,
// where the same-path push does NOT land. null outside a provider / when no signal is present.
export function useOverlayRewardSignal() {
  const ctx = useContext(OverlayContext)
  return ctx?.overlayLocation?.state?.critterCheck ?? null
}
