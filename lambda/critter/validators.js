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

// ─── /api/app-config — GLOBAL, installation-wide config (V5-ADMINCENTER-001) ───────────────────
//
// A DIFFERENT SCOPE FROM EVERYTHING ABOVE, and that is the whole reason it is a separate route
// rather than another key on validatePrefsPatchBody. Dave ruled 2026-09-08 that nav_tabs is GLOBAL —
// one nav order for the installation, not one per person. Every other validator in this file guards
// a write to public.user_notification_prefs, which is keyed by created_by and cannot express an
// installation-wide fact. `nav_tabs` is deliberately NOT in HAS_UPDATABLE at the top of this file
// and must not be added there: that route is the wrong door regardless of ordering.
//
// The store is public.app_config (key text PK | value jsonb | updated_at), which already existed in
// live prod — created 2026-04-23 in the Supabase era, 0 rows, 0 code references until this row. No
// DDL was written for this feature. Its RLS policies are already global (any authenticated caller
// may read AND write), so RLS cannot express the admin restriction — which is the structural reason
// the gate below is mandatory rather than defence-in-depth.

// The write-side key allowlist. An unrecognised key 400s BEFORE any SQL is built, which is the
// safety property V101 §3 identified as load-bearing: the guard is the allowlist, not the storage.
export const APP_CONFIG_KEYS = ['nav_tabs']

// The shipped tab vocabulary. Byte-identical to DEFAULT_NAV_TABS in src/lib/navConfig.js, which is
// the client's copy and the renderer's authority; appConfig.parity.test.js asserts the two agree, in
// the house pattern critterSpecies.parity.test.js established for the same class of duplication.
export const NAV_TAB_KEYS = ['today', 'garden', 'create', 'harvests', 'put-up']

// The allowlist, parsed at CALL TIME rather than cached at module init — so a Lambda config change
// takes effect on the next invocation instead of on the next cold start.
function adminSubs(env) {
  return (env?.ADMIN_CLERK_SUBS ?? '').split(',').map(s => s.trim()).filter(Boolean)
}

// Fail-CLOSED admin gate. Unset/empty ADMIN_CLERK_SUBS -> nobody is admin -> 403 for everyone,
// including Dave. That is the safe failure and it will look like a bug: ADMIN_CLERK_SUBS is
// per-function Lambda runtime config, so this function needs the var set ON IT (it is set on
// facebook-share, projects, tags and ux-events, and was never set here) before the gate admits
// anyone. Copied from lambda/tags/validate.js:56-60 rather than reinvented — four Lambdas, one
// idiom, and this is the fifth.
export function isAdmin(userId, env) {
  const subs = adminSubs(env)
  return subs.length > 0 && subs.includes(userId)
}

// The refusal, split in two the way lambda/projects/index.js:598-605 splits it: "not configured" and
// "not you" are different operational facts and collapsing them costs a deploy-debugging session.
// Built ON isAdmin rather than beside it — a second copy of the split-and-trim would be a redundant
// suppression that hides a mutation in the first.
export function adminRefusal(userId, env) {
  if (adminSubs(env).length === 0) return { status: 403, error: 'Admin route not configured' }
  if (!isAdmin(userId, env)) return { status: 403, error: 'Not authorized' }
  return null
}

// The GET's row -> response projection. EXTRACTED SO IT CAN BE TESTED: importing
// lambda/critter/index.js is impossible in this suite (its Lambda runtime deps are deliberately not
// installed), so a projection left inline there would be asserted by nothing.
//
// NO ROW = SHIPPED DEFAULT, made explicit here rather than implied. Every allowlisted key is
// reported — absent ones as null — so the client sees "unset" rather than a key simply missing from
// the object, and resolveNavTabs maps null to the shipped bar. app_config has zero rows in prod, so
// "never configured" is already the natural state and no seeding row is needed or wanted.
export function projectAppConfig(rows) {
  const out = Object.fromEntries(APP_CONFIG_KEYS.map(k => [k, null]))
  for (const r of Array.isArray(rows) ? rows : []) {
    if (APP_CONFIG_KEYS.includes(r?.key)) out[r.key] = r.value ?? null
  }
  return out
}

// PATCH /api/app-config body validator.
//
// GUARD ORDER MIRRORS resolveNavTabs (src/lib/navConfig.js) DELIBERATELY — array, then vocabulary,
// then duplicate, then arity. Two enforcement points on one contract, the same shape today_skipped
// carries above: this one turns a bad write into a 400 the admin page can state, and the client
// resolver is the total renderer that cannot be bypassed by a hand-written database row. There is no
// third point: app_config is a generic k/v table and a nav_tabs-specific CHECK would be the wrong
// shape on it.
//
// V1 IS REORDER-ONLY, enforced here as a permutation rule. A short array (including []) is a hide
// attempt and a long one is an add; both are refused whole rather than partly applied. Hiding a tab
// removes the only door to a page — the defect class DebugMenu.reachability.test.jsx exists to
// catch, arriving by another route — and the hide-vs-reorder question is still Dave's (design §7).
export function validateAppConfigPatchBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { status: 400, error: 'body required' }
  const unknown = Object.keys(body).filter(k => !APP_CONFIG_KEYS.includes(k))
  if (unknown.length > 0) return { status: 400, error: `unknown config key: ${unknown.join(', ')}` }
  if (body.nav_tabs === undefined) return { status: 400, error: 'no updatable fields present' }
  const tabs = body.nav_tabs
  if (!Array.isArray(tabs)) return { status: 400, error: 'nav_tabs must be an array of tab keys' }
  // Membership also rejects non-string entries (numbers, nulls, nested objects), so a separate
  // typeof pass would be a redundant suppression hiding mutations in this one.
  if (tabs.some(k => !NAV_TAB_KEYS.includes(k))) {
    return { status: 400, error: `nav_tabs entries must be one of: ${NAV_TAB_KEYS.join(', ')}` }
  }
  if (new Set(tabs).size !== tabs.length) return { status: 400, error: 'nav_tabs must not repeat a tab' }
  if (tabs.length !== NAV_TAB_KEYS.length) {
    return { status: 400, error: `nav_tabs must list all ${NAV_TAB_KEYS.length} tabs — v1 is reorder-only` }
  }
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
