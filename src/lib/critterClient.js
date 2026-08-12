// Fire-and-forget critter award client — MVP-Critter Stages 1/2/3 plumbing.
// Spec: revision §2.7 (events Lambda → critter Lambda hook) + §3.10 (failure mode + retry).
// Pattern mirrors src/lib/uxEvents.js (telemetry must never block UX).
//
// HARD RULE: critter POST must NEVER throw into the events flow. Failure path =
// log + swallow + defer to server-side backfill (revision §3.10).
//
// If VITE_API_CRITTERS is unset (not yet provisioned in env), every reader below is a
// silent no-op (resolves to null). Matches uxEvents.js no-op pattern.
//
// Idempotency: server enforces UNIQUE INDEX on critter_state(source_event_id) per
// revision §3.27. Repeat POSTs return 200 + idempotent=true with the existing row.

const CRITTER_BASE = (import.meta.env.VITE_API_CRITTERS ?? '').replace(/\/$/, '')

// awardCritter() and its buildSeed() helper were REMOVED 2026-08-12 with the server route they
// called (POST /api/critters — BUG-CRITTERSELFGRANT-001; the tombstone in lambda/critter/index.js
// has the evidence). awardCritter had had zero call sites since the events Lambda's server-side
// hook replaced it (EventNew.jsx:1041), and buildSeed existed only to feed it. The SERVER seed
// builder in lambda/events/critterAward.js is independent and unchanged — it is what produces
// meta.deterministic_seed on all 1277 live critter_state rows.

// fetchActiveCritters — GETs /api/critters/active for the Stage 3 dot.
// Returns array (possibly empty) on success, [] on no-op or failure (NEVER throws).
export async function fetchActiveCritters({ getToken } = {}) {
  if (!CRITTER_BASE) return []
  try {
    const token = await (typeof getToken === 'function' ? getToken() : null)
    if (!token) return []
    const res = await fetch(`${CRITTER_BASE}/api/critters/active`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return []
    const json = await res.json().catch(() => null)
    return (json && Array.isArray(json.critters)) ? json.critters : []
  } catch {
    return []
  }
}

// fetchCollection — GETs /api/critters/collection for the Stickerbook (Collection page Phase 2).
// Per-user lifetime species summary; each row: { species_id, count, first_seen_at, last_seen_at }.
// Returns the full response object { species: [...] } on success, null on no-op or failure.
// NEVER throws. Mirrors fetchActiveCritters pattern but returns the wrapper object so the
// hook can distinguish "fetched-but-empty" (loading→done, []) from "no-op" (env unset or auth fail).
export async function fetchCollection({ getToken } = {}) {
  if (!CRITTER_BASE) return null
  try {
    const token = await (typeof getToken === 'function' ? getToken() : null)
    if (!token) return null
    const res = await fetch(`${CRITTER_BASE}/api/critters/collection`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return null
    const json = await res.json().catch(() => null)
    if (!json || typeof json !== 'object') return null
    return { species: Array.isArray(json.species) ? json.species : [] }
  } catch {
    return null
  }
}

// markCrittersViewed — PATCHes /api/critters/viewed with race-window header.
// Returns array of marked-viewed ids, [] on no-op or failure.
//
// Session 3.5 (revision §3.26): optional actuallySeenCritterIds (string[] of UUIDs).
// - When omitted / null / empty array → no body sent; Lambda bulk-marks (legacy path).
// - When non-empty → POSTs body { actually_seen_critter_ids: [...] }; Lambda marks ONLY those.
//
// keepalive: true survives unmount-on-route-change and visibility-change-on-tab-hide.
export async function markCrittersViewed({ getToken, openedAt = null, actuallySeenCritterIds = null } = {}) {
  if (!CRITTER_BASE) return []
  try {
    const token = await (typeof getToken === 'function' ? getToken() : null)
    if (!token) return []
    const gate = openedAt ?? new Date().toISOString()
    const headers = {
      Authorization: `Bearer ${token}`,
      'x-garden-view-opened-at': gate,
    }
    const init = { method: 'PATCH', headers, keepalive: true }
    if (Array.isArray(actuallySeenCritterIds) && actuallySeenCritterIds.length > 0) {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify({ actually_seen_critter_ids: actuallySeenCritterIds })
    }
    const res = await fetch(`${CRITTER_BASE}/api/critters/viewed`, init)
    if (!res.ok) return []
    const json = await res.json().catch(() => null)
    return (json && Array.isArray(json.marked_viewed_ids)) ? json.marked_viewed_ids : []
  } catch {
    return []
  }
}

// patchSpeciesPrefs — D-INV-1 Option A long-press love/meh weight write.
// Spec: revision §3.29 (Investment loop). Mirrors uxEvents fire-and-forget contract:
// silent no-op when env unset, NEVER rejects, returns null on failure.
//
// Inputs:
//   getToken   — async () => string | null
//   speciesId  — integer in [1,8] (validated client-side; Lambda re-validates)
//   weight     — number; 2.0 = love, 0.5 = meh, 1.0 = reset to default
//
// Resolves to the updated row { created_by, species_id, weight, set_at } or null.
export async function patchSpeciesPrefs({ getToken, speciesId, weight } = {}) {
  if (!CRITTER_BASE) return null
  if (!Number.isInteger(speciesId) || speciesId < 1 || speciesId > 8) return null
  if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) return null
  try {
    const token = await (typeof getToken === 'function' ? getToken() : null)
    if (!token) return null
    const res = await fetch(`${CRITTER_BASE}/api/critters/species-prefs`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ species_id: speciesId, weight }),
    })
    if (!res.ok) return null
    return await res.json().catch(() => null)
  } catch (err) {
    console.warn('patchSpeciesPrefs failed:', err?.message ?? String(err))
    return null
  }
}
