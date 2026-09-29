// V5-SEASONSTATS-001 — the pure shapers behind GET /api/harvests/season-stats.
//
// Two kinds of assertion. The CONTRACT block holds every section's output to
// tests/fixtures/season-stats.v1.json — same keys in the same order, same leaf types, null only where
// the fixture itself carries a null — because that file is what lane L2's page is built against and
// a shaper that drifts from it breaks the page with no server error. The BEHAVIOUR blocks pin the
// few things a shaper decides on its own: merging rows across household owners, the no-source card,
// filling absent groups/bands, rounding, and the section parser.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STATS_VERSION, SECTION_IDS, CARE_KINDS, SOURCE_GROUPS, HEAT_BANDS, LONGEST_LIMIT,
  num, round, day, seasonSpan, parseSections, queriesFor, buildEnvelope, SECTION_QUERIES,
  shapeRibbon, shapeSources, shapeHeatClock, shapeHeatLadder, shapeTomatoKeep, shapeLongest,
  shapeSepSize, shapeSeedLots,
} from './season-stats-sections.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(resolve(__dirname, '../../tests/fixtures/season-stats.v1.json'), 'utf8'));
const GEN = '2026-09-29T19:30:00.000Z';
const A = 'user_owner_a';
const B = 'user_owner_b';
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// Synthetic view rows, one or two per query, every field populated — so a null in the shaped output
// can only come from the shaper, never from the input.
const RESULTS = {
  weather: [
    { owner: A, day: '2026-05-10', tmax_f: 68.4, tmin_f: 48, precip_in: 0.02 },
    { owner: A, day: '2026-05-11', tmax_f: 71.2, tmin_f: 52.1, precip_in: 0 },
  ],
  care: [
    { owner: A, day: '2026-05-10', care_kind: 'water' },
    { owner: B, day: '2026-05-10', care_kind: 'water' },
    { owner: A, day: '2026-05-10', care_kind: 'checkins' },
    { owner: A, day: '2026-05-11', care_kind: 'picking' },
  ],
  pins: [{
    owner: A, first_sow: '2026-04-18', first_setout: '2026-05-19', hottest_day: '2026-07-02',
    hottest_tmax_f: 96.2, wettest_day: '2026-07-29', wettest_precip_in: 2.84, weather_from: '2026-05-10',
  }],
  weeks: [{ owner: A, week_start: '2026-05-04', heat_units: 9.2, cool_nights: 1, rain_in: 0.02, tomato_fruit: 0, pepper_pods: 3 }],
  mix: [{ owner: A, source_group: 'nursery', plantings: 3, plants: 5 }],
  cards: [
    { owner: A, source_id: id(1), name: 'Starview Gardens', kind: 'nursery', plantings: 2, plants: 3, picked: 1, lost: 0, lb: 4.44, saved_lots: 1 },
    { owner: A, source_id: null, name: null, kind: null, plantings: 1, plants: 2, picked: 1, lost: 1, lb: 1.26, saved_lots: 0 },
  ],
  crops: [{ owner: A, crop_slug: 'lettuce', crop_name: 'Lettuce', first_pick: '2026-06-04', origin_date: '2026-05-10', heat_units: 287.4 }],
  cultivars: [{
    owner: A, planting_id: id(2), crop_slug: 'pepper', cultivar: 'Habanero', transplanted_at: '2026-07-16',
    first_pick: '2026-08-09', days: 24, heat_units: 506.2, heat_band: 'superhot', crop_median_heat: 506.2,
  }, {
    owner: A, planting_id: id(3), crop_slug: 'tomato', cultivar: 'Stupice', transplanted_at: '2026-06-01',
    first_pick: '2026-07-10', days: 39, heat_units: 1151, heat_band: 'sweet', crop_median_heat: 1151,
  }],
  bands: [{ owner: A, band: 'sweet', plantings: 2, plants: 2, pods: 18, lb: 0.451 }],
  best: [{ owner: A, planting_id: id(4), band: 'sweet', cultivar: 'Red Mini Bell', pods: 18, lb: 0.451, rank_in_band: 1 }],
  tomatoKeep: [{
    owner: A, planting_id: id(5), cultivar: 'Ukrainian Purple', lb: 9.36, fruit: 46, g_per_fruit: 92.3,
    container_size: '10 gal', measured_share: 0.861, late_aug: false, median_lb: 2.05, x_median: 4.566, verdict: 'grow_again',
  }],
  longest: [{
    owner: A, planting_id: id(6), cultivar: 'Super Sweet 100', crop_name: 'Tomato', plants: 1, first_pick: '2026-07-12',
    last_pick: '2026-09-27', window_days: 78, pick_days: ['2026-07-12', '2026-09-27'], still_picking: true, lb: 2.5,
    lb_per_plant_week: 0.224, season_last_pick: '2026-09-28',
  }],
  sepSize: [{
    owner: A, cultivar: 'Ukrainian Purple', aug_grams: 1710, aug_fruit: 15, sep_grams: 1950, sep_fruit: 26,
    aug_g: 114, sep_g: 75, ratio: 0.658, fruit_weighted_ratio: 0.761,
  }],
  lots: [{
    owner: A, lot_id: id(7), cultivar: 'Sugar Baby', crop_slug: 'watermelon', seed_count: 175, count_estimated: false,
    stage: 'stored', saved_on: '2026-09-02', saved_at: '2026-09-02 14:00:00+00', parent_planting_id: id(8),
    parent_name: 'Sugar Baby', parent_lb: 13.21, source_id: id(9), source_name: 'Starview Gardens', source_kind: 'nursery',
    source_locality: 'Somewhere', source_address: '1 Road', source_website_url: 'https://example.com',
    source_instagram_url: 'https://www.instagram.com/x', source_facebook_url: 'https://www.facebook.com/x', via_name: 'A market',
  }],
};

// ── contract helpers ─────────────────────────────────────────────────────────────────────────────

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

// Every path at which the fixture ever holds a null ('sources.series.cards[].plants', …).
function nullablePaths(v, path = '', out = new Set()) {
  if (v === null) out.add(path);
  else if (Array.isArray(v)) v.forEach((x) => nullablePaths(x, `${path}[]`, out));
  else if (typeof v === 'object') for (const [k, x] of Object.entries(v)) nullablePaths(x, path ? `${path}.${k}` : k, out);
  return out;
}
// The first non-null example of each path, for its type and (objects) its key order.
function examples(v, path = '', out = new Map()) {
  if (v === null) return out;
  if (!out.has(path)) out.set(path, v);
  if (Array.isArray(v)) v.forEach((x) => examples(x, `${path}[]`, out));
  else if (typeof v === 'object') for (const [k, x] of Object.entries(v)) examples(x, path ? `${path}.${k}` : k, out);
  return out;
}
const NULLABLE = nullablePaths(FIXTURE.sections);
const EXAMPLE = examples(FIXTURE.sections);

const at = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

function shapeProblems(v, path, problems = []) {
  if (v === null) {
    if (!NULLABLE.has(path)) problems.push(`${path}: null where the fixture never is`);
    return problems;
  }
  // limits is a list of differently-shaped codes ({code}, {code,date}, {code,lb}…): match by code.
  if (/\.meta\.limits$/.test(path)) {
    const want = at(FIXTURE.sections, path);
    if (v.map((l) => l.code).join() !== want.map((l) => l.code).join()) problems.push(`${path}: codes differ`);
    v.forEach((l, i) => {
      if (Object.keys(l).join() !== Object.keys(want[i] ?? {}).join()) problems.push(`${path}[${l.code}]: keys differ`);
      for (const k of Object.keys(l)) if (typeOf(l[k]) !== typeOf(want[i]?.[k])) problems.push(`${path}[${l.code}].${k}: type`);
    });
    return problems;
  }
  const ex = EXAMPLE.get(path);
  if (ex === undefined) {
    // No non-null example: an empty array in the fixture (care: []) whose elements are strings, or a
    // field the fixture only ever carries as null (the contact links) — a scalar string either way.
    const ok = typeof v === 'string' && (/\[\]$/.test(path) || NULLABLE.has(path));
    if (!ok) problems.push(`${path}: not in the fixture`);
    return problems;
  }
  if (typeOf(v) !== typeOf(ex)) problems.push(`${path}: ${typeOf(v)} vs fixture ${typeOf(ex)}`);
  else if (Array.isArray(v)) v.forEach((x) => shapeProblems(x, `${path}[]`, problems));
  else if (typeof v === 'object') {
    const got = Object.keys(v);
    const want = Object.keys(ex);
    if (got.join() !== want.join()) problems.push(`${path}: keys [${got}] vs fixture [${want}]`);
    for (const k of got) shapeProblems(v[k], `${path}.${k}`, problems);
  }
  return problems;
}

describe('contract fixture — tests/fixtures/season-stats.v1.json', () => {
  it('is a v1 envelope carrying every section, in SECTION_IDS order', () => {
    expect(FIXTURE.version).toBe(STATS_VERSION);
    expect(Object.keys(FIXTURE)).toEqual(['version', 'generatedAt', 'season', 'sections']);
    expect(Object.keys(FIXTURE.sections)).toEqual([...SECTION_IDS]);
    expect(FIXTURE.season).toEqual(seasonSpan(FIXTURE.season.year));
    for (const [sid, s] of Object.entries(FIXTURE.sections)) {
      expect(Object.keys(s)).toEqual(['section', 'version', 'generatedAt', 'meta', 'series']);
      expect(s.section).toBe(sid);
      expect(s.version).toBe(STATS_VERSION);
      expect(Array.isArray(s.meta.limits)).toBe(true);
    }
  });

  it('has real rows in every series, so the shape checks below compare against something', () => {
    for (const s of Object.values(FIXTURE.sections)) {
      for (const [k, rows] of Object.entries(s.series)) expect(rows.length, k).toBeGreaterThan(0);
    }
  });
});

describe('contract — every shaper matches the fixture shape', () => {
  const env = buildEnvelope({ year: 2026, sections: [...SECTION_IDS], results: RESULTS, generatedAt: GEN });

  it('envelope', () => {
    expect(Object.keys(env)).toEqual(Object.keys(FIXTURE));
    expect(env.version).toBe(1);
    expect(env.generatedAt).toBe(GEN);
    expect(env.season).toEqual({ year: 2026, start: '2025-11-01', end: '2026-10-31' });
    expect(Object.keys(env.sections)).toEqual([...SECTION_IDS]);
  });

  for (const sid of SECTION_IDS) {
    it(sid, () => {
      const s = env.sections[sid];
      expect(Object.keys(s)).toEqual(Object.keys(FIXTURE.sections[sid]));
      expect(shapeProblems(s, sid)).toEqual([]);
      for (const [k, rows] of Object.entries(s.series)) expect(rows.length, k).toBeGreaterThan(0);
    });
  }

  it('the checker itself reds on a drifted key, a wrong type and an unexpected null', () => {
    const bad = structuredClone(env.sections.tomato_keep);
    bad.series.rows[0].lbs = bad.series.rows[0].lb;
    delete bad.series.rows[0].lb;
    bad.meta.median_lb = '2.05';
    bad.series.rows[0].verdict = null;
    const p = shapeProblems(bad, 'tomato_keep');
    expect(p.some((x) => x.includes('keys'))).toBe(true);
    expect(p.some((x) => x.includes('median_lb: string'))).toBe(true);
    expect(p.some((x) => x.includes('verdict: null'))).toBe(true);
  });
});

describe('helpers', () => {
  it('num / round / day', () => {
    expect(num('1.5')).toBe(1.5);
    expect(num(null)).toBeNull();
    expect(num('')).toBeNull();
    expect(num('x')).toBeNull();
    expect(round('2.345', 2)).toBe(2.35);
    expect(round(130.5)).toBe(131);
    expect(round(-1.5)).toBe(-2);
    expect(round(null, 2)).toBeNull();
    expect(day('2026-07-02')).toBe('2026-07-02');
    expect(day('2026-07-02 12:00:00+00')).toBe('2026-07-02');
    expect(day(new Date('2026-07-02T00:00:00Z'))).toBe('2026-07-02');
    expect(day(null)).toBeNull();
  });

  it('seasonSpan is Nov 1 .. Oct 31, inclusive', () => {
    expect(seasonSpan(2027)).toEqual({ year: 2027, start: '2026-11-01', end: '2027-10-31' });
  });

  it('parseSections: default all, page order, trims, rejects unknown ids by name', () => {
    expect(parseSections(undefined)).toEqual([...SECTION_IDS]);
    expect(parseSections('')).toEqual([...SECTION_IDS]);
    expect(parseSections(' seed_lots , ribbon ')).toEqual(['ribbon', 'seed_lots']);
    expect(() => parseSections('ribbon,nope')).toThrow(/nope/);
    try { parseSections('x,y'); } catch (e) { expect(e.unknown).toEqual(['x', 'y']); }
  });

  it('queriesFor: union, no duplicates; every section maps to at least one query', () => {
    expect(queriesFor(['ribbon', 'heat_clock'])).toEqual(['weather', 'care', 'pins', 'weeks', 'crops', 'cultivars']);
    for (const s of SECTION_IDS) expect(SECTION_QUERIES[s].length).toBeGreaterThan(0);
  });

  it('buildEnvelope emits only the requested sections', () => {
    const env = buildEnvelope({ year: 2026, sections: ['seed_lots'], results: RESULTS, generatedAt: GEN });
    expect(Object.keys(env.sections)).toEqual(['seed_lots']);
  });
});

describe('ribbon', () => {
  const s = shapeRibbon(RESULTS, GEN);

  it('care is counted in DAYS across owners; picking stays off the ribbon', () => {
    expect(s.meta.care_day_totals).toEqual({ water: 1, feed: 0, pests: 0, starts: 0, upkeep: 0, checkins: 1 });
    expect(Object.keys(s.meta.care_day_totals)).toEqual([...CARE_KINDS]);
    expect(s.series.days[0].care).toEqual(['checkins', 'water']);
    expect(s.series.days[1].care).toEqual([]);
  });

  it('one row per weather day even if two owners report it', () => {
    const r = shapeRibbon({ ...RESULTS, weather: [...RESULTS.weather, { ...RESULTS.weather[0], owner: B, tmax_f: 1 }] }, GEN);
    expect(r.series.days.map((d) => d.date)).toEqual(['2026-05-10', '2026-05-11']);
  });

  it('weeks: fruit sums across owners, heat is taken once and rounded', () => {
    const r = shapeRibbon({ ...RESULTS, weeks: [...RESULTS.weeks, { owner: B, week_start: '2026-05-04', heat_units: 9.2, cool_nights: 1, rain_in: 0.02, tomato_fruit: 4, pepper_pods: 1 }] }, GEN);
    expect(r.series.weeks).toEqual([{ week_start: '2026-05-04', heat_units: 9, cool_nights: 1, rain_in: 0.02, tomato_fruit: 4, pepper_pods: 4 }]);
  });

  it('pins: earliest dates, hottest/wettest across owners with the earlier day on a tie', () => {
    const r = shapeRibbon({
      ...RESULTS,
      pins: [...RESULTS.pins, {
        owner: B, first_sow: '2026-04-01', first_setout: null, hottest_day: '2026-06-01', hottest_tmax_f: 96.2,
        wettest_day: '2026-08-01', wettest_precip_in: 3, weather_from: '2026-05-12',
      }],
    }, GEN);
    expect(r.meta.pins).toEqual({
      first_sow: '2026-04-01', first_setout: '2026-05-19',
      hottest: { date: '2026-06-01', tmax_f: 96.2 }, wettest: { date: '2026-08-01', precip_in: 3 },
    });
    expect(r.meta.limits).toEqual([{ code: 'weather_from', date: '2026-05-10' }, { code: 'care_counted_in_days' }]);
  });

  it('an empty season still shapes', () => {
    const r = shapeRibbon({}, GEN);
    expect(r.series).toEqual({ days: [], weeks: [] });
    expect(r.meta.pins).toEqual({ first_sow: null, first_setout: null, hottest: null, wettest: null });
    expect(r.meta.limits[0]).toEqual({ code: 'weather_from', date: null });
  });
});

describe('sources', () => {
  it('fills all six groups in order, summed across owners', () => {
    const s = shapeSources({ mix: [...RESULTS.mix, { owner: B, source_group: 'nursery', plantings: 1, plants: 1 }, { owner: B, source_group: 'weird', plantings: 1, plants: 2 }] }, GEN);
    expect(s.series.by_type.map((g) => g.group)).toEqual([...SOURCE_GROUPS]);
    expect(s.series.by_type[0]).toEqual({ group: 'nursery', plantings: 4, plants: 6 });
    expect(s.series.by_type.find((g) => g.group === 'other')).toEqual({ group: 'other', plantings: 1, plants: 2 });
  });

  it('merges a source across owners, sorts by pounds, and puts the no-source card last with counts only', () => {
    const s = shapeSources({
      cards: [
        ...RESULTS.cards,
        { owner: B, source_id: id(1), name: 'Starview Gardens', kind: 'nursery', plantings: 1, plants: 1, picked: 1, lost: 1, lb: 1, saved_lots: 0 },
        { owner: A, source_id: id(2), name: 'Big Seller', kind: 'seed_company', plantings: 1, plants: 1, picked: 1, lost: 0, lb: 9, saved_lots: 0 },
      ],
    }, GEN);
    expect(s.series.cards.map((c) => c.name)).toEqual(['Big Seller', 'Starview Gardens', null]);
    expect(s.series.cards[1]).toMatchObject({ plantings: 3, plants: 4, picked: 2, lost: 1, lb: 5.4, saved_lots: 1 });
    expect(s.series.cards[2]).toEqual({ source_id: null, name: null, kind: null, plantings: 1, plants: null, picked: null, lost: null, lb: 1.3, saved_lots: 0 });
    expect(s.meta.total_lb).toBe(15.7);
    expect(s.meta.limits).toEqual([{ code: 'archived_included' }, { code: 'no_source_lb', lb: 1.3 }]);
  });

  it('no no-source card when every planting names a source', () => {
    const s = shapeSources({ cards: [RESULTS.cards[0]] }, GEN);
    expect(s.series.cards.every((c) => c.source_id)).toBe(true);
    expect(s.meta.limits[1]).toEqual({ code: 'no_source_lb', lb: 0 });
  });
});

describe('heat_clock', () => {
  it('keeps the earliest first pick per crop across owners and sorts by heat', () => {
    const s = shapeHeatClock({
      crops: [
        { owner: A, crop_slug: 'bean', crop_name: 'Bean', first_pick: '2026-07-01', origin_date: '2026-05-10', heat_units: 800 },
        { owner: B, crop_slug: 'bean', crop_name: 'Bean', first_pick: '2026-06-20', origin_date: '2026-05-10', heat_units: 600 },
        ...RESULTS.crops,
      ],
      cultivars: RESULTS.cultivars,
      pins: RESULTS.pins,
    }, GEN);
    expect(s.series.by_crop.map((c) => [c.crop_slug, c.heat_units])).toEqual([['lettuce', 287], ['bean', 600]]);
    expect(s.meta.median_heat).toEqual({ tomato: 1151, pepper: 506 });
    expect(s.series.by_cultivar.map((c) => c.crop_slug)).toEqual(['pepper', 'tomato']);
  });

  it('origin falls back to the crop rows without pins; medians null without rows', () => {
    const s = shapeHeatClock({ crops: RESULTS.crops }, GEN);
    expect(s.meta.origin_date).toBe('2026-05-10');
    expect(s.meta.median_heat).toEqual({ tomato: null, pepper: null });
  });

  it('a per-owner median comes from the owner with the most rows', () => {
    const rows = [
      { ...RESULTS.cultivars[1], owner: A, crop_median_heat: 1000 },
      { ...RESULTS.cultivars[1], owner: B, planting_id: id(20), crop_median_heat: 2000 },
      { ...RESULTS.cultivars[1], owner: B, planting_id: id(21), crop_median_heat: 2000 },
    ];
    expect(shapeHeatClock({ cultivars: rows }, GEN).meta.median_heat.tomato).toBe(2000);
  });
});

describe('heat_ladder', () => {
  it('lists all six bands with contract labels, summing across owners', () => {
    const s = shapeHeatLadder({ bands: [...RESULTS.bands, { owner: B, band: 'sweet', plantings: 1, plants: 1, pods: 2, lb: 0.1 }, { owner: A, band: 'bogus', plantings: 9 }], best: RESULTS.best }, GEN);
    expect(s.series.bands.map((b) => b.band)).toEqual(HEAT_BANDS.map((b) => b.slug));
    expect(s.series.bands.map((b) => b.label)).toEqual(['Sweet', 'Mild', 'Medium', 'Hot', 'Very hot', 'Superhot']);
    expect(s.series.bands[0]).toEqual({ band: 'sweet', label: 'Sweet', plantings: 3, plants: 3, pods: 20, lb: 0.55 });
    expect(s.series.bands[5]).toEqual({ band: 'superhot', label: 'Superhot', plantings: 0, plants: 0, pods: 0, lb: 0 });
  });

  it('best is ordered by band, then rank; unknown bands dropped', () => {
    const s = shapeHeatLadder({
      best: [
        { planting_id: id(1), band: 'hot', cultivar: 'b', pods: 1, lb: 0, rank_in_band: 2 },
        { planting_id: id(2), band: 'hot', cultivar: 'a', pods: 5, lb: 0, rank_in_band: 1 },
        { planting_id: id(3), band: 'sweet', cultivar: 'c', pods: 0, lb: 0, rank_in_band: 1 },
        { planting_id: id(4), band: 'nope', cultivar: 'd', pods: 0, lb: 0, rank_in_band: 1 },
      ],
    }, GEN);
    expect(s.series.best.map((r) => r.cultivar)).toEqual(['c', 'a', 'b']);
  });
});

describe('tomato_keep', () => {
  it('sorts by pounds, rounds, and flags late plantings', () => {
    const s = shapeTomatoKeep({ rows: [RESULTS.tomatoKeep[0], { ...RESULTS.tomatoKeep[0], planting_id: id(30), cultivar: 'Late', lb: 1, late_aug: true, verdict: 'fine', g_per_fruit: null }] }, GEN);
    expect(s.series.rows.map((r) => r.cultivar)).toEqual(['Ukrainian Purple', 'Late']);
    expect(s.series.rows[0]).toMatchObject({ lb: 9.36, g_per_fruit: 92, measured_share: 0.86, x_median: 4.57, flags: [] });
    expect(s.series.rows[1].flags).toEqual(['late_aug']);
    expect(s.series.rows[1].g_per_fruit).toBeNull();
    expect(s.meta).toEqual({ median_lb: 2.05, limits: [{ code: 'single_plant_only' }, { code: 'measured_share_min', share: 0.7 }] });
  });

  it('empty season: null median, no rows', () => {
    expect(shapeTomatoKeep({ rows: [] }, GEN).meta.median_lb).toBeNull();
  });
});

describe('longest', () => {
  it(`caps at ${LONGEST_LIMIT} after merging owners, longest window first`, () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      ...RESULTS.longest[0], owner: i % 2 ? A : B, planting_id: id(100 + i), window_days: 10 + i, lb: 1,
      season_last_pick: i === 3 ? '2026-09-29' : '2026-09-28',
    }));
    const s = shapeLongest({ rows }, GEN);
    expect(s.series.rows).toHaveLength(LONGEST_LIMIT);
    expect(s.series.rows[0].window_days).toBe(29);
    expect(s.meta.last_pick).toBe('2026-09-29');
  });

  it('pace stays null under 21 days', () => {
    const s = shapeLongest({ rows: [{ ...RESULTS.longest[0], lb_per_plant_week: null, pick_days: null }] }, GEN);
    expect(s.series.rows[0].lb_per_plant_week).toBeNull();
    expect(s.series.rows[0].pick_days).toEqual([]);
  });
});

describe('sep_size', () => {
  it('uses the view ratio for one owner, pools grams/fruit across two', () => {
    expect(shapeSepSize({ rows: RESULTS.sepSize }, GEN).meta.fruit_weighted_ratio).toBe(0.76);
    const two = shapeSepSize({ rows: [RESULTS.sepSize[0], { ...RESULTS.sepSize[0], owner: B, cultivar: 'X', aug_grams: 1000, aug_fruit: 10, sep_grams: 500, sep_fruit: 10, ratio: 0.5 }] }, GEN);
    // (2450/36) / (2710/25) = 0.6278…
    expect(two.meta.fruit_weighted_ratio).toBe(0.63);
    expect(two.series.rows.map((r) => r.cultivar)).toEqual(['X', 'Ukrainian Purple']);
    expect(shapeSepSize({ rows: [] }, GEN).meta.fruit_weighted_ratio).toBeNull();
  });
});

describe('seed_lots', () => {
  it('parent and source are null when the lot has neither', () => {
    const s = shapeSeedLots({ rows: [{ ...RESULTS.lots[0], parent_planting_id: null, source_name: null, seed_count: null }] }, GEN);
    expect(s.series.rows[0]).toMatchObject({ parent: null, source: null, count: null });
  });

  it('orders by save time and carries the contact links through', () => {
    const s = shapeSeedLots({ rows: [{ ...RESULTS.lots[0], lot_id: id(2), saved_at: '2026-09-03 01:00:00+00' }, RESULTS.lots[0]] }, GEN);
    expect(s.series.rows.map((r) => r.lot_id)).toEqual([id(7), id(2)]);
    expect(s.series.rows[0].source).toMatchObject({ instagram_url: 'https://www.instagram.com/x', facebook_url: 'https://www.facebook.com/x', via: 'A market' });
    expect(s.series.rows[0].parent).toEqual({ planting_id: id(8), name: 'Sugar Baby', lb: 13.2 });
  });
});
