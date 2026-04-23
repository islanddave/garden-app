// Hand-rolled service worker — no vite-plugin-pwa
// Cache-first for static assets, network-first for Supabase API calls.
// CACHE_VERSION should be updated with each deploy for cache-busting.

const CACHE_VERSION = 'v9-20260423a'
const STATIC_CACHE  = `static-${CACHE_VERSION}`
const API_CACHE     = `api-${CACHE_VERSION}`

const SUPABASE_ORIGIN = 'supabase.co'

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
          .filter(k => k !== STATIC_CACHE && k !== API_CACHE)
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

  // Network-first for Supabase API calls
  if (url.hostname.includes(SUPABASE_ORIGIN)) {
    event.respondWith(networkFirst(request, API_CACHE))
    return
  }

  // Cache-first for static assets (JS, CSS, images, fonts)
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

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request)
  if (cached) return cached
  try {
    const response = await fetch(request)
    if (response.ok) {
      const cache = await caches.open(cacheName)
      cache.put(request, response.clone())
    }
    return response
  } catch {
    return new Response('Offline', { status: 503 })
  }
}

async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request)
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

function isStaticAsset(url) {
  return /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|webp|avif)(\?.*)?$/.test(url.pathname)
}
