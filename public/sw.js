// Hand-rolled service worker — no vite-plugin-pwa
// Cache-first for static assets, network-first for Lambda API calls.
// CACHE_VERSION should be updated with each deploy for cache-busting.

const CACHE_VERSION = 'v16-20260524' // base default — deploy workflows rewrite this to v{version}-{sha} per deploy for cache-busting (deploy.yml / deploy-staging.yml). Frozen value caused stale-footer bug (2.1.1 fix).
const STATIC_CACHE  = `static-${CACHE_VERSION}`
// V4-SWCACHEID-001: the API cache is no longer ONE cache. It is one cache PER SIGNED-IN SUBJECT,
// named by apiCacheNameFor() below, because a single shared `api-*` cache served the previous
// user's bodies to whoever held the device next — including a signed-OUT device, which needs no
// credential at all to read them. There is deliberately no API_CACHE constant any more: a single
// name is the defect, and leaving one in scope invites a future edit to reach for it.
// V4-PHOTOCDN-001 P2 (supersedes V3-CACHE-001): image cache is now VERSIONED and purged
// on activate. The old unversioned garden-images cache persisted stale/poisoned entries forever
// (excluded from purge), and per-request presigned URLs rotate the query string so entries
// almost never re-matched anyway — pure growth, no hits. Versioning costs little and kills
// the poison-persistence class. Content-type guard + signing-param normalization below.
const IMAGE_CACHE   = `images-${CACHE_VERSION}`
const MAX_IMAGE_ENTRIES = 150

const LAMBDA_ORIGIN = 'lambda-url.us-east-1.on.aws'

/* SW-MIRROR-START — byte-identical copy lives in public/sw.js; gate:sw-mirror enforces it */
// Clerk subs are opaque `user_<base58>` strings. VALIDATE rather than sanitize-and-truncate:
// truncation would let two distinct subs share a partition, and a sanitizer that rewrites a bad
// sub into a valid-looking one fails TOWARD a shared partition. An unrecognised shape returns
// null, and null means "no cache at all" (fail closed), never a shared 'anon' bucket.
const SW_SUB_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

// Extract the `sub` claim from an `Authorization: Bearer <jwt>` header. Total function: every
// malformed input returns null rather than throwing, because this runs inside the fetch handler
// and a throw there fails the request rather than falling back to the network.
function subFromAuthHeader(header) {
  if (typeof header !== 'string') return null
  const match = /^Bearer\s+(\S+)$/.exec(header)
  if (!match) return null
  const parts = match[1].split('.')
  if (parts.length !== 3) return null
  let claims
  try {
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    while (b64.length % 4) b64 += '='
    const bin = atob(b64)
    // Decode as UTF-8 rather than trusting atob's binary string: a non-ASCII claim elsewhere in
    // the payload would otherwise corrupt JSON.parse and lose an otherwise-valid sub.
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    claims = JSON.parse(new TextDecoder().decode(bytes))
  } catch { return null }
  const sub = claims && claims.sub
  if (typeof sub !== 'string' || !SW_SUB_PATTERN.test(sub)) return null
  return sub
}

// null sub => null name => caller performs NO cache read and NO cache write.
function apiCacheNameFor(version, sub) {
  if (typeof version !== 'string' || !version) return null
  if (typeof sub !== 'string' || !SW_SUB_PATTERN.test(sub)) return null
  return `api-${version}-u-${sub}`
}

// Predicate replacing the old equality allowlist. The allowlist deleted every key not exactly
// equal to the three constants, so any per-sub name self-destructed on every activation. Note the
// BARE `api-${version}` is deliberately NOT kept: unsegmented entries must not survive the upgrade
// that exists to remove them.
function keepCacheKey(key, version) {
  if (typeof key !== 'string' || typeof version !== 'string' || !version) return false
  if (key === `static-${version}` || key === `images-${version}`) return true
  const prefix = `api-${version}-u-`
  if (key.startsWith(prefix)) return SW_SUB_PATTERN.test(key.slice(prefix.length))
  return false
}
/* SW-MIRROR-END */

// SW-STALEAPI-001. Header stamped on an API response served from the offline cache instead of the
// network. Read by src/lib/api.js, which turns it into a marker on the parsed value; src/lib/dataCache.js
// then commits the data WITHOUT advancing its freshness clock.
//
// WHY THIS EXISTS — do not "simplify" it away. Every /api/* route resolves to the Lambda origin and is
// therefore in the API cache, so an offline API fetch does NOT surface as an error anywhere: networkFirst's
// catch returned the cached body verbatim as a plain 200. That 200 passed api.js's `!res.ok` guard,
// reached dataCache's success branch, and committed `at: Date.now()`. Two failures followed: a failed
// refresh was indistinguishable from a successful one at every layer above this file, and the refreshed
// `at` made revalidateLive(RESUME_MIN_AGE_MS) SKIP the next legitimate wake revalidation — the app
// avoided refetching for 5 minutes precisely because it had just failed to fetch.
const FROM_CACHE_HEADER = 'X-From-Cache'

// Re-emit a cached response carrying FROM_CACHE_HEADER. Headers on a Response handed back by the Cache
// API are immutable, so the response must be rebuilt rather than mutated. Null-body statuses (204/205/304)
// cannot legally carry a body through the Response constructor.
//
// V4-APIGZIP-001: the two transport headers are dropped on the rebuild because they describe the wire
// form, not what is being re-emitted. Now that /api/plants negotiates gzip, a cached API response
// carries `Content-Encoding: gzip` and a compressed `Content-Length` — but the Cache API stores the
// DECODED body (that is why it uses more disk than the HTTP cache), so cached.body is plain JSON and
// both headers are false statements about it. Copying them forward asks the consumer to gunzip
// something that is not gzipped and to expect ~1/5 of the bytes present. Nothing in src/ reads either
// header, so dropping them costs nothing and removes the one place this SW would restate them.
function markFromCache(cached) {
  const headers = new Headers(cached.headers)
  headers.delete('Content-Encoding')
  headers.delete('Content-Length')
  headers.set(FROM_CACHE_HEADER, '1')
  const nullBody = cached.status === 204 || cached.status === 205 || cached.status === 304
  return new Response(nullBody ? null : cached.body, {
    status: cached.status,
    statusText: cached.statusText,
    headers,
  })
}

// Assets to precache on install
const PRECACHE_URLS = [
  '/',
  '/manifest.webmanifest',
]

// ---- Install ----
// V4-KBVIEWPORT-001: precache with cache:'no-store', NOT cache.addAll(). addAll() issues plain
// fetches that the browser's own HTTP cache may satisfy from the PREVIOUS build — so a correctly
// versioned new SW, whose activate purge ran correctly, could still install a stale '/' shell.
// That shell is what every offline/timeout navigation falls back to (see navigationFallback), and
// index.html carries the viewport meta, so a stale one silently runs the OLD viewport model. The
// result is a per-launch coin flip between viewport modes on the same build — and a device test
// that passes without revealing which model it exercised. navigationFallback already goes to this
// trouble (`new Request(request, { cache: 'no-store' })`); install did not. Per-URL so one failure
// cannot void the whole precache, which is what addAll().catch(()=>{}) silently did.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(async (cache) => {
      await Promise.all(PRECACHE_URLS.map(async (url) => {
        try {
          const res = await fetch(new Request(url, { cache: 'no-store' }))
          if (res.ok) await cache.put(url, res)
        } catch { /* offline install: navigationFallback still handles the miss */ }
      }))
    }).then(() => self.skipWaiting())
  )
})

// ---- Activate — purge old caches, then sweep poison out of the one we keep ----
// V4-PHOTOSWHARDEN-001: the two passes are complementary, not redundant. The name filter is
// all-or-nothing and only fires when CACHE_VERSION actually moved; purgePoisonedImages is the
// per-entry one and is the only thing that cleans a client activating under an UNCHANGED name.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    // V4-SWCACHEID-001: keepCacheKey REJECTS the bare `api-${CACHE_VERSION}`, so the sweep itself
    // removes the legacy unsegmented cache — including on a client whose deploy-time CACHE_VERSION
    // rewrite never ran, which is the case the design worried about. Design V100 D5 also called for
    // a separate unconditional one-shot delete of that name; it was written against the OLD
    // exact-equality allowlist, which KEPT `api-${CACHE_VERSION}`. Under the predicate it is
    // unreachable dead code — mutation testing confirmed removing it changed no observable
    // behaviour — so it is deliberately not here. The purge below is the whole mechanism.
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter(k => !keepCacheKey(k, CACHE_VERSION)) // old garden-images + prior images-* + every prior-version per-sub partition
          .map(k => caches.delete(k))
      )
    }).then(() => purgePoisonedImages()).then(() => self.clients.claim())
  )
})

// ---- Messages ----
// BUG-STALECLIENT-001: lets the page force a waiting (installed) SW to activate on demand.
// skipWaiting() at install time is not always sufficient — activation defers while the active
// SW has in-flight respondWith work, and on slow devices the 12s-bounded requests can pin the
// old SW so long that updates park in `waiting` indefinitely (clients then never reload and
// keep running a stale bundle). The UpdateBanner posts SKIP_WAITING for a deterministic path.
self.addEventListener('message', (event) => {
  if (event && event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting()
})

// ---- Fetch ----
self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)

  // Skip non-GET requests
  if (request.method !== 'GET') return

  // Skip browser-extension and non-http requests
  if (!url.protocol.startsWith('http')) return

  // Network-first for Lambda API calls (never serve stale API responses).
  // V4-SWCACHEID-001: the cache is chosen by the SUBJECT of this request's own bearer token, read
  // off the request that is already in hand. Deriving it here — rather than from a sub pushed in
  // by postMessage — is what makes it survive SW termination: module globals do not outlive an
  // idle kill (~30s in Chromium, sooner under Android memory pressure), which is precisely the
  // offline cold start where identity matters most. A null sub yields a null name, and a null name
  // means no read and no write (fail closed) — never a shared bucket.
  if (url.hostname.includes(LAMBDA_ORIGIN)) {
    const sub = subFromAuthHeader(request.headers.get('Authorization'))
    event.respondWith(networkFirst(request, apiCacheNameFor(CACHE_VERSION, sub), event))
    return
  }

  // Cache-first for images — separate bounded, versioned cache (count-capped).
  if (isImage(url)) {
    event.respondWith(imageCacheFirst(request))
    return
  }

  // Cache-first for other static assets (JS, CSS, fonts) — versioned, purged on deploy
  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(request, STATIC_CACHE))
    return
  }

  // Network-first for HTML navigation (always fresh shell), with an SPA fallback to the precached
  // app shell so any client-side route works offline.
  if (request.mode === 'navigate') {
    event.respondWith(navigationFallback(request))
    return
  }
})

// ---- Strategies ----

// WS-A6: bound the network leg so a hung Lambda can't hang a request forever.
const SW_TIMEOUT_MS = 12000
// BUG-BOOTSTALL-001: navigations get a much shorter leash than API calls. The 12s bound applied
// to the SHELL fetch is exactly the frozen pre-splash screen Dave reported (onset matches WS-A6
// shipping 2026-07-24): on a degraded route the user stares at a blank tab for the full 12s
// before the cached-shell fallback fires. A navigation has a safe, instant fallback (the cached
// shell renders ANY route, and the UpdateBanner's staleness probe heals a stale shell within
// seconds of connectivity returning), so waiting longer than ~4s buys nothing. API calls keep
// 12s — their fallback is an error, not a render, so patience still pays there.
const NAV_TIMEOUT_MS = 4000
async function fetchWithTimeout(request, ms) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(request, { signal: controller.signal })
  } catch (err) {
    if (err && err.name === 'AbortError') { const e = new Error('Network timeout'); e.name = 'TimeoutError'; throw e }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

// V4-PHOTOCDN-001 P2: CloudFront signed-URL params rotate per mint; keying the cache on the
// full URL would make every re-mint a miss + an immortal entry. Strip signing params for
// BOTH match and put. Dormant until the photo CDN issues signed URLs; harmless today.
const SIGNING_PARAMS = ['Expires', 'Signature', 'Key-Pair-Id', 'Policy']
function normalizeImageUrl(url) {
  const u = new URL(url)
  if (SIGNING_PARAMS.some(p => u.searchParams.has(p))) {
    SIGNING_PARAMS.forEach(p => u.searchParams.delete(p))
  }
  return u.href
}

// Image variant of cacheFirst: normalized cache key + content-type guard. Only status-200
// image/* responses are cached — S3/CloudFront 403s (application/xml), SPA index.html
// poison (text/html), and opaque responses never enter the cache. (Closes V4-PHOTOSWHARDEN-001.)
// The guarded response is still RETURNED to the page unmodified: refusing to cache a bad answer
// must not turn it into a different bad answer, and PhotoImg's own 403 heal needs to see the real
// status. Poison is denied a home here, not hidden.
async function imageCacheFirst(request) {
  const key = normalizeImageUrl(request.url)
  const cache = await caches.open(IMAGE_CACHE)
  const cached = await cache.match(key)
  if (cached) return cached
  try {
    const response = await fetch(request)
    if (isImageResponse(response)) {
      await cache.put(key, response.clone())
      trimCache(IMAGE_CACHE, MAX_IMAGE_ENTRIES).catch(() => {})
    }
    return response
  } catch {
    return new Response('Offline', { status: 503 })
  }
}

// V4-PHOTOSWHARDEN-001 part (b). The guard above stops NEW poison; this evicts poison that an
// EARLIER sw.js already wrote into the cache this SW is about to go on using. Never
// caches.delete(IMAGE_CACHE) — discarding every good photo to evict a handful of bad entries is
// the offline story traded away for a bug a per-entry predicate handles exactly.
//
// SCOPE, deliberately narrower than the write guard: delete only entries we can PROVE are wrong —
// a stored content-type that is present and is not image/*. An entry with an absent or empty
// content-type is LEFT ALONE. It is not provably poison (an older sw.js could have stored an opaque
// or header-less but perfectly good image) and deleting it costs a real offline photo, whereas
// poison always identifies itself: an interception/login page is text/html, an S3 403 is
// application/xml, a stray error body is text/plain. Idempotent — a second pass finds nothing left
// matching, and it never writes, so re-running it is free.
async function purgePoisonedImages() {
  try {
    const names = await caches.keys()
    if (!names.includes(IMAGE_CACHE)) return   // don't materialize an empty cache on a first activate
    const cache = await caches.open(IMAGE_CACHE)
    const keys = await cache.keys()
    await Promise.all(keys.map(async (key) => {
      const stored = await cache.match(key)
      if (!stored) return
      const type = (stored.headers.get('content-type') ?? '').toLowerCase()
      if (type && !type.startsWith('image/')) await cache.delete(key)
    }))
  } catch { /* a failed sweep must never block activation; the write guard still holds */ }
}

// V4-PHOTOSWHARDEN-001: same poisoning class, different cache. This path is only ever reached for
// isStaticAsset() URLs (js/css/fonts), and a captive portal, an auth redirect or S3's 200-index.html
// SPA fallback answers a missing hashed chunk with HTML — cached here it is served cache-first for
// the life of the cache name, so the app boots broken for that client with no network involved.
// Denylist (reject text/html) rather than the image path's allowlist: legitimate assets arrive under
// half a dozen content-types (application/javascript, text/javascript, font/woff2,
// application/octet-stream, …) and an allowlist would silently stop caching real ones, while
// text/html is never a correct answer for a script, stylesheet or font. navigationFallback does its
// own put and does not route through here, so the precached HTML app shell is unaffected.
async function cacheFirst(request, cacheName, maxEntries) {
  const cached = await caches.match(request)
  if (cached) return cached
  try {
    const response = await fetch(request)
    if (response.ok && !isHtmlResponse(response)) {
      const cache = await caches.open(cacheName)
      await cache.put(request, response.clone())
      if (maxEntries) trimCache(cacheName, maxEntries).catch(() => {})
    }
    return response
  } catch {
    return new Response('Offline', { status: 503 })
  }
}

// Bound a cache by entry count, evicting oldest-inserted first. Cache.keys() preserves
// insertion order, so this is a FIFO approximation of LRU — sufficient to cap growth.
async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName)
  const keys = await cache.keys()
  if (keys.length <= maxEntries) return
  for (let i = 0; i < keys.length - maxEntries; i++) {
    await cache.delete(keys[i])
  }
}

// Navigation strategy: fresh shell when online; offline, serve the exact cached URL if present,
// else fall back to the precached app shell '/' (§7). Without the '/' fallback, an unvisited route
// (or a client-side overlay transition to /search etc.) returned bare "Offline" — the SPA shell at
// '/' can render ANY route client-side, so it is the correct offline entry for every navigation.
async function navigationFallback(request) {
  try {
    const networkReq = new Request(request, { cache: 'no-store' })
    // WS-A6: bound the navigation fetch too; on timeout/offline the catch serves the presign-free '/' shell.
    // BUG-BOOTSTALL-001: navigations use the SHORT bound — see NAV_TIMEOUT_MS.
    const response = await fetchWithTimeout(networkReq, NAV_TIMEOUT_MS)
    if (response.ok) {
      const cache = await caches.open(STATIC_CACHE)
      cache.put(request, response.clone())
    }
    return response
  } catch {
    const cached = await caches.match(request)
    return cached || (await caches.match('/')) || new Response('Offline', { status: 503 })
  }
}

// `cacheName` is NULL when the request carries no usable identity. Null means this function
// degrades to a plain timed fetch: no cache read, no cache write, and 503 rather than someone
// else's body on the offline branch. That is the whole control — see the fail-closed note below.
async function networkFirst(request, cacheName, event) {
  try {
    // cache: 'no-store' bypasses browser HTTP disk cache — prevents stale 300/redirect
    // responses from reaching Lambda (root cause of photo gallery not refreshing)
    const networkReq = new Request(request, { cache: 'no-store' })
    const response = await fetchWithTimeout(networkReq, SW_TIMEOUT_MS)
    if (response.ok && cacheName) {
      // Keyed by request.URL, never by the Request itself: a Request key persists its
      // `Authorization: Bearer <jwt>` into Cache Storage at rest, where it outlives the session and
      // is readable by anything that can open the cache. Matching is symmetric (`cache.match` on
      // the same URL string with ignoreVary), so this costs no hit rate — and ignoreVary is
      // required precisely BECAUSE the stored key no longer carries the request's headers.
      const copy = response.clone()
      const write = caches.open(cacheName)
        .then(cache => cache.put(request.url, copy))
        // A QuotaExceededError here was previously an unhandled rejection on a floating promise —
        // invisible on an Android PWA, where quota pressure is the expected failure, not the odd one.
        .catch(() => {})
      if (event && event.waitUntil) event.waitUntil(write)
    }
    return response
  } catch (e) {
    // The two failure branches deliberately differ. The governing rule is STALE IS A LAST RESORT:
    // serve a cached API body only when there is no possibility of getting a fresh one right now.
    //
    // TIMEOUT (WS-A6) — the radio is up; the request merely lost a race against SW_TIMEOUT_MS. A retry
    // can succeed immediately, and stale JSON is actively harmful on a live network because its
    // presigned photo URLs (900s TTL) may already be dead: the user gets a working-looking screen with
    // 403 images, which reads as data corruption rather than as a network problem. Synthetic 504 →
    // the client surfaces an error/retry.
    if (e && e.name === 'TimeoutError') {
      return new Response('Gateway Timeout', { status: 504 })
    }
    // OFFLINE (fetch rejected outright) — no fresher answer exists, so it is cache-or-blank, and the
    // cached list beats a blank screen (rural dead zones are this app's normal operating condition,
    // not an edge case). The WS-A6 presign hazard genuinely does not bite the same way here: with no
    // network, an <img> pointing at a VALID presign fails exactly as hard as one pointing at an expired
    // presign, so serving the cached body costs no image that being offline had not already cost.
    // The residual risk is presigns going stale in memory across the offline→online edge; that is
    // covered by useCacheLifecycle's B6 onReconnect revalidate (age gate deliberately bypassed) plus
    // PhotoImg's own 403 heal — and the FROM_CACHE marker is what keeps B5/B6 from being suppressed by
    // a poisoned `at` in the first place.
    //
    // Scoped to `cacheName` rather than the global caches.match(): an API request must only ever be
    // answered from the API cache, never from a same-URL entry in the static or image cache.
    //
    // V4-SWCACHEID-001 FAIL CLOSED: no identity, no read. This is the control, and it is the branch
    // that closes the credential-less read — a signed-OUT device issues its API calls with no
    // Authorization header at all (Clerk returns a null token rather than throwing when there is no
    // session), so before this guard the offline branch handed the previous user's bodies to
    // whoever picked the phone up next, with no credential required. Airplane mode was the whole
    // exploit. Returning 503 here is a deliberate, bounded loss of offline for unauthenticated GETs.
    if (!cacheName) return new Response('Offline', { status: 503 })
    const cache = await caches.open(cacheName)
    const cached = await cache.match(request.url, { ignoreVary: true })
    return cached ? markFromCache(cached) : new Response('Offline', { status: 503 })
  }
}

// ---- Helpers ----

function isImage(url) {
  return /\.(png|jpg|jpeg|gif|svg|ico|webp|avif)(\?.*)?$/.test(url.pathname)
}

// V4-PHOTOSWHARDEN-001. isImage() asks what the URL LOOKS like; isImageResponse() asks what the
// server actually SENT — the gap between the two is the whole poisoning bug. A URL ending .jpg
// proves nothing: a captive portal, a Clerk login redirect and an S3 403 all answer it with a 200
// and a body, and once one is cached it is served cache-first forever and the photo is permanently
// broken for that client. Allowlist, so anything not positively an image is refused.
//
// OPAQUE RESPONSES ARE REFUSED, DELIBERATELY. A cross-origin <img> issues a no-cors request and the
// SW's fetch() mirrors that mode, so the response comes back opaque: status 0, headers stripped,
// content-type unreadable. There is no way to tell an image from a login page inside one, so caching
// it is caching an unverifiable body — precisely the class this closes. `status !== 200` already
// excluded them (opaque is status 0); the type test is spelled out so a later refactor that relaxes
// the status check cannot silently reopen the hole. Cost: cross-origin presigned photos are not
// offline-cached — they already were not, and their presigns die in 900s regardless.
function isImageResponse(response) {
  if (response.type === 'opaque' || response.status !== 200) return false
  return (response.headers.get('content-type') ?? '').toLowerCase().startsWith('image/')
}

function isHtmlResponse(response) {
  return (response.headers.get('content-type') ?? '').toLowerCase().startsWith('text/html')
}

function isStaticAsset(url) {
  return /\.(js|css|woff2?|ttf|eot)(\?.*)?$/.test(url.pathname)
}
