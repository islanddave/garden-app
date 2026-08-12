// V4-PERFTHEMEA-001 — canonical home for the reasoning behind the two index.html boot changes.
// It lives here rather than in index.html because that document is the critical path and its
// comments SHIP: an earlier draft of this change put the full rationale inline and added 1.6 kB
// gzip to the first byte-for-byte blocking download, in a change whose entire purpose is to make
// boot faster. Source comments here are stripped by the minifier and cost nothing.
//
// ── MEASURED BOOT (prod garden.futureishere.net, Chrome @375px, resource timing, 2026-08-12) ──
//   t=348ms   index.html TTFB
//   t=783ms   entry bundle done (402 kB gzip, 50+ pages statically imported — no route splitting)
//   t=823ms   FIRST reference to the Clerk origin → DNS + TCP + TLS start only now
//   t=1265ms  clerk.browser.js done
//   t=2249ms  @clerk/ui done
//   t=3376ms  /v1/environment + /v1/client resolve → isLoaded → App.jsx <Protected> stops
//             returning null and the app finally has something to render
// Nothing was on screen for that entire window except a brand splash that had already timed out
// (see SplashScreen.jsx). Both changes below attack that window from opposite ends.
//
// ── 1. #boot-splash: paint before any JS runs ──
// Everything React can do begins at t=783ms, so the first ~435ms is unreachable by any component
// — and on Android cellular, where 402 kB gzip is seconds rather than 435ms, that gap is the
// dominant part of the complaint. index.html renders `<div id="boot-splash">` with inline CSS, so
// it paints as soon as the HTML parses.
// It is a SIBLING of #root, never a child: createRoot() owns and clears #root's children, so a
// splash nested inside would be wiped on React's first commit — precisely the moment the app still
// has nothing to show. Being outside #root also means React will never remove it, which is what
// dismissBootSplash() below is for.
// Its background is #f8f5f0 = P.cream (src/lib/constants.js), matching SplashScreen exactly, so
// the handover reads as the illustration arriving rather than a white→cream flash.
//
// ── 2. Clerk preconnect ──
// The Clerk origin is not connected until t=823ms because nothing in the document references it
// until the entry bundle has downloaded AND evaluated far enough to mount <ClerkProvider>. The
// whole DNS+TCP+TLS handshake therefore sits on the critical path to isLoaded.
// The host is DERIVED from the publishable key (Clerk encodes it as base64 with a trailing '$'),
// not hardcoded: dev, staging and prod point at different Clerk instances
// (VITE_CLERK_PUBLISHABLE_KEY / STAGING_CLERK_KEY), so a hardcoded prod FAPI would be a
// config-canonicity violation that warms a socket staging never uses. Vite substitutes %VITE_*% in
// index.html at build time; the `pk_` guard also covers the unsubstituted literal in any context
// where substitution did not run.
// NO crossorigin, deliberately: Chrome keys its socket pool on credentials mode, and both
// consumers of this origin are credentialed — clerk.browser.js is a plain <script> (cookies sent)
// and Clerk's /v1/* calls use credentials:'include'. `crossorigin` would warm the ANONYMOUS pool
// and buy exactly nothing while looking like it worked.
// The inline script is try/catch-wrapped because it runs in <head> before #root exists: a throw
// would abort boot outright. A preconnect is an optimisation; boot is not negotiable.
//
// NOT FIXED HERE, and deliberately so — see scratchpad/lane-perfthemea.md: the ~1.9s of
// main-thread evaluation inside that waterfall (route-level code splitting), the 21 independent
// Lambda origins whose cold TTFB measured 1.4–1.8s vs 0.13–0.24s warm, and extending the existing
// dataCache/useCachedFetch beyond the three photo surfaces. Each needs a decision above this lane.

// Remove the pre-React boot paint. Idempotent; a no-op when the element was never rendered (unit
// tests never load index.html into jsdom). Called from a LAYOUT effect at the App root so the
// removal commits in the same frame that first paints SplashScreen — a passive effect would let
// the browser paint in between, i.e. one frame of exactly the white flash this removes.
export function dismissBootSplash() {
  if (typeof document === 'undefined') return
  const el = document.getElementById('boot-splash')
  if (el && el.parentNode) el.parentNode.removeChild(el)
}
