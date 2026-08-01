// useCachedFetch — V4-IMGCACHE-001 D-1 hook tests. Covers the React integration: SWR cached-paint on
// revisit, N-mounts→1 dedup, the null-identity security guard (no cache under an absent sub), the
// identity-flip isolation (a sub change without remount can NEVER read the prior sub's cache — the
// test a browser smoke can't reproduce, since real sign-in is a full-page OAuth reload), and the
// flag-OFF plain-fetch passthrough.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor, act } from '@testing-library/react'
import React from 'react'

const { fetchSpy, authState, flagState } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  authState: { user: { id: 'userA' } },
  flagState: { on: true },
}))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy, getToken: () => Promise.resolve('t') }) }))
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => authState }))
vi.mock('../lib/featureFlags.js', () => ({ get IMAGE_LIST_CACHE_ENABLED() { return flagState.on } }))

import { useCachedFetch } from '../hooks/useCachedFetch.js'
import { __resetDataCache, peek } from '../lib/dataCache.js'

beforeEach(() => { fetchSpy.mockReset(); __resetDataCache(); authState.user = { id: 'userA' }; flagState.on = true })

function Probe({ path }) {
  const { data, loading, error, isValidating } = useCachedFetch(path)
  return (
    <div>
      <span data-testid="ids">{(data ?? []).map((p) => p.id).join(',')}</span>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="validating">{String(isValidating)}</span>
      <span data-testid="error">{error ? 'err' : ''}</span>
    </div>
  )
}
const ids = (c) => c.querySelector('[data-testid="ids"]').textContent
const loading = (c) => c.querySelector('[data-testid="loading"]').textContent

describe('useCachedFetch — SWR', () => {
  it('cold mount: loading then data', async () => {
    fetchSpy.mockResolvedValue([{ id: 'a' }, { id: 'b' }])
    const { container } = render(<Probe path="/api/photos" />)
    expect(loading(container)).toBe('true')
    await waitFor(() => expect(ids(container)).toBe('a,b'))
    expect(fetchSpy).toHaveBeenCalledWith('/api/photos')
  })

  it('revisit paints from cache on first render (no loading) and revalidates', async () => {
    fetchSpy.mockResolvedValue([{ id: 'a' }])
    const first = render(<Probe path="/api/photos" />)
    await waitFor(() => expect(ids(first.container)).toBe('a'))
    first.unmount()
    // remount the same identity+path
    const second = render(<Probe path="/api/photos" />)
    expect(loading(second.container)).toBe('false')            // instant cache paint, no spinner
    expect(ids(second.container)).toBe('a')
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2))   // background revalidate on mount
  })

  it('two instances of one path share one fetch (dedup)', async () => {
    fetchSpy.mockResolvedValue([{ id: 'a' }])
    const { container } = render(<div><Probe path="/api/photos" /><Probe path="/api/photos" /></div>)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
    container.querySelectorAll('[data-testid="ids"]').forEach((n) => expect(n.textContent).toBe('a'))
  })
})

describe('useCachedFetch — identity security', () => {
  it('no sub: plain-fetches (passthrough) but writes NO cache; the identity path takes over once the sub loads', async () => {
    authState.user = null
    fetchSpy.mockResolvedValue([{ id: 'a' }])
    const { container, rerender } = render(<Probe path="/api/photos" />)
    await waitFor(() => expect(ids(container)).toBe('a'))       // plain fetch renders (byte-identical to today)
    expect(peek('userA|/api/photos')).toBe(null)               // NOTHING cached under an absent sub
    authState.user = { id: 'userA' }
    rerender(<Probe path="/api/photos" />)
    await waitFor(() => expect(peek('userA|/api/photos')?.status).toBe('value'))   // now cached under the sub
    expect(ids(container)).toBe('a')
  })

  it('an identity flip WITHOUT remount can never read the prior sub cache', async () => {
    fetchSpy.mockResolvedValueOnce([{ id: 'a1' }]).mockResolvedValueOnce([{ id: 'b1' }])
    const { container, rerender } = render(<Probe path="/api/photos" />)
    await waitFor(() => expect(ids(container)).toBe('a1'))     // userA's data
    authState.user = { id: 'userB' }                           // soft identity switch, same heap
    rerender(<Probe path="/api/photos" />)
    await waitFor(() => expect(ids(container)).toBe('b1'))     // userB fetches fresh under its own key
    expect(ids(container)).not.toContain('a1')                 // never A's cached list
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})

describe('useCachedFetch — flag OFF (rollback passthrough)', () => {
  it('flag OFF: plain fetch every mount, no cache reuse, no cache entry written', async () => {
    flagState.on = false
    fetchSpy.mockResolvedValue([{ id: 'a' }])
    const first = render(<Probe path="/api/photos" />)
    await waitFor(() => expect(ids(first.container)).toBe('a'))
    first.unmount()
    const second = render(<Probe path="/api/photos" />)
    await waitFor(() => expect(ids(second.container)).toBe('a'))
    expect(fetchSpy).toHaveBeenCalledTimes(2)                  // every mount fetches (no cache)
    expect(peek('userA|/api/photos')).toBe(null)              // store untouched
  })
})

// SW-STALEAPI-001 — `stale` must reach the UI layer. The correctness half (never advancing the
// freshness clock) lives in dataCache and is tested there; this pins that the flag is READABLE by a
// surface, which is what makes "you're looking at offline data" renderable at all.
function StaleProbe({ path }) {
  const { stale, loading } = useCachedFetch(path)
  return (
    <div>
      <span data-testid="stale">{String(stale)}</span>
      <span data-testid="sloading">{String(loading)}</span>
    </div>
  )
}
const staleOf = (c) => c.querySelector('[data-testid="stale"]').textContent

describe('SW-STALEAPI-001: stale reaches the consumer', () => {
  it('is false on a normal network-served read', async () => {
    fetchSpy.mockResolvedValue([{ id: 'a' }])
    const { container } = render(<StaleProbe path="/api/photos" />)
    await waitFor(() => expect(container.querySelector('[data-testid="sloading"]').textContent).toBe('false'))
    expect(staleOf(container)).toBe('false')
  })

  it('turns true once a cache-served response is committed', async () => {
    const marked = [{ id: 'a' }]
    Object.defineProperty(marked, Symbol.for('garden-app.fromCache'), { value: true, enumerable: false })
    fetchSpy.mockResolvedValue(marked)
    const { container } = render(<StaleProbe path="/api/photos" />)
    await waitFor(() => expect(staleOf(container)).toBe('true'))
  })

  it('is false in the flag-OFF plain-fetch passthrough', async () => {
    flagState.on = false
    fetchSpy.mockResolvedValue([{ id: 'a' }])
    const { container } = render(<StaleProbe path="/api/photos" />)
    await waitFor(() => expect(container.querySelector('[data-testid="sloading"]').textContent).toBe('false'))
    expect(staleOf(container)).toBe('false')
  })
})
