import React, { useCallback, useEffect, useRef, useState } from 'react'
import { P } from '../lib/constants.js'
import { useAuthOptional } from '../context/AuthContext.jsx'

// V4-BRANDICON-001 — in-app welcome/splash overlay.
// Purpose: replace the blank cold-start flash with a branded cream screen showing
// the locked garden-arbor illustration (public/splash.svg). NOT the OS splash
// (Android auto-composes name+bg+icon; iOS startup PNGs are a separate later scope).
// Behavior: shows once per browser session (sessionStorage flag) on cold start,
// tap-to-dismiss, honors prefers-reduced-motion.
// Rendered as a sibling overlay in App so it covers login + all routes.
//
// V4-PERFTHEMEA-001 — IT NOW EXITS ON READINESS, NOT ON A TIMER.
// Measured on prod (Chrome @375px, resource timing, 2026-08-12): React mounts at t≈783ms and this
// component used to self-dismiss at t≈2520ms (HOLD_MS + FADE_MS), but App.jsx's `Protected` returns
// null until Clerk's isLoaded resolves — which the same trace put at t≈3376ms. So the splash left
// ~850ms before there was anything behind it, and on a WARM session (flag already set) it never
// rendered at all and the entire 3.4s was raw white. A fixed-duration brand moment was doing duty
// as a loading state.
//
// The model now has three terms, and keeping them distinct is the whole design:
//   • BRAND HOLD (HOLD_MS)   — a MINIMUM, once per session. Stops the illustration flashing past.
//   • READINESS (authLoading) — the real exit condition. There is nothing to reveal before it.
//   • CEILING (MAX_HOLD_MS)  — a wedged or offline Clerk must never trap the user behind a brand
//     screen with no in-app recovery; that would be strictly worse than the blank it replaced.
// Exit happens at max(brand hold, readiness), capped by the ceiling.

const FLAG = 'gah_splash_shown'
const HOLD_MS = 1400
const FADE_MS = 320
// Chosen against the measured cold boot (3.4s to isLoaded on a wired desktop; slower on Android
// cellular, which is the only device that matters here) with room to spare, so the ceiling only
// ever fires on a genuine failure rather than on a merely slow network.
const MAX_HOLD_MS = 8000

function alreadyShown() {
  try { return sessionStorage.getItem(FLAG) === '1' } catch { return false }
}
function markShown() {
  try { sessionStorage.setItem(FLAG, '1') } catch { /* private mode: show each cold start */ }
}
function prefersReducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

export default function SplashScreen() {
  // useAuthOptional, not useAuth: this renders inside AuthProvider in the real app, but its own
  // unit tests (and any future harness) mount it bare. The non-throwing selector reports
  // loading:false there, which collapses this component to its pre-V4-PERFTHEMEA-001 behaviour
  // exactly — that is the compatibility contract with SplashScreen.test.jsx.
  const { loading: authLoading } = useAuthOptional()

  // The brand moment is owed at most once per session. Captured ONCE at mount: reading
  // sessionStorage on later renders would see the flag this component itself just wrote.
  const [brandDue] = useState(() => !alreadyShown())
  const [visible, setVisible] = useState(() => brandDue || authLoading)
  // `held` = the brand hold is satisfied. A warm session never owed one, so it starts satisfied and
  // such a re-entry exits the moment auth resolves rather than re-serving 1400ms of illustration.
  const [held, setHeld] = useState(() => !brandDue)
  const [fading, setFading] = useState(false)
  const reduced = prefersReducedMotion()

  // Read inside timer callbacks, so the callbacks are not re-armed on every auth tick.
  const authLoadingRef = useRef(authLoading); authLoadingRef.current = authLoading
  const exitingRef = useRef(false)

  // Runs SYNCHRONOUSLY from inside a timer callback on the hold path. That placement is load-
  // bearing under fake timers: scheduling the fade timeout from within the timer callback means a
  // single advanceTimersByTime() spanning hold+fade sees it, which is how the pre-existing
  // auto-dismiss test measures the exit. Scheduling it from an effect instead would defer past
  // act()'s flush and the exit would never be observed.
  const beginExit = useCallback(() => {
    if (exitingRef.current) return
    exitingRef.current = true
    if (reduced) { setVisible(false); return }
    setFading(true)
    setTimeout(() => setVisible(false), FADE_MS)
  }, [reduced])

  useEffect(() => {
    if (!visible) return
    markShown()
    const hold = setTimeout(() => {
      // Brand hold done. Exit only if the app is ready; otherwise record that the hold is spent and
      // let the readiness effect below take the exit the moment auth resolves.
      if (authLoadingRef.current) { setHeld(true); return }
      beginExit()
    }, HOLD_MS)
    const ceiling = setTimeout(beginExit, MAX_HOLD_MS)
    return () => { clearTimeout(hold); clearTimeout(ceiling) }
  }, [visible, beginExit])

  // Readiness exit: auth resolved after the brand hold had already elapsed.
  useEffect(() => {
    if (!visible || !held || authLoading) return
    beginExit()
  }, [visible, held, authLoading, beginExit])

  if (!visible) return null

  // Tap-to-dismiss is INERT while auth is loading. Pre-change a tap always dismissed, which was
  // right when this was purely a brand moment; now that it is also the boot cover, honouring the
  // tap would reveal the blank screen it exists to hide. The ceiling above is the escape hatch.
  const dismiss = () => { if (!authLoading) beginExit() }

  return (
    <div
      role="img"
      aria-label="Gardens at Home — welcome"
      aria-busy={authLoading || undefined}
      onClick={dismiss}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2147483000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: P.cream,
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
        opacity: fading ? 0 : 1,
        transition: reduced ? 'none' : `opacity ${FADE_MS}ms ease`,
        cursor: 'pointer',
      }}
    >
      <img
        src="/splash.svg"
        alt=""
        aria-hidden="true"
        style={{
          width: 'min(88vw, 360px)',
          height: 'auto',
          maxHeight: '92vh',
          objectFit: 'contain',
          userSelect: 'none',
          pointerEvents: 'none',
        }}
      />
    </div>
  )
}
