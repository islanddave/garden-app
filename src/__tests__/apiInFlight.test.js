// BUG-DETAILPAGESCARRYSCROLL-001 (qa2-scrollmanager-confirm NEW-1) — useApiFetch().fetch counts its request as in
// flight from the CALL, the wait for the Clerk token included (src/lib/netActivity.js). The page-scroll manager's
// out-of-reach stop reads "nothing in flight" as "the page has settled"; before this, a Back whose first GET was
// still waiting for a cold token looked settled on its loading shell and gave the place up (real Chrome, a 1.2-1.5 s
// token: 9 of 9 lost). gate:page-scroll's zones-slowtoken flow is the real-browser pin; this is the unit one.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useApiFetch } from '../lib/api.js'
import { requestsInFlight, __resetNetActivity } from '../lib/netActivity.js'

let clerkGetToken
vi.mock('@clerk/react', () => ({ useAuth: () => ({ getToken: (...a) => clerkGetToken(...a) }) }))

const okJson = (body = '[]') => new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } })

describe('useApiFetch: a request is in flight from the call, the token wait included', () => {
  beforeEach(() => { __resetNetActivity() })
  afterEach(() => { vi.unstubAllGlobals(); __resetNetActivity() })

  it('counts while the token is still being fetched, and stops once the response is in', async () => {
    let giveToken
    clerkGetToken = vi.fn(() => new Promise((resolve) => { giveToken = resolve }))
    const fetchSpy = vi.fn(async () => okJson('[{"id":1}]'))
    vi.stubGlobal('fetch', fetchSpy)
    const { result } = renderHook(() => useApiFetch())

    const pending = result.current.fetch('/api/locations')
    expect(fetchSpy).toHaveBeenCalledTimes(0)       // still waiting for the token…
    expect(requestsInFlight()).toBe(1)              // …and already counted
    giveToken('tok_live')
    await expect(pending).resolves.toEqual([{ id: 1 }])
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(requestsInFlight()).toBe(0)
  })

  it('stops counting when no token comes and no request is sent', async () => {
    clerkGetToken = vi.fn(async () => null)
    const fetchSpy = vi.fn(async () => okJson())
    vi.stubGlobal('fetch', fetchSpy)
    const { result } = renderHook(() => useApiFetch())

    const pending = result.current.fetch('/api/locations')
    expect(requestsInFlight()).toBe(1)
    await expect(pending).rejects.toMatchObject({ status: 0 })
    expect(fetchSpy).toHaveBeenCalledTimes(0)
    expect(requestsInFlight()).toBe(0)
  })

  it('counts through the 401 re-mint and replay, and ends at 0', async () => {
    clerkGetToken = vi.fn(async (opts) => (opts && opts.skipCache ? 'tok_fresh' : 'tok_stale'))
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(okJson('{"id":"p1"}'))
    vi.stubGlobal('fetch', fetchSpy)
    const { result } = renderHook(() => useApiFetch())

    const pending = result.current.fetch('/api/plants/p1')
    expect(requestsInFlight()).toBe(1)
    await expect(pending).resolves.toEqual({ id: 'p1' })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(requestsInFlight()).toBe(0)
  })
})
