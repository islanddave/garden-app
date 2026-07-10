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
  FALL_SLOWDOWN_DAYS,
  FALL_GRACE_DAYS,
  bucketize,
  classifyClause,
  splitClauses,
} from '../lib/sowEngine.js';

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
  radicchioPallaRossa: {"name": "Palla Rossa Mavrik Radicchio Seeds", "crop": "Radicchio", "variety": "Palla Rossa Mavrik", "quantity_on_hand": 1, "vendor": "Botanical Interests", "source": "Botanical Interests online order; captured 2026-06-10 as official seed->plant pipeline seeding", "source_url": null, "purchase_date": "2026-06-09", "price_usd": 1.35, "sku": "3119", "metadata": {"seeds_per_packet": null, "organic": false, "heirloom": false, "item_category": "vegetable"}, "crop_type_slug_guess": "endive", "sow_profile": {"life_cycle": "biennial", "season": "cool", "sun": "full sun", "start_method": "both", "start_indoor_weeks_before_lastfrost": "8-10", "direct_sow_timing": "8-10 weeks before first fall frost (late June to early July for Oct 1 target)", "sow_depth_in": "0.25", "seed_spacing_in": "8-10", "row_spacing_in": "12", "days_to_germ": "5-15", "days_to_maturity": "80-95", "zone_notes": "Primarily a fall crop: start indoors or direct sow in late June–early July so heads mature as temps cool in September. Cool temps trigger head formation and reduce bitterness. Spring starts often bolt. Harvest before hard freeze in zone 5b.", "packet_notes": "Chioggia-type radicchio; will not head properly without cool fall temperatures. Bitter flavor mellows when cooked. Biennial grown as annual. Frost tolerant."}, "origin": "BI-order-2026-06-09"},
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

  it('bucketize returns all seven buckets even for empty input', () => {
    expect(Object.keys(bucketize([], TODAY)).sort()).toEqual([
      'direct_sow_now', 'hold', 'needs_profile', 'sow_inside_anytime',
      'start_indoors_now', 'too_late', 'window_closing',
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
  // spring window open through latest_safe = FF+14-dtm = Aug 13, so Jul 10 is
  // an open direct window. Rules win per build direction.
  it('Spinach Oceanside -> direct_sow_now via class D (rules) [golden said hold ~Aug 20]', () => {
    const { bucket, entry } = locate(golden(), 'Oceanside');
    expect(bucket).toBe('direct_sow_now');
    expect(entry.daysLeft).toBe(34); // open until Aug 13
  });

  it('Lettuce Black Seeded Simpson -> direct_sow_now (class D through Aug 23)', () => {
    const { bucket, entry } = locate(golden(), 'Black Seeded Simpson');
    expect(bucket).toBe('direct_sow_now');
    expect(entry.daysLeft).toBe(44);
    expect(entry.action).toBe('direct_sow');
  });

  it('Hollyhock The Watchman -> direct_sow_now (class H summer window open)', () => {
    const { bucket, entry } = locate(golden(), 'The Watchman');
    expect(bucket).toBe('direct_sow_now');
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

  it('Onion Monastrell -> too_late (all windows past, incl. fall pass ended Jun 24)', () => {
    expect(locate(golden(), 'Monastrell').bucket).toBe('too_late');
  });

  it('Broccoli Belstar -> start_indoors_now (cool fall pass opens day-of Jul 10)', () => {
    const { bucket, entry } = locate(golden(), 'Belstar');
    expect(bucket).toBe('start_indoors_now');
    expect(entry.action).toBe('start_indoors');
    // Rules: latest = FF + 28 - 66 - 14 = Aug 7 (panel note said Jul 24; the
    // rules' grace/slowdown arithmetic gives Aug 7 — bucket is unchanged).
    expect(entry.daysLeft).toBe(28);
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

  // PANEL GOLDEN DEVIATION: panel expected window_closing. Under the rules the
  // fall indoor pass closed Jul 9 (FF+28-95-14) and the class E direct window
  // [FF-10w, FF-8w] = [Jul 20, Aug 3] (close clamped to Jul 23 by the
  // cool-hardy latest_safe) has not opened yet -> hold with reopensOn Jul 20.
  it('Radicchio Palla Rossa -> hold, reopens Jul 20 (rules) [golden said window_closing]', () => {
    const { bucket, entry } = locate(golden(), 'Palla Rossa Mavrik');
    expect(bucket).toBe('hold');
    expect(entry.reopensOn).toBe('2026-07-20');
    expect(entry.action).toBe('direct_sow');
  });

  it('spreads the twelve packets across six buckets with no leftovers', () => {
    const buckets = golden();
    const counts = Object.fromEntries(
      Object.entries(buckets).map(([k, v]) => [k, v.length]),
    );
    expect(counts).toEqual({
      start_indoors_now: 1, // broccoli
      direct_sow_now: 3,    // spinach, lettuce, hollyhock (see deviations)
      sow_inside_anytime: 0,
      window_closing: 2,    // cucumber, pea
      hold: 2,              // columbine, radicchio
      too_late: 3,          // biquinho, black krim, onion
      needs_profile: 1,     // california wonder
    });
  });
});
