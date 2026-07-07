import React, { useEffect, useState } from 'react'
import { P } from '../lib/constants.js'

// V4-BRANDICON-001 — in-app welcome/splash overlay.
// Purpose: replace the blank cold-start flash with a branded cream screen showing
// the locked garden-arbor illustration (public/splash.svg). NOT the OS splash
// (Android auto-composes name+bg+icon; iOS startup PNGs are a separate later scope).
// Behavior: shows once per browser session (sessionStorage flag) on cold start,
// auto-dismisses after HOLD_MS, tap-to-dismiss, honors prefers-reduced-motion.
// Rendered as a sibling overlay in App so it covers login + all routes.

const FLAG = 'gah_splash_shown'
const HOLD_MS = 1400
const FADE_MS = 320

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
  const [visible, setVisible] = useState(() => !alreadyShown())
  const [fading, setFading] = useState(false)
  const reduced = prefersReducedMotion()

  useEffect(() => {
    if (!visible) return
    markShown()
    const timers = []
    const hold = setTimeout(() => {
      if (reduced) { setVisible(false); return }
      setFading(true)
      timers.push(setTimeout(() => setVisible(false), FADE_MS))
    }, HOLD_MS)
    timers.push(hold)
    return () => timers.forEach(clearTimeout)
  }, [visible, reduced])

  if (!visible) return null

  const dismiss = () => {
    if (reduced) { setVisible(false); return }
    setFading(true)
    setTimeout(() => setVisible(false), FADE_MS)
  }

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
