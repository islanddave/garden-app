// SW-STALEAPI-001 — EXECUTABLE harness over public/sw.js's API strategy.
//
// WHAT THIS IS: the real public/sw.js source, evaluated with the ServiceWorkerGlobalScope surface it
// needs injected as parameters (self / caches / fetch). Control flow, branch order and the Response
// construction are the shipped ones — this is not string-matching like swImageCache.test.js, and not a
// reimplementation. Response/Request/Headers/AbortController are the REAL WHATWG classes (Node 26
// globals survive vitest's jsdom env), so header immutability, null-body-status rules and body
// plumbing behave as they do in a browser.
//
// WHAT THIS IS NOT — read before trusting a green run:
//   · `caches` is a hand-rolled Map fake. Real Cache API matching (Vary, ignoreSearch, request-header
//     matching) is NOT modelled; these tests key on request.url alone.
//   · There is no real service worker: no install/activate/claim lifecycle, no registration, no
//     cross-origin response filtering. In production the cached /api/* response is a CORS-filtered
//     response and this code rebuilds it as a synthetic same-scope one — that transition is the piece
//     only a real browser can prove. See the manual check in the task report.
//   · Nothing here proves the page actually READS X-From-Cache off a SW-synthesized response.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(resolve(__dirname, '../../public/sw.js'), 'utf8')

const API_URL = 'https://abc123.lambda-url.us-east-1.on.aws/api/photos'
// The subject whose cache partition these tests operate in (V4-SWCACHEID-001).
const SUB = 'user_2networkfirst'
const AUTH_JWT = [
  Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify({ sub: SUB })).toString('base64url'),
  'sig_not_verified',
].join('.')
const authedRequest = (url = API_URL) =>
  new Request(url, { headers: { Authorization: `Bearer ${AUTH_JWT}` } })
const PAYLOAD = [{ id: 'p1', view_url: 'https://s3/p1?X-Amz-Signature=old' }]

const keyOf = (r) => (typeof r === 'string' ? r : r.url)
const jsonRes = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })

function makeCaches() {
  const store = new Map()
  const bucket = (name) => {
    if (!store.has(name)) store.set(name, new Map())
    return store.get(name)
  }
  const wrap = (name) => {
    const m = bucket(name)
    return {
      match: async (req) => { const r = m.get(keyOf(req)); return r ? r.clone() : undefined },
      put: async (req, res) => { m.set(keyOf(req), res) },
      keys: async () => [...m.keys()],
      delete: async (req) => m.delete(keyOf(req)),
    }
  }
  return {
    open: async (name) => wrap(name),
    // Global match — deliberately searches EVERY bucket, which is exactly the over-broad behaviour
    // networkFirst must no longer rely on (see the cache-scoping test).
    match: async (req) => { for (const m of store.values()) { const r = m.get(keyOf(req)); if (r) return r.clone() } return undefined },
    keys: async () => [...store.keys()],
    delete: async (name) => store.delete(name),
    bucket,
  }
}

function loadSW(fetchImpl) {
  const listeners = {}
  const selfStub = {
    addEventListener: (type, handler) => { listeners[type] = handler },
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() },
  }
  const cachesStub = makeCaches()
  const factory = new Function(
    'self', 'caches', 'fetch', 'Response', 'Request', 'Headers', 'URL',
    'AbortController', 'setTimeout', 'clearTimeout', 'atob', 'TextDecoder', 'Uint8Array',
    // V4-SWCACHEID-001: API_CACHE no longer exists as a single constant — the cache is chosen per
    // subject. `API_CACHE` below is THIS test's subject partition, derived by the real
    // apiCacheNameFor so the name can never drift from the one sw.js computes at runtime.
    `${SRC}\nreturn { networkFirst, navigationFallback, markFromCache, STATIC_CACHE, FROM_CACHE_HEADER,`
    + ` CACHE_VERSION, subFromAuthHeader, apiCacheNameFor, keepCacheKey,`
    + ` API_CACHE: apiCacheNameFor(CACHE_VERSION, ${JSON.stringify(SUB)}) }`,
  )
  const api = factory(
    selfStub, cachesStub, fetchImpl, Response, Request, Headers, URL,
    AbortController, setTimeout, clearTimeout, atob, TextDecoder, Uint8Array,
  )
  return { ...api, caches: cachesStub, listeners }
}

/**
 * networkFirst defers its cache write onto event.waitUntil. Direct callers below pass this fake
 * event so the write is awaitable instead of racing the assertion.
 */
function withWrites() {
  const waits = []
  return { event: { waitUntil: (p) => waits.push(p) }, settle: () => Promise.all(waits) }
}

// Network stub with a switchable failure mode. `offline` models fetch rejecting outright (no radio);
// `timeout` models the AbortError that fetchWithTimeout converts into a TimeoutError — same object the
// real AbortController produces, so no fake timers are needed to reach that branch deterministically.
function net() {
  const state = { mode: 'online', body: PAYLOAD, calls: 0 }
  const impl = vi.fn(async () => {
    state.calls++
    if (state.mode === 'offline') throw new TypeError('Failed to fetch')
    if (state.mode === 'timeout') throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    return jsonRes(state.body)
  })
  return { state, impl }
}

async function warmCache(sw, n) {
  n.state.mode = 'online'
  const w = withWrites()
  const res = await sw.networkFirst(new Request(API_URL), sw.API_CACHE, w.event)
  await res.json()
  await w.settle()
  return res
}

describe('sw.js networkFirst — offline cache fallback is marked (SW-STALEAPI-001)', () => {
  it('a live network response is NOT marked', async () => {
    const n = net()
    const sw = loadSW(n.impl)
    const res = await sw.networkFirst(new Request(API_URL), sw.API_CACHE)
    expect(res.status).toBe(200)
    expect(res.headers.get('X-From-Cache')).toBeNull()
    expect(await res.json()).toEqual(PAYLOAD)
  })

  it('an OFFLINE fetch serves the cached body as a 200 stamped X-From-Cache', async () => {
    const n = net()
    const sw = loadSW(n.impl)
    await warmCache(sw, n)

    n.state.mode = 'offline'
    const res = await sw.networkFirst(new Request(API_URL), sw.API_CACHE)

    // Still 200 by design: the body is the user's real data and SWR must keep serving it offline.
    expect(res.status).toBe(200)
    expect(res.headers.get('X-From-Cache')).toBe('1')
    // Content-Type must survive the rebuild or res.json() consumers get a surprise.
    expect(res.headers.get('Content-Type')).toContain('application/json')
    expect(await res.json()).toEqual(PAYLOAD)
  })

  it('an OFFLINE fetch with nothing cached is a 503 (not a silent empty 200)', async () => {
    const n = net()
    const sw = loadSW(n.impl)
    n.state.mode = 'offline'
    const res = await sw.networkFirst(new Request(API_URL), sw.API_CACHE)
    expect(res.status).toBe(503)
    expect(res.headers.get('X-From-Cache')).toBeNull()
  })

  // V4-APIGZIP-001 — /api/plants now negotiates gzip, so a cached API entry can carry the transport
  // headers the network layer put on it. The Cache API stores the DECODED body, so those headers
  // describe bytes that are no longer there and must not survive the rebuild.
  it('an OFFLINE replay drops Content-Encoding/Content-Length from a gzip-negotiated entry', async () => {
    const n = net()
    const sw = loadSW(n.impl)
    // What Chrome hands the SW for a gzipped response: decoded body, encoding headers intact,
    // Content-Length still describing the COMPRESSED bytes.
    n.impl.mockImplementationOnce(async () => new Response(JSON.stringify(PAYLOAD), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
        'Content-Length': '97',
        Vary: 'Accept-Encoding, Origin',
      },
    }))
    await warmCache(sw, n)

    n.state.mode = 'offline'
    const res = await sw.networkFirst(new Request(API_URL), sw.API_CACHE)

    expect(res.headers.get('X-From-Cache')).toBe('1')
    expect(res.headers.get('Content-Encoding')).toBeNull()
    expect(res.headers.get('Content-Length')).toBeNull()
    // Vary is NOT transport — it must survive, and the body must still parse.
    expect(res.headers.get('Vary')).toBe('Accept-Encoding, Origin')
    expect(await res.json()).toEqual(PAYLOAD)
  })

  it('a TIMEOUT still refuses the cache and returns 504, even with a warm entry (WS-A6 preserved)', async () => {
    const n = net()
    const sw = loadSW(n.impl)
    await warmCache(sw, n)

    n.state.mode = 'timeout'
    const res = await sw.networkFirst(new Request(API_URL), sw.API_CACHE)
    expect(res.status).toBe(504)
    expect(await res.text()).toBe('Gateway Timeout')
  })

  it('the offline lookup is scoped to the API cache — a same-URL static entry never leaks', async () => {
    const n = net()
    const sw = loadSW(n.impl)
    // Decoy in the WRONG bucket. The old global caches.match() would have served this.
    ;(await sw.caches.open(sw.STATIC_CACHE)).put(new Request(API_URL), jsonRes([{ id: 'WRONG' }]))

    n.state.mode = 'offline'
    const res = await sw.networkFirst(new Request(API_URL), sw.API_CACHE)
    expect(res.status).toBe(503)
  })

  it('marking a null-body cached status (204) does not throw', async () => {
    const n = net()
    const sw = loadSW(n.impl)
    ;(await sw.caches.open(sw.API_CACHE)).put(new Request(API_URL), new Response(null, { status: 204 }))

    n.state.mode = 'offline'
    const res = await sw.networkFirst(new Request(API_URL), sw.API_CACHE)
    expect(res.status).toBe(204)
    expect(res.headers.get('X-From-Cache')).toBe('1')
  })

  it('the fetch listener routes a Lambda-origin GET through networkFirst and marks it offline', async () => {
    const n = net()
    const sw = loadSW(n.impl)
    await warmCache(sw, n)

    n.state.mode = 'offline'
    // Bears SUB's token: the listener derives the partition from this header, and warmCache seeded
    // exactly that partition. An unauthenticated request here would correctly 503 (fail closed).
    const event = { request: authedRequest(), respondWith: vi.fn(), waitUntil: vi.fn() }
    sw.listeners.fetch(event)
    expect(event.respondWith).toHaveBeenCalledTimes(1)
    const res = await event.respondWith.mock.calls[0][0]
    expect(res.status).toBe(200)
    expect(res.headers.get('X-From-Cache')).toBe('1')
    expect(await res.json()).toEqual(PAYLOAD)
  })

  it('the header name the SW writes is the one src/lib/api.js reads', async () => {
    const { FROM_CACHE_HEADER } = await import('../lib/api.js')
    const sw = loadSW(net().impl)
    expect(sw.FROM_CACHE_HEADER).toBe(FROM_CACHE_HEADER)
  })
})
