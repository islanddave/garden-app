// ============================================================
// Canonical event-type vocabulary — SINGLE SOURCE OF TRUTH
// ============================================================
// This module has ZERO imports so that scripts/gen-lambda-event-types.mjs can import it and write
// lambda/events/eventTypes.generated.js: the events Lambda is a standalone zip with no bundler, so
// it CANNOT import from src/lib/ at runtime. The generator emits the exported values plus five
// functions copied as source (fn.toString()), so a comment inside one of those five bodies travels
// into lambda/ too.
//
// Drift is structurally prevented because:
//   (a) BATCH_EVENT_TYPES is DERIVED from EVENT_TYPES − BATCH_EXCLUDED_TYPES,
//       never hand-listed; and
//   (b) `npm run check:event-types` regenerates the Lambda copy and fails CI on any byte
//       difference from the committed generated file. Its banner stamps this file's length, so
//       ANY edit here, comment-only included, needs `npm run gen:event-types` and a commit.
//
// `event_log.event_type` is free-text TEXT (no DB CHECK constraint), so adding /
// removing values here needs NO migration. The allowlist gating lives only in the
// batch path (validateBatchBody) and the UI pickers — never the DB.

// ── Master ordered soft-enum ────────────────────────────────────────
// Suggested event types; free text is always accepted on the single-event path.
// Order is meaningful: it is the order of values inside each "More" panel group
// (buildSecondaryGroups); CATEGORY_ORDER orders the groups. No schema change needed to add one.
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
  // The two PLANT-REDUCTION types. See PLANT_REDUCTION_EVENT_TYPES below for the whole contract;
  // they are ordinary EVENT_TYPES members in every other respect. Older rows and cached clients use
  // the legacy spellings `failed` / `given_away`; see LEGACY_EVENT_TYPE_ALIASES.
  'reduction_lost',
  'reduction_given_away',
  'observation',
  'photo',
  'other',
]

// ── Per-type display metadata ───────────────────────────────────────
// EVERY value in EVENT_TYPES MUST have an entry here with { label, category }
// (eventTypes.test.js checks it), primary quick-pick types included, so the
// picker/label resolver never falls through to a raw snake_case fallback.
// `category` buckets the "More" secondary groups.
//
// No `emoji` field. The glyph for an event type is `event.<value>` in the icon
// registry (src/lib/iconEvents.js -> iconRegistry), one SVG + accessibleName per
// value with no neutral fallback. Nothing renders a glyph from this table — do not
// re-add one here; eventTypeIconWiring.test.jsx fails the build if it comes back.
export const EVENT_TYPE_META = {
  sowing:              { label: 'Sowed',                  category: 'Growth & Training' },
  seed_soak:           { label: 'Seed soak',              category: 'Growth & Training' },
  germination:         { label: 'Germination',            category: 'Growth & Training' },
  thinning:            { label: 'Thinned',                category: 'Growth & Training' },
  potting_up:          { label: 'Potted up / Repotted',   category: 'Growth & Training' },
  transplant:          { label: 'Transplanted / Planted', category: 'Growth & Training' },
  hardening_off:       { label: 'Hardening off',          category: 'Growth & Training' },
  watering:            { label: 'Watered',                category: 'Care' },
  rain:                { label: 'Rain',                   category: 'Environmental' },
  // "I checked the soil and it does not need water." A NEGATIVE care observation — it records
  // an inspection, NOT an intervention. Deliberately NOT mapped onto `observation`: the
  // daily-plan-read DONE_EVENTS map treats `observation` as satisfying PEST tasks, so reusing it
  // would silently check off pest work the user never did.
  moisture_check:      { label: 'Moisture check',         category: 'Care' },
  fertilizing:         { label: 'Fertilized / Fed',       category: 'Care' },
  pest_treatment:      { label: 'Pest treatment',         category: 'Pest & Health' },
  doctored:            { label: 'Doctored / Treated',     category: 'Pest & Health' },
  pruning:             { label: 'Pruned / Topped',        category: 'Growth & Training' },
  cover:               { label: 'Covered',                category: 'Environmental' },
  uncover:             { label: 'Uncovered',              category: 'Environmental' },
  brought_inside:      { label: 'Brought inside',         category: 'Environmental' },
  brought_outside:     { label: 'Brought outside',        category: 'Environmental' },
  mulched:             { label: 'Mulched',                category: 'Environmental' },
  caged:               { label: 'Caged',                  category: 'Growth & Training' },
  staked:              { label: 'Staked',                 category: 'Growth & Training' },
  mesh_netting:        { label: 'Mesh / Netting',         category: 'Environmental' },
  trellised:           { label: 'Trellised',              category: 'Growth & Training' },
  pinched:             { label: 'Pinched',                category: 'Growth & Training' },
  suckered:            { label: 'Suckered',               category: 'Growth & Training' },
  deadheaded:          { label: 'Deadheaded',             category: 'Growth & Training' },
  weeded:              { label: 'Weeded',                 category: 'Environmental' },
  hand_pollinated:     { label: 'Hand-pollinated',        category: 'Growth & Training' },
  divided:             { label: 'Divided',                category: 'Growth & Training' },
  cutting_taken:       { label: 'Cutting taken',          category: 'Growth & Training' },
  rooting:             { label: 'Rooting',                category: 'Growth & Training' },
  relocated:           { label: 'Relocated / Moved',      category: 'Environmental' },
  flowering:           { label: 'Flowering',              category: 'Growth & Training' },
  fruit_set:           { label: 'Fruit set',              category: 'Growth & Training' },
  animal_damage:       { label: 'Animal damage',          category: 'Environmental' },
  heat_damage:         { label: 'Heat damage',            category: 'Environmental' },
  frost_damage:        { label: 'Frost damage',           category: 'Environmental' },
  soil_amended:        { label: 'Soil amended',           category: 'Environmental' },
  hilled:              { label: 'Hilled / Mounded',       category: 'Environmental' },
  first_harvest:       { label: 'First harvest',          category: 'Harvest' },
  harvest:             { label: 'Harvested',              category: 'Harvest' },
  scape_cut:           { label: 'Scape cut',              category: 'Growth & Training' },
  cured:               { label: 'Cured',                  category: 'Harvest' },
  seed_saved:          { label: 'Seed saved',             category: 'Harvest' },
  cloves_saved:        { label: 'Cloves saved',           category: 'Harvest' },
  overwinter_survived: { label: 'Overwinter survived',    category: 'Environmental' },
  // The labels name the EVENT (what happened to the plants), never the cause — the cause is the
  // reason value. 'Attrition' is their own category because 'Pest & Health' would be wrong for the
  // give-away (a plant swap is not a health event), and a gift must never read as a loss.
  reduction_lost:        { label: 'Plants lost',          category: 'Attrition' },
  reduction_given_away:  { label: 'Plants given away',    category: 'Attrition' },
  observation:         { label: 'Observed / Note',        category: 'Notes & Photos' },
  photo:               { label: 'Photo only',             category: 'Notes & Photos' },
  other:               { label: 'Other',                  category: 'Environmental' },
}

// ── Required META fields (named for the completeness test) ──────────
export const REQUIRED_META_FIELDS = ['label', 'category']

// ── Unified first-class quick-pick order ────────────────────────────
// The single ordered set of "first-class" event types shown at the top of BOTH the Log One
// picker (EventTypePicker's EVENT_TYPES_UI carries the same values with richer labels) and
// the Log Many bulk picker, so the two selectors match. Order is meaningful
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
//                              entry, never batch-submitted.
//     first_harvest          — a MILESTONE event that carries NO quantity and writes NO
//                              harvest_log row. The API actively REJECTS harvest fields on
//                              it (validators.js "harvest fields only valid on
//                              event_type=harvest"), and the harvest_log CTE is gated on
//                              `isHarvest = eventType === 'harvest'` (events/index.js), so
//                              first_harvest is excluded by construction. Excluded from
//                              batch for the same per-plant-entry reason as harvest, NOT
//                              because it needs quantity. CONSEQUENCE:
//                              a planting whose ONLY pick is logged as first_harvest is
//                              invisible to every evidence-only surface that INNER JOINs
//                              harvest_log — e.g. /api/events/harvest-ready. Do not "fix"
//                              that by backfilling harvest_log: quantity and unit are NOT
//                              NULL with a unit CHECK enum and no source value exists, so a
//                              backfill must fabricate user-facing data that
//                              /api/events/harvest-summary then renders as recorded.
//     photo                  — requires a file upload.
//
//   data-integrity (propagation / single-plant events):
//     divided, cutting_taken — SPAWN child plantings; bulk-logging across many
//                              plantings would orphan lineage or partial-write
//                              mid-batch with no stated transaction.
//     hand_pollinated        — single-plant horticultural event; you pollinate a
//                              specific flower, not a whole scope.
//
// flowering + fruit_set are NOT excluded: the batch path fires the SAME forward-only status
// advance the single path does (the two UPDATE statements in the index.js batch transaction,
// guarded by FLOWERING/FRUITING_SOURCE_STATUSES — idempotent: plantings already at/past the
// target status are skipped). So bulk logging is trigger-parity with single logging for these two.
//   per-plant judgement:
//     moisture_check         — a per-plant JUDGEMENT ("this one is still damp"), the exact
//                              opposite of a scope-wide assertion. Bulk-logging "none of these
//                              500 need water" without touching them is a fabricated observation,
//                              and it would let one tap suppress the whole water bar. Also see
//                              NON_REWARD_EVENT_TYPES: it earns nothing, so bulk has no upside.
//   per-planting quantity:
//     reduction_lost, reduction_given_away — carry a PER-PLANTING quantity, the same disqualifier
//                             `harvest` has.
//                             Worse here than for harvest, because the batch path writes a
//                             side-effect the user cannot see: one "lost 3" fanned across a
//                             500-planting scope would decrement 500 plantings by 3 each and accrue
//                             1500 to qty_lost. Bulk attrition is not a real gesture anyway — you
//                             count what a pest actually took on the planting in front of you.
//   single-path-only side record:
//     seed_saved            — the SAME evidence asymmetry as `harvest`, in the same direction. The
//                             single path (SaveSeedSheet) writes three requests: it creates an
//                             inventory_items seed LOT, stages it via POST /seed-stage (which writes
//                             the seed_lot_stage_log row /seeds/saved sorts on), and only then posts
//                             the event. The batch path posts the event ALONE — so a bulk seed_saved
//                             asserts on N plantings' timelines that seed was saved while creating
//                             zero lots, and /seeds/saved, which is the only surface that would show
//                             the claim was empty, stays empty.
//                             The multiplier is the reason this is worth excluding rather than just
//                             discouraging: seed_saved is deliberately NOT in NON_REWARD_EVENT_TYPES
//                             (a two-week ferment→dry→store commitment should pay like a
//                             watering), so one tap over a
//                             500-planting scope is 500 events and 500 xp grants for one gesture that
//                             produced nothing. Same shape as `divided`/`cutting_taken` above: the
//                             real act spawns a child record, and only the single path spawns it.
export const BATCH_EXCLUDED_TYPES = [
  'harvest',
  'first_harvest',
  'photo',
  'divided',
  'cutting_taken',
  'hand_pollinated',
  'moisture_check',
  'reduction_lost',
  'reduction_given_away',
  'seed_saved',
]

// ── Reward-bearing partition ────────────────────────────────────────
// Event types that must grant ZERO xp, ZERO streak credit and ZERO total_events.
//
// This list is NOT cosmetic and it is NOT enforced by the database: no `event_log` trigger touches
// xp_events, user_stats or achievements, and the only trigger in the reward path
// (`trg_user_stats_level` on `user_stats`) just sets `NEW.level := public.xp_level(NEW.xp)`. So every
// grant is APPLICATION code in the events Lambda, and the exclusion has to be applied there — in
// FOUR places, because two of them are recomputes that would otherwise re-grant retroactively:
//   (1) the flat XP grant                     — skipped outright for these types;
//   (2) user_stats.total_events / streak      — RECOMPUTED as `count(*) FROM event_log`, so a
//                                               moisture_check row would inflate the total on the
//                                               NEXT event logged even if this one granted nothing;
//   (3) the achievement evaluator's counts    — `today_events` (multi_per_day) counts every row.
//   (4) the CRITTER award                     — the ONLY reward here that writes DURABLE data (a
//                                               critter_state row persists; xp/streak/total_events
//                                               are recomputed), with no daily cap, so an ungated
//                                               ~47.5% roll per moisture_check would make the snooze
//                                               farmable for collectibles while it earned no XP.
//                                               Gated at lambda/events/index.js's hook, in
//                                               awardCrittersForBatch, and at the awardCritterServer
//                                               chokepoint; pinned by critter-nonreward.test.js.
//
// Two further paths are closed:
//   POST /api/critters      RETIRED, not gated (it had no event_type gate and no roll); see the
//                           tombstone in lambda/critter/index.js.
//   issue_resolve_count     FILTERED. The resolved_set CTE in lambda/events/index.js carries the same
//                           NOT (event_type = ANY(NON_REWARD_EVENT_TYPES)) predicate as the
//                           recompute, so a flagged non-reward event earns no caretaker achievement
//                           (issue-resolve-nonreward.test.js).
//
// WHY: moisture_check is a one-tap "not thirsty" snooze sitting next to the primary log button. A
// rewarded snooze is a farmable XP lever — tap it on 200 plantings, cap the daily XP, sustain a
// streak without gardening — and it would poison the watering learner with events that mean
// "I did nothing." Zero reward is what keeps it an honest signal.
export const NON_REWARD_EVENT_TYPES = [
  'moisture_check',
]

// Single predicate for the reward partition. Free-text / non-vocabulary types are rewarded
// (they are real logging actions), so the default is TRUE and exclusion is opt-in.
export function isRewardedEventType(eventType) {
  return !NON_REWARD_EVENT_TYPES.includes(eventType)
}

// ── Watering amount classes ─────────────────────────────────────────
// Stored as `metadata.water_depth` on watering events — category-canonical, no DDL.
// Deliberately NOT `quantity_numeric`: that column is structurally harvest-only (the single-event
// POST fills it from harvest.quantity), and a dimensionless class code parked in a numeric column
// would collide with real gallons later. Categories also survive a magnitude retune; recorded
// numerics would not.
//
// `metadata.water_depth_source` records WHO chose the class: 'user' = the gardener tapped a chip,
// 'default' = the preselected Normal rode along untouched. The two are not interchangeable:
// whether gardeners actually set a depth (and so whether amount-dependent watering math can be
// fed) can only be measured if provenance is stored.
export const WATER_DEPTH_CLASSES = ['light', 'normal', 'deep']
export const WATER_DEPTH_SOURCES = ['user', 'default']

// ── Plant-reduction ledger ──────────────────────────────────────────
// Ten lettuce thinned to five between seedling and plant-out, or three of ten eaten by a pest, is
// NOT the planting failing: the planting is alive and healthy, just smaller, and the gardener needs
// to record WHY the count went down.
//
// So the unit of record is a PARTIAL QUANTITY REDUCTION on a still-ACTIVE planting, repeatable:
// 10 -> 8 (pest) then 8 -> 5 (culled) must BOTH be recoverable afterwards, each with its own
// reason, quantity and date. A single `plants.loss_cause` scalar cannot hold that — it holds one
// value, so the second reduction would erase the first — which is why the history lives in
// event_log and not in a column. See lambda/events/validators.js validateReduction for the wire
// contract and lambda/events/index.js for the counter write.
//
// TWO TYPES, TWO VOCABULARIES, AND THE SEPARATION IS THE POINT. A plant swap is not a loss. If
// give-away reasons were folded into loss_cause then "how much did I lose to problems this season"
// would count every gift. They are kept apart at the STORAGE layer, not merely the vocabulary
// layer: `loss_reason` is only ever written on `reduction_lost` rows and `giveaway_reason` only on
// `reduction_given_away` rows, so a loss aggregate that forgets to filter by event_type STILL
// cannot pick up a gift.
//
// THE `reduction_` PREFIX IS RESERVED FOR THESE TWO. The legacy spellings `failed` and `given_away`
// each collide with another vocabulary: `failed` is also a planting STATUS (constants.js
// PLANT_STATUSES), a kitchen-batch stage and a share-post status; `given_away` is also a
// kitchen-batch OUTCOME (putup/batchClose.js, lambda/preservation/kitchenBatch.js). Not `plants_`:
// that is already the plants table's naming namespace (plants_loss_cause_check, chk_plants_status,
// ...). eventTypes.test.js pins the prefix as reserved and disjoint from those vocabularies.
export const LOSS_EVENT_TYPE = 'reduction_lost'
export const GIVEAWAY_EVENT_TYPE = 'reduction_given_away'
export const PLANT_REDUCTION_EVENT_TYPES = [LOSS_EVENT_TYPE, GIVEAWAY_EVENT_TYPE]

// THE LEGACY SPELLINGS, AND THE ALIAS IS PERMANENT. Rows written before the rename carry them until
// migrations/v5-losstoken-001 rewrites them, and a phone running a cached older bundle keeps POSTing
// them for as long as it stays unrefreshed — which has no upper bound (an offline launch runs the old
// shell). So every predicate below canonicalises FIRST: the DELETE that reverses a loss's counters
// and the PUT guard that refuses to edit one both read the STORED token, and an alias applied only to
// request bodies would let a legacy row be deleted without restoring its plants. Never remove an entry
// here; never apply canonicalEventType to anything but an EVENT type — `failed` the planting status
// is a different word that happens to be spelled the same.
export const LEGACY_EVENT_TYPE_ALIASES = Object.freeze({
  failed: LOSS_EVENT_TYPE,
  given_away: GIVEAWAY_EVENT_TYPE,
})

export function canonicalEventType(eventType) {
  return Object.hasOwn(LEGACY_EVENT_TYPE_ALIASES, eventType) ? LEGACY_EVENT_TYPE_ALIASES[eventType] : eventType
}

// Every stored spelling of one event type: the canonical token plus its legacy aliases. For SQL that
// matches STORED rows (`= ANY(...)`), which the canonicalising predicates cannot reach.
export function eventTypeTokens(eventType) {
  const canon = canonicalEventType(eventType)
  return [canon, ...Object.keys(LEGACY_EVENT_TYPE_ALIASES).filter((k) => LEGACY_EVENT_TYPE_ALIASES[k] === canon)]
}

// The reason vocabulary for `reduction_lost`. THIS IS THE SAME VOCABULARY AS plants.loss_cause — one
// vocabulary, five homes (here, the generated Lambda mirror, migrations/v4-losscapture-001's
// ARRAY, both ALLOWED_LOSS literals in lambda/plants/index.js, and gates.yml's set-equality
// expectation), pinned against each other by lambda/plants/loss-cause-vocab.test.js.
//
// Adding a value here means widening the plants.loss_cause DB CHECK too, and that is DEPLOY-ORDERED:
// SCHEMA FIRST for a widening, the opposite of a narrowing (see migrations/v4-losscapture-001/README.md).
//
// No 'plant death' reason: it names the outcome, not the cause, and the event type already says
// the plant is gone.
export const LOSS_REASONS = [
  'pest',
  'disease',
  'weather',
  'transplant_shock',
  'unknown',
  'animal_damage',
  'culled',
]

// The reason vocabulary for `reduction_given_away`: the PLANT being given away, not the produce
// (produce disposition is harvest_log.disposition — a third and unrelated vocabulary that happens
// to share the token 'culled'; do not merge them).
//
// Unlike LOSS_REASONS this list is in NO migration CHECK, so widening it carries no deploy ordering.
//
// 'community' is the deliberate broad non-friend option — neighbours, a local group, a roadside
// free stand, school or church — and it doubles as the CATCH-ALL, because a give-away has no
// natural 'unknown'-style floor the way a loss does. Its label is warm on purpose; see
// REDUCTION_REASON_LABELS.
export const GIVEAWAY_REASONS = ['friend', 'donated', 'plant_swap', 'sold', 'traded', 'community']

// Deliberate vs accidental, DERIVED FROM THE REASON VALUE ALONE — no `intentional` column. A
// stored boolean alongside the reason is a second source of truth for one fact, and the pair drifts
// the first time a reason is renamed. Every give-away is deliberate by construction; among losses
// only culling is.
export const INTENTIONAL_LOSS_REASONS = ['culled']

export function isIntentionalReduction(reason) {
  return INTENTIONAL_LOSS_REASONS.includes(reason) || GIVEAWAY_REASONS.includes(reason)
}

// The three metadata keys the reduction ledger writes. Named constants because the client, the
// API validator and every aggregate query have to agree on the spelling, and a typo in a jsonb key
// fails SILENTLY (`metadata->>'loss_reson'` is NULL, not an error).
export const REDUCTION_QTY_KEY = 'qty_reduced'
export const LOSS_REASON_KEY = 'loss_reason'
export const GIVEAWAY_REASON_KEY = 'giveaway_reason'

// Which reason key belongs to which type, and therefore which vocabulary applies. An event type
// absent from this map carries NO reduction keys at all. Keyed by the CANONICAL token only — look it
// up through reductionReasonKey(), which also answers for a legacy spelling.
export const REDUCTION_REASON_KEY_BY_TYPE = {
  [LOSS_EVENT_TYPE]: LOSS_REASON_KEY,
  [GIVEAWAY_EVENT_TYPE]: GIVEAWAY_REASON_KEY,
}

export function reductionReasonKey(eventType) {
  return REDUCTION_REASON_KEY_BY_TYPE[canonicalEventType(eventType)]
}

export const REDUCTION_REASONS_BY_KEY = {
  [LOSS_REASON_KEY]: LOSS_REASONS,
  [GIVEAWAY_REASON_KEY]: GIVEAWAY_REASONS,
}

// The chip captions. Lives HERE, beside the vocabularies, so a value can never be added to a list
// without a reader noticing it has no label: `reductionReasonLabel` falls back to the un-snaked
// token, which is legible but obviously unstyled, and plantReduction.test.js walks both vocabularies
// rather than a hand-listed set.
//
// The two catch-alls are worded as invitations rather than as shrugs. 'unknown' -> "Not sure"
// because "unknown" reads like a data-entry failure and the honest answer ("plants died and I never
// found out why") is the single most common one. 'community' -> "Shared locally": warm, not
// clinical, and broad enough to cover the neighbour, the local group, the roadside free stand and
// the school or church without naming any of them on a 44px chip.
export const REDUCTION_REASON_LABELS = {
  pest: 'Pest',
  disease: 'Disease',
  weather: 'Weather',
  transplant_shock: 'Transplant shock',
  unknown: 'Not sure',
  animal_damage: 'Animals',
  culled: 'Culled / thinned',
  friend: 'A friend',
  donated: 'Donated',
  plant_swap: 'Plant swap',
  sold: 'Sold',
  traded: 'Traded',
  community: 'Shared locally',
}

// The one-line expansion each catch-all needs and neither chip has room for. Rendered as help text
// under the chip row (NOT on the chip — at seven chips a per-chip caption doubles the block height
// on the fast path, which is the trade WaterDepthChips could afford at three and this cannot).
export const REDUCTION_REASON_HINTS = {
  unknown: 'they died and you never found out why — a real answer, not a gap',
  community: 'neighbours, a local group, a free stand, school or church — and anything else',
}

export function reductionReasonLabel(reason) {
  return REDUCTION_REASON_LABELS[reason] ?? String(reason ?? '').replace(/_/g, ' ')
}

export function isPlantReductionEventType(eventType) {
  return PLANT_REDUCTION_EVENT_TYPES.includes(canonicalEventType(eventType))
}

// Only a LOSS accrues into plants.qty_lost. A give-away is a reduction, not a loss: the plant is
// alive somewhere else. Give-away totals are read off the ledger instead of getting their own
// column — a `qty_given_away` counter would need its own CHECK, its own non-negative guard and its
// own deploy ordering to answer a question one SUM already answers.
export function accruesQtyLost(eventType) {
  return canonicalEventType(eventType) === LOSS_EVENT_TYPE
}

// The global EVENT-CREATION gate, as opposed to the vocabulary the API accepts. Today it is the
// whole vocabulary. It stays a named alias rather than a bare EVENT_TYPES import because it is the
// one-line seam for hiding a type from every creation surface at once — e.g. a type whose API
// requires fields no capture panel collects yet, which would otherwise be a visible option that
// 400s on every save.
//
// TRAP: FeedPage's type filter (a READ surface) also renders this list, via constants.js, so
// narrowing it here hides the type from the feed filter too.
//
// It is the INPUT to creatableEventTypes() at the bottom of this file, which a creation surface
// that cannot collect every required field calls instead. Global narrowing is a one-line change
// here; per-surface narrowing is the capability cross down there.
export const SELECTABLE_EVENT_TYPES = EVENT_TYPES

// ── Derived batch allowlist (NEVER hand-listed) ─────────────────────
// The server (validateBatchBody) and the LogMany picker both consume this.
export const BATCH_EVENT_TYPES = EVENT_TYPES.filter(
  (t) => !BATCH_EXCLUDED_TYPES.includes(t),
)

// ── Canonical "More"-panel category order ───────────────────────────
// Explicit ordering for the secondary-group panel. Frequency-descending, with the
// exception buckets (Pest & Health, Attrition, Notes & Photos) anchored last. Categories
// not listed here are appended in first-appearance order (defensive).
export const CATEGORY_ORDER = [
  'Care',
  'Growth & Training',
  'Environmental',
  'Harvest',
  'Pest & Health',
  // The rarest group, and the one whose members are terminal for the plants they name.
  'Attrition',
  'Notes & Photos',
]

// ── Secondary-group builder ─────────────────────────────────────────
// Given the set of values rendered as primary quick-picks, returns the remaining
// values grouped by EVENT_TYPE_META category, ready for the "More" panel:
//   [[category, [{ value, label }, ...]], ...]
// `primaryValues` may be an array or a Set. Values without a META entry fall back
// to the raw value as its own label (the completeness test ensures that never
// actually happens for real EVENT_TYPES values). No `emoji` on the emitted
// record — the consumer renders <Icon name={`event.${value}`} />.
export function buildSecondaryGroups(primaryValues, values = EVENT_TYPES) {
  const primary = primaryValues instanceof Set ? primaryValues : new Set(primaryValues)
  const cats = {}
  values.forEach((v) => {
    if (primary.has(v)) return
    const meta = EVENT_TYPE_META[v] ?? { label: v, category: 'Other' }
    if (!cats[meta.category]) cats[meta.category] = []
    cats[meta.category].push({ value: v, label: meta.label })
  })
  // Order categories by the canonical CATEGORY_ORDER; unranked categories
  // (defensive — e.g. the 'Other' fallback) keep first-appearance order.
  const rank = (c) => { const i = CATEGORY_ORDER.indexOf(c); return i === -1 ? CATEGORY_ORDER.length : i }
  return Object.entries(cats).sort(([a], [b]) => rank(a) - rank(b))
}

// ── Per-event-type planting-requirement partition ───────────────────
// REQUIRE a planting where the event predicates on a specific plant; the rest take a space/garden
// target instead (never nothing). This map is the CANONICAL home so the client and any future
// Lambda copy share ONE source — do NOT re-list the partition anywhere else. Enforcement is
// CLIENT-side only (except the reduction pair below); the server validator is deliberately NOT
// made to require it — a PWA service-worker running a stale bundle would 400 every log mid-season.
export const PLANTING_REQUIRED_TYPES = new Set([
  'sowing', 'seed_soak', 'germination', 'thinning', 'potting_up', 'transplant', 'hardening_off',
  'watering', 'moisture_check', 'fertilizing', 'pest_treatment', 'doctored', 'pruning',
  'brought_inside', 'brought_outside', 'caged', 'staked', 'trellised', 'pinched', 'suckered',
  'deadheaded', 'hand_pollinated', 'divided', 'cutting_taken', 'rooting', 'relocated',
  'flowering', 'fruit_set', 'first_harvest', 'harvest', 'scape_cut', 'cured', 'seed_saved',
  'cloves_saved', 'overwinter_survived',
  // A reduction is arithmetic ON a specific planting's count. Without a planting
  // there is no count to reduce, so this is the strongest predication in the whole map — and unlike
  // the rest of it the SERVER enforces this pair too (validatePostBody), because the write has a
  // side effect on plants and a planting-less one would be a no-op behind a success response.
  'reduction_lost', 'reduction_given_away',
])

// EXEMPT (a space/garden target, never nothing): rain, cover, uncover, mulched, mesh_netting,
// weeded, animal_damage, heat_damage, frost_damage, soil_amended, hilled, observation, photo, other.
// DERIVED from EVENT_TYPES so the two lists can never silently drift (mirrors BATCH_EVENT_TYPES).
// The completeness + disjointness invariant is asserted in eventTypes.test.js.
export const PLANTING_EXEMPT_TYPES = EVENT_TYPES.filter((t) => !PLANTING_REQUIRED_TYPES.has(t))

// Single predicate both call sites use (EventNew.handleSubmit, ProjectDetail.handleLogEvent). Free
// text / non-vocabulary types (e.g. EventNew's 'flag_issue' mode, which is NOT in EVENT_TYPES
// and carries its own plant_id gate) return false here — they are governed by their own rules.
export function requiresPlanting(eventType) {
  return PLANTING_REQUIRED_TYPES.has(canonicalEventType(eventType))
}

// ── Creation-surface capability gate ────────────────────────────────
// THE RULE: a creation surface must not OFFER a type it cannot successfully SUBMIT. Offering one is
// worse than omitting it — the user makes a choice, fills the form, taps Save and gets a generic
// error, which reads as a broken app rather than as an unsupported option.
//
// This is a CROSS of two facts, which is why it is a function of the surface and not a constant:
// what the API DEMANDS of a type (below), against what a given surface can COLLECT (its call site).
//
// The types whose API contract demands a field only a dedicated capture panel can gather. Derived
// from PLANT_REDUCTION_EVENT_TYPES for the reduction pair so that list stays the one source; the
// third member is named here because nothing else names it:
//   harvest     -> lambda/events/validators.js validateHarvestFields — `body.harvest` {quantity,unit}
//                  is REQUIRED. Absent -> 400 'harvest fields required for event_type=harvest'.
//   reduction_lost       -> validateReduction — `metadata.qty_reduced` + `metadata.loss_reason` REQUIRED.
//   reduction_given_away -> validateReduction — `metadata.qty_reduced` + `metadata.giveaway_reason` REQUIRED.
//
// The membership is HAND-LISTED here and PROVEN elsewhere, deliberately: this module has ZERO
// imports by design (gen-lambda-event-types.mjs imports it to build the Lambda copy), so it
// cannot read the validator at runtime. creatableEventTypes.test.js closes the loop by running the
// REAL validator over all EVENT_TYPES with each surface's real POST body, so a fourth
// required-field type added to the validator and forgotten here reds the suite.
export const CAPTURE_PANEL_REQUIRED_TYPES = ['harvest', ...PLANT_REDUCTION_EVENT_TYPES]

export function requiresCapturePanel(eventType) {
  return CAPTURE_PANEL_REQUIRED_TYPES.includes(canonicalEventType(eventType))
}

// The list a CREATION surface renders, given what that surface can collect. Reads
// SELECTABLE_EVENT_TYPES, so the global creation gate stays the one-line seam it was: narrowing
// there still narrows every creation surface at once, and a READ filter (FeedPage) keeps importing
// the constant directly and is untouched by any of this.
//
//   capturePanels — the surface renders the required capture panels (harvest fields, plant
//                   reduction fields). Today ONLY EventNew does.
//   plantScoped   — the surface's POST carries a plant_id. A location-scoped event does not.
//
// Capabilities rather than a surface NAME (`creatableIn('mini-logger')`) on purpose: a name would
// make this module know every page in the app — the wrong direction for a zero-import canonical
// vocabulary — and it would say WHICH surface without saying WHY. A capability is checkable against
// the call site's own code.
export function creatableEventTypes(
  { capturePanels = false, plantScoped = false } = {},
  types = SELECTABLE_EVENT_TYPES,
) {
  return types.filter((t) => (
    (capturePanels || !requiresCapturePanel(t)) &&
    (plantScoped || !requiresPlanting(t))
  ))
}

