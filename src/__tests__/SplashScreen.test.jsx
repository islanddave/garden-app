import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import SplashScreen from '../components/SplashScreen.jsx'

beforeEach(() => {
  vi.useFakeTimers()
  try { sessionStorage.clear() } catch { /* noop */ }
})
afterEach(() => { vi.useRealTimers() })

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
    act(() => { vi.advanceTimersByTime(1400 + 320 + 10) })
    expect(screen.queryByRole('img', { name: /welcome/i })).toBeNull()
  })
})
