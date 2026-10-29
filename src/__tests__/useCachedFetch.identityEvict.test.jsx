// BUG-TODAYSECTIONSSTUCK-001 — the identity eviction must not strand a reader that is already mounted.
// AuthContext evicts the data cache in a passive effect keyed on userId. A provider's passive effects run AFTER its
// children's, so when the page mounts in the same commit as userId resolves, the page's useCachedFetch has already
// registered and started its fetch before invalidateAll clears the store. Before the fix the hook stayed subscribed to
// the evicted entry, nothing fetched for the fresh one, and `loading` stayed true until a remount. Today's ready point
// waits on /api/plants + /api/locations settling, so every section below the weather card never appeared. The Parent
// below mirrors AuthContext's effect order; the identity-flip isolation tests stay in useCachedFetch.test.jsx.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor, act } from '@testing-library/react'
import React, { useEffect } from 'react'

const { fetchSpy, authState } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  authState: { user: { id: 'userA' } },
}))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy, getToken: () => Promise.resolve('t') }) }))
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => authState }))

import { useCachedFetch } from '../hooks/useCachedFetch.js'
import { __resetDataCache, invalidateAll } from '../lib/dataCache.js'

beforeEach(() => { fetchSpy.mockReset(); __resetDataCache(); authState.user = { id: 'userA' } })

function EvictOnIdentity({ uid, children }) {
  useEffect(() => { invalidateAll() }, [uid])
  return children
}
function Probe({ path }) {
  const { data, loading } = useCachedFetch(path)
  return (
    <div>
      <span data-testid="ids">{(data ?? []).map((p) => p.id).join(',')}</span>
      <span data-testid="loading">{String(loading)}</span>
    </div>
  )
}
const ids = (c) => c.querySelector('[data-testid="ids"]').textContent
const loading = (c) => c.querySelector('[data-testid="loading"]').textContent
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }

describe('useCachedFetch — identity eviction after the reader mounted', () => {
  it('a reader mounted in the eviction commit still settles with data', async () => {
    fetchSpy.mockResolvedValue([{ id: 'a' }, { id: 'b' }])
    const { container } = render(<EvictOnIdentity uid="userA"><Probe path="/api/plants" /></EvictOnIdentity>)
    await waitFor(() => expect(loading(container)).toBe('false'))
    expect(ids(container)).toBe('a,b')
  })

  it('the sign-in transition (no user, then a user, one commit) settles too', async () => {
    authState.user = null
    fetchSpy.mockResolvedValue([{ id: 'p1' }])
    const { container, rerender } = render(<EvictOnIdentity uid={null}><Probe path="/api/plants" /></EvictOnIdentity>)
    await waitFor(() => expect(loading(container)).toBe('false'))
    authState.user = { id: 'userA' }
    fetchSpy.mockResolvedValue([{ id: 'p1' }, { id: 'p2' }])
    rerender(<EvictOnIdentity uid="userA"><Probe path="/api/plants" /></EvictOnIdentity>)
    await waitFor(() => expect(ids(container)).toBe('p1,p2'))
    expect(loading(container)).toBe('false')
  })

  it('a fetch started before the eviction never lands in the fresh entry; the fresh entry fetches for itself', async () => {
    const first = deferred()
    fetchSpy.mockReturnValueOnce(first.promise).mockResolvedValueOnce([{ id: 'fresh' }])
    const { container } = render(<EvictOnIdentity uid="userA"><Probe path="/api/plants" /></EvictOnIdentity>)
    await waitFor(() => expect(ids(container)).toBe('fresh'))
    await act(async () => { first.resolve([{ id: 'evicted' }]); await first.promise })
    expect(ids(container)).toBe('fresh')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('an eviction while a settled reader is mounted refetches it rather than leaving it loading', async () => {
    fetchSpy.mockResolvedValue([{ id: 'a' }])
    const { container } = render(<Probe path="/api/plants" />)
    await waitFor(() => expect(ids(container)).toBe('a'))
    fetchSpy.mockResolvedValue([{ id: 'a' }, { id: 'c' }])
    act(() => { invalidateAll() })
    await waitFor(() => expect(ids(container)).toBe('a,c'))
    expect(loading(container)).toBe('false')
  })
})
