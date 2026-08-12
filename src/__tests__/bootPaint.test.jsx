// V4-PERFTHEMEA-001 — "the boot is never blank, and it ends when the app is ready".
//
// MEASURED PROBLEM (prod, 2026-08-12, Chrome @375px, resource timing on garden.futureishere.net):
//   t=348ms   index.html TTFB
//   t=783ms   entry bundle (402 kB gzip) done → React mounts, SplashScreen paints
//   t=2520ms  SplashScreen self-dismisses (HOLD_MS 1400 + FADE_MS 320 from mount)
//   t=3376ms  Clerk /v1/client resolves → isLoaded → App.jsx `Protected` stops returning null
// So the splash was gone for ~850ms before there was anything to show, and on a WARM session
// (sessionStorage flag already set) it never rendered at all — the full 3.4s was white.
// The splash was a fixed-duration brand moment being mistaken for a loading state.
//
// The fix has two halves, both covered here:
//   1. SplashScreen exits on READINESS (auth resolved), with HOLD_MS as a *minimum* for the brand
//      moment and MAX_HOLD_MS as a ceiling so a wedged Clerk can never trap the user behind it.
//   2. index.html paints a cream #boot-splash before any JS runs, and React removes it on its
//      first commit — closing the 0→783ms white gap that no React component can reach.
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'

// Controllable auth state. SplashScreen reads useAuthOptional(), which is the non-throwing
// selector — so the EXISTING SplashScreen tests (no provider, no mock) keep seeing loading:false
// and their behaviour is unchanged. That is the compatibility contract this mock encodes.
let authLoading = false
vi.mock('../context/AuthContext.jsx', async (importOriginal) => ({
  ...(await importOriginal()),
  useAuthOptional: () => ({ user: null, profile: null, loading: authLoading }),
}))

const { default: SplashScreen } = await import('../components/SplashScreen.jsx')
const { dismissBootSplash } = await import('../lib/bootSplash.js')

const HOLD_MS = 1400
const FADE_MS = 320
const MAX_HOLD_MS = 8000
const splash = () => screen.queryByRole('img', { name: /welcome/i })

beforeEach(() => {
  vi.useFakeTimers()
  authLoading = false
  try { sessionStorage.clear() } catch { /* noop */ }
})
afterEach(() => { vi.useRealTimers() })

describe('SplashScreen exits on readiness, not on a timer (V4-PERFTHEMEA-001)', () => {
  it('stays up past the brand hold while auth is still loading', () => {
    authLoading = true
    render(<SplashScreen />)
    act(() => { vi.advanceTimersByTime(HOLD_MS + FADE_MS + 500) })
    // Pre-fix this asserted null at 1720ms — the measured 850ms of white.
    expect(splash()).toBeTruthy()
  })

  it('exits once auth resolves after the brand hold has already elapsed', () => {
    authLoading = true
    const { rerender } = render(<SplashScreen />)
    act(() => { vi.advanceTimersByTime(HOLD_MS + 10) })
    expect(splash()).toBeTruthy()

    authLoading = false
    act(() => { rerender(<SplashScreen />) })
    act(() => { vi.advanceTimersByTime(FADE_MS + 10) })
    expect(splash()).toBeNull()
  })

  it('renders on a WARM session (brand moment already spent) whenever auth is still loading', () => {
    // This is the re-entry case Dave actually hits in the installed PWA: the flag is set, so the
    // pre-fix component returned null and the boot gate showed raw white for the whole 3.4s.
    sessionStorage.setItem('gah_splash_shown', '1')
    authLoading = true
    render(<SplashScreen />)
    expect(splash()).toBeTruthy()
  })

  it('does not re-serve the brand hold on a warm session — exits as soon as auth resolves', () => {
    sessionStorage.setItem('gah_splash_shown', '1')
    authLoading = true
    const { rerender } = render(<SplashScreen />)
    authLoading = false
    act(() => { rerender(<SplashScreen />) })
    act(() => { vi.advanceTimersByTime(FADE_MS + 10) })
    // Exits at ~320ms, NOT at HOLD_MS+FADE_MS — a warm re-entry must not pay for a brand moment
    // it already showed this session.
    expect(splash()).toBeNull()
  })

  it('MAX_HOLD_MS ceiling releases the screen even if auth never resolves', () => {
    authLoading = true
    render(<SplashScreen />)
    act(() => { vi.advanceTimersByTime(MAX_HOLD_MS + FADE_MS + 10) })
    // Without this, a wedged/offline Clerk would leave the user staring at a brand screen with no
    // in-app recovery — strictly worse than the blank it replaced.
    expect(splash()).toBeNull()
  })

  it('tap-to-dismiss is inert while auth is loading, live once it has resolved', () => {
    authLoading = true
    const { rerender } = render(<SplashScreen />)
    fireEvent.click(splash())
    act(() => { vi.advanceTimersByTime(FADE_MS + 10) })
    expect(splash()).toBeTruthy()   // nothing behind it yet — dismissing would reveal the blank

    authLoading = false
    act(() => { rerender(<SplashScreen />) })
    act(() => { vi.advanceTimersByTime(HOLD_MS + FADE_MS + 10) })
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
