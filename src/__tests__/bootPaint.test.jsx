// V4-PERFTHEMEA-001 — "the boot is never blank".
//
// MEASURED PROBLEM (prod, 2026-08-12, Chrome @375px, resource timing on garden.futureishere.net):
//   t=348ms   index.html TTFB
//   t=783ms   entry bundle (402 kB gzip) done → React mounts, SplashScreen paints
//   t=2520ms  SplashScreen self-dismisses (HOLD_MS 1400 + FADE_MS 320 from mount — those were the
//             durations AT THAT MEASUREMENT; V4-PERFSPLASH-001 has since cut them to 320+180)
//   t=3376ms  Clerk /v1/client resolves → isLoaded → App.jsx `Protected` stops returning null
// So the splash was gone for ~850ms before there was anything to show, and on a WARM session
// (sessionStorage flag already set) it never rendered at all — the full 3.4s was white.
//
// V4-PERFTHEMEA-001's fix was to make the splash exit on READINESS (isLoaded), i.e. to promote the
// brand moment into the boot gate, because `Protected` returned null and there genuinely was nothing
// behind it.
//
// V4-PERFCLERK-001 C REMOVED THAT COUPLING, AND THIS FILE NOW ENCODES THE NEW CONTRACT.
// `Protected` renders an identity-free skeleton and the shell paints on React's first commit, so
// there IS something behind the splash from the moment it mounts. Holding it to isLoaded would spend
// the ~2.5s Clerk window covering a ready shell. The splash is a brand moment again; the SHELL is
// the loading state. The auth-coupled assertions that used to live here (readiness exit, the
// MAX_HOLD_MS ceiling, inert tap-to-dismiss) were guards on a mechanism that no longer exists —
// their replacement guards are in authRenderGate.test.jsx, which asserts the shell is up.
//
// What survives unchanged and is still covered here:
//   1. HOLD_MS is a real brand hold, and it is owed at most ONCE per session.
//   2. index.html paints a cream #boot-splash before any JS runs, and React removes it on its
//      first commit — closing the 0→783ms white gap that no React component can reach.
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'

const { default: SplashScreen } = await import('../components/SplashScreen.jsx')
const { dismissBootSplash } = await import('../lib/bootSplash.js')

const HOLD_MS = 320
const FADE_MS = 180
// The BUDGET, as opposed to the two mirrors above. Dave's call, 2026-08-26: "cut it to about half a
// second." Every duration assertion in this repo mirrors the source constants into a test file, so
// editing the source and its mirrors together is green all the way back to 1720ms — the decision
// itself is guarded by nothing. This is the ceiling; 600 rather than 500 so a 20ms rebalance
// between hold and fade is not a test change.
const BRAND_HOLD_BUDGET_MS = 600
const splash = () => screen.queryByRole('img', { name: /welcome/i })

beforeEach(() => {
  vi.useFakeTimers()
  try { sessionStorage.clear() } catch { /* noop */ }
})
afterEach(() => { vi.useRealTimers() })

describe('SplashScreen is a brand moment, NOT the boot gate (V4-PERFCLERK-001 C)', () => {
  it('reads NO auth state at all — the coupling is gone structurally, not merely unused', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const src = readFileSync(resolve(process.cwd(), 'src/components/SplashScreen.jsx'), 'utf8')
    // If this re-appears, the splash is back in front of the shell and Option C's perceived win is
    // silently gone while every other test still passes.
    expect(/^\s*import .*AuthContext/m.test(src)).toBe(false)
    expect(/useAuthOptional|authLoading/.test(src)).toBe(false)
  })

  it('holds for no more than the brand-hold budget — the shortening cannot be lockstepped away', async () => {
    // Read from SOURCE, not from the mirrors at the top of this file, for the reason stated there:
    // mirrors move with whatever the source says, so they cannot hold a ceiling.
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const src = readFileSync(resolve(process.cwd(), 'src/components/SplashScreen.jsx'), 'utf8')
    const num = (name) => {
      const m = src.match(new RegExp(`^const ${name} = (\\d+)$`, 'm'))
      // A regex that matched nothing would make every comparison below vacuous.
      expect(m, `could not read ${name} out of SplashScreen.jsx — this guard is measuring nothing`).toBeTruthy()
      return Number(m[1])
    }
    const hold = num('HOLD_MS'), fade = num('FADE_MS')
    expect(hold).toBeGreaterThan(0)
    expect(fade).toBeGreaterThan(0)
    expect(hold + fade).toBeLessThanOrEqual(BRAND_HOLD_BUDGET_MS)
    // ...and the mirrors this file asserts against are the source's real numbers, so the brackets
    // below are bracketing the shipped timer rather than a stale pair.
    expect([hold, fade]).toEqual([HOLD_MS, FADE_MS])
  })

  it('exits on the brand hold and does NOT wait for anything else', () => {
    render(<SplashScreen />)
    expect(splash()).toBeTruthy()
    act(() => { vi.advanceTimersByTime(HOLD_MS + FADE_MS + 10) })
    // Pre-change this stayed up until isLoaded — measured at t=3376ms, i.e. ~1.9s longer than this.
    expect(splash()).toBeNull()
  })

  it('is still up just BEFORE the hold elapses (the brand moment is real, not skipped)', () => {
    render(<SplashScreen />)
    act(() => { vi.advanceTimersByTime(HOLD_MS - 50) })
    expect(splash()).toBeTruthy()
  })

  it('a WARM session shows nothing and hands straight to the shell', () => {
    // The re-entry case Dave actually hits in the installed PWA. Under the old model this path was
    // the 3.4s-of-white case and the splash was pressed into service to cover it; the shell covers
    // it now, so re-serving a brand moment here would only delay the app.
    sessionStorage.setItem('gah_splash_shown', '1')
    const { container } = render(<SplashScreen />)
    expect(container.firstChild).toBeNull()
  })

  it('tap-to-dismiss is live — an impatient tap reveals the shell, not a blank', () => {
    render(<SplashScreen />)
    fireEvent.click(splash())
    act(() => { vi.advanceTimersByTime(FADE_MS + 10) })
    expect(splash()).toBeNull()
  })
})

describe('dismissBootSplash (V4-PERFTHEMEA-001)', () => {
  it('removes the pre-React #boot-splash element from the document', () => {
    const el = document.createElement('div')
    el.id = 'boot-splash'
    document.body.appendChild(el)
    expect(document.getElementById('boot-splash')).toBeTruthy()

    dismissBootSplash()

    // Left in place, this fixed/inset-0 overlay would cover the entire app forever.
    expect(document.getElementById('boot-splash')).toBeNull()
  })

  it('is idempotent and a no-op when the element was never rendered (unit tests, SSR)', () => {
    expect(() => { dismissBootSplash(); dismissBootSplash() }).not.toThrow()
  })
})
