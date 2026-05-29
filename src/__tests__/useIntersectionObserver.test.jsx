import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useIntersectionObserver, intersectionObserverAvailable } from '../hooks/useIntersectionObserver.js'

describe('useIntersectionObserver', () => {
  let observerCallbacks = []
  let disconnectSpy

  beforeEach(() => {
    observerCallbacks = []
    disconnectSpy = vi.fn()
    class MockIO {
      constructor(cb) { this.cb = cb; observerCallbacks.push(cb) }
      observe() {}
      unobserve() {}
      disconnect() { disconnectSpy() }
    }
    vi.stubGlobal('IntersectionObserver', MockIO)
  })

  afterEach(() => { vi.unstubAllGlobals() })

  it('returns isIntersecting=false initially', () => {
    const { result } = renderHook(() => useIntersectionObserver())
    expect(result.current.isIntersecting).toBe(false)
    expect(result.current.ref).toBeDefined()
  })

  it('detection helper agrees with stubbed env', () => {
    expect(intersectionObserverAvailable()).toBe(true)
    vi.unstubAllGlobals()
    // After unstub, the jsdom env may or may not provide it; just ensure helper doesn't throw.
    expect(typeof intersectionObserverAvailable()).toBe('boolean')
  })
})
