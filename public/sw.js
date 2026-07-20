// Hand-rolled service worker — no vite-plugin-pwa
// Cache-first for static assets, network-first for Lambda API calls.
// CACHE_VERSION should be updated with each deploy for cache-busting.

const CACHE_VERSION = 'v16-20260524' // base default — deploy workflows rewrite this to v{version}-{sha} per deploy for cache-busting (deploy.yml / deploy-staging.yml). Frozen value caused stale-footer bug (2.1.1 fix).
const STATIC_CACHE  = `static-${CACHE_VERSION}`
const API_CACHE     = `api-${CACHE_VERSION}`
// V4-PHOTOCDN-001 P2 (supersedes V3-CACHE-001): image cache is now VERSIONED and purged
// on activate. The old unversioned garden-images cache persisted stale/poisoned entries forever
// (excluded from purge), and per-request presigned URLs rotate the query string so entries
// almost never re-matched anyway — pure growth, no hits. Versioning costs little and kills
// the poison-persistence class. Content-type guard + signing-param normalization below.
const IMAGE_CACHE   = `images-${CACHE_VERSION}`
const MAX_IMAGE_ENTRIES = 150

const LAMBDA_ORIGIN = 'lambda-url.us-east-1.on.aws'

// Assets to precache on install
const PRECACHE_URLS = [
  '/',
  '/manifest.webmanifest',
]

// ---- Install ----
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      return cache.addAll(PRECACHE_URLS).catch(() => {})
    }).then(() => self.skipWaiting())
  )
})

// ---- Activate — purge old caches ----
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter(k => k !== STATIC_CACHE && k !== API_CACHE && k !== IMAGE_CACHE) // old garden-images + prior images-* caches purge here too
          .map(k => caches.delete(k))
      )
    }).then(() => self.clients.claim())
  )
})

// ---- Fetch ----
self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)

  // Skip non-GET requests
  if (request.method !== 'GET') return

  // Skip browser-extension and non-http requests
  if (!url.protocol.startsWith('http')) return

  // Network-first for Lambda API calls (never serve stale API responses)
  if (url.hostname.includes(LAMBDA_ORIGIN)) {
    event.respondWith(networkFirst(request, API_CACHE))
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
async function imageCacheFirst(request) {
  const key = normalizeImageUrl(request.url)
  const cache = await caches.open(IMAGE_CACHE)
  const cached = await cache.match(key)
  if (cached) return cached
  try {
    const response = await fetch(request)
    const type = response.headers.get('content-type') ?? ''
    if (response.status === 200 && type.startsWith('image/')) {
      await cache.put(key, response.clone())
      trimCache(IMAGE_CACHE, MAX_IMAGE_ENTRIES).catch(() => {})
    }
    return response
  } catch {
    return new Response('Offline', { status: 503 })
  }
}

async function cacheFirst(request, cacheName, maxEntries) {
  const cached = await caches.match(request)
  if (cached) return cached
  try {
    const response = await fetch(request)
    if (response.ok) {
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
    const response = await fetch(networkReq)
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

async function networkFirst(request, cacheName) {
  try {
    // cache: 'no-store' bypasses browser HTTP disk cache — prevents stale 300/redirect
    // responses from reaching Lambda (root cause of photo gallery not refreshing)
    const networkReq = new Request(request, { cache: 'no-store' })
    const response = await fetch(networkReq)
    if (response.ok) {
      const cache = await caches.open(cacheName)
      cache.put(request, response.clone())
    }
    return response
  } catch {
    const cached = await caches.match(request)
    return cached || new Response('Offline', { status: 503 })
  }
}

// ---- Helpers ----

function isImage(url) {
  return /\.(png|jpg|jpeg|gif|svg|ico|webp|avif)(\?.*)?$/.test(url.pathname)
}

function isStaticAsset(url) {
  return /\.(js|css|woff2?|ttf|eot)(\?.*)?$/.test(url.pathname)
}
