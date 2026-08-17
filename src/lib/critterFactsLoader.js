// V4-COLLECTIONSPLIT-001 — lazy access to critter-facts.json (~138 KB rendered), which was a
// static import in BOTH Collection.jsx and CritterOfDay.jsx and therefore sat in the ENTRY bundle
// for every user on every route, including the ones who never open /collection.
//
// WHY A DYNAMIC import() AND NOT React.lazy. The ledger row proposed lazifying the whole /collection
// route. The objection it records as closed is only the STALE-CLIENT one (deploy.yml:209-213 carries
// --exclude assets/* before --delete, so old hashed chunks are never pruned). That is a different
// hazard from OFFLINE, which is not closed: sw.js precaches only '/' and the manifest, and serves JS
// cache-first POPULATED ON DEMAND from a STATIC_CACHE that is purged on every deploy. So after any
// deploy, the first offline visit to a lazily-routed page finds no chunk and no network — and a
// React.lazy rejection throws into the route ErrorBoundary and replaces the whole page. That is
// exactly the failure CropCard.jsx:17 forbids React.lazy at/above that card to avoid, in an app Dave
// uses standing in a garden with no signal.
//
// This module is that comment's sanctioned alternative: a plain import() whose failure branch is a
// VALUE, not a throw. A cold offline miss degrades to "no facts text", which is a state both call
// sites already render correctly for a critter that simply has no facts entry. Nothing unmounts,
// nothing error-boundaries, and the page still works.
//
// Module-scope cache, mirroring CropCard's hwModule: once the chunk lands, later mounts resolve
// synchronously via peek() at first render, so reopening the popover does not flash empty.
let cached = null
let inflight = null

// Synchronous read for first-render use. null means "not loaded yet OR failed" — callers must treat
// both the same way (render the no-facts branch), which is what makes the offline path safe.
export function peekCritterFacts() {
  return cached
}

// Idempotent and concurrency-safe: N simultaneous callers share one import() and one chunk fetch.
// Never rejects — a failed load resolves null and leaves `cached` null so a later call can retry
// (e.g. the user taps again once back on signal).
export function loadCritterFacts() {
  if (cached) return Promise.resolve(cached)
  if (inflight) return inflight
  inflight = import('../data/critter-facts.json')
    .then((m) => {
      cached = m.default ?? m
      return cached
    })
    .catch(() => null)
    .finally(() => { inflight = null })
  return inflight
}

// Test seam only — the module cache would otherwise leak a loaded dataset across test files.
export function __resetCritterFactsCache() {
  cached = null
  inflight = null
}
