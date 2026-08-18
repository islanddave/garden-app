// Slice 1 — SW API-cache IDENTITY SEGMENTATION (design V100, V4-SWCACHEID-001).
//
// Every assertion below names the mutation that must break it. The harness evaluates the REAL bytes
// of public/sw.js (see helpers/swHarness.js), so these are behavioural tests of the shipped file,
// not of a parallel implementation.
//
// NOTE ON D7 ("sign-out cleanup is hygiene, not the control"): the design proposed re-running the
// anchor test with cleanup disabled to prove read-time segmentation is what protects the data.
// Slice 1 ships NO sign-out cleanup at all, so that proof is structural here rather than a second
// test run — there is no cleanup path that could be doing the work. The anchor test below passes
// against a build in which nothing is ever purged on sign-out.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  loadServiceWorker, dispatchFetch, dispatchActivate, makeFakeCaches,
  apiRequest, jwtWithSub, LAMBDA_URL, offlineError,
} from './helpers/swHarness.js'
import { subFromAuthHeader, apiCacheNameFor, keepCacheKey } from '../lib/swCacheKeys.js'

const CACHE_VERSION = 'v16-20260524'
const SUB_A = 'user_2aAAAAAAAAAAAAAAAAAAAAAAAAA'
const SUB_B = 'user_2bBBBBBBBBBBBBBBBBBBBBBBBBB'
const nameFor = (sub) => `api-${CACHE_VERSION}-u-${sub}`

const jsonResponse = (body) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

/** Drive one API GET through the real fetch listener and settle any waitUntil cache write. */
async function apiGet(sw, request) {
  const { responded, waits } = dispatchFetch(sw, request)
  const response = await responded
  await Promise.all(waits)
  return response
}

beforeEach(() => { vi.clearAllMocks() })

// ── THE ANCHOR TEST ───────────────────────────────────────────────────────────────────────────
describe('anchor — one user\'s cached API body is unreachable by another user', () => {
  it('seeds A online, denies B offline, and STILL serves A offline (positive control)', async () => {
    const caches = makeFakeCaches()
    let online = true
    const fetchMock = vi.fn(async () => {
      if (!online) throw offlineError()
      return jsonResponse({ owner: 'A', plants: 10247 })
    })
    const sw = loadServiceWorker({ caches, fetchImpl: fetchMock })

    // Phase 1 — A, online. Seeds the cache through the REAL put path, never by hand.
    const seeded = await apiGet(sw, apiRequest(SUB_A))
    expect(seeded.status).toBe(200)
    // Mutation: drop `sub` from the cache name => this asserts the wrong bucket was written.
    expect(caches.store.has(nameFor(SUB_A))).toBe(true)

    // Phase 2 — B, offline. B must NOT receive A's body.
    online = false
    const bResponse = await apiGet(sw, apiRequest(SUB_B))
    // Mutation: remove the sub from the key derivation => B reads A's entry and this becomes 200.
    expect(bResponse.status).toBe(503)
    expect(await bResponse.text()).not.toContain('10247')

    // Phase 3 — POSITIVE CONTROL (boss finding B3). Without this phase the test also passes when
    // `subFromAuthHeader` returns null for BOTH subjects, because a blanket-null build 503s
    // everyone. Mutation: `subFromAuthHeader = () => null` => THIS assertion fails while the
    // phase-2 assertion still passes.
    const aResponse = await apiGet(sw, apiRequest(SUB_A))
    expect(aResponse.status).toBe(200)
    expect(await aResponse.json()).toEqual({ owner: 'A', plants: 10247 })
  })

  it('reads through cache.match on A\'s partition and never opens B\'s (path witness)', async () => {
    const caches = makeFakeCaches()
    let online = true
    const sw = loadServiceWorker({
      caches,
      fetchImpl: vi.fn(async () => { if (!online) throw offlineError(); return jsonResponse({ owner: 'A' }) }),
    })
    await apiGet(sw, apiRequest(SUB_A))
    online = false
    await apiGet(sw, apiRequest(SUB_A))

    // Mutation: return early before touching the cache (e.g. at the origin guard) => no open call
    // with this name, so the witness fails even where an outcome assertion would not.
    expect(caches.open).toHaveBeenCalledWith(nameFor(SUB_A))
    expect(caches.open).not.toHaveBeenCalledWith(nameFor(SUB_B))
    expect(caches.store.get(nameFor(SUB_A)).match).toHaveBeenCalled()
  })
})

// ── THE P1 AXIS: credential-less read ─────────────────────────────────────────────────────────
describe('fail closed — a request with no identity gets no cache, in either direction', () => {
  it('a SIGNED-OUT device offline gets 503, not the previous user\'s body', async () => {
    // This is the axis that made the item worth doing: Clerk returns a NULL token (it does not
    // throw) when there is no session, so src/lib/api.js omits the Authorization header entirely
    // and the request IS issued. Before segmentation the offline branch answered it from the one
    // shared api-* cache — the last user's data, readable with no credential, one airplane-mode tap.
    const caches = makeFakeCaches()
    let online = true
    const sw = loadServiceWorker({
      caches,
      fetchImpl: vi.fn(async () => { if (!online) throw offlineError(); return jsonResponse({ owner: 'A', plants: 10247 }) }),
    })
    await apiGet(sw, apiRequest(SUB_A))          // A signs in and browses
    online = false
    const anon = await apiGet(sw, apiRequest(null)) // A signs out; device goes offline

    // Mutation: revert apiCacheNameFor to one shared `api-${version}` for everyone (the exact
    // pre-Slice-1 shape) => 200 carrying A's 10,247 events.
    expect(anon.status).toBe(503)
    expect(await anon.text()).not.toContain('10247')
    // ...and no 'anon' partition was invented to hold unidentified data either. Without this line
    // the test also passes against a build that fails OPEN into a shared anon bucket, because A's
    // body lives in A's partition and the anon read misses for the WRONG reason.
    // Mutation: return `api-${version}-u-anon` for a null sub => a partition appears here.
    expect([...caches.store.keys()]).toEqual([nameFor(SUB_A)])
  })

  it('never WRITES an unidentified response into any cache', async () => {
    const caches = makeFakeCaches()
    const sw = loadServiceWorker({ caches, fetchImpl: vi.fn(async () => jsonResponse({ any: 'body' })) })
    const res = await apiGet(sw, apiRequest(null))

    expect(res.status).toBe(200)             // the NETWORK response still passes through untouched
    // Mutation: write under a null key (an 'anon' bucket) => a cache appears here, rebuilding the
    // exact defect for the unauthenticated surface.
    expect([...caches.store.keys()]).toEqual([])
    expect(caches.open).not.toHaveBeenCalled()
  })

  it('a malformed or unparseable bearer token is treated as no identity', async () => {
    const caches = makeFakeCaches()
    const sw = loadServiceWorker({ caches, fetchImpl: vi.fn(async () => jsonResponse({ any: 'body' })) })
    for (const header of ['Bearer not-a-jwt', 'Bearer a.b', 'Basic dXNlcjpwdw==', 'Bearer a.!!!.c']) {
      await apiGet(sw, new Request(LAMBDA_URL(), { headers: { Authorization: header } }))
    }
    // Mutation: let a parse failure throw instead of returning null => the fetch handler rejects.
    expect([...caches.store.keys()]).toEqual([])
  })
})

// ── N1: the bearer token must not be persisted at rest ────────────────────────────────────────
describe('the cache key is a URL string, so no bearer token is stored at rest', () => {
  it('puts under request.url and not under the Request object', async () => {
    const caches = makeFakeCaches()
    const sw = loadServiceWorker({ caches, fetchImpl: vi.fn(async () => jsonResponse({ ok: true })) })
    await apiGet(sw, apiRequest(SUB_A))

    const cache = caches.store.get(nameFor(SUB_A))
    const [key] = cache.put.mock.calls[0]
    // Mutation: revert to `cache.put(request, ...)` => key becomes a Request, which carries the
    // Authorization header into Cache Storage where it outlives the session.
    expect(typeof key).toBe('string')
    expect(key).toBe(LAMBDA_URL())
    expect(JSON.stringify(key)).not.toContain('Bearer')
  })

  it('still HITS that entry offline, so keying by URL costs no hit rate', async () => {
    const caches = makeFakeCaches()
    let online = true
    const sw = loadServiceWorker({
      caches,
      fetchImpl: vi.fn(async () => { if (!online) throw offlineError(); return jsonResponse({ hit: true }) }),
    })
    await apiGet(sw, apiRequest(SUB_A))
    online = false
    const res = await apiGet(sw, apiRequest(SUB_A))
    // Mutation: put by URL but match by Request without ignoreVary => a Vary-bearing response
    // misses and this becomes 503, turning every offline read into a permanent miss.
    expect(res.status).toBe(200)
    expect(res.headers.get('X-From-Cache')).toBe('1')
  })
})

// ── activate: the purge must KEEP per-sub partitions and DROP the bare legacy cache ───────────
describe('activate purge', () => {
  it('keeps this version\'s per-sub partitions instead of self-destructing them', async () => {
    const caches = makeFakeCaches({
      [nameFor(SUB_A)]: {}, [nameFor(SUB_B)]: {},
      [`static-${CACHE_VERSION}`]: {}, [`images-${CACHE_VERSION}`]: {},
    })
    const sw = loadServiceWorker({ caches })
    await dispatchActivate(sw)
    // Mutation: revert to the equality allowlist (k !== STATIC && k !== API && k !== IMAGE) => every
    // per-sub name is deleted on EVERY activation and segmentation can never retain anything.
    expect(caches.store.has(nameFor(SUB_A))).toBe(true)
    expect(caches.store.has(nameFor(SUB_B))).toBe(true)
  })

  it('deletes the bare legacy api- cache and prior-version partitions', async () => {
    const caches = makeFakeCaches({
      [`api-${CACHE_VERSION}`]: {},              // bare, unsegmented — the pre-Slice-1 cache
      'api-v15-20260101-u-user_old': {},          // a prior version's partition
      [nameFor(SUB_A)]: {},
      [`static-${CACHE_VERSION}`]: {},
    })
    const sw = loadServiceWorker({ caches })
    await dispatchActivate(sw)
    // The bare name must NOT survive: it holds bodies written before segmentation existed, which
    // are by definition cross-identity. This is what makes the upgrade actually remove the defect
    // rather than leave a readable copy of it behind.
    // Mutation: make keepCacheKey accept `api-${version}` (i.e. keep the legacy cache) => fails.
    expect(caches.store.has(`api-${CACHE_VERSION}`)).toBe(false)
    expect(caches.store.has('api-v15-20260101-u-user_old')).toBe(false)
    expect(caches.store.has(nameFor(SUB_A))).toBe(true)
  })
})

// ── pure helpers ──────────────────────────────────────────────────────────────────────────────
describe('swCacheKeys — pure helpers', () => {
  it('extracts sub from a base64URL payload, including non-ASCII sibling claims', () => {
    // Mutation: decode with atob's binary string instead of TextDecoder => JSON.parse throws on the
    // multi-byte name and an otherwise-valid sub is silently lost.
    const header = `Bearer ${jwtWithSub(SUB_A, { name: 'Jën Ünïcode 🌱' })}`
    expect(subFromAuthHeader(header)).toBe(SUB_A)
  })

  it('is identity-agnostic — the same human with a NEW sub gets a different partition', () => {
    // Mutation: key on email or a normalized display identity => these collapse to one partition.
    const first = apiCacheNameFor(CACHE_VERSION, 'user_2original')
    const second = apiCacheNameFor(CACHE_VERSION, 'user_2recreated')
    expect(first).not.toBe(second)
  })

  it('returns null for every shape that is not a usable identity', () => {
    for (const bad of [null, undefined, 42, '', 'Bearer', 'Bearer   ', 'Bearer a.b.c.d', `Bearer ${jwtWithSub('')}`]) {
      expect(subFromAuthHeader(bad)).toBeNull()
    }
    // A sub outside [A-Za-z0-9_-] or over 64 chars is rejected rather than sanitized, because a
    // sanitizer fails TOWARD a shared partition. Mutation: sanitize-and-truncate => these return
    // a usable (and colliding) name.
    expect(subFromAuthHeader(`Bearer ${jwtWithSub('a'.repeat(65))}`)).toBeNull()
    expect(subFromAuthHeader(`Bearer ${jwtWithSub('user/../other')}`)).toBeNull()
    expect(apiCacheNameFor(CACHE_VERSION, null)).toBeNull()
    expect(apiCacheNameFor('', SUB_A)).toBeNull()
  })

  it('keepCacheKey truth table', () => {
    const keep = (k) => keepCacheKey(k, CACHE_VERSION)
    expect(keep(`static-${CACHE_VERSION}`)).toBe(true)
    expect(keep(`images-${CACHE_VERSION}`)).toBe(true)
    expect(keep(nameFor(SUB_A))).toBe(true)
    expect(keep(`api-${CACHE_VERSION}`)).toBe(false)        // bare legacy — must NOT survive
    expect(keep('api-v15-20260101-u-user_old')).toBe(false) // prior version
    expect(keep('static-v15-20260101')).toBe(false)
    expect(keep('garden-images')).toBe(false)
    expect(keep(`api-${CACHE_VERSION}-u-`)).toBe(false)     // empty sub
    expect(keep(`api-${CACHE_VERSION}-u-bad/sub`)).toBe(false)
  })
})
