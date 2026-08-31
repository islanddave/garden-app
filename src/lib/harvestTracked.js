// src/lib/harvestTracked.js
// V4-CONSUMABLECLASS-001 (BD-042), first slice — "is this plant grown to be EATEN or to be LOOKED AT?"
//
// Dave: the app has no concept of the difference, so harvest behaviour is applied to plants that
// will never be harvested. His live example: a rescued violet showing an "Est. harvest Oct 4 – Oct 24"
// countdown on its planting tab, which he called nonsensical. Seven live ornamentals do it today.
//
// THIS IS NOT A NEW CLASSIFICATION SCHEME, and deliberately so — the row reserves that for a design
// + crucible session, and the class-3 question (a sunflower is ornamental but MIGHT be harvested for
// seed) is genuinely open. What this closes is an ASYMMETRY in gating that already existed:
//
//   * lib/harvestReadiness.js:116  gates on harvest habit  -> ornamentals excluded  ✓
//   * lambda/harvests/watch.js:850 gates on harvest habit  -> ornamentals excluded  ✓
//   * lib/plantingMaturity.js      gated on NOTHING        -> ornamentals project a harvest  ✗
//
// So the data to answer Dave's complaint has been in the repo the whole time; one consumer just
// never consulted it.
//
// WHY A SLUG LIST AND NOT `harvest_habit IS NULL`. That inference is the obvious shortcut and it is
// wrong: plantingMaturity.js's own comment claims the 54 NULL-habit live plantings are "every one an
// ornamental", and 5 of them are edible. NULL means "nobody has said", which is not the same claim as
// "this is not harvested". The 60 slugs below are the POSITIVE, curated statement, each one a
// recorded decision — including the two that are edible-but-not-here: avocado will not fruit in this
// zone, and the dogwood does fruit but was planted as a landscape tree.
//
// SOURCE OF TRUTH is `src/data/harvest-attributes-v1.json` -> not_harvest_tracked.slugs, which also
// carries the reasoning and the `contested` class-3 register with its pre-authored flip conditions
// (one has already fired: bee_balm graduated out of this list on 2026-08-18). This module is a
// COPY, kept small on purpose — the JSON is 29KB and importing it would put all of it in the client
// bundle to read one array. harvestTracked.sync.test.js fails if the two ever diverge, which is the
// only thing making a copy safe.
//
// NOT a permanent property of a plant. Dave may decide to harvest sunflower seed next year; the flip
// is a one-line edit here plus the JSON, and the contested register exists to make that a considered
// act rather than a surprise.

// V4-PUTUPFOODCATEGORY-001 (2026-08-25) — the seven non-plant food classes are on this list too, and
// they are the first entries that are not plants at all. Everything above them is an ornamental or a
// plant grown here without a harvest claim, i.e. a decision that could be revisited (bee_balm's
// already was). Bread has no harvest to claim in any season. They can only ever reach this gate
// through a mis-typed variety — the seed exists for Put-Up and is filtered out of every garden
// picker by category — but the default direction below is TRACKED, so omitting them would mean a
// loaf of bread with an "Est. harvest" countdown rather than anything failing.
//
// Sorted, so a diff against the JSON is readable and an insertion lands somewhere obvious.
export const NOT_HARVEST_TRACKED_SLUGS = Object.freeze([
  'aloe', 'avocado', 'begonia', 'blackberry_lily', 'bread', 'butter', 'cactus', 'calibrachoa',
  'carnation', 'cheese', 'christmas_cactus', 'chrysanthemum', 'cobaea', 'coleus', 'columbine',
  'crown_of_thorns', 'delphinium', 'dogwood', 'dracaena', 'echeveria', 'edelweiss', 'fish',
  'fittonia', 'flower_mix', 'four_o_clock', 'foxglove', 'geranium', 'goldenrod', 'haworthia',
  'helichrysum', 'hibiscus', 'hollyhock', 'hosta', 'hoya', 'jade', 'japanese_maple', 'lantana',
  'lithops', 'marigold',
  'meat', 'milk', 'milkweed', 'money_plant', 'morning_glory', 'petunia', 'pineapple', 'poppy',
  'pothos', 'rose', 'sedum', 'sempervivum', 'spider_plant', 'stock', 'succulent', 'sunflower',
  'thunbergia', 'torenia', 'tradescantia', 'tweedia', 'viola', 'yarrow', 'yogurt',
])

const NOT_TRACKED = new Set(NOT_HARVEST_TRACKED_SLUGS)

// TRUE unless the crop type is positively listed as not-harvested.
//
// The default direction is load-bearing. An unknown or missing slug — a newly minted crop type, an
// older bundle, a cultivar with no crop_type_slug — reads as TRACKED, so the only thing this can do
// is REMOVE a harvest claim from a plant somebody explicitly said is not harvested. It can never
// withhold harvest information from a food crop because a slug was missing, which is the failure
// that would actually cost Dave something.
export function isHarvestTracked(cropTypeSlug) {
  if (typeof cropTypeSlug !== 'string' || !cropTypeSlug) return true
  return !NOT_TRACKED.has(cropTypeSlug)
}

// Convenience for the render sites, which hold a planting rather than a slug. Same default: a
// planting with no variety_ref (a bare record) is tracked.
export function plantingIsHarvestTracked(planting) {
  return isHarvestTracked(planting?.variety_ref?.crop_type_slug)
}
