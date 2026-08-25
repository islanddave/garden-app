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

const CRITTER_BASE = (import.meta.env.VITE_API_CRITTERS ?? '').replace(/\/$/, '')

export const CRITTER_VISIT_VALUES = ['off', 'in_app_only', 'system']
export const GARDEN_GROUP_BY_VALUES = ['none', 'type', 'lifecycle', 'heat', 'determinacy', 'day_length', 'allium_type', 'basil_use', 'bean_type', 'bean_habit', 'bean_use', 'location', 'group', 'freeform', 'status']
export const GARDEN_SORT_ORDER_VALUES = ['alpha', 'recency']
// Re-exported (not redeclared) from the layout module so the wire contract and the render contract
// cannot drift: handedness.js is what every surface reads, and this is what gets PATCHed. Imported
// as well as re-exported — a bare `export ... from` does not bind the name in this module's scope,
// and saveHandedness below validates against it.
export const HANDEDNESS_VALUES = HANDS
export const GARDEN_EXPANDED_MAX = 2000

// saveGardenGroupBy — fire-and-forget PATCH of the cross-device Garden group-by preference
// (user_notification_prefs.garden_group_by). Mirrors patchNotificationPrefs: NEVER throws,
// silent no-op when env unset / unauth / value invalid. keepalive survives route-change unmount.
export async function saveGardenGroupBy({ getToken, value } = {}) {
  if (!CRITTER_BASE) return null
  if (value != null && !GARDEN_GROUP_BY_VALUES.includes(value)) return null
  try {
    const token = await (typeof getToken === 'function' ? getToken() : null)
    if (!token) return null
    const res = await fetch(`${CRITTER_BASE}/api/notifications/prefs`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ garden_group_by: value }),
      keepalive: true,
    })
    if (!res.ok) return null
    return await res.json().catch(() => null)
  } catch {
    return null
  }
}

// saveGardenSortOrder — fire-and-forget PATCH of the cross-device Garden sort-order preference
// (user_notification_prefs.garden_sort_order). Mirrors saveGardenGroupBy: NEVER throws, silent
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

// fetchNotificationPrefs — GETs current prefs.
// Returns the prefs object on success, null on no-op or failure (NEVER throws).
export async function fetchNotificationPrefs({ getToken } = {}) {
  if (!CRITTER_BASE) return null
  try {
    const token = await (typeof getToken === 'function' ? getToken() : null)
    if (!token) return null
    const res = await fetch(`${CRITTER_BASE}/api/notifications/prefs`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return null
    const json = await res.json().catch(() => null)
    return json && typeof json === 'object' ? json : null
  } catch {
    return null
  }
}

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
// saveGardenGroupBy above. This is the correct posture here specifically: the caller has ALREADY
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
