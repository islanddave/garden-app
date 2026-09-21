// BUG-SEEDTHUMBSOFFLINE-001 — src/lib/deviceThumb.js: find a thumb the phone already holds.
//
// Two halves. The unit half drives the lookup against a fake Cache Storage. The PAIRING half is the
// one that matters: it runs the REAL public/sw.js (swHarness evaluates its bytes) to store a thumb
// fetched through a realistic SDK presign, then asks the lookup for that object and fetches what it
// returns through a fresh service worker with the network mocked to a distinguishable body. If the
// page's idea of the cache key ever drifts from normalizeImageUrl's, the lookup misses (or the SW
// fetches from the network) and this fails — the two formats are held equal by behaviour, not by a
// copied constant.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { loadServiceWorker, dispatchFetch, makeFakeCaches } from './helpers/swHarness.js'
import {
  deviceThumbUrl, deviceThumbUrlFor, deviceThumbLookupPossible, __resetDeviceThumb,
} from '../lib/deviceThumb.js'

const HOST = 'https://garden-photos-prod.s3.us-east-1.amazonaws.com'
const KEY_A = 'thumbs/inventory/2d6df841-b507-4e65-8db0-97c8659df37c/0f2c1f6e-8a44-4f7e-9a1c-6b1f2d3e4a5b.jpg'
const KEY_B = 'thumbs/inventory/8c0b8a1e-1d2e-4a3b-9c4d-5e6f7a8b9c0d/aa11bb22-cc33-4d44-8e55-ff6677889900.jpg'
// What the SW stores under: the object URL with every X-Amz-* removed and the SDK's x-id kept.
const stored = (key) => `${HOST}/${key}?x-id=GetObject`
// What the SDK actually mints (checked against @aws-sdk/s3-request-presigner 2026-09-21).
const presign = (key, sig) => `${HOST}/${key}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD`
  + '&X-Amz-Credential=ASIAEXAMPLE%2F20260921%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20260921T140000Z'
  + `&X-Amz-Expires=900&X-Amz-Security-Token=TOKEN${sig}&X-Amz-Signature=${sig}&X-Amz-SignedHeaders=host&x-id=GetObject`
const jpeg = (body) => new Response(body, { status: 200, headers: { 'Content-Type': 'image/jpeg', Vary: 'Origin' } })

// The fake has no has(); give it one, as the real CacheStorage does.
function withHas(api) {
  api.has = vi.fn(async (name) => api.store.has(name))
  return api
}

let savedCaches
beforeEach(() => {
  __resetDeviceThumb()
  savedCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches')
})
afterEach(() => {
  if (savedCaches) Object.defineProperty(globalThis, 'caches', savedCaches)
  else delete globalThis.caches
})
const install = (api) => {
  Object.defineProperty(globalThis, 'caches', { configurable: true, writable: true, value: api })
  return api
}

describe('deviceThumbUrl — the lookup', () => {
  it('no Cache API at all (jsdom, an insecure origin): impossible, and null', async () => {
    delete globalThis.caches
    expect(deviceThumbLookupPossible()).toBe(false)
    expect(await deviceThumbUrl(KEY_A)).toBeNull()
  })

  it('no photos-v1 yet: null, and the cache is NOT created by asking', async () => {
    const api = install(withHas(makeFakeCaches()))
    expect(await deviceThumbUrl(KEY_A)).toBeNull()
    expect(api.open).not.toHaveBeenCalled()
    expect(api.store.has('photos-v1')).toBe(false)
  })

  it('a thumb the phone holds comes back as its exact cache key; one it lacks is null', async () => {
    install(withHas(makeFakeCaches({ 'photos-v1': { [stored(KEY_A)]: jpeg('A') } })))
    expect(await deviceThumbUrl(KEY_A)).toBe(stored(KEY_A))
    expect(await deviceThumbUrl(KEY_B)).toBeNull()
  })

  it('learns the origin and query from ANOTHER object in the cache, never from the one asked for', async () => {
    const api = install(withHas(makeFakeCaches({ 'photos-v1': { [stored(KEY_B)]: jpeg('B') } })))
    expect(await deviceThumbUrl(KEY_A)).toBeNull()          // taught by B, and A is not there
    await (await api.open('photos-v1')).put(stored(KEY_A), jpeg('A'))
    expect(await deviceThumbUrl(KEY_A)).toBe(stored(KEY_A)) // the template stuck; A is found now
  })

  it('refuses anything that is not a thumbs/ key — an original is never served from here', async () => {
    install(withHas(makeFakeCaches({ 'photos-v1': { [stored(KEY_A)]: jpeg('A') } })))
    for (const k of [null, undefined, '', KEY_A.replace(/^thumbs\//, ''), `/${KEY_A}`, 42]) {
      expect(await deviceThumbUrl(k)).toBeNull()
    }
  })

  it('a Cache Storage that throws answers null rather than faulting the row', async () => {
    install({ has: vi.fn(async () => { throw new Error('SecurityError') }), open: vi.fn() })
    expect(await deviceThumbUrl(KEY_A)).toBeNull()
  })

  it('encodes the key per path segment and keeps the slashes', () => {
    expect(deviceThumbUrlFor('thumbs/a b/c#d.jpg', { origin: HOST, search: '?x-id=GetObject' }))
      .toBe(`${HOST}/thumbs/a%20b/c%23d.jpg?x-id=GetObject`)
  })
})

describe('deviceThumbUrl ↔ public/sw.js — the key the page builds is the key the SW stored', () => {
  it('a thumb fetched once through the SW is found by key and then served with NO network', async () => {
    const caches = withHas(makeFakeCaches())
    // 1. The row's first-ever draw: PhotoImg's crossOrigin <img> fetches a real-shaped presign.
    const firstFetch = vi.fn(async () => jpeg('THUMB-A'))
    const sw1 = loadServiceWorker({ caches, fetchImpl: firstFetch })
    await dispatchFetch(sw1, new Request(presign(KEY_A, 'sig1'), { mode: 'cors' })).responded
    await new Promise((r) => setTimeout(r, 0))
    expect(firstFetch).toHaveBeenCalledTimes(1)

    // 2. A later visit, offline or not: the page asks the cache for the row's key.
    install(caches)
    const url = await deviceThumbUrl(KEY_A)
    expect(url).not.toBeNull()

    // 3. Drawing that url goes through a fresh SW and must be answered from photos-v1.
    const secondFetch = vi.fn(async () => jpeg('FROM-NETWORK'))
    const sw2 = loadServiceWorker({ caches, fetchImpl: secondFetch })
    const res = await dispatchFetch(sw2, new Request(url, { mode: 'cors' })).responded
    expect(secondFetch).not.toHaveBeenCalled()
    expect(await res.text()).toBe('THUMB-A')
  })
})
