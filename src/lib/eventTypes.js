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
  // V4-LOSSEVENT-001 — the two PLANT-REDUCTION types. See PLANT_REDUCTION_EVENT_TYPES below for
  // the whole contract; they are ordinary EVENT_TYPES members in every other respect.
  'failed',
  'given_away',
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
  // V4-LOSSEVENT-001. The labels name the EVENT (what happened to the plants), never the cause —
  // the cause is the reason value, and Dave's ruling was that a reason naming the outcome
  // ("plant death") is not a reason at all. 'Attrition' is a NEW category: 'Pest & Health' would
  // have been a defensible home for `failed` and an actively wrong one for `given_away` (a plant
  // swap is not a health event), and the whole point of keeping the two vocabularies apart is that
  // a gift never reads as a loss. Category placement is a taste call — Dave's to overrule.
  failed:          { label: 'Plants lost',          emoji: '🥀', category: 'Attrition' },
  given_away:      { label: 'Plants given away',    emoji: '🎁', category: 'Attrition' },
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
//   V4-LOSSEVENT-001:
//     failed, given_away    — carry a PER-PLANTING quantity, the same disqualifier `harvest` has.
//                             Worse here than for harvest, because the batch path writes a
//                             side-effect the user cannot see: one "lost 3" fanned across a
//                             500-planting scope would decrement 500 plantings by 3 each and accrue
//                             1500 to qty_lost. Bulk attrition is not a real gesture anyway — you
//                             count what a pest actually took on the planting in front of you.
export const BATCH_EXCLUDED_TYPES = [
  'harvest',
  'first_harvest',
  'photo',
  'divided',
  'cutting_taken',
  'hand_pollinated',
  'moisture_check',
  'failed',
  'given_away',
]

// ── Reward-bearing partition (V4-WATERMATH-001 F0) ──────────────────
// Event types that must grant ZERO xp, ZERO streak credit and ZERO total_events.
//
// This list is NOT cosmetic and it is NOT enforced by the database. Verified against live Neon
// 2026-08-12: `event_log` carries exactly two non-internal triggers — `prevent_ownership_transfer`
// and `set_updated_at` — and NEITHER touches xp_events, user_stats or achievements. The only
// trigger anywhere in the reward path is `trg_user_stats_level` on `user_stats`, whose whole body
// is `NEW.level := public.xp_level(NEW.xp)`. So every grant is APPLICATION code in the events
// Lambda, and the exclusion has to be applied there — in FOUR places, because two of them are
// recomputes that would otherwise re-grant retroactively:
//   (1) the flat XP grant                     — skipped outright for these types;
//   (2) user_stats.total_events / streak      — RECOMPUTED as `count(*) FROM event_log`, so a
//                                               moisture_check row would inflate the total on the
//                                               NEXT event logged even if this one granted nothing;
//   (3) the achievement evaluator's counts    — `today_events` (multi_per_day) counts every row.
//   (4) the CRITTER award                     — BUG-CRITTERNONREWARD-001. Added 2026-08-12; it was
//                                               missed when (1)-(3) were built and shipped ungated
//                                               to the integration branch. It is the ONLY reward
//                                               here that writes DURABLE data (a critter_state row
//                                               persists; xp/streak/total_events are recomputed),
//                                               and it had no daily cap, so a ~47.5% roll per
//                                               moisture_check made the snooze farmable for
//                                               collectibles even while it correctly earned no XP.
//                                               Gated at lambda/events/index.js's hook, in
//                                               awardCrittersForBatch, and at the awardCritterServer
//                                               chokepoint; pinned by critter-nonreward.test.js.
//
// The two paths previously recorded here as KNOWN NOT COVERED are now both closed, 2026-08-12:
//   POST /api/critters      RETIRED, not gated. It granted a critter_state row for any source event
//                           with no event_type gate and no roll at all. Zero SPA callers and zero
//                           prod rows ever came from it; see the tombstone in lambda/critter/index.js.
//   issue_resolve_count     FILTERED. The resolved_set CTE in lambda/events/index.js counted any
//                           flagged+resolved row regardless of type, so a flagged non-reward event
//                           earned caretaker achievements and their XP. It now carries the same
//                           NOT (event_type = ANY(NON_REWARD_EVENT_TYPES)) predicate as the
//                           recompute. Prod had 0 non-reward flagged rows, so no count moved.
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

// ── V4-LOSSEVENT-001 — plant-reduction ledger ───────────────────────
// DAVE'S REQUIREMENT, in his words: he starts more seeds than he needs, plants out ten lettuce,
// and between seedling and plant-out takes that to five — and he needs to record WHY the count
// went from ten to five. That is NOT the planting failing. The planting is alive and healthy, just
// smaller. Three of ten eaten by a pest is the same shape.
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
// layer: `loss_reason` is only ever written on `failed` rows and `giveaway_reason` only on
// `given_away` rows, so a loss aggregate that forgets to filter by event_type STILL cannot pick up
// a gift.
export const PLANT_REDUCTION_EVENT_TYPES = ['failed', 'given_away']

// The reason vocabulary for `failed`. THIS IS THE SAME VOCABULARY AS plants.loss_cause — one
// vocabulary, five homes (here, the generated Lambda mirror, migrations/v4-losscapture-001's
// ARRAY, both ALLOWED_LOSS literals in lambda/plants/index.js, and gates.yml's set-equality
// expectation), pinned against each other by lambda/plants/loss-cause-vocab.test.js.
//
// `animal_damage` and `culled` are Dave's additions (2026-08-18) to the five that were already
// deployed. Widening the DB CHECK is DEPLOY-ORDERED — see that migration's README §Ordering;
// the direction is SCHEMA FIRST for a widening, the opposite of the qty_lost narrowing in the
// same bundle.
//
// 'plant death' was proposed and REJECTED by Dave: it names the outcome, not the cause, and the
// event type already says the plant is gone.
export const LOSS_REASONS = [
  'pest',
  'disease',
  'weather',
  'transplant_shock',
  'unknown',
  'animal_damage',
  'culled',
]

// The reason vocabulary for `given_away`. Dave confirmed this is the PLANT being given away, not
// the produce (produce disposition is harvest_log.disposition, V4-HARVDISPOSITION-001 — a third
// and unrelated vocabulary that happens to share the token 'culled'; do not merge them).
//
// 'sold', 'traded' and 'community' were APPROVED by Dave 2026-08-18 (the predecessor lane left the
// first two proposed-but-unshipped precisely so an unapproved value could not become
// indistinguishable from an approved one once rows carried it — the approval is what unblocks them).
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
// absent from this map carries NO reduction keys at all.
export const REDUCTION_REASON_KEY_BY_TYPE = {
  failed: LOSS_REASON_KEY,
  given_away: GIVEAWAY_REASON_KEY,
}

export const REDUCTION_REASONS_BY_KEY = {
  [LOSS_REASON_KEY]: LOSS_REASONS,
  [GIVEAWAY_REASON_KEY]: GIVEAWAY_REASONS,
}

// V4-LOSSUI-001 — the chip captions. Lives HERE, beside the vocabularies, so a value can never be
// added to a list without a reader noticing it has no label: `reductionReasonLabel` falls back to
// the un-snaked token, which is legible but obviously unstyled, and the panel's render test walks
// both vocabularies rather than a hand-listed set.
//
// The two catch-alls are worded as invitations rather than as shrugs. 'unknown' -> "Not sure"
// because "unknown" reads like a data-entry failure and the honest answer ("plants died and I never
// found out why") is the single most common one. 'community' -> "Shared locally" per Dave: warm,
// not clinical, and broad enough to cover the neighbour, the local group, the roadside free stand
// and the school or church without naming any of them on a 44px chip.
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
  return PLANT_REDUCTION_EVENT_TYPES.includes(eventType)
}

// Only a LOSS accrues into plants.qty_lost. A give-away is a reduction, not a loss: the plant is
// alive somewhere else. Give-away totals are read off the ledger instead of getting their own
// column — a `qty_given_away` counter would need its own CHECK, its own non-negative guard and its
// own deploy ordering to answer a question one SUM already answers.
export function accruesQtyLost(eventType) {
  return eventType === 'failed'
}

// The list every EVENT-CREATION picker renders, as opposed to the vocabulary the API accepts.
//
// V4-LOSSUI-001 — THE GATE IS OPEN. This was `EVENT_TYPES.filter(t => !PLANT_REDUCTION_EVENT_TYPES
// .includes(t))` while the two reduction types had a complete API write path and NO capture panel:
// the API REQUIRES a quantity and a reason on them, so a picker entry would have been a visible
// option that 400s every time — the CATCH_UP_EDITOR_SHIPPED failure shape (a badge linking to an
// editor nobody built). V4-LOSSEVENT-001 deliberately left the re-opening as this ONE line.
//
// The panel now exists: components/PlantReductionFields.jsx, rendered by EventNew as a REQUIRED
// panel beside the harvest / treatment / severity ones, gating Save on both fields client-side
// before the POST is ever attempted (EventNew.jsx handleSubmit). So the filter is retired and the
// creation list is the vocabulary again.
//
// The alias is KEPT rather than replaced at the five call sites. It is not redundant: it is the
// named seam that made the gating a one-line change in both directions, and one of its five
// consumers (FeedPage) is a READ filter over the feed, where the two types must appear the moment
// rows carrying them exist — a distinction that is invisible if every site just imports
// EVENT_TYPES. Re-narrowing a future panel-less type is one line here again.
//
// V4-PICKERGATE-001 — this is now the INPUT to creatableEventTypes() at the bottom of this file,
// not the list a creation surface renders directly. Opening the gate here made the three types
// with required capture fields (harvest, failed, given_away) visible on three surfaces that cannot
// collect those fields, where every save is a guaranteed 400. Global narrowing stays a one-line
// change here; per-surface narrowing is the capability cross down there.
export const SELECTABLE_EVENT_TYPES = EVENT_TYPES

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
  // V4-LOSSEVENT-001. Anchored after the other exception buckets: the rarest group and the one
  // whose members are terminal for the plants they name.
  'Attrition',
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
  // V4-LOSSEVENT-001: a reduction is arithmetic ON a specific planting's count. Without a planting
  // there is no count to reduce, so this is the strongest predication in the whole map — and unlike
  // the rest of it the SERVER enforces this pair too (validatePostBody), because the write has a
  // side effect on plants and a planting-less one would be a no-op behind a success response.
  'failed', 'given_away',
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

// ── V4-PICKERGATE-001 — creation-surface capability gate ────────────
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
//   failed      -> validateReduction — `metadata.qty_reduced` + `metadata.loss_reason` REQUIRED.
//   given_away  -> validateReduction — `metadata.qty_reduced` + `metadata.giveaway_reason` REQUIRED.
//
// The membership is HAND-LISTED here and PROVEN elsewhere, deliberately: this module has ZERO
// imports by design (it is copied verbatim into the Lambda by gen-lambda-event-types.mjs), so it
// cannot read the validator at runtime. creatableEventTypes.test.js closes the loop by running the
// REAL validator over all EVENT_TYPES with each surface's real POST body, so a fourth
// required-field type added to the validator and forgotten here reds the suite.
export const CAPTURE_PANEL_REQUIRED_TYPES = ['harvest', ...PLANT_REDUCTION_EVENT_TYPES]

export function requiresCapturePanel(eventType) {
  return CAPTURE_PANEL_REQUIRED_TYPES.includes(eventType)
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

