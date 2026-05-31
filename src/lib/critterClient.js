// Fire-and-forget critter award client — MVP-Critter Stages 1/2/3 plumbing.
// Spec: revision §2.7 (events Lambda → critter Lambda hook) + §3.10 (failure mode + retry).
// Pattern mirrors src/lib/uxEvents.js (telemetry must never block UX).
//
// HARD RULE: critter POST must NEVER throw into the events flow. Failure path =
// log + swallow + defer to server-side backfill (revision §3.10).
//
// If VITE_API_CRITTERS is unset (not yet provisioned in env), awardCritter is a
// silent no-op (resolves to null). Matches uxEvents.js no-op pattern.
//
// Idempotency: server enforces UNIQUE INDEX on critter_state(source_event_id) per
// revision §3.27. Repeat POSTs return 200 + idempotent=true with the existing row.

import { pickSpecies, pickCopyVariant } from './critterSpecies.js'

const CRITTER_BASE = (import.meta.env.VITE_API_CRITTERS ?? '').replace(/\/$/, '')

// Build the deterministic seed string per revision §2.2 step 4.
// Inputs are stringified defensively — undefined/null become empty so the seed
// is still deterministic for a given event (the source_event_id alone is unique
// enough; created_at + householdId add resilience to upstream id-reuse bugs).
export function buildSeed({ sourceEventId, eventCreatedAt, householdId }) {
  const parts = [
    sourceEventId ?? '',
    eventCreatedAt ?? '',
    householdId ?? '',
  ]
  return parts.join('|')
}

// awardCritter — POSTs /api/critters and returns the critter row (or null on
// failure / no-op).
//
// Inputs:
//   getToken         — async () => string | null (Clerk bearer)
//   sourceEventId    — UUID of the just-created event_log row (required)
//   plantId          — UUID of the event's plant (optional; Lambda re-derives from event)
//   eventCreatedAt   — ISO string from events POST response (for seed)
//   householdId      — string (Clerk sub, typically) — for seed
//   prefs            — { [species_id]: weight } — optional species-pref weights (D-INV-1)
//   tzOffsetMin      — number — JS getTimezoneOffset() value, sent via header
//
// Resolves to:
//   { critter: {...}, idempotent?: boolean } on success (201 or 200-idempotent)
//   null when VITE_API_CRITTERS unset, when source event has no plant_id (204),
//   or when any fetch/parse error occurs (logged via console.warn).
//
// NEVER REJECTS. Caller pattern:
//   const result = await awardCritter({...})
//   if (result?.critter) renderStage1(result.critter)
export async function awardCritter({
  getToken,
  sourceEventId,
  plantId = null,
  eventCreatedAt = null,
  householdId = null,
  prefs = {},
  tzOffsetMin = null,
} = {}) {
  if (!CRITTER_BASE) return null
  if (!sourceEventId) return null
  try {
    const token = await (typeof getToken === 'function' ? getToken() : null)
    if (!token) return null
    const seed = buildSeed({ sourceEventId, eventCreatedAt, householdId })
    const speciesId = pickSpecies(seed, prefs)
    const copyVariantId = pickCopyVariant(seed, 10)
    const tz = Number.isFinite(tzOffsetMin)
      ? tzOffsetMin
      : (typeof Date !== 'undefined' ? new Date().getTimezoneOffset() : 0)
    const body = {
      source_event_id: sourceEventId,
      species_id: speciesId,
      meta: {
        deterministic_seed: seed,
        copy_variant_id: copyVariantId,
      },
    }
    if (plantId) body.plant_id = plantId
    const res = await fetch(`${CRITTER_BASE}/api/critters`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'x-client-tz-offset': String(tz),
      },
      body: JSON.stringify(body),
      keepalive: true, // survive nav-after-save
    })
    if (res.status === 204) return null // MVP plant-only scope (no plant_id on source event)
    if (!res.ok) {
      console.warn(`awardCritter: HTTP ${res.status}`)
      return null
    }
    const json = await res.json().catch(() => null)
    return json && json.critter ? json : null
  } catch (err) {
    // Per revision §3.10: log telemetry, defer to server-side backfill on garden-view open.
    console.warn('awardCritter failed:', err?.message ?? String(err))
    return null
  }
}

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
// keepalive: true survives unmount-on-route-change and visibility-change-on-tab-hide
// (same flag pattern as awardCritter).
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
