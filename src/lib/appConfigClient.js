// appConfigClient — V5-ADMINCENTER-001. The GLOBAL, installation-wide config store.
//
// A SEPARATE FILE FROM notificationPrefsClient BECAUSE IT IS A SEPARATE SCOPE, and that is the whole
// point of the row. Dave ruled 2026-09-08 that nav_tabs is global — one nav order for the
// installation, not one per person — after two sessions independently found the first implementation
// had wired it to public.user_notification_prefs, which is keyed by created_by and cannot express an
// installation-wide fact. Everything in notificationPrefsClient is per-user. Nothing here is. Mixing
// them would give one module two scopes, which is precisely the confusion the ruling ruled out.
//
// SAME LAMBDA, SAME FUNCTION URL, NEW PATH — deliberately. This reads VITE_API_CRITTERS, the base
// critterClient and notificationPrefsClient already hold, and the critter Lambda routes on rawPath.
// The preconnect budget is closed at four and bootPaint.static.test.js asserts the preconnected set
// equals WARM_PATHS, but it dedupes by ORIGIN not by path (warmOrigins.js:92-93) — so this costs
// zero preconnects, zero new VITE_API_* repo variables and zero new Function URLs, and the nav is
// already talking to this origin (BottomNavDot fetches /api/critters/active on mount). It is the
// same move api.js:71-76 records for Instagram reusing the Facebook Function URL, and the same
// reasoning that was accepted there. clientRouteLambdaContract.test.js covers this file
// automatically via its VITE_API_CRITTERS -> 'critter' mapping, so the path below is checked against
// the routes the Lambda actually declares rather than trusted.

const CRITTER_BASE = (import.meta.env.VITE_API_CRITTERS ?? '').replace(/\/$/, '')

// SINGLE FLIGHT, matching fetchNotificationPrefs. DEDUP, NOT CACHE: the latch clears the moment the
// request settles, so the admin centre's re-read after its own save still hits the network. The
// latch is keyed on nothing because there is exactly one signed-in user per document and this row is
// global — two concurrent callers are by construction asking for the same row.
let inFlight = null

// fetchAppConfig — GETs the global config, joining any request already in flight.
// Returns the config object on success, null on failure (NEVER throws).
//
// NULL IS THE HONEST FAILURE VALUE and it is load-bearing. A failed GET, an offline boot, an unset
// base URL and a never-configured installation all arrive at the consumer as null, and resolveNavTabs
// maps null to the shipped default. Degrading to today's nav is the only failure mode that cannot
// strand either user; degrading to an empty bar would.
export async function fetchAppConfig({ getToken } = {}) {
  if (!CRITTER_BASE) return null
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      const token = await (typeof getToken === 'function' ? getToken() : null)
      if (!token) return null
      const res = await fetch(`${CRITTER_BASE}/api/app-config`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) return null
      const json = await res.json().catch(() => null)
      return json && typeof json === 'object' ? json : null
    } catch {
      return null
    } finally {
      // In `finally` rather than after the await: a caller that never awaits must not leave the
      // latch holding a settled response forever, which would turn dedup into a permanent cache.
      inFlight = null
    }
  })()
  return inFlight
}

// saveNavTabs — the admin centre's write. REPORTS ITS OUTCOME rather than being fire-and-forget.
//
// Every writer in notificationPrefsClient returns null-on-anything, which is correct there: the
// caller has already applied the change locally and a failed sync costs the user nothing. This is
// the opposite — a user-initiated Save on a page whose only job is that write — and a save that
// silently reports nothing is a save that lies. So it returns a discriminated result and the page
// renders what actually happened, including the 403 that means "the server says you are not an
// admin". `nav_tabs` is sent as the only key: the route accepts nothing else and batching would put
// an unrelated setting into a request the server may reject whole.
//
// The client-side shape check is NOT the security boundary — the Lambda's fail-closed
// ADMIN_CLERK_SUBS gate is, and there is no client admin list anywhere in this app by a decision
// recorded in three files. This check only declines to spend a round trip on a payload the server
// would refuse anyway.
export async function saveNavTabs({ getToken, tabs } = {}) {
  if (!CRITTER_BASE) return { ok: false, status: 0 }
  if (!Array.isArray(tabs) || tabs.some(t => typeof t !== 'string')) return { ok: false, status: 0 }
  try {
    const token = await (typeof getToken === 'function' ? getToken() : null)
    if (!token) return { ok: false, status: 401 }
    const res = await fetch(`${CRITTER_BASE}/api/app-config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ nav_tabs: tabs }),
    })
    if (!res.ok) return { ok: false, status: res.status }
    return { ok: true, config: await res.json().catch(() => null) }
  } catch {
    // status 0 is the house convention for "never reached the server" (api.js:284), kept so the page
    // can distinguish a refusal from an outage.
    return { ok: false, status: 0 }
  }
}
