// ============================================================
// Canonical event-type vocabulary — SINGLE SOURCE OF TRUTH
// ============================================================
// V3-EVENT-008 (2026-06-03). This module is the ONE place the event-type
// vocabulary lives. It has ZERO imports so it can be:
//   - imported directly by the frontend (constants.js, EventNew.jsx, LogMany.jsx,
//     EventDetail.jsx, ProjectDetail.jsx)
//   - copied verbatim into lambda/events/ at build time via
//     scripts/gen-lambda-event-types.mjs → lambda/events/eventTypes.generated.js
//     (the deployed Lambda is a standalone zip with no bundler, so it CANNOT
//     import from src/lib/ at runtime — codegen is the only safe bridge).
//
// Drift is structurally prevented because:
//   (a) BATCH_EVENT_TYPES is DERIVED from EVENT_TYPES − BATCH_EXCLUDED_TYPES,
//       never hand-listed; and
//   (b) `npm run check:event-types` regenerates the Lambda copy to a temp file
//       and fails CI on any byte difference vs the committed generated file.
//
// `event_log.event_type` is free-text TEXT (no DB CHECK constraint), so adding /
// removing values here needs NO migration. The allowlist gating lives only in the
// batch path (validateBatchBody) and the UI pickers — never the DB.

// ── Master ordered soft-enum (moved from constants.js) ──────────────
// Suggested event types; free text is always accepted on the single-event path.
// Order is meaningful: it drives the "More" panel grouping order indirectly via
// EVENT_TYPE_META categories. Add new values here — no schema change needed.
export const EVENT_TYPES = [
  'sowing',
  'seed_soak',
  'germination',
  'thinning',
  'potting_up',
  'transplant',
  'hardening_off',
  'watering',
  'rain',
  'moisture_check',
  'fertilizing',
  'pest_treatment',
  'doctored',
  'pruning',
  'cover',
  'uncover',
  'brought_inside',
  'brought_outside',
  'mulched',
  'caged',
  'staked',
  'mesh_netting',
  'trellised',
  'pinched',
  'suckered',
  'deadheaded',
  'weeded',
  'hand_pollinated',
  'divided',
  'cutting_taken',
  'rooting',
  'relocated',
  'flowering',
  'fruit_set',
  'animal_damage',
  'heat_damage',
  'frost_damage',
  'soil_amended',
  'hilled',
  'first_harvest',
  'harvest',
  'scape_cut',
  'cured',
  'seed_saved',
  'cloves_saved',
  'overwinter_survived',
  'observation',
  'photo',
  'other',
]

// ── Per-type display metadata (moved from EventNew.jsx) ─────────────
// EVERY value in EVENT_TYPES MUST have an entry here with { label, emoji,
// category } — enforced by the EVENT_TYPE_META completeness test. The four
// primary quick-pick types (watering, fertilizing, pruning, transplant) get
// entries too so the picker/label resolver never falls through to a raw
// snake_case fallback. `category` buckets the "More" secondary groups.
export const EVENT_TYPE_META = {
  sowing:          { label: 'Sowed',                emoji: '🌰', category: 'Growth & Training' },
  seed_soak:       { label: 'Seed soak',            emoji: '💦', category: 'Growth & Training' },
  germination:     { label: 'Germination',          emoji: '🌿', category: 'Growth & Training' },
  thinning:        { label: 'Thinned',              emoji: '🪓', category: 'Growth & Training' },
  potting_up:      { label: 'Potted up / Repotted', emoji: '🪴', category: 'Growth & Training' },
  transplant:      { label: 'Transplanted / Planted', emoji: '🌱', category: 'Growth & Training' },
  hardening_off:   { label: 'Hardening off',        emoji: '⛅', category: 'Growth & Training' },
  watering:        { label: 'Watered',              emoji: '💧', category: 'Care' },
  rain:            { label: 'Rain',                 emoji: '🌧️', category: 'Environmental' },
  // V4-WATERMATH-001 F0: "I checked the soil and it does not need water." A NEGATIVE care
  // observation — it records an inspection, NOT an intervention. Deliberately NOT mapped onto
  // `observation`: the daily-plan DONE_EVENTS map treats `observation` as satisfying PEST tasks,
  // so reusing it would silently check off pest work the user never did.
  moisture_check:  { label: 'Moisture check',       emoji: '🖐️', category: 'Care' },
  fertilizing:     { label: 'Fertilized / Fed',     emoji: '🌿', category: 'Care' },
  pest_treatment:  { label: 'Pest treatment',       emoji: '🐛', category: 'Pest & Health' },
  doctored:        { label: 'Doctored / Treated',   emoji: '🩹', category: 'Pest & Health' },
  pruning:         { label: 'Pruned / Topped',      emoji: '✂️', category: 'Growth & Training' },
  cover:           { label: 'Covered',              emoji: '🌂', category: 'Environmental' },
  uncover:         { label: 'Uncovered',            emoji: '🌤️', category: 'Environmental' },
  brought_inside:  { label: 'Brought inside',       emoji: '🏠', category: 'Environmental' },
  brought_outside: { label: 'Brought outside',      emoji: '☀️', category: 'Environmental' },
  mulched:         { label: 'Mulched',              emoji: '🍂', category: 'Environmental' },
  caged:           { label: 'Caged',                emoji: '🛡️', category: 'Growth & Training' },
  staked:          { label: 'Staked',               emoji: '🪵', category: 'Growth & Training' },
  mesh_netting:    { label: 'Mesh / Netting',       emoji: '🕸️', category: 'Environmental' },
  trellised:       { label: 'Trellised',            emoji: '🏗️', category: 'Growth & Training' },
  pinched:         { label: 'Pinched',              emoji: '🤌', category: 'Growth & Training' },
  suckered:        { label: 'Suckered',             emoji: '🌿', category: 'Growth & Training' },
  deadheaded:      { label: 'Deadheaded',           emoji: '🌸', category: 'Growth & Training' },
  weeded:          { label: 'Weeded',               emoji: '☘️', category: 'Environmental' },
  hand_pollinated: { label: 'Hand-pollinated',      emoji: '🐝', category: 'Growth & Training' },
  divided:         { label: 'Divided',              emoji: '↔️', category: 'Growth & Training' },
  cutting_taken:   { label: 'Cutting taken',        emoji: '🪚', category: 'Growth & Training' },
  rooting:         { label: 'Rooting',              emoji: '🫚', category: 'Growth & Training' },
  relocated:       { label: 'Relocated / Moved',    emoji: '📦', category: 'Environmental' },
  flowering:       { label: 'Flowering',            emoji: '🌸', category: 'Growth & Training' },
  fruit_set:       { label: 'Fruit set',            emoji: '🍅', category: 'Growth & Training' },
  animal_damage:   { label: 'Animal damage',        emoji: '🐾', category: 'Environmental' },
  heat_damage:     { label: 'Heat damage',          emoji: '🌡️', category: 'Environmental' },
  frost_damage:    { label: 'Frost damage',         emoji: '❄️', category: 'Environmental' },
  soil_amended:    { label: 'Soil amended',         emoji: '🪨', category: 'Environmental' },
  hilled:          { label: 'Hilled / Mounded',     emoji: '⛰️', category: 'Environmental' },
  first_harvest:   { label: 'First harvest',        emoji: '🌟', category: 'Harvest' },
  harvest:         { label: 'Harvested',            emoji: '🧺', category: 'Harvest' },
  scape_cut:           { label: 'Scape cut',            emoji: '➰', category: 'Growth & Training' },
  cured:               { label: 'Cured',                emoji: '🧅', category: 'Harvest' },
  seed_saved:          { label: 'Seed saved',           emoji: '🫘', category: 'Harvest' },
  cloves_saved:        { label: 'Cloves saved',         emoji: '🧄', category: 'Harvest' },
  overwinter_survived: { label: 'Overwinter survived',  emoji: '🧥', category: 'Environmental' },
  observation:     { label: 'Observed / Note',      emoji: '👁️', category: 'Notes & Photos' },
  photo:           { label: 'Photo only',           emoji: '📷', category: 'Notes & Photos' },
  other:           { label: 'Other',                emoji: '📝', category: 'Environmental' },
}

// ── Required META fields (named for the completeness test) ──────────
export const REQUIRED_META_FIELDS = ['label', 'emoji', 'category']

// ── Unified first-class quick-pick order (V4-EVENTSEL-002, Dave 2026-07-07) ──
// The single ordered set of "first-class" event types shown at the top of BOTH the Log One
// picker (EventTypePicker's EVENT_TYPES_UI carries the same values with richer labels) and
// the Log Many bulk picker — so the two selectors are homogenized. Order is meaningful
// (left→right, top→bottom). In BULK: `photo` is hidden (needs a file upload) and `harvest`
// is shown but routes to per-plant entry (needs a quantity); the other five are
// batch-submittable and fire the same server triggers as the single path.
export const PRIMARY_EVENT_TYPES = [
  'watering',
  'transplant',
  'fertilizing',
  'flowering',
  'fruit_set',
  'harvest',
  'photo',
]

// ── Batch-logging exclusions (THE one exclusion list) ───────────────
// Types that must NOT be bulk-loggable via /api/events/batch.
//
//   needs-extra-input (no bulk semantics):
//     harvest                — requires quantity+unit (dual-write to harvest_log);
//                              reachable in the unified selector but ROUTED to per-plant
//                              entry, never batch-submitted (V4-EVENTSEL-002).
//     first_harvest          — a MILESTONE event that carries NO quantity and writes NO
//                              harvest_log row. The API actively REJECTS harvest fields on
//                              it (validators.js "harvest fields only valid on
//                              event_type=harvest"), and the harvest_log CTE is gated on
//                              `isHarvest = eventType === 'harvest'` (events/index.js), so
//                              first_harvest is excluded by construction. Excluded from
//                              batch for the same per-plant-entry reason as harvest, NOT
//                              because it needs quantity. CONSEQUENCE (verified 2026-07-21,
//                              prod: 5/5 first_harvest orphaned vs 112/112 harvest logged):
//                              a planting whose ONLY pick is logged as first_harvest is
//                              invisible to every evidence-only surface that INNER JOINs
//                              harvest_log — e.g. /api/events/harvest-ready. Do not "fix"
//                              that by backfilling harvest_log: quantity and unit are NOT
//                              NULL with a unit CHECK enum and no source value exists, so a
//                              backfill must fabricate user-facing data that
//                              /api/events/harvest-summary then renders as recorded.
//     photo                  — requires a file upload.
//
//   HS-1 data-integrity (V002 §4 — propagation / single-plant events):
//     divided, cutting_taken — SPAWN child plantings; bulk-logging across many
//                              plantings would orphan lineage or partial-write
//                              mid-batch with no stated transaction.
//     hand_pollinated        — single-plant horticultural event; you pollinate a
//                              specific flower, not a whole scope.
//
// V4-EVENTSEL-002 (2026-07-07): flowering + fruit_set are NO LONGER excluded. The batch path
// now fires the SAME forward-only status advance the single path does (the two UPDATE
// statements in the index.js batch transaction, guarded by FLOWERING/FRUITING_SOURCE_STATUSES
// — idempotent: plantings already at/past the target status are skipped). So bulk logging is
// trigger-parity with single logging for these two.
//   V4-WATERMATH-001 F0:
//     moisture_check         — a per-plant JUDGEMENT ("this one is still damp"), the exact
//                              opposite of a scope-wide assertion. Bulk-logging "none of these
//                              500 need water" without touching them is a fabricated observation,
//                              and it would let one tap suppress the whole water bar. Also see
//                              NON_REWARD_EVENT_TYPES: it earns nothing, so bulk has no upside.
export const BATCH_EXCLUDED_TYPES = [
  'harvest',
  'first_harvest',
  'photo',
  'divided',
  'cutting_taken',
  'hand_pollinated',
  'moisture_check',
]

// ── Reward-bearing partition (V4-WATERMATH-001 F0) ──────────────────
// Event types that must grant ZERO xp, ZERO streak credit and ZERO total_events.
//
// This list is NOT cosmetic and it is NOT enforced by the database. Verified against live Neon
// 2026-08-12: `event_log` carries exactly two non-internal triggers — `prevent_ownership_transfer`
// and `set_updated_at` — and NEITHER touches xp_events, user_stats or achievements. The only
// trigger anywhere in the reward path is `trg_user_stats_level` on `user_stats`, whose whole body
// is `NEW.level := public.xp_level(NEW.xp)`. So every grant is APPLICATION code in the events
// Lambda, and the exclusion has to be applied there — in three places, because two of them are
// recomputes that would otherwise re-grant retroactively:
//   (1) the flat XP grant                     — skipped outright for these types;
//   (2) user_stats.total_events / streak      — RECOMPUTED as `count(*) FROM event_log`, so a
//                                               moisture_check row would inflate the total on the
//                                               NEXT event logged even if this one granted nothing;
//   (3) the achievement evaluator's counts    — `today_events` (multi_per_day) counts every row.
//
// WHY: moisture_check is a one-tap "not thirsty" snooze sitting next to the primary log button. A
// rewarded snooze is a farmable XP lever — tap it on 200 plantings, cap the daily XP, sustain a
// streak without gardening — and it would poison the V1.1 watering learner with events that mean
// "I did nothing." Zero reward is what keeps it an honest signal.
export const NON_REWARD_EVENT_TYPES = [
  'moisture_check',
]

// Single predicate for the reward partition. Free-text / non-vocabulary types are rewarded
// (they are real logging actions), so the default is TRUE and exclusion is opt-in.
export function isRewardedEventType(eventType) {
  return !NON_REWARD_EVENT_TYPES.includes(eventType)
}

// ── Watering amount classes (V4-WATERMATH-001 F0 capture) ───────────
// Stored as `metadata.water_depth` on watering events — category-canonical, no DDL.
// Deliberately NOT `quantity_numeric`: that column is structurally harvest-only (the single-event
// POST hardcodes it from harvest.quantity, and 544/544 live rows are harvest), and a dimensionless
// class code parked in a numeric column would collide with real gallons later. Categories also
// survive a magnitude retune; recorded numerics would not.
//
// `metadata.water_depth_source` records WHO chose the class: 'user' = the gardener tapped a chip,
// 'default' = the preselected Normal rode along untouched. The two are not interchangeable —
// the F0 instrumentation gate (if <5% of waterings carry a USER-set depth at 30 days, the
// amount-dependent math is declared unfeedable) can only be measured if provenance is stored.
export const WATER_DEPTH_CLASSES = ['light', 'normal', 'deep']
export const WATER_DEPTH_SOURCES = ['user', 'default']

// ── Derived batch allowlist (NEVER hand-listed) ─────────────────────
// The server (validateBatchBody) and the LogMany picker both consume this.
export const BATCH_EVENT_TYPES = EVENT_TYPES.filter(
  (t) => !BATCH_EXCLUDED_TYPES.includes(t),
)

// ── Canonical "More"-panel category order (V4-EVENTSEL-001) ─────────
// Explicit ordering for the secondary-group panel; categories previously fell out
// in incidental EVENT_TYPES first-appearance order. Frequency-descending, with the
// two exception buckets (Pest & Health, Notes & Photos) anchored last. Categories
// not listed here are appended in first-appearance order (defensive).
export const CATEGORY_ORDER = [
  'Care',
  'Growth & Training',
  'Environmental',
  'Harvest',
  'Pest & Health',
  'Notes & Photos',
]

// ── Secondary-group builder ─────────────────────────────────────────
// Given the set of values rendered as primary quick-picks, returns the remaining
// values grouped by EVENT_TYPE_META category, ready for the "More" panel:
//   [[category, [{ value, label, emoji }, ...]], ...]
// `primaryValues` may be an array or a Set. Values without a META entry fall back
// to a raw marker (the completeness test ensures that never actually happens for
// real EVENT_TYPES values).
export function buildSecondaryGroups(primaryValues, values = EVENT_TYPES) {
  const primary = primaryValues instanceof Set ? primaryValues : new Set(primaryValues)
  const cats = {}
  values.forEach((v) => {
    if (primary.has(v)) return
    const meta = EVENT_TYPE_META[v] ?? { label: v, emoji: '📌', category: 'Other' }
    if (!cats[meta.category]) cats[meta.category] = []
    cats[meta.category].push({ value: v, label: meta.label, emoji: meta.emoji })
  })
  // V4-EVENTSEL-001: order categories by the canonical CATEGORY_ORDER; unranked
  // categories (defensive — e.g. the 'Other' fallback) keep first-appearance order.
  const rank = (c) => { const i = CATEGORY_ORDER.indexOf(c); return i === -1 ? CATEGORY_ORDER.length : i }
  return Object.entries(cats).sort(([a], [b]) => rank(a) - rank(b))
}

// ── V4-PLANTREQUIRED-001 (Lane 3, Ask 2): per-event-type planting-requirement partition ──
// D2 "predication test" (spec v4-metaphoto-plantingtarget §3): REQUIRE a planting where the event
// predicates on a specific plant; the rest take a space/garden target instead (never nothing). This
// map is the CANONICAL home (spec §6.4) so the client and any future Lambda copy share ONE source —
// do NOT re-list the partition anywhere else. Enforcement is CLIENT-side and feature-flagged
// (featureFlags.PLANTING_REQUIRED_ENABLED); the server validator is deliberately NOT flipped in
// lockstep — a PWA service-worker running a stale bundle would 400 every log mid-season (spec D7).
export const PLANTING_REQUIRED_TYPES = new Set([
  'sowing', 'seed_soak', 'germination', 'thinning', 'potting_up', 'transplant', 'hardening_off',
  'watering', 'moisture_check', 'fertilizing', 'pest_treatment', 'doctored', 'pruning',
  'brought_inside', 'brought_outside', 'caged', 'staked', 'trellised', 'pinched', 'suckered',
  'deadheaded', 'hand_pollinated', 'divided', 'cutting_taken', 'rooting', 'relocated',
  'flowering', 'fruit_set', 'first_harvest', 'harvest', 'scape_cut', 'cured', 'seed_saved',
  'cloves_saved', 'overwinter_survived',
])

// EXEMPT (a space/garden target, never nothing): rain, cover, uncover, mulched, mesh_netting,
// weeded, animal_damage, heat_damage, frost_damage, soil_amended, hilled, observation, photo, other.
// DERIVED from EVENT_TYPES so the two lists can never silently drift (mirrors BATCH_EVENT_TYPES).
// The completeness + disjointness invariant is asserted in eventTypes.test.js.
export const PLANTING_EXEMPT_TYPES = EVENT_TYPES.filter((t) => !PLANTING_REQUIRED_TYPES.has(t))

// Single predicate both call sites use (EventNew.handleSubmit, ProjectDetail.handleLogEvent). Free
// text / non-vocabulary types (e.g. the V4-FLAG-001 'flag_issue' mode, which is NOT in EVENT_TYPES
// and carries its own plant_id gate) return false here — they are governed by their own rules.
export function requiresPlanting(eventType) {
  return PLANTING_REQUIRED_TYPES.has(eventType)
}

