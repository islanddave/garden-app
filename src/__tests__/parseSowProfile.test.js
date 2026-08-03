// V4-SEEDINV-001 — parseSowProfile contract tests.
// Fixtures are real packets from /tmp/seed-load-dataset-V1.json, embedded
// verbatim (CI has no dataset file).
import { describe, it, expect } from 'vitest';
import {
  CROP_TYPE_SLUGS,
  parseRange,
  parseNumericLow,
  parseLifecycle,
  parseSun,
  parseSeason,
  parseStartMethod,
  packetToVarietyCols,
  packetToInventoryPayload,
  slugifyCropName,
  checkCropGuess,
  CROP_GUESS_SYNONYMS,
} from '../lib/parseSowProfile.js';

// Real packets from /tmp/seed-load-dataset-V1.json (garden.seed_load_dataset.v1),
// embedded verbatim so CI needs no dataset file.
const PACKETS = {
  biquinho: {"name": "Red and Yellow Blend Biquinho Chile Pepper Seeds", "crop": "Pepper, Chile", "variety": "Biquinho Red & Yellow Blend", "quantity_on_hand": 1, "vendor": "Botanical Interests", "source": "Botanical Interests online order; captured 2026-06-10 as official seed->plant pipeline seeding", "source_url": null, "purchase_date": "2026-06-09", "price_usd": 1.5, "sku": "0074", "metadata": {"seeds_per_packet": "1", "organic": false, "heirloom": false, "item_category": "vegetable"}, "crop_type_slug_guess": "pepper", "sow_profile": {"life_cycle": "tender perennial (grown as annual)", "season": "warm", "sun": "full sun", "start_method": "start indoors", "start_indoor_weeks_before_lastfrost": "8-10", "direct_sow_timing": null, "sow_depth_in": "0.25", "seed_spacing_in": "18", "row_spacing_in": "18-24", "days_to_germ": "10-21", "days_to_maturity": null, "zone_notes": "Start indoors mid-March; transplant after May 20 (valley). Long-season pepper — western MA's 120-day window is tight. Prioritize early indoor start and warm transplant site. Can be overwintered indoors as a container plant.", "packet_notes": "Capsicum chinense. Mild, only 1,000-2,000 Scoville units. Teardrop-shaped fruits 0.75-1.25\" ripen to red or golden yellow. Brazilian specialty pepper. Long season; needs warmth to produce well. Can overwinter indoors."}, "origin": "BI-order-2026-06-09"},
  californiaWonder: {"name": "California Wonder (Pepper, Sweet)", "crop": "Pepper, Sweet", "variety": "California Wonder", "quantity_on_hand": 1, "vendor": "Botanical Interests", "source": "Botanical Interests packet", "source_url": null, "purchase_date": null, "price_usd": null, "sku": null, "metadata": {"seeds_per_packet": null, "organic": null, "heirloom": null}, "crop_type_slug_guess": "pepper", "sow_profile": null, "origin": "physical-packet-photo-2026-06-05", "needs_confirmation": ["seed_count", "price", "acquired_date"]},
  hollyhockWatchman: {"name": "The Watchman Hollyhock Seeds", "crop": "Hollyhock", "variety": "The Watchman", "quantity_on_hand": 1, "vendor": "Botanical Interests", "source": "Botanical Interests online order; captured 2026-06-10 as official seed->plant pipeline seeding", "source_url": null, "purchase_date": "2026-06-09", "price_usd": 1.35, "sku": "1225", "metadata": {"seeds_per_packet": null, "organic": false, "heirloom": false, "item_category": "flower"}, "crop_type_slug_guess": null, "sow_profile": {"life_cycle": "biennial", "season": "cool/warm", "sun": "full sun", "start_method": "both", "start_indoor_weeks_before_lastfrost": "6-8", "direct_sow_timing": "after last frost or in summer for next-year bloom", "sow_depth_in": "0.125", "seed_spacing_in": "18-24", "row_spacing_in": "24-36", "days_to_germ": "10-14", "days_to_maturity": null, "zone_notes": "Biennial: start indoors in spring or direct sow in summer; plants establish first year, bloom second summer. Hardy to zone 2 — fully winter-hardy in Conway and South Deerfield. Plant in a sheltered spot for the tall 5–7' stalks.", "packet_notes": "Deep near-black burgundy flowers. Heirloom. Self-sows freely once established. Susceptible to hollyhock rust — avoid overhead watering. Excellent pollinator and hummingbird plant. Tall background or fence plant."}, "origin": "BI-order-2026-06-09"},
  columbineMcKana: {"name": "McKana Giants Blend Columbine Seeds", "crop": "Columbine", "variety": "McKana Giants Blend", "quantity_on_hand": 1, "vendor": "Botanical Interests", "source": "Botanical Interests online order; captured 2026-06-10 as official seed->plant pipeline seeding", "source_url": null, "purchase_date": "2026-06-09", "price_usd": 1.35, "sku": "1007", "metadata": {"seeds_per_packet": null, "organic": false, "heirloom": false, "item_category": "flower"}, "crop_type_slug_guess": null, "sow_profile": {"life_cycle": "perennial", "season": "cool/warm", "sun": "full sun to part shade", "start_method": "both", "start_indoor_weeks_before_lastfrost": "10-12", "direct_sow_timing": "fall sow for spring germination, or early spring when soil is cold", "sow_depth_in": "0.125", "seed_spacing_in": "18-24", "row_spacing_in": "24-36", "days_to_germ": "21-25", "days_to_maturity": null, "zone_notes": "Perennial; blooms spring of second year from a spring sowing. Start indoors February–March (10–12 wks before May 20) for possible first-year bloom. Cold stratification recommended — fall direct sow works well in western MA. AAS winner; vigorous and reliable.", "packet_notes": "AAS 1955 winner. Large 3\" bi-color flowers; tall 24–36\" plants. Cold stratification improves germination. Blooms spring to early summer. Hummingbird and pollinator magnet. Self-sows. Deer resistant."}, "origin": "BI-order-2026-06-09"},
  cucumberSpacemaster: {"name": "Spacemaster 80 Cucumber Seeds", "crop": "Cucumber", "variety": "Spacemaster 80", "quantity_on_hand": 1, "vendor": "Botanical Interests", "source": "Botanical Interests online order; captured 2026-06-10 as official seed->plant pipeline seeding", "source_url": null, "purchase_date": "2026-06-09", "price_usd": 1.35, "sku": "0020", "metadata": {"seeds_per_packet": "2", "organic": false, "heirloom": false, "item_category": "vegetable"}, "crop_type_slug_guess": "cucumber", "sow_profile": {"life_cycle": "annual", "season": "warm", "sun": "full sun", "start_method": "both", "start_indoor_weeks_before_lastfrost": "3-4", "direct_sow_timing": "after last frost when soil ≥60°F", "sow_depth_in": "0.5-1", "seed_spacing_in": "12", "row_spacing_in": "36-48", "days_to_germ": "7-10", "days_to_maturity": "62", "zone_notes": "Direct sow after May 20 once soil reaches 60°F, or start indoors 3–4 weeks before last frost. Compact bush/short-vine habit is ideal for small spaces and containers. 62-day DTM fits the ~120-day frost-free season comfortably.", "packet_notes": "Compact 2–3' vines — good for containers and small gardens. Disease resistant (CMV, downy/powdery mildew, scab). Bush-type, can be grown without a trellis. Keep picked for continued production."}, "origin": "BI-order-2026-06-09"},
  peaCascadia: {"name": "Cascadia Snap Pea Seeds", "crop": "Pea, Snap", "variety": "Cascadia", "quantity_on_hand": 1, "vendor": "Botanical Interests", "source": "Botanical Interests online order; captured 2026-06-10 as official seed->plant pipeline seeding", "source_url": null, "purchase_date": "2026-06-09", "price_usd": 1.75, "sku": "3218", "metadata": {"seeds_per_packet": "15", "organic": false, "heirloom": false, "item_category": "vegetable"}, "crop_type_slug_guess": "other", "sow_profile": {"life_cycle": "annual", "season": "cool", "sun": "full sun", "start_method": "direct sow", "start_indoor_weeks_before_lastfrost": null, "direct_sow_timing": "4-6 wks before last frost when soil ≥40°F; succession sow again 10-12 wks before first fall frost", "sow_depth_in": "1", "seed_spacing_in": "2-3", "row_spacing_in": "18-24", "days_to_germ": "7-14", "days_to_maturity": "58", "zone_notes": "Direct sow around mid-Apr in South Deerfield (soil permitting), late Apr in Conway hilltown. 58-day maturity fits comfortably before summer heat sets in. Second sowing ~late Jul for fall crop.", "packet_notes": "Short 30\" self-supporting vines — minimal staking. Stringless, 3\" pods produced two per cluster. Resistant to pea enation mosaic virus and powdery mildew. Direct sow only — dislikes transplant."}, "origin": "BI-order-2026-06-09"},
  radicchioPallaRossa: {"name": "Palla Rossa Mavrik Radicchio Seeds", "crop": "Radicchio", "variety": "Palla Rossa Mavrik", "quantity_on_hand": 1, "vendor": "Botanical Interests", "source": "Botanical Interests online order; captured 2026-06-10 as official seed->plant pipeline seeding", "source_url": null, "purchase_date": "2026-06-09", "price_usd": 1.35, "sku": "3119", "metadata": {"seeds_per_packet": null, "organic": false, "heirloom": false, "item_category": "vegetable"}, "crop_type_slug_guess": "radicchio", "sow_profile": {"life_cycle": "biennial", "season": "cool", "sun": "full sun", "start_method": "both", "start_indoor_weeks_before_lastfrost": "8-10", "direct_sow_timing": "8-10 weeks before first fall frost (late June to early July for Oct 1 target)", "sow_depth_in": "0.25", "seed_spacing_in": "8-10", "row_spacing_in": "12", "days_to_germ": "5-15", "days_to_maturity": "80-95", "zone_notes": "Primarily a fall crop: start indoors or direct sow in late June–early July so heads mature as temps cool in September. Cool temps trigger head formation and reduce bitterness. Spring starts often bolt. Harvest before hard freeze in zone 5b.", "packet_notes": "Chioggia-type radicchio; will not head properly without cool fall temperatures. Bitter flavor mellows when cooked. Biennial grown as annual. Frost tolerant."}, "origin": "BI-order-2026-06-09"},
};

describe('parseRange', () => {
  it.each([
    ['6-8', 6, 8],
    ['3', 3, 3],
    ['7-14', 7, 14],
    ['10-12', 10, 12],
    ['25-60', 25, 60],
    ['1–2', 1, 2], // en dash
    [' 4 - 6 ', 4, 6],
    ['80-90 days', 80, 90],
    [62, 62, 62], // numeric passthrough
    ['', null, null],
    [null, null, null],
    [undefined, null, null],
    ['n/a', null, null],
    [NaN, null, null],
  ])('parseRange(%j) -> {min:%j, max:%j}', (input, min, max) => {
    expect(parseRange(input)).toEqual({ min, max });
  });
});

describe('parseNumericLow', () => {
  it.each([
    ['0.5-1', 0.5],
    ['0', 0],
    ['0.125', 0.125],
    ['36-48', 36],
    ['18-24', 18],
    ['12', 12],
    [0.25, 0.25],
    ['', null],
    [null, null],
    ['none', null],
  ])('parseNumericLow(%j) -> %j', (input, expected) => {
    expect(parseNumericLow(input)).toBe(expected);
  });
});

describe('parseLifecycle', () => {
  it.each([
    ['annual', 'annual', null],
    ['perennial', 'perennial', null],
    ['biennial', 'biennial', null],
    ['tender perennial', 'tender_perennial', null],
    // both "grown as annual" forms present in the dataset:
    ['biennial grown as annual', 'biennial', 'annual'],
    ['tender perennial (grown as annual)', 'tender_perennial', 'annual'],
    ['Tender Perennial (Grown As Annual)', 'tender_perennial', 'annual'],
    ['perennial grown as an annual', 'perennial', 'annual'],
    ['hardy shrub', null, null],
    [null, null, null],
    ['', null, null],
  ])('parseLifecycle(%j) -> {%j, %j}', (input, lifecycle, grownAs) => {
    expect(parseLifecycle(input)).toEqual({ lifecycle, grown_as: grownAs });
  });
});

describe('parseSun', () => {
  it.each([
    ['full sun', 'full_sun'],
    ['full sun to part shade', 'full_sun'], // nuance collapses to sunniest
    ['part shade', 'part_shade'],
    ['part sun', 'part_sun'],
    ['part sun to part shade', 'part_sun'],
    ['full shade', 'full_shade'],
    ['Full Sun', 'full_sun'],
    ['dappled', null],
    [null, null],
  ])('parseSun(%j) -> %j', (input, expected) => {
    expect(parseSun(input)).toBe(expected);
  });
});

describe('parseSeason', () => {
  it.each([
    ['cool', 'cool'],
    ['warm', 'warm'],
    ['cool/warm', 'cool_warm'],
    ['cool_warm', 'cool_warm'],
    ['Cool/Warm', 'cool_warm'],
    ['warm-cool', 'cool_warm'],
    ['hot', null],
    [null, null],
  ])('parseSeason(%j) -> %j', (input, expected) => {
    expect(parseSeason(input)).toBe(expected);
  });
});

describe('parseStartMethod', () => {
  it.each([
    ['both', 'both'],
    ['direct sow', 'direct_sow'],
    ['Direct Sow', 'direct_sow'],
    ['start indoors', 'start_indoors'],
    ['indoors only', 'indoors_only'],
    ['indoors year-round', 'indoors_only'],
    ['scatter', null],
    [null, null],
  ])('parseStartMethod(%j) -> %j', (input, expected) => {
    expect(parseStartMethod(input)).toBe(expected);
  });
});

describe('packetToVarietyCols', () => {
  it('maps Cucumber Spacemaster 80 (ranges, depth low-end, fidelity lines)', () => {
    const v = packetToVarietyCols(PACKETS.cucumberSpacemaster);
    expect(v.name).toBe('Spacemaster 80');
    expect(v.species).toBeNull();
    expect(v.crop_type_slug).toBe('cucumber');
    expect(v.lifecycle).toBe('annual');
    expect(v.grown_as).toBeNull();
    expect(v.sow_season).toBe('warm');
    expect(v.sun_requirements).toBe('full_sun');
    expect(v.start_method).toBe('both');
    expect(v.start_indoor_weeks_min).toBe(3);
    expect(v.start_indoor_weeks_max).toBe(4);
    expect(v.days_to_maturity_min).toBe(62);
    expect(v.days_to_maturity_max).toBe(62);
    expect(v.days_to_germ_min).toBe(7);
    expect(v.days_to_germ_max).toBe(10);
    expect(v.sow_depth_in).toBe(0.5); // "0.5-1" -> low end
    expect(v.seed_spacing_in).toBe(12);
    expect(v.row_spacing_in).toBe(36); // "36-48" -> low end
    // Range fidelity preserved in sow_notes
    expect(v.sow_notes).toContain('Depth: 0.5-1 in');
    expect(v.sow_notes).toContain('Row spacing: 36-48 in');
    expect(v.sow_notes).not.toContain('Seed spacing:'); // "12" was not a range
    // zone_notes first, packet_notes second
    expect(v.sow_notes.startsWith(PACKETS.cucumberSpacemaster.sow_profile.zone_notes)).toBe(true);
    expect(v.sow_notes).toContain(PACKETS.cucumberSpacemaster.sow_profile.packet_notes);
  });

  it('maps Hollyhock The Watchman (biennial, null dtm, both spacing ranges collapsed)', () => {
    const v = packetToVarietyCols(PACKETS.hollyhockWatchman);
    expect(v.name).toBe('The Watchman');
    expect('crop_type_slug' in v).toBe(false); // null guess omitted
    expect(v.lifecycle).toBe('biennial');
    expect(v.grown_as).toBeNull();
    expect(v.sow_season).toBe('cool_warm'); // 'cool/warm'
    expect(v.days_to_maturity_min).toBeNull();
    expect(v.days_to_maturity_max).toBeNull();
    expect(v.seed_spacing_in).toBe(18);
    expect(v.row_spacing_in).toBe(24);
    expect(v.sow_notes).toContain('Seed spacing: 18-24 in');
    expect(v.sow_notes).toContain('Row spacing: 24-36 in');
  });

  it('maps Chile Biquinho (tender perennial grown as annual, indoor-start only)', () => {
    const v = packetToVarietyCols(PACKETS.biquinho);
    expect(v.lifecycle).toBe('tender_perennial');
    expect(v.grown_as).toBe('annual');
    expect(v.start_method).toBe('start_indoors');
    expect(v.start_indoor_weeks_min).toBe(8);
    expect(v.start_indoor_weeks_max).toBe(10);
    expect(v.direct_sow_timing).toBeNull();
    expect(v.crop_type_slug).toBe('pepper');
  });

  it('maps Columbine McKana (sun nuance collapsed into sow_notes)', () => {
    const v = packetToVarietyCols(PACKETS.columbineMcKana);
    expect(v.sun_requirements).toBe('full_sun');
    expect(v.sow_notes).toContain('Sun: full sun to part shade');
    expect(v.sow_season).toBe('cool_warm');
    expect(v.days_to_germ_min).toBe(21);
    expect(v.days_to_germ_max).toBe(25);
  });

  it('omits crop_type_slug for "other" guesses (Pea Cascadia)', () => {
    const v = packetToVarietyCols(PACKETS.peaCascadia);
    expect('crop_type_slug' in v).toBe(false);
    expect(v.start_method).toBe('direct_sow');
    expect(v.days_to_maturity_min).toBe(58);
  });

  // V4-RADICCHIO-001: this case previously asserted Radicchio -> endive, locking in a wrong-but-valid
  // slug (endive is Cichorium endivia; Palla Rossa Mavrik is C. intybus). The gate keeps whitelisted
  // guesses without questioning them, so the dataset guess must be right at the source.
  it('keeps whitelisted guesses (Radicchio -> radicchio)', () => {
    expect(CROP_TYPE_SLUGS).toContain('radicchio');
    const v = packetToVarietyCols(PACKETS.radicchioPallaRossa);
    expect(v.crop_type_slug).toBe('radicchio');
    expect(v.lifecycle).toBe('biennial');
    expect(v.days_to_maturity_max).toBe(95);
  });

  it('null sow_profile -> every sow field null (Sweet California Wonder)', () => {
    const v = packetToVarietyCols(PACKETS.californiaWonder);
    expect(v.name).toBe('California Wonder');
    expect(v.crop_type_slug).toBe('pepper');
    for (const field of [
      'lifecycle', 'grown_as', 'days_to_maturity_min', 'days_to_maturity_max',
      'sun_requirements', 'start_method', 'start_indoor_weeks_min',
      'start_indoor_weeks_max', 'direct_sow_timing', 'sow_depth_in',
      'seed_spacing_in', 'row_spacing_in', 'days_to_germ_min',
      'days_to_germ_max', 'sow_season', 'sow_notes',
    ]) {
      expect(v[field], field).toBeNull();
    }
  });
});

describe('packetToInventoryPayload', () => {
  const IDS = { variety_id: 'var-123', created_by: 'user_3D2gM0hIl03gjW3JM2DjtPzm0jI' };

  it('builds a seeds inventory insert payload (Cucumber Spacemaster 80)', () => {
    const p = packetToInventoryPayload(PACKETS.cucumberSpacemaster, IDS);
    expect(p).toMatchObject({
      type: 'consumable',
      category: 'seeds',
      unit: 'packet',
      status: 'active',
      name: 'Spacemaster 80 Cucumber Seeds',
      quantity_on_hand: 1,
      purchase_date: '2026-06-09',
      unit_cost: 1.35,
      notes: null,
      variety_id: 'var-123',
      created_by: 'user_3D2gM0hIl03gjW3JM2DjtPzm0jI',
    });
    expect(p.source).toContain('Botanical Interests online order');
    expect(p.metadata).toMatchObject({
      seeds_per_packet: '2',
      sku: '0020',
      vendor: 'Botanical Interests',
      origin: 'BI-order-2026-06-09',
    });
    expect(p.metadata.needs_confirmation).toBeUndefined();
    expect(JSON.stringify(p.metadata).length).toBeLessThan(8192);
  });

  it('preserves needs_confirmation for null-profile packets (California Wonder)', () => {
    const p = packetToInventoryPayload(PACKETS.californiaWonder, IDS);
    expect(p.metadata.needs_confirmation).toEqual(['seed_count', 'price', 'acquired_date']);
    expect(p.purchase_date).toBeNull();
    expect(p.unit_cost).toBeNull();
    expect(p.quantity_on_hand).toBe(1);
  });

  it('coerces string quantity_on_hand and defaults missing quantity to 1', () => {
    const base = PACKETS.cucumberSpacemaster;
    expect(packetToInventoryPayload({ ...base, quantity_on_hand: '3' }, IDS).quantity_on_hand).toBe(3);
    expect(packetToInventoryPayload({ ...base, quantity_on_hand: null }, IDS).quantity_on_hand).toBe(1);
  });

  it('throws when metadata would exceed the 8192-byte DB CHECK', () => {
    const bloated = {
      ...PACKETS.cucumberSpacemaster,
      metadata: { blob: 'x'.repeat(9000) },
    };
    expect(() => packetToInventoryPayload(bloated, IDS)).toThrow(/8192/);
  });
});

// ── V4-CROPGUESS-001 — crop-guess cross-check (croptype-mistyping-20260721 Pending 1) ────────
// The prevention for L-286's defect class: a slug can be VALID and still be WRONG. Three real
// instances shipped this way (Radicchio->endive, Chervil->parsley, Borage->basil), each passing
// every existing guard because none compared the guess to the packet's own crop name.
describe('slugifyCropName', () => {
  it('normalises the comma-head form (a subtype, not a disagreement)', () => {
    expect(slugifyCropName('Pepper, Chile')).toBe('pepper');
    expect(slugifyCropName('Basil, Holy (Tulsi)')).toBe('basil');
  });
  it('strips parentheticals', () => {
    expect(slugifyCropName('Potato (true seed)')).toBe('potato');
    expect(slugifyCropName('Eggplant (ornamental)')).toBe('eggplant');
  });
  it('lowercases and underscores multi-word crops', () => {
    expect(slugifyCropName('Winter Squash')).toBe('winter_squash');
    expect(slugifyCropName('Chinese Broccoli (Gai Lan)')).toBe('chinese_broccoli');
  });
  it('is total over junk input', () => {
    for (const v of [null, undefined, '', '   ', '---']) expect(slugifyCropName(v)).toBe('');
  });
});

describe('checkCropGuess', () => {
  const pk = (crop, crop_type_slug_guess) => ({ crop, crop_type_slug_guess });

  it('accepts a guess that agrees with the packet crop', () => {
    expect(checkCropGuess(pk('Tomato', 'tomato')).status).toBe('match');
    expect(checkCropGuess(pk('Tomato', 'tomato')).slug).toBe('tomato');
  });

  it('accepts a reviewed synonym', () => {
    // V4-CROPSPLIT-001: was pk('Winter Squash', 'squash') -> synonym/squash. That synonym existed
    // ONLY because winter_squash had no slug of its own, and it is now deleted. Pumpkin is the
    // surviving reviewed synonym: pumpkins ARE winter squash (zero behavioural columns differ, and
    // the label cross-cuts species — Howden is C. pepo, Cinderella C. maxima).
    const r = checkCropGuess(pk('Pumpkin', 'winter_squash'));
    expect(r.status).toBe('synonym');
    expect(r.slug).toBe('winter_squash');
  });

  it('a Winter Squash packet guessing the old conflated slug is now UNRESOLVED', () => {
    // The regression guard for the split itself. Before V4-CROPSPLIT-001 this resolved to 'squash'
    // and silently bound winter squash to the SUMMER squash cadence (repeat/2d). If someone
    // re-adds winter_squash -> squash to CROP_GUESS_SYNONYMS, this fails.
    expect(checkCropGuess(pk('Winter Squash', 'squash')).status).toBe('unresolved');
    expect(checkCropGuess(pk('Winter Squash', 'winter_squash')).status).toBe('match');
  });

  it('scallion steers to bunching_onion, not the bulb onion slug', () => {
    // 'Scallion' slugifies to `scallion`, which reaches bunching_onion via the synonym map — so
    // the correct status is 'synonym', not 'match'. A packet whose crop IS 'Bunching Onion'
    // matches directly.
    expect(checkCropGuess(pk('Scallion', 'bunching_onion')).status).toBe('synonym');
    expect(checkCropGuess(pk('Bunching Onion', 'bunching_onion')).status).toBe('match');
    // Guessing the bulb slug for a scallion packet must NOT quietly pass — bulb onion is
    // harvest_habit='single', which is the defect the onion split exists to fix.
    expect(checkCropGuess(pk('Scallion', 'onion')).status).toBe('unresolved');
  });

  it('does NOT accept an arbitrary mismatch just because the synonym KEY exists', () => {
    // pumpkin is a known key, but only ever maps to winter_squash. Any other target must not ride it.
    expect(checkCropGuess(pk('Pumpkin', 'melon')).status).toBe('unresolved');
  });

  // The three real defects. Each was VALID and each was WRONG.
  it('flags Radicchio -> endive as unresolved (C. intybus vs C. endivia)', () => {
    const r = checkCropGuess(pk('Radicchio', 'endive'));
    expect(r.status).toBe('unresolved');
    expect(r.slug).toBeNull();
  });
  it('flags Chervil -> parsley as unresolved (Anthriscus vs Petroselinum)', () => {
    expect(checkCropGuess(pk('Chervil', 'parsley')).status).toBe('unresolved');
  });
  it('flags Borage -> basil as unresolved (Borago vs Ocimum)', () => {
    expect(checkCropGuess(pk('Borage', 'basil')).status).toBe('unresolved');
  });
  it('accepts each of those three once corrected', () => {
    for (const [c, g] of [['Radicchio', 'radicchio'], ['Chervil', 'chervil'], ['Borage', 'borage']]) {
      expect(checkCropGuess(pk(c, g)).status).toBe('match');
    }
  });

  it("treats an absent guess and the explicit 'other' escape hatch as nothing-to-check", () => {
    expect(checkCropGuess(pk('Tomato', null)).status).toBe('none');
    expect(checkCropGuess(pk('Tomato', 'other')).status).toBe('none');
  });

  it('honours an injected synonym table (callers can review their own)', () => {
    const r = checkCropGuess(pk('Rapini', 'broccoli'), { synonyms: { rapini: 'broccoli' } });
    expect(r.status).toBe('synonym');
  });
});

describe('packetToVarietyCols cross-check wiring', () => {
  const radicchioMistyped = { crop: 'Radicchio', variety: 'Palla Rossa Mavrik', crop_type_slug_guess: 'endive' };

  it('is OPT-IN: default behaviour is unchanged, so already-run loaders cannot shift silently', () => {
    const out = packetToVarietyCols(radicchioMistyped, { validSlugs: ['endive'] });
    expect(out.crop_type_slug).toBe('endive');
    expect(out.crop_guess).toBeUndefined();
  });

  it('with crossCheck:true, refuses to bind an unresolved guess and reports the verdict', () => {
    const out = packetToVarietyCols(radicchioMistyped, { validSlugs: ['endive'], crossCheck: true });
    expect(out.crop_type_slug).toBeUndefined();
    expect(out.crop_guess.status).toBe('unresolved');
    expect(out.crop_guess.cropSlug).toBe('radicchio');
    expect(out.crop_guess.guess).toBe('endive');
  });

  it('with crossCheck:true, still binds a matching guess', () => {
    const out = packetToVarietyCols(
      { crop: 'Radicchio', variety: 'Palla Rossa Mavrik', crop_type_slug_guess: 'radicchio' },
      { validSlugs: ['radicchio'], crossCheck: true });
    expect(out.crop_type_slug).toBe('radicchio');
    expect(out.crop_guess.status).toBe('match');
  });

  it('cross-check does not rescue a slug the live catalog rejects (both gates apply)', () => {
    const out = packetToVarietyCols(
      { crop: 'Radicchio', crop_type_slug_guess: 'radicchio' },
      { validSlugs: ['tomato'], crossCheck: true });
    expect(out.crop_type_slug).toBeUndefined();
  });
});
