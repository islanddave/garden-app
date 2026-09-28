// BUG-GARDENSPOTCREEP-001 — useMembers serves the household from the app's SWR store (useCachedFetch/dataCache).
//
// Uncached, every mount started with members = [] and the household landed a round trip later. On Garden the
// caretaker row renders above the list only once the household has two members, so it appeared a round trip
// after Garden had restored its spot, and scroll anchoring moved the spot one row (64px) down the list on every
// Today → Garden round trip. The cure is the first render: a return must paint the household it had last time.
//
// The CACHED-mode assertions use a request that HANGS FOREVER as the discriminator (Garden.cached.test.jsx's
// rule): a second mount showing the household with its own request still on the wire can only have read it from
// the cache. The identity mock supplies `user` (a Clerk sub), which is what puts useCachedFetch in CACHED mode;
// `user: null` is PLAIN — the no-sub path, which must stay a plain fetch that caches nothing.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

const { fetchSpy, identity } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  identity: { current: { user: { id: 'sub-A' }, profile: null, loading: false } },
}))
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: vi.fn(async () => 'tok') }),
  apiFetch: (...a) => fetchSpy(...a),
}))
vi.mock('../context/AuthContext.jsx', () => ({
  useAuthOptional: () => identity.current,
  useAuth: () => identity.current,
}))

import { useMembers } from '../hooks/useMembers.js'
import * as cache from '../lib/dataCache.js'
import { IMAGE_LIST_CACHE_ENABLED } from '../lib/featureFlags.js'

const PATH = '/api/members'
const DAVE = { id: 'sub-A', display_name: 'Dave N' }
const JEN = { id: 'user_jen', display_name: 'Jen' }
const hang = () => new Promise(() => {})

beforeEach(() => {
  cache.__resetDataCache()
  fetchSpy.mockReset()
  identity.current = { user: { id: 'sub-A' }, profile: null, loading: false }
})

// Mount, record every render's result, and wait until the household has landed (or failed).
async function mountSettled() {
  const hook = renderHook(() => useMembers())
  await waitFor(() => expect(hook.result.current.loading).toBe(false))
  return hook
}

describe('useMembers — CACHED (a signed-in sub, IMAGE_LIST_CACHE_ENABLED)', () => {
  it('the flag under test is on, or every assertion in this block is vacuous', () => {
    expect(IMAGE_LIST_CACHE_ENABLED).toBe(true)
  })

  it('a first mount: loading until the household lands, then members from the route\'s { members }', async () => {
    fetchSpy.mockResolvedValue({ members: [DAVE, JEN] })
    const hook = renderHook(() => useMembers())
    expect(hook.result.current).toMatchObject({ members: [], loading: true, error: null })
    await waitFor(() => expect(hook.result.current.loading).toBe(false))
    expect(hook.result.current.members).toEqual([DAVE, JEN])
    expect(fetchSpy).toHaveBeenCalledWith(PATH)
    expect(cache.peek(cache.keyFor('sub-A', PATH))?.data).toEqual({ members: [DAVE, JEN] })
  })

  it('a SECOND mount paints the household on its FIRST render, loading false — with its own request hanging', async () => {
    fetchSpy.mockResolvedValue({ members: [DAVE, JEN] })
    ;(await mountSettled()).unmount()
    fetchSpy.mockReset()
    fetchSpy.mockImplementation(hang)
    const renders = []
    renderHook(() => { const r = useMembers(); renders.push(r); return r })
    expect(renders[0]).toMatchObject({ members: [DAVE, JEN], loading: false, error: null })
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(PATH))   // and it still revalidates, every mount
  })

  it('a household that changed is adopted by that revalidate', async () => {
    fetchSpy.mockResolvedValue({ members: [DAVE] })
    ;(await mountSettled()).unmount()
    fetchSpy.mockResolvedValue({ members: [DAVE, JEN] })
    const hook = renderHook(() => useMembers())
    expect(hook.result.current.members).toEqual([DAVE])           // last time's, on the first render
    await waitFor(() => expect(hook.result.current.members).toEqual([DAVE, JEN]))
  })

  it('a revalidate that fails keeps the cached household with error null (the store\'s rule: only a COLD failure surfaces)', async () => {
    fetchSpy.mockResolvedValue({ members: [DAVE, JEN] })
    ;(await mountSettled()).unmount()
    fetchSpy.mockRejectedValue(new Error('offline'))
    const hook = renderHook(() => useMembers())
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
    await act(async () => {})
    expect(hook.result.current).toMatchObject({ members: [DAVE, JEN], loading: false, error: null })
  })

  it('a COLD failure is a string: the error\'s message, or "Failed to load caretakers" when it has none', async () => {
    fetchSpy.mockRejectedValue(new Error('Clerk said no'))
    let hook = await mountSettled()
    expect(hook.result.current).toMatchObject({ members: [], loading: false, error: 'Clerk said no' })
    hook.unmount()
    cache.__resetDataCache()
    fetchSpy.mockRejectedValue({})
    hook = await mountSettled()
    expect(hook.result.current.error).toBe('Failed to load caretakers')
  })

  it('reload refetches, and the answer is adopted', async () => {
    fetchSpy.mockResolvedValue({ members: [DAVE] })
    const hook = await mountSettled()
    fetchSpy.mockResolvedValue({ members: [DAVE, JEN] })
    await act(async () => { hook.result.current.reload() })
    await waitFor(() => expect(hook.result.current.members).toEqual([DAVE, JEN]))
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  // The store keeps a revalidate's prior data ref only for arrays, so this route's { members } object is a new ref on
  // every revalidate. Keyed on content, the list is not: memos over it (Garden's lens options, its caretaker map,
  // Findings') do not recompute when nothing changed. Each answer here is a FRESH object, as a real response is.
  it('a revalidate returning the SAME household keeps the same members array (the store did commit a new object)', async () => {
    fetchSpy.mockImplementation(async () => ({ members: [{ ...DAVE }, { ...JEN }] }))
    const hook = await mountSettled()
    const first = hook.result.current.members
    const firstData = cache.peek(cache.keyFor('sub-A', PATH)).data
    await act(async () => { hook.result.current.reload() })
    await waitFor(() => expect(cache.peek(cache.keyFor('sub-A', PATH)).data).not.toBe(firstData))
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(hook.result.current.members).toBe(first)
  })

  it('a revalidate returning a DIFFERENT household is a new array with the new members', async () => {
    fetchSpy.mockImplementation(async () => ({ members: [{ ...DAVE }, { ...JEN }] }))
    const hook = await mountSettled()
    const first = hook.result.current.members
    fetchSpy.mockImplementation(async () => ({ members: [{ ...DAVE }] }))
    await act(async () => { hook.result.current.reload() })
    await waitFor(() => expect(hook.result.current.members).toEqual([DAVE]))
    expect(hook.result.current.members).not.toBe(first)
  })

  it('identity-scoped: a different sub never reads the first sub\'s household', async () => {
    fetchSpy.mockResolvedValue({ members: [DAVE, JEN] })
    ;(await mountSettled()).unmount()
    identity.current = { user: { id: 'sub-B' }, profile: null, loading: false }
    fetchSpy.mockImplementation(hang)
    const hook = renderHook(() => useMembers())
    expect(hook.result.current).toMatchObject({ members: [], loading: true })
  })

  it('a body with no members array reads as an empty household, as before', async () => {
    fetchSpy.mockResolvedValue([])
    expect((await mountSettled()).result.current.members).toEqual([])
  })
})

describe('useMembers — PLAIN (no sub: no AuthProvider, a signed-out moment) is unchanged', () => {
  beforeEach(() => { identity.current = { user: null, profile: null, loading: false } })

  it('a plain fetch on mount that writes NO cache entry', async () => {
    fetchSpy.mockResolvedValue({ members: [DAVE, JEN] })
    const hook = renderHook(() => useMembers())
    expect(hook.result.current).toMatchObject({ members: [], loading: true, error: null })
    await waitFor(() => expect(hook.result.current.members).toEqual([DAVE, JEN]))
    expect(hook.result.current.loading).toBe(false)
    for (const sub of [null, undefined, 'null', 'undefined']) expect(cache.peek(cache.keyFor(sub, PATH))).toBeNull()
  })

  it('every mount fetches again: nothing was remembered', async () => {
    fetchSpy.mockResolvedValue({ members: [DAVE, JEN] })
    ;(await mountSettled()).unmount()
    fetchSpy.mockImplementation(hang)
    const hook = renderHook(() => useMembers())
    expect(hook.result.current).toMatchObject({ members: [], loading: true })
  })

  it('a failure is a string, and reload refetches', async () => {
    fetchSpy.mockRejectedValue(new Error('offline'))
    const hook = await mountSettled()
    expect(hook.result.current.error).toBe('offline')
    fetchSpy.mockResolvedValue({ members: [DAVE] })
    await act(async () => { hook.result.current.reload() })
    await waitFor(() => expect(hook.result.current.members).toEqual([DAVE]))
    expect(hook.result.current.error).toBeNull()
  })
})
