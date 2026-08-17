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

  // V4-PERFTHEMEA-001. /api/plants gained a SECOND presigned field (featured_photo_thumb_url), and a
  // URL field absent from URL_FIELDS is the single most direct way to turn a photo-weight fix into a
  // perf REGRESSION: it churns on every revalidate, so the list takes a new identity and the whole
  // visible screenful re-renders and re-downloads on every background refresh.
  it('a plants row whose BOTH presigned fields churn keeps the prior data ref', async () => {
    const K = 'u1|/api/plants'
    let n = 0
    cache.register(K, () => {
      n++
      return Promise.resolve([{
        id: 'pl9', name: 'Bhut Jolokia', featured_photo_id: 'ph9',
        featured_photo_view_url: `https://s3.invalid/plants/a.jpg?sig=full${n}`,
        featured_photo_thumb_url: `https://s3.invalid/thumbs/plants/a.jpg?sig=thumb${n}`,
      }])
    })
    cache.revalidate(K); await flush()
    const d1 = cache.getSnapshot(K).data
    cache.revalidate(K); await flush()
    expect(n).toBe(2)                                          // the revalidate really ran
    expect(cache.getSnapshot(K).data).toBe(d1)                 // …and produced NO new data identity
  })

  // The case above passes with a FLAT fixture row, which no real /api/plants row is: the list
  // projection carries `variety_ref` (a jsonb_build_object cultivar join) and the `metadata` jsonb
  // column. Every response is a fresh JSON.parse, so those two never survive an === compare and the
  // guard silently reported presign-only churn as a data change — new list identity, enrichment
  // rebuilt, fresh presign into PhotoImg's initialUrl, thumbnails re-downloaded on every background
  // refresh. Measured false at 9c335bf before _sameField.
  it('a plants row carrying nested jsonb (variety_ref, metadata) keeps the prior data ref', async () => {
    const K = 'u1|/api/plants'
    let n = 0
    // JSON round-trip per call: reproduces the fresh-parse identities a real response has.
    cache.register(K, () => {
      n++
      return Promise.resolve(JSON.parse(JSON.stringify([{
        id: 'pl9', name: 'Bhut Jolokia', status: 'growing', location_id: 'loc1',
        metadata: { bed: 3, notes: null },
        variety_ref: { id: 'v1', name: 'Bhut Jolokia', crop_type_slug: 'pepper', days_to_maturity_min: 90 },
        featured_photo_id: 'ph9',
        featured_photo_view_url: `https://s3.invalid/plants/a.jpg?sig=full${n}`,
        featured_photo_thumb_url: `https://s3.invalid/thumbs/plants/a.jpg?sig=thumb${n}`,
      }])))
    })
    cache.revalidate(K); await flush()
    const d1 = cache.getSnapshot(K).data
    cache.revalidate(K); await flush()
    expect(n).toBe(2)
    expect(cache.getSnapshot(K).data).toBe(d1)
  })

  it('a change INSIDE a nested jsonb field still adopts the fresh list', async () => {
    const K = 'u1|/api/plants'
    const lists = [
      [{ id: 'pl9', variety_ref: { id: 'v1', crop_type_slug: 'pepper' }, featured_photo_view_url: 'u1' }],
      [{ id: 'pl9', variety_ref: { id: 'v1', crop_type_slug: 'tomato' }, featured_photo_view_url: 'u2' }],
    ]
    let i = 0
    cache.register(K, () => Promise.resolve(lists[i++]))
    cache.revalidate(K); await flush()
    const d1 = cache.getSnapshot(K).data
    cache.revalidate(K); await flush()
    expect(cache.getSnapshot(K).data).not.toBe(d1)
    expect(cache.getSnapshot(K).data[0].variety_ref.crop_type_slug).toBe('tomato')
  })

  it('a nested field appearing or disappearing adopts the fresh list', async () => {
    const K = 'u1|/api/plants'
    const lists = [
      [{ id: 'pl9', variety_ref: null, featured_photo_view_url: 'u1' }],
      [{ id: 'pl9', variety_ref: { id: 'v1' }, featured_photo_view_url: 'u2' }],
    ]
    let i = 0
    cache.register(K, () => Promise.resolve(lists[i++]))
    cache.revalidate(K); await flush()
    const d1 = cache.getSnapshot(K).data
    cache.revalidate(K); await flush()
    expect(cache.getSnapshot(K).data).not.toBe(d1)
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

// ── SW-STALEAPI-001 — the freshness clock must be NETWORK-ONLY ───────────────────────────────────────
//
// public/sw.js answers an offline /api/* fetch out of API_CACHE with a plain 200, so the fetcher here
// RESOLVES on a failed refresh. Before this fix that resolution committed `at: Date.now()`, and
// revalidateLive(RESUME_MIN_AGE_MS) then skipped the next real wake revalidate — the app stopped trying
// to refetch precisely because it had just failed to fetch.
//
// FROM_CACHE is imported from api.js on purpose: dataCache.js reads the symbol via Symbol.for() rather
// than importing api.js (to stay dependency-free), so this import is what pins the two definitions
// together. If either side renames its symbol, these tests go red instead of the marker going silently
// dead in production.
import { FROM_CACHE } from '../lib/api.js'

const fromCache = (rows) => {
  Object.defineProperty(rows, FROM_CACHE, { value: true, enumerable: false, configurable: true })
  return rows
}

describe('dataCache — cache-served responses do not advance the freshness clock', () => {
  afterEach(() => vi.restoreAllMocks())

  it('a cache-served refresh keeps serving data, flags stale, and leaves `at` at the last NETWORK time', async () => {
    const K = 'u1|/api/photos'
    let now = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)

    let payload = [{ id: 'a', view_url: 'u1' }]
    cache.subscribe(K, () => {})
    cache.register(K, () => Promise.resolve(payload))

    cache.revalidate(K); await flush()                       // live success → at = t0
    expect(cache.getSnapshot(K).stale).toBe(false)

    now += 6 * 60 * 1000                                     // 6 min later, offline
    payload = fromCache([{ id: 'a', view_url: 'u1' }])
    cache.revalidate(K); await flush()

    const snap = cache.getSnapshot(K)
    expect(snap.status).toBe('value')                        // data still served (SWR keeps the list)
    expect(snap.data).toEqual([{ id: 'a', view_url: 'u1' }])
    expect(snap.error).toBeNull()
    expect(snap.stale).toBe(true)                            // …but knowably stale
    expect(snap.isValidating).toBe(false)                    // and the in-flight settled

    // THE POISONING FIX: `at` is still t0, so the entry reads as 6 min old and the wake gate FIRES.
    // With the old behaviour `at` was t0+6min, age 0, and this returned 0.
    expect(cache.revalidateLive(5 * 60 * 1000)).toBe(1)
    await flush()
  })

  it('control: a LIVE refresh does advance `at` and correctly suppresses the wake gate', async () => {
    const K = 'u1|/api/photos'
    let now = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)

    cache.subscribe(K, () => {})
    cache.register(K, () => Promise.resolve([{ id: 'a', view_url: 'u1' }]))
    cache.revalidate(K); await flush()

    now += 6 * 60 * 1000
    cache.revalidate(K); await flush()                       // live, unmarked → at = t0+6min

    expect(cache.getSnapshot(K).stale).toBe(false)
    expect(cache.revalidateLive(5 * 60 * 1000)).toBe(0)      // genuinely fresh → correctly skipped
  })

  it('a COLD cache-served mount leaves at:0, so the very next wake revalidates it', async () => {
    const K = 'u1|/api/photos'
    cache.subscribe(K, () => {})
    cache.register(K, () => Promise.resolve(fromCache([{ id: 'a' }])))
    cache.revalidate(K); await flush()

    expect(cache.getSnapshot(K).data).toEqual([{ id: 'a' }])
    expect(cache.getSnapshot(K).stale).toBe(true)
    expect(cache.revalidateLive(5 * 60 * 1000)).toBe(1)      // at:0 is never "recent enough" to skip
    await flush()
  })

  it('stale clears once the network answers again', async () => {
    const K = 'u1|/api/photos'
    let payload = fromCache([{ id: 'a', view_url: 'u1' }])
    cache.register(K, () => Promise.resolve(payload))
    cache.revalidate(K); await flush()
    expect(cache.getSnapshot(K).stale).toBe(true)

    payload = [{ id: 'a', view_url: 'u1' }, { id: 'b' }]
    cache.revalidate(K); await flush()
    expect(cache.getSnapshot(K).stale).toBe(false)
    expect(cache.getSnapshot(K).data).toHaveLength(2)
  })

  it('a boot warm served from cache survives (it is not a failed warm) and stays revalidatable', async () => {
    const K = 'u1|/api/photos'
    cache.warm(K, () => Promise.resolve(fromCache([{ id: 'a' }])))
    await flush()
    const snap = cache.getSnapshot(K)
    expect(snap.status).toBe('value')                        // NOT reset to 'empty' — real rows arrived
    expect(snap.stale).toBe(true)
    cache.subscribe(K, () => {})
    expect(cache.revalidateLive(5 * 60 * 1000)).toBe(1)
    await flush()
  })
})
