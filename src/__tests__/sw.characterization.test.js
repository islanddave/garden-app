// Slice 0 — CHARACTERIZATION of public/sw.js as it exists TODAY (dev 6d1aed1).
//
// These tests deliberately pin CURRENT behaviour, including behaviour that will change in Slice 1.
// That is the point: sw.js has had ZERO test instrumentation, so every documented invariant in it
// rests on a comment. A change to the API cache rewrites `networkFirst` and the `activate` purge —
// the two functions carrying the most load-bearing undocumented-by-test behaviour in the file.
//
// Every assertion below names the mutation that must break it. An assertion with no such mutation
// is vacuous by construction and does not belong here.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import vm from 'node:vm'
import {
  readSwSource, loadServiceWorker, dispatchFetch, dispatchActivate,
  makeFakeCaches, LAMBDA_URL, offlineError, abortError,
} from './helpers/swHarness.js'

const CACHE_VERSION = 'v16-20260524'
const API_CACHE = `api-${CACHE_VERSION}`
const STATIC_CACHE = `static-${CACHE_VERSION}`
const IMAGE_CACHE = `images-${CACHE_VERSION}`

beforeEach(() => { vi.clearAllMocks() })

// ── Meta: prove the harness runs the REAL file ────────────────────────────────────────────────
describe('harness integrity — these tests run public/sw.js, not a reimplementation', () => {
  it('parses as a CLASSIC script (not a module) — the browser loads it raw', () => {
    // Mutation: add `export {}` to public/sw.js → vm.Script throws "Unexpected token 'export'".
    expect(() => new vm.Script(readSwSource())).not.toThrow()
  })

  it('registers exactly the four expected listeners, and nothing else', () => {
    const sw = loadServiceWorker()
    // Mutation: delete the message listener → 'message' disappears from this set.
    expect(Object.keys(sw.listeners).sort()).toEqual(['activate', 'fetch', 'install', 'message'])
  })

  it('has NO side effects at module top level — evaluating it touches neither caches nor fetch', () => {
    // Mutation: hoist a `caches.open(...)` to top level → this fails.
    const sw = loadServiceWorker()
    expect(sw.caches.open).not.toHaveBeenCalled()
    expect(sw.fetch).not.toHaveBeenCalled()
  })

  it('MUTATION META-TEST: changing the on-disk source changes observed behaviour', async () => {
    // This is the assertion that makes every other SW test in this file meaningful. If the harness
    // were evaluating a parallel implementation instead of the real bytes, editing the source text
    // would have no effect and this test would fail.
    const mutated = readSwSource().replace(
      "headers.set(FROM_CACHE_HEADER, '1')",
      "headers.set(FROM_CACHE_HEADER, 'MUTATED')",
    )
    expect(mutated).not.toBe(readSwSource())   // guard: the replace actually matched

    const url = LAMBDA_URL('/api/plants')
    const caches = makeFakeCaches({ [API_CACHE]: { [url]: new Response('{"ok":1}', { status: 200 }) } })
    const sw = loadServiceWorker({
      source: mutated,
      caches,
      fetchImpl: vi.fn(async () => { throw offlineError() }),
    })
    const { responded } = dispatchFetch(sw, new Request(url))
    const res = await responded
    expect(res.headers.get('X-From-Cache')).toBe('MUTATED')
  })
})

// ── networkFirst: the two failure branches, which are deliberate and undocumented-by-test ─────
describe('networkFirst — failure branches (documented prior art, previously untested)', () => {
  const url = LAMBDA_URL('/api/plants')

  function withCachedBody(fetchImpl) {
    const caches = makeFakeCaches({
      [API_CACHE]: { [url]: new Response('{"cached":true}', { status: 200 }) },
    })
    return { caches, sw: loadServiceWorker({ caches, fetchImpl }) }
  }

  it('OFFLINE (fetch rejects with TypeError) → serves the cached body, stamped X-From-Cache', async () => {
    // Mutation: drop the markFromCache() wrapper → header is null and the whole
    // api.js → dataCache `stale` → useCacheLifecycle B5/B6 chain silently stops working.
    const { sw } = withCachedBody(vi.fn(async () => { throw offlineError() }))
    const res = await dispatchFetch(sw, new Request(url)).responded
    expect(res.status).toBe(200)
    expect(res.headers.get('X-From-Cache')).toBe('1')
    expect(await res.text()).toBe('{"cached":true}')
  })

  it('OFFLINE with NOTHING cached → 503, and never a fabricated body', async () => {
    const caches = makeFakeCaches()
    const sw = loadServiceWorker({ caches, fetchImpl: vi.fn(async () => { throw offlineError() }) })
    const res = await dispatchFetch(sw, new Request(url)).responded
    expect(res.status).toBe(503)
  })

  it('TIMEOUT → synthetic 504 and the cache is NEVER read', async () => {
    // The load-bearing asymmetry: on a live radio a retry may succeed, and a stale body carries
    // presigned photo URLs with a 900s TTL, so serving it yields a working-looking screen with 403
    // images — which reads as data corruption rather than as a network problem.
    // Mutation: let the TimeoutError branch fall through to the offline branch → status becomes 200
    // and the cache-read assertion fails.
    const { caches, sw } = withCachedBody(vi.fn(async () => { throw abortError() }))
    const res = await dispatchFetch(sw, new Request(url)).responded
    expect(res.status).toBe(504)
    const apiCache = caches.store.get(API_CACHE)
    expect(apiCache.match).not.toHaveBeenCalled()
  })

  it('an ABORT is classified as a TIMEOUT, not as offline — fetchWithTimeout remaps it', async () => {
    // Pins a subtlety that is easy to get wrong when refactoring this function: fetchWithTimeout
    // converts ANY AbortError into a TimeoutError, so a deliberate page-side abort (Search.jsx
    // aborts on every supersede) takes the 504 branch and does NOT serve stale on a live radio.
    // Mutation: remove the AbortError→TimeoutError remap in fetchWithTimeout → the abort reaches
    // networkFirst's catch as an AbortError, takes the offline branch, and returns 200.
    const { sw } = withCachedBody(vi.fn(async () => { throw abortError() }))
    const res = await dispatchFetch(sw, new Request(url)).responded
    expect(res.status).toBe(504)
  })

  it('caches a successful response', async () => {
    const caches = makeFakeCaches()
    const sw = loadServiceWorker({
      caches, fetchImpl: vi.fn(async () => new Response('{"fresh":1}', { status: 200 })),
    })
    await dispatchFetch(sw, new Request(url)).responded
    await Promise.resolve(); await Promise.resolve()   // the put is fire-and-forget
    expect(caches.store.get(API_CACHE)?.entries.get(url)).toBeTruthy()
  })

  it('a NON-OK response is never cached', async () => {
    // Mutation: drop the `response.ok` guard → the 500 body is written to the cache and later
    // served offline as though it were data.
    const caches = makeFakeCaches()
    const sw = loadServiceWorker({
      caches, fetchImpl: vi.fn(async () => new Response('boom', { status: 500 })),
    })
    await dispatchFetch(sw, new Request(url)).responded
    await Promise.resolve(); await Promise.resolve()
    expect(caches.store.get(API_CACHE)?.entries.size ?? 0).toBe(0)
  })

  it('a fresh network response carries NO cache marker', async () => {
    // Mutation: stamp X-From-Cache before the clone/response split → dataCache sets stale:true on
    // FRESH data and useCacheLifecycle B5/B6 revalidate in a loop.
    const sw = loadServiceWorker({
      fetchImpl: vi.fn(async () => new Response('{"fresh":1}', { status: 200 })),
    })
    const res = await dispatchFetch(sw, new Request(url)).responded
    expect(res.headers.get('X-From-Cache')).toBeNull()
  })
})

// ── The routing guards ────────────────────────────────────────────────────────────────────────
describe('fetch routing guards', () => {
  it('a NON-GET request is declined outright — respondWith is never called', async () => {
    // Mutation: move the key/route derivation above the method guard → respondWith fires and
    // mutations start being cached under a user identity.
    const sw = loadServiceWorker()
    const { responded, event } = dispatchFetch(sw, new Request(LAMBDA_URL('/api/events'), { method: 'POST' }))
    expect(event.respondWith).not.toHaveBeenCalled()
    expect(responded).toBeNull()
  })

  it('an API path cannot reach the STATIC cache — it has no matching file extension', async () => {
    // Guards the class where an authenticated body lands in an unsegmented, CACHE-FIRST store,
    // which would be served cross-identity even while ONLINE — strictly worse than the API-cache
    // defect. Mutation: broaden isStaticAsset to match extension-less paths.
    const caches = makeFakeCaches()
    const sw = loadServiceWorker({
      caches, fetchImpl: vi.fn(async () => new Response('{"a":1}', { status: 200 })),
    })
    await dispatchFetch(sw, new Request(LAMBDA_URL('/api/search?q=tomato'))).responded
    await Promise.resolve(); await Promise.resolve()
    expect(caches.store.has(STATIC_CACHE)).toBe(false)
    expect(caches.store.get(API_CACHE)?.entries.size).toBe(1)
  })
})

// ── activate purge: an exact-equality allowlist, which Slice 1 must replace ────────────────────
describe('activate purge — CURRENT exact-equality allowlist', () => {
  it('keeps exactly the three current caches and deletes everything else', async () => {
    const caches = makeFakeCaches({
      [STATIC_CACHE]: {}, [API_CACHE]: {}, [IMAGE_CACHE]: {},
      'api-v15-older': {}, 'garden-images': {},
    })
    const sw = loadServiceWorker({ caches })
    await dispatchActivate(sw)
    expect([...caches.store.keys()].sort()).toEqual([API_CACHE, IMAGE_CACHE, STATIC_CACHE].sort())
  })

  it('DELETES any per-sub API cache name — the hazard Slice 1 must fix before it can use one', async () => {
    // This is the single highest-risk line for the planned change: a per-sub name never equals
    // API_CACHE, so today's purge destroys it on every activation. Pinning it here means Slice 1's
    // predicate rewrite has a red test to turn green rather than an unverified claim.
    const caches = makeFakeCaches({
      [STATIC_CACHE]: {}, [API_CACHE]: {}, [IMAGE_CACHE]: {},
      [`${API_CACHE}-u-user_2abc`]: {},
    })
    const sw = loadServiceWorker({ caches })
    await dispatchActivate(sw)
    expect(caches.store.has(`${API_CACHE}-u-user_2abc`)).toBe(false)
  })
})
