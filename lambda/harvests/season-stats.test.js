// V5-SEASONSTATS-001 — GET /api/harvests/season-stats, run through the REAL handler.
//
// index.js is importable here through the vitest.config.ts stub aliases (lambda/_test-stubs), so the
// assertions are about what the handler DOES between auth and the database: which views it reads for
// which sections, that every read is fenced to the caller's household and season, the 400/405 edges
// and the 60 s cache. The numbers themselves are the views' job (verified against prod when the
// migration was written) and the layout is season-stats-sections.test.js's.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { stubState, resetStubs } from '../_test-stubs/state.js';
import {
  SEASON_STATS_PATH, CACHE_TTL_MS, QUERY_NAMES, matchSeasonStatsRoute, parseSeason, currentGrowYear,
  handleSeasonStatsGet, _resetSeasonStatsCache,
} from './season-stats.js';
import { SECTION_IDS, SECTION_QUERIES } from './season-stats-sections.js';

const { handler } = await import('./index.js');

const USER = 'user_stats_owner';
const MATE = 'user_stats_mate';
const STRANGER = 'user_stats_stranger';
const ENV_KEY = 'GARDEN_HOUSEHOLD_IDS';

const VIEW_OF = {
  weather: 'stat_weather_day', care: 'stat_care_day', pins: 'stat_season_pins', weeks: 'stat_weekly_heat_fruit',
  mix: 'stat_source_mix', cards: 'stat_source_card', crops: 'stat_heat_clock_crop',
  cultivars: 'stat_heat_clock_cultivar', bands: 'stat_heat_ladder', best: 'stat_pepper_best',
  tomatoKeep: 'stat_tomato_keep', longest: 'stat_longest_giving', sepSize: 'stat_tomato_month_size',
  lots: 'stat_saved_lot',
};
const viewIn = (text) => (text.match(/FROM public\.(stat_\w+)/) ?? [])[1];

// One plausible row per view so every section has something to shape.
const ROWS = {
  stat_weather_day: [{ owner: USER, day: '2026-05-10', tmax_f: 70, tmin_f: 50, precip_in: 0.1 }],
  stat_care_day: [{ owner: USER, day: '2026-05-10', care_kind: 'water' }],
  stat_season_pins: [{ owner: USER, first_sow: '2026-04-18', first_setout: '2026-05-19', hottest_day: '2026-07-02', hottest_tmax_f: 96.2, wettest_day: '2026-07-29', wettest_precip_in: 2.84, weather_from: '2026-05-10' }],
  stat_weekly_heat_fruit: [{ owner: USER, week_start: '2026-05-04', heat_units: 9, cool_nights: 1, rain_in: 0.1, tomato_fruit: 0, pepper_pods: 0 }],
  stat_source_mix: [{ owner: USER, source_group: 'seed', plantings: 2, plants: 4 }],
  stat_source_card: [{ owner: USER, source_id: 'a0000000-0000-4000-8000-000000000001', name: 'Seller', kind: 'nursery', plantings: 2, plants: 4, picked: 1, lost: 0, lb: '3.25', saved_lots: 0 }],
  stat_heat_clock_crop: [{ owner: USER, crop_slug: 'bean', crop_name: 'Bean', first_pick: '2026-07-01', origin_date: '2026-05-10', heat_units: 700.2 }],
  stat_heat_clock_cultivar: [{ owner: USER, planting_id: 'a0000000-0000-4000-8000-000000000002', crop_slug: 'tomato', cultivar: 'Stupice', transplanted_at: '2026-06-01', first_pick: '2026-07-10', days: 39, heat_units: 900, heat_band: null, crop_median_heat: 900 }],
  stat_heat_ladder: [{ owner: USER, band: 'hot', plantings: 1, plants: 1, pods: 6, lb: 0.2 }],
  stat_pepper_best: [{ owner: USER, planting_id: 'a0000000-0000-4000-8000-000000000003', band: 'hot', cultivar: 'Hot Portugal', pods: 6, lb: 0.2, rank_in_band: 1, scoville_max: 20000 }],
  stat_tomato_keep: [{ owner: USER, planting_id: 'a0000000-0000-4000-8000-000000000004', cultivar: 'Stupice', lb: 2, fruit: 20, g_per_fruit: 45, container_size: '10 gal', measured_share: 1, late_aug: false, median_lb: 2, x_median: 1, verdict: 'fine' }],
  stat_longest_giving: [{ owner: USER, planting_id: 'a0000000-0000-4000-8000-000000000005', cultivar: 'Cherry', crop_name: 'Tomato', plants: 1, first_pick: '2026-07-01', last_pick: '2026-09-20', window_days: 82, pick_days: ['2026-07-01', '2026-09-20'], still_picking: false, lb: 3, lb_per_plant_week: 0.26, season_last_pick: '2026-09-28' }],
  stat_tomato_month_size: [{ owner: USER, cultivar: 'Stupice', aug_grams: 500, aug_fruit: 10, sep_grams: 400, sep_fruit: 10, aug_g: 50, sep_g: 40, ratio: 0.8, fruit_weighted_ratio: 0.8 }],
  stat_saved_lot: [{ owner: USER, lot_id: 'a0000000-0000-4000-8000-000000000006', cultivar: 'Stupice', crop_slug: 'tomato', seed_count: 40, count_estimated: true, stage: 'drying', saved_on: '2026-09-02', saved_at: '2026-09-02 13:00:00+00', parent_planting_id: null, parent_name: null, parent_lb: null, source_id: null, source_name: null, source_kind: null, source_locality: null, source_address: null, source_website_url: null, source_instagram_url: null, source_facebook_url: null, via_name: null }],
};

const call = (method, query) => handler({
  requestContext: { http: { method } },
  rawPath: SEASON_STATS_PATH,
  headers: { authorization: 'Bearer stub-token' },
  ...(query ? { queryStringParameters: query } : {}),
});
const get = async (query) => {
  const res = await call('GET', query);
  return { status: res.statusCode, body: JSON.parse(res.body || '{}') };
};
const statCalls = () => stubState.sqlCalls.filter((c) => viewIn(c.text));

let savedEnv;
beforeEach(() => {
  resetStubs();
  _resetSeasonStatsCache();
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
  stubState.verifyTokenResult = { sub: USER };
  stubState.sqlHandler = (text) => ROWS[viewIn(text)] ?? [];
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY]; else process.env[ENV_KEY] = savedEnv;
});

describe('route matching', () => {
  it('GET matches, other verbs 405, other paths fall through', () => {
    expect(matchSeasonStatsRoute('GET', SEASON_STATS_PATH)).toEqual({ kind: 'season_stats_get' });
    expect(matchSeasonStatsRoute('POST', SEASON_STATS_PATH)).toEqual({ kind: 'method_not_allowed' });
    expect(matchSeasonStatsRoute('GET', '/api/harvests')).toBeNull();
    expect(matchSeasonStatsRoute('GET', `${SEASON_STATS_PATH}/x`)).toBeNull();
  });

  it('POST through the handler is a 405 and reads nothing', async () => {
    const res = await call('POST');
    expect(res.statusCode).toBe(405);
    expect(statCalls()).toHaveLength(0);
  });

  it('an unauthenticated call is a 401 and reads nothing', async () => {
    stubState.verifyTokenResult = new Error('bad token');
    const { status } = await get({ season: '2026' });
    expect(status).toBe(401);
    expect(statCalls()).toHaveLength(0);
  });
});

describe('GET /api/harvests/season-stats', () => {
  it('returns the v1 envelope with all eight sections', async () => {
    const { status, body } = await get({ season: '2026' });
    expect(status).toBe(200);
    expect(body.version).toBe(1);
    expect(body.season).toEqual({ year: 2026, start: '2025-11-01', end: '2026-10-31' });
    expect(Object.keys(body.sections)).toEqual([...SECTION_IDS]);
    expect(body.sections.sources.series.cards[0].lb).toBe(3.3);
    expect(body.sections.ribbon.series.days[0].care).toEqual(['water']);
    expect(body.sections.heat_ladder.series.best[0].scoville_max).toBe(20000);
    expect(Date.parse(body.generatedAt)).not.toBeNaN();
  });

  it('reads each of the fourteen views exactly once for a full request', async () => {
    await get({ season: '2026' });
    expect(statCalls().map((c) => viewIn(c.text)).sort()).toEqual(Object.values(VIEW_OF).sort());
    expect(QUERY_NAMES.map((q) => VIEW_OF[q]).sort()).toEqual(Object.values(VIEW_OF).sort());
  });

  it('EVERY read is fenced by owner = ANY(household) AND grow_year = season', async () => {
    await get({ season: '2026' });
    for (const c of statCalls()) {
      expect(c.text, viewIn(c.text)).toMatch(/\bowner = ANY\(\?::text\[\]\) AND \w+\.grow_year = \?::int/);
      expect(c.values[0]).toEqual([USER]);
      expect(c.values[1]).toBe(2026);
    }
  });

  it('household member: scope widens to the configured household; a non-member stays alone', async () => {
    process.env[ENV_KEY] = `${USER},${MATE}`;
    await get({ season: '2026' });
    expect(statCalls()[0].values[0]).toEqual([USER, MATE]);
    resetStubs();
    _resetSeasonStatsCache();
    stubState.verifyTokenResult = { sub: STRANGER };
    stubState.sqlHandler = (text) => ROWS[viewIn(text)] ?? [];
    await get({ season: '2026' });
    expect(statCalls().every((c) => c.values[0].length === 1 && c.values[0][0] === STRANGER)).toBe(true);
  });

  it('sections= narrows both the response and the reads', async () => {
    const { status, body } = await get({ season: '2026', sections: 'seed_lots,heat_ladder' });
    expect(status).toBe(200);
    expect(Object.keys(body.sections)).toEqual(['heat_ladder', 'seed_lots']);
    expect(statCalls().map((c) => viewIn(c.text)).sort()).toEqual(['stat_heat_ladder', 'stat_pepper_best', 'stat_saved_lot']);
  });

  it('every section names only queries the handler has', () => {
    for (const s of SECTION_IDS) for (const q of SECTION_QUERIES[s]) expect(QUERY_NAMES).toContain(q);
  });

  it('an unknown section is a 400 naming it, with the allowed list', async () => {
    const { status, body } = await get({ season: '2026', sections: 'ribbon,charts' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/charts/);
    expect(body.allowed).toEqual([...SECTION_IDS]);
    expect(statCalls()).toHaveLength(0);
  });

  it.each([['26'], ['2026a'], ['1999'], ['2101']])('season=%s is a 400', async (season) => {
    const { status } = await get({ season });
    expect(status).toBe(400);
    expect(statCalls()).toHaveLength(0);
  });

  it('no season = the current grow-year', async () => {
    const { body } = await get();
    expect(body.season.year).toBe(currentGrowYear());
  });

  it('a database error is a 500, not a partial page', async () => {
    stubState.sqlHandler = () => { throw new Error('relation "stat_saved_lot" does not exist'); };
    const { status, body } = await get({ season: '2026' });
    expect(status).toBe(500);
    expect(body).toEqual({ error: 'Internal server error' });
  });
});

describe('grow-year parsing', () => {
  it('Nov 1 ET opens the next season; Oct 31 ET is still this one', () => {
    expect(currentGrowYear(new Date('2026-11-01T05:00:00Z'))).toBe(2027);
    expect(currentGrowYear(new Date('2026-11-01T03:59:00Z'))).toBe(2026);
    expect(currentGrowYear(new Date('2026-06-15T12:00:00Z'))).toBe(2026);
  });

  it('parseSeason', () => {
    const now = new Date('2026-12-01T12:00:00Z');
    expect(parseSeason(undefined, now)).toBe(2027);
    expect(parseSeason('', now)).toBe(2027);
    expect(parseSeason('2025', now)).toBe(2025);
    expect(parseSeason('20x5', now)).toBeNull();
  });
});

describe('60 s cache (plan D5)', () => {
  const ctx = (overrides = {}) => ({
    sql: async (strings, ...values) => {
      const text = strings.join('?');
      stubState.sqlCalls.push({ text, values });
      return ROWS[viewIn(text)] ?? [];
    },
    householdIds: [USER],
    query: { season: '2026' },
    ...overrides,
  });

  it('a repeat inside the TTL reads nothing; after it, reads again', async () => {
    let t = 1_000_000;
    const now = () => t;
    const first = await handleSeasonStatsGet(ctx({ now }));
    const n = stubState.sqlCalls.length;
    expect(n).toBe(14);
    t += CACHE_TTL_MS - 1;
    const second = await handleSeasonStatsGet(ctx({ now }));
    expect(stubState.sqlCalls.length).toBe(n);
    expect(second.body).toBe(first.body);
    t += 2;
    await handleSeasonStatsGet(ctx({ now }));
    expect(stubState.sqlCalls.length).toBe(2 * n);
  });

  it('keys on household, season and sections — household order does not matter', async () => {
    const now = () => 5;
    await handleSeasonStatsGet(ctx({ now, householdIds: [USER, MATE] }));
    const n = stubState.sqlCalls.length;
    await handleSeasonStatsGet(ctx({ now, householdIds: [MATE, USER] }));
    expect(stubState.sqlCalls.length).toBe(n);
    await handleSeasonStatsGet(ctx({ now, householdIds: [USER] }));
    await handleSeasonStatsGet(ctx({ now, householdIds: [USER], query: { season: '2025' } }));
    await handleSeasonStatsGet(ctx({ now, householdIds: [USER], query: { season: '2025', sections: 'ribbon' } }));
    expect(stubState.sqlCalls.length).toBe(n * 3 + 4);
  });

  it('does not grow without bound', async () => {
    const now = () => 7;
    for (let y = 2000; y < 2100; y += 1) {
      // eslint-disable-next-line no-await-in-loop
      await handleSeasonStatsGet(ctx({ now, query: { season: String(y), sections: 'seed_lots' } }));
    }
    const before = stubState.sqlCalls.length;
    await handleSeasonStatsGet(ctx({ now, query: { season: '2000', sections: 'seed_lots' } }));
    expect(stubState.sqlCalls.length).toBe(before + 1);
  });
});
