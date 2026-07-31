// V4-IMGCACHE-002 D-2 — boot-warm (B3), resume-revalidate (B5), refresh primitive (B4).
//
// The store-level behaviours are tested directly against dataCache (deterministic, no React), and the
// wiring is tested through the hook (listener registration + the flag gate + identity gating).
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { render, act, waitFor } from '@testing-library/react'
import React from 'react'
import * as cache from '../lib/dataCache.js'
import { useCacheLifecycle, useRefreshAll, RESUME_MIN_AGE_MS, BOOT_WARM_PATHS } from '../hooks/useCacheLifecycle.js'

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

let apiCalls
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: (p) => { apiCalls.push(p); return Promise.resolve([{ id: 'a', view_url: 'u1' }]) } }),
}))

beforeEach(() => { cache.__resetDataCache(); apiCalls = [] })
afterEach(() => { vi.useRealTimers() })

// ── B3 boot-warm ────────────────────────────────────────────────────────────────────────────────
describe('D-2 B3: warm()', () => {
  it('seeds a cold key so a later mount has data with no cold fetch', async () => {
    const p = cache.warm('u1|/api/photos', () => Promise.resolve([{ id: 'x' }]))
    expect(p).not.toBeNull()
    await flush()
    expect(cache.peek('u1|/api/photos').data).toEqual([{ id: 'x' }])
  })

  it('does NOT duplicate work when the key already has data', async () => {
    cache.warm('k', () => Promise.resolve([{ id: 'x' }]))
    await flush()
    let second = 0
    expect(cache.warm('k', () => { second++; return Promise.resolve([]) })).toBeNull()
    await flush()
    expect(second).toBe(0)
  })

  it('does NOT duplicate work when a fetch is already in flight', async () => {
    // The gate is created eagerly: revalidate() invokes the fetcher a microtask later, so a `release`
    // assigned inside the fetcher would still be undefined at the synchronous assertion below.
    let release
    const gate = new Promise((r) => { release = r })
    cache.warm('k', () => gate.then(() => [{ id: 'x' }]))
    let second = 0
    expect(cache.warm('k', () => { second++; return Promise.resolve([]) })).toBeNull()
    release(); await flush()
    expect(second).toBe(0)
  })

  it('a FAILED warm leaves no trace — the next real mount still gets a clean cold fetch', async () => {
    // The point of the invariant: an entry left in status:'error' would make the first visit to the
    // surface render an error state for a failure the user never triggered and cannot see the cause of.
    cache.warm('k', () => Promise.reject(new Error('offline at boot')))
    await flush()
    const snap = cache.peek('k')
    expect(snap.status).toBe('empty')
    expect(snap.error).toBeNull()
    expect(snap.data).toBeUndefined()

    // …and the key is still usable afterwards.
    cache.register('k', () => Promise.resolve([{ id: 'later' }]))
    cache.revalidate('k'); await flush()
    expect(cache.peek('k').data).toEqual([{ id: 'later' }])
  })

  it('a subscriber that arrives mid-warm is still notified after a failure', async () => {
    // Resetting the entry must not replace the entry OBJECT — subscribers hold a reference to it.
    let notified = 0
    cache.warm('k', () => Promise.reject(new Error('boom')))
    cache.subscribe('k', () => { notified++ })
    await flush()
    expect(notified).toBeGreaterThan(0)
    expect(cache.peek('k').status).toBe('empty')
  })
})

// ── B5 resume revalidate ────────────────────────────────────────────────────────────────────────
describe('D-2 B5: revalidateLive()', () => {
  async function seed(key, fetcher) {
    cache.subscribe(key, () => {})
    cache.register(key, fetcher)
    cache.revalidate(key)
    await flush()
  }

  it('revalidates watched keys and skips unwatched ones', async () => {
    let watched = 0, orphan = 0
    await seed('w', () => { watched++; return Promise.resolve([{ id: 'a' }]) })
    cache.register('o', () => { orphan++; return Promise.resolve([]) })   // no subscriber
    cache.revalidate('o'); await flush()
    const beforeW = watched, beforeO = orphan

    expect(cache.revalidateLive(0)).toBe(1)
    await flush()
    expect(watched).toBe(beforeW + 1)
    expect(orphan).toBe(beforeO)                                          // nobody is looking at it
  })

  it('the elapsed gate suppresses a glance-length app switch', async () => {
    let n = 0
    await seed('w', () => { n++; return Promise.resolve([{ id: 'a' }]) })
    const after = n
    // Entry was just written, so it is far younger than the gate.
    expect(cache.revalidateLive(RESUME_MIN_AGE_MS)).toBe(0)
    await flush()
    expect(n).toBe(after)
  })

  it('the elapsed gate lets a genuinely stale entry through', async () => {
    let n = 0
    await seed('w', () => { n++; return Promise.resolve([{ id: 'a' }]) })
    const after = n
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + RESUME_MIN_AGE_MS + 1000)
    expect(cache.revalidateLive(RESUME_MIN_AGE_MS)).toBe(1)
    await flush()
    expect(n).toBe(after + 1)
    Date.now.mockRestore()
  })

  it('does not stack a second fetch on a key already revalidating', async () => {
    let n = 0, release
    const gate = new Promise((r) => { release = r })
    cache.subscribe('w', () => {})
    cache.register('w', () => { n++; return gate.then(() => []) })
    cache.revalidate('w')
    await Promise.resolve()                      // let revalidate's deferred fetcher actually start
    expect(cache.revalidateLive(0)).toBe(0)
    release(); await flush()
    expect(n).toBe(1)
  })

  it('a revalidate returning the same rows with fresh presigns keeps the data ref (no re-render)', async () => {
    // Guards the D-1 merge-by-id invariant across the NEW resume path: a foreground refresh must not
    // re-render every photo surface (and re-download the visible screenful) just because S3 handed
    // back new signatures for the same objects.
    let call = 0
    cache.subscribe('w', () => {})
    cache.register('w', () => { call++; return Promise.resolve([{ id: 'a', view_url: `sig${call}` }]) })
    cache.revalidate('w'); await flush()
    const first = cache.peek('w').data
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + RESUME_MIN_AGE_MS + 1000)
    cache.revalidateLive(RESUME_MIN_AGE_MS); await flush()
    Date.now.mockRestore()
    expect(cache.peek('w').data).toBe(first)
  })
})

// ── B4 refresh primitive ────────────────────────────────────────────────────────────────────────
describe('D-2 B4: refreshAll()', () => {
  it('keeps watched data on screen while forcing the network, and leaves unwatched entries intact', async () => {
    let n = 0
    cache.subscribe('w', () => {})
    cache.register('w', () => { n++; return Promise.resolve([{ id: 'a' }]) })
    cache.revalidate('w'); await flush()
    cache.register('o', () => Promise.resolve([{ id: 'b' }]))
    cache.revalidate('o'); await flush()

    const before = n
    expect(cache.refreshAll()).toBe(1)
    // The watched list is still rendered from cache while the refetch runs — a refresh gesture that
    // blanked every mounted list would feel broken.
    expect(cache.peek('w').data).toEqual([{ id: 'a' }])
    await flush()
    expect(n).toBe(before + 1)
    // REVERSED 2026-07-31: this used to assert peek('o') === null, pinning the unwatched-delete as
    // intended. It was the boot-warm regression (see dataCache.js refreshAll). An unwatched warm
    // entry must SURVIVE a refresh.
    expect(cache.peek('o').data).toEqual([{ id: 'b' }])
  })

  it('does not evict the boot-warmed key when invoked with no subscribers (the off-surface case)', async () => {
    // The regression this guards: warm() registers no subscriber, so from any surface that isn't
    // PhotosWall the boot-warm entry is unwatched. Deleting it here made the next Photos visit a
    // cold fetch — the exact slow-tab cost V4-IMGCACHE-001 exists to remove.
    cache.register('warm-key', () => Promise.resolve([{ id: 'p' }]))
    cache.revalidate('warm-key'); await flush()

    expect(cache.refreshAll()).toBe(0)               // nothing watched → nothing refetched
    expect(cache.peek('warm-key').data).toEqual([{ id: 'p' }])   // …and nothing destroyed
  })

  it('does not count a subscribed key that has no registered fetcher', async () => {
    // invalidate() only re-kicks when subs AND a fetcher are present; counting on subs alone
    // over-reported and made the return value unsafe to display.
    cache.subscribe('nofetch', () => {})
    expect(cache.refreshAll()).toBe(0)
  })

  it('leaves a warm entry serving when a refresh fails (offline no-clobber)', async () => {
    let call = 0
    cache.subscribe('w2', () => {})
    cache.register('w2', () => {
      call++
      return call === 1 ? Promise.resolve([{ id: 'a' }]) : Promise.reject(new Error('offline'))
    })
    cache.revalidate('w2'); await flush()

    cache.refreshAll(); await flush()
    const snap = cache.peek('w2')
    expect(snap.data).toEqual([{ id: 'a' }])   // still serving
    expect(snap.error).toBeNull()              // SWR keeps-serving: no error surfaced over good data
    expect(snap.isValidating).toBe(false)      // …and the cycle completed
  })
})

// ── Hook wiring ─────────────────────────────────────────────────────────────────────────────────
function Harness({ sub }) { useCacheLifecycle(sub); return null }

describe('D-2 wiring: useCacheLifecycle', () => {
  it('warms the boot paths once an identity resolves', async () => {
    render(<Harness sub="user_1" />)
    await waitFor(() => expect(apiCalls).toEqual(BOOT_WARM_PATHS))
    expect(cache.peek(cache.keyFor('user_1', '/api/photos')).data).toEqual([{ id: 'a', view_url: 'u1' }])
  })

  it('warms NOTHING while the identity is unresolved (nothing cached under an absent sub)', async () => {
    render(<Harness sub={null} />)
    await flush()
    expect(apiCalls).toEqual([])
  })

  it('uses the shared key builder, so the warmed key is the one useCachedFetch reads', async () => {
    render(<Harness sub="user_1" />)
    await waitFor(() => expect(apiCalls.length).toBe(BOOT_WARM_PATHS.length))
    // A warm under a differently-shaped key would look successful and still miss on every read.
    expect(cache.peek('user_1|/api/photos')).not.toBeNull()
  })

  it('revalidates on foreground and removes its listeners on unmount', async () => {
    const { unmount } = render(<Harness sub="user_1" />)
    await waitFor(() => expect(apiCalls.length).toBe(1))
    cache.subscribe(cache.keyFor('user_1', '/api/photos'), () => {})

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + RESUME_MIN_AGE_MS + 1000)
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    await flush()
    expect(apiCalls.length).toBe(2)

    unmount()
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    await flush()
    expect(apiCalls.length).toBe(2)               // listener really detached
    Date.now.mockRestore()
  })

  it('ignores a visibilitychange that fires while the page is hidden', async () => {
    render(<Harness sub="user_1" />)
    await waitFor(() => expect(apiCalls.length).toBe(1))
    cache.subscribe(cache.keyFor('user_1', '/api/photos'), () => {})
    const spy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + RESUME_MIN_AGE_MS + 1000)
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    await flush()
    expect(apiCalls.length).toBe(1)               // backgrounding is not a reason to fetch
    spy.mockRestore(); Date.now.mockRestore()
  })

  it('B6: a reconnect revalidates a key the age gate would have skipped', async () => {
    // The regression this pins: reusing the B5 wake handler would inherit RESUME_MIN_AGE_MS, and a
    // failed revalidate never writes `at` — so after a short outage the entry still carries its last
    // SUCCESSFUL timestamp and the 5-minute gate skips exactly the keys that just failed. B6 must
    // pass minAgeMs 0. Here the entry is only ~0ms old, so a gated call would refetch nothing.
    render(<Harness sub="user_1" />)
    cache.subscribe('r1', () => {})
    let calls = 0
    cache.register('r1', () => { calls++; return Promise.resolve([{ id: 'a' }]) })
    cache.revalidate('r1'); await flush()
    const before = calls

    // Sanity: the gated path really would skip this fresh entry.
    cache.revalidateLive(RESUME_MIN_AGE_MS); await flush()
    expect(calls).toBe(before)

    await act(async () => { window.dispatchEvent(new Event('online')) })
    await flush()
    expect(calls).toBe(before + 1)
  })

  it('B6: the reconnect listener is removed on unmount', async () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const { unmount } = render(<Harness sub="user_1" />)
    expect(add.mock.calls.some(([e]) => e === 'online')).toBe(true)
    unmount()
    expect(remove.mock.calls.some(([e]) => e === 'online')).toBe(true)
    add.mockRestore(); remove.mockRestore()
  })

  it('useRefreshAll returns a callable that reports how many keys it refreshed', async () => {
    let refresh
    function R() { refresh = useRefreshAll(); return null }
    render(<R />)
    cache.subscribe('w', () => {})
    cache.register('w', () => Promise.resolve([]))
    cache.revalidate('w'); await flush()
    expect(refresh()).toBe(1)
  })
})
