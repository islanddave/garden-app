// V4-PHOTOCORS-001 — EXECUTABLE coverage of the photo cache, through swHarness (the REAL bytes of
// public/sw.js in a vm sandbox, driving the REAL fetch/activate listeners). Sibling to
// swCachePoisoning.test.js; swImageCache.test.js pins the source shape, this file pins behaviour.
//
// WHAT WAS BROKEN. The IMAGE_CACHE held ZERO photos. A photo <img> carried no crossOrigin, so it
// issued a no-cors request, the response came back opaque, and isImageResponse() refused it — as it
// should, an opaque body cannot be told apart from a login page. Nothing was cached, so the OTHER
// half of the bug was invisible: normalizeImageUrl stripped only CloudFront's signing params, and
// every photo URL is an S3 presign whose X-Amz-* params rotate on each 900s mint. Fix one without
// the other and you get, respectively, a cache that thrashes on a key that never repeats, or a strip
// with nothing to strip. Both land here together.
//
// ⚠ WHAT THIS FILE CANNOT PROVE — read before trusting a green run. makeFakeCache keys on the URL
// string ALONE. Real Cache Storage `match()` additionally honours the stored response's `Vary`
// header against the stored request, and S3 sends `Vary: Origin` (verified live 2026-08-26). The
// fixtures below carry that header so the shape is honest, but this harness ignores it, so a hit
// here is NOT evidence that a real browser hits. That claim needs real CacheStorage and is proven
// separately by scripts/photo-cors-probe.mjs against headless Chrome. Nothing in this file may be
// cited as the instrument for the Vary question.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { loadServiceWorker, dispatchFetch, dispatchActivate, makeFakeCaches } from './helpers/swHarness.js'

const CACHE_VERSION = 'v16-20260524'
const IMAGE_CACHE = `images-${CACHE_VERSION}`
const PHOTO_CACHE = 'photos-v1'

// The real shape, copied from a live presign of garden-photos-prod on 2026-08-26 (param names and
// order verified against the wire, not invented). Two mints of the SAME object differ in the date,
// the credential's date scope, the signature and the session token — i.e. in everything except the
// path, which is exactly why the full URL is a useless cache key.
const OBJ = 'https://garden-photos-prod.s3.us-east-1.amazonaws.com/thumbs/plants/014747a9-b824-4a0c-84cd-eca6fd4384aa/d30a7590-95bc-4085-8047-1802afb04678.jpg'
// The SAME photo's ORIGINAL — byte-identical URL minus the server-owned `thumbs/` prefix, which is
// the only thing that distinguishes the two objects. ~4.15 MB against the thumb's ~177 KB (measured
// prod medians, 2026-08-26). BUG-PHOTOCACHEUNGATED-001 is entirely about this key.
const FULL_OBJ = OBJ.replace('/thumbs/', '/')
const presignOf = (obj, date, sig) =>
  `${obj}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=ASIAEXAMPLE%2F${date}%2Fus-east-1%2Fs3%2Faws4_request` +
  `&X-Amz-Date=${date}T213345Z&X-Amz-Expires=900&X-Amz-SignedHeaders=host&X-Amz-Signature=${sig}` +
  `&X-Amz-Security-Token=FwoGEXAMPLE${sig}`
const presign = (date, sig) => presignOf(OBJ, date, sig)

const MINT_A = presign('20260826', 'aaaa1111')
const MINT_B = presign('20260827', 'bbbb2222')
const FULL_MINT = presignOf(FULL_OBJ, '20260826', 'cccc3333')

// A crossOrigin="anonymous" <img>. The Request constructor already defaults to 'cors', but spelling
// it out is the point of the test — this is the attribute's only observable at this layer.
const corsReq = (url) => new Request(url, { mode: 'cors' })
// A plain <img>: today's behaviour, and the flag-OFF behaviour after this change.
const noCorsReq = (url) => new Request(url, { mode: 'no-cors' })

// What S3 answers a CORS-mode GET with, verified live: 200, image/jpeg, and Vary: Origin.
const jpeg = (body = 'JPEG-A') => new Response(body, {
  status: 200, headers: { 'Content-Type': 'image/jpeg', Vary: 'Origin' },
})
// What a no-cors request gets back instead. Node cannot construct a status-0 Response, so this
// models the surface sw.js touches, exactly as swCachePoisoning.test.js does.
const opaqueRes = () => ({
  type: 'opaque', status: 0, headers: new Headers(), clone() { return opaqueRes() },
})

const settle = async () => { await Promise.resolve(); await Promise.resolve() }
// trimCache is deliberately fire-and-forget (`trimCache(...).catch(() => {})`), so its awaited
// open/keys/delete chain outlives `settle`. A macrotask turn is what actually drains it.
const settleTrim = async () => { await new Promise((r) => setTimeout(r, 0)); await settle() }

beforeEach(() => { vi.clearAllMocks() })

describe('photo cache — two presigns of one object', () => {
  it('the SECOND mint is served from cache, with no network at all', async () => {
    // THE HEADLINE. Fails before this change for a reason worth naming: MINT_B normalizes to a
    // different key than MINT_A, so it misses, and (before the crossOrigin half) MINT_A was never
    // stored in the first place.
    const caches = makeFakeCaches()

    const firstFetch = vi.fn(async () => jpeg('JPEG-A'))
    const sw1 = loadServiceWorker({ caches, fetchImpl: firstFetch })
    const first = await dispatchFetch(sw1, corsReq(MINT_A)).responded
    await settle()
    expect(firstFetch).toHaveBeenCalledTimes(1)
    expect(await first.text()).toBe('JPEG-A')

    // Second page load: same persistent Cache Storage, a fresh SW, a DIFFERENT presign. The network
    // mock returns a distinguishable body so this asserts WHICH response was served rather than
    // inferring it from a call count — a miss would surface as 'JPEG-FROM-NETWORK', not as silence.
    const secondFetch = vi.fn(async () => jpeg('JPEG-FROM-NETWORK'))
    const sw2 = loadServiceWorker({ caches, fetchImpl: secondFetch })
    const second = await dispatchFetch(sw2, corsReq(MINT_B)).responded
    await settle()
    expect(secondFetch).not.toHaveBeenCalled()
    expect(await second.text()).toBe('JPEG-A')
  })

  it('stores it under the bare object URL — path kept, every X-Amz-* dropped', async () => {
    // Mutation: drop the PRESIGN_PARAM_PREFIX loop → the key is the full presigned URL and the test
    // above stops hitting. Asserting the key itself (not just "a hit happened") is what makes the
    // failure legible when it does break.
    const caches = makeFakeCaches()
    const sw = loadServiceWorker({ caches, fetchImpl: vi.fn(async () => jpeg()) })
    await dispatchFetch(sw, corsReq(MINT_A)).responded
    await settle()
    expect([...caches.store.get(PHOTO_CACHE).entries.keys()]).toEqual([OBJ])
  })

  it('keeps a non-signing query param — it strips presigns, not query strings', async () => {
    // The over-correction guard. Stripping the whole query would collide two genuinely different
    // objects onto one key, which is a wrong-photo bug rather than a missing-photo bug.
    const caches = makeFakeCaches()
    const sw = loadServiceWorker({ caches, fetchImpl: vi.fn(async () => jpeg()) })
    await dispatchFetch(sw, corsReq(`${MINT_A}&v=2`)).responded
    await settle()
    expect([...caches.store.get(PHOTO_CACHE).entries.keys()]).toEqual([`${OBJ}?v=2`])
  })
})

describe('photo cache — the two halves are coupled by request mode', () => {
  it('a no-cors request does NOT read the stripped key', async () => {
    // The coupling proof, and the reason the SW half needs no flag of its own: a plain <img> (flag
    // off, or a bundle older than this SW) must still compute the FULL url as its key, because its
    // response is opaque and unverifiable and serving it a stripped-key entry would be the
    // half-state the design forbids.
    //
    // The seed goes in IMAGE_CACHE, which is the cache a no-cors request actually opens — and that
    // detail is the whole test. An earlier draft seeded PHOTO_CACHE and claimed this same mutation,
    // but a no-cors request never opens that cache at all, so it missed for the ROUTING reason and
    // would have passed against a normalizeImageUrl that stripped unconditionally. It was proving
    // the line below it. Mutation, verified: pass `true` instead of `cors` to normalizeImageUrl →
    // MINT_B normalizes onto the seeded key, the fetch never happens, and this fails.
    const caches = makeFakeCaches({ [IMAGE_CACHE]: { [OBJ]: jpeg('JPEG-A') } })
    const netFetch = vi.fn(async () => opaqueRes())
    const sw = loadServiceWorker({ caches, fetchImpl: netFetch })
    const out = await dispatchFetch(sw, noCorsReq(MINT_B)).responded
    await settle()
    expect(netFetch).toHaveBeenCalledTimes(1)
    expect(out.type).toBe('opaque')            // it really went to the network, not to the seed
  })

  it('a no-cors opaque response is still refused, so nothing half-caches', async () => {
    // isImageResponse()'s opaque refusal is NOT relaxed by any of this — it is satisfied instead, by
    // asking for the photo in CORS mode. swCachePoisoning.test.js owns the guard; this asserts the
    // guard still governs the path this change added.
    const caches = makeFakeCaches()
    const sw = loadServiceWorker({ caches, fetchImpl: vi.fn(async () => opaqueRes()) })
    await dispatchFetch(sw, noCorsReq(MINT_A)).responded
    await settle()
    expect(caches.store.has(PHOTO_CACHE)).toBe(false)
    expect(caches.store.get(IMAGE_CACHE)?.entries.size ?? 0).toBe(0)
  })

  it('photos and app images land in DIFFERENT caches', async () => {
    // A same-origin critter SVG is a no-cors request and belongs in the version-purged app cache;
    // only a CORS photo reaches the stable one. Mutation: collapse the two names → the un-hashed
    // public/ images inherit the photo cache's immortality.
    const caches = makeFakeCaches()
    const sw = loadServiceWorker({ caches, fetchImpl: vi.fn(async () => jpeg('PNG')) })
    await dispatchFetch(sw, corsReq(MINT_A)).responded
    await dispatchFetch(sw, noCorsReq('https://garden.futureishere.net/critters/c155.png')).responded
    await settle()
    expect([...caches.store.get(PHOTO_CACHE).entries.keys()]).toEqual([OBJ])
    expect([...caches.store.get(IMAGE_CACHE).entries.keys()])
      .toEqual(['https://garden.futureishere.net/critters/c155.png'])
  })
})

// BUG-PHOTOCACHEUNGATED-001 — the photo cache accepts thumbs/ keys ONLY.
//
// The bug: PHOTO_CORS_CACHE_ENABLED gates the <img> half only. sw.js cannot import it, so it reads
// `request.mode === 'cors'` instead — and the /today share composer's own fetch is a cors request
// that no flag ever touched, carrying a TIER.FULL original. Every one of those was written to
// photos-v1 in prod v4.57.0 with the flag OFF, at ~4.15 MB against a 500-entry COUNT cap.
describe('photo cache — thumbs only, in and out', () => {
  it('refuses to store a FULL original, and still returns it to the page', async () => {
    // THE HEADLINE FOR THIS BUG. The response must be delivered unmodified — refusing to cache a
    // 4 MB photo may not turn it into a missing photo. Mutation: drop the `storable` guard in
    // imageCacheFirst → the original lands in photos-v1 and the size assertion below fails.
    const caches = makeFakeCaches()
    const netFetch = vi.fn(async () => jpeg('ORIGINAL-BYTES'))
    const sw = loadServiceWorker({ caches, fetchImpl: netFetch })
    const out = await dispatchFetch(sw, corsReq(FULL_MINT)).responded
    await settle()
    expect(netFetch).toHaveBeenCalledTimes(1)
    expect(await out.text()).toBe('ORIGINAL-BYTES')
    expect(caches.store.get(PHOTO_CACHE)?.entries.size ?? 0).toBe(0)
    expect(caches.store.get(IMAGE_CACHE)?.entries.size ?? 0).toBe(0)   // nor does it fall into the app cache
  })

  it('the share composer\'s own fetch shape is the one refused', async () => {
    // Not a paraphrase of the mechanism — the literal call from src/lib/harvestPostPhotos.js:83,
    // `fetch(url, { credentials: 'omit' })` with NO mode. `mode` DEFAULTS to 'cors', which is the
    // entire reason a flag-off build was writing originals. If a future Request default ever made
    // this no-cors, this case would stop exercising the photo branch at all — so it asserts the
    // mode it depends on rather than assuming it.
    const composerReq = new Request(FULL_MINT, { credentials: 'omit' })
    expect(composerReq.mode).toBe('cors')
    const caches = makeFakeCaches()
    const sw = loadServiceWorker({ caches, fetchImpl: vi.fn(async () => jpeg('ORIGINAL-BYTES')) })
    await dispatchFetch(sw, composerReq).responded
    await settle()
    expect(caches.store.get(PHOTO_CACHE)?.entries.size ?? 0).toBe(0)
  })

  it('still stores the thumb — the guard is a filter, not an off switch', async () => {
    // The over-correction guard. A predicate that refused everything would "fix" the leak by
    // deleting the feature, and every hit test above would still pass for the wrong reason.
    const caches = makeFakeCaches()
    const sw = loadServiceWorker({ caches, fetchImpl: vi.fn(async () => jpeg()) })
    await dispatchFetch(sw, corsReq(MINT_A)).responded
    await settle()
    expect([...caches.store.get(PHOTO_CACHE).entries.keys()]).toEqual([OBJ])
  })

  it('a full original already in the cache is still SERVED — reads are not gated', async () => {
    // Bytes an older sw.js already paid for are free to serve. Gating the read as well would spend
    // 4 MB re-downloading something already on the device, on the way to deleting it.
    const caches = makeFakeCaches({ [PHOTO_CACHE]: { [FULL_OBJ]: jpeg('ALREADY-PAID') } })
    const netFetch = vi.fn(async () => jpeg('FROM-NETWORK'))
    const sw = loadServiceWorker({ caches, fetchImpl: netFetch })
    const out = await dispatchFetch(sw, corsReq(FULL_MINT)).responded
    await settle()
    expect(netFetch).not.toHaveBeenCalled()
    expect(await out.text()).toBe('ALREADY-PAID')
  })

  it('activate evicts the originals prod already wrote, and keeps the thumbs', async () => {
    // The write rule alone leaves a shipped device holding whatever v4.57.0 put there FOREVER:
    // photos-v1 carries no CACHE_VERSION, so the name purge never reaches it, purgePoisonedImages
    // sees a perfectly valid image/jpeg, and FIFO trim only bites after 500 more thumbs arrive.
    // Mutation: drop evictNonThumbPhotos() from the activate chain → FULL_OBJ survives here.
    const caches = makeFakeCaches({
      [PHOTO_CACHE]: { [FULL_OBJ]: jpeg('4MB-ORIGINAL'), [OBJ]: jpeg('177KB-THUMB') },
    })
    await dispatchActivate(loadServiceWorker({ caches }))
    const entries = caches.store.get(PHOTO_CACHE).entries
    expect(entries.has(FULL_OBJ)).toBe(false)
    expect(entries.has(OBJ)).toBe(true)
  })

  it('the eviction pass does not materialize photos-v1 on a first activate', async () => {
    // Matches purgePoisonedImages' own contract. Creating an empty cache on every activate of a
    // client that has never cached a photo is pure churn, and it would mask a "was it ever written"
    // question later.
    const caches = makeFakeCaches({ [IMAGE_CACHE]: {} })
    await dispatchActivate(loadServiceWorker({ caches }))
    expect(caches.store.has(PHOTO_CACHE)).toBe(false)
  })
})

describe('photo cache — it outlives a deploy, and it is sized for the photo working set', () => {
  it('survives an activate that purges a stale version-keyed image cache', async () => {
    // The de-versioning proof. CACHE_VERSION is rewritten on every deploy (several a day), so a
    // version-keyed photo cache is deleted before it repays the requests that filled it.
    // Mutation: remove the PHOTO_CACHE_NAME clause from keepCacheKey → photos-v1 is swept here.
    const caches = makeFakeCaches({
      [PHOTO_CACHE]: { [OBJ]: jpeg('JPEG-A') },
      [IMAGE_CACHE]: {},
      'images-v15-OLD': {},
      'static-v15-OLD': {},
    })
    await dispatchActivate(loadServiceWorker({ caches }))
    expect(caches.store.has(PHOTO_CACHE)).toBe(true)
    expect(caches.store.get(PHOTO_CACHE).entries.has(OBJ)).toBe(true)
    expect(caches.store.has('images-v15-OLD')).toBe(false)
    expect(caches.store.has('static-v15-OLD')).toBe(false)
  })

  it('the poison sweep reaches the photo cache — its only invalidation', async () => {
    // IMAGE_CACHE also gets the all-or-nothing name purge whenever CACHE_VERSION moves. The photo
    // cache is stable, so this per-entry pass is the whole eviction story for a provably-wrong
    // entry. Mutation: revert the sweep to IMAGE_CACHE only → poison in photos-v1 is immortal.
    const good = `${OBJ}#good`
    const html = new Response('<!doctype html><title>Sign in</title>', {
      status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
    const caches = makeFakeCaches({ [PHOTO_CACHE]: { [OBJ]: html, [good]: jpeg() } })
    await dispatchActivate(loadServiceWorker({ caches }))
    const entries = caches.store.get(PHOTO_CACHE).entries
    expect(entries.has(OBJ)).toBe(false)
    expect(entries.has(good)).toBe(true)
  })

  it('trims at 500 entries, not the app cache\'s 150', async () => {
    // MEASURED sizing, not a round number: thumbs/plants/ is 405 objects / 66.0 MB on prod
    // (2026-08-26) and the Garden list fires 176 image requests on one paint. Feeding 405 objects
    // through a 150-slot FIFO evicts continuously — a cache that hits sometimes and thrashes
    // constantly reads as partial success and is worse than the honest zero it replaces.
    // Mutation: pass MAX_IMAGE_ENTRIES here → the cache lands at 150 and this fails loudly.
    const seeded = {}
    for (let i = 0; i < 500; i++) seeded[`${OBJ}?seed=${i}`] = jpeg()
    const caches = makeFakeCaches({ [PHOTO_CACHE]: seeded })
    const sw = loadServiceWorker({ caches, fetchImpl: vi.fn(async () => jpeg()) })
    await dispatchFetch(sw, corsReq(MINT_A)).responded
    await settleTrim()
    const entries = caches.store.get(PHOTO_CACHE).entries
    expect(entries.size).toBe(500)              // one in, exactly one evicted
    expect(entries.has(OBJ)).toBe(true)         // the newcomer is kept
    expect(entries.has(`${OBJ}?seed=0`)).toBe(false)  // FIFO: the oldest went
    expect(entries.has(`${OBJ}?seed=1`)).toBe(true)
  })
})
