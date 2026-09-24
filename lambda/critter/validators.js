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

// V5-NAVCUSTOM-001 — the two per-person nav settings, more_pins and bar_layout. Dave ruled on
// 2026-09-24 that pins (D1) AND the tab bar (D4) are per person, so both live on the caller's own
// prefs row and are validated here with the rest of that row. The database checks shape only
// (migrations/v5-navcustom-001); the vocabulary is checked here. A more_pins id is checked for FORM,
// never against the current More rows: a retired row id must not make every later save by that
// person fail (CONTRACT §3), and the client drops ids it cannot draw at read time.
//
// The shipped tab vocabulary, in the shipped order. Byte-identical to DEFAULT_NAV_TABS in
// src/lib/navConfig.js, the client's copy and the renderer's authority; appConfig.parity.test.js
// asserts the two agree. bar_layout.order must be a permutation of it.
export const NAV_TAB_KEYS = ['today', 'garden', 'create', 'harvests', 'put-up']
// The tabs a person may move off the bar into More. Today (where the app lands) and ＋ (the only door
// to the create sheet and, in field mode, to Field capture) never move; More is not a tab key.
export const MOVABLE_TAB_KEYS = ['garden', 'harvests', 'put-up']
// A More row id, minted once from its route and frozen (src/lib/moreRegistry.js). The client carries
// the same pattern (CONTRACT §4).
export const MORE_PIN_ID_RE = /^[a-z][a-z0-9-]{0,39}$/
// The stored cap, equal to chk_unp_more_pins_shape's. The sheet shows at most 4 pins; the headroom
// keeps pins that are asleep (a flag-off or unknown row) through a save.
export const MORE_PINS_MAX = 32

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
  // V5-NAVCUSTOM-001 — more_pins, in pin order. [] clears; null or absent leaves the stored list alone
  // (the route merges with COALESCE, so it cannot write NULL back). One bad entry refuses the whole
  // list: a partly applied list would silently drop a pin the person just set.
  if (body.more_pins != null) {
    const pins = body.more_pins
    if (!Array.isArray(pins)) return { status: 400, error: 'more_pins must be an array of More row ids' }
    if (pins.length > MORE_PINS_MAX) return { status: 400, error: `more_pins exceeds max ${MORE_PINS_MAX}` }
    // typeof first: RegExp.test coerces its argument, so a nested ["seeds"] would stringify to "seeds"
    // and pass the pattern.
    if (pins.some(id => typeof id !== 'string' || !MORE_PIN_ID_RE.test(id))) {
      return { status: 400, error: 'more_pins entries must be row ids: a lowercase letter, then up to 39 of a-z, 0-9 or -' }
    }
    if (new Set(pins).size !== pins.length) return { status: 400, error: 'more_pins must not repeat an id' }
  }
  // V5-NAVCUSTOM-001 — bar_layout, this person's bar: EXACTLY {order, hidden}. Refused whole, so a
  // valid order never lands beside a bad hidden list. The guards on `order` run in the same sequence as
  // the dormant nav_tabs validator below: array, vocabulary, repeat, arity.
  if (body.bar_layout != null) {
    const layout = body.bar_layout
    if (typeof layout !== 'object' || Array.isArray(layout)) {
      return { status: 400, error: 'bar_layout must be an object with keys order and hidden' }
    }
    const unknown = Object.keys(layout).filter(k => k !== 'order' && k !== 'hidden')
    if (unknown.length > 0) return { status: 400, error: `bar_layout has unknown key: ${unknown.join(', ')}` }
    const { order, hidden } = layout
    if (!Array.isArray(order)) return { status: 400, error: 'bar_layout.order must be an array of tab keys' }
    // Membership also refuses non-strings, nulls and nested arrays (includes() does not coerce).
    if (order.some(k => !NAV_TAB_KEYS.includes(k))) {
      return { status: 400, error: `bar_layout.order entries must be one of: ${NAV_TAB_KEYS.join(', ')}` }
    }
    if (new Set(order).size !== order.length) return { status: 400, error: 'bar_layout.order must not repeat a tab' }
    if (order.length !== NAV_TAB_KEYS.length) {
      return { status: 400, error: `bar_layout.order must list all ${NAV_TAB_KEYS.length} tabs` }
    }
    if (!Array.isArray(hidden)) return { status: 400, error: 'bar_layout.hidden must be an array of tab keys' }
    // Today and ＋ are refused here: each is the only door to something (design §2).
    if (hidden.some(k => !MOVABLE_TAB_KEYS.includes(k))) {
      return { status: 400, error: `bar_layout.hidden entries must be one of: ${MOVABLE_TAB_KEYS.join(', ')}` }
    }
    if (new Set(hidden).size !== hidden.length) return { status: 400, error: 'bar_layout.hidden must not repeat a tab' }
  }
  // At least one updatable field must be present
  const HAS_UPDATABLE = ['critter_visit', 'quiet_hours_start', 'quiet_hours_end', 'garden_group_by', 'garden_sort_order', 'garden_expanded', 'garden_bloom_seen', 'garden_helper_rung1_seen', 'today_skipped', 'log_many_all_selected', 'whats_new_last_seen', 'more_pins', 'bar_layout']
    .some(k => body[k] != null)
  if (!HAS_UPDATABLE) return { status: 400, error: 'no updatable fields present' }
  return null
}

// ─── /api/app-config — DORMANT since V5-NAVCUSTOM-001 (was GLOBAL config, V5-ADMINCENTER-001) ──────
//
// The SPA stopped reading and writing this route in V5-NAVCUSTOM-001. Dave ruled on 2026-09-24 (D4)
// that the tab bar is per person — only his bar changes, and Jen's never shifts — which reverses his
// 2026-09-08 ruling that nav_tabs is one global order for the installation. The per-person bar is
// bar_layout on the caller's own prefs row, validated in validatePrefsPatchBody above. The route and
// the helpers in this section stay, behaviour unchanged, only so a client that is still rolling out
// gets a 200 rather than a 404; removing them is a follow-up ledger row, not this release.
//
// `nav_tabs` must still never be added to HAS_UPDATABLE: it is the dormant GLOBAL key, and a key on
// the prefs route writes the caller's own row. The per-person setting is bar_layout.
//
// What stays true while the route exists: the store is public.app_config (key text PK | value jsonb |
// updated_at), which predates this code (created 2026-04-23 in the Supabase era, 0 rows on prod). Its
// RLS policies admit any authenticated caller, so RLS cannot express an admin restriction — which is
// why the PATCH's admin gate stays mandatory for as long as the route does.

// The write-side key allowlist. An unrecognised key 400s BEFORE any SQL is built, which is the
// safety property V101 §3 identified as load-bearing: the guard is the allowlist, not the storage.
export const APP_CONFIG_KEYS = ['nav_tabs']

// The allowlist, parsed at CALL TIME rather than cached at module init — so a Lambda config change
// takes effect on the next invocation instead of on the next cold start.
function adminSubs(env) {
  return (env?.ADMIN_CLERK_SUBS ?? '').split(',').map(s => s.trim()).filter(Boolean)
}

// Fail-CLOSED admin check. Unset/empty ADMIN_CLERK_SUBS -> nobody is admin. Two callers:
//   * the dormant app-config PATCH, through adminRefusal below (403 for everyone when unset);
//   * GET /api/notifications/prefs, which reports it as can_edit_bar (V5-NAVCUSTOM-001). That flag
//     decides only who SEES the bar editor (D3: today, Dave). It never gates a write — the prefs PATCH
//     writes the caller's own row, so a bar_layout save needs no admin check.
// ADMIN_CLERK_SUBS is per-function Lambda runtime config: deploy-lambda.yml sets it on garden-critter
// in a continue-on-error step, and deploy-staging.yml does not set it on garden-critter-staging, so
// can_edit_bar is false for everyone on staging. Copied from lambda/tags/validate.js:56-60 rather than
// reinvented — four Lambdas, one idiom, and this is the fifth.
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
// reported — absent ones as null — so a client sees "unset" rather than a key simply missing from the
// object; the client resolver that read this route (resolveNavTabs, until V5-NAVCUSTOM-001) maps null
// to the shipped bar. app_config has zero rows in prod, so "never configured" is the natural state
// and no seeding row is needed or wanted.
export function projectAppConfig(rows) {
  const out = Object.fromEntries(APP_CONFIG_KEYS.map(k => [k, null]))
  for (const r of Array.isArray(rows) ? rows : []) {
    if (APP_CONFIG_KEYS.includes(r?.key)) out[r.key] = r.value ?? null
  }
  return out
}

// PATCH /api/app-config body validator — DORMANT with its route (section header above); unchanged.
//
// Its guard order (array, vocabulary, duplicate, arity) mirrors resolveNavTabs in
// src/lib/navConfig.js, the client resolver that read this key until V5-NAVCUSTOM-001, and
// bar_layout.order above repeats the same sequence. It is REORDER-ONLY: a short array (including []) is
// a hide attempt and a long one an add, and both are refused whole. Hiding now happens per person, in
// bar_layout.hidden, which admits only the movable tabs; nothing here was widened to allow it, so an old
// client that still saves nav_tabs can only ever store a full five-tab order.
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
