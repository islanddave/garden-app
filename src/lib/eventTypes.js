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
  rain:            { label: 'Rain',                 emoji: '🌧️', category: 'Care' },
  fertilizing:     { label: 'Fertilized / Fed',     emoji: '🌿', category: 'Care' },
  pest_treatment:  { label: 'Pest treatment',       emoji: '🐛', category: 'Pest & Health' },
  doctored:        { label: 'Doctored / Treated',   emoji: '🩹', category: 'Pest & Health' },
  pruning:         { label: 'Pruned / Topped',      emoji: '✂️', category: 'Growth & Training' },
  cover:           { label: 'Covered',              emoji: '🌂', category: 'Environmental' },
  uncover:         { label: 'Uncovered',            emoji: '🌤️', category: 'Environmental' },
  brought_inside:  { label: 'Brought inside',       emoji: '🏠', category: 'Environmental' },
  brought_outside: { label: 'Brought outside',      emoji: '☀️', category: 'Environmental' },
  mulched:         { label: 'Mulched',              emoji: '🍂', category: 'Environmental' },
  caged:           { label: 'Caged',                emoji: '🛡️', category: 'Environmental' },
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
  fruit_set:       { label: 'Fruit set',            emoji: '🍅', category: 'Growth & Training' },
  animal_damage:   { label: 'Animal damage',        emoji: '🐾', category: 'Pest & Health' },
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

// ── Batch-logging exclusions (THE one exclusion list) ───────────────
// Types that must NOT be bulk-loggable via /api/events/batch. Two reasons:
//
//   needs-extra-input (no bulk semantics):
//     harvest, first_harvest — require quantity+unit (dual-write to harvest_log)
//     photo                  — requires a file upload
//
//   HS-1 data-integrity (V002 §4 — propagation / single-plant events):
//     divided, cutting_taken — SPAWN child plantings; bulk-logging across many
//                              plantings would orphan lineage or partial-write
//                              mid-batch with no stated transaction.
//     hand_pollinated, fruit_set — single-plant horticultural events; bulk-applying
//                              them across a scope is semantically wrong (you
//                              pollinate / observe fruit-set per plant, not en masse).
//
// These four are treated single-event-only (like harvest/first_harvest/photo).
export const BATCH_EXCLUDED_TYPES = [
  'harvest',
  'first_harvest',
  'photo',
  'divided',
  'cutting_taken',
  'hand_pollinated',
  'fruit_set',
]

// ── Derived batch allowlist (NEVER hand-listed) ─────────────────────
// The server (validateBatchBody) and the LogMany picker both consume this.
export const BATCH_EVENT_TYPES = EVENT_TYPES.filter(
  (t) => !BATCH_EXCLUDED_TYPES.includes(t),
)

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
  return Object.entries(cats)
}

