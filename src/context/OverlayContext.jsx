// src/context/OverlayContext.jsx
// V4-OVERLAY-001 Slice 1 — route-backed overlays (design V102 §1, Architecture A).
// Navigate carrying state:{ background: location }; App renders the PAGE tree at
// `background ?? location` and an OVERLAY tree at the REAL location when a background exists.
// This context is the single source of the "effective page location" so App-level chrome
// (TopChrome/TodayBand/BottomNav/CritterArrivalController) follows the BACKGROUND, not the
// overlay URL (§2). Entirely inert when OVERLAY_ROUTES_ENABLED is false: no background is ever
// set, the overlay tree never renders, and every helper degrades to plain navigate/Link.
import React, { createContext, useContext, useMemo, useCallback } from 'react'
import { useLocation, useNavigate, Link } from 'react-router-dom'
import { OVERLAY_ROUTES_ENABLED } from '../lib/featureFlags.js'

const OverlayContext = createContext(null)

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

// A background is honored only if the flag is on AND it looks like a real location. Guards the
// "stale background across reload/deploy" trap (§V102 failure mode b): an unparseable/legacy value
// degrades to full-page (background=undefined) instead of rendering a broken overlay tree.
function validBackground(bg) {
  return bg && typeof bg === 'object' && typeof bg.pathname === 'string' ? bg : undefined
}

export function OverlayProvider({ children }) {
  const location = useLocation()
  const background = OVERLAY_ROUTES_ENABLED ? validBackground(location.state?.background) : undefined

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
      navigate(to, { ...opts, state: { ...opts.state, background: location } })
    },
    [navigate, location]
  )
}

// Declarative equivalent of useOverlayNavigate. Flag off -> a plain <Link>, same DOM/props.
export function OverlayLink({ to, state, children, ...rest }) {
  const location = useLocation()
  const linkState = OVERLAY_ROUTES_ENABLED ? { ...state, background: location } : state
  return (
    <Link to={to} state={linkState} {...rest}>
      {children}
    </Link>
  )
}

// Dismiss (§4): NEVER bare navigate(-1) (history.back() at idx 0 is a no-op — the overlay would
// stick open). Replace to the background URL (immune to history index), else /today. `replace`
// avoids growing history. Resilient outside a provider (useContext, not useOverlay) so overlay
// route content (LogMany "Done") can call it in isolated unit tests that render without a provider —
// there background is simply undefined and it falls back to /today (same as flag-off / no overlay).
export function useOverlayDismiss() {
  const navigate = useNavigate()
  const ctx = useContext(OverlayContext)
  const background = ctx ? ctx.background : undefined
  return useCallback(() => {
    if (background) navigate(background.pathname + background.search, { replace: true })
    else navigate('/today', { replace: true })
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
