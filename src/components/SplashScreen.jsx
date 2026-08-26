import React, { useCallback, useEffect, useRef, useState } from 'react'
import { P } from '../lib/constants.js'

// V4-BRANDICON-001 — in-app welcome/splash overlay.
// Purpose: replace the blank cold-start flash with a branded cream screen showing
// the locked garden-arbor illustration (public/splash.svg). NOT the OS splash
// (Android auto-composes name+bg+icon; iOS startup PNGs are a separate later scope).
// Behavior: shows once per browser session (sessionStorage flag) on cold start,
// tap-to-dismiss, honors prefers-reduced-motion.
// Rendered as a sibling overlay in App so it covers login + all routes.
//
// V4-PERFTHEMEA-001 made this exit on READINESS (Clerk's isLoaded) rather than on a timer, because
// App.jsx's `Protected` returned null until then: the splash was leaving ~850ms before there was
// anything behind it, and on a WARM session it never rendered at all and the full 3.4s was raw
// white. The premise was correct for the app as it stood — a fixed-duration brand moment was doing
// duty as a loading state because nothing else could.
//
// V4-PERFCLERK-001 C — THE PREMISE NO LONGER HOLDS, SO THE AUTH COUPLING IS GONE.
// `Protected` now renders an identity-free skeleton instead of null, and the shell (header, nav
// frame, content slot) paints on React's FIRST COMMIT. There is therefore something behind this
// overlay from the moment it mounts, and holding it until isLoaded would spend the ~2.5s Clerk
// window showing an illustration on top of a ready shell — the exact inversion of the goal.
// So the exit condition is the brand hold again, and this is a brand moment again, not a gate.
//
// Two consequences, stated rather than buried:
//   • MAX_HOLD_MS is GONE, not relaxed. It existed so a wedged/offline Clerk could not trap the user
//     behind the brand screen. Removing the auth dependency eliminates that failure mode outright
//     rather than bounding it — a ceiling on a timer that cannot exceed HOLD_MS is a dead guard.
//   • A warm session (flag already set) now renders nothing at all and hands straight to the shell.
//     Under the old model that path was the 3.4s-of-white case; under this one it is the fast path.

// V4-PERFSPLASH-001 — the brand hold is cut from 1720ms to 500ms (Dave, 2026-08-26: "cut it to
// about half a second"). Nothing structural changes: same timer, same once-per-session flag, same
// reduced-motion branch. Only the two durations move.
// Why the split is 320/180 rather than an even one: this overlay is `position:fixed; inset:0` and
// takes pointer events for its WHOLE life, so the fade is not free screen-dressing — it is a window
// in which the shell is visibly ready and still swallows taps (a tap at 90% faded hits `dismiss`,
// which early-returns on exitingRef). So the fade gets the smaller share. 180ms is still a dissolve
// rather than a cut: ~11 frames at 60Hz, just under the ~195ms Material uses for a full-screen
// surface LEAVING, and the handoff underneath is cream-on-cream so the only thing actually
// dissolving is the arbor mark, not a background luminance step.
const FLAG = 'gah_splash_shown'
const HOLD_MS = 320
const FADE_MS = 180

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
  // The brand moment is owed at most once per session. Captured ONCE at mount: reading
  // sessionStorage on later renders would see the flag this component itself just wrote.
  const [brandDue] = useState(() => !alreadyShown())
  const [visible, setVisible] = useState(() => brandDue)
  const [fading, setFading] = useState(false)
  const reduced = prefersReducedMotion()

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
    const hold = setTimeout(beginExit, HOLD_MS)
    return () => clearTimeout(hold)
  }, [visible, beginExit])

  if (!visible) return null

  // Tap-to-dismiss is live again. It was made inert while auth loaded because dismissing would have
  // revealed the blank this was covering; the shell underneath is now a rendered skeleton, so an
  // impatient tap reveals structure rather than nothing.
  const dismiss = () => beginExit()

  return (
    <div
      role="img"
      aria-label="Gardens at Home — welcome"
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
