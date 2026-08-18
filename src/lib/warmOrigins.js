// V4-PERFCLERK-001 Option A — retire Lambda cold-start INSIDE the Clerk dead window.
//
// MEASURED (2026-08-18, prod /api/plants Function URL, wired broadband):
//   first tokenless GET → 401 in 1,706ms · three warm repeats → 302 / 410 / 320ms
// The ~1.4s gap is Node init + the heavy module graph (@aws-sdk/*, @clerk/backend,
// @neondatabase/serverless, s3-request-presigner) + the Secrets Manager fetch. Every bit of it runs
// BEFORE the auth check: lambda/plants/index.js:108 `await getSecrets()` precedes :114
// `await verifyToken(...)`, which 401s at :124. So a request carrying no token still PAYS that
// init — and therefore retires it — while being turned away with {error:'Unauthorized'}.
//
// The window to spend it in is already free. bootSplash.js's measured trace puts isLoaded at
// t=3376ms and this module's evaluation at t≈783ms: ~2.5s in which App.jsx:104 `Protected` returns
// null for every route, no page component mounts, and not one API request has been issued. Today
// the cold start is paid AFTER that window rather than inside it, purely because no code runs
// before the gate opens. That ordering is an accident of structure, not a security property.
//
// ── WHY THIS CANNOT LEAK. Preserve all four on every future edit. ──
//   1. No Authorization header is ever set, so the Lambda calls verifyToken('') — an empty token
//      fails parse before any key lookup, making 401 structurally guaranteed. There is no input to
//      this module under which a Lambda returns a row.
//   2. credentials:'omit' is EXPLICIT rather than inherited. fetch's default 'same-origin' already
//      sends nothing cross-origin, but stating it turns the invariant from relied-upon into
//      enforced — and it is what warmOrigins.test.js asserts against.
//   3. The response is never awaited, read, parsed or returned. Callers get URLs, never bodies.
//   4. public/sw.js:296 caches only `response.ok`, so a 401 can never enter API_CACHE.
//
// ── GET, NEVER OPTIONS. ──
// A CORS preflight returns at lambda/plants/index.js:98, BEFORE getSecrets(), and warms nothing.
// Anything that promotes these to preflighted requests — a custom header, a non-simple
// Content-Type — silently converts this whole file into a no-op that still looks like it works.
// That is also why the ping does not carry an X-Warm-Ping marker: the CloudWatch attribution would
// cost the very warm it exists to produce. The 401s show up as `verifyToken failed` lines at boot;
// that is expected, and this comment is the place that says so.
//
// ── IT DOES NOT PRIME THE JWKS CACHE. ──
// verifyToken is passed secretKey with no jwtKey, so key fetching is online — but an empty token
// fails parse first, so no key is ever fetched. This warms the CONTAINER. Do not claim otherwise.
//
// ── PATH CHOICE. ──
// WARM_PATHS names the four origins Today (POST_LOGIN_ROUTE, and the '/' and '*' redirect target)
// fetches above the fold, in render order: StorageDeadlineAlert + CareNeeded → /api/plants,
// CultivationLead → /api/inventory-items, WeatherWidget's read model → /api/daily-plan,
// CareNeeded's location paths → /api/locations. Below-the-fold bands (harvests, preservation) and
// /api/members are deliberately out: each costs an invocation on every cold boot and the Clerk
// window is not unbounded. Adding one means showing it is above the fold, not that it exists.
// Distinct from useCacheLifecycle's BOOT_WARM_PATHS, which warms the DATA CACHE post-auth and is
// empty since OPS-BOOTWARMSTALE-001. This warms containers pre-auth and caches nothing.
import { FUNCTION_URLS, resolveUrl } from './api.js'

export const WARM_PATHS = Object.freeze([
  '/api/plants',
  '/api/daily-plan',
  '/api/locations',
  '/api/inventory-items',
])

// Fire-and-forget. SYNCHRONOUS and total: it awaits nothing, throws nothing, and returns the URLs
// it dispatched so a test can assert the target set without observing the network. A warm-ping that
// can block or break boot is worse than no warm-ping at all.
//
// Deduped by ORIGIN, not by path: one cold start is per container, and two prefixes that resolve to
// the same Function URL are the same container. Origin also survives trailing-slash normalisation.
export function warmApiOrigins({ paths = WARM_PATHS, urls = FUNCTION_URLS, fetchImpl } = {}) {
  const pinged = []
  try {
    const doFetch = fetchImpl ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null)
    if (!doFetch) return pinged
    const seen = new Set()
    for (const path of paths) {
      let url
      // resolveUrl throws on a prefix with no table entry; an unset VITE_API_* leaves the base ''
      // so the result is a relative path and `new URL` throws. Both mean "nothing to warm here" —
      // in particular a staging/dev build missing one var must skip that origin, not the rest.
      try { url = resolveUrl(path, urls) } catch { continue }
      let origin
      try { origin = new URL(url).origin } catch { continue }
      if (seen.has(origin)) continue
      seen.add(origin)
      pinged.push(url)
      try {
        const p = doFetch(url, { method: 'GET', credentials: 'omit' })
        // Attached inline so a rejection can never surface as an unhandled rejection (which Chrome
        // reports to the console and vitest fails a run on). The result is intentionally discarded.
        if (p && typeof p.then === 'function') p.then(() => {}, () => {})
      } catch { /* a synchronously-throwing fetch must not take the remaining origins with it */ }
    }
  } catch { /* boot is not negotiable; a warm-ping is an optimisation */ }
  return pinged
}
