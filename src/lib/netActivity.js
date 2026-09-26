// src/lib/netActivity.js
// BUG-DETAILPAGESCARRYSCROLL-001 — how many of the app's own content requests are in flight right now.
//
// ONE reader: the page-scroll manager's restore driver (src/lib/pageScroll.js driverStep, `quiet`). A Back
// restore whose target the page cannot reach stops once the page has SETTLED; a page is not settled while
// the request that would grow it is still on the wire. Without this the driver could only watch the page's
// height, and a loading shell holds its height for as long as the network takes (measured: a 5 s Zones
// fetch and a two-stage Event log both lost their place that way).
//
// Fed by apiFetch (src/lib/api.js — every API call, through useApiFetch or direct), by useApiFetch().fetch from
// the moment it is called (the wait for the Clerk token counts too: qa2-scrollmanager-confirm NEW-1), and by the
// one page that loads its content with a plain fetch, ReleaseNotes (/releases.json). A request the tracker does
// not see only makes a stop EARLIER than it should be, never later; the budget still bounds every restore.
//
// ONE GLOBAL COUNT, NOT PER PAGE (qa2-scrollmanager-confirm MINOR-6). Any request anywhere keeps every page
// "unsettled": while a long background request runs — a photo upload's relay waits up to 60 s
// (useUploadPhoto.js RELAY_TIMEOUT_MS) — a Back to a place out of reach pulls for the whole 15 s budget instead of
// stopping at the page's end, as the manager did before the out-of-reach stop existed. The budget bounds it, and
// a tap still takes the restore over, so "Show more" never jumps. Per-page attribution would need every request
// tagged with the page that made it; not worth it for a degradation that is bounded and rare.
//
// No React, no DOM, no dependencies: api.js is imported almost everywhere, and this must not drag anything
// into it.
let inflight = 0

// Count `promise` as in flight until it settles; returns a promise that settles the same way.
export function trackRequest(promise) {
  if (!promise || typeof promise.finally !== 'function') return promise
  inflight += 1
  return promise.finally(() => { inflight = Math.max(0, inflight - 1) })
}

export function requestsInFlight() {
  return inflight
}

// Test seam only.
export function __resetNetActivity() {
  inflight = 0
}
