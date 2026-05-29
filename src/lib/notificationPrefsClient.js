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

const CRITTER_BASE = (import.meta.env.VITE_API_CRITTERS ?? '').replace(/\/$/, '')

export const CRITTER_VISIT_VALUES = ['off', 'in_app_only', 'system']

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
