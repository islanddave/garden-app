// dataCache — V4-IMGCACHE-001 D-1 store unit tests (pure, no React). Covers the crucible-hardened
// invariants: immutable/stable snapshot, in-flight dedup, generation-guard-at-settle, merge-by-id URL
// preservation, rejected-promise recovery, error-only-when-no-data, prefix/all invalidation.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as cache from '../lib/dataCache.js'

beforeEach(() => cache.__resetDataCache())
// A macrotask drains the whole Promise.resolve().then(fetcher).then(...).finally() chain (incl. the
// identity-guarded in-flight eviction) before the next assertion.
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('dataCache — snapshot + fetch lifecycle', () => {
  it('empty→pending→value; snapshot ref is stable until the entry changes', async () => {
    const K = 'u1|/api/photos'
    const snap0 = cache.getSnapshot(K)
    expect(snap0.status).toBe('empty')
    expect(cache.getSnapshot(K)).toBe(snap0)                    // stable while empty
    cache.register(K, () => Promise.resolve([{ id: 'a', view_url: 'v1' }]))
    cache.revalidate(K)
    const snapP = cache.getSnapshot(K)
    expect(snapP).not.toBe(snap0)                               // new ref on transition
    expect(snapP.isValidating).toBe(true)
    await flush()
    const snapV = cache.getSnapshot(K)
    expect(snapV.status).toBe('value')
    expect(snapV.data).toEqual([{ id: 'a', view_url: 'v1' }])
    expect(snapV.isValidating).toBe(false)
    for (let i = 0; i < 5; i++) expect(cache.getSnapshot(K)).toBe(snapV)   // 5 no-op reads → identical ref
  })

  it('in-flight dedup: two revalidates of one key share one fetch', async () => {
    const K = 'u1|/x'
    const fetcher = vi.fn(() => Promise.resolve([{ id: 'a' }]))
    cache.register(K, fetcher)
    const p1 = cache.revalidate(K)
    const p2 = cache.revalidate(K)
    expect(p1).toBe(p2)                                         // same in-flight promise → dedup
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(1)                    // one network call for both
  })
})

describe('dataCache — merge-by-id URL preservation (no re-download churn)', () => {
  it('same rows with only fresh presigned URLs keep the prior data ref', async () => {
    const K = 'u1|/api/photos'
    let n = 0
    cache.register(K, () => Promise.resolve([{ id: 'a', caption: 'c', view_url: 'url' + (++n) }]))
    cache.revalidate(K); await flush()
    const d1 = cache.getSnapshot(K).data
    cache.revalidate(K); await flush()                         // fresh URL, same row/caption
    expect(cache.getSnapshot(K).data).toBe(d1)                 // Object.is-equal → no re-render/re-download
  })

  it('a real membership change adopts the fresh list', async () => {
    const K = 'u1|/api/photos'
    const lists = [[{ id: 'a', view_url: 'u' }], [{ id: 'a', view_url: 'u2' }, { id: 'b', view_url: 'u3' }]]
    let i = 0
    cache.register(K, () => Promise.resolve(lists[i++]))
    cache.revalidate(K); await flush()
    const d1 = cache.getSnapshot(K).data
    cache.revalidate(K); await flush()
    const d2 = cache.getSnapshot(K).data
    expect(d2).not.toBe(d1)
    expect(d2.map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('a non-URL field change (caption edit) adopts the fresh list', async () => {
    const K = 'u1|/api/photos'
    const lists = [[{ id: 'a', caption: 'old', view_url: 'u' }], [{ id: 'a', caption: 'new', view_url: 'u2' }]]
    let i = 0
    cache.register(K, () => Promise.resolve(lists[i++]))
    cache.revalidate(K); await flush()
    const d1 = cache.getSnapshot(K).data
    cache.revalidate(K); await flush()
    expect(cache.getSnapshot(K).data).not.toBe(d1)
    expect(cache.getSnapshot(K).data[0].caption).toBe('new')
  })
})

describe('dataCache — generation guard + failure handling', () => {
  it('an older-gen result resolving AFTER an invalidate is discarded', async () => {
    const K = 'uA|/api/photos'
    let resolveOld
    cache.register(K, () => new Promise((r) => { resolveOld = r }))
    cache.subscribe(K, () => {})
    cache.revalidate(K)                                        // gen 0, pending
    cache.register(K, () => Promise.resolve([{ id: 'new', view_url: 'fresh' }]))
    cache.invalidate(K)                                        // gen→1 + auto-revalidate (subscribed)
    await flush()
    expect(cache.getSnapshot(K).data).toEqual([{ id: 'new', view_url: 'fresh' }])
    resolveOld([{ id: 'stale' }])                              // gen-0 resolves late
    await flush()
    expect(cache.getSnapshot(K).data).toEqual([{ id: 'new', view_url: 'fresh' }])   // discarded
  })

  it('a rejected fetch does not poison the key; the next revalidate recovers', async () => {
    const K = 'u1|/x'
    let call = 0
    cache.register(K, () => (++call === 1 ? Promise.reject(new Error('net')) : Promise.resolve([{ id: 'a' }])))
    cache.revalidate(K); await flush()
    expect(cache.getSnapshot(K).status).toBe('error')
    cache.revalidate(K); await flush()
    expect(cache.getSnapshot(K).status).toBe('value')
    expect(cache.getSnapshot(K).data).toEqual([{ id: 'a' }])
  })

  it('error only when no data: a revalidate failure WITH a cached value keeps the value', async () => {
    const K = 'u1|/x'
    let call = 0
    cache.register(K, () => (++call === 1 ? Promise.resolve([{ id: 'a' }]) : Promise.reject(new Error('blip'))))
    cache.revalidate(K); await flush()
    expect(cache.getSnapshot(K).status).toBe('value')
    cache.revalidate(K); await flush()
    expect(cache.getSnapshot(K).status).toBe('value')
    expect(cache.getSnapshot(K).error).toBe(null)
    expect(cache.getSnapshot(K).data).toEqual([{ id: 'a' }])
  })
})

describe('dataCache — invalidation', () => {
  it('invalidate re-fetches a SUBSCRIBED key (mounted-consumer refresh without remount)', async () => {
    const K = 'uA|/api/photos'
    const fetcher = vi.fn(() => Promise.resolve([{ id: 'a' }]))
    cache.register(K, fetcher)
    cache.subscribe(K, () => {})
    cache.revalidate(K); await flush()
    expect(fetcher).toHaveBeenCalledTimes(1)
    cache.invalidate(K); await flush()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('invalidatePrefix bumps only keys whose PATH starts with the prefix', async () => {
    const kPhotos = 'uA|/api/photos', kAttached = 'uA|/api/photos?attachedTo=1', kPlants = 'uA|/api/plants'
    const f = {}
    for (const k of [kPhotos, kAttached, kPlants]) {
      f[k] = vi.fn(() => Promise.resolve([{ id: k }]))
      cache.register(k, f[k]); cache.subscribe(k, () => {}); cache.revalidate(k)
    }
    await flush()
    cache.invalidatePrefix('/api/photos'); await flush()
    expect(f[kPhotos]).toHaveBeenCalledTimes(2)
    expect(f[kAttached]).toHaveBeenCalledTimes(2)
    expect(f[kPlants]).toHaveBeenCalledTimes(1)               // not matched
  })

  it('invalidateAll clears every entry', async () => {
    const K = 'uA|/api/photos'
    cache.register(K, () => Promise.resolve([{ id: 'a' }]))
    cache.revalidate(K); await flush()
    expect(cache.getSnapshot(K).status).toBe('value')
    cache.invalidateAll()
    expect(cache.peek(K)).toBe(null)                          // entry gone
  })
})
