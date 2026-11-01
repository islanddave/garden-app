// Pure validators for /api/critters Lambda. Pulled out of index.js so unit tests can
// import without @neondatabase/serverless / @clerk/backend / @aws-sdk/* in the picture
// (mirrors lambda/events/validators.js pattern).

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// The two range constants serve validateSpeciesPrefsPatchBody (POST /api/critters was removed,
// BUG-CRITTERSELFGRANT-001; see the tombstone in index.js). Live pool is species_id 1-168; the bound is
// 1-254 to leave headroom under the DB CHECK (species_id BETWEEN 1 AND 255).
export const MVP_SPECIES_MIN = 1
export const MVP_SPECIES_MAX = 254

// PATCH /api/notifications/prefs body validator
const CRITTER_VISIT_VALUES = new Set(['off', 'in_app_only', 'system'])
// Every value Garden's group-by control can offer (src/lib/gardenGroupBy.js). The client keeps its own copy
// (GARDEN_GROUP_BY_VALUES in src/lib/notificationPrefsClient.js); groupby.parity.test.js pins the two lists
// together AND against the control. A value missing here 400s, the server keeps an older one, and Garden re-adopts it.
export const GARDEN_GROUP_BY_VALUES = new Set(['none', 'type', 'crop_type', 'lifecycle', 'heat', 'determinacy', 'day_length', 'allium_type', 'basil_use', 'bean_type', 'bean_habit', 'bean_use', 'location', 'group', 'freeform', 'status'])
export const GARDEN_SORT_ORDER_VALUES = new Set(['alpha', 'recency'])
export const GARDEN_EXPANDED_MAX = 2000
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/
// today_skipped.date: format-only, matching the DB CHECK's strictness; a wrong-but-well-formed date
// self-heals at the next day boundary (the set is ignored when date != today).
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// Per-person nav settings, more_pins and bar_layout, both on the caller's own prefs row. The database
// checks shape only (migrations/v5-navcustom-001); the vocabulary is checked here. A more_pins id is
// checked for FORM, never against the current More rows: a retired row id must not make every later save
// fail (CONTRACT §3), and the client drops ids it cannot draw.
//
// The shipped tab vocabulary, in shipped order. Byte-identical to DEFAULT_NAV_TABS in src/lib/navConfig.js;
// appConfig.parity.test.js asserts the two agree. Also the reset value and the slot cap (BAR_MAX_SLOTS).
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
// bar_layout.order is the bar itself, left to right: distinct ids of the MORE_PIN_ID_RE form (a tab key or
// a More row id), holding Today and ＋, at most BAR_MAX_SLOTS long. Checked for FORM like more_pins (the
// Lambda does not know the client's More rows). A pre-change {order: [the five], hidden: [...]} still passes.
// Byte-identical to navConfig.js BAR_REQUIRED_KEYS / BAR_MAX_SLOTS (navcustom.parity.test.js).
export const BAR_REQUIRED_KEYS = ['today', 'create']
export const BAR_MAX_SLOTS = NAV_TAB_KEYS.length

// today_sections: the Today page's remembered open/closed state, {v:1, <section>: {open, at, ack?}}, one
// entry per section key, written only by an explicit header tap. The database checks shape only
// (migrations/v5-todaysections-001); this is the contract. The client's copy is
// src/lib/todayV2/sectionsWire.js; todaySections.parity.test.js runs both over one table of bodies.
//
// KEYS ARE A WHITELIST: the seven fixed sections and one household section per member, 'hh-' + the first 8
// characters of that member's Clerk sub (HouseholdSection.jsx householdKey). A sub is `user_` + base62, so
// the tail carries '_' and capitals; a lowercase-only form would refuse every real household key. A section
// added later is added here in the same release; until then the client keeps that entry on the device.
export const TODAY_SECTION_KEYS = ['glance', 'protect', 'headsup', 'care', 'harvest', 'putup', 'resting']
export const TODAY_SECTION_HH_RE = /^hh-[A-Za-z0-9_-]{1,8}$/
// The ack vocabulary is what triggers.js records (its header names this validator): t is a Protect tier
// (TIER_RANK's keys), r one reason type or a list of them (CARE_REASONS ∪ HEADSUP_REASONS).
export const TODAY_SECTION_ACK_TIERS = ['chill', 'frost', 'hardfreeze']
export const TODAY_SECTION_ACK_REASONS = ['never', 'hot', 'small', 'window', 'deadline']
// v plus 23 sections: headroom, not a limit anyone meets; the byte cap bounds the body.
export const TODAY_SECTIONS_MAX_KEYS = 24
export const TODAY_SECTIONS_MAX_CHARS = 4096
export const TODAY_SECTIONS_VERSION = 1

const plainObject = (x) => x != null && typeof x === 'object' && !Array.isArray(x)
export const todaySectionKeyOk = (k) => TODAY_SECTION_KEYS.includes(k) || TODAY_SECTION_HH_RE.test(k)

// One entry, or the reason it is refused. EXACTLY {open, at} or {open:false, at, ack}: an ack records a
// close made while a trigger held the section open (MF1), so an open entry never carries one — and the
// ack is date-scoped by the entry's own `at`, which is why it has no date of its own.
export function todaySectionEntryError(e) {
  if (!plainObject(e)) return 'must be an object {open, at}'
  const unknown = Object.keys(e).filter(k => k !== 'open' && k !== 'at' && k !== 'ack')
  if (unknown.length > 0) return `has unknown key: ${unknown.join(', ')}`
  if (typeof e.open !== 'boolean') return 'open must be a boolean'
  if (typeof e.at !== 'string' || !DATE_RE.test(e.at)) return 'at must be YYYY-MM-DD'
  if (e.ack === undefined) return null
  if (e.open !== false) return 'ack is allowed only on a close (open:false)'
  if (!plainObject(e.ack)) return 'ack must be an object {t?, r?}'
  const ackUnknown = Object.keys(e.ack).filter(k => k !== 't' && k !== 'r')
  if (ackUnknown.length > 0) return `ack has unknown key: ${ackUnknown.join(', ')}`
  if (e.ack.t === undefined && e.ack.r === undefined) return 'ack must carry t or r'
  if (e.ack.t !== undefined && !TODAY_SECTION_ACK_TIERS.includes(e.ack.t)) {
    return `ack.t must be one of: ${TODAY_SECTION_ACK_TIERS.join(', ')}`
  }
  if (e.ack.r !== undefined) {
    const rs = Array.isArray(e.ack.r) ? e.ack.r : [e.ack.r]
    if (rs.length === 0 || rs.some(r => !TODAY_SECTION_ACK_REASONS.includes(r)) || new Set(rs).size !== rs.length) {
      return `ack.r must be one of ${TODAY_SECTION_ACK_REASONS.join(', ')}, or a list of them without repeats`
    }
  }
  return null
}

// The whole today_sections value of a PATCH, or the reason it is refused. Refused whole: a partly applied
// set would silently drop a tap the person just made.
export function todaySectionsError(ts) {
  if (!plainObject(ts)) return 'today_sections must be an object'
  if (ts.v !== TODAY_SECTIONS_VERSION) return `today_sections.v must be ${TODAY_SECTIONS_VERSION}`
  const keys = Object.keys(ts)
  if (keys.length > TODAY_SECTIONS_MAX_KEYS) return `today_sections exceeds max ${TODAY_SECTIONS_MAX_KEYS} keys`
  const sections = keys.filter(k => k !== 'v')
  if (sections.length === 0) return 'today_sections carries no section'
  const unknown = sections.filter(k => !todaySectionKeyOk(k))
  if (unknown.length > 0) return `today_sections has unknown section key: ${unknown.join(', ')}`
  for (const k of sections) {
    const err = todaySectionEntryError(ts[k])
    if (err) return `today_sections.${k} ${err}`
  }
  if (JSON.stringify(ts).length > TODAY_SECTIONS_MAX_CHARS) return `today_sections exceeds ${TODAY_SECTIONS_MAX_CHARS} characters`
  return null
}

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
    // Built from the set so the text cannot drift from what is accepted.
    return { status: 400, error: `garden_group_by must be ${[...GARDEN_GROUP_BY_VALUES].join('|')}` }
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
  // Per-user UI state (formerly per-device). today_skipped is validated to the SAME object contract as the
  // DB CHECK (chk_unp_today_skipped_shape): the DB guard cannot be bypassed; this one turns a malformed
  // write into a 400 the client can act on rather than a 500.
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
  // more_pins, in pin order. [] clears; null or absent leaves the stored list alone (the route merges
  // with COALESCE). One bad entry refuses the whole list: a partly applied list would silently drop a pin.
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
  // bar_layout: EXACTLY {order, hidden}, refused whole. The guards on `order` run in the same sequence as
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
    // Form. The typeof half refuses non-strings, nulls and nested arrays (test() would coerce ['today']).
    if (order.some(k => !(typeof k === 'string' && MORE_PIN_ID_RE.test(k)))) {
      return { status: 400, error: 'bar_layout.order entries must be tab keys or More row ids: a lowercase letter, then up to 39 of a-z, 0-9 or -' }
    }
    if (new Set(order).size !== order.length) return { status: 400, error: 'bar_layout.order must not repeat a tab' }
    // Today and ＋ each stay: each is the only door to something (design §2).
    const missing = BAR_REQUIRED_KEYS.filter(k => !order.includes(k))
    if (missing.length > 0) {
      return { status: 400, error: `bar_layout.order must include ${BAR_REQUIRED_KEYS.join(' and ')}` }
    }
    if (order.length > BAR_MAX_SLOTS) {
      return { status: 400, error: `bar_layout.order may hold at most ${BAR_MAX_SLOTS} tabs` }
    }
    if (!Array.isArray(hidden)) return { status: 400, error: 'bar_layout.hidden must be an array of tab keys' }
    // Today and ＋ are refused here: each is the only door to something (design §2).
    if (hidden.some(k => !MOVABLE_TAB_KEYS.includes(k))) {
      return { status: 400, error: `bar_layout.hidden entries must be one of: ${MOVABLE_TAB_KEYS.join(', ')}` }
    }
    if (new Set(hidden).size !== hidden.length) return { status: 400, error: 'bar_layout.hidden must not repeat a tab' }
  }
  // today_sections is SENT ALONE: the route writes it with its own statement so a database without the
  // column (migrations/v5-todaysections-001 not yet applied) can refuse it with 409 BEFORE anything is
  // written; a body that also carried another field would be half saved.
  if (body.today_sections != null) {
    const others = Object.keys(body).filter(k => k !== 'today_sections' && body[k] != null)
    if (others.length > 0) return { status: 400, error: `today_sections must be sent alone (also present: ${others.join(', ')})` }
    const err = todaySectionsError(body.today_sections)
    if (err) return { status: 400, error: err }
  }
  // At least one updatable field must be present
  const HAS_UPDATABLE = ['critter_visit', 'quiet_hours_start', 'quiet_hours_end', 'garden_group_by', 'garden_sort_order', 'garden_expanded', 'garden_bloom_seen', 'garden_helper_rung1_seen', 'today_skipped', 'log_many_all_selected', 'whats_new_last_seen', 'more_pins', 'bar_layout', 'today_sections']
    .some(k => body[k] != null)
  if (!HAS_UPDATABLE) return { status: 400, error: 'no updatable fields present' }
  return null
}

// /api/app-config: DORMANT since V5-NAVCUSTOM-001 (was GLOBAL config).
//
// The SPA no longer reads or writes this route; the tab bar is per person (bar_layout on the caller's own
// prefs row, validated in validatePrefsPatchBody above). The route and helpers stay, behaviour unchanged,
// only so a client still rolling out gets a 200 rather than a 404.
//
// `nav_tabs` must never be added to HAS_UPDATABLE: it is the dormant GLOBAL key, and a key on the prefs
// route writes the caller's own row.
//
// The store is public.app_config (key text PK | value jsonb | updated_at). Its RLS policies admit any
// authenticated caller, so RLS cannot express an admin restriction; the PATCH's admin gate is mandatory
// for as long as the route exists.

// The write-side key allowlist. An unrecognised key 400s BEFORE any SQL is built, which is the
// safety property V101 §3 identified as load-bearing: the guard is the allowlist, not the storage.
export const APP_CONFIG_KEYS = ['nav_tabs']

// The allowlist, parsed at CALL TIME rather than cached at module init — so a Lambda config change
// takes effect on the next invocation instead of on the next cold start.
function adminSubs(env) {
  return (env?.ADMIN_CLERK_SUBS ?? '').split(',').map(s => s.trim()).filter(Boolean)
}

// Fail-CLOSED admin check: unset/empty ADMIN_CLERK_SUBS -> nobody is admin. Two callers: the dormant
// app-config PATCH (via adminRefusal) and GET /api/notifications/prefs, which reports it as can_edit_bar.
// That flag decides only who SEES the bar editor; it never gates a write (the prefs PATCH writes the
// caller's own row). ADMIN_CLERK_SUBS is per-function Lambda runtime config: deploy-lambda.yml sets it on
// garden-critter in a continue-on-error step and deploy-staging.yml does not set it on garden-critter-staging,
// so can_edit_bar is false for everyone on staging. Same idiom as lambda/tags/validate.js.
export function isAdmin(userId, env) {
  const subs = adminSubs(env)
  return subs.length > 0 && subs.includes(userId)
}

// Split the way lambda/projects/index.js splits it: "not configured" and "not you" are different
// operational facts. Built ON isAdmin, not beside it: a second copy of the split-and-trim would hide a
// mutation in the first.
export function adminRefusal(userId, env) {
  if (adminSubs(env).length === 0) return { status: 403, error: 'Admin route not configured' }
  if (!isAdmin(userId, env)) return { status: 403, error: 'Not authorized' }
  return null
}

// The GET's row -> response projection, extracted so it can be tested (importing lambda/critter/index.js
// is impossible in this suite: its runtime deps are not installed). NO ROW = SHIPPED DEFAULT: every
// allowlisted key is reported, absent ones as null, so a client sees "unset" rather than a missing key.
// app_config has zero rows in prod; no seeding row is wanted.
export function projectAppConfig(rows) {
  const out = Object.fromEntries(APP_CONFIG_KEYS.map(k => [k, null]))
  for (const r of Array.isArray(rows) ? rows : []) {
    if (APP_CONFIG_KEYS.includes(r?.key)) out[r.key] = r.value ?? null
  }
  return out
}

// PATCH /api/app-config body validator: DORMANT with its route; unchanged. Guard order (array,
// vocabulary, duplicate, arity) mirrors resolveNavTabs in src/lib/navConfig.js and bar_layout.order above.
// REORDER-ONLY: a short array (including []) is a hide attempt and a long one an add; both are refused
// whole. Hiding is per person, in bar_layout.hidden.
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
