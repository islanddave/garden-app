'use strict';
// V4-FROST-001 slice F2 — pure crop_type_slug -> frost sensitivity BAND + per-crop-type trip points.
// HTTP-free, deterministic, unit-testable (house pattern: lambda/daily-plan/station.js). The planting QUERY
// lives in handler.js. Design ref: frost-alert-design-V100-20260803.md §3-4, as amended by decision D6.
//
// D6 (Dave, 2026-08-04) CHANGES §3-4: thresholds are PER CROP TYPE, not one global tender/hardy split —
// "stay true to the care engine, since crops have genuinely different cold tolerances." Delivery is still
// ONE COALESCED alert per frost event (frostEval.js), never one message per crop.
//
// WHY NOT coldFor (design G2): engine.js:coldFor fires only for (a) a pepper/tomato regex on crop-or-name
// and (b) cadence profiles carrying cold.tender. On a 30°F night it emits NO cold task for basil, melon,
// watermelon, tomatillo, bean, nasturtium or cucurbits. Frost tiering is therefore computed HERE from a
// sensitivity band, never reused from coldFor.
//
// WHY NOT cadence protect_below_F verbatim: cadence-data-v2.json's protect_below_F is a CONTAINER-COMFORT
// number (pepper = 50°F: bring the pot in to keep it setting fruit), not a frost-KILL number. Adopting it
// would fire the alert on most September nights and bury the signal. The bands below are frost-damage/kill
// thresholds; the care engine keeps its own comfort numbers. Same split the design draws in G2.
//
// PROVENANCE: the slug set was derived from LIVE prod Neon (ep-lucky-bird-amju6iqt-pooler) on 2026-08-04 —
// 250 live plantings across 80 distinct crop_type_slug values (3 NULL), plus the FULL
// plant_varieties.crop_type_slug domain (120 values) so a newly-planted variety of an existing crop is
// already covered. Live-planting query = the daily-plan handler.js WHERE clause verbatim.

const numEnv = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
};

// ── Bands ─────────────────────────────────────────────────────────────────────────────────────────
// Each band carries the same three trip points frostEval uses globally, so a band IS a threshold set.
// `tender` is the D2-APPROVED baseline (advisory 40 / imminent 38 / hard-freeze 33) and is also the
// fallback band for an unknown slug (§3-4 unknown-counted-as-tender). The other bands deviate ONLY where
// the crop's cold tolerance genuinely differs; every deviation is justified in the slug lists below.
//
// The three env names below are the prep's original global overrides. Under D6 they retarget the TENDER
// band specifically — that keeps D2's "injectable exactly as prepared" contract intact while the other
// bands move relative to it via FROST_BAND_THRESHOLDS_JSON or the uniform offset.
const BAND_THRESHOLDS = Object.freeze({
  // ═══ DAVE DECISION 2026-08-07 — the two most sensitive bands are HELD to the tender baseline ═══
  //
  // Horticulturally correct values, preserved here because they are the thing to restore, not
  // rediscover: tropical 52/50/40 (chilling injury in the low 50s, long before frost) and
  // chill_sensitive 47/45/36 (basil blackens at ~40F with no frost at all; cucurbits rot after a
  // 45F night). Both are true.
  //
  // They are overridden anyway, on ALERT-FATIGUE grounds. Measured against four years of
  // Open-Meteo actuals at the site (42.5087N, -72.6471W), Sep 1 - Nov 15:
  //     <= 50F (tropical imminent)        49 / 44 / 53 / 51 nights of 76   -- first trip Sep 1-4 EVERY year
  //     <= 45F (chill_sensitive imminent) 33 / 33 / 31 / 38 nights
  //     <= 38F (tender imminent)          14 / 15 / 16 / 19 nights
  // while the first night that actually threatens the tender crops is Oct 9-24. Alerting two
  // nights in three is not a signal; it is how the only operator learns to ignore the channel, and
  // a muted channel then misses the October night that matters. The failure mode of over-alerting
  // here is the SAME failure mode as not alerting at all, arrived at more slowly.
  //
  // Moving tropical ALONE was considered and rejected: it inverts BAND_ORDER (basil at 45F would
  // alert BEFORE a pothos at 38F, so the more sensitive plant warns later) and it only removes
  // about a third of the fatigue, since chill_sensitive keeps firing 31-38 nights. Collapsing both
  // into the tender line keeps the band table monotonic and gets the ~19-night channel.
  //
  // THE ACCEPTED COST, stated plainly: a 40-45F night can damage basil, cucurbits and the potted
  // tropicals with no alert. The mitigation is a one-time "bring the tropicals in / cut the basil"
  // task by mid-September, not a nightly page. Revisit if the tropical population grows or if a
  // per-plant bring-inside surface ever exists.
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
  // Shrug off a light frost, killed by a hard one. Alerting these at 38°F is pure noise — they are the
  // crops still standing the morning after the first frost.
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
    // potato: the TUBERS survive, the FOLIAGE does not — a frost ends the planting's growth.
    // Kept at the tender baseline rather than light_frost_tolerant: foliage blackens around 31°F, so 38
    // is an early warning rather than a wrong one, and over-alerting a potato is cheap.
    'potato',
  ],
  light_frost_tolerant: [
    // still standing the morning after a light frost; a hard freeze finishes them
    'marigold', 'petunia', 'sunflower', 'borage',
  ],
  hardy: [
    // §3-4 named
    'kale', 'cabbage', 'broccoli', 'carrot', 'beet', 'leek',
    // brassicas + cool-season greens
    'brussels_sprouts', 'collard', 'bok_choy', 'kohlrabi', 'mustard', 'arugula', 'spinach', 'lettuce',
    'endive', 'radicchio', 'celery', 'chervil', 'cilantro', 'chard',
    // chard added 2026-08-05 (V4-SLUGCONSIST-001, found by the new cross-surface guard, not by a
    // user report). It was mentioned in CROP_TYPE_SLUGS and in the ripeness cues but mapped to no
    // band, so it silently counted as tender (40/38/33). Banded hardy to match 'beet': chard IS
    // Beta vulgaris — same species, same cold tolerance. Zero live chard plantings at the time of
    // the change, so no alert behaviour moved for anyone.
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
  ],
});

// DELIBERATELY UNMAPPED. These fall through to `unknown` (counted in the tender band, reported separately)
// rather than being guessed. Documented so a future reader knows the omission is a decision, not a gap.
//   sedum   — genus spans hardy stonecrop AND tender species; the two LIVE rows are Sedum adolphii (tender),
//             so a slug-level "hardy" guess would have been WRONG in prod today.
//   cactus / succulent — generic buckets; live rows are tender (Gymnocalycium, Graptosedum, Pachyphytum,
//             Echeveria agavoides) but hardy Opuntia/Sempervivum would share the same slug.
//   hibiscus — tropical (tender) and H. moscheutos (hardy) share the slug; live row is the tender
//             'Mahogany Splendor' (H. acetosella).
//   bay / rosemary — zone-8-ish woody herbs: they SURVIVE a first frost (so not "tender" in this feature's
//             sense) but are overwintered indoors here (so not "never alert" either). Marginal by nature.
//   artichoke — overwinter-marginal; not killed by first frost, not reliably hardy.
//   flower_mix — an unopened seed blend of unknown composition.
const UNCERTAIN_SLUGS = ['sedum', 'cactus', 'succulent', 'hibiscus', 'bay', 'rosemary', 'artichoke', 'flower_mix'];

const BAND_BY_SLUG = Object.freeze(Object.fromEntries(
  BAND_ORDER.flatMap((band) => SLUGS_BY_BAND[band].map((s) => [s, band])),
));

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
// The coalesced alert names CROP TYPES, not plantings — that is what keeps one SMS readable when 183
// plantings are at risk. Irregulars are listed; everything else falls through to the rule below.
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
// Unknown band names and non-numeric values THROW rather than silently keeping the default — a typo'd
// override that silently kept the default is exactly the failure this feature cannot afford (§3-7).
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
// `opts.cadenceTender` is the cold.tender signal from cadence-data-v2.json (§3-4 "plus cold.tender
// profiles"). It is a PROMOTION-ONLY input: it can lift an unknown into the tender band, but it can NEVER
// override an explicit slug classification. That precedence is load-bearing, not defensive —
// cadence-data-v2.json keys by VARIETY NAME, and by_variety['Peach'] is a PEPPER profile (crop: "pepper
// (likely Sugar Rush Peach)", cold.tender, protect_below_F 50) which collides with the live "Peach tree"
// planting whose variety name is also "Peach". Cadence-wins precedence would mark a mature peach tree
// tender at 50°F.
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

// D6 covered-exclusion: the daily-plan query resolves coverage from the planting's location
// (locations.type_label in (shelf,rack,tray) OR locations.name in (Stable,House)). 19 at-risk
// plantings live indoors today and would otherwise be named on every frost night for no action.
//
// BUG-NOLOCOUTDOOR-001: reads frost_covered_resolved (`state IS TRUE`) rather than the raw boolean.
// This consumer's fail-safe runs OPPOSITE to rain credit's: excluding a planting here SUPPRESSES its
// frost alert, so an unknown location must resolve to NOT covered — it keeps its seat in the alert
// and Dave gets told about it. Excluding it would be a freeze with no warning, which is the same
// principle handler.js already encodes for a missing tonight-low: silence must never be
// indistinguishable from safety.
function isCoveredDefault(p) {
  return !!(p && p.frost_covered_resolved === true);
}

// Classify a list of plantings and produce the exposure summary frostEval's copy consumes.
// Each planting is expected to carry { id, name, crop_type_slug, container_type, status, covered } — a
// superset of what the daily-plan query already selects, plus crop_type_slug via the plant_varieties join.
function summarize(plantings, opts = {}) {
  const rows = Array.isArray(plantings) ? plantings : [];
  const resolvedBands = opts.resolvedBands || resolveBandThresholds(opts.bandThresholds);
  const cadenceTenderFor = typeof opts.cadenceTenderFor === 'function' ? opts.cadenceTenderFor : () => false;
  const isCovered = typeof opts.isCovered === 'function' ? opts.isCovered
    : (opts.excludeCovered === false ? () => false : isCoveredDefault);
  const out = {
    tender: 0, hardy: 0, unknown: 0,
    tenderContainers: 0,
    tenderFruiting: 0,
    // At-risk == everything the alert names == tender + unknown (§3-4 unknown-counted-as-tender).
    atRisk: 0,
    tenderPlantings: [], unknownPlantings: [],
    unknownSlugs: [],
    // D6: named crop types, each carrying ITS OWN trip points. This is what makes one coalesced alert
    // possible — the message names ~10 crop types instead of ~183 plantings.
    byCropType: [],
    // D6: at-risk plantings suppressed because they are already under cover. Reported (never silent) so a
    // shrinking alert is explainable, but deliberately kept OUT of the SMS body to protect its length.
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
    // Covered plantings are excluded from every at-risk number AND from the named crop list (D6).
    // Done AFTER the hardy check so a covered kale is simply hardy, not double-counted.
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
        count: 0, containers: 0, fruiting: 0, names: [],
      };
      byType.set(key, g);
    }
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
  // Crop types: the most exposed first — most containers, then most plantings, then alphabetical so the
  // ordering is fully deterministic (a message that reshuffles between runs reads as a different alert).
  out.byCropType = [...byType.values()].sort((a, b) =>
    (b.containers - a.containers) || (b.count - a.count) || String(a.label).localeCompare(String(b.label)));
  return out;
}

module.exports = {
  frostClassForSlug, summarize, isContainer, isCoveredDefault, cropLabel,
  resolveBandThresholds,
  BAND_THRESHOLDS, BAND_BY_SLUG, SLUGS_BY_BAND, BAND_ORDER, UNKNOWN_BAND, TRIP_KEYS,
  CLASS_BY_SLUG, CLASS_BY_BAND, TENDER_SLUGS, HARDY_SLUGS, UNCERTAIN_SLUGS, CROP_LABELS,
};
