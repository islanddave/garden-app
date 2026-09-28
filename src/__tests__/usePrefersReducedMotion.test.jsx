// V5-TODAYREDESIGN-001 S2 — the shared, LIVE reduced-motion read (plan-v2 §5.11).
import { describe, it, expect, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion.js'

const original = window.matchMedia
afterEach(() => { window.matchMedia = original })

function fakeMedia(matches, { legacy = false } = {}) {
  const listeners = new Set()
  const mq = { matches, media: '(prefers-reduced-motion: reduce)' }
  if (legacy) { mq.addListener = (fn) => listeners.add(fn); mq.removeListener = (fn) => listeners.delete(fn) }
  else { mq.addEventListener = (_t, fn) => listeners.add(fn); mq.removeEventListener = (_t, fn) => listeners.delete(fn) }
  window.matchMedia = () => mq
  return { set(v) { mq.matches = v; for (const fn of [...listeners]) fn() }, listeners }
}

describe('usePrefersReducedMotion', () => {
  it('reads the setting and follows a change while mounted', () => {
    const m = fakeMedia(false)
    const { result, unmount } = renderHook(() => usePrefersReducedMotion())
    expect(result.current).toBe(false)
    act(() => m.set(true))
    expect(result.current).toBe(true)
    unmount()
    expect(m.listeners.size).toBe(0)
  })

  it('works with the legacy addListener API', () => {
    const m = fakeMedia(true, { legacy: true })
    const { result, unmount } = renderHook(() => usePrefersReducedMotion())
    expect(result.current).toBe(true)
    act(() => m.set(false))
    expect(result.current).toBe(false)
    unmount()
    expect(m.listeners.size).toBe(0)
  })

  it('no matchMedia reads as no preference', () => {
    window.matchMedia = undefined
    const { result } = renderHook(() => usePrefersReducedMotion())
    expect(result.current).toBe(false)
  })
})
