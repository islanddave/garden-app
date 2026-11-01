'use strict';
// Pure crop_type_slug -> frost sensitivity BAND + per-crop-type trip points (V4-FROST-001 slice F2).
// HTTP-free, deterministic, unit-testable (house pattern: station.js). The planting QUERY lives in handler.js.
// Design ref: frost-alert-design-V100-20260803.md §3-4, as amended by decision D6.
//
// D6 changes §3-4: thresholds are PER CROP TYPE, not one global tender/hardy split, because crops have
// genuinely different cold tolerances. Delivery is still ONE COALESCED alert per frost event (frostEval.js),
// never one message per crop.
//
// WHY NOT coldFor (design G2): engine.js:coldFor fires only for (a) a pepper/tomato regex on crop-or-name and
// (b) cadence profiles carrying cold.tender, so on a 30°F night it emits NO cold task for basil, melon,
// watermelon, tomatillo, bean, nasturtium or cucurbits. Frost tiering is computed HERE from a sensitivity
// band, never reused from coldFor.
//
// WHY NOT cadence protect_below_F verbatim: it is a CONTAINER-COMFORT number (pepper = 50°F: bring the pot in
// to keep it setting fruit), not a frost-KILL number. Adopting it would fire the alert on most September
// nights and bury the signal. The bands below are frost-damage/kill thresholds; the care engine keeps its own
// comfort numbers.
//
// PROVENANCE: the slug set was derived from the live database (every live crop_type_slug plus the full
// plant_varieties.crop_type_slug domain), so a newly-planted variety of an existing crop is already covered.
// Every live crop type is banded, in UNCERTAIN_SLUGS, or in NON_PLANT_FOOD_SLUGS, and
// src/__tests__/slugUniverseConsistency.test.js holds that in both directions.

const numEnv = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
};

// ── Bands ─────────────────────────────────────────────────────────────────────────────────────────
// Each band carries the same three trip points frostEval uses globally, so a band IS a threshold set.
// `tender` is the approved baseline (advisory 40 / imminent 38 / hard-freeze 33) and is also the fallback
// band for an unknown slug (§3-4 unknown-counted-as-tender). The other bands deviate ONLY where the crop's
// cold tolerance genuinely differs; every deviation is justified in the slug lists below.
//
// The three env names below are the original global overrides. Under D6 they retarget the TENDER band
// specifically, which keeps D2's "injectable exactly as prepared" contract intact while the other bands move
// relative to it via FROST_BAND_THRESHOLDS_JSON or the uniform offset.
const BAND_THRESHOLDS = Object.freeze({
  // ═══ DECISION: the two most sensitive bands are HELD to the tender baseline ═══
  //
  // Horticulturally correct values, preserved because they are what to restore, not rediscover: tropical
  // 52/50/40 (chilling injury in the low 50s, long before frost) and chill_sensitive 47/45/36 (basil blackens
  // at ~40F with no frost at all; cucurbits rot after a 45F night). Both are true.
  //
  // They are overridden anyway, on ALERT-FATIGUE grounds. Against four years of site actuals (Sep 1 - Nov 15),
  // the tropical imminent line (<= 50F) tripped on 44-53 of 76 nights, first trip Sep 1-4 EVERY year, and the
  // chill_sensitive line (<= 45F) on 31-38, versus 14-19 for the tender line (<= 38F); the first night that
  // threatens the tender crops is Oct 9-24. Alerting two nights in three is not a signal; it is how the only
  // operator learns to ignore the channel, and a muted channel then misses the October night that matters.
  // Over-alerting here has the SAME failure mode as not alerting at all, arrived at more slowly.
  //
  // Moving tropical ALONE was rejected: it inverts BAND_ORDER (basil at 45F would alert BEFORE a pothos at
  // 38F) and removes only about a third of the fatigue. Collapsing both into the tender line keeps the band
  // table monotonic and gets the ~19-night channel.
  //
  // THE ACCEPTED COST: a 40-45F night can damage basil, cucurbits and the potted tropicals with no alert. The
  // mitigation is a one-time "bring the tropicals in / cut the basil" task by mid-September (see
  // COLD_BY_CROP_TYPE), not a nightly page. Revisit if the tropical population grows or a per-plant
  // bring-inside surface ever exists.
  tropical: Object.freeze({
    ADVISORY_LOW_F: numEnv('FROST_ADVISORY_LOW_F', 40),
    IMMINENT_LOW_F: numEnv('FROST_IMMINENT_LOW_F', 38),
    HARD_FREEZE_LOW_F: numEnv('FROST_HARD_FREEZE_LOW_F', 33),
  }),
  chill_sensitive: Object.freeze({
    ADVISORY_LOW_F: numEnv('FROST_ADVISORY_LOW_F', 40),
    IMMINENT_LOW_F: numEnv('FROST_IMMINENT_LOW_F', 38),
    HARD_FREEZE_LOW_F: numEnv('FROST_HARD_FREEZE_LOW_F', 33),
  }),
  // D2 BASELINE. Killed at or just below the first frost. Also the band an unknown slug falls into.
  tender: Object.freeze({
    ADVISORY_LOW_F: numEnv('FROST_ADVISORY_LOW_F', 40),
    IMMINENT_LOW_F: numEnv('FROST_IMMINENT_LOW_F', 38),
    HARD_FREEZE_LOW_F: numEnv('FROST_HARD_FREEZE_LOW_F', 33),
  }),
  // Shrug off a light frost, killed by a hard one. Alerting these at 38°F is pure noise: they are the crops
  // still standing the morning after the first frost.
  light_frost_tolerant: Object.freeze({ ADVISORY_LOW_F: 36, IMMINENT_LOW_F: 34, HARD_FREEZE_LOW_F: 30 }),
  // Unharmed or improved by frost. NEVER alerted (§3-4). null is the "no trip point exists" signal.
  hardy: null,
});

// The band an unknown/unmapped slug is counted in (§3-4 fail-safe: unknown counts as tender).
const UNKNOWN_BAND = 'tender';

const BAND_ORDER = ['tropical', 'chill_sensitive', 'tender', 'light_frost_tolerant', 'hardy'];

// ── Slug -> band ──────────────────────────────────────────────────────────────────────────────────
const SLUGS_BY_BAND = Object.freeze({
  tropical: [
    // houseplants brought in for winter
    'pothos', 'spider_plant', 'dracaena', 'tradescantia', 'fittonia',
    // soft succulents — cold-tender, unlike the hardy Sempervivum they are often lumped with
    'jade', 'echeveria', 'haworthia', 'lithops', 'christmas_cactus', 'crown_of_thorns',
    // true tropicals grown in pots here
    'avocado', 'pineapple', 'lemongrass', 'lemon_verbena',
    // V4-TROPICALCOLD-001: these entered the crop_type domain after the original provenance pull and fell
    // through to UNKNOWN_BAND. Banding them moves NO alert threshold (tropical is held to the tender baseline,
    // identical to UNKNOWN_BAND) but makes them VISIBLE to the coverage guards and is the declaration the
    // cold-profile requirement is derived from (COLD_BY_CROP_TYPE below).
    //   ginger  - chilling injury in the low 50s, cumulatively and irreversibly, long before any frost.
    //   aloe    - tender succulent; same overwinter-indoors handling as jade/echeveria.
    //   lantana - tender tropical shrub, overwintered indoors rather than replaced.
    'ginger', 'aloe', 'lantana',
    // hoya - a tropical epiphyte (wax plant, Hoya carnosa): winter hardy to zone 10-12, tolerating night
    // temperatures down to 50F (MBG Plant Finder).
    'hoya',
  ],
  chill_sensitive: [
    'basil',
    // cucurbits — chilling injury well above freezing
    'melon', 'watermelon', 'cucumber', 'squash', 'winter_squash', 'bitter_melon', 'cucamelon', 'luffa',
    // other warm-season crops with the same chilling response
    'okra', 'sweet_potato',
    // tropical culinary herbs
    'perilla', 'culantro', 'vietnamese_coriander',
    // tender ornamentals overwintered indoors or replaced yearly; all damaged in the 40s
    'geranium', 'coleus', 'begonia', 'torenia', 'thunbergia', 'cobaea',
  ],
  tender: [
    // solanaceous core — the D2 baseline, and 105 of the 250 live plantings
    'pepper', 'tomato', 'tomatillo', 'eggplant',
    // killed outright by the first frost
    'bean', 'nasturtium', 'four_o_clock', 'morning_glory', 'tweedia', 'helichrysum',
    // calibrachoa - a tender bedding annual, frost-killed and replaced yearly rather than overwintered, so
    // `tender`, not `tropical`. It gets NO cold profile below: nothing to save by carrying it indoors.
    'calibrachoa',
    // potato: the TUBERS survive, the FOLIAGE does not, so a frost ends the planting's growth. Kept at the
    // tender baseline rather than light_frost_tolerant: foliage blackens around 31°F, so 38 is an early
    // warning rather than a wrong one, and over-alerting a potato is cheap.
    'potato',
    // pineapple_sage (BUG-PINEAPPLESAGEBAND-001) - Salvia elegans, zone 8-10, top-killed by the first frost.
    // It was typed `sage`, banded hardy for GARDEN sage, so no frost alert could ever name it. Genus cannot
    // tell them apart and a name is not an identity, so it has a crop type of its own (migrations/
    // v5-frostband-001). `tender`, not `tropical`: frost kills it, the 50s do not chill-injure it, and the
    // tender band carries no crop-type cold profile (COLD_PROFILE_REQUIRED_BANDS). Its bring-it-inside
    // threshold lives on its cultivar care profile.
    'pineapple_sage',
    // Crop types minted but not yet planted; banded now because the day one is planted is the day it would
    // count unseen.
    //   corn          - sweet corn. UMN Extension: "A corn killing freeze occurs when temperatures dip to 32
    //                   degrees Fahrenheit for four hours or 28 degrees for minutes."
    //   cosmos        - a "warm weather annual" that blooms "to frost" (MBG).
    //   summer_savory - sown once any threat of frost is past, "the same for basil seeds" (Herb Society of
    //                   America).
    'corn', 'cosmos', 'summer_savory',
  ],
  light_frost_tolerant: [
    // still standing the morning after a light frost; a hard freeze finishes them
    'marigold', 'petunia', 'sunflower', 'borage',
    // chamomile - German chamomile is sown before the last spring frost (MBG, UW-Madison Extension), so it
    // takes a light frost; no source says it takes a hard one, and its flowers run "until frost". Borage's
    // band, the other self-seeding annual herb, not hardy.
    'chamomile',
  ],
  hardy: [
    // §3-4 named
    'kale', 'cabbage', 'broccoli', 'carrot', 'beet', 'leek',
    // brassicas + cool-season greens
    'brussels_sprouts', 'collard', 'bok_choy', 'kohlrabi', 'mustard', 'arugula', 'spinach', 'lettuce',
    'endive', 'radicchio', 'celery', 'chervil', 'cilantro', 'chard',
    // chard: mentioned in CROP_TYPE_SLUGS but once mapped to no band, so it silently counted as tender
    // (V4-SLUGCONSIST-001). Banded hardy to match 'beet': chard IS Beta vulgaris, same species and cold
    // tolerance.
    // roots + alliums
    'parsnip', 'radish', 'rat_tail_radish', 'turnip', 'onion', 'bunching_onion', 'garlic', 'shallot', 'pea',
    // hardy perennial herbs
    'parsley', 'sage', 'thyme', 'oregano', 'mint', 'chives', 'dill', 'tarragon',
    // hardy perennials / biennials / hardy annuals
    'milkweed', 'bee_balm', 'chrysanthemum', 'rose', 'hosta', 'columbine', 'delphinium', 'foxglove',
    'hollyhock', 'althaea', 'carnation', 'edelweiss', 'money_plant', 'blackberry_lily', 'poppy', 'viola',
    'stock', 'sempervivum', 'asparagus',
    // woody fruit + trees (first frost is not the risk; spring bloom frost is a separate concern)
    'blueberry', 'blackberry', 'black_raspberry', 'red_raspberry', 'wineberry', 'strawberry', 'peach',
    'japanese_maple',
    // dogwood - Kousa (Cornus kousa), a fully hardy zone-5 landscape tree in the ground; banded to stop it
    // counting as tender.
    'dogwood',
    // The rest of the crop_types vocabulary (V4-TROPICALCOLD-001): re-pinning the guard's universe from
    // `crop_types` instead of `plant_varieties.crop_type_slug` exposed 16 never-banded slugs counting as
    // tender. All are hardy with no live plantings, so no current planting changes; it is forward coverage
    // bought before the planting exists, which is the only time it is free.
    // Hardy tree fruit + fruiting woody: first frost is not the risk (spring bloom frost is, and is a
    // separate concern), same rationale as the peach/blueberry entries.
    'apple', 'apricot', 'cherry', 'sour_cherry', 'nectarine', 'pear', 'plum', 'grape', 'elderberry',
    'cranberry', 'raspberry',
    // crabapple (DATA-CRABAPPLEPROFILE-001) - marked hardy next to apple: same genus, same answer (first frost
    // is not a risk to an established tree). It was unbanded, so the frost email counted it "unclassified".
    'crabapple',
    // Hardy perennial crown.
    'rhubarb',
    // The overwintering greens, the crops that are SUPPOSED to be out in a frost. Alerting these at 38F would
    // be the clearest false positive.
    'claytonia', 'mache', 'mizuna', 'tatsoi',
    // BUG-STABLEUNKNOWNSLUGS-001: two false alarms the Stable exposed once the alert stopped skipping it
    // (BUG-FROSTALERTSTABLE-001), each banded by its own controlled slug:
    //   hylotelephium - showy stonecrop, sold as "Sedum spectabile", zone 3. Minted by migrations/
    //                   v5-frostband-001, which re-points that cultivar off `sedum` by id. `sedum` itself
    //                   stays UNCERTAIN: what is left under it is tender.
    //   horseweed     - Erigeron canadensis, a native annual weed whose rosettes overwinter to zone 3.
    'hylotelephium', 'horseweed',
    // OPS-SLUGUNIVERSESTALE-001: crop types minted after the guard's pin, banded on the cultivars prod holds.
    // The first three were in the frost email as "unclassified" (counted tender) until banded.
    //   goldenrod     - Solidago canadensis, herbaceous perennial, zone 3-9 (MBG).
    //   lamb_s_ear    - Stachys byzantina, zone 4-8 (MBG). Typed `sage` (hardy) until its own crop type was
    //                   minted, so this restores its old answer.
    //   yarrow        - Achillea millefolium, zone 3-9 (MBG).
    // Not planted yet:
    //   blanketflower - perennial Gaillardia (G. aristata zone 3-8, MBG). The annual G. pulchella would get
    //                   its own slug, not this one.
    //   dianthus      - D. caryophyllus, the species `carnation` already is, zone 5-9 or 6-9 (MBG); Penn
    //                   State Extension files Dianthus with the hardy annuals.
    //   snapdragon    - Antirrhinum majus: SDSU Extension, "can survive temperatures as low as 25 degrees
    //                   Fahrenheit", below the 30F trip that light_frost_tolerant would fire.
    'goldenrod', 'lamb_s_ear', 'yarrow', 'blanketflower', 'dianthus', 'snapdragon',
  ],
});

// DELIBERATELY UNMAPPED. These fall through to `unknown` (counted in the tender band, reported separately)
// rather than being guessed. Documented so a future reader knows the omission is a decision, not a gap.
//   sedum   - genus spans hardy stonecrop AND tender species; the live rows are Sedum adolphii (tender), so a
//             slug-level "hardy" guess would be WRONG. The hardy one that turned up (Autumn Fire, a
//             Hylotelephium) moved to its own `hylotelephium` slug (BUG-STABLEUNKNOWNSLUGS-001).
//   cactus / succulent - generic buckets; live rows are tender but hardy Opuntia/Sempervivum would share the
//             slug. A hardy one gets its own slug, as `sempervivum` and `hylotelephium` did, never a hardy bucket.
//   hibiscus - tropical (tender) and H. moscheutos (hardy) share the slug; the live row is tender.
//   bay / rosemary - zone-8-ish woody herbs: they SURVIVE a first frost (so not "tender" in this feature's
//             sense) but are overwintered indoors here (so not "never alert" either). Marginal by nature.
//   artichoke - overwinter-marginal; not killed by first frost, not reliably hardy.
//   flower_mix - an unopened seed blend of unknown composition.
//   penstemon - the genus spans hardy species (most zone 3-8) and the large-flowered bedding hybrids
//             ("tender perennial", MSU Extension). The one live planting is that hybrid: it survives a first
//             frost and is not hardy here, the bay/rosemary case. Nothing is lost by leaving it unmapped: its
//             cultivar care profile says cold.tender, so the handler's cadence promotion names it at the
//             tender trips, and that profile's own 35F card still fires. A hardy species gets its own slug.
const UNCERTAIN_SLUGS = ['sedum', 'cactus', 'succulent', 'hibiscus', 'bay', 'rosemary', 'artichoke', 'flower_mix',
  'penstemon'];

// NOT PLANTS: no frost band exists to decide (OPS-SLUGUNIVERSESTALE-001). These crop types are category
// 'non_plant_food' (migrations/v4-putupfood-001), Put-Up's pantry classes. None can be a planting's type: the
// planting query reads the slug through plant_varieties, and that migration's continuous gate
// post_no_variety_typed_to_a_food_class keeps every variety off a food class. Named one by one rather than
// skipped by category (the v4-harvhabitgap-001 precedent): a category exemption lets the next food class in
// with no record. Banding one `hardy` to satisfy a guard would be a false statement about bread; if one ever
// reached summarize it falls through to UNKNOWN_BAND and reads "unclassified", the right loud answer.
const NON_PLANT_FOOD_SLUGS = Object.freeze(['bread', 'butter', 'cheese', 'fish', 'meat', 'milk', 'yogurt']);

const BAND_BY_SLUG = Object.freeze(Object.fromEntries(
  BAND_ORDER.flatMap((band) => SLUGS_BY_BAND[band].map((s) => [s, band])),
));

// ── V4-TROPICALCOLD-001: crop-type cold profiles (the BRING-IT-INDOORS channel) ──────────────────
//
// THIS IS A DIFFERENT CHANNEL FROM THE BANDS ABOVE, and the distinction is the whole item. The bands drive
// frostEval's coalesced frost ALERT (one SMS per frost event) and are held to the tender baseline for alert
// fatigue. `protect_below_F` here drives engine.coldFor -> tasks.cold: a per-planting card in the in-app
// Today/CareNeeded list with a one-tap `brought_inside`. It pages no one, which is why a low-50s number is
// affordable here and not in a band.
//
// It is the mitigation the band decision above names: a ONE-TIME "bring the tropicals in" task, not a
// nightly page. ONE-TIME is load-bearing: coldFor is evaluated nightly, so without the
// brought_inside/brought_outside suppression in engine.coldFor these become the nightly nag the band
// decision rejected. The suppression is a precondition of this being correct.
//
// WHY CROP-TYPE-KEYED. cadence-data-v2.json carries cold profiles keyed by VARIETY, which only covers a plant
// somebody hand-authored a row for (ginger, a gift plant with no variety row, could not produce a cold task
// at ANY temperature). crop_type_slug is the coarsest key that still carries the trait, so ONE entry covers
// every present and future planting. Variety-level stays authoritative where it exists; this is the fallback
// beneath it, never an override.
//
// SCOPED TO THE `tropical` BAND ON PURPOSE. `chill_sensitive` (basil, cucurbits) is chill-injured in the 40s
// but is field-planted with nothing to carry indoors; a "bring it in tonight" card against an in-ground
// squash cannot be followed. All live tropical-band plantings are potted.
const COLD_BY_CROP_TYPE = Object.freeze({
  // True tropicals — chilling injury in the low 50s, well above any frost.
  ginger:        Object.freeze({ tender: true, protect_below_F: 55 }),
  pineapple:     Object.freeze({ tender: true, protect_below_F: 55 }),
  lemongrass:    Object.freeze({ tender: true, protect_below_F: 50 }),
  lemon_verbena: Object.freeze({ tender: true, protect_below_F: 50 }),
  avocado:       Object.freeze({ tender: true, protect_below_F: 50 }),
  lantana:       Object.freeze({ tender: true, protect_below_F: 50 }),
  // Foliage houseplants — damaged in the mid-40s, and all of them live outdoors only for the summer.
  // hoya: MBG Plant Finder, Hoya carnosa, "tolerate night temperatures to 50F" in winter.
  hoya:          Object.freeze({ tender: true, protect_below_F: 50 }),
  pothos:        Object.freeze({ tender: true, protect_below_F: 50 }),
  spider_plant:  Object.freeze({ tender: true, protect_below_F: 45 }),
  dracaena:      Object.freeze({ tender: true, protect_below_F: 50 }),
  tradescantia:  Object.freeze({ tender: true, protect_below_F: 45 }),
  fittonia:      Object.freeze({ tender: true, protect_below_F: 55 }),
  // Soft succulents. Cold-tolerant relative to the tropicals and harmed far more by wet-and-cold than
  // by cool alone, so these sit at the bottom of the range rather than with the true tropicals.
  jade:            Object.freeze({ tender: true, protect_below_F: 45 }),
  echeveria:       Object.freeze({ tender: true, protect_below_F: 40 }),
  haworthia:       Object.freeze({ tender: true, protect_below_F: 40 }),
  aloe:            Object.freeze({ tender: true, protect_below_F: 45 }),
  lithops:         Object.freeze({ tender: true, protect_below_F: 40 }),
  christmas_cactus:Object.freeze({ tender: true, protect_below_F: 45 }),
  crown_of_thorns: Object.freeze({ tender: true, protect_below_F: 50 }),
});

// The bands whose members MUST carry a cold profile. Exported so the coverage guard derives the requirement
// from the same declaration the runtime reads, not a second hand-kept list that can silently disagree
// (the failure mode that hid ginger).
const COLD_PROFILE_REQUIRED_BANDS = Object.freeze(['tropical']);

// The cold profile for a crop_type_slug, or null. Null means "no decision recorded": callers must treat it
// as UNKNOWN and not substitute a default (silently inheriting the tender baseline is how a 55°F plant got a
// 38°F answer).
function coldProfileForSlug(slug) {
  const s = normalizeSlug(slug);
  return (s && COLD_BY_CROP_TYPE[s]) || null;
}

// Back-compat with the pre-D6 3-class map: tender/chill_sensitive/tropical/light_frost_tolerant all read
// as class 'tender'; hardy reads as 'hardy'. Kept because the class is what the §3-4 copy counts.
const CLASS_BY_BAND = Object.freeze({
  tropical: 'tender', chill_sensitive: 'tender', tender: 'tender', light_frost_tolerant: 'tender', hardy: 'hardy',
});
const CLASS_BY_SLUG = Object.freeze(Object.fromEntries(
  Object.entries(BAND_BY_SLUG).map(([s, b]) => [s, CLASS_BY_BAND[b]]),
));
const TENDER_SLUGS = Object.freeze(Object.keys(CLASS_BY_SLUG).filter((s) => CLASS_BY_SLUG[s] === 'tender'));
const HARDY_SLUGS = Object.freeze(SLUGS_BY_BAND.hardy.slice());

// ── Display labels ────────────────────────────────────────────────────────────────────────────────
// The coalesced alert names CROP TYPES, not plantings, which keeps one SMS readable when many plantings are
// at risk. Irregulars are listed; everything else falls through to the rule below.
const CROP_LABELS = Object.freeze({
  tomato: 'tomatoes', tomatillo: 'tomatillos', potato: 'potatoes', sweet_potato: 'sweet potatoes',
  squash: 'squash', winter_squash: 'winter squash', okra: 'okra', basil: 'basil', coleus: 'coleus',
  fittonia: 'fittonia', echeveria: 'echeveria', haworthia: 'haworthia', lithops: 'lithops',
  pothos: 'pothos', jade: 'jade plants', christmas_cactus: 'Christmas cactus',
  crown_of_thorns: 'crown of thorns', spider_plant: 'spider plants', dracaena: 'dracaena',
  tradescantia: 'tradescantia', lemongrass: 'lemongrass', lemon_verbena: 'lemon verbena',
  perilla: 'perilla', culantro: 'culantro', vietnamese_coriander: 'Vietnamese coriander',
  four_o_clock: "four o'clocks", morning_glory: 'morning glories', helichrysum: 'helichrysum',
  borage: 'borage', thunbergia: 'thunbergia', cobaea: 'cobaea', torenia: 'torenia',
  bitter_melon: 'bitter melon', cucamelon: 'cucamelons', luffa: 'luffa', pineapple: 'pineapple',
  pineapple_sage: 'pineapple sage',
  // The rule below would say "corns", "cosmoses", "summer savories", "chamomiles".
  corn: 'corn', cosmos: 'cosmos', summer_savory: 'summer savory', chamomile: 'chamomile',
});
function cropLabel(slug) {
  if (!slug) return 'unclassified';
  if (CROP_LABELS[slug]) return CROP_LABELS[slug];
  const words = String(slug).replace(/_/g, ' ');
  if (/(s|x|z|ch|sh)$/.test(words)) return `${words}es`;
  if (/o$/.test(words)) return `${words}es`;
  if (/[^aeiou]y$/.test(words)) return `${words.slice(0, -1)}ies`;
  return `${words}s`;
}

// ── Threshold resolution ──────────────────────────────────────────────────────────────────────────
// Override chain, weakest first: band defaults -> env FROST_BAND_THRESHOLDS_JSON -> env
// FROST_THRESHOLD_OFFSET_F (uniform, the F5 rehearsal lever) -> per-call `bandThresholds`.
// Unknown band names and non-numeric values THROW rather than silently keeping the default: a typo'd override
// that silently kept the default is the failure this feature cannot afford (§3-7).
const TRIP_KEYS = ['ADVISORY_LOW_F', 'IMMINENT_LOW_F', 'HARD_FREEZE_LOW_F'];

function applyOverrideSet(base, overrides, where) {
  const out = { ...base };
  for (const [band, vals] of Object.entries(overrides || {})) {
    if (!(band in BAND_THRESHOLDS)) throw new Error(`frostClass: unknown band "${band}" in ${where}`);
    if (vals == null) { out[band] = null; continue; }
    const cur = out[band] ? { ...out[band] } : {};
    for (const [k, v] of Object.entries(vals)) {
      if (!TRIP_KEYS.includes(k)) throw new Error(`frostClass: unknown threshold "${k}" for band ${band} in ${where}`);
      if (v == null) continue;
      if (!Number.isFinite(Number(v))) throw new Error(`frostClass: non-numeric threshold ${band}.${k}=${v} in ${where}`);
      cur[k] = Number(v);
    }
    out[band] = cur;
  }
  return out;
}

function envBandOverrides() {
  const raw = process.env.FROST_BAND_THRESHOLDS_JSON;
  if (!raw) return null;
  try { const j = JSON.parse(raw); return (j && typeof j === 'object') ? j : null; } catch (_) { return null; }
}

function resolveBandThresholds(overrides) {
  let out = {};
  for (const b of BAND_ORDER) out[b] = BAND_THRESHOLDS[b] ? { ...BAND_THRESHOLDS[b] } : null;
  const fromEnv = envBandOverrides();
  if (fromEnv) out = applyOverrideSet(out, fromEnv, 'FROST_BAND_THRESHOLDS_JSON');
  const offset = Number(process.env.FROST_THRESHOLD_OFFSET_F);
  if (Number.isFinite(offset) && offset !== 0) {
    for (const b of BAND_ORDER) {
      if (!out[b]) continue;
      for (const k of TRIP_KEYS) out[b][k] = out[b][k] + offset;
    }
  }
  if (overrides) out = applyOverrideSet(out, overrides, 'bandThresholds');
  return out;
}

// ── Classification ────────────────────────────────────────────────────────────────────────────────
const normalizeSlug = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : null);

// Classify ONE slug. Returns { slug, class, countedAs, source, band, label, thresholds }.
//   class      'tender' | 'hardy' | 'unknown'   — the honest answer
//   countedAs  'tender' | 'hardy'               — how the alert counts it (§3-4: unknown counts as tender)
//   band       the D6 threshold band actually used ('hardy' -> null thresholds, never alerted)
//   source     'slug' | 'cadence' | 'unmapped' | 'missing'
//
// `opts.cadenceTender` is the cold.tender signal from cadence-data-v2.json (§3-4 "plus cold.tender profiles").
// It is a PROMOTION-ONLY input: it can lift an unknown into the tender band, but it can NEVER override an
// explicit slug classification. That precedence is load-bearing: cadence-data-v2.json keys by VARIETY NAME,
// and by_variety['Peach'] is a PEPPER profile (cold.tender, protect_below_F 50) which collides with a "Peach
// tree" planting whose variety name is also "Peach"; cadence-wins would mark a mature peach tree tender at
// 50°F.
function frostClassForSlug(slug, opts = {}) {
  const T = opts.resolvedBands || resolveBandThresholds(opts.bandThresholds);
  const pack = (s, cls, countedAs, source, band) => ({
    slug: s, class: cls, countedAs, source, band,
    label: cropLabel(s), thresholds: T[band] ? { ...T[band] } : null,
  });
  const s = normalizeSlug(slug);
  if (!s) return pack(null, 'unknown', 'tender', 'missing', UNKNOWN_BAND);
  const band = BAND_BY_SLUG[s];
  if (band) return pack(s, CLASS_BY_BAND[band], CLASS_BY_BAND[band], 'slug', band);
  if (opts.cadenceTender) return pack(s, 'tender', 'tender', 'cadence', UNKNOWN_BAND);
  return pack(s, 'unknown', 'tender', 'unmapped', UNKNOWN_BAND);
}

// Container detection mirrors the planting shape the daily-plan query already returns
// (plants.container_type). §3-4: containers are listed first — most exposed, easiest to save.
function isContainer(p) {
  const t = p && p.container_type;
  return !!(t && String(t).trim() && String(t).trim().toLowerCase() !== 'in_ground');
}

// D6 indoor-exclusion, keyed on HEAT since BUG-FROSTALERTSTABLE-001. A planting is left out of the frost alert
// only when its location is HEATED: locations.heated (migrations/v5-locheated-001), projected by handler.js
// as `l.heated is true as heated_resolved`.
//
// It used to read frost_covered_resolved (locations.covered), and that was the bug: `covered` means rain does
// not reach the plant, not that frost does not. The Stable is covered and UNHEATED (the House is heated, the
// shelves are all in the Stable), so every Stable planting was dropped from every frost alert, hard freeze
// included. The decision is to warn for them at the same trips as the outdoor crops; the email stops naming a
// plant once it is moved into the House.
//
// Fail-safe unchanged (BUG-NOLOCOUTDOOR-001): excluding a planting SUPPRESSES its frost alert, so only a
// strict `=== true` excludes. An un-located planting reads heated_resolved false (SQL `IS TRUE`), and a row
// with no flag at all reads undefined; both keep their seat in the alert. Silence must never be
// indistinguishable from safety. frost_covered_resolved still exists for its other readers (ledger.js
// exposureClass) and is deliberately NOT read here.
function isHeatedDefault(p) {
  return !!(p && p.heated_resolved === true);
}

// Classify a list of plantings and produce the exposure summary frostEval's copy consumes.
// Each planting is expected to carry { id, name, crop_type_slug, container_type, status, heated_resolved }:
// a superset of what the daily-plan query selects, plus crop_type_slug via the plant_varieties join.
// `opts.isCovered` / `opts.excludeCovered` and the `coveredExcluded*` outputs keep their D6 names for the
// callers and frostEval provenance that read them; what they count is now "indoors in a HEATED location".
function summarize(plantings, opts = {}) {
  const rows = Array.isArray(plantings) ? plantings : [];
  const resolvedBands = opts.resolvedBands || resolveBandThresholds(opts.bandThresholds);
  const cadenceTenderFor = typeof opts.cadenceTenderFor === 'function' ? opts.cadenceTenderFor : () => false;
  const isCovered = typeof opts.isCovered === 'function' ? opts.isCovered
    : (opts.excludeCovered === false ? () => false : isHeatedDefault);
  const out = {
    tender: 0, hardy: 0, unknown: 0,
    tenderContainers: 0,
    tenderFruiting: 0,
    // At-risk == everything the alert names == tender + unknown (§3-4 unknown-counted-as-tender).
    atRisk: 0,
    tenderPlantings: [], unknownPlantings: [],
    unknownSlugs: [],
    // D6: named crop types, each carrying ITS OWN trip points. This is what makes one coalesced alert
    // possible: the message names a handful of crop types instead of every planting.
    byCropType: [],
    // D6: at-risk plantings suppressed because they sit in a HEATED location (an unheated covered building
    // such as the Stable is NOT excluded). Reported (never silent) so a shrinking alert is explainable, but
    // kept OUT of the SMS body to protect its length.
    coveredExcluded: 0, coveredExcludedSlugs: [],
    bands: resolvedBands,
  };
  const unknownSlugSet = new Set();
  const coveredSlugSet = new Set();
  const byType = new Map();
  for (const p of rows) {
    if (!p) continue;
    const r = frostClassForSlug(p.crop_type_slug, { cadenceTender: !!cadenceTenderFor(p), resolvedBands });
    if (r.class === 'hardy') { out.hardy++; continue; }
    // Plantings in a heated location are excluded from every at-risk number AND from the named crop list
    // (D6). Done AFTER the hardy check so a kale in the House is simply hardy, not double-counted.
    if (isCovered(p)) {
      out.coveredExcluded++;
      if (r.slug) coveredSlugSet.add(r.slug);
      continue;
    }
    const container = isContainer(p);
    const fruiting = p.status === 'flowering' || p.status === 'fruiting';
    const item = { id: p.id, name: p.name, slug: r.slug, class: r.class, band: r.band, source: r.source, container, status: p.status || null };
    if (r.class === 'unknown') {
      out.unknown++; out.unknownPlantings.push(item);
      if (r.slug) unknownSlugSet.add(r.slug);
    } else {
      out.tender++; out.tenderPlantings.push(item);
    }
    out.atRisk++;
    if (container) out.tenderContainers++;
    if (fruiting) out.tenderFruiting++;

    // Group by crop type. An unmapped/NULL slug groups under a single synthetic 'unclassified' bucket so
    // the message says "3 unclassified" once rather than naming three mystery slugs.
    const key = r.class === 'unknown' ? '__unclassified__' : r.slug;
    let g = byType.get(key);
    if (!g) {
      g = {
        slug: r.class === 'unknown' ? null : r.slug,
        label: r.class === 'unknown' ? 'unclassified' : r.label,
        band: r.band, class: r.class, thresholds: r.thresholds,
        count: 0, containers: 0, fruiting: 0, names: [], ids: [],
      };
      byType.set(key, g);
    }
    // BUG-INGROUND39FSLIVER-001: every planting id, uncapped (unlike `names`), so frostEval.frostCoverage can
    // say which plantings a tripped crop covers without re-deriving this grouping. Never reaches the message,
    // the dedup key or alerts_sent (those read slug/label/count/level only).
    g.ids.push(p.id);
    g.count++;
    if (container) g.containers++;
    if (fruiting) g.fruiting++;
    if (g.names.length < 5 && p.name) g.names.push(p.name);
  }
  out.unknownSlugs = [...unknownSlugSet].sort();
  out.coveredExcludedSlugs = [...coveredSlugSet].sort();
  // Containers first (§3-4), then fruiting/flowering, then the rest — stable within each group.
  const rank = (x) => (x.container ? 0 : 2) + ((x.status === 'flowering' || x.status === 'fruiting') ? 0 : 1);
  out.tenderPlantings.sort((a, b) => rank(a) - rank(b));
  out.unknownPlantings.sort((a, b) => rank(a) - rank(b));
  // Crop types: the most exposed first (most containers, then most plantings, then alphabetical) so the
  // ordering is deterministic; a message that reshuffles between runs reads as a different alert.
  out.byCropType = [...byType.values()].sort((a, b) =>
    (b.containers - a.containers) || (b.count - a.count) || String(a.label).localeCompare(String(b.label)));
  return out;
}

module.exports = {
  frostClassForSlug, summarize, isContainer, isHeatedDefault, cropLabel,
  resolveBandThresholds, coldProfileForSlug,
  BAND_THRESHOLDS, BAND_BY_SLUG, SLUGS_BY_BAND, BAND_ORDER, UNKNOWN_BAND, TRIP_KEYS,
  CLASS_BY_SLUG, CLASS_BY_BAND, TENDER_SLUGS, HARDY_SLUGS, UNCERTAIN_SLUGS, NON_PLANT_FOOD_SLUGS, CROP_LABELS,
  COLD_BY_CROP_TYPE, COLD_PROFILE_REQUIRED_BANDS,
};
