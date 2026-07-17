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
// avoids growing history.
export function useOverlayDismiss() {
  const navigate = useNavigate()
  const { background } = useOverlay()
  return useCallback(() => {
    if (background) navigate(background.pathname + background.search, { replace: true })
    else navigate('/today', { replace: true })
  }, [navigate, background])
}
