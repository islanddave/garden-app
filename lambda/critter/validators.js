// Pure validators for /api/critters Lambda. Pulled out of index.js so unit tests can
// import without @neondatabase/serverless / @clerk/backend / @aws-sdk/* in the picture
// (mirrors lambda/events/validators.js pattern).

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// NOTE: validateCritterPostBody was removed with POST /api/critters (BUG-CRITTERSELFGRANT-001; see
// the tombstone in index.js). Its SMOKE_SENTINEL_SPECIES_ID went with it — that route was the only
// caller, and critterSpecies.js holds the copy the client/lambda parity tests actually compare.
//
// The two range constants STAY: validateSpeciesPrefsPatchBody bounds its species_id with them, so
// they were never exclusive to the retired route. Same values, same reason.
// V102 un-gate (L-102 owner-override): full earnable critter pool. Live pool is species_id 1-168;
// the bound is 1-254 to leave headroom under the DB CHECK (species_id BETWEEN 1 AND 255) for later
// roster waves without re-touching this gate.
export const MVP_SPECIES_MIN = 1
export const MVP_SPECIES_MAX = 254

// PATCH /api/notifications/prefs body validator
const CRITTER_VISIT_VALUES = new Set(['off', 'in_app_only', 'system'])
export const GARDEN_GROUP_BY_VALUES = new Set(['none', 'type', 'lifecycle', 'heat', 'determinacy', 'day_length', 'allium_type', 'basil_use', 'location', 'group', 'freeform', 'status'])
export const GARDEN_SORT_ORDER_VALUES = new Set(['alpha', 'recency'])
export const GARDEN_EXPANDED_MAX = 2000
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/
// V4-USERPREFS-001 — today_skipped.date. Format-only, matching the DB CHECK's own strictness:
// calendar validity is not asserted because the client writes todayLocalISO() and a wrong-but-
// well-formed date self-heals on the next day boundary (the set is ignored when date != today).
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

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
    return { status: 400, error: 'garden_group_by must be none|type|lifecycle|heat|determinacy|day_length|allium_type|basil_use|location|group|freeform|status' }
  }
  if (body.garden_sort_order != null && !GARDEN_SORT_ORDER_VALUES.has(body.garden_sort_order)) {
    return { status: 400, error: 'garden_sort_order must be alpha|recency' }
  }
  if (body.garden_expanded != null) {
    if (!Array.isArray(body.garden_expanded) || body.garden_expanded.some(x => typeof x !== 'string')) {
      return { status: 400, error: 'garden_expanded must be an array of id strings' }
    }
    if (body.garden_expanded.length > GARDEN_EXPANDED_MAX) {
      return { status: 400, error: 'garden_expanded exceeds max size' }
    }
  }
  if (body.garden_bloom_seen != null) {
    if (!Array.isArray(body.garden_bloom_seen) || body.garden_bloom_seen.some(x => typeof x !== 'string')) {
      return { status: 400, error: 'garden_bloom_seen must be an array of id strings' }
    }
    if (body.garden_bloom_seen.length > GARDEN_EXPANDED_MAX) {
      return { status: 400, error: 'garden_bloom_seen exceeds max size' }
    }
  }
  if (body.garden_helper_rung1_seen != null && typeof body.garden_helper_rung1_seen !== 'boolean') {
    return { status: 400, error: 'garden_helper_rung1_seen must be a boolean' }
  }
  // V4-USERPREFS-001 — the three per-device UI states that became per-user server state
  // (V4-TODAYLOC-002, V4-LOGMANY-001, V4-WHATSNEW-002).
  //
  // today_skipped is validated to the SAME object contract as the DB CHECK
  // (chk_unp_today_skipped_shape). Two enforcement points on one contract is deliberate: the DB
  // guard is the one that cannot be bypassed, and this one is what turns a malformed write into a
  // 400 the client can act on rather than a 500 from a constraint violation.
  if (body.today_skipped != null) {
    const ts = body.today_skipped
    if (typeof ts !== 'object' || Array.isArray(ts)) {
      return { status: 400, error: 'today_skipped must be an object' }
    }
    if (typeof ts.date !== 'string' || !DATE_RE.test(ts.date)) {
      return { status: 400, error: 'today_skipped.date must be YYYY-MM-DD' }
    }
    if (!Array.isArray(ts.keys) || ts.keys.some(x => typeof x !== 'string')) {
      return { status: 400, error: 'today_skipped.keys must be an array of strings' }
    }
    // Same bound as the other collection columns. The suppress set is one entry per care row on a
    // single day, so a body anywhere near this ceiling is a bug or an attack, not a big garden.
    if (ts.keys.length > GARDEN_EXPANDED_MAX) {
      return { status: 400, error: 'today_skipped.keys exceeds max size' }
    }
  }
  if (body.log_many_all_selected != null && typeof body.log_many_all_selected !== 'boolean') {
    return { status: 400, error: 'log_many_all_selected must be a boolean' }
  }
  // Deliberately NOT semver-validated. The client compares this against its own build version and
  // treats anything it cannot parse as "show the dot" — a strict format check here would reject a
  // legitimate future version scheme and permanently wedge the dot instead.
  if (body.whats_new_last_seen != null) {
    if (typeof body.whats_new_last_seen !== 'string' || body.whats_new_last_seen.length > 32) {
      return { status: 400, error: 'whats_new_last_seen must be a string of at most 32 chars' }
    }
  }
  // At least one updatable field must be present
  const HAS_UPDATABLE = ['critter_visit', 'quiet_hours_start', 'quiet_hours_end', 'garden_group_by', 'garden_sort_order', 'garden_expanded', 'garden_bloom_seen', 'garden_helper_rung1_seen', 'today_skipped', 'log_many_all_selected', 'whats_new_last_seen']
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
