// src/lib/netActivity.js
// BUG-DETAILPAGESCARRYSCROLL-001 — how many of the app's own content requests are in flight right now.
//
// ONE reader: the page-scroll manager's restore driver (src/lib/pageScroll.js driverStep, `quiet`). A Back
// restore whose target the page cannot reach stops once the page has SETTLED; a page is not settled while
// the request that would grow it is still on the wire. Without this the driver could only watch the page's
// height, and a loading shell holds its height for as long as the network takes (measured: a 5 s Zones
// fetch and a two-stage Event log both lost their place that way).
//
// Fed by apiFetch (src/lib/api.js — every API call, through useApiFetch or direct) and by the one page that
// loads its content with a plain fetch, ReleaseNotes (/releases.json). A request the tracker does not see
// only makes a stop EARLIER than it should be, never later; the budget still bounds every restore.
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
