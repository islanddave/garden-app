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

export function useApiFetch() {
  const { getToken } = useAuth()
  const fetch = useCallback(async (path, options = {}) => {
    const token = await getToken()
    return apiFetch(path, options, token)
  }, [getToken])
  // getToken is also returned so fire-and-forget telemetry (uxEvents) can route token
  // acquisition through this same seam — component tests mock useApiFetch, which keeps
  // the Clerk dependency out of every consumer's test.
  return { fetch, getToken }
}
