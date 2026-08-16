// V4-PHOTOSWHARDEN-001 — EXECUTABLE coverage of the cache-poisoning guards in public/sw.js.
//
// Uses the swHarness (same as sw.characterization.test.js), which evaluates the REAL bytes of
// public/sw.js in a vm sandbox and drives the REAL fetch/activate listeners. Not string matching
// (swImageCache.test.js already pins the source shape) and not a reimplementation — the meta-test
// in sw.characterization.test.js is the standing proof that mutating the on-disk file changes what
// is observed here.
//
// THE BUG: isImage() classifies by URL EXTENSION. A captive portal, a login redirect, or S3's
// 200-index.html SPA fallback answers `photo.jpg` with an HTML body and a 200, cacheFirst stores it,
// and every later load is served from cache — the photo is permanently broken for that client with
// no network involved. Two halves must hold: refuse the write, and evict what a previous sw.js
// already wrote.
//
// Each assertion names the mutation that must break it. An assertion with no such mutation is
// vacuous by construction and does not belong here.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  loadServiceWorker, dispatchFetch, dispatchActivate, makeFakeCaches,
} from './helpers/swHarness.js'

const CACHE_VERSION = 'v16-20260524'
const API_CACHE = `api-${CACHE_VERSION}`
const STATIC_CACHE = `static-${CACHE_VERSION}`
const IMAGE_CACHE = `images-${CACHE_VERSION}`

const IMG_URL = 'https://garden.futureishere.net/critters/c155.png'
const JS_URL = 'https://garden.futureishere.net/assets/index-abc123.js'

const res = (body, type, status = 200) =>
  new Response(body, { status, headers: type ? { 'Content-Type': type } : {} })

/** The captive-portal / login-redirect / SPA-fallback shape: a 200, with HTML in it. */
const htmlRes = () => res('<!doctype html><title>Sign in</title>', 'text/html; charset=utf-8')

// A real opaque Response cannot be constructed in Node (the Response ctor rejects status 0), so this
// models the surface sw.js actually touches: type/status/headers/clone. A cross-origin <img> is a
// no-cors request, so this is what the SW really sees for an S3 photo.
const opaqueRes = () => ({
  type: 'opaque', status: 0, headers: new Headers(), clone() { return opaqueRes() },
})

const settle = async () => { await Promise.resolve(); await Promise.resolve() }

beforeEach(() => { vi.clearAllMocks() })

// ── (a) write-time guard: the image cache ─────────────────────────────────────────────────────
describe('imageCacheFirst — only real images are written to the image cache', () => {
  function run(response) {
    const caches = makeFakeCaches({ [IMAGE_CACHE]: {} })
    const sw = loadServiceWorker({ caches, fetchImpl: vi.fn(async () => response) })
    return { caches, sw }
  }

  it('an image/* 200 IS cached', async () => {
    // The positive control. Without it every "not cached" assertion below could pass because the
    // image cache is broken outright. Mutation: invert isImageResponse → this fails first.
    const { caches, sw } = run(res('PNGBYTES', 'image/png'))
    await dispatchFetch(sw, new Request(IMG_URL)).responded
    await settle()
    expect(caches.store.get(IMAGE_CACHE).entries.has(IMG_URL)).toBe(true)
  })

  it('a text/html 200 for an image URL is NOT cached', async () => {
    // The bug itself. Mutation: drop the isImageResponse() call in imageCacheFirst → the login page
    // is stored under photo.jpg and served cache-first forever.
    const { caches, sw } = run(htmlRes())
    await dispatchFetch(sw, new Request(IMG_URL)).responded
    await settle()
    expect(caches.store.get(IMAGE_CACHE).entries.size).toBe(0)
  })

  it('the refused response is still returned to the page, unaltered', async () => {
    // Refusing to CACHE a bad answer must not turn it into a DIFFERENT bad answer — PhotoImg's 403
    // heal reads the real status. Mutation: return a synthetic 503 on the guard-fail branch.
    const { sw } = run(htmlRes())
    const out = await dispatchFetch(sw, new Request(IMG_URL)).responded
    expect(out.status).toBe(200)
    expect(await out.text()).toContain('Sign in')
  })

  it('an S3/CloudFront 403 error body (application/xml) is NOT cached', async () => {
    // The other real-world poison: an expired presign returns XML with a 403.
    const { caches, sw } = run(res('<Error><Code>AccessDenied</Code></Error>', 'application/xml', 403))
    await dispatchFetch(sw, new Request(IMG_URL)).responded
    await settle()
    expect(caches.store.get(IMAGE_CACHE).entries.size).toBe(0)
  })

  it('an OPAQUE cross-origin response is NOT cached — its content-type is unreadable', async () => {
    // Deliberate, documented cost: cross-origin <img> photos are not offline-cached, because an
    // opaque body cannot be told apart from a login page. Mutation: drop the `type === 'opaque'`
    // test AND relax the status test → unverifiable bodies re-enter the cache.
    const { caches, sw } = run(opaqueRes())
    await dispatchFetch(sw, new Request('https://bucket.s3.amazonaws.com/photos/p1.jpg')).responded
    await settle()
    expect(caches.store.get(IMAGE_CACHE).entries.size).toBe(0)
  })
})

// ── (a) write-time guard: the sibling static cache ────────────────────────────────────────────
describe('cacheFirst — HTML never poisons a hashed static asset', () => {
  function run(response) {
    const caches = makeFakeCaches({ [STATIC_CACHE]: {} })
    const sw = loadServiceWorker({ caches, fetchImpl: vi.fn(async () => response) })
    return { caches, sw }
  }

  it('a real script IS cached', async () => {
    const { caches, sw } = run(res('export const a=1', 'application/javascript'))
    await dispatchFetch(sw, new Request(JS_URL)).responded
    await settle()
    expect(caches.store.get(STATIC_CACHE).entries.has(JS_URL)).toBe(true)
  })

  it('a text/html 200 for a .js URL is NOT cached', async () => {
    // A missing hashed chunk answered by the SPA index.html would otherwise be served cache-first
    // for the life of the cache name — the app boots broken with no network involved.
    // Mutation: drop `&& !isHtmlResponse(response)` → the shell is stored under the chunk URL.
    const { caches, sw } = run(htmlRes())
    await dispatchFetch(sw, new Request(JS_URL)).responded
    await settle()
    expect(caches.store.get(STATIC_CACHE).entries.size).toBe(0)
  })

  it('a font served as application/octet-stream is still cached (denylist, not allowlist)', async () => {
    // Guards the over-correction: an image-style allowlist here would silently stop caching real
    // assets, which is a performance regression that no test would otherwise catch.
    const url = 'https://garden.futureishere.net/assets/inter.woff2'
    const { caches, sw } = run(res('FONTBYTES', 'application/octet-stream'))
    await dispatchFetch(sw, new Request(url)).responded
    await settle()
    expect(caches.store.get(STATIC_CACHE).entries.has(url)).toBe(true)
  })
})

// ── (b) activate purge: evict what an earlier sw.js already wrote ─────────────────────────────
describe('activate purge — poisoned image entries are evicted, good ones survive', () => {
  const GOOD = 'https://garden.futureishere.net/critters/good.png'
  const POISON = 'https://garden.futureishere.net/critters/poisoned.png'
  const XML = 'https://garden.futureishere.net/critters/denied.png'
  const UNKNOWN = 'https://garden.futureishere.net/critters/unknown.png'

  // new Response(null) carries NO content-type — the stand-in for an entry an older sw.js stored
  // without readable headers. It must SURVIVE: unverifiable is not the same as proven-poison.
  const seed = () => makeFakeCaches({
    [STATIC_CACHE]: {}, [API_CACHE]: {},
    [IMAGE_CACHE]: {
      [GOOD]: res('PNGBYTES', 'image/png'),
      [POISON]: htmlRes(),
      [XML]: res('<Error/>', 'application/xml'),
      [UNKNOWN]: new Response(null, { status: 200 }),
    },
  })

  it('deletes the HTML entry and keeps the image entry', async () => {
    // Mutation: remove `.then(() => purgePoisonedImages())` from the activate chain → POISON
    // survives and the photo stays broken for every already-poisoned client.
    const caches = seed()
    const sw = loadServiceWorker({ caches })
    await dispatchActivate(sw)
    const entries = caches.store.get(IMAGE_CACHE).entries
    expect(entries.has(POISON)).toBe(false)
    expect(entries.has(GOOD)).toBe(true)
  })

  it('deletes an application/xml entry too — poison is not only text/html', async () => {
    const caches = seed()
    await dispatchActivate(loadServiceWorker({ caches }))
    expect(caches.store.get(IMAGE_CACHE).entries.has(XML)).toBe(false)
  })

  it('LEAVES an entry with no readable content-type alone', async () => {
    // The conservative half of the predicate. Mutation: change `if (type && !type.startsWith(...))`
    // to `if (!type.startsWith(...))` → header-less but perfectly good offline photos get wiped.
    const caches = seed()
    await dispatchActivate(loadServiceWorker({ caches }))
    expect(caches.store.get(IMAGE_CACHE).entries.has(UNKNOWN)).toBe(true)
  })

  it('never deletes the image cache wholesale — the offline story survives the sweep', async () => {
    // Mutation: "fix" poisoning with caches.delete(IMAGE_CACHE) → the cache is gone and every good
    // photo with it. This is the assertion that keeps the cheap wrong fix out.
    const caches = seed()
    await dispatchActivate(loadServiceWorker({ caches }))
    expect(caches.store.has(IMAGE_CACHE)).toBe(true)
    expect(caches.delete).not.toHaveBeenCalledWith(IMAGE_CACHE)
  })

  it('is idempotent — a second activation changes nothing further', async () => {
    const caches = seed()
    await dispatchActivate(loadServiceWorker({ caches }))
    const after1 = [...caches.store.get(IMAGE_CACHE).entries.keys()].sort()
    await dispatchActivate(loadServiceWorker({ caches }))
    expect([...caches.store.get(IMAGE_CACHE).entries.keys()].sort()).toEqual(after1)
    expect(after1).toEqual([GOOD, UNKNOWN].sort())
  })

  it('does not materialize an image cache that does not exist yet', async () => {
    // First activate on a brand-new client: the sweep must not create an empty images-* cache, or
    // the name-purge assertions in sw.characterization.test.js stop meaning what they say.
    const caches = makeFakeCaches({ [STATIC_CACHE]: {}, [API_CACHE]: {} })
    await dispatchActivate(loadServiceWorker({ caches }))
    expect(caches.store.has(IMAGE_CACHE)).toBe(false)
  })

  it('still claims clients when the sweep throws — activation is never blocked', async () => {
    // Mutation: drop the try/catch in purgePoisonedImages → a Cache API failure rejects the
    // waitUntil chain, clients.claim() never runs, and the new SW does not take over.
    const caches = seed()
    caches.store.get(IMAGE_CACHE).keys = vi.fn(async () => { throw new Error('QuotaExceeded') })
    const sw = loadServiceWorker({ caches })
    await dispatchActivate(sw)
    expect(sw.self.clients.claim).toHaveBeenCalled()
  })
})
