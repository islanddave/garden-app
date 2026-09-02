// DRG-SOWNOW-001 — sowEngine contract tests.
// Golden fixtures are the real dataset packets run through packetToVarietyCols
// into v_sow_candidates-shaped rows. Anchors: LF 2026-05-20, FF 2026-09-28,
// windowClosingDays 10; today = 2026-07-10 for the golden suite.
//
// NOTE — three horticulture-panel golden expectations disagree with a faithful
// implementation of the panel's own FINAL rules (documented per-case below and
// in the build report): Spinach Oceanside, Pea Cascadia, Radicchio Palla Rossa.
// Per build direction, the RULES win and the deviations are flagged.
import { describe, it, expect } from 'vitest';
import { packetToVarietyCols } from '../lib/parseSowProfile.js';
import {
  FROST_ANCHORS,
  OBSERVED_FIRST_FALL_FROST,
  FALL_SLOWDOWN_DAYS,
  FALL_GRACE_DAYS,
  bucketize,
  classifyClause,
  splitClauses,
  isSpringEstablishmentAllium,
  sowGoal,
  isArchivedForSeason,
  isDepleted,
  isInProcess,
  IN_PROCESS_STAGES,
  FALL_HARDY_CROPS,
} from '../lib/sowEngine.js';
// BUG-FROSTANCHORWRONG-001. Both imported ONLY to cross-check the measured anchor against surfaces
// derived independently of it: storageDeadlines.json holds the same site frost measurement (kept in
// lockstep below), and overwinter.js computes the 10-hour daylength wall from latitude alone, which
// is what bounds the hardy clamp from above. The engine itself imports neither.
import storageDeadlines from '../data/storageDeadlines.json';
import ow from '../../lambda/daily-plan/overwinter.js';
// Imported ONLY to pin the engine's local bunching predicate against the canonical derivation, so
// the two cannot silently diverge. The engine itself never imports from lambda/.
import { alliumType } from '../../lambda/varieties/crop-derive.js';
// Same reason, for V4-HARDYSET-001: frostClass.js's `hardy` band is the canonical "shrugs off frost"
// vocabulary and FALL_HARDY_CROPS must stay a subset of it.
import fc from '../../lambda/daily-plan/frostClass.js';

// Real packets from /tmp/seed-load-dataset-V1.json (garden.seed_load_dataset.v1),
// embedded verbatim so CI needs no dataset file.
const PACKETS = {
  biquinho: {"name": "Red and Yellow Blend Biquinho Chile Pepper Seeds", "crop": "Pepper, Chile", "variety": "Biquinho Red & Yellow Blend", "quantity_on_hand": 1, "vendor": "Botanical Interests", "source": "Botanical Interests online order; captured 2026-06-10 as official seed->plant pipeline seeding", "source_url": null, "purchase_date": "2026-06-09", "price_usd": 1.5, "sku": "0074", "metadata": {"seeds_per_packet": "1", "organic": false, "heirloom": false, "item_category": "vegetable"}, "crop_type_slug_guess": "pepper", "sow_profile": {"life_cycle": "tender perennial (grown as annual)", "season": "warm", "sun": "full sun", "start_method": "start indoors", "start_indoor_weeks_before_lastfrost": "8-10", "direct_sow_timing": null, "sow_depth_in": "0.25", "seed_spacing_in": "18", "row_spacing_in": "18-24", "days_to_germ": "10-21", "days_to_maturity": null, "zone_notes": "Start indoors mid-March; transplant after May 20 (valley). Long-season pepper — western MA's 120-day window is tight. Prioritize early indoor start and warm transplant site. Can be overwintered indoors as a container plant.", "packet_notes": "Capsicum chinense. Mild, only 1,000-2,000 Scoville units. Teardrop-shaped fruits 0.75-1.25\" ripen to red or golden yellow. Brazilian specialty pepper. Long season; needs warmth to produce well. Can overwinter indoors."}, "origin": "BI-order-2026-06-09"},
  californiaWonder: {"name": "California Wonder (Pepper, Sweet)", "crop": "Pepper, Sweet", "variety": "California Wonder", "quantity_on_hand": 1, "vendor": "Botanical Interests", "source": "Botanical Interests packet", "source_url": null, "purchase_date": null, "price_usd": null, "sku": null, "metadata": {"seeds_per_packet": null, "organic": null, "heirloom": null}, "crop_type_slug_guess": "pepper", "sow_profile": null, "origin": "physical-packet-photo-2026-06-05", "needs_confirmation": ["seed_count", "price", "acquired_date"]},
  blackKrim: {"name": "Black Krim Pole Tomato Seeds", "crop": "Tomato, Pole", "variety": "Black Krim", "quantity_on_hand": 1, "vendor": "Botanical Interests", "source": "Botanical Interests online order; captured 2026-06-10 as official seed->plant pipeline seeding", "source_url": null, "purchase_date": "2026-06-09", "price_usd": 1.5, "sku": "3118", "metadata": {"seeds_per_packet": "1", "organic": false, "heirloom": false, "item_category": "vegetable"}, "crop_type_slug_guess": "tomato", "sow_profile": {"life_cycle": "annual", "season": "warm", "sun": "full sun", "start_method": "start indoors", "start_indoor_weeks_before_lastfrost": "6-8", "direct_sow_timing": null, "sow_depth_in": "0.25", "seed_spacing_in": "24-36", "row_spacing_in": "36-48", "days_to_germ": "7-14", "days_to_maturity": "75-80", "zone_notes": "Start indoors early April (6-8 wks before May 20). Transplant after last frost, mid-to-late May in the valley; wait until early June for Conway hilltown. Indeterminate — stake or cage; keep supported through frost-free season.", "packet_notes": "Heirloom from Crimea. Indeterminate. Deep maroon-red flesh; rich, complex, slightly salty flavor. Medium-large beefsteak type. Prone to cracking in uneven watering. Excellent for slicing. Some green shoulders at maturity are normal."}, "origin": "BI-order-2026-06-09"},
  spinachOceanside: {"name": "Oceanside Spinach Seeds", "crop": "Spinach", "variety": "Oceanside", "quantity_on_hand": 1, "vendor": "Botanical Interests", "source": "Botanical Interests online order; captured 2026-06-10 as official seed->plant pipeline seeding", "source_url": null, "purchase_date": "2026-06-09", "price_usd": 1.75, "sku": "0081", "metadata": {"seeds_per_packet": "2", "organic": false, "heirloom": false, "item_category": "vegetable"}, "crop_type_slug_guess": "spinach", "sow_profile": {"life_cycle": "annual", "season": "cool", "sun": "full sun to part shade", "start_method": "direct sow", "start_indoor_weeks_before_lastfrost": null, "direct_sow_timing": "4-6 wks before last frost; succession every 2-3 wks; again in late Aug for fall crop", "sow_depth_in": "0.5", "seed_spacing_in": "4-6", "row_spacing_in": "12", "days_to_germ": "7-14", "days_to_maturity": "25-60", "zone_notes": "Direct sow outdoors around late Apr (South Deerfield) or early May (Conway hilltown); spinach tolerates light frost. Sow again late Aug for fall harvest before Oct 1 first frost.", "packet_notes": "Baby greens ready ~25 days; full leaves 40-60 days. Bolt-prone in heat — shade-cloth or cut-and-come-again extends season. Disease-resistant, easy-to-clean leaves."}, "origin": "BI-order-2026-06-09"},
  lettuceBSS: {"name": "Black Seeded Simpson Leaf Lettuce Seeds", "crop": "Lettuce, Leaf", "variety": "Black Seeded Simpson", "quantity_on_hand": 1, "vendor": "Botanical Interests", "source": "Botanical Interests online order; captured 2026-06-10 as official seed->plant pipeline seeding", "source_url": null, "purchase_date": "2026-06-09", "price_usd": 1.75, "sku": "3025", "metadata": {"seeds_per_packet": "1", "organic": false, "heirloom": false, "item_category": "vegetable"}, "crop_type_slug_guess": "lettuce", "sow_profile": {"life_cycle": "annual", "season": "cool", "sun": "full sun to part shade", "start_method": "both", "start_indoor_weeks_before_lastfrost": "4-6", "direct_sow_timing": "2-4 wks before last frost; succession sow every 2-3 wks; direct sow Aug for fall", "sow_depth_in": "0.125", "seed_spacing_in": "8-12", "row_spacing_in": "12", "days_to_germ": "5-10", "days_to_maturity": "45-50", "zone_notes": "One of the earliest lettuce varieties — direct sow late Apr in South Deerfield, early May in Conway. 45-50 day maturity gives multiple spring harvests before heat. Sow again late Aug for fall; harvests before Oct 1 frost. Classic open-pollinated variety since 1850.", "packet_notes": "Heirloom since 1850. Crinkled, light green frilly leaves; centers blanch almost white. Fast and reliable. Needs light to germinate — surface sow. Cut-and-come-again. Bolt-prone in heat — shade or pull when temps rise."}, "origin": "BI-order-2026-06-09"},
  hollyhockWatchman: {"name": "The Watchman Hollyhock Seeds", "crop": "Hollyhock", "variety": "The Watchman", "quantity_on_hand": 1, "vendor": "Botanical Interests", "source": "Botanical Interests online order; captured 2026-06-10 as official seed->plant pipeline seeding", "source_url": null, "purchase_date": "2026-06-09", "price_usd": 1.35, "sku": "1225", "metadata": {"seeds_per_packet": null, "organic": false, "heirloom": false, "item_category": "flower"}, "crop_type_slug_guess": null, "sow_profile": {"life_cycle": "biennial", "season": "cool/warm", "sun": "full sun", "start_method": "both", "start_indoor_weeks_before_lastfrost": "6-8", "direct_sow_timing": "after last frost or in summer for next-year bloom", "sow_depth_in": "0.125", "seed_spacing_in": "18-24", "row_spacing_in": "24-36", "days_to_germ": "10-14", "days_to_maturity": null, "zone_notes": "Biennial: start indoors in spring or direct sow in summer; plants establish first year, bloom second summer. Hardy to zone 2 — fully winter-hardy in Conway and South Deerfield. Plant in a sheltered spot for the tall 5–7' stalks.", "packet_notes": "Deep near-black burgundy flowers. Heirloom. Self-sows freely once established. Susceptible to hollyhock rust — avoid overhead watering. Excellent pollinator and hummingbird plant. Tall background or fence plant."}, "origin": "BI-order-2026-06-09"},
  columbineMcKana: {"name": "McKana Giants Blend Columbine Seeds", "crop": "Columbine", "variety": "McKana Giants Blend", "quantity_on_hand": 1, "vendor": "Botanical Interests", "source": "Botanical Interests online order; captured 2026-06-10 as official seed->plant pipeline seeding", "source_url": null, "purchase_date": "2026-06-09", "price_usd": 1.35, "sku": "1007", "metadata": {"seeds_per_packet": null, "organic": false, "heirloom": false, "item_category": "flower"}, "crop_type_slug_guess": null, "sow_profile": {"life_cycle": "perennial", "season": "cool/warm", "sun": "full sun to part shade", "start_method": "both", "start_indoor_weeks_before_lastfrost": "10-12", "direct_sow_timing": "fall sow for spring germination, or early spring when soil is cold", "sow_depth_in": "0.125", "seed_spacing_in": "18-24", "row_spacing_in": "24-36", "days_to_germ": "21-25", "days_to_maturity": null, "zone_notes": "Perennial; blooms spring of second year from a spring sowing. Start indoors February–March (10–12 wks before May 20) for possible first-year bloom. Cold stratification recommended — fall direct sow works well in western MA. AAS winner; vigorous and reliable.", "packet_notes": "AAS 1955 winner. Large 3\" bi-color flowers; tall 24–36\" plants. Cold stratification improves germination. Blooms spring to early summer. Hummingbird and pollinator magnet. Self-sows. Deer resistant."}, "origin": "BI-order-2026-06-09"},
  cucumberSpacemaster: {"name": "Spacemaster 80 Cucumber Seeds", "crop": "Cucumber", "variety": "Spacemaster 80", "quantity_on_hand": 1, "vendor": "Botanical Interests", "source": "Botanical Interests online order; captured 2026-06-10 as official seed->plant pipeline seeding", "source_url": null, "purchase_date": "2026-06-09", "price_usd": 1.35, "sku": "0020", "metadata": {"seeds_per_packet": "2", "organic": false, "heirloom": false, "item_category": "vegetable"}, "crop_type_slug_guess": "cucumber", "sow_profile": {"life_cycle": "annual", "season": "warm", "sun": "full sun", "start_method": "both", "start_indoor_weeks_before_lastfrost": "3-4", "direct_sow_timing": "after last frost when soil ≥60°F", "sow_depth_in": "0.5-1", "seed_spacing_in": "12", "row_spacing_in": "36-48", "days_to_germ": "7-10", "days_to_maturity": "62", "zone_notes": "Direct sow after May 20 once soil reaches 60°F, or start indoors 3–4 weeks before last frost. Compact bush/short-vine habit is ideal for small spaces and containers. 62-day DTM fits the ~120-day frost-free season comfortably.", "packet_notes": "Compact 2–3' vines — good for containers and small gardens. Disease resistant (CMV, downy/powdery mildew, scab). Bush-type, can be grown without a trellis. Keep picked for continued production."}, "origin": "BI-order-2026-06-09"},
  onionMonastrell: {"name": "Monastrell Bulb Onion Seeds", "crop": "Onion, Bulb", "variety": "Monastrell", "quantity_on_hand": 1, "vendor": "Botanical Interests", "source": "Botanical Interests online order; captured 2026-06-10 as official seed->plant pipeline seeding", "source_url": null, "purchase_date": "2026-06-09", "price_usd": 2.25, "sku": "3790", "metadata": {"seeds_per_packet": null, "organic": false, "heirloom": false, "item_category": "vegetable"}, "crop_type_slug_guess": "onion", "sow_profile": {"life_cycle": "biennial", "season": "cool", "sun": "full sun", "start_method": "both", "start_indoor_weeks_before_lastfrost": "10-12", "direct_sow_timing": "8-10 wks before last frost when soil ≥50°F", "sow_depth_in": "0.25", "seed_spacing_in": "4-6", "row_spacing_in": "12", "days_to_germ": "7-14", "days_to_maturity": "110", "zone_notes": "Start indoors early February (10–12 wks before May 20) for transplant in April–May. Intermediate-day variety — bulbs with 12–14 hr days, suitable for western MA. Harvest late summer when tops fall over; cure well for 4–6 month storage.", "packet_notes": "Intermediate-day F1 hybrid — works in zone 5b–6a unlike long-day types. Dark red uniform 3.5\"–4\" bulbs with 4–6 month storage life. Keep seedlings trimmed to 3\" indoors to develop strong plants. Cure thoroughly before storage."}, "origin": "BI-order-2026-06-09"},
  broccoliBelstar: {"name": "Belstar Broccoli Seeds", "crop": "Broccoli", "variety": "Belstar", "quantity_on_hand": 1, "vendor": "Botanical Interests", "source": "Botanical Interests online order; captured 2026-06-10 as official seed->plant pipeline seeding", "source_url": null, "purchase_date": "2026-06-09", "price_usd": 2.25, "sku": "3181", "metadata": {"seeds_per_packet": "1", "organic": false, "heirloom": false, "item_category": "vegetable"}, "crop_type_slug_guess": "broccoli", "sow_profile": {"life_cycle": "annual", "season": "cool", "sun": "full sun", "start_method": "both", "start_indoor_weeks_before_lastfrost": "4-6", "direct_sow_timing": "4-6 wks before last frost for spring; late June–July for fall crop", "sow_depth_in": "0.25", "seed_spacing_in": "18", "row_spacing_in": "24", "days_to_germ": "5-10", "days_to_maturity": "66", "zone_notes": "Start indoors early–mid April for May transplant after last frost. For fall crop, start indoors late June and transplant in late July. Belstar is well-suited to cool western MA conditions; secondary side shoots extend harvest.", "packet_notes": "F1 hybrid organic. Days to maturity from transplant. Produces large central head plus abundant side shoots. Heat-tolerant for broccoli. Excellent for fall cropping as quality improves in cool weather."}, "origin": "BI-order-2026-06-09"},
  peaCascadia: {"name": "Cascadia Snap Pea Seeds", "crop": "Pea, Snap", "variety": "Cascadia", "quantity_on_hand": 1, "vendor": "Botanical Interests", "source": "Botanical Interests online order; captured 2026-06-10 as official seed->plant pipeline seeding", "source_url": null, "purchase_date": "2026-06-09", "price_usd": 1.75, "sku": "3218", "metadata": {"seeds_per_packet": "15", "organic": false, "heirloom": false, "item_category": "vegetable"}, "crop_type_slug_guess": "other", "sow_profile": {"life_cycle": "annual", "season": "cool", "sun": "full sun", "start_method": "direct sow", "start_indoor_weeks_before_lastfrost": null, "direct_sow_timing": "4-6 wks before last frost when soil ≥40°F; succession sow again 10-12 wks before first fall frost", "sow_depth_in": "1", "seed_spacing_in": "2-3", "row_spacing_in": "18-24", "days_to_germ": "7-14", "days_to_maturity": "58", "zone_notes": "Direct sow around mid-Apr in South Deerfield (soil permitting), late Apr in Conway hilltown. 58-day maturity fits comfortably before summer heat sets in. Second sowing ~late Jul for fall crop.", "packet_notes": "Short 30\" self-supporting vines — minimal staking. Stringless, 3\" pods produced two per cluster. Resistant to pea enation mosaic virus and powdery mildew. Direct sow only — dislikes transplant."}, "origin": "BI-order-2026-06-09"},
  radicchioPallaRossa: {"name": "Palla Rossa Mavrik Radicchio Seeds", "crop": "Radicchio", "variety": "Palla Rossa Mavrik", "quantity_on_hand": 1, "vendor": "Botanical Interests", "source": "Botanical Interests online order; captured 2026-06-10 as official seed->plant pipeline seeding", "source_url": null, "purchase_date": "2026-06-09", "price_usd": 1.35, "sku": "3119", "metadata": {"seeds_per_packet": null, "organic": false, "heirloom": false, "item_category": "vegetable"}, "crop_type_slug_guess": "radicchio", "sow_profile": {"life_cycle": "biennial", "season": "cool", "sun": "full sun", "start_method": "both", "start_indoor_weeks_before_lastfrost": "8-10", "direct_sow_timing": "8-10 weeks before first fall frost (late June to early July for Oct 1 target)", "sow_depth_in": "0.25", "seed_spacing_in": "8-10", "row_spacing_in": "12", "days_to_germ": "5-15", "days_to_maturity": "80-95", "zone_notes": "Primarily a fall crop: start indoors or direct sow in late June–early July so heads mature as temps cool in September. Cool temps trigger head formation and reduce bitterness. Spring starts often bolt. Harvest before hard freeze in zone 5b.", "packet_notes": "Chioggia-type radicchio; will not head properly without cool fall temperatures. Bitter flavor mellows when cooked. Biennial grown as annual. Frost tolerant."}, "origin": "BI-order-2026-06-09"},
};

const TODAY = '2026-07-10';

const NUMERIC_FIELDS = [
  'quantity_on_hand', 'days_to_maturity_min', 'days_to_maturity_max',
  'start_indoor_weeks_min', 'start_indoor_weeks_max', 'sow_depth_in',
  'seed_spacing_in', 'row_spacing_in', 'days_to_germ_min', 'days_to_germ_max',
];

let seq = 0;
function toCandidate(packet, { stringifyNumerics = false, ...overrides } = {}) {
  const v = packetToVarietyCols(packet);
  seq += 1;
  const candidate = {
    inventory_item_id: `inv-${seq}`,
    item_name: packet.name,
    quantity_on_hand: packet.quantity_on_hand ?? 1,
    variety_id: `var-${seq}`,
    variety_name: v.name,
    crop_type_slug: v.crop_type_slug ?? null,
    lifecycle: v.lifecycle,
    grown_as: v.grown_as,
    sun_requirements: v.sun_requirements,
    days_to_maturity_min: v.days_to_maturity_min,
    days_to_maturity_max: v.days_to_maturity_max,
    start_method: v.start_method,
    start_indoor_weeks_min: v.start_indoor_weeks_min,
    start_indoor_weeks_max: v.start_indoor_weeks_max,
    direct_sow_timing: v.direct_sow_timing,
    sow_depth_in: v.sow_depth_in,
    seed_spacing_in: v.seed_spacing_in,
    row_spacing_in: v.row_spacing_in,
    days_to_germ_min: v.days_to_germ_min,
    days_to_germ_max: v.days_to_germ_max,
    sow_season: v.sow_season,
    sow_notes: v.sow_notes,
    ...overrides,
  };
  if (stringifyNumerics) {
    // The neon driver returns numerics as strings — prove Number() coercion.
    for (const field of NUMERIC_FIELDS) {
      if (candidate[field] != null) candidate[field] = String(candidate[field]);
    }
  }
  return candidate;
}

function synth(overrides = {}) {
  return toCandidate(
    { name: 'Synthetic packet', variety: 'Synthetic', sow_profile: null },
    {
      lifecycle: 'annual', grown_as: null, sow_season: null,
      sun_requirements: 'full_sun', ...overrides,
    },
  );
}

/** Locate a candidate's bucket + entry across all buckets. */
function locate(buckets, varietyName) {
  for (const [bucket, entries] of Object.entries(buckets)) {
    const entry = entries.find((e) => e.candidate.variety_name === varietyName);
    if (entry) return { bucket, entry };
  }
  return { bucket: null, entry: null };
}

function run(candidate, today = TODAY, anchors) {
  return locate(bucketize([candidate], today, anchors), candidate.variety_name);
}

describe('exports', () => {
  it('exposes the panel FROST_ANCHORS and fall constants', () => {
    expect(FROST_ANCHORS).toEqual({
      lastSpringFrost: '05-20',
      firstFallFrost: '09-28',
      windowClosingDays: 10,
    });
    expect(FALL_SLOWDOWN_DAYS).toBe(14);
    expect(FALL_GRACE_DAYS).toEqual({ cool: 28, cool_warm: 14 });
  });

  // Every key bucketOne can return must be pre-seeded here — a missing key makes
  // buckets[bucket].push() throw, which propagates out of SowNow's useMemo and white-screens /sow.
  // Every key bucketOne can return MUST be pre-seeded here — `buckets[bucket].push(entry)` throws
  // on a missing one, which propagates out of SowNow's useMemo and white-screens /sow. `archived`
  // added by V4-SOWARCHIVE-001 (9th), `sowed_previously` by V4-SEEDZEROVIEW-001 (10th),
  // `in_process` by V4-SEEDSAVEFLOW-001 (11th).
  it('bucketize returns all eleven buckets even for empty input', () => {
    expect(Object.keys(bucketize([], TODAY)).sort()).toEqual([
      'archived', 'direct_sow_now', 'hold', 'in_process', 'needs_profile', 'sow_inside_anytime',
      'sow_next_year', 'sowed_previously', 'start_indoors_now', 'too_late', 'window_closing',
    ]);
  });
});

describe('splitClauses', () => {
  it('splits on ";" and " or " (case-insensitive), trimming punctuation', () => {
    expect(splitClauses(
      '4-6 wks before last frost OR direct sow in midsummer for fall crop',
    )).toEqual(['4-6 wks before last frost', 'direct sow in midsummer for fall crop']);
    expect(splitClauses(
      'fall sow for spring germination, or early spring when soil is cold',
    )).toEqual(['fall sow for spring germination', 'early spring when soil is cold']);
    expect(splitClauses(
      '2-4 wks before last frost; succession sow every 2-3 wks; direct sow Aug for fall',
    )).toHaveLength(3);
    expect(splitClauses(null)).toEqual([]);
  });
});

describe('classifyClause — classes A-L against real dataset strings', () => {
  it.each([
    // [clause, class]
    ['2-4 wks before last frost', 'A'],
    ['8-10 wks before last frost when soil ≥50°F', 'A'],
    ['2–4 wks before last frost when soil can be worked', 'A'], // en dash; A wins over C
    ['2-3 wks before last frost', 'A'],
    ['after last frost when soil is warm', 'B'],
    ['1-2 wks after last frost when soil ≥65°F', 'B'],
    ['1–2 wks after last frost', 'B'],
    ['after last frost in Year 1', 'B'],
    ['after last frost in zone 5b-6a', 'B'],
    ['as soon as soil can be worked in spring', 'C'],
    ['succession sow every 2-3 wks', 'D'],
    ['succession every 3 wks through early summer', 'D'],
    ['succession sow again 10-12 wks before first fall frost', 'E'], // E beats D
    ['8-10 weeks before first fall frost (late June to early July for Oct 1 target)', 'E'],
    ['again in late summer 8-10 wks before first frost', 'E'], // E beats F
    ['again in late Aug for fall crop', 'F'],
    ['direct sow Aug for fall', 'F'],
    ['direct sow in midsummer for fall crop', 'F'],
    ['late June–July for fall crop', 'F'],
    ['late summer for fall crop', 'F'],
    ['again in Aug-Sep for fall', 'F'],
    ['fall sow for spring germination', 'G'],
    ['fall sow for early spring bloom', 'G'],
    // Hyphenated separator: real Edelweiss copy. Matched nothing before the fall[-\s]sow widen.
    ['Early spring outdoors, letting natural freeze-thaw cycles stratify the seed; or fall-sow for spring germination', 'G'],
    // ...but the "for (early) spring germination|bloom" tail is still REQUIRED. Real Althaea copy
    // offers fall-sowing only as an alternate to a spring primary, so it must NOT become class G
    // (that would surface a spring-primary packet as a fall-only recommendation).
    ['Direct sow in very early spring as soon as soil is workable, or fall-sow to let winter cold stratify the seed (a good Zone 5b option).', null],
    ['in summer for next-year bloom', 'H'],
    ['mid-summer for blooming next spring', 'H'], // H beats F
    ['grow indoors year-round', 'J'],
    ['self-seeds freely once established', 'L'],
    ['self-sows freely', 'L'],
    ['early spring when soil is cold', null], // unclassifiable -> ignored
  ])('%j -> class %j', (clause, cls) => {
    expect(classifyClause(clause).cls).toBe(cls);
  });

  it('parses weeks precisely for classes A/B/E', () => {
    expect(classifyClause('succession sow again 10-12 wks before first fall frost'))
      .toMatchObject({ cls: 'E', weeksMin: 10, weeksMax: 12 });
    expect(classifyClause('8-10 weeks before first fall frost (late June to early July for Oct 1 target)'))
      .toMatchObject({ cls: 'E', weeksMin: 8, weeksMax: 10 });
    expect(classifyClause('4-6 wks before last frost for spring'))
      .toMatchObject({ cls: 'A', weeksMin: 4, weeksMax: 6 });
    expect(classifyClause('1-2 weeks after last frost when soil 70-80°F'))
      .toMatchObject({ cls: 'B', weeksMin: 1, weeksMax: 2, soilTempF: 70 });
  });

  it('extracts class I soil-temp modifiers and class K zone flags', () => {
    expect(classifyClause('after last frost when soil ≥60°F').soilTempF).toBe(60);
    expect(classifyClause('4-6 wks before last frost when soil ≥40°F').soilTempF).toBe(40);
    expect(classifyClause('1-2 wks after last frost when soil ≥65°F, ideally 70-85°F').soilTempF).toBe(65);
    expect(classifyClause('after last frost when soil is warm').soilTempF).toBeUndefined();
    expect(classifyClause('after last frost in zone 5b-6a').zone5b6a).toBe(true);
    expect(classifyClause('2-4 wks before last frost (mild climates)').mildClimates).toBe(true);
  });

  it('collects month windows for class F', () => {
    expect(classifyClause('again in late Aug for fall crop').monthWindows).toEqual([['08-15', '08-31']]);
    expect(classifyClause('direct sow Aug for fall').monthWindows).toEqual([['08-01', '08-31']]);
    expect(classifyClause('again in Aug-Sep for fall').monthWindows).toEqual([['08-01', '09-15']]);
    expect(classifyClause('late June–July for fall crop').monthWindows).toEqual([['06-20', '06-30']]);
  });
});

describe('window math boundaries (synthetic candidates)', () => {
  const indoor68 = () => synth({
    start_method: 'start_indoors', start_indoor_weeks_min: 6, start_indoor_weeks_max: 8,
    sow_season: 'warm',
  });
  // Spring indoor window for 6-8 wks: [LF-56d, LF-42d] = [Mar 25, Apr 8]

  it('day before spring indoor window opens -> hold with reopensOn', () => {
    const { bucket, entry } = run(indoor68(), '2026-03-24');
    expect(bucket).toBe('hold');
    expect(entry.reopensOn).toBe('2026-03-25');
    expect(entry.action).toBe('start_indoors');
  });

  it('day-of exact open -> start_indoors_now', () => {
    const { bucket, entry } = run(indoor68(), '2026-03-25');
    expect(bucket).toBe('start_indoors_now');
    expect(entry.daysLeft).toBe(14);
    expect(entry.action).toBe('start_indoors');
  });

  it('day-of exact close -> window_closing with daysLeft 0 (action label kept)', () => {
    const { bucket, entry } = run(indoor68(), '2026-04-08');
    expect(bucket).toBe('window_closing');
    expect(entry.daysLeft).toBe(0);
    expect(entry.action).toBe('start_indoors');
  });

  it('day after close (warm season, no fall pass) -> too_late', () => {
    const { bucket, entry } = run(indoor68(), '2026-04-09');
    expect(bucket).toBe('too_late');
    expect(entry.action).toBeNull();
  });

  it('window_closing threshold: daysLeft 10 closes, 11 stays open', () => {
    // warm annual, 'after last frost' close = FF - dtm - 14
    const at = (dtm) => run(synth({
      start_method: 'direct_sow', direct_sow_timing: 'after last frost',
      sow_season: 'warm', days_to_maturity_max: dtm,
    }));
    const ten = at(56); // close Jul 20 -> daysLeft 10
    expect(ten.bucket).toBe('window_closing');
    expect(ten.entry.daysLeft).toBe(10);
    expect(ten.entry.action).toBe('direct_sow');
    const eleven = at(55); // close Jul 21 -> daysLeft 11
    expect(eleven.bucket).toBe('direct_sow_now');
    expect(eleven.entry.daysLeft).toBe(11);
  });

  describe('fall indoor pass grace by season (weeks 4-6, dtm 66)', () => {
    const fall = (season) => synth({
      start_method: 'both', start_indoor_weeks_min: 4, start_indoor_weeks_max: 6,
      days_to_maturity_max: 66, sow_season: season,
    });

    it('cool: grace 28 -> window Jul 10-Aug 7, opens day-of today', () => {
      const { bucket, entry } = run(fall('cool'));
      expect(bucket).toBe('start_indoors_now');
      expect(entry.daysLeft).toBe(28);
      expect(entry.windowLabel).toContain('Aug 7');
    });

    it('cool_warm: grace 14 -> window Jun 26-Jul 24', () => {
      const { bucket, entry } = run(fall('cool_warm'));
      expect(bucket).toBe('start_indoors_now');
      expect(entry.daysLeft).toBe(14);
    });

    it('warm: no fall pass -> too_late', () => {
      expect(run(fall('warm')).bucket).toBe('too_late');
    });

    it('null dtm skips fall math entirely', () => {
      const c = fall('cool');
      c.days_to_maturity_max = null;
      expect(run(c).bucket).toBe('too_late');
    });

    it('before the fall window opens -> hold with reopensOn', () => {
      const { bucket, entry } = run(fall('cool'), '2026-06-01');
      expect(bucket).toBe('hold');
      expect(entry.reopensOn).toBe('2026-07-10');
      expect(entry.action).toBe('start_indoors');
    });
  });

  it('class I soil-temp floor: >=60F clamps open to Jun 1, >=70F to Jun 10', () => {
    const sixty = run(synth({
      start_method: 'direct_sow', direct_sow_timing: 'after last frost when soil ≥60°F',
      sow_season: 'warm', days_to_maturity_max: 62,
    }), '2026-05-25');
    expect(sixty.bucket).toBe('hold');
    expect(sixty.entry.reopensOn).toBe('2026-06-01');
    const seventy = run(synth({
      start_method: 'direct_sow', direct_sow_timing: 'after last frost when soil ≥70°F',
      sow_season: 'warm', days_to_maturity_max: 62,
    }), '2026-06-05');
    expect(seventy.bucket).toBe('hold');
    expect(seventy.entry.reopensOn).toBe('2026-06-10');
  });

  it('class K keeps the zone 5b-6a clause and drops the mild-climates clause', () => {
    const timing = '2-4 wks before last frost (mild climates); after last frost in zone 5b-6a';
    const zoned = run(synth({
      start_method: 'direct_sow', direct_sow_timing: timing,
      sow_season: 'warm', days_to_maturity_max: 60,
    }), '2026-04-25');
    // Apr 25 is inside the mild-climates A window [Apr 22, May 6] — dropped.
    expect(zoned.bucket).toBe('hold');
    expect(zoned.entry.reopensOn).toBe('2026-05-20');
    const mildOnly = run(synth({
      start_method: 'direct_sow',
      direct_sow_timing: '2-4 wks before last frost (mild climates)',
      sow_season: 'warm', days_to_maturity_max: 60,
    }), '2026-04-25');
    expect(mildOnly.bucket).toBe('direct_sow_now');
  });

  it('class L self-sows clauses produce no window', () => {
    const { bucket } = run(synth({
      start_method: 'direct_sow',
      direct_sow_timing: 'self-seeds freely once established',
      sow_season: 'warm', days_to_maturity_max: 60,
    }), '2026-12-01');
    expect(bucket).toBe('too_late');
  });

  describe('class J / indoors_only -> sow_inside_anytime', () => {
    const jCandidate = () => synth({
      start_method: 'both',
      direct_sow_timing:
        'as soon as soil can be worked in spring; succession sow every 2-3 wks; or grow indoors year-round',
      sow_season: 'cool', days_to_maturity_max: 30,
    });

    it('J overlay applies when no actionable window is open', () => {
      const { bucket, entry } = run(jCandidate(), '2026-12-01');
      expect(bucket).toBe('sow_inside_anytime');
      expect(entry.action).toBe('sow_inside');
    });

    it('an open actionable window beats the J overlay', () => {
      expect(run(jCandidate(), '2026-04-10').bucket).toBe('direct_sow_now');
    });

    it('start_method indoors_only is always sowable inside', () => {
      const { bucket } = run(synth({ start_method: 'indoors_only' }), '2026-12-01');
      expect(bucket).toBe('sow_inside_anytime');
    });
  });

  it('start_method null with a direct_sow_timing is NOT needs_profile', () => {
    const { bucket } = run(synth({
      start_method: null, direct_sow_timing: 'after last frost',
      sow_season: 'warm', days_to_maturity_max: 50,
    }));
    expect(bucket).toBe('direct_sow_now');
  });

  it('anchors override merges over FROST_ANCHORS', () => {
    const cuke = toCandidate(PACKETS.cucumberSpacemaster);
    // Default FF 09-28: close Jul 14 -> window_closing. FF 10-05: close Jul 21.
    const moved = run(cuke, TODAY, { firstFallFrost: '10-05' });
    expect(moved.bucket).toBe('direct_sow_now');
    expect(moved.entry.daysLeft).toBe(11);
  });

  it('coerces numeric-as-string candidate fields (neon driver shape)', () => {
    const stringy = toCandidate(PACKETS.cucumberSpacemaster, { stringifyNumerics: true });
    expect(typeof stringy.days_to_maturity_max).toBe('string');
    const { bucket, entry } = run(stringy);
    expect(bucket).toBe('window_closing');
    expect(entry.daysLeft).toBe(4);
  });
});

describe('GOLDEN suite — real packets, today 2026-07-10', () => {
  const golden = () => bucketize([
    toCandidate(PACKETS.biquinho),
    toCandidate(PACKETS.californiaWonder),
    toCandidate(PACKETS.blackKrim),
    toCandidate(PACKETS.spinachOceanside),
    toCandidate(PACKETS.lettuceBSS, { stringifyNumerics: true }),
    toCandidate(PACKETS.hollyhockWatchman),
    toCandidate(PACKETS.columbineMcKana),
    toCandidate(PACKETS.cucumberSpacemaster),
    toCandidate(PACKETS.onionMonastrell, { stringifyNumerics: true }),
    toCandidate(PACKETS.broccoliBelstar, { stringifyNumerics: true }),
    toCandidate(PACKETS.peaCascadia),
    toCandidate(PACKETS.radicchioPallaRossa),
  ], TODAY);

  it('Chile Biquinho pepper -> too_late (indoor window closed Mar 25, warm = no fall pass)', () => {
    expect(locate(golden(), 'Biquinho Red & Yellow Blend').bucket).toBe('too_late');
  });

  it('null-profile pepper (Sweet California Wonder) -> needs_profile', () => {
    const { bucket, entry } = locate(golden(), 'California Wonder');
    expect(bucket).toBe('needs_profile');
    expect(entry.action).toBeNull();
  });

  it('Black Krim tomato -> too_late', () => {
    expect(locate(golden(), 'Black Krim').bucket).toBe('too_late');
  });

  // PANEL GOLDEN DEVIATION: panel expected hold(reopen ~Aug 20). The panel's
  // own class-D rule ("succession -> open until latest_safe") keeps the
  // spring window open through latest_safe, so Jul 10 is an open direct window.
  // Rules win per build direction.
  //
  // REBASELINED BY V4-HARDYSET-001, and this is the defect landing, not a golden moved to match new
  // output. Spinach is one of the crops the prose test MISSED: its packet says "spinach tolerates
  // light frost", which HARDY_RE does not match, so it took the 14d grace (Aug 13) while radish took
  // 28d on the strength of a different copywriter. Spinach is hardier than radish. It now takes the
  // hardy clamp by crop type.
  //
  // REBASELINED AGAIN BY BUG-FROSTANCHORWRONG-001, +3d: the hardy clamp was FF + 28 - 60 = Aug 27,
  // where FF is the sowing-safety margin and the 28 was an underived constant copied from
  // FALL_GRACE_DAYS.cool. It is now FFobs - 60 = Aug 30, FFobs being the MEASURED median first
  // <=32F night (10-29). Small in days, but the number is now derived from a measurement instead of
  // being the product of two errors that happened to nearly cancel.
  it('Spinach Oceanside -> direct_sow_now via class D (rules) [golden said hold ~Aug 20]', () => {
    const { bucket, entry } = locate(golden(), 'Oceanside');
    expect(bucket).toBe('direct_sow_now');
    expect(entry.daysLeft).toBe(51); // open until Aug 30 = FFobs (10-29) - 60
  });

  // REBASELINED BY V4-HARDYSET-001, same cause as spinach above: lettuce carries no frost prose at
  // all and lost 14 days to that (was Aug 23, then Sep 6). REBASELINED AGAIN BY
  // BUG-FROSTANCHORWRONG-001 for the same reason as spinach: FFobs (10-29) - 50 = Sep 9.
  it('Lettuce Black Seeded Simpson -> direct_sow_now (class D through Sep 9)', () => {
    const { bucket, entry } = locate(golden(), 'Black Seeded Simpson');
    expect(bucket).toBe('direct_sow_now');
    expect(entry.daysLeft).toBe(61);
    expect(entry.action).toBe('direct_sow');
  });

  // REBASELINED BY BUG-SOWNONANNUAL-001, and this is the fix landing, not a golden being quietly
  // moved to match new output. Previously direct_sow_now: hollyhock's class-B clause got NO
  // season-length clamp (latestSafeMs returned null for every non-annual) and its close fell back
  // to the raw ctx.FF, so the card read "Direct sow through Sep 28" — the reported bug. The Watchman
  // is a biennial that will not flower until next June; a late-July sow is FOR NEXT YEAR, so
  // sow_next_year is the honest bucket and the establishment clamp closes it Aug 24, not Sep 28.
  it('Hollyhock The Watchman -> sow_next_year (biennial, establishment clamp)', () => {
    const { bucket, entry } = locate(golden(), 'The Watchman');
    expect(bucket).toBe('sow_next_year');
    expect(entry.action).toBe('direct_sow');
  });

  it('Columbine McKana -> hold, reopens Sep 15 (class G), never too_late', () => {
    const { bucket, entry } = locate(golden(), 'McKana Giants Blend');
    expect(bucket).toBe('hold');
    expect(entry.reopensOn).toBe('2026-09-15');
    // NEVER too_late: even after the fall window has passed it rolls forward.
    const late = run(toCandidate(PACKETS.columbineMcKana), '2026-12-01');
    expect(late.bucket).toBe('hold');
    expect(late.entry.reopensOn).toBe('2027-09-15');
  });

  it('Cucumber Spacemaster 80 -> window_closing (latest Jul 14, 4 days)', () => {
    const { bucket, entry } = locate(golden(), 'Spacemaster 80');
    expect(bucket).toBe('window_closing');
    expect(entry.daysLeft).toBe(4);
    expect(entry.action).toBe('direct_sow');
    expect(entry.windowLabel).toContain('Jul 14');
    expect(entry.windowLabel).toContain('60°F'); // class I advisory chip
  });

  // V4-SOWNOW-PHOTOPERIOD-001 INTENDED CHANGE (was too_late). Monastrell is a bulbing onion, so
  // the allium gate keeps only its class-A spring window; past that it rolls to next year's indoor
  // start rather than dead-ending in too_late. This golden fixture also exercises the column-absent
  // fail-safe: packetToVarietyCols emits no growth_habit, so the gate falls back to crop_type_slug
  // and still gates — the same path a deploy that lands ahead of the view-widen would take.
  it('Onion Monastrell -> hold, gated bulber rolls to next Feb indoor start (was too_late)', () => {
    const { bucket, entry } = locate(golden(), 'Monastrell');
    expect(bucket).toBe('hold');
    expect(entry.gated).toBe(true);
    expect(entry.gateReason).toMatch(/spring start/i);
    expect(entry.reopensOn).toBe('2027-02-25');
    expect(entry.action).toBe('start_indoors');
    expect(entry.windowLabel).toContain('2027');
  });

  // REBASELINED BY V4-FALLINDOORHARDY-001, and this is the golden sitting exactly ON the old
  // boundary rather than a bucket regression. Broccoli is a FALL_HARDY_CROPS slug, so its fall
  // indoor pass moved from FF + 28 - 66 - 14 = Aug 7 to FFobs - 66 - 14 = Aug 10 — the same +3d the
  // direct branch took under BUG-FROSTANCHORWRONG-001, from the same cause (a 31-day-early anchor
  // and an underived 28 that nearly cancelled). The window is 28 days wide, so BOTH ends shift +3:
  // it opened Jul 10 (this golden's `today`, per the old test name) and now opens Jul 13. The packet
  // is not less sowable — it has 3 more days at the far end, and 3 fewer at the near end.
  it('Broccoli Belstar -> hold, fall pass now opens Jul 13 (was open day-of Jul 10)', () => {
    const { bucket, entry } = locate(golden(), 'Belstar');
    expect(bucket).toBe('hold');
    expect(entry.action).toBe('start_indoors');
    expect(entry.reopensOn).toBe('2026-07-13');
  });

  // PANEL GOLDEN DEVIATION: panel expected direct_sow_now with class E window
  // "Jul 8-22" — that arithmetic used FF ~Sep 30/Oct 1. Against the specified
  // 09-28 anchor, class E = [Jul 6, Jul 20], daysLeft 10 <= windowClosingDays,
  // so the open window moves to window_closing (action label kept).
  it('Pea Cascadia -> window_closing at daysLeft 10 (rules) [golden said direct_sow_now]', () => {
    const { bucket, entry } = locate(golden(), 'Cascadia');
    expect(bucket).toBe('window_closing');
    expect(entry.daysLeft).toBe(10);
    expect(entry.action).toBe('direct_sow');
    expect(entry.windowLabel).toContain('Jul 20');
  });

  // PANEL GOLDEN DEVIATION: panel expected window_closing. Under the rules the fall indoor pass
  // closed Jul 9 (FF+28-95-14) and the class E direct window [FF-10w, FF-8w] = [Jul 20, Aug 3]
  // (close clamped to Jul 23 by the cool-hardy latest_safe) had not opened yet -> hold, reopens
  // Jul 20.
  //
  // REBASELINED BY V4-FALLINDOORHARDY-001 — and this one lands back ON the panel's original call.
  // Radicchio is a FALL_HARDY_CROPS slug, so its fall indoor pass moved to FFobs - 95 - 14 = Jul 12.
  // It closed Jul 9 (three days before `today`) and now closes Jul 12 (two days after), so the
  // packet is INSIDE its indoor window on Jul 10 instead of past it, at daysLeft 2 <=
  // windowClosingDays -> window_closing. The bucket the panel expected all along; the deviation note
  // above stays because the ARITHMETIC still differs from theirs, it is only the verdict that agrees.
  it('Radicchio Palla Rossa -> window_closing, fall pass now closes Jul 12 [matches the panel again]', () => {
    const { bucket, entry } = locate(golden(), 'Palla Rossa Mavrik');
    expect(bucket).toBe('window_closing');
    expect(entry.daysLeft).toBe(2);
    expect(entry.action).toBe('start_indoors');
    expect(entry.windowLabel).toContain('Jul 12');
  });

  it('spreads the twelve packets across six buckets with no leftovers', () => {
    const buckets = golden();
    const counts = Object.fromEntries(
      Object.entries(buckets).map(([k, v]) => [k, v.length]),
    );
    // BUG-SOWNONANNUAL-001 INTENDED DELTA, and the ONLY delta this round: hollyhock moved
    // direct_sow_now -> sow_next_year (3->2 and 0->1).
    // The previous note here said hollyhock "deliberately does NOT move" because its class-B
    // this-season clause outranks its class-H next-year window. That reasoning held only because
    // the class-B clause was UNCLAMPED — latestSafeMs returned null for every non-annual and the
    // close fell back to the raw ctx.FF. The class-B window was the bug, so the thing that was
    // outranking the next-year window was itself wrong. With the establishment clamp the same
    // clause closes Aug 24 and carries horizon=next_year, and the bucket follows the horticulture.
    // Prior delta, still standing: V4-SOWNOW-PHOTOPERIOD-001 moved onion Monastrell too_late -> hold.
    // V4-FALLINDOORHARDY-001 DELTA: exactly two packets swapped places, both fall-hardy cool crops
    // whose indoor pass shifted +3d and whose window boundary straddles this golden's `today`.
    // Broccoli start_indoors_now -> hold (opens Jul 13, was Jul 10) and radicchio hold ->
    // window_closing (closes Jul 12, was Jul 9). Net totals move by one each way; nothing else in
    // the twelve moved, which is the evidence the re-key touched only the fall indoor pass and only
    // for hardy slugs. Any movement BEYOND those two is an unintended regression, not a rebaseline.
    expect(counts).toEqual({
      start_indoors_now: 0,
      direct_sow_now: 2,    // spinach, lettuce
      sow_inside_anytime: 0,
      sow_next_year: 1,     // hollyhock (biennial: sown now, blooms next June)
      window_closing: 3,    // cucumber, pea, radicchio
      hold: 3,              // columbine, onion (gated bulber), broccoli
      too_late: 2,          // biquinho, black krim
      needs_profile: 1,     // california wonder
      // V4-SOWARCHIVE-001: no golden packet carries sow_archived_season, so this stays 0. That it
      // is 0 while every other count is UNCHANGED is the evidence the archive path is purely
      // additive — it diverts packets, it does not re-bucket them.
      archived: 0,
      // V4-SEEDZEROVIEW-001: same evidence, same reason — every golden packet carries
      // quantity_on_hand 1, so nothing is depleted and every other count above is UNCHANGED.
      sowed_previously: 0,
      // V4-SEEDSAVEFLOW-001: third time, same evidence. No golden packet carries seed_stage (they
      // are bought packets, which is what NULL means), so nothing diverts and the eight counts
      // above are UNCHANGED — the in-process guard is additive, not a re-bucketing.
      in_process: 0,
    });
  });
});

// ── V4-SOWNOW-PHOTOPERIOD-001 — allium viability gate + next-year horizon ────────
// Every fixture below is a v_sow_candidates-shaped row built from LIVE prod field values
// (audit 2026-07-24), not from a packet — packetToVarietyCols cannot emit growth_habit.

const GATE_DAY = '2026-07-24'; // the day /sow recommended Flat of Italy, i.e. the reported bug

function viewRow(over = {}) {
  return {
    inventory_item_id: `gate-${(seq += 1)}`,
    item_name: over.variety_name ?? 'fixture',
    variety_id: `gv-${seq}`,
    variety_name: 'fixture',
    crop_type_slug: null,
    lifecycle: 'annual',
    grown_as: 'annual',
    days_to_maturity_min: null,
    days_to_maturity_max: null,
    start_method: 'both',
    start_indoor_weeks_min: null,
    start_indoor_weeks_max: null,
    direct_sow_timing: null,
    sow_season: 'cool',
    sow_notes: '',
    growth_habit: null,
    day_length_response: null,
    ...over,
  };
}

const one = (row, today = GATE_DAY) => {
  const buckets = bucketize([row], today);
  const key = Object.keys(buckets).find((k) => buckets[k].length > 0);
  return { bucket: key, entry: buckets[key][0] };
};

// Real prod prose, verbatim (audit §0-c). These strings ARE the test — paraphrasing them
// invalidates the polarity proof.
const PROSE = {
  flatOfItaly: 'Intermediate-day (leaning intermediate-to-long-day) heirloom Italian cipollini; forms flattened, disk-shaped bulbs rather than tall globes. Biennial grown as a warm-season annual for bulb harvest.',
  yellowSpanish: 'LONG-DAY onion-requires ~14-16 hours of summer daylight to trigger bulbing, well-suited to northern latitudes (recommended north of the 37th parallel, includes Zone 5b MA). Forms large 3-6 in globe bulbs. Biennial grown as an annual.',
  granex: 'SHORT-DAY onion-bulbs only when daylength is ~10-12 hours (grown fall-to-spring in the Deep South). Produces large sweet flattened-globe bulbs (classic Vidalia-type). Biennial grown as an annual.',
  redAmposta: 'Intermediate-day Spanish/Italian heirloom producing large copper-red semi-flat globes with red-and-white ringed flesh. Best range 32-42N, placing South Deerfield (~42.5N) at the northern edge. Biennial grown as an annual.',
  monastrell: 'Intermediate-day F1 hybrid storage onion; forms large, slightly flattened red-skinned globes. Adapted to a broad latitude range including northern zones such as Massachusetts. Biennial grown as an annual.',
  tokyoLongWhite: 'Day-neutral / non-bulbing bunching (green) onion-unaffected by the photoperiod that governs bulb onions, grows regardless of Zone 5b day length. Clump-forming perennial (Allium fistulosum), grown as an annual scallion.',
  zebrune: 'Long-day shallot (needs long summer daylength ~14-16 hrs to bulb-well suited to northern latitudes like MA); each seed-grown plant divides into a cluster of elongated torpedo-shaped copper/pink-skinned bulbs.',
  garlicHardneck: 'upright clump, 12-18 in tall; stiff leaves; hardneck produces curling scape (flower stalk) in early summer; bulb formed at soil level from single clove',
};

// Flat of Italy, exactly as prod holds it.
const flatOfItaly = (over = {}) => viewRow({
  variety_name: 'Flat of Italy',
  crop_type_slug: 'onion',
  days_to_maturity_min: 70,
  days_to_maturity_max: 70,
  start_indoor_weeks_min: 10,
  start_indoor_weeks_max: 12,
  direct_sow_timing: '4-6 weeks before last frost or as soon as soil can be worked',
  sow_season: 'cool',
  growth_habit: PROSE.flatOfItaly,
  day_length_response: null,
  ...over,
});

describe('allium viability gate — isSpringEstablishmentAllium truth table', () => {
  // THE POLARITY PROOF. Every bulbing onion in prod is regex-SILENT: alliumType returns null, not
  // 'bulbing'. An affirmative "gate when bulbing" predicate would gate NONE of them and ship the
  // reported bug unfixed. Gate-unless-confirmed-bunching gates all of them.
  it('every bulbing prod onion is prose-silent (alliumType null) yet still gated', () => {
    for (const key of ['flatOfItaly', 'yellowSpanish', 'granex', 'redAmposta', 'monastrell']) {
      expect(alliumType('onion', PROSE[key])).toBeNull();               // affirmative test fails...
      expect(isSpringEstablishmentAllium(
        viewRow({ crop_type_slug: 'onion', growth_habit: PROSE[key] }),
      )).toBe(true);                                                    // ...inverted polarity holds
    }
  });

  it('bunching onion is affirmatively identified and NOT gated', () => {
    expect(alliumType('onion', PROSE.tokyoLongWhite)).toBe('bunching');
    expect(isSpringEstablishmentAllium(
      viewRow({ crop_type_slug: 'onion', growth_habit: PROSE.tokyoLongWhite }),
    )).toBe(false);
  });

  it('seed shallot is gated; garlic and chives are not', () => {
    expect(isSpringEstablishmentAllium(
      viewRow({ crop_type_slug: 'shallot', growth_habit: PROSE.zebrune }),
    )).toBe(true);
    // garlic is fall-planted and vernalization-dependent — a spring-only gate would be wrong.
    expect(isSpringEstablishmentAllium(
      viewRow({ crop_type_slug: 'garlic', growth_habit: PROSE.garlicHardneck }),
    )).toBe(false);
    expect(isSpringEstablishmentAllium(viewRow({ crop_type_slug: 'chives' }))).toBe(false);
    expect(isSpringEstablishmentAllium(viewRow({ crop_type_slug: 'leek' }))).toBe(false);
    expect(isSpringEstablishmentAllium(viewRow({ crop_type_slug: 'lettuce' }))).toBe(false);
  });

  // FAIL-SAFE: the engine may deploy before the view-widen lands. Absent columns must still gate.
  it('fails SAFE when growth_habit / day_length_response are absent entirely', () => {
    const bare = { crop_type_slug: 'onion' };
    expect(isSpringEstablishmentAllium(bare)).toBe(true);
    expect(isSpringEstablishmentAllium(viewRow({ crop_type_slug: 'onion', growth_habit: undefined }))).toBe(true);
    expect(isSpringEstablishmentAllium(viewRow({ crop_type_slug: 'onion', growth_habit: '' }))).toBe(true);
  });

  // day_length_response is informational ONLY — it is NULL for 367 of 399 prod varieties and for
  // every bulbing onion sow-candidate, so it must never influence the gate.
  it('ignores day_length_response in every state', () => {
    for (const dl of [null, undefined, 'day_neutral', 'intermediate', 'long_day', 'short_day']) {
      expect(isSpringEstablishmentAllium(flatOfItaly({ day_length_response: dl }))).toBe(true);
      expect(isSpringEstablishmentAllium(
        viewRow({ crop_type_slug: 'onion', growth_habit: PROSE.tokyoLongWhite, day_length_response: dl }),
      )).toBe(false);
    }
  });

  // Drift guard: the engine keeps a local bunching regex rather than a third synced copy of
  // crop-derive.js. This pins the two to the same answer over the real prose corpus.
  it('agrees with crop-derive alliumType across the whole prod allium corpus', () => {
    const corpus = [
      ['onion', PROSE.flatOfItaly], ['onion', PROSE.yellowSpanish], ['onion', PROSE.granex],
      ['onion', PROSE.redAmposta], ['onion', PROSE.monastrell], ['onion', PROSE.tokyoLongWhite],
      ['shallot', PROSE.zebrune],
    ];
    for (const [slug, prose] of corpus) {
      expect(isSpringEstablishmentAllium(viewRow({ crop_type_slug: slug, growth_habit: prose })))
        .toBe(alliumType(slug, prose) !== 'bunching');
    }
  });
});

describe('allium viability gate — bucketing on 2026-07-24 (the reported bug)', () => {
  it('Flat of Italy -> hold, reopening at next Feb indoor start (was recommended)', () => {
    const { bucket, entry } = one(flatOfItaly());
    expect(bucket).toBe('hold');
    expect(entry.gated).toBe(true);
    expect(entry.gateReason).toMatch(/Bulb onions need a spring start/);
    expect(entry.reopensOn).toBe('2027-02-25');
    expect(entry.action).toBe('start_indoors');
    expect(entry.windowLabel).toContain('2027'); // a 7-month hold must not read as imminent
  });

  // CONTROL — proves the suppressed windows really are open on this date and that the GATE is what
  // removes them. Same row, prose flipped to bunching: it lands in an actionable bucket via the
  // class-C tail (Apr 8 - Aug 3) plus the fall indoor pass (Jul 6 - Aug 3).
  it('the identical row with bunching prose IS still recommended (gate is the only cause)', () => {
    const { bucket } = one(flatOfItaly({ growth_habit: 'non-bulbing bunching scallion' }));
    expect(bucket).toBe('window_closing');
  });

  it('bunching Tokyo Long White is untouched — still actionable in July', () => {
    const tokyo = viewRow({
      variety_name: 'Tokyo Long White',
      crop_type_slug: 'onion',
      lifecycle: 'perennial',
      grown_as: 'perennial',
      days_to_maturity_min: 65,
      days_to_maturity_max: 65,
      start_indoor_weeks_min: 8,
      start_indoor_weeks_max: 10,
      direct_sow_timing: '3-4 wks before last frost; succession every 3-4 wks through mid-summer',
      sow_season: 'cool_warm',
      growth_habit: PROSE.tokyoLongWhite,
    });
    expect(one(tokyo, '2026-07-01').bucket).toBe('start_indoors_now');
    expect(one(tokyo, GATE_DAY).entry.gated).toBeUndefined();
  });

  // gateReason means "the gate removed something". In January nothing is suppressed — the spring
  // window is simply still ahead — so the card must be an ORDINARY hold. Attaching the reason here
  // produced a contradiction in spring: "a summer sowing will not size a bulb … start indoors in
  // late winter" shown beside a direct-sow window opening 27 days later.
  it('a gated bulber whose spring window is merely still ahead is an ORDINARY hold, no reason', () => {
    const jan = one(flatOfItaly(), '2026-01-15');
    expect(jan.bucket).toBe('hold');
    expect(jan.entry.reopensOn).toBe('2026-02-25'); // this year's indoor start, not next year's
    expect(jan.entry.gated).toBeUndefined();
    expect(jan.entry.gateReason).toBeUndefined();

    // March: the next window is a DIRECT sow 27 days out — reason text would contradict it outright.
    const mar = one(flatOfItaly(), '2026-03-12');
    expect(mar.bucket).toBe('hold');
    expect(mar.entry.gateReason).toBeUndefined();
  });

  // The gate suppresses out-of-season windows only — it must not touch the spring window itself.
  // (Its indoor window is Feb 25 - Mar 11, so by Mar 1 it is correctly `window_closing` at 10 days
  // left; Feb 27 has the headroom to show the ordinary open-window bucket.)
  it('a gated bulber sows normally while its spring window is open', () => {
    const { bucket, entry } = one(flatOfItaly(), '2026-02-27');
    expect(bucket).toBe('start_indoors_now');
    expect(entry.action).toBe('start_indoors');
    expect(entry.gated).toBeUndefined(); // no "why held" microcopy on an actionable card
    expect(one(flatOfItaly(), '2026-03-01').bucket).toBe('window_closing');
  });
});

describe('next-year horizon — sow_next_year bucket', () => {
  it('a pure class-H candidate lands in sow_next_year, not direct_sow_now', () => {
    const { bucket, entry } = one(viewRow({
      variety_name: 'Pure Biennial',
      lifecycle: 'biennial',
      grown_as: 'biennial',
      start_method: 'direct_sow',
      direct_sow_timing: 'sow in summer for next-year bloom',
      sow_season: 'cool_warm',
    }));
    expect(bucket).toBe('sow_next_year');
    expect(entry.action).toBe('direct_sow');
    expect(entry.daysLeft).toBe(22); // through Aug 15
    // V4-SOWOWCOPY-001: was 'next year'. The card no longer claims a flower — the bucket takes
    // biennial vegetables and overwintered greens too — so it names the horizon instead.
    expect(entry.windowLabel).toContain('pays off next spring');
  });

  // Horizon partition happens BEFORE the close/daysLeft math: an open this-season clause outranks a
  // next-year one, and the card is labelled from the this-season window. This is why the real
  // Hollyhock (class B + H) stays in direct_sow_now.
  it('an open this-season clause outranks a next-year clause', () => {
    const { bucket } = one(viewRow({
      variety_name: 'Both Horizons',
      grown_as: 'annual',
      days_to_maturity_min: 30,
      days_to_maturity_max: 30,
      start_method: 'direct_sow',
      direct_sow_timing: 'after last frost or in summer for next-year bloom',
      sow_season: 'cool_warm',
    }));
    expect(bucket).toBe('direct_sow_now');
  });

  // B1-over-A precedence: the gate drops G/H clauses, so a gated bulber can never surface a
  // next-year window no matter what its timing prose says.
  it('a gated bulber never reaches sow_next_year even with a class-H clause', () => {
    const { bucket, entry } = one(flatOfItaly({
      direct_sow_timing: '4-6 weeks before last frost or in summer for next-year bloom',
    }));
    expect(bucket).toBe('hold');
    expect(entry.gated).toBe(true);
  });
});

// ── Hardening pass (pre-promote QA + regression-impact review, 2026-07-26) ───────
// Each block below was added because a mutation survived the original suite, or because a probe
// found a reachable hole. Tests that only restate the implementation are worthless; these are
// written so that reverting the corresponding fix makes them fail.

describe('bunching predicate — negated and comparative prose must NOT un-gate a bulb onion', () => {
  // THE FAIL-OPEN CLASS. Every string below is realistic seed-catalog copy for a BULBING onion
  // that happens to contain a bunching token inside a negation or comparison. Before the guard,
  // all of these escaped the gate — the reported bug, re-introduced through the data layer.
  // growth_habit is free text (varieties API validates only typeof === 'string'), so an enrichment
  // rewrite of any current variety could land one of these.
  const MUST_GATE = [
    'A true storage bulb onion, not a bunching type; forms large globes for winter keeping.',
    'Unlike a scallion, this long-day variety sizes a heavy 4-in bulb by late summer.',
    'Not a bunching onion. Intermediate-day Spanish heirloom forming semi-flat globes.',
    'This is a bulbing (non-bunching) onion requiring 14 hours of daylight.',
    'Harvest thinnings as scallions; remaining plants form storage bulbs by September.',
    'Can be pulled young as a scallion or left to mature into a large yellow globe onion.',
    'Sweeter than bunching onions; produces a single large storage bulb.',
    'Grown for bulbs rather than scallions.',
    'A storage onion, never a bunching type.',
    'Bulbs well in the north — this is not a scallion variety.',
  ];
  for (const prose of MUST_GATE) {
    it(`gates: "${prose.slice(0, 52)}…"`, () => {
      expect(isSpringEstablishmentAllium(viewRow({ crop_type_slug: 'onion', growth_habit: prose }))).toBe(true);
    });
  }

  // The exclusion must still fire on genuine, unqualified bunching prose.
  const MUST_NOT_GATE = [
    PROSE.tokyoLongWhite,
    'upright non-bulbing clump, 12-18 in; thin hollow green leaves; harvested as green bunching onion before bulb forms',
    'upright non-bulbing clump, 12-18 in; thin green hollow leaves; bunching habit if A. fistulosum',
    'Japanese bunching onion; tall white shanks, harvested green.',
    'Perennial scallion, forms clumps and never bulbs.',
  ];
  for (const prose of MUST_NOT_GATE) {
    it(`does NOT gate: "${prose.slice(0, 52)}…"`, () => {
      expect(isSpringEstablishmentAllium(viewRow({ crop_type_slug: 'onion', growth_habit: prose }))).toBe(false);
    });
  }

  // Each alternation pinned INDEPENDENTLY. Previously all three tokens co-occurred in every
  // bunching fixture, so deleting any one of them — or the case-insensitive flag — left the suite
  // fully green. These fail individually if an alternation or the /i flag is dropped.
  it('pins each bunching alternation and case-insensitivity separately', () => {
    const g = (p) => isSpringEstablishmentAllium(viewRow({ crop_type_slug: 'onion', growth_habit: p }));
    expect(g('non-bulbing clump')).toBe(false);   // needs non[-_ ]?bulbing
    expect(g('non bulbing clump')).toBe(false);   // needs the [-_ ]? separator class
    expect(g('a bunching habit')).toBe(false);    // needs |bunching
    expect(g('classic scallion')).toBe(false);    // needs |scallion
    expect(g('NON-BULBING CLUMP')).toBe(false);   // needs the /i flag
    expect(g('Bunching Onion')).toBe(false);      // needs the /i flag
    expect(g('forms a large globe')).toBe(true);  // no signal at all -> fail safe
  });
});

describe('gate clause filter — every dropped class is pinned', () => {
  // Mutating the filter to leak B, D, E, F or G previously left the suite green, while a leaked
  // class B reproduced the reported bug verbatim ("Direct sow through Aug 3" on a bulb onion).
  // One case per class: each timing below MUST NOT produce an actionable bucket on the gate day.
  const TIMINGS = {
    B: 'sow 2 weeks after last frost',
    C: 'as soon as soil can be worked',
    D: 'succession sow every 3 weeks',
    E: 'sow 8-10 wks before first fall frost',
    F: 'direct sow late summer',
    G: 'fall sow for spring germination',
    H: 'sow in summer for next-year bloom',
  };
  for (const [cls, timing] of Object.entries(TIMINGS)) {
    it(`class ${cls} is dropped for a gated allium ("${timing}")`, () => {
      const { bucket, entry } = one(flatOfItaly({ direct_sow_timing: timing }));
      expect(bucket).toBe('hold');
      expect(entry.gated).toBe(true);
    });
  }
});

describe('gate — holes found by probe', () => {
  // start_method 'indoors_only' returned `sow_inside_anytime` (an ACTIONABLE bucket) BEFORE the
  // gated branch, so a bulb onion kept a live Sow button in July with no reason and no gate.
  it('an indoors_only gated allium does not escape via the sow-inside-anytime overlay', () => {
    const { bucket, entry } = one(flatOfItaly({ start_method: 'indoors_only' }));
    expect(bucket).toBe('hold');
    expect(entry.gated).toBe(true);
  });

  // No class-A clause AND no indoor weeks -> nothing to rebuild. This previously fell through to
  // `too_late`: collapsed, no reason line, and no "Sow anyway" (the override keys on entry.gated).
  it('a gated allium with nothing rebuildable still holds, with reason and override intact', () => {
    const { bucket, entry } = one(flatOfItaly({
      direct_sow_timing: 'as soon as soil can be worked',
      start_indoor_weeks_min: null,
      start_indoor_weeks_max: null,
    }));
    expect(bucket).toBe('hold');
    expect(entry.gated).toBe(true);
    expect(entry.gateReason).toMatch(/spring start/i);
    expect(entry.reopensOn).toBeUndefined();
  });

  it('shallots carry their own reason text, not the onion one', () => {
    const { entry } = one(viewRow({
      variety_name: 'Zebrune', crop_type_slug: 'shallot',
      days_to_maturity_min: 100, days_to_maturity_max: 100,
      start_method: 'start_indoors', start_indoor_weeks_min: 8, start_indoor_weeks_max: 10,
      direct_sow_timing: 'Indoor start strongly preferred in Zone 5b', growth_habit: PROSE.zebrune,
    }));
    expect(entry.gated).toBe(true);
    expect(entry.gateReason).toMatch(/^Shallots/);
  });

  // The year+1 hold REBUILDS against next year's anchors rather than adding 365 days. Replacing it
  // with +365d survived the old suite because the 2026->2027 roll is not a leap boundary. A
  // 2027->2028 roll diverges by exactly one day; this pins the correct value.
  it('the year+1 rebuild stays correct across a leap boundary', () => {
    expect(one(flatOfItaly(), '2027-07-24').entry.reopensOn).toBe('2028-02-26');
  });
});

describe('sow_next_year — window boundaries', () => {
  const pureH = () => viewRow({
    variety_name: 'Pure Biennial', lifecycle: 'biennial', grown_as: 'biennial',
    start_method: 'direct_sow', direct_sow_timing: 'sow in summer for next-year bloom',
    sow_season: 'cool_warm',
  });
  // Dropping the isOpen() guard on the next-year partition survived the old suite, yet produced
  // sow_next_year with daysLeft -1 after the close and +106 before the open.
  it('is not used before the window opens', () => {
    expect(one(pureH(), '2026-05-01').bucket).toBe('hold');
  });
  it('is used on the open date and on the close date', () => {
    expect(one(pureH(), '2026-06-01').bucket).toBe('sow_next_year');
    const close = one(pureH(), '2026-08-15');
    expect(close.bucket).toBe('sow_next_year');
    expect(close.entry.daysLeft).toBe(0);
  });
  it('is not used after the window closes', () => {
    expect(one(pureH(), '2026-08-16').bucket).toBe('too_late');
  });
  // An open next-year window used to vanish entirely when a this-season window took the card.
  it('surfaces as a hint when a this-season window owns the card', () => {
    const both = one(viewRow({
      variety_name: 'Both Horizons', grown_as: 'annual',
      days_to_maturity_min: 60, days_to_maturity_max: 60,
      start_method: 'both', start_indoor_weeks_min: 4, start_indoor_weeks_max: 6,
      direct_sow_timing: 'sow in summer for next-year bloom', sow_season: 'cool_warm',
    }));
    expect(both.entry.windowLabel).toContain('also sowable now for next year');
  });
});

// ── BUG-SOWNONANNUAL-001 — non-annual season-length clamp ───────────────────────
// Horticulture call 2026-07-26 (horticulture-planning-analyst, V4 expert-dispatch rule).
// The season-length question is NOT "is this an annual" but "is the payoff a harvest this season
// or an overwintering crown". Fixtures use LIVE prod field values for the varieties Dave owns.
describe('BUG-SOWNONANNUAL-001 — non-annuals get a season-length clamp', () => {
  const TODAY = '2026-07-26'; // the day the bug was reported

  it('classifies a year-2 bloomer as establishment, not harvest', () => {
    // dtm=300 on a biennial is days-to-BLOOM across a winter, not days to a harvest.
    expect(sowGoal({ lifecycle: 'biennial', grown_as: null }, 300)).toBe('establishment');
    expect(sowGoal({ lifecycle: 'perennial', grown_as: null }, 110)).toBe('establishment');
  });

  it('classifies a biennial grown for a first-year harvest as harvest', () => {
    // Long Island Improved (Brussels sprouts): biennial, but you eat it in year 1.
    expect(sowGoal({ lifecycle: 'biennial', grown_as: null, crop_type_slug: 'brussels_sprouts' }, 90))
      .toBe('harvest');
    // ...and via the timing text, for a crop whose slug is not in the bridge set.
    expect(sowGoal({ lifecycle: 'biennial', grown_as: null, crop_type_slug: 'zzz',
      direct_sow_timing: 'sow in late spring for a fall harvest' }, 90)).toBe('harvest');
  });

  it('an annual is always harvest, whatever its dtm', () => {
    expect(sowGoal({ lifecycle: 'annual', grown_as: null }, 300)).toBe('harvest');
    expect(sowGoal({ lifecycle: 'tender_perennial', grown_as: 'annual' }, null)).toBe('harvest');
  });

  it('THE REPORTED BUG: a biennial no longer reads "direct sow through" the raw first frost', () => {
    const r = run(viewRow({
      variety_name: 'The Watchman', lifecycle: 'biennial', grown_as: null,
      days_to_maturity_min: 300, sow_season: 'cool_warm',
      direct_sow_timing: 'after last frost or in summer for next-year bloom',
    }), TODAY);
    // Sep 28 is ctx.FF verbatim — the fabricated close the ?? fallback used to produce.
    expect(JSON.stringify(r)).not.toContain('Sep 28');
    expect(r.bucket).toBe('sow_next_year');
  });

  it('THE NAIVE FIX HAZARD: the card must not vanish', () => {
    // Deleting the `effective !== 'annual'` line instead of classifying would send hollyhock down
    // the cool_warm branch to FF-307 = Nov 25 of the PREVIOUS year. open > close, and pushDirect's
    // annihilation guard drops the window silently — the card disappears rather than being wrong.
    // This asserts it is still PRESENT, which no bucket assertion alone guarantees.
    const r = run(viewRow({
      variety_name: 'The Watchman', lifecycle: 'biennial', grown_as: null,
      days_to_maturity_min: 300, sow_season: 'cool_warm',
      direct_sow_timing: 'after last frost or in summer for next-year bloom',
    }), TODAY);
    expect(r).toBeTruthy();
    expect(r.bucket).toBeTruthy();
    expect(r.bucket).not.toBe('needs_profile');
  });

  // BUG-SOWFIRSTYEAR-001 — the flag is authoritative; NULL still falls back.
  it('crop_types.first_year_harvest overrides the dtm heuristic when set', () => {
    // kohlrabi: a real biennial-lifecycle vegetable that is NOT in FIRST_YEAR_HARVEST_CROPS and
    // whose timing text never says "harvest" — the exact false-negative the hardcoded set produces,
    // and it would have told Dave to wait a year for a kohlrabi. The flag fixes it in DATA.
    // (An earlier draft used 'salsify', which IS in the bridge set, so it proved nothing.)
    const veg = { lifecycle: 'biennial', grown_as: null, crop_type_slug: 'kohlrabi',
                  direct_sow_timing: 'sow in spring' };
    expect(sowGoal(veg, 120)).toBe('establishment');                       // without the flag
    expect(sowGoal({ ...veg, first_year_harvest: true }, 120)).toBe('harvest'); // with it
  });

  it('first_year_harvest=false wins even when the slug is in the bridge set', () => {
    // Data beats the hardcoded list, so a wrong entry there can be corrected without a deploy.
    expect(sowGoal({ lifecycle: 'biennial', grown_as: null, crop_type_slug: 'onion',
                     first_year_harvest: false }, 90)).toBe('establishment');
  });

  it('NULL first_year_harvest is UNKNOWN, not false', () => {
    // Truthiness would read null as false and send every unseeded crop to establishment — telling
    // Dave to wait a year for most of the catalog. Strict === checks are load-bearing.
    const brussels = { lifecycle: 'biennial', grown_as: null, crop_type_slug: 'brussels_sprouts',
                       first_year_harvest: null };
    expect(sowGoal(brussels, 90)).toBe('harvest');       // falls through to the bridge set
    expect(sowGoal({ ...brussels, first_year_harvest: undefined }, 90)).toBe('harvest');
  });

  it('the orthogonality case: perennial AND first-year (bunching onion)', () => {
    // Tokyo Long White is grown_as='perennial' in live data — correct, it clumps and overwinters —
    // and you still cut scallions from it the first season. This is why grown_as could not carry
    // the flag: asparagus has the same grown_as and the opposite answer.
    const bunching = { lifecycle: 'perennial', grown_as: 'perennial', crop_type_slug: 'onion',
                       first_year_harvest: true };
    const asparagus = { lifecycle: 'perennial', grown_as: 'perennial', crop_type_slug: 'asparagus',
                        first_year_harvest: false };
    expect(sowGoal(bunching, 65)).toBe('harvest');
    expect(sowGoal(asparagus, 65)).toBe('establishment');
  });

  it('an unknown clamp says "I do not know", never "too late"', () => {
    // The mirror of the reported bug. Removing the `latestSafe ?? ctx.FF` fabrication correctly
    // stops "Direct sow through Sep 28", but falling through to too_late would assert "Sowing
    // window passed for 2026" — equally unknown, and in 5b a French marigold direct-sown in late
    // July still blooms before frost. Verified on live data: this change moves 5 packets off a
    // fabricated date and leaves the too_late count at 162, exactly where it was.
    const r = run(viewRow({
      variety_name: 'Favourite Blend (French)', lifecycle: 'annual', grown_as: 'annual',
      days_to_maturity_min: null, days_to_maturity_max: null, sow_season: 'warm',
      start_method: 'both', start_indoor_weeks_min: 4, start_indoor_weeks_max: 6,
      direct_sow_timing: '1-2 wks after last frost when soil is warm',
    }), TODAY);
    expect(r.bucket).toBe('needs_profile');
    expect(r.entry.windowLabel).toMatch(/days to maturity/i);
  });

  it('a null-dtm annual emits NO window rather than a fabricated one', () => {
    // `close = latestSafe ?? ctx.FF` invented a close date out of the frost anchor whenever the
    // clamp was unknown. NULL means UNKNOWN and must never render as a confident date.
    const r = run(viewRow({
      variety_name: 'unknown-dtm', lifecycle: 'annual', grown_as: 'annual',
      days_to_maturity_min: null, days_to_maturity_max: null, sow_season: 'warm',
      direct_sow_timing: 'after last frost',
    }), TODAY);
    expect(JSON.stringify(r)).not.toContain('Sep 28');
  });
});

// ── V4-MATURITYBASIS-001 Slice C — basis-aware fall indoor pass ────────────────────────────────
// `latest` (last day to START SEED INDOORS) previously subtracted DTM straight off the fall frost
// anchor, i.e. assumed DTM counts from the indoor sow. For a crop whose catalogue DTM is quoted
// FROM TRANSPLANT that omits the whole nursery period, so the engine told the user to start fall
// brassicas 4-6 weeks after the real deadline. Measured on live prod 2026-08-04: 16 fall_indoor
// windows read OPEN, 14 of them from-transplant crops whose true latest-start had passed between
// 2026-06-23 and 2026-07-17. After this change: 2 open, both genuinely from-sow (beet, carrot).
describe('fall indoor pass — DTM basis (V4-MATURITYBASIS-001 Slice C)', () => {
  // weeks 4-6 / dtm 66 / cool -> uncorrected latest = FF + (28 - 66 - 14) = Aug 7.
  const fall = (overrides = {}) => synth({
    start_method: 'start_indoors', start_indoor_weeks_min: 4, start_indoor_weeks_max: 6,
    days_to_maturity_max: 66, sow_season: 'cool', ...overrides,
  });

  it('NULL basis (uncurated) reproduces the pre-basis window exactly', () => {
    const { bucket, entry } = run(fall({ dtm_basis: null }));
    expect(bucket).toBe('start_indoors_now');
    expect(entry.daysLeft).toBe(28);
    expect(entry.windowLabel).toContain('Aug 7');
  });

  it('an ABSENT dtm_basis key (pre-view-change payload) behaves identically to NULL', () => {
    const c = fall();
    delete c.dtm_basis;
    const { bucket, entry } = run(c);
    expect(bucket).toBe('start_indoors_now');
    expect(entry.windowLabel).toContain('Aug 7');
  });

  it('from-sow shifts nothing — byte-identical to the NULL-basis entry', () => {
    const strip = (r) => JSON.stringify({ b: r.bucket, w: r.entry.windowLabel, d: r.entry.daysLeft });
    expect(strip(run(fall({ dtm_basis: 'from-sow' })))).toBe(strip(run(fall({ dtm_basis: null }))));
  });

  it('an unrecognised basis value falls back to the from-sow behaviour', () => {
    // A bundle older than the data must degrade to today's math, never to a suppressed window.
    const { bucket, entry } = run(fall({ dtm_basis: 'from-germination' }));
    expect(bucket).toBe('start_indoors_now');
    expect(entry.windowLabel).toContain('Aug 7');
  });

  it('from-transplant pulls the latest indoor start back by the FULL nursery period', () => {
    // wMax 6 weeks = 42 days: Aug 7 -> Jun 26. Evaluated inside the corrected window (open Jun 26
    // - 28d = May 29), the close date is the corrected one, not the old one. 6 days left is inside
    // windowClosingDays, so the urgency bucket is `window_closing` — the correction does not just
    // move the date, it moves this candidate into the bucket that actually shouts at the user.
    const { bucket, entry } = run(fall({ dtm_basis: 'from-transplant' }), '2026-06-20');
    expect(bucket).toBe('window_closing');
    expect(entry.windowLabel).toContain('Jun 26');
    expect(entry.windowLabel).not.toContain('Aug 7');
    expect(entry.daysLeft).toBe(6);
  });

  it('the seasonal failure itself: a window that read OPEN now reads too_late', () => {
    // On 2026-07-10 the uncorrected window (Jul 10 - Aug 7) was open and the card said
    // "Start indoors through Aug 7". The corrected window (May 29 - Jun 26) closed two weeks ago.
    expect(run(fall({ dtm_basis: null })).bucket).toBe('start_indoors_now');
    expect(run(fall({ dtm_basis: 'from-transplant' })).bucket).toBe('too_late');
  });

  it('uses start_indoor_weeks_MAX (the longer nursery = the earlier close)', () => {
    // min 4 / max 6 -> shift 42d, not 28d. Aug 7 - 42 = Jun 26; Aug 7 - 28 would be Jul 10.
    const { entry } = run(fall({ dtm_basis: 'from-transplant' }), '2026-06-20');
    expect(entry.windowLabel).toContain('Jun 26');
  });

  it('falls back to start_indoor_weeks_MIN when max is absent', () => {
    const { entry } = run(fall({
      dtm_basis: 'from-transplant', start_indoor_weeks_min: 4, start_indoor_weeks_max: null,
    }), '2026-06-20');
    expect(entry.windowLabel).toContain('Jul 10'); // Aug 7 - 28d
  });

  it('from-transplant with NO nursery estimate emits no fall window rather than a wrong one', () => {
    // Uncomputable latest-start. The same rule latestSafeMs applies to a null dtm: unknown must
    // never be fabricated into a confident date, least of all an OPEN one in a frost race.
    const c = fall({
      dtm_basis: 'from-transplant', start_indoor_weeks_min: null, start_indoor_weeks_max: null,
    });
    const r = run(c);
    expect(r.bucket).toBe('too_late');
    expect(JSON.stringify(r)).not.toContain('Aug 7');
  });

  it('the SPRING indoor window is untouched by basis', () => {
    const spring = (basis) => run(fall({ dtm_basis: basis }), '2026-04-01');
    expect(spring('from-transplant').entry.windowLabel)
      .toBe(spring(null).entry.windowLabel);
  });

  it('DIRECT-sow windows are untouched by basis (latestSafeMs is from-sow and stays that way)', () => {
    const direct = (basis) => run(synth({
      start_method: 'direct_sow', direct_sow_timing: 'after last frost',
      sow_season: 'cool', days_to_maturity_max: 66, dtm_basis: basis,
    }));
    const a = direct('from-transplant');
    const b = direct(null);
    expect(a.bucket).toBe(b.bucket);
    expect(a.entry.windowLabel).toBe(b.entry.windowLabel);
  });

  it('gated bulbing alliums still get no fall pass at all', () => {
    const onion = toCandidate(PACKETS.onionMonastrell, { dtm_basis: 'from-transplant' });
    expect(run(onion).bucket).toBe('hold');
  });

  it('reproduces the live prod correction for Belstar broccoli (dtm 66, 4-6 wks)', () => {
    // The Belstar packet literally reads "Days to maturity from transplant" — the ground truth
    // this whole slice encodes. Prod said start-by Aug 7; the real deadline was Jun 26, and is now
    // Jun 29 (V4-FALLINDOORHARDY-001: broccoli is fall-hardy, so the anchor moved FF -> FFobs, +3d).
    // The correction this test exists for is the NURSERY shift, and it is unchanged at 42 days —
    // Aug 10 - 42 = Jun 29, exactly as Aug 7 - 42 was Jun 26. The two are orthogonal, which is the
    // point: re-keying the anchor did not disturb the basis correction measured against it.
    const belstar = toCandidate(PACKETS.broccoliBelstar, { dtm_basis: 'from-transplant' });
    const at = (d) => run(belstar, d);
    expect(at('2026-06-20').entry.windowLabel).toContain('Jun 29');
    expect(at('2026-08-04').entry.windowLabel).not.toMatch(/Start indoors/);
  });
});

// ── V4-SOWARCHIVE-001 ─────────────────────────────────────────────────────────
// Archive-for-the-season: a packet Dave is done sowing leaves the ACTIVE buckets for a bottom
// section, and comes back by itself next season. The invariant under test throughout is that
// archiving DIVERTS a packet without re-deciding it — bucketOne's verdict is preserved on
// `archivedFrom`, so un-archiving is a pure restore and the two paths cannot drift.
describe('V4-SOWARCHIVE-001 archive-for-the-season', () => {
  const SEASON = 2026; // == the year TODAY ('2026-07-10') resolves to

  it('isArchivedForSeason: only a stamp matching THIS season archives', () => {
    expect(isArchivedForSeason({ sow_archived_season: 2026 }, 2026)).toBe(true);
    // Expiry is the whole design: last season's stamp does not hide anything this season.
    expect(isArchivedForSeason({ sow_archived_season: 2025 }, 2026)).toBe(false);
    expect(isArchivedForSeason({ sow_archived_season: 2027 }, 2026)).toBe(false);
  });

  it('isArchivedForSeason: absent/empty/garbage reads as NOT archived', () => {
    // The safe direction. The failure this guards is a packet silently vanishing from the list,
    // so anything unparseable must fall back to visible.
    expect(isArchivedForSeason({ sow_archived_season: null }, 2026)).toBe(false);
    expect(isArchivedForSeason({ sow_archived_season: '' }, 2026)).toBe(false);
    expect(isArchivedForSeason({ sow_archived_season: 'nope' }, 2026)).toBe(false);
    expect(isArchivedForSeason({}, 2026)).toBe(false);
    expect(isArchivedForSeason(undefined, 2026)).toBe(false);
  });

  it('isArchivedForSeason: coerces the neon driver string form', () => {
    // View columns can arrive as strings; a strict === would silently never archive anything.
    expect(isArchivedForSeason({ sow_archived_season: '2026' }, 2026)).toBe(true);
  });

  it('PRE-MIGRATION SAFETY: a view without the column behaves exactly as today', () => {
    // Until 0a lands in an environment, v_sow_candidates has no such column and every row yields
    // undefined. That must degrade to "nothing is archived", not to an empty page.
    const rows = [PACKETS.spinachOceanside, PACKETS.cucumberSpacemaster].map((p) => toCandidate(p));
    const buckets = bucketize(rows, TODAY);
    expect(buckets.archived).toHaveLength(0);
    expect(locate(buckets, 'Oceanside').bucket).toBe('direct_sow_now');
  });

  it('diverts an archived packet out of its natural bucket, recording where it came from', () => {
    const archived = toCandidate(PACKETS.spinachOceanside, { sow_archived_season: SEASON });
    const buckets = bucketize([archived], TODAY);
    expect(buckets.direct_sow_now).toHaveLength(0);
    expect(buckets.archived).toHaveLength(1);
    expect(buckets.archived[0].archivedFrom).toBe('direct_sow_now');
  });

  it('the archived card keeps its real window label, not a blank', () => {
    // An archived card that loses its context reads as broken rather than as put-away.
    const plain = run(toCandidate(PACKETS.cucumberSpacemaster), TODAY);
    const archived = bucketize(
      [toCandidate(PACKETS.cucumberSpacemaster, { sow_archived_season: SEASON })], TODAY,
    ).archived[0];
    expect(archived.windowLabel).toBe(plain.entry.windowLabel);
    expect(archived.windowLabel).toBeTruthy();
  });

  it('ROUND TRIP: un-archiving restores the exact original bucket and entry', () => {
    // The property that makes archive safe to offer on every card — it is reversible with no
    // residue. Asserted against a window_closing packet because that is the case Dave named
    // ("things that are closing soon, I've already sown").
    const before = run(toCandidate(PACKETS.cucumberSpacemaster), TODAY);
    expect(before.bucket).toBe('window_closing');

    const onArchive = bucketize(
      [toCandidate(PACKETS.cucumberSpacemaster, { sow_archived_season: SEASON })], TODAY,
    );
    expect(onArchive.window_closing).toHaveLength(0);
    expect(onArchive.archived[0].archivedFrom).toBe('window_closing');

    // Un-archive == clearing the stamp (what the PATCH writes on {archived:false}).
    const after = run(toCandidate(PACKETS.cucumberSpacemaster, { sow_archived_season: null }), TODAY);
    expect(after.bucket).toBe('window_closing');
    expect(after.entry.daysLeft).toBe(before.entry.daysLeft);
    expect(after.entry.action).toBe(before.entry.action);
  });

  it('AUTO-RELEASE: last season\'s archive is invisible this season, with no job having run', () => {
    // Nothing clears the stamp on 1 Jan — the predicate simply stops matching. Same row, same
    // stamp, one year later, back on the list.
    const stamped = { sow_archived_season: 2025 };
    expect(bucketize([toCandidate(PACKETS.spinachOceanside, stamped)], '2025-07-10').archived)
      .toHaveLength(1);
    const nextSeason = bucketize([toCandidate(PACKETS.spinachOceanside, stamped)], TODAY);
    expect(nextSeason.archived).toHaveLength(0);
    expect(locate(nextSeason, 'Oceanside').bucket).toBe('direct_sow_now');
  });

  it('archiving one packet does not disturb the others', () => {
    const rows = [
      toCandidate(PACKETS.spinachOceanside, { sow_archived_season: SEASON }),
      toCandidate(PACKETS.cucumberSpacemaster),
      toCandidate(PACKETS.broccoliBelstar),
    ];
    const buckets = bucketize(rows, TODAY);
    expect(buckets.archived).toHaveLength(1);
    expect(buckets.window_closing).toHaveLength(1);
    // broccoli. `hold` rather than `start_indoors_now` since V4-FALLINDOORHARDY-001 moved its fall
    // indoor open from Jul 10 (= TODAY) to Jul 13; see the golden rebaseline. What this test asserts
    // is that archiving spinach leaves the OTHER two where bucketOne put them, which is unaffected.
    expect(buckets.hold).toHaveLength(1);
    expect(buckets.start_indoors_now).toHaveLength(0);
  });
});

// ── V4-SEEDZEROVIEW-001 ───────────────────────────────────────────────────────
// Dave: "I want to keep zero counts in our records, viewable as 'sowed previously' so i can review,
// but I don't want a real 'reorder if...' logic in here … zero counts can be filtered out of sow now
// and other used surfaces, but a view/filter of them would be useful."
//
// The filed defect: v_sow_candidates carries no quantity predicate, so Belstar Broccoli at
// quantity_on_hand = 0 was offered as sowable (prod 2026-08-28; 259 candidates, 257 positive, 1
// fractional at 0.5, 1 zero, 0 NULL). The through-line here matches the archive block above —
// depletion DIVERTS a packet without re-deciding it, so bucketOne's verdict survives on
// `depletedFrom` and no data is lost.
describe('V4-SEEDZEROVIEW-001 depleted packets', () => {
  const SEASON = 2026; // == the year TODAY ('2026-07-10') resolves to

  it('isDepleted: a counted zero or negative is depleted', () => {
    expect(isDepleted({ quantity_on_hand: 0 })).toBe(true);
    expect(isDepleted({ quantity_on_hand: -1 })).toBe(true);
    // View columns can arrive as strings; a strict === 0 would never fire on a real row.
    expect(isDepleted({ quantity_on_hand: '0' })).toBe(true);
    expect(isDepleted({ quantity_on_hand: '-2' })).toBe(true);
  });

  it('isDepleted: any real stock is not depleted, fractions included', () => {
    // Clemson Spineless 80 Okra sits at 0.5 on prod — half a packet is still seed to sow.
    expect(isDepleted({ quantity_on_hand: 0.5 })).toBe(false);
    expect(isDepleted({ quantity_on_hand: '0.5' })).toBe(false);
    expect(isDepleted({ quantity_on_hand: 1 })).toBe(false);
    expect(isDepleted({ quantity_on_hand: '12' })).toBe(false);
  });

  it('THE NULL DECISION: untracked is not depleted, and stays sowable', () => {
    // quantity_on_hand is nullable with no default: NULL means "nobody counted this", which is NOT
    // "used up". This is DELIBERATELY unlike InventoryDetail.jsx:253's `Number(x ?? 0) > 0`, which
    // collapses NULL into "hide" — correct for a plant-from-this-packet CTA that needs stock in
    // hand, wrong for a planning surface where hiding an uncounted packet forfeits a sowing.
    // Zero prod rows are NULL today, so this pin is the ONLY thing deciding the first one.
    expect(isDepleted({ quantity_on_hand: null })).toBe(false);
    expect(isDepleted({ quantity_on_hand: undefined })).toBe(false);
    expect(isDepleted({})).toBe(false);
    expect(isDepleted(undefined)).toBe(false);
    // Number(null) and Number('') are both 0, so the empty string needs the same guard as null.
    expect(isDepleted({ quantity_on_hand: '' })).toBe(false);
    // Unparseable reads as visible, same safe direction isArchivedForSeason takes.
    expect(isDepleted({ quantity_on_hand: 'nope' })).toBe(false);
  });

  it('THE FILED DEFECT: a zero-count packet is not offered as sowable', () => {
    // Asserted on the window_closing packet specifically: that is the bucket CultivationLead reads,
    // so an empty packet there does not just sit on /sow, it puts an imperative line on Today.
    const empty = toCandidate(PACKETS.cucumberSpacemaster, { quantity_on_hand: 0 });
    const buckets = bucketize([empty], TODAY);
    expect(buckets.window_closing).toHaveLength(0);
    expect(buckets.sowed_previously).toHaveLength(1);
    expect(buckets.sowed_previously[0].depletedFrom).toBe('window_closing');
  });

  it('NO action bucket can hold a depleted packet — swept over all twelve goldens', () => {
    // One packet proves one path. The sweep proves the divert happens before the bucket is honoured
    // at all, so no future bucket can quietly acquire an empty packet.
    const rows = Object.values(PACKETS).map((p) => toCandidate(p, { quantity_on_hand: 0 }));
    const buckets = bucketize(rows, TODAY);
    expect(buckets.sowed_previously).toHaveLength(rows.length);
    for (const key of ['start_indoors_now', 'direct_sow_now', 'sow_inside_anytime',
      'sow_next_year', 'window_closing']) {
      expect(buckets[key], `${key} must never hold a depleted packet`).toHaveLength(0);
    }
  });

  it('a half-empty packet stays on the working list', () => {
    const half = toCandidate(PACKETS.cucumberSpacemaster, { quantity_on_hand: '0.5' });
    expect(run(half, TODAY).bucket).toBe('window_closing');
  });

  it('an UNTRACKED packet stays on the working list — the wrong-late direction is the costly one', () => {
    const untracked = toCandidate(PACKETS.cucumberSpacemaster, { quantity_on_hand: null });
    const buckets = bucketize([untracked], TODAY);
    expect(buckets.sowed_previously).toHaveLength(0);
    expect(locate(buckets, 'Spacemaster 80').bucket).toBe('window_closing');
  });

  it('the depleted card keeps its real window label and every column, not a blank', () => {
    // "just need to know what I've had, how much I have now, and all the details even if zero."
    const plain = run(toCandidate(PACKETS.cucumberSpacemaster), TODAY);
    const depleted = bucketize(
      [toCandidate(PACKETS.cucumberSpacemaster, { quantity_on_hand: 0 })], TODAY,
    ).sowed_previously[0];
    expect(depleted.windowLabel).toBe(plain.entry.windowLabel);
    expect(depleted.windowLabel).toBeTruthy();
    expect(depleted.candidate.sow_depth_in).toBe(plain.entry.candidate.sow_depth_in);
    expect(depleted.candidate.days_to_maturity_max).toBe(plain.entry.candidate.days_to_maturity_max);
  });

  it('ROUND TRIP: restocking a packet returns it to the exact bucket it left', () => {
    // Nothing is retired, deleted or status-flipped, so the only thing standing between a refilled
    // packet and its old place on the list is the number itself.
    const before = run(toCandidate(PACKETS.cucumberSpacemaster), TODAY);
    const after = run(toCandidate(PACKETS.cucumberSpacemaster, { quantity_on_hand: '3' }), TODAY);
    expect(after.bucket).toBe(before.bucket);
    expect(after.entry.daysLeft).toBe(before.entry.daysLeft);
    expect(after.entry.action).toBe(before.entry.action);
  });

  it('COMPOSES WITH ARCHIVE: an archived empty packet reports the review section as its home', () => {
    // Order matters and is asserted, not assumed. Depletion picks the home bucket, archive diverts
    // out of THAT — so un-archiving lands it back in sowed_previously rather than re-offering an
    // empty packet on the working list.
    const both = toCandidate(PACKETS.cucumberSpacemaster, {
      quantity_on_hand: 0, sow_archived_season: SEASON,
    });
    const buckets = bucketize([both], TODAY);
    expect(buckets.sowed_previously).toHaveLength(0);
    expect(buckets.archived).toHaveLength(1);
    expect(buckets.archived[0].archivedFrom).toBe('sowed_previously');
    expect(buckets.archived[0].depletedFrom).toBe('window_closing');
  });

  it('depleting one packet does not disturb the others', () => {
    const rows = [
      toCandidate(PACKETS.spinachOceanside, { quantity_on_hand: 0 }),
      toCandidate(PACKETS.cucumberSpacemaster),
      toCandidate(PACKETS.broccoliBelstar),
    ];
    const buckets = bucketize(rows, TODAY);
    expect(buckets.sowed_previously).toHaveLength(1);
    expect(buckets.direct_sow_now).toHaveLength(0); // spinach was the only one
    expect(buckets.window_closing).toHaveLength(1);
    expect(buckets.hold).toHaveLength(1);
  });
});

// ── V4-SEEDSAVEFLOW-001 — seed that is not seed yet ───────────────────────────
// THE FILED DEFECT, measured on a real Neon branch 2026-09-02, not inferred: v_sow_candidates
// selects on category/deleted_at/status/variety_id and says nothing about seed_stage, so a lot
// inserted at seed_stage='fermenting' — wet tomato seed in its own pulp — came back out of the view
// and was offered by Sow Now identically to a finished packet. The reverse half of the same gap:
// advancing a lot to `stored` granted it nothing, because sowability was already fixed before the
// lot was ever staged.
//
// Dave's call on the remedy is DIVERT, NOT HIDE: the lot stays on the page, marked with the stage it
// is in, so he can see the seed exists and is coming while being unable to mis-sow it. So these
// tests assert BOTH halves, exactly as the zero-count block above does.
describe('V4-SEEDSAVEFLOW-001 in-process seed lots', () => {
  const SEASON = 2026; // == the year TODAY ('2026-07-10') resolves to

  it('isInProcess: the two unfinished stages divert', () => {
    expect(isInProcess({ seed_stage: 'fermenting' })).toBe(true);
    expect(isInProcess({ seed_stage: 'drying' })).toBe(true);
    // The vocabulary is the DB CHECK's, minus its terminal value — pinned so the two cannot drift.
    expect([...IN_PROCESS_STAGES].sort()).toEqual(['drying', 'fermenting']);
  });

  it('isInProcess: STORED is sowable — that is the whole point of finishing a lot', () => {
    expect(isInProcess({ seed_stage: 'stored' })).toBe(false);
  });

  it('THE NULL DECISION: never-tracked is not in process, and stays sowable', () => {
    // seed_stage is nullable with no default and is written only by POST /seed-stage, which exists
    // solely for home-saved lots — so NULL is not an edge case here the way quantity_on_hand's NULL
    // was, it is what EVERY bought packet carries. Treating it as in-process would divert the whole
    // sow list into "not ready yet".
    expect(isInProcess({ seed_stage: null })).toBe(false);
    expect(isInProcess({ seed_stage: undefined })).toBe(false);
    expect(isInProcess({})).toBe(false);
    expect(isInProcess(undefined)).toBe(false);
    expect(isInProcess({ seed_stage: '' })).toBe(false);
    // Unparseable reads as sowable, same safe direction isDepleted and isArchivedForSeason take.
    expect(isInProcess({ seed_stage: 'nope' })).toBe(false);
    // Pre-migration view: the column simply is not projected, so the row behaves exactly as today.
    expect(isInProcess({ quantity_on_hand: 1 })).toBe(false);
  });

  it('isInProcess: case and surrounding space do not decide sowability', () => {
    expect(isInProcess({ seed_stage: ' Fermenting ' })).toBe(true);
    expect(isInProcess({ seed_stage: 'DRYING' })).toBe(true);
  });

  it('THE FILED DEFECT: a fermenting lot is not offered as sowable', () => {
    // Asserted on the window_closing packet specifically: that is the bucket CultivationLead reads,
    // so a jar of wet seed there does not just sit on /sow, it puts an imperative line on Today.
    const wet = toCandidate(PACKETS.cucumberSpacemaster, { seed_stage: 'fermenting' });
    const buckets = bucketize([wet], TODAY);
    expect(buckets.window_closing).toHaveLength(0);
    expect(buckets.in_process).toHaveLength(1);
    expect(buckets.in_process[0].inProcessFrom).toBe('window_closing');
  });

  it('a drying lot diverts the same way', () => {
    const drying = toCandidate(PACKETS.cucumberSpacemaster, { seed_stage: 'drying' });
    const buckets = bucketize([drying], TODAY);
    expect(buckets.window_closing).toHaveLength(0);
    expect(buckets.in_process).toHaveLength(1);
  });

  it('NO action bucket can hold an in-process lot — swept over all twelve goldens', () => {
    // One packet proves one path. The sweep proves the divert happens before the bucket is honoured
    // at all, so no future bucket can quietly acquire a jar of wet seed.
    const rows = Object.values(PACKETS).map((p) => toCandidate(p, { seed_stage: 'fermenting' }));
    const buckets = bucketize(rows, TODAY);
    expect(buckets.in_process).toHaveLength(rows.length);
    for (const key of ['start_indoors_now', 'direct_sow_now', 'sow_inside_anytime',
      'sow_next_year', 'window_closing']) {
      expect(buckets[key], `${key} must never hold an in-process lot`).toHaveLength(0);
    }
  });

  it('THE FORWARD HALF: reaching `stored` puts the lot back on the working list', () => {
    // The gap ran both ways — this is the one that had no implementation at all. Same row, one
    // column advanced, and the lot is sowable seed again.
    const stored = toCandidate(PACKETS.cucumberSpacemaster, { seed_stage: 'stored' });
    const buckets = bucketize([stored], TODAY);
    expect(buckets.in_process).toHaveLength(0);
    expect(buckets.window_closing).toHaveLength(1);
  });

  it('an UNTRACKED packet stays on the working list — every bought packet is this row', () => {
    const untracked = toCandidate(PACKETS.cucumberSpacemaster, { seed_stage: null });
    const buckets = bucketize([untracked], TODAY);
    expect(buckets.in_process).toHaveLength(0);
    expect(locate(buckets, 'Spacemaster 80').bucket).toBe('window_closing');
  });

  it('the in-process card keeps its real window label and every column, not a blank', () => {
    // "see it coming" needs the card to still say WHEN — the window it will return to once dry.
    const plain = run(toCandidate(PACKETS.cucumberSpacemaster), TODAY);
    const wet = bucketize(
      [toCandidate(PACKETS.cucumberSpacemaster, { seed_stage: 'fermenting' })], TODAY,
    ).in_process[0];
    expect(wet.windowLabel).toBe(plain.entry.windowLabel);
    expect(wet.windowLabel).toBeTruthy();
    expect(wet.candidate.seed_stage).toBe('fermenting');
    expect(wet.candidate.sow_depth_in).toBe(plain.entry.candidate.sow_depth_in);
  });

  it('ORDER: in-process beats depletion, so a wet lot never reads as already sown', () => {
    // A lot mid-ferment has no meaningful count yet — the number is taken when it is packeted — so
    // 0/NULL on a fermenting jar must not claim a sowing that never happened. Asserted, not assumed.
    const both = toCandidate(PACKETS.cucumberSpacemaster, {
      seed_stage: 'fermenting', quantity_on_hand: 0,
    });
    const buckets = bucketize([both], TODAY);
    expect(buckets.sowed_previously).toHaveLength(0);
    expect(buckets.in_process).toHaveLength(1);
    expect(buckets.in_process[0].inProcessFrom).toBe('window_closing');
  });

  it('COMPOSES WITH ARCHIVE: an archived wet lot reports in-process as its home', () => {
    // Same composition rule the depleted block pins: the divert picks the home bucket, archive
    // diverts out of THAT — so un-archiving lands it back in in_process, never on the working list.
    const both = toCandidate(PACKETS.cucumberSpacemaster, {
      seed_stage: 'drying', sow_archived_season: SEASON,
    });
    const buckets = bucketize([both], TODAY);
    expect(buckets.in_process).toHaveLength(0);
    expect(buckets.archived).toHaveLength(1);
    expect(buckets.archived[0].archivedFrom).toBe('in_process');
    expect(buckets.archived[0].inProcessFrom).toBe('window_closing');
  });

  it('one lot in process does not disturb the others', () => {
    const rows = [
      toCandidate(PACKETS.spinachOceanside, { seed_stage: 'fermenting' }),
      toCandidate(PACKETS.cucumberSpacemaster),
      toCandidate(PACKETS.broccoliBelstar),
    ];
    const buckets = bucketize(rows, TODAY);
    expect(buckets.in_process).toHaveLength(1);
    expect(buckets.direct_sow_now).toHaveLength(0); // spinach was the only one
    expect(buckets.window_closing).toHaveLength(1);
    expect(buckets.hold).toHaveLength(1);
  });
});

// ── V4-HARDYSET-001 — fall hardiness by crop type, not by packet prose ────────────
// The +14d fall grace used to be decided by `HARDY_RE` against sow_notes. Zero false positives (the
// branch is season-gated and every pepper is warm), but 54 false negatives out of 64 live cool
// candidates — it caught radish and missed spinach, lettuce, Vates kale, mustard, arugula, chard and
// leek. Measured on live v_sow_candidates 2026-08-17.
//
// PROBE. latestSafeMs is not exported and should not be — the clamp is only meaningful through a
// window. This probe needs a clause class whose close date IS latestSafe, so the card's own label
// is a direct readout of it. PROBE_DAY sits after every open and before every close under test, so
// the window is always live and the label always dated.
//
// USES CLASS B ("after last frost"), NOT CLASS C. It was class C until 2026-09-01, when
// BUG-SOWCLASSC-001 moved class C's close from latestSafe to a spring bound (LF+14d) — "as soon as
// the soil can be worked" is an early-spring instruction and had been advertising August sow
// windows for spinach and peas. That fix deliberately severed the very property this probe relied
// on, so the probe moved rather than the fix.
//
// Class B is the right replacement and not merely a convenient one: sowEngine case 'B' closes at
// EXACTLY latestSafe (unchanged by that fix), and opens at LF + weeksMin (0 here), so the window is
// still live at PROBE_DAY. The eight assertions below are about the FALL clamp — hardiness grace
// and frost anchor — and never about which clause carries them; only the instrument changed, and
// every expected date below is unchanged from before the fix.
const PROBE_DAY = '2026-06-01';
function latestSafe(over = {}) {
  const { entry } = one(viewRow({
    variety_name: 'Clamp probe',
    start_method: 'direct_sow',
    direct_sow_timing: 'after last frost',
    days_to_maturity_max: 60,
    ...over,
  }), PROBE_DAY);
  const m = /through ([A-Z][a-z]{2} \d+)/.exec(entry?.windowLabel ?? '');
  return m ? m[1] : (entry?.windowLabel ?? null);
}

describe('V4-HARDYSET-001 fall hardiness set', () => {
  it('is the edible subset of frostClass\'s hardy band — one vocabulary, not two', () => {
    // The anti-drift guard. frostClass.js already answers "does this crop shrug off frost" for the
    // alert channel; this set must never become a second, disagreeing answer to the same question.
    // A slug added here without a frost band would also silently start emitting 40°F frost alerts.
    const band = new Set(fc.SLUGS_BY_BAND.hardy);
    const strays = [...FALL_HARDY_CROPS].filter((s) => !band.has(s)).sort();
    expect(
      strays,
      `not banded hardy in lambda/daily-plan/frostClass.js — band it there first: ${strays.join(', ')}`,
    ).toEqual([]);
    // Non-vacuity: an emptied set passes the diff above while silently restoring the 14d clamp for
    // everything. 27 slugs today; the floor is the panel's stated bar.
    expect(FALL_HARDY_CROPS.size).toBeGreaterThanOrEqual(25);
  });

  it('covers every crop the prose test missed', () => {
    for (const slug of ['spinach', 'lettuce', 'kale', 'mustard', 'arugula', 'chard', 'leek']) {
      expect(FALL_HARDY_CROPS.has(slug), slug).toBe(true);
    }
  });

  it('sow_notes no longer moves the answer, in either direction', () => {
    // The mutation proof that the regex is gone rather than merely supplemented. Prose that DID
    // match and prose that did NOT now give the same date for the same crop, and the prose that
    // used to buy 14 days buys nothing on a crop that does not stand frost.
    const HARDY_PROSE = 'Frost tolerant. Improves in flavor after a light frost.';
    expect(latestSafe({ crop_type_slug: 'spinach', sow_notes: '' })).toBe('Aug 30');
    expect(latestSafe({ crop_type_slug: 'spinach', sow_notes: HARDY_PROSE })).toBe('Aug 30');
    expect(latestSafe({ crop_type_slug: 'poppy', sow_notes: HARDY_PROSE })).toBe('Aug 13');
  });

  it('two packets of the same species agree — the prose lottery is gone', () => {
    // The reported symptom: live 2026-08-17, Lacinato kale read "Direct sow through Aug 25" and
    // Vates kale read "Sowing window passed", on nothing but a copywriter's phrasing. Same slug and
    // same dtm must now give the same date; the residual 2-day gap in prod is their real dtm gap
    // (62 vs 60), which is a difference the engine is entitled to have an opinion about.
    const lacinato = { crop_type_slug: 'kale', sow_notes: 'Frost tolerant.' };
    const vates = { crop_type_slug: 'kale', sow_notes: 'OR direct sow in midsummer for fall crop.' };
    expect(latestSafe(vates)).toBe(latestSafe(lacinato));
    expect(latestSafe(vates)).toBe('Aug 30');
    expect(latestSafe({ ...lacinato, days_to_maturity_max: 62 })).toBe('Aug 28');
  });

  it('the grace stays cool-season only — a hardy slug in a warm packet gains nothing', () => {
    // The old branch was already season-gated, which is why it had zero false positives. Widening
    // the predicate must not widen the gate: 82 live pepper candidates sit behind it.
    expect(latestSafe({ crop_type_slug: 'kale', sow_season: 'warm' })).toBe('Jul 16');      // FF-(60+14)
    expect(latestSafe({ crop_type_slug: 'kale', sow_season: 'cool_warm' })).toBe('Jul 23'); // FF-(60+7)
    expect(latestSafe({ crop_type_slug: 'pepper', sow_season: 'warm' })).toBe('Jul 16');
  });

  it('an establishment sowing keeps its own clamp — hardiness never overrides it', () => {
    // The hardy branch used to run FIRST, above the establishment check. On an establishment crop
    // dtm is days-to-BLOOM, so a grace computed from it is arithmetic on the wrong number — and it
    // runs the wrong way, TIGHTENING the window (FF+28-300 lands in the previous year). Nothing live
    // crossed that ordering while the predicate was prose; a crop-type set is wide enough to.
    const establishmentClamp = 'Aug 24'; // FF - 35
    expect(latestSafe({
      crop_type_slug: 'kale', lifecycle: 'biennial', grown_as: 'biennial', first_year_harvest: false,
    })).toBe(establishmentClamp);
    expect(latestSafe({
      crop_type_slug: 'kale', lifecycle: 'perennial', grown_as: 'perennial', days_to_maturity_max: 300,
    })).toBe(establishmentClamp);
  });

  it('a hardy slug with no days-to-maturity is still UNKNOWN where the clamp is REQUIRED', () => {
    // NULL must not become a date in either direction. A class-B clause ("after last frost") closes
    // at latestSafe, so with no days-to-maturity there is genuinely no computable close: the clause
    // is dropped and the packet asks for a profile rather than claiming a window it cannot compute.
    const { bucket } = one(viewRow({
      variety_name: 'No DTM', crop_type_slug: 'spinach', start_method: 'direct_sow',
      direct_sow_timing: 'after last frost', days_to_maturity_max: null,
    }), PROBE_DAY);
    expect(bucket).toBe('needs_profile');
  });

  it('but a class-C spring window does NOT need days-to-maturity (BUG-SOWCLASSC-001)', () => {
    // The counterpart, and the reason the assertion above had to move off class C. Until
    // 2026-09-01 class C also closed at latestSafe, so a cool annual with no DTM fell into
    // needs_profile — the engine refusing to say "sow it as soon as you can work the soil" purely
    // because it did not know when the crop would MATURE. Those are different questions: DTM tells
    // you when you will harvest, not when to sow, and class C's window is now derived from the
    // frost anchors at both ends (LF-42d .. LF+14d). Neither end is fabricated from a null.
    const { bucket } = one(viewRow({
      variety_name: 'No DTM class C', crop_type_slug: 'spinach', start_method: 'direct_sow',
      direct_sow_timing: 'as soon as the soil can be worked', days_to_maturity_max: null,
    }), PROBE_DAY);
    expect(bucket).not.toBe('needs_profile');
  });
});

// ── BUG-SOWCLASSC-001 — "as soon as the soil can be worked" is an EARLY-SPRING instruction ───────
// The reported symptom, in Dave's garden: spinach and peas still advertising a direct-sow window in
// late summer, because class C closed at latestSafe (the last date a sowing could still beat frost
// to a harvest) instead of at the end of the spring soil-working window. Two different questions,
// months apart. These pin the SHAPE of the window at both ends, not just that late-summer is shut —
// a fix that simply deleted class C would satisfy a September-only assertion.
describe('BUG-SOWCLASSC-001 class-C closes in spring, not at the frost-math limit', () => {
  const CLASS_C = {
    variety_name: 'Class C probe', start_method: 'direct_sow',
    direct_sow_timing: 'as soon as the soil can be worked', days_to_maturity_max: 45,
  };
  const openOn = (day, over = {}) => one(viewRow({ ...CLASS_C, ...over }), day).bucket;

  it('is SHUT on Sep 1 for spinach and peas — the reported symptom', () => {
    for (const slug of ['spinach', 'pea']) {
      expect(openOn('2026-09-01', { crop_type_slug: slug }), slug).not.toBe('direct_sow_now');
    }
  });

  it('is SHUT in high summer too, not merely past a September edge', () => {
    expect(openOn('2026-08-01', { crop_type_slug: 'spinach' })).not.toBe('direct_sow_now');
    expect(openOn('2026-07-01', { crop_type_slug: 'spinach' })).not.toBe('direct_sow_now');
  });

  it('is still OPEN in early spring — the instruction it actually encodes', () => {
    // Non-vacuity for the three assertions above: deleting class C outright would pass all of them
    // and fail this one. The window must still exist where it belongs.
    expect(openOn('2026-04-15', { crop_type_slug: 'spinach' })).toBe('direct_sow_now');
  });
});

// ── BUG-FROSTANCHORWRONG-001 — the two anchors, and which branch consumes which ───
// `FROST_ANCHORS.firstFallFrost` ('09-28') is a conservative SOWING-SAFETY MARGIN. It was being read
// in places that wanted an observed frost DATE — 31 days later at the median — and the two errors
// compounded silently because there was only ever one named quantity. The separation is now
// structural, and these guards pin the SEPARATION (which branch moves when which anchor moves),
// not the rationale for it.
//
// Every assertion below names the source edit that turns it red. All five were run against a
// mutated source and observed failing before being committed green; the mutation is stated inline.
describe('BUG-FROSTANCHORWRONG-001 alerting margin vs measured frost date', () => {
  const D = 86400000;
  const toMs = (mmdd, y = 2026) => Date.UTC(y, Number(mmdd.slice(0, 2)) - 1, Number(mmdd.slice(3)));
  // 'Oct 29' -> ms. Hand-rolled rather than `new Date('Oct 29 2026')`, whose parse is
  // implementation-defined and locale/TZ-sensitive — the exact class of thing a guard must not rest on.
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const labelToMs = (label, y = 2026) => {
    const [mon, day] = label.split(' ');
    return Date.UTC(y, MON.indexOf(mon), Number(day));
  };

  // Same PROBE_DAY readout as the V4-HARDYSET-001 block above, but with the anchors argument open so
  // an override can be pushed through bucketize. A class-C clause closes at EXACTLY latestSafe.
  function clampISO(over, anchors) {
    const row = viewRow({
      variety_name: 'Anchor probe',
      start_method: 'direct_sow',
      // Class B, for the reason given at the latestSafe() probe above: BUG-SOWCLASSC-001 moved
      // class C's close off latestSafe onto a spring bound, and this probe reads latestSafe.
      direct_sow_timing: 'after last frost',
      days_to_maturity_max: 60,
      ...over,
    });
    const buckets = bucketize([row], PROBE_DAY, anchors);
    const key = Object.keys(buckets).find((k) => buckets[k].length > 0);
    const label = buckets[key][0]?.windowLabel ?? '';
    return /through ([A-Z][a-z]{2} \d+)/.exec(label)?.[1] ?? label;
  }
  const HARDY = { crop_type_slug: 'spinach' };      // in FALL_HARDY_CROPS
  const NOT_HARDY = { crop_type_slug: 'poppy' };    // cool, absent from the set

  it('the two anchors are separate quantities and the margin is the earlier one', () => {
    // MUTATION: set OBSERVED_FIRST_FALL_FROST.medianMonthDay to '09-28' (i.e. "simplify" by
    // collapsing the two anchors back into one) and this goes red on the strict inequality.
    expect(FROST_ANCHORS.firstFallFrost < OBSERVED_FIRST_FALL_FROST.medianMonthDay).toBe(true);
    const gapDays = (toMs(OBSERVED_FIRST_FALL_FROST.medianMonthDay)
      - toMs(FROST_ANCHORS.firstFallFrost)) / D;
    expect(gapDays).toBe(31);
  });

  it('moving the SAFETY MARGIN moves the frost-killed branches and NOT the hardy one', () => {
    // The load-bearing guard. MUTATION: restore the old hardy branch
    // (`return ctx.FF + (28 - dtm) * DAY_MS`) in latestSafeMs and the hardy clamp starts tracking
    // firstFallFrost — the first and third assertions both go red.
    const base = clampISO(HARDY);
    const movedFF = clampISO(HARDY, { firstFallFrost: '10-18' }); // +20d on the margin
    expect(movedFF).toBe(base);

    const notHardyBase = clampISO(NOT_HARDY);
    const notHardyMoved = clampISO(NOT_HARDY, { firstFallFrost: '10-18' });
    expect(notHardyBase).toBe('Aug 13');   // FF (09-28) + 14 - 60
    expect(notHardyMoved).toBe('Sep 2');   // 10-18 + 14 - 60
  });

  it('moving the MEASURED anchor moves the hardy branch and NOT the frost-killed ones', () => {
    // The other half — proves the hardy branch really reads FFobs rather than merely ignoring FF.
    // MUTATION: change the hardy branch to any FF-relative expression and the first pair goes red.
    expect(clampISO(HARDY)).toBe('Aug 30');                                    // FFobs (10-29) - 60
    expect(clampISO(HARDY, { observedFirstFallFrost: '11-08' })).toBe('Sep 9'); // +10d
    expect(clampISO(NOT_HARDY, { observedFirstFallFrost: '11-08' })).toBe('Aug 13');
    expect(clampISO({ ...HARDY, sow_season: 'warm' }, { observedFirstFallFrost: '11-08' }))
      .toBe('Jul 16'); // FF - (60 + 14): hardiness never crosses the season gate
  });

  it('the measured stats are RECOMPUTED from first_frost_by_year, not asserted beside it', () => {
    // MUTATION: edit any one of the three *_month_day literals, or edit any single year's date in
    // first_frost_by_year, and this goes red. That is what stops the block being decoration.
    const b = OBSERVED_FIRST_FALL_FROST.measured_basis;
    const dates = Object.values(b.first_frost_by_year).slice().sort(); // all 10-xx/11-xx: lexical == chronological
    expect(dates).toHaveLength(b.years);
    expect(dates[0]).toBe(b.first_frost_earliest_month_day);
    expect(dates[dates.length - 1]).toBe(b.first_frost_latest_month_day);
    expect(dates[(dates.length - 1) / 2]).toBe(b.first_frost_median_month_day);
    // The three exported fields must be the same three numbers, not a second opinion.
    expect(OBSERVED_FIRST_FALL_FROST.earliestMonthDay).toBe(b.first_frost_earliest_month_day);
    expect(OBSERVED_FIRST_FALL_FROST.medianMonthDay).toBe(b.first_frost_median_month_day);
    expect(OBSERVED_FIRST_FALL_FROST.latestMonthDay).toBe(b.first_frost_latest_month_day);
  });

  it('one site has ONE frost measurement — storageDeadlines.json carries the same basis', () => {
    // src/lib may not import a Lambda, and storageDeadlines.json is a data file, so the measurement
    // exists in two places by necessity. This is the lockstep that keeps them one measurement — the
    // same pattern anchorDerive.test.js uses for watch.js's restated anchor.
    // MUTATION: change a digit in either copy's `query`, `years` or any *_month_day and this is red.
    // `what` and `instrument_limits` are deliberately NOT compared: both are per-consumer prose
    // (theirs names sweet-potato vines and its 10-10 backstop). Every field that is a MEASUREMENT is.
    const theirs = storageDeadlines.by_crop_type.sweet_potato.measured_basis;
    const mine = OBSERVED_FIRST_FALL_FROST.measured_basis;
    for (const k of ['query', 'source', 'source_url', 'years', 'first_frost_earliest_month_day',
      'first_frost_median_month_day', 'first_frost_latest_month_day', 'september_bounds',
      'reproduced_by']) {
      expect(mine[k], k).toEqual(theirs[k]);
    }
    expect(mine.first_frost_by_year).toEqual(theirs.first_frost_by_year);
  });

  it('the hardy clamp is bounded by the site 10-hour wall, computed independently', () => {
    // The upper bound that killed the old `FALL_GRACE_HARDY = 28`. Carrying that grace onto the
    // measured anchor aims a hardy sowing at 11-26, past the date cool-season growth stops here.
    // The wall comes from lambda/daily-plan/overwinter.js, a separate derivation (solar declination
    // from latitude) that knows nothing about frost — so this is a cross-check, not a restatement.
    // MUTATION: `return ctx.FFobs + (28 - dtm) * DAY_MS` — i.e. keep the measured anchor but carry
    // the old grace onto it — and the first assertion goes red by 17 days. Note that reverting the
    // WHOLE branch to `ctx.FF + (28 - dtm)` does NOT trip this one (Oct 26 is inside the wall); that
    // mutation is caught by the two anchor-movement guards above. The pair is what covers both.
    const wall = ow.persephoneDates(ow.SITE_LAT, 2026).closes; // '2026-11-0x'
    const latestMaturity = labelToMs(clampISO({ ...HARDY, days_to_maturity_max: 0 }));
    expect(latestMaturity).toBeLessThan(toMs(wall.slice(5)));
    // ...and not so conservative that it lands before frost has ever been recorded here — the
    // direction the original defect ran. MUTATION: `return ctx.FF - dtm * DAY_MS`, i.e. put the
    // hardy branch back on the safety margin, and this goes red (Sep 28 < Oct 10). Pinning it to
    // earliestMonthDay would sit exactly on this bound and pass, which is intended: 10-10 is a
    // defensible backstop reading, just a more conservative one than the median.
    expect(latestMaturity).toBeGreaterThanOrEqual(toMs(OBSERVED_FIRST_FALL_FROST.earliestMonthDay));
  });
});

// ── V4-FALLINDOORHARDY-001 — the fall INDOOR pass, re-keyed by hardiness ──────────
// BUG-FROSTANCHORWRONG-001 left this consumer on the margin and said why: the pass was keyed by
// sow_season alone, so its `cool` bucket held kale and cool-but-tender crops together and there was
// no branch to route. There is one now, and these guards pin the SPLIT — which arm moves when which
// anchor moves — rather than the rationale for it. The +3d delta is the same one the direct branch
// took, from the same pair of cancelling errors.
//
// Every assertion names the source edit that turns it red. All six were run against a mutated
// sowEngine.js, observed failing, and reverted from a lane-local copy before being committed green.
describe('V4-FALLINDOORHARDY-001 fall indoor pass — hardiness, not just season', () => {
  const D = 86400000;
  const toMs = (mmdd, y = 2026) => Date.UTC(y, Number(mmdd.slice(0, 2)) - 1, Number(mmdd.slice(3)));
  const isoToMsUTC = (iso) => Date.parse(`${iso}T00:00:00Z`);
  const shiftISO = (iso, n) => new Date(isoToMsUTC(iso) + n * D).toISOString().slice(0, 10);

  // The last day seed may be STARTED INDOORS for the fall pass, read off the engine.
  //
  // Read from `reopensOn` (the window's OPEN) rather than from a "through ..." label, and run on
  // PROBE_DAY: on Jun 1 the fall pass is still in the future under EVERY anchor override below, so
  // the readout never changes shape as the window slides. The window is a fixed 28 days wide
  // (`open: latest - 28 * DAY_MS`), so open + 28 is `latest`, the quantity under test.
  function fallIndoorLatest(over = {}, anchors) {
    const row = viewRow({
      variety_name: 'Fall indoor probe',
      start_method: 'start_indoors',      // no direct clauses: the fall INDOOR pass is the only window
      start_indoor_weeks_min: 3,
      start_indoor_weeks_max: 4,
      days_to_maturity_max: 60,
      sow_season: 'cool',
      ...over,
    });
    const { bucket, entry } = locate(bucketize([row], PROBE_DAY, anchors), 'Fall indoor probe');
    expect(bucket).toBe('hold');          // the readout's own precondition, asserted not assumed
    return shiftISO(entry.reopensOn, 28);
  }
  const HARDY = { crop_type_slug: 'kale' };       // in FALL_HARDY_CROPS
  const NOT_HARDY = { crop_type_slug: 'poppy' };  // cool, absent from the set

  it('hardy takes the measured anchor with no grace; tender keeps margin + grace', () => {
    // MUTATION: delete the `fallHardy` ternary in buildIndoorWindows (i.e. put the whole pass back on
    // `ctx.FF + (grace - dtm - slowdown - nursery)`) and the first assertion goes red at Aug 13.
    expect(fallIndoorLatest(HARDY)).toBe('2026-08-16');      // FFobs 10-29 - 60 - 14
    expect(fallIndoorLatest(NOT_HARDY)).toBe('2026-08-13');  // FF 09-28 + 28 - 60 - 14, unchanged
    // The two arms are 3 days apart and in that order — the whole delta of this item, stated once.
    expect((isoToMsUTC(fallIndoorLatest(HARDY)) - isoToMsUTC(fallIndoorLatest(NOT_HARDY))) / D).toBe(3);
  });

  it('moving the SAFETY MARGIN moves the tender arm and NOT the hardy one', () => {
    // MUTATION: route both arms to ctx.FF and the first assertion goes red (hardy starts tracking
    // the margin). This is the guard that makes the separation structural rather than numeric.
    expect(fallIndoorLatest(HARDY, { firstFallFrost: '10-18' })).toBe('2026-08-16');
    expect(fallIndoorLatest(NOT_HARDY, { firstFallFrost: '10-18' })).toBe('2026-09-02'); // +20d
  });

  it('moving the MEASURED anchor moves the hardy arm and NOT the tender one', () => {
    // The other half — proves the hardy arm really READS FFobs rather than merely ignoring FF.
    // MUTATION: route both arms to ctx.FFobs and the second assertion goes red.
    expect(fallIndoorLatest(HARDY, { observedFirstFallFrost: '11-08' })).toBe('2026-08-26'); // +10d
    expect(fallIndoorLatest(NOT_HARDY, { observedFirstFallFrost: '11-08' })).toBe('2026-08-13');
  });

  it('cool_warm keeps the margin even for a hardy slug — hardiness never crosses the season gate', () => {
    // latestSafeMs routes cool_warm to a strictly TIGHTER clamp (FF - dtm - 7) regardless of
    // hardiness, so widening it here would make the indoor pass more permissive than the direct one
    // for the same packet. 4 live cool_warm candidates carry a hardy slug.
    // MUTATION: drop `candidate.sow_season === 'cool' &&` from the fallHardy predicate and both
    // assertions go red (Jul 30 -> Aug 16).
    const coolWarmHardy = { ...HARDY, sow_season: 'cool_warm' };
    expect(fallIndoorLatest(coolWarmHardy)).toBe('2026-07-30'); // FF + 14 - 60 - 14
    expect(fallIndoorLatest(coolWarmHardy, { observedFirstFallFrost: '11-08' })).toBe('2026-07-30');
  });

  it('the V4-MATURITYBASIS nursery shift is IDENTICAL on both arms', () => {
    // The interaction BUG-FROSTANCHORWRONG-001 flagged as the reason this re-key was not a constant
    // swap. It resolves in the helpful direction: the nursery term shifts `latest` back by the same
    // number of days whichever anchor `latest` is measured from, so the basis correction and the
    // anchor are orthogonal and a future re-derivation of the offset measures only the offset.
    // Asserted as a computed SHIFT, never as two literals — a guard on two constants would survive
    // the mutation it exists to catch. MUTATION: apply nurseryDays on only one arm and this is red.
    const TX = { dtm_basis: 'from-transplant' };  // weeks 3-4 -> wMax 4 -> nursery 28d
    const shift = (over) => (isoToMsUTC(fallIndoorLatest(over)) - isoToMsUTC(fallIndoorLatest({ ...over, ...TX }))) / D;
    expect(shift(HARDY)).toBe(28);
    expect(shift(NOT_HARDY)).toBe(28);
    expect(shift(HARDY)).toBe(shift(NOT_HARDY));
  });

  it('hardy maturity lands inside the 10-hour wall, FALL_SLOWDOWN_DAYS before measured frost', () => {
    // The structural bound, computed from the exports rather than pinned as a date: dropping the
    // grace is what keeps `latest + nursery + dtm` at FFobs - slowdown instead of past it.
    //
    // The two assertions are ordered so each has its OWN mutation rather than the first masking the
    // second (vitest stops a test at the first failing expect).
    //   * The WALL bound: MUTATION carry the grace onto the hardy arm (`ctx.FFobs + (grace - dtm -
    //     slowdown - nursery)`) — maturity lands 2026-11-12, past the 2026-11-07 wall, red. This is
    //     the over-correction that killed the old FALL_GRACE_HARDY on the direct branch, caught here
    //     on the indoor one. The wall comes from lambda/daily-plan/overwinter.js, derived from solar
    //     declination and latitude with no knowledge of frost, so it is an independent cross-check
    //     rather than a restatement of the anchor.
    //   * The SLOWDOWN relation: MUTATION put the hardy arm back on ctx.FF, with or without the
    //     branch — red at 17 (grace kept) or 45 (grace dropped), i.e. it catches the defect in the
    //     original direction too.
    const maturity = isoToMsUTC(fallIndoorLatest(HARDY)) + 60 * D; // latest + dtm, nursery 0
    const wall = ow.persephoneDates(ow.SITE_LAT, 2026).closes;
    expect(maturity).toBeLessThan(toMs(wall.slice(5)));
    expect((toMs(OBSERVED_FIRST_FALL_FROST.medianMonthDay) - maturity) / D).toBe(FALL_SLOWDOWN_DAYS);
  });
});
