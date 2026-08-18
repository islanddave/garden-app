// SW test harness — Slice 0 of the SW API-cache remediation (design V100).
//
// THE WHOLE POINT: this evaluates the REAL BYTES of public/sw.js. It does not import a parallel
// implementation, and it does not re-declare the logic under test. `public/sw.js` is an unbundled
// classic script served raw to the browser, so it cannot be `import`ed — instead it is read from
// disk and run through node's `vm` in a sandbox whose globals are the ones a ServiceWorkerGlobalScope
// actually provides. `swMutationIsObservable` in the characterization suite is the meta-assertion
// proving this: mutate the on-disk source and the observed behaviour must change. Without that
// proof, every SW test here could be passing against a reimplementation — which is exactly the
// failure class this codebase has already produced twice.
//
// Deliberately NOT covered: real Cache Storage persistence, real SW lifecycle/termination, real
// quota. jsdom has no CacheStorage and no fetch events. Those remain device-gated.
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { vi } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const SW_SRC_PATH = path.resolve(HERE, '../../../public/sw.js')

export function readSwSource() {
  return fs.readFileSync(SW_SRC_PATH, 'utf8')
}

// Cache keys are URL strings. The real Cache API keys on URL (+ method/Vary); sw.js only ever
// caches GETs, so URL alone is faithful for these tests. Insertion order is preserved by Map,
// which is what makes it a valid stand-in for `cache.keys()` FIFO ordering.
const keyOf = (req) => (typeof req === 'string' ? req : req.url)

export function makeFakeCache(name) {
  const entries = new Map()
  return {
    name,
    entries,
    put: vi.fn(async (req, res) => { entries.set(keyOf(req), res) }),
    match: vi.fn(async (req) => entries.get(keyOf(req))),
    keys: vi.fn(async () => [...entries.keys()].map((u) => ({ url: u }))),
    delete: vi.fn(async (req) => entries.delete(keyOf(req))),
  }
}

export function makeFakeCaches(seed = {}) {
  const store = new Map()
  for (const [name, pairs] of Object.entries(seed)) {
    const c = makeFakeCache(name)
    for (const [url, res] of Object.entries(pairs)) c.entries.set(url, res)
    store.set(name, c)
  }
  const api = {
    store,
    open: vi.fn(async (name) => {
      if (!store.has(name)) store.set(name, makeFakeCache(name))
      return store.get(name)
    }),
    keys: vi.fn(async () => [...store.keys()]),
    delete: vi.fn(async (name) => store.delete(name)),
    match: vi.fn(async (req) => {
      for (const c of store.values()) {
        const hit = await c.match(req)
        if (hit) return hit
      }
      return undefined
    }),
  }
  return api
}

/**
 * Evaluate public/sw.js (or a mutated copy of its source) in a sandbox.
 * Returns the registered listeners plus the mocks, so a test can drive real handlers.
 */
export function loadServiceWorker({ source, fetchImpl, caches: cachesImpl } = {}) {
  const src = source ?? readSwSource()
  const listeners = {}
  const fetchMock = fetchImpl ?? vi.fn(async () => new Response('{}', { status: 200 }))
  const cachesMock = cachesImpl ?? makeFakeCaches()

  const self = {
    addEventListener: vi.fn((type, fn) => { (listeners[type] ||= []).push(fn) }),
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn(), matchAll: vi.fn(async () => []) },
    registration: {},
    location: new URL('https://garden.futureishere.net/sw.js'),
  }

  const sandbox = {
    self, caches: cachesMock, fetch: fetchMock,
    Response, Request, Headers, URL, AbortController,
    setTimeout, clearTimeout, console,
    // Present in a real ServiceWorkerGlobalScope; needed by subFromAuthHeader's JWT payload decode.
    atob, TextDecoder, Uint8Array, JSON,
  }
  sandbox.globalThis = sandbox
  vm.runInNewContext(src, sandbox, { filename: SW_SRC_PATH })

  return { listeners, self, caches: cachesMock, fetch: fetchMock, sandbox }
}

/** Drive the real fetch listener. `responded` is null when the handler declined the request. */
export function dispatchFetch(sw, request) {
  let responded = null
  const waits = []
  const event = {
    request,
    respondWith: vi.fn((p) => { responded = p }),
    waitUntil: vi.fn((p) => { waits.push(p) }),
  }
  for (const fn of sw.listeners.fetch ?? []) fn(event)
  return { responded, waits, event }
}

/** Drive the real activate listener and settle whatever it passed to waitUntil. */
export async function dispatchActivate(sw) {
  const waits = []
  const event = { waitUntil: vi.fn((p) => { waits.push(p) }) }
  for (const fn of sw.listeners.activate ?? []) fn(event)
  await Promise.all(waits)
  return { waits, event }
}

export const LAMBDA_URL = (p = '/api/plants') =>
  `https://abc123.lambda-url.us-east-1.on.aws${p}`

/**
 * An UNSIGNED JWT carrying `sub`. Unsigned on purpose: sw.js does not verify the token, and a test
 * that supplied a signed one would imply a verification step that does not exist. Payload is
 * base64URL (`-`/`_`, unpadded) exactly as a real Clerk token encodes it.
 */
export function jwtWithSub(sub, extraClaims = {}) {
  const b64url = (obj) =>
    Buffer.from(JSON.stringify(obj), 'utf8').toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({ sub, ...extraClaims })}.sig_not_verified`
}

/** A GET at the Lambda origin, optionally bearing `sub`'s token. No token => no header at all. */
export function apiRequest(sub, path = '/api/plants') {
  const headers = sub ? { Authorization: `Bearer ${jwtWithSub(sub)}` } : {}
  return new Request(LAMBDA_URL(path), { method: 'GET', headers })
}

/** A rejection shaped like a real offline failure (fetch rejects with TypeError). */
export const offlineError = () => new TypeError('Failed to fetch')

/** A rejection shaped like an aborted request (page abort OR the SW's own timeout controller). */
export const abortError = () => {
  const e = new Error('The operation was aborted')
  e.name = 'AbortError'
  return e
}
