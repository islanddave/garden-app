// notificationPrefsClient — Settings page read/write for user_notification_prefs.
// Spec: mvp-critter-pre-build-revision-V001 §2.1 (Lambda Routes 7+8).
// Pattern mirrors src/lib/critterClient.js — same Lambda (VITE_API_CRITTERS),
// fire-and-forget semantics where applicable, NEVER throws.
//
// Routes:
//   GET   /api/notifications/prefs   → returns { critter_visit, quiet_hours_start, quiet_hours_end, ... }
//                                       Stateless defaults applied at read; no first-read-side-effect write.
//   PATCH /api/notifications/prefs   → body { critter_visit?, quiet_hours_start?, quiet_hours_end? }
//                                       Returns the updated row.
//
// Allowed critter_visit values: 'off' | 'in_app_only' | 'system' (DB CHECK enforces).
// Defaults applied by Lambda when no row exists: critter_visit='in_app_only',
// quiet_hours_start='21:00:00', quiet_hours_end='07:00:00'.

import { HANDS } from './handedness.js'
import { API_TIMEOUT_MS, FROM_CACHE, FROM_CACHE_HEADER } from './api.js'
import { MORE_PIN_ID_RE, MORE_PINS_MAX_STORED } from './moreRegistry.js'
import { resolveBarLayout } from './navConfig.js'

const CRITTER_BASE = (import.meta.env.VITE_API_CRITTERS ?? '').replace(/\/$/, '')

export const CRITTER_VISIT_VALUES = ['off', 'in_app_only', 'system']
// Every value Garden's group-by control can offer (src/lib/gardenGroupBy.js); the Lambda's copy is
// lambda/critter/validators.js, and lambda/critter/groupby.parity.test.js pins both to the control.
// BUG-GARDENGROUPBYRESET-001: 'crop_type' — the Type option, Garden's default — was missing, so a Type
// choice was never sent and every Garden mount re-adopted the server's older one.
export const GARDEN_GROUP_BY_VALUES = ['none', 'type', 'crop_type', 'lifecycle', 'heat', 'determinacy', 'day_length', 'allium_type', 'basil_use', 'bean_type', 'bean_habit', 'bean_use', 'location', 'group', 'freeform', 'status']
export const GARDEN_SORT_ORDER_VALUES = ['alpha', 'recency']
// Re-exported (not redeclared) from the layout module so the wire contract and the render contract
// cannot drift: handedness.js is what every surface reads, and this is what gets PATCHed. Imported
// as well as re-exported — a bare `export ... from` does not bind the name in this module's scope,
// and saveHandedness below validates against it.
export const HANDEDNESS_VALUES = HANDS
export const GARDEN_EXPANDED_MAX = 2000

// saveGardenGroupBy moved to the REPORTED savers below (BUG-GARDENGROUPBYRESET-001).

// saveGardenSortOrder — fire-and-forget PATCH of the cross-device Garden sort-order preference
// (user_notification_prefs.garden_sort_order). Mirrors patchNotificationPrefs: NEVER throws, silent
// no-op when env unset / unauth / value invalid. keepalive survives route-change unmount.
export async function saveGardenSortOrder({ getToken, value } = {}) {
  if (!CRITTER_BASE) return null
  if (value != null && !GARDEN_SORT_ORDER_VALUES.includes(value)) return null
  try {
    const token = await (typeof getToken === 'function' ? getToken() : null)
    if (!token) return null
    const res = await fetch(`${CRITTER_BASE}/api/notifications/prefs`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ garden_sort_order: value }),
      keepalive: true,
    })
    if (!res.ok) return null
    return await res.json().catch(() => null)
  } catch {
    return null
  }
}

// saveGardenExpanded — fire-and-forget PATCH of the cross-device project-tree disclosure set
// (user_notification_prefs.garden_expanded, JSON array of project-id strings). Mirrors the other
// garden pref writers: NEVER throws, silent no-op when env unset / unauth / shape invalid.
export async function saveGardenExpanded({ getToken, ids } = {}) {
  if (!CRITTER_BASE) return null
  if (ids != null && (!Array.isArray(ids) || ids.some(x => typeof x !== 'string') || ids.length > GARDEN_EXPANDED_MAX)) return null
  try {
    const token = await (typeof getToken === 'function' ? getToken() : null)
    if (!token) return null
    const res = await fetch(`${CRITTER_BASE}/api/notifications/prefs`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ garden_expanded: ids }),
      keepalive: true,
    })
    if (!res.ok) return null
    return await res.json().catch(() => null)
  } catch {
    return null
  }
}

// saveGardenBloomSeen — fire-and-forget PATCH of the cross-device critter first-reveal set
// (user_notification_prefs.garden_bloom_seen, JSON array of critter-id strings). V4-BLOOM-001.
// Monotonic union semantics live in the caller; this just persists. NEVER throws.
export async function saveGardenBloomSeen({ getToken, ids } = {}) {
  if (!CRITTER_BASE) return null
  if (ids != null && (!Array.isArray(ids) || ids.some(x => typeof x !== 'string') || ids.length > GARDEN_EXPANDED_MAX)) return null
  try {
    const token = await (typeof getToken === 'function' ? getToken() : null)
    if (!token) return null
    const res = await fetch(`${CRITTER_BASE}/api/notifications/prefs`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ garden_bloom_seen: ids }),
      keepalive: true,
    })
    if (!res.ok) return null
    return await res.json().catch(() => null)
  } catch {
    return null
  }
}

// saveGardenHelperRung1 — fire-and-forget one-shot PATCH marking the GardenHelper rung-1 explainer
// dismissed cross-device (user_notification_prefs.garden_helper_rung1_seen). NEVER throws.
export async function saveGardenHelperRung1({ getToken } = {}) {
  if (!CRITTER_BASE) return null
  try {
    const token = await (typeof getToken === 'function' ? getToken() : null)
    if (!token) return null
    const res = await fetch(`${CRITTER_BASE}/api/notifications/prefs`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ garden_helper_rung1_seen: true }),
      keepalive: true,
    })
    if (!res.ok) return null
    return await res.json().catch(() => null)
  } catch {
    return null
  }
}

// V5-ADMINCENTER-001 — SINGLE FLIGHT over the prefs GET.
//
// This route had NINE independent callers coming (SettingsNotifications, Collection, GardenHelper,
// Garden, useWhatsNew, CareNeeded, useHandedness, ScopeChecklist, and the nav-config read this row
// adds), each firing its own bare fetch on its own mount. On /today three of them mount in the same
// frame, so the app was asking the same Lambda the same question three times inside the boot window
// three consecutive perf rows were spent clearing — against a measured 1,706ms cold start
// (warmOrigins.js:3-5). Adding a tenth uncoordinated call was not acceptable, so this collapses all
// of them instead, in the one place every caller already goes through: no call site changes.
//
// DEDUP, NOT CACHE — and the distinction is the whole safety argument. `inFlight` is cleared the
// moment the request settles, so a call made AFTER a response has landed still hits the network.
// Callers that read prefs following their own PATCH (SettingsNotifications re-reads to confirm; the
// admin centre refreshes after a save) therefore see fresh data exactly as before. A time-windowed
// cache would have changed that, silently, for eight surfaces that never asked for it.
//
// The latch is keyed on nothing because the token is per-signed-in-user and there is exactly one
// signed-in user per document: two concurrent callers in one page are by construction asking for the
// same row. The token is resolved INSIDE the shared promise for the same reason — resolving it first
// would serialise the callers on getToken() before they could join.
let inFlight = null

// BUG-GARDENGROUPBYRESET-001 (QA MINOR 4) — A READ THAT WAS ON THE WIRE WHEN A GARDEN GROUPING SAVE WAS CONFIRMED
// IS MARKED, the way a cached body is. Its row can be the one from BEFORE that save: a later caller JOINS it
// through the latch above (Garden, left and re-entered while its read was out), or it simply answers after the
// save's own answer (a read sent while the save was still on the wire, handled first by another Lambda
// instance). Either way Garden would read the older grouping as another device's choice and regroup the list.
// Dropping the join on a confirmed save would reach only the first of those, and would change what the other
// callers of the join get, so the join stays exactly as it is: instead each read notes the count of confirmed
// grouping saves when it STARTS, and a body landing after the count moved carries
// PREDATES_GROUP_BY_SAVE — a non-enumerable global-registry Symbol like FROM_CACHE, invisible to Object.keys,
// spread and JSON. Garden (src/lib/gardenGroupBy.js) never adopts a marked body; no other caller reads the mark.
// Scoped to garden_group_by on purpose: no other save can make that field of a body stale.
let groupBySavesConfirmed = 0
export const PREDATES_GROUP_BY_SAVE = Symbol.for('garden-app.prefsPredatesGroupBySave')

// fetchNotificationPrefs — GETs current prefs, joining any request already in flight.
// Returns the prefs object on success, null on no-op or failure (NEVER throws).
//
// V5-NAVCUSTOM-001 — A BODY THE SERVICE WORKER SERVED FROM ITS CACHE IS MARKED, exactly as apiFetch
// marks one (api.js, SW-STALEAPI-001): public/sw.js answers a GET whose network attempt failed
// outright from its per-user API cache, still HTTP 200, stamped X-From-Cache. This client bypasses
// apiFetch (the prefs route lives on the critter Lambda), so without this the stamp died here and a
// days-old body read as fresh — it un-pinned pins this device had already confirmed and rewrote the
// launch caches with an older bar. The marker is api.js's FROM_CACHE: a non-enumerable global-registry
// Symbol, invisible to Object.keys, spread and JSON, so no existing caller sees a shape change.
// NavPrefsContext reads it; every other caller is unaffected.
export async function fetchNotificationPrefs({ getToken } = {}) {
  if (!CRITTER_BASE) return null
  if (inFlight) return inFlight
  inFlight = (async () => {
    const savesAtStart = groupBySavesConfirmed
    try {
      const token = await (typeof getToken === 'function' ? getToken() : null)
      if (!token) return null
      const res = await fetch(`${CRITTER_BASE}/api/notifications/prefs`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) return null
      const json = await res.json().catch(() => null)
      if (!json || typeof json !== 'object') return null
      // Optional chaining is load-bearing, as in apiFetch: most tests stub fetch with a bare
      // { ok, json } that has no headers, and "no header surface" means "not from cache".
      if (res.headers?.get?.(FROM_CACHE_HEADER)) {
        try {
          Object.defineProperty(json, FROM_CACHE, { value: true, enumerable: false, configurable: true })
        } catch { /* frozen body — marking is best-effort */ }
      }
      if (groupBySavesConfirmed !== savesAtStart) {
        try {
          Object.defineProperty(json, PREDATES_GROUP_BY_SAVE, { value: true, enumerable: false, configurable: true })
        } catch { /* frozen body — marking is best-effort */ }
      }
      return json
    } catch {
      return null
    } finally {
      // In `finally` rather than after the await at the call site: a caller that never awaits (or
      // an unmount that drops the promise) must not leave the latch stuck holding a settled
      // response forever, which would turn dedup into a permanent cache.
      inFlight = null
    }
  })()
  return inFlight
}

// Test seam. The latch is module state and vitest does not reset modules between cases in a file;
// without this a suite's second case would silently join the first case's settled promise.
// Mirrors __resetHandednessSync() in hooks/useHandedness.js.
export function __resetPrefsFlight() { inFlight = null }

// patchNotificationPrefs — PATCHes a partial prefs object.
// Inputs:
//   getToken          — async () => string | null
//   critterVisit?     — 'off' | 'in_app_only' | 'system' (only sent if provided)
//   quietHoursStart?  — 'HH:MM:SS' or 'HH:MM' (only sent if provided)
//   quietHoursEnd?    — 'HH:MM:SS' or 'HH:MM' (only sent if provided)
// Returns the updated row on success, null on validation fail / no-op / failure.
export async function patchNotificationPrefs({
  getToken,
  critterVisit = null,
  quietHoursStart = null,
  quietHoursEnd = null,
} = {}) {
  if (!CRITTER_BASE) return null
  if (critterVisit != null && !CRITTER_VISIT_VALUES.includes(critterVisit)) return null
  try {
    const token = await (typeof getToken === 'function' ? getToken() : null)
    if (!token) return null
    const body = {}
    if (critterVisit != null) body.critter_visit = critterVisit
    if (quietHoursStart != null) body.quiet_hours_start = quietHoursStart
    if (quietHoursEnd != null) body.quiet_hours_end = quietHoursEnd
    if (Object.keys(body).length === 0) return null
    const res = await fetch(`${CRITTER_BASE}/api/notifications/prefs`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) return null
    return await res.json().catch(() => null)
  } catch (err) {
    console.warn('patchNotificationPrefs failed:', err?.message ?? String(err))
    return null
  }
}

// ─── Phase B — fire-and-forget POSTs (Routes 6, 9, 10) ────────────────────────
// All three NEVER reject, NEVER throw, silent no-op when env unset.
// keepalive:true survives unmount-on-route-change.

// recordGardenViewOpened — Route 6 POST /api/notifications/garden-view-opened.
// Spec: revision §3.7 (Phase B coachmark triggers on garden-view-enter, not critter-state-change).
// Server updates last_garden_view_at = now() (upserts user_notification_prefs row if absent).
// Caller pattern: fire on Garden mount AND on document visibilitychange→visible (Garden re-entry).
// Returns the updated last_garden_view_at ISO string on success, null otherwise.
export async function recordGardenViewOpened({ getToken } = {}) {
  if (!CRITTER_BASE) return null
  try {
    const token = await (typeof getToken === 'function' ? getToken() : null)
    if (!token) return null
    const res = await fetch(`${CRITTER_BASE}/api/notifications/garden-view-opened`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      keepalive: true,
    })
    if (!res.ok) return null
    const json = await res.json().catch(() => null)
    return json?.last_garden_view_at ?? null
  } catch {
    return null
  }
}

// recordCoachmarkDismissed — Route 9 POST /api/notifications/coachmark-dismissed.
// Spec: revision §3.7 (1500ms min-visible-time before writing coachmark_seen_at).
// Idempotent on server (COALESCE preserves existing coachmark_seen_at).
// Caller pattern: fire on Garden unmount IFF coachmark was visible ≥1500ms.
export async function recordCoachmarkDismissed({ getToken } = {}) {
  if (!CRITTER_BASE) return null
  try {
    const token = await (typeof getToken === 'function' ? getToken() : null)
    if (!token) return null
    const res = await fetch(`${CRITTER_BASE}/api/notifications/coachmark-dismissed`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      keepalive: true,
    })
    if (!res.ok) return null
    const json = await res.json().catch(() => null)
    return json?.coachmark_seen_at ?? null
  } catch {
    return null
  }
}

// recordOptInDismissed — Route 10 POST /api/notifications/opt-in-dismissed.
// Spec: revision §3.8 (suppression-flag fix: opt_in_prompt_seen_at ONLY set after prompt ACTUALLY rendered).
// Server is idempotent (COALESCE preserves existing).
// Caller pattern: fire on Garden unmount IFF opt-in prompt was rendered.
export async function recordOptInDismissed({ getToken } = {}) {
  if (!CRITTER_BASE) return null
  try {
    const token = await (typeof getToken === 'function' ? getToken() : null)
    if (!token) return null
    const res = await fetch(`${CRITTER_BASE}/api/notifications/opt-in-dismissed`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      keepalive: true,
    })
    if (!res.ok) return null
    const json = await res.json().catch(() => null)
    return json?.opt_in_prompt_seen_at ?? null
  } catch {
    return null
  }
}

// V4-USERPREFS-001 (V4-TODAYLOC-002) — the Care-Needed suppress-for-today set, cross-device.
//
// Wire shape is {date, keys}, with the date INSIDE the object so the pair can never be written
// apart: a write that advanced the keys but not the date would suppress today's care rows using
// yesterday's set. Self-expiring — readTodaySkipped ignores a non-today date, so nothing has to
// clean this up.
//
// Fire-and-forget, NEVER throws, silent no-op when env unset / unauth — same contract as
// saveGardenSortOrder above. This is the correct posture here specifically: the caller has ALREADY
// applied the skip locally by the time this runs, so a failed sync must cost the user nothing.
// keepalive survives the route-change unmount that follows a skip-then-navigate.
export async function saveTodaySkipped({ getToken, date, keys } = {}) {
  if (!CRITTER_BASE) return null
  if (typeof date !== 'string' || !Array.isArray(keys)) return null
  try {
    const token = await (typeof getToken === 'function' ? getToken() : null)
    if (!token) return null
    const res = await fetch(`${CRITTER_BASE}/api/notifications/prefs`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ today_skipped: { date, keys } }),
      keepalive: true,
    })
    if (!res.ok) return null
    return await res.json().catch(() => null)
  } catch {
    return null
  }
}

// Reads the stored set, returning [] for anything that is not TODAY's. The date check is the whole
// expiry mechanism: yesterday's suppressions must not hide today's watering rows, which is a
// silent and dangerous failure (a plant goes unwatered and nothing on screen says why).
export function readTodaySkipped(prefs, todayISO) {
  const ts = prefs?.today_skipped
  if (!ts || typeof ts !== 'object') return []
  if (ts.date !== todayISO) return []
  return Array.isArray(ts.keys) ? ts.keys.filter(k => typeof k === 'string') : []
}

// V4-USERPREFS-001 (V4-LOGMANY-001) — Log-Many default selection, per USER.
//
// This is the clearest case in the set for per-identity keying. ScopeChecklist's own comment reads
// "true=start all selected [Dave], false=start none [Jen]": the two users want OPPOSITE defaults,
// and the value was per-DEVICE, so whoever signed in second on a shared phone got the other
// person's answer. Keyed on the Clerk sub, they can finally disagree.
//
// `value` is passed through a strict boolean check rather than a truthiness coercion because FALSE
// IS A REAL CHOICE here (it is Jen's), and `if (!value) return` would silently refuse to save it.
export async function saveLogManyAllSelected({ getToken, value } = {}) {
  if (!CRITTER_BASE) return null
  if (typeof value !== 'boolean') return null
  try {
    const token = await (typeof getToken === 'function' ? getToken() : null)
    if (!token) return null
    const res = await fetch(`${CRITTER_BASE}/api/notifications/prefs`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ log_many_all_selected: value }),
      keepalive: true,
    })
    if (!res.ok) return null
    return await res.json().catch(() => null)
  } catch {
    return null
  }
}

// V4-HANDEDNESSCONTROLS-001 (BD-054) — which hand works the phone, per USER.
//
// Per-identity for the same reason log_many_all_selected is: this app has exactly two users on
// shared devices and they do not have the same hands. It is also the one preference here where
// inheriting the other person's answer is a SAFETY regression rather than an annoyance — it moves
// a destructive control under the wrong thumb (see src/lib/handedness.js).
//
// ⚠️ INERT UNTIL THE COLUMN LANDS. user_notification_prefs.handedness does not exist yet
// (migrations/v4-handednesscontrols-001 — authored, NOT applied to staging or prod). Until it does,
// this PATCH carries `handedness` as its ONLY key, so validateNotificationPrefsPatchBody's
// HAS_UPDATABLE check (lambda/critter/validators.js:102) returns 400 "no updatable fields present"
// and this function returns null. That is the correct pre-migration outcome and it is why the key
// is sent alone rather than batched with another: batching it would carry a live preference into a
// request the server is about to reject. Nothing else on the prefs surface is affected.
export async function saveHandedness({ getToken, value } = {}) {
  if (!CRITTER_BASE) return null
  if (!HANDEDNESS_VALUES.includes(value)) return null
  try {
    const token = await (typeof getToken === 'function' ? getToken() : null)
    if (!token) return null
    const res = await fetch(`${CRITTER_BASE}/api/notifications/prefs`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ handedness: value }),
      keepalive: true,
    })
    if (!res.ok) return null
    return await res.json().catch(() => null)
  } catch {
    return null
  }
}

// V5-NAVCUSTOM-001 — THE SAVERS BELOW REPORT THEIR OUTCOME, unlike every writer above them.
//
// The fire-and-forget writers above are right for what they save: the caller has already applied the
// change locally and a lost sync costs nothing visible. These are the opposite. A pin that fails
// silently reappears unpinned at the next launch, and the bar editor's Save is a page whose only job
// is that write — a save that reports nothing is a save that lies. A Garden grouping that fails silently
// is overwritten at the next Garden mount by the server's older one (BUG-GARDENGROUPBYRESET-001). So all return
// { ok: true } | { ok: false, status }, where status 0 is the house convention for "never reached the
// server" (offline, no token, timed out, env unset) and anything else is the server's own answer.
// NavPrefsContext reads that split: 0 and 5xx keep the change and retry, a 4xx rolls it back. Garden keeps
// its grouping on ANY non-ok: every value it can send is pinned to the Lambda's list, so a 4xx there means
// the deployed Lambda is older than this bundle (a deploy window), and rolling back would re-create the bug.
//
// THE 15-SECOND BOUND IS api.js's API_TIMEOUT_MS, not a second constant. These cannot go through
// apiFetch itself — its prefix table routes /api/notifications to the EVENTS Lambda, and the prefs
// route lives on the critter Lambda this module has always called directly — so the bound is applied
// here with the same AbortController pattern, around the fetch only, exactly as apiFetch applies it.
//
// NO keepalive by default, deliberately. A reported save needs its response. Durability across an app close is
// the caller's pending flag, written BEFORE the request goes out (NavPrefsContext's for pins, projectTree.js's
// for the Garden grouping). ONE caller asks for keepalive per call: the Garden grouping (rimpact #5). It was a
// keepalive write before BUG-GARDENGROUPBYRESET-001, and without it a pick followed at once by closing the
// app reaches the server only at this device's next Garden visit — another device shows the older grouping in
// between. A keepalive fetch still resolves with its response while the page lives (Fetch spec), so the report
// is unchanged; the pins and the bar keep the default.
//
// NOT nav_tabs. The retired global order (public.app_config, V5-ADMINCENTER-001) never belonged on
// this per-user table and still does not: bar_layout below is a different key with a different
// shape, and it IS per-user — Dave ruled on 2026-09-24 (D4) that only his bar changes, never Jen's.
//
// A payload the contract refuses is reported as the 400 the server would return, with `local: true`,
// without spending the round trip. The client check is not the boundary — the Lambda validator is.
async function patchPrefsReported(getToken, body, { keepalive = false } = {}) {
  if (!CRITTER_BASE) return { ok: false, status: 0 }
  try {
    const token = await (typeof getToken === 'function' ? getToken() : null)
    if (!token) return { ok: false, status: 0 }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS)
    try {
      const init = {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      }
      // Only when asked: every other caller's request is byte-for-byte what it was.
      if (keepalive) init.keepalive = true
      const res = await fetch(`${CRITTER_BASE}/api/notifications/prefs`, init)
      return res.ok ? { ok: true } : { ok: false, status: res.status }
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return { ok: false, status: 0 }
  }
}

const LOCAL_REFUSAL = { ok: false, status: 400, local: true }

// saveMorePins — the caller's ordered pin list, WHOLE. `[]` is a real value and MUST be sent: the
// route merges each column with COALESCE(new, old), so null or an absent key means "unchanged" and
// removing the last pin by sending nothing would leave it pinned on the server forever.
export async function saveMorePins({ getToken, ids } = {}) {
  if (!Array.isArray(ids) || ids.length > MORE_PINS_MAX_STORED) return LOCAL_REFUSAL
  if (ids.some(id => typeof id !== 'string' || !MORE_PIN_ID_RE.test(id))) return LOCAL_REFUSAL
  if (new Set(ids).size !== ids.length) return LOCAL_REFUSAL
  return patchPrefsReported(getToken, { more_pins: ids })
}

// saveBarLayout — the caller's own bar, as { order, hidden }. Self-scoped: the route writes the
// caller's row and is NOT admin-gated; can_edit_bar only decides who sees the editor (D3). Only the
// two contract keys are sent, whatever else the object carries.
export async function saveBarLayout({ getToken, layout } = {}) {
  const r = resolveBarLayout(layout)
  if (!r.applied.order || !r.applied.hidden) return LOCAL_REFUSAL
  return patchPrefsReported(getToken, { bar_layout: { order: r.order, hidden: r.hidden } })
}

// saveGardenGroupBy — the cross-device Garden grouping (user_notification_prefs.garden_group_by).
// BUG-GARDENGROUPBYRESET-001: was fire-and-forget, returning the row or null, so Garden could not tell a
// save the server has from one a dead zone ate — and the first thing its next mount did was adopt the
// server's older value. Garden now clears its pending marker only on { ok: true } (gardenGroupBy.js). The
// body is not read: ok is the confirmation, and a 200 with an unreadable body is still a stored value.
// A confirmed save moves the count every read compares against (PREDATES_GROUP_BY_SAVE, above the read).
// keepalive: see the note above patchPrefsReported (rimpact #5).
export async function saveGardenGroupBy({ getToken, value } = {}) {
  if (!GARDEN_GROUP_BY_VALUES.includes(value)) return LOCAL_REFUSAL
  const res = await patchPrefsReported(getToken, { garden_group_by: value }, { keepalive: true })
  if (res.ok) groupBySavesConfirmed += 1
  return res
}

// V4-USERPREFS-001 (V4-WHATSNEW-002) — last-seen release version, per user.
// whatsNew.js's header said cross-device sync was "deferred to V4-WHATSNEW-002"; this is it.
export async function saveWhatsNewSeen({ getToken, version } = {}) {
  if (!CRITTER_BASE) return null
  if (typeof version !== 'string' || version === '') return null
  try {
    const token = await (typeof getToken === 'function' ? getToken() : null)
    if (!token) return null
    const res = await fetch(`${CRITTER_BASE}/api/notifications/prefs`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ whats_new_last_seen: version }),
      keepalive: true,
    })
    if (!res.ok) return null
    return await res.json().catch(() => null)
  } catch {
    return null
  }
}
