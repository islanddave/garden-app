// API prefix → Lambda routing table.
// Owner: Dave. Change requires staging smoke of affected route.
//
// Resolution is FIRST-MATCH on insertion order — Object.entries preserves
// declaration order. Longer / more-specific prefixes MUST be declared BEFORE
// their shorter parents (e.g., '/api/projects/inactive' precedes '/api/projects').
//
// Prefix → Lambda env var → purpose
//   /api/projects/inactive  → VITE_API_DASHBOARD     dashboard footer / inactive surface (S3)
//   /api/projects           → VITE_API_PROJECTS      projects CRUD
//   /api/plants             → VITE_API_PLANTS        plants CRUD
//   /api/locations          → VITE_API_LOCATIONS     locations CRUD
//   /api/notifications      → VITE_API_EVENTS        web-push subscribe (Lambda 2.2.x)
//   /api/events             → VITE_API_EVENTS        events CRUD
//   /api/favorites          → VITE_API_FAVORITES     favorites toggle
//   /api/photos             → VITE_API_PHOTOS        photo upload/list
//   /api/dashboard          → VITE_API_DASHBOARD     dashboard composite
//   /api/inventory-items    → VITE_API_INVENTORY     inventory CRUD
//   /api/varieties          → VITE_API_VARIETIES     variety reference data
//   /api/achievements       → VITE_API_ACHIEVEMENTS  achievements list
//   /api/ux-events          → VITE_API_UX_EVENTS     UX success-metric sink (Inc 0; admin-read + telemetry write)
//   /api/shared-state       → VITE_API_SHARED_STATE  shared-garden reward substrate (V3-REWARDSTATE-001)
//   /api/findings           → VITE_API_FINDINGS      DRG care findings read model (DRG-TAB-001)
//   /api/daily-plan         → VITE_API_DAILY_PLAN_READ  Daily Plan read model — Today surface (DRG-TODAY-002)
//   /api/members            → VITE_API_MEMBERS       household roster for the caretaker picker (PLANT-ASSIGN-001)
//   /api/tags               → VITE_API_TAGS         faceted tag substrate CRUD (V4-TAGSUB-001)
//   /api/entity-tags        → VITE_API_TAGS         entity↔tag attach/detach + projected derived tags
//   /api/search             → VITE_API_DASHBOARD    server-side universal search (V4-SEARCH-002)
//   /api/storage-locations  → VITE_API_STORAGE_LOCATIONS  Put-Up storage vocab CRUD (V4-HARVESTCENTER-001)
//   /api/preservation       → VITE_API_PRESERVATION  Put-Up log CRUD + whats-put-up/use-soon reads (V4-HARVESTCENTER-001)
//   /api/harvests           → VITE_API_HARVESTS     Harvests page read model — Log + Totals (V4-HARVESTVIEW-001)
//   /api/share/facebook     → VITE_API_FACEBOOK_SHARE  post photos to the Gardens at Matthews FB Page (V4-FBSHARE-001)

import { useAuth } from '@clerk/react'
import { ClerkOfflineError } from '@clerk/shared/error'
import { useCallback } from 'react'

// Exported for src/__tests__/clientRouteLambdaContract.test.js, which resolves every client-side
// API path through THIS table (via resolveUrl, with probe base URLs) and asserts the Lambda it
// lands on actually declares a matching route. Exporting it is what makes that guard read the one
// real table instead of a second copy — a copy is precisely how BUG-HARVWATCHROUTE-001 stayed green.
// Values are still the statically-replaced `import.meta.env.VITE_*` member expressions: Vite only
// substitutes static property access, so this object must never be rebuilt by dynamic indexing.
export const FUNCTION_URLS = {
  '/api/projects/inactive': import.meta.env.VITE_API_DASHBOARD     ?? '',
  '/api/projects':          import.meta.env.VITE_API_PROJECTS      ?? '',
  '/api/plants':            import.meta.env.VITE_API_PLANTS        ?? '',
  '/api/locations':         import.meta.env.VITE_API_LOCATIONS     ?? '',
  '/api/notifications':     import.meta.env.VITE_API_EVENTS        ?? '',
  '/api/events':            import.meta.env.VITE_API_EVENTS        ?? '',
  '/api/favorites':         import.meta.env.VITE_API_FAVORITES     ?? '',
  '/api/photos':            import.meta.env.VITE_API_PHOTOS        ?? '',
  '/api/dashboard':         import.meta.env.VITE_API_DASHBOARD     ?? '',
  '/api/search':            import.meta.env.VITE_API_DASHBOARD     ?? '',
  '/api/inventory-items':   import.meta.env.VITE_API_INVENTORY     ?? '',
  '/api/varieties':         import.meta.env.VITE_API_VARIETIES     ?? '',
  '/api/achievements':      import.meta.env.VITE_API_ACHIEVEMENTS  ?? '',
  '/api/ux-events':         import.meta.env.VITE_API_UX_EVENTS     ?? '',
  '/api/shared-state':      import.meta.env.VITE_API_SHARED_STATE  ?? '',
  '/api/findings':          import.meta.env.VITE_API_FINDINGS      ?? '',
  '/api/daily-plan':        import.meta.env.VITE_API_DAILY_PLAN_READ ?? '',
  '/api/members':           import.meta.env.VITE_API_MEMBERS        ?? '',
  '/api/tags':              import.meta.env.VITE_API_TAGS           ?? '',
  '/api/entity-tags':       import.meta.env.VITE_API_TAGS           ?? '',
  '/api/storage-locations': import.meta.env.VITE_API_STORAGE_LOCATIONS ?? '',
  '/api/preservation':      import.meta.env.VITE_API_PRESERVATION   ?? '',
  '/api/harvests':          import.meta.env.VITE_API_HARVESTS       ?? '',
  '/api/share/facebook':    import.meta.env.VITE_API_FACEBOOK_SHARE ?? '',
  // Instagram is served by the SAME Lambda and the SAME Function URL as Facebook — the handler
  // routes on rawPath — so it deliberately reuses VITE_API_FACEBOOK_SHARE rather than introducing a
  // second repo variable that would have to hold an identical value and could drift from it.
  // It also means Instagram inherits Facebook's reachability exactly: while VITE_API_FACEBOOK_SHARE
  // does not exist, NEITHER target has an address to post to.
  '/api/share/instagram':   import.meta.env.VITE_API_FACEBOOK_SHARE ?? '',
}

export function resolveUrl(path, urls = FUNCTION_URLS) {
  for (const [prefix, base] of Object.entries(urls)) {
    if (path.startsWith(prefix)) return `${base.replace(/\/$/, '')}${path}`
  }
  throw new Error(`No Lambda URL configured for path: ${path}`)
}

// WS-A6: bound every API call so a hung Lambda/network can't spin forever. AbortController
// (NOT AbortSignal.timeout — Safari 16 gap). 15s clears a cold Neon+Lambda start plus a heavy
// txn; a caller can override via options.timeoutMs and still pass its own options.signal.
export const API_TIMEOUT_MS = 15000

// SW-STALEAPI-001 — carry the service worker's offline-cache marker across the parse boundary.
//
// public/sw.js stamps X-From-Cache on an API response it served from cache because the network was
// unavailable. It stays HTTP 200 on purpose (the body is the user's real data and SWR should keep
// serving it offline), so the header is the ONLY signal — and it dies here unless carried forward,
// because apiFetch returns parsed JSON, not the Response.
//
// Carried as a NON-ENUMERABLE Symbol property on the returned value rather than by wrapping it: every
// existing caller destructures / spreads / Array.isArray()s this return value, and a wrapper would
// break all of them. Non-enumerable + symbol ⇒ invisible to Object.keys, object spread,
// JSON.stringify, and dataCache's _sameExceptUrls field walk, so nothing downstream changes shape.
// Symbol.for() (global registry) rather than a shared import so the dependency-free dataCache store
// does not have to import this module (Clerk + the whole routing table) just to read one bit.
//
// DO NOT remove this: without it, a failed offline refresh is indistinguishable from a successful one
// at every layer above the service worker, and dataCache resets its freshness clock on the failure.
export const FROM_CACHE_HEADER = 'X-From-Cache'
export const FROM_CACHE = Symbol.for('garden-app.fromCache')

export function isFromCache(value) {
  return !!value && typeof value === 'object' && value[FROM_CACHE] === true
}

export async function apiFetch(path, options = {}, token) {
  const url = resolveUrl(path)
  const { timeoutMs = API_TIMEOUT_MS, signal: callerSignal, headers: optHeaders, ...fetchOpts } = options
  const headers = { 'Content-Type': 'application/json', ...(optHeaders ?? {}) }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort()
    else callerSignal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  let res
  try {
    res = await fetch(url, { ...fetchOpts, headers, signal: controller.signal })
  } catch (e) {
    // Our timeout fired (the caller didn't abort): surface a friendly, catchable error.
    if (e?.name === 'AbortError' && !callerSignal?.aborted) {
      const te = new Error('Request timed out')
      te.status = 0
      te.timeout = true
      throw te
    }
    throw e
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    let errBody
    try { errBody = await res.json() } catch { errBody = { error: res.statusText } }
    const e = new Error(errBody?.error ?? `HTTP ${res.status}`)
    e.status = res.status
    e.body = errBody
    throw e
  }
  if (res.status === 204) return null
  const data = await res.json()
  // Optional chaining is load-bearing: many component tests stub fetch with a bare { ok, json } object
  // that has no headers. A missing header surface means "not from cache", never a throw.
  if (res.headers?.get?.(FROM_CACHE_HEADER) && data !== null && typeof data === 'object') {
    try {
      Object.defineProperty(data, FROM_CACHE, { value: true, enumerable: false, configurable: true })
    } catch { /* frozen/sealed body — marking is best-effort, never fatal to the request */ }
  }
  return data
}

// OFFLINE-AUTH — an offline token failure must degrade to "no token", not abort the request.
//
// getToken() caches with a 60s TTL over an IN-MEMORY singleton, so any tab idle for a minute is a
// cache miss. Offline, a miss THROWS rather than returning null (@clerk/shared session.d.ts:246),
// and this module used to await it bare: the throw escaped useApiFetch().fetch, apiFetch was never
// called, no fetch() was ever issued, and so the service worker's fetch handler never ran. The SW
// API cache was therefore unreachable for exactly the users it was built for.
//
// TWO codes, not one. clerk-js 6.29.2 Session.getToken (dist/clerk.browser.js @132530) wraps the
// retry ladder in `catch(e){ if(!k()) throw new ClerkOfflineError(...); throw e }`, k() reading
// navigator.onLine. So the escape depends on the radio's state when the ladder gives up:
//   still offline      -> ClerkOfflineError,  code 'clerk_offline'
//   came back mid-retry -> the INNER error, ClerkRuntimeError, code 'network_error'
//                         (_getToken @138781: `else throw new x("Browser is offline, skipping
//                         token fetch", { code: "network_error" })`)
// Guarding only clerk_offline would miss every connectivity FLAP — the normal condition in a rural
// dead zone, not an edge case. 'network_error' has no exported constant the way
// ClerkOfflineError.ERROR_CODE does, hence the literal; it is a structured discriminant field on
// the error, not a message match.
const CLERK_NETWORK_ERROR_CODE = 'network_error'

// ClerkOfflineError.is() is checked first but is NOT sufficient, and the reason is worth stating
// because the obvious implementation is the broken one. Its doc comment claims it "checks both
// instanceof and the error code to support cross-bundle/cross-realm errors". That is FALSE for this
// subclass: the cross-realm arm is isClerkRuntimeError(), which compares
// `err.constructor.kind === 'ClerkRuntimeError'`, but ClerkOfflineError SHADOWS that static with
// 'ClerkOfflineError', so it never matches — and the instanceof arm fails because the throw
// originates in the CDN-hotloaded @clerk/clerk-js, a different realm from the bundled
// @clerk/shared. Measured against a faithful CDN-realm replica: .is() returns FALSE for the error
// this app actually receives and TRUE for a same-realm one, i.e. a guard written on .is() alone is
// green in every unit test and vacuous in production. The code comparison is what fires; .is() is
// retained so this self-heals if Clerk ever fixes the guard.
export function isOfflineTokenError(e) {
  if (!e || typeof e !== 'object') return false
  // A 4xx is Clerk's API ANSWERING — a revoked session, a bad key. That is a real auth failure and
  // must surface; laundering it into "no token" would silently downgrade the request to anonymous
  // and bury the cause. Checked first so no later arm can override it.
  if (typeof e.status === 'number' && e.status >= 400 && e.status < 500) return false
  if (ClerkOfflineError.is(e)) return true
  return e.code === ClerkOfflineError.ERROR_CODE || e.code === CLERK_NETWORK_ERROR_CODE
}

// How long to wait for a token when navigator.onLine is ALREADY false.
//
// Not a tuning knob — derived from Clerk's retry ladder, which has a hard floor. retry()
// (@clerk/shared/dist/retry.mjs) runs `return await callback()` FIRST with no preceding delay and
// only sleeps BETWEEN retries; clerk-js passes initialDelay 3000 / factor 1.55 / jitter false and
// caps offline at 4 attempts. That separates the two outcomes cleanly in time:
//   warm-tab cache HIT -> resolves on attempt 1, no timer involved (~a microtask)
//   offline cache MISS -> cannot produce anything for >=3000ms, then throws at ~14.9s
// Any wait strictly between those bounds keeps the working path intact and truncates the dead one.
// 1500ms is half the 3000ms floor: 2x headroom below the earliest answer Clerk could give, and ~3
// orders of magnitude above an in-memory cache read, so main-thread jank cannot push a hit past it.
export const OFFLINE_TOKEN_WAIT_MS = 1500

// WHY PRE-EMPT rather than simply catching the throw when it finally arrives: when navigator.onLine
// is false, clerk-js consults the SAME signal on every attempt, so all four hit `else throw` and the
// ladder is futile BY CONSTRUCTION — it can only succeed if the radio returns mid-window. Waiting
// ~14.9s to learn something knowable at t=0 also blows the entire request budget, because the stall
// happens BEFORE apiFetch starts its own API_TIMEOUT_MS timer: today's worst case is ~30s of spinner
// for a request that was never going to be sent. The cost is bounded and already covered — if the
// radio does return between 1.5s and 14.9s we abandon a token that might have arrived, but the
// 'online' event then fires and useCacheLifecycle's onReconnect revalidate refetches
// automatically, so recovery needs no user action.
async function tokenWithOfflineWait(getToken) {
  let timer
  try {
    // Promise.race attaches reactions to BOTH arms immediately, so a getToken() that rejects at
    // ~14.9s after the timeout already won still counts as handled — no unhandled rejection.
    return await Promise.race([
      getToken(),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), OFFLINE_TOKEN_WAIT_MS) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

// The one seam every token acquisition goes through. Returns a token or null.
//
// null used to mean "issue the request with no Authorization header". IT NO LONGER DOES — see
// BUG-TOKENLESS-401-001 below. It now means "no credential is available", and the hook turns that
// into a typed, retryable error instead of an anonymous request. The offline pre-empt above is
// unchanged and still earns its keep: it is what stops an API call stalling ~15s on Clerk's ladder.
export async function tokenForRequest(getToken) {
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false
  try {
    return offline ? await tokenWithOfflineWait(getToken) : await getToken()
  } catch (e) {
    if (isOfflineTokenError(e)) return null
    throw e
  }
}

// BUG-TOKENLESS-401-001 — why a null token must NOT become an anonymous request.
//
// The previous seam did `apiFetch(path, options, null)`, and apiFetch omits the Authorization
// header entirely when the token is falsy. That was introduced (113de76, v4.39.0) so the request
// would at least reach the service worker and be answered from its API cache. THAT PREMISE IS VOID,
// and was already void when it shipped: sw.js derives its cache name from the JWT's `sub`, so a
// headerless request produces a null cacheName, and a null cacheName means NO cache read at all
// (the V4-SWCACHEID-001 fail-closed control, pinned by apiOfflineToken D1). So an anonymous request
// has no success case anywhere:
//   offline -> the SW answers 503 Offline
//   online  -> it reaches the Lambda, which calls verifyToken('') and returns 401 Unauthorized
// It cost a Lambda invocation to produce a misleading error. MEASURED in prod 2026-08-26: 48 such
// 401s in one morning across 7 Lambdas, every one logging `Invalid JWT form` (an EMPTY token, not
// an expired one), surfacing to Dave as "Couldn't load your harvests — Unauthorized" while online.
//
// Do not reintroduce the tokenless call as an offline optimisation. Throwing is strictly safer than
// a headerless request AND strictly more useful than a guaranteed 401.
export const OFFLINE_MESSAGE = 'You appear to be offline.'
export const NO_CREDENTIAL_MESSAGE = 'Couldn’t verify your sign-in. Tap Retry.'

// Plain Errors with flags rather than subclasses, matching the timeout error above — callers
// discriminate on `e.offline` / `e.authPending`, and `e.message` is what error surfaces render
// verbatim (e.g. Harvests' <ErrorState message={error} />). status 0 keeps them out of any
// `e.status >= 400` HTTP branch.
function noCredentialError() {
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false
  const e = new Error(offline ? OFFLINE_MESSAGE : NO_CREDENTIAL_MESSAGE)
  e.status = 0
  if (offline) e.offline = true
  else e.authPending = true
  return e
}

// Acquire a token, forcing a fresh mint when the ordinary path yields nothing.
//
// A null from Clerk is NOT self-healing, which is the property that made this bug sticky enough to
// need an app restart. Two states produce it and both persist:
//   · the session object has gone away while `useUser()` still reports a signed-in user, so
//     App.jsx's <Protected> keeps rendering the app and every request goes out anonymous;
//   · the in-memory token cache was emptied (Android freezes the tab during the OS photo picker —
//     the Snap flow does this on every capture) and the refresh that should refill it did not run.
// Every later getToken() reads the same empty cache and returns null again. skipCache:true bypasses
// it and forces a network mint, which re-establishes the session as a side effect.
//
// Skipped when already offline: a mint needs the network, so it could only burn a second
// OFFLINE_TOKEN_WAIT_MS (doubling the offline stall to 3s) to reach the same null.
async function acquireToken(getToken) {
  const cached = await tokenForRequest(getToken)
  if (cached) return cached
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return null
  return tokenForRequest(() => getToken({ skipCache: true }))
}

export function useApiFetch() {
  const { getToken } = useAuth()
  const fetch = useCallback(async (path, options = {}) => {
    const token = await acquireToken(getToken)
    if (!token) throw noCredentialError()

    try {
      return await apiFetch(path, options, token)
    } catch (e) {
      // A 401 with a token attached means the token was stale in a way the client could not see —
      // a mint that raced an expiry, or a session rotated on another device. Re-mint and replay ONCE.
      //
      // Safe for POST/PUT/DELETE, not just reads: every Lambda calls verifyToken BEFORE it touches
      // the database (checked against lambda/harvests/index.js and lambda/photos/index.js — the two
      // this bug was reported on), so a 401 is always a server-side no-op and the replay cannot
      // double-write. Bodies are JSON strings at every call site, so `options` is replayable.
      //
      // Bounded at one attempt by construction — the retry calls apiFetch directly, never itself.
      // The identity check is what stops a pointless second round trip when the mint returns the
      // same cached string, which is also the shape an infinite loop would take.
      if (e?.status !== 401) throw e
      const fresh = await tokenForRequest(() => getToken({ skipCache: true }))
      if (!fresh || fresh === token) throw e
      return apiFetch(path, options, fresh)
    }
  }, [getToken])
  // getToken is also returned so fire-and-forget telemetry (uxEvents) can route token
  // acquisition through this same seam — component tests mock useApiFetch, which keeps
  // the Clerk dependency out of every consumer's test. Wrapped rather than raw: those callers all
  // do `if (!token) return null`, so the offline-safe null lets them bail in 1.5s instead of
  // holding a promise open for the full ladder to throw inside their own catch. Args are forwarded
  // so the wrapper stays signature-compatible with Clerk's getToken(options).
  //
  // Deliberately NOT acquireToken: these callers are fire-and-forget telemetry that must stay cheap
  // and silent. Spending a forced network mint on a UX-event beacon would be the tail wagging the dog.
  const safeGetToken = useCallback((...args) => tokenForRequest(() => getToken(...args)), [getToken])
  return { fetch, getToken: safeGetToken }
}
