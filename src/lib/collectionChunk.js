// V4-LAZYRETRY-001 — lazy access to the /collection page chunk (~40KB gzip: Collection.jsx plus the
// critters-roster.json and CritterOfDay.jsx subgraphs no other route reaches).
//
// WHY A DYNAMIC import() AND NOT React.lazy. This route WAS `React.lazy(() => import(…))` in
// App.jsx, and that made a failed fetch UNRECOVERABLE. React.lazy caches a rejected payload
// permanently: in the installed React 18.3.1 (react/cjs/react.development.js:1354-1409,
// `lazyInitializer`) the ctor runs only under `if (payload._status === Uninitialized)`, a failed
// load sets `_status = Rejected`, and every later render falls through to `throw payload._result`
// without ever issuing another request. The route had no ErrorBoundary of its own, so the throw
// reached the APP-level boundary and blanked the whole PWA — and its "Try again" button, which only
// clears `hasError` and re-renders the same lazy object, could never recover it. One dead spot
// mid-tap, or a STATIC_CACHE purged by a deploy, and /collection was gone for the session.
//
// This module is the sanctioned alternative, and the same shape as its sibling
// critterFactsLoader.js: a plain import() whose failure branch is a VALUE, not a throw. It is what
// CropCard.jsx:17 forbids React.lazy at/above that card in favour of. Nothing unmounts, nothing
// error-boundaries, and a retry is a genuinely NEW import() rather than a re-read of a cached
// rejection — which is the whole point, since browsers no longer memoise module-map fetch errors.
//
// Module-scope cache, mirroring CropCard's hwModule and critterFactsLoader's: once the chunk lands,
// later mounts resolve synchronously via peek() at first render, so navigating back to /collection
// does not flash the loading state again.
let cached = null
let inflight = null

// Synchronous read for first-render use. null means "not loaded yet OR failed" — the caller
// distinguishes those two by whether an attempt has completed, not by this value.
export function peekCollectionChunk() {
  return cached
}

// Idempotent and concurrency-safe: N simultaneous callers share one import() and one chunk fetch,
// which is also what absorbs StrictMode's double-invoked effect in dev.
// Never rejects — a failed load resolves null and leaves `cached` null AND `inflight` cleared, so
// the next call starts a fresh import(). That is the retry the old React.lazy path could not do.
export function loadCollectionChunk() {
  if (cached) return Promise.resolve(cached)
  if (inflight) return inflight
  inflight = import('../pages/Collection.jsx')
    .then((m) => {
      cached = m.default ?? m
      return cached
    })
    .catch(() => null)
    .finally(() => { inflight = null })
  return inflight
}

// Test seam only — the module cache would otherwise leak a loaded chunk across test files.
export function __resetCollectionChunkCache() {
  cached = null
  inflight = null
}
