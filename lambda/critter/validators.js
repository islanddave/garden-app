// Pure validators for /api/critters Lambda. Pulled out of index.js so unit tests can
// import without @neondatabase/serverless / @clerk/backend / @aws-sdk/* in the picture
// (mirrors lambda/events/validators.js pattern).

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// V102 un-gate (L-102 owner-override): full earnable critter pool. Live pool is species_id 1-168;
// the validator bound is 1-254 to leave headroom under the DB CHECK (species_id BETWEEN 1 AND 255)
// for later roster waves without re-touching this gate. Smoke sentinel 255 still accepted (out-of-pool).
export const MVP_SPECIES_MIN = 1
export const MVP_SPECIES_MAX = 254
export const SMOKE_SENTINEL_SPECIES_ID = 255

// POST /api/critters body validator
export function validateCritterPostBody(body) {
  if (!body || typeof body !== 'object') return { status: 400, error: 'body required' }
  if (!body.source_event_id || !UUID_RE.test(body.source_event_id)) {
    return { status: 400, error: 'source_event_id must be a UUID' }
  }
  // plant_id optional in request; absence → 204 (MVP plant-only scope cut per revision §1.1)
  if (body.plant_id != null && !UUID_RE.test(body.plant_id)) {
    return { status: 400, error: 'plant_id must be a UUID' }
  }
  // species_id is client-asserted (deterministic from seed, per Tension 3) within MVP range or sentinel
  if (body.species_id != null) {
    const id = body.species_id
    if (!Number.isInteger(id)) return { status: 400, error: 'species_id must be an integer' }
    const inMvp = id >= MVP_SPECIES_MIN && id <= MVP_SPECIES_MAX
    const isSentinel = id === SMOKE_SENTINEL_SPECIES_ID
    if (!inMvp && !isSentinel) {
      return { status: 400, error: `species_id ${id} out of pool range (1-254) and not smoke sentinel (255)` }
    }
  }
  // meta JSONB allowlist (revision §6 deferred note — prevent behavioral-log creep)
  if (body.meta != null) {
    if (typeof body.meta !== 'object' || Array.isArray(body.meta)) {
      return { status: 400, error: 'meta must be a plain object' }
    }
    const ALLOWED = new Set(['deterministic_seed', 'copy_variant_id', 'client_picked_at'])
    for (const k of Object.keys(body.meta)) {
      if (!ALLOWED.has(k)) return { status: 400, error: `meta.${k} not in allowlist` }
    }
  }
  return null
}

// PATCH /api/notifications/prefs body validator
const CRITTER_VISIT_VALUES = new Set(['off', 'in_app_only', 'system'])
export const GARDEN_GROUP_BY_VALUES = new Set(['none', 'type', 'lifecycle', 'location', 'group', 'freeform'])
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/

export function validatePrefsPatchBody(body) {
  if (!body || typeof body !== 'object') return { status: 400, error: 'body required' }
  if (body.critter_visit != null && !CRITTER_VISIT_VALUES.has(body.critter_visit)) {
    return { status: 400, error: 'critter_visit must be off|in_app_only|system' }
  }
  if (body.quiet_hours_start != null && !TIME_RE.test(body.quiet_hours_start)) {
    return { status: 400, error: 'quiet_hours_start must be HH:MM' }
  }
  if (body.quiet_hours_end != null && !TIME_RE.test(body.quiet_hours_end)) {
    return { status: 400, error: 'quiet_hours_end must be HH:MM' }
  }
  if (body.garden_group_by != null && !GARDEN_GROUP_BY_VALUES.has(body.garden_group_by)) {
    return { status: 400, error: 'garden_group_by must be none|type|lifecycle|location|group|freeform' }
  }
  // At least one updatable field must be present
  const HAS_UPDATABLE = ['critter_visit', 'quiet_hours_start', 'quiet_hours_end', 'garden_group_by']
    .some(k => body[k] != null)
  if (!HAS_UPDATABLE) return { status: 400, error: 'no updatable fields present' }
  return null
}

// PATCH /api/critters/species-prefs body validator (D-INV-1 Option A)
export function validateSpeciesPrefsPatchBody(body) {
  if (!body || typeof body !== 'object') return { status: 400, error: 'body required' }
  const id = body.species_id
  if (!Number.isInteger(id) || id < MVP_SPECIES_MIN || id > MVP_SPECIES_MAX) {
    return { status: 400, error: `species_id must be integer in [${MVP_SPECIES_MIN}, ${MVP_SPECIES_MAX}]` }
  }
  const w = body.weight
  if (typeof w !== 'number' || !Number.isFinite(w) || w <= 0) {
    return { status: 400, error: 'weight must be a positive finite number' }
  }
  // Bound by sanity: 0.1 .. 10. Prevents Jen-edge-case 1000x weight.
  if (w < 0.1 || w > 10) return { status: 400, error: 'weight must be between 0.1 and 10' }
  return null
}

// PATCH /api/critters/viewed body validator (Session 3.5 §3.26 per-sprite mark)
// Body is OPTIONAL: absent body OR missing key → bulk-mark fallback (current behavior).
// Non-empty actually_seen_critter_ids → mark ONLY those ids.
// Sanity cap MAX_MARK_VIEWED_BATCH to prevent abuse.
export const MAX_MARK_VIEWED_BATCH = 200

export function validateMarkViewedPatchBody(body) {
  if (body == null) return null
  if (typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, error: 'body must be a plain object' }
  }
  if (body.actually_seen_critter_ids == null) return null
  const ids = body.actually_seen_critter_ids
  if (!Array.isArray(ids)) {
    return { status: 400, error: 'actually_seen_critter_ids must be an array' }
  }
  if (ids.length > MAX_MARK_VIEWED_BATCH) {
    return { status: 400, error: `actually_seen_critter_ids exceeds max ${MAX_MARK_VIEWED_BATCH}` }
  }
  for (const id of ids) {
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      return { status: 400, error: 'actually_seen_critter_ids items must be UUID strings' }
    }
  }
  return null
}
