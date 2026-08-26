import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import SplashScreen from '../components/SplashScreen.jsx'

// Mirrors of SplashScreen.jsx's constants (V4-PERFSPLASH-001: 320+180=500ms, was 1400+320=1720ms).
// Deliberately mirrored rather than exported-and-imported: the tests below bracket the real timer
// from BOTH sides, so if the source drifts from these one of the brackets goes red. Importing them
// would make every assertion self-fulfilling.
const HOLD_MS = 320
const FADE_MS = 180
// jsdom defines matchMedia on Window.prototype, so a stub lands as an OWN property and has to be
// deleted rather than reassigned — otherwise every later test in this file inherits reduced motion.
const REAL_MM = Object.getOwnPropertyDescriptor(window, 'matchMedia')

beforeEach(() => {
  vi.useFakeTimers()
  try { sessionStorage.clear() } catch { /* noop */ }
})
afterEach(() => {
  vi.useRealTimers()
  if (REAL_MM) Object.defineProperty(window, 'matchMedia', REAL_MM)
  else delete window.matchMedia
})

describe('SplashScreen', () => {
  it('renders the welcome overlay on first cold start and marks the session flag', () => {
    render(<SplashScreen />)
    expect(screen.getByRole('img', { name: /welcome/i })).toBeTruthy()
    expect(sessionStorage.getItem('gah_splash_shown')).toBe('1')
  })

  it('does not render again once shown this session', () => {
    sessionStorage.setItem('gah_splash_shown', '1')
    const { container } = render(<SplashScreen />)
    expect(container.firstChild).toBeNull()
  })

  it('auto-dismisses after the hold + fade window', () => {
    render(<SplashScreen />)
    expect(screen.queryByRole('img', { name: /welcome/i })).toBeTruthy()
    act(() => { vi.advanceTimersByTime(HOLD_MS + FADE_MS + 10) })
    expect(screen.queryByRole('img', { name: /welcome/i })).toBeNull()
  })

  it('is still up one tick before the fade starts — the hold is a real hold, not a skipped one', () => {
    // The lower bracket. Without it every duration assertion here passes for a splash that never
    // renders at all, and a hold shortened to 0 would look exactly like a hold shortened to 320.
    render(<SplashScreen />)
    act(() => { vi.advanceTimersByTime(HOLD_MS - 1) })
    expect(screen.queryByRole('img', { name: /welcome/i })).toBeTruthy()
  })

  it('fades for exactly as long as it stays mounted — the CSS duration matches the unmount timer', () => {
    // These two are the same number in the source and must stay that way. Too short a transition
    // finishes early and leaves a fully-transparent overlay still swallowing taps; too long a one
    // gets cut off mid-dissolve by the unmount. Both are invisible to a duration-only assertion.
    render(<SplashScreen />)
    const el = screen.getByRole('img', { name: /welcome/i })
    expect(el.style.transition).toBe(`opacity ${FADE_MS}ms ease`)
    expect(el.style.opacity).toBe('1')
    act(() => { vi.advanceTimersByTime(HOLD_MS + 1) })
    // Fading, but still mounted and still the thing under the user's thumb.
    expect(screen.getByRole('img', { name: /welcome/i }).style.opacity).toBe('0')
    act(() => { vi.advanceTimersByTime(FADE_MS + 10) })
    expect(screen.queryByRole('img', { name: /welcome/i })).toBeNull()
  })

  it('honours prefers-reduced-motion: no transition, and it leaves on the hold ALONE', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (q) => ({ matches: q === '(prefers-reduced-motion: reduce)', media: q, addEventListener() {}, removeEventListener() {} }),
    })
    render(<SplashScreen />)
    expect(screen.getByRole('img', { name: /welcome/i }).style.transition).toBe('none')
    // The reduced branch sets visible=false straight from the hold and never schedules FADE_MS, so
    // advancing the hold alone has to retire it. If the exit ever starts routing through the fade
    // timer again this goes red instead of merely taking 180ms longer than it claims to.
    act(() => { vi.advanceTimersByTime(HOLD_MS + 1) })
    expect(screen.queryByRole('img', { name: /welcome/i })).toBeNull()
  })
})
