// Hand-rolled service worker — no vite-plugin-pwa
// Cache-first for static assets, network-first for Lambda API calls.
// CACHE_VERSION should be updated with each deploy for cache-busting.

const CACHE_VERSION = 'v16-20260524' // base default — deploy workflows rewrite this to v{version}-{sha} per deploy for cache-busting (deploy.yml / deploy-staging.yml). Frozen value caused stale-footer bug (2.1.1 fix).
const STATIC_CACHE  = `static-${CACHE_VERSION}`
const API_CACHE     = `api-${CACHE_VERSION}`
// Image cache is intentionally UNVERSIONED — app images are stable across deploys, so we
// persist them and bound growth by count (oldest-inserted evicted) rather than discarding
// the whole set every deploy. Excluded from the version purge below. (V3-CACHE-001)
const IMAGE_CACHE   = 'garden-images'
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
          .filter(k => k !== STATIC_CACHE && k !== API_CACHE && k !== IMAGE_CACHE)
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

  // Cache-first for images — separate bounded cache (persists across deploys, count-capped)
  if (isImage(url)) {
    event.respondWith(cacheFirst(request, IMAGE_CACHE, MAX_IMAGE_ENTRIES))
    return
  }

  // Cache-first for other static assets (JS, CSS, fonts) — versioned, purged on deploy
  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(request, STATIC_CACHE))
    return
  }

  // Network-first for HTML navigation (always fresh shell)
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, STATIC_CACHE))
    return
  }
})

// ---- Strategies ----

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
