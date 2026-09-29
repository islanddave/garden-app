// season-stats.js — V5-SEASONSTATS-001. GET /api/harvests/season-stats?season=YYYY[&sections=a,b]
//
// Layer B of the season stats engine (plan D1): a READ-ONLY route inside lambda/harvests, riding the
// EXISTING /api/harvests prefix in src/lib/api.js exactly like watch-route.js and
// ready-impression.js — no new Function URL, repo variable, staging URL or deploy matrix entry, and
// GARDEN_HOUSEHOLD_IDS is already set on this Lambda.
//
// THE NUMBERS LIVE IN THE VIEWS. Every figure comes from a public.stat_* view
// (migrations/v5-seasonstats-001); this module filters them to the caller's household and season,
// and season-stats-sections.js shapes the rows into the v1 contract
// (tests/fixtures/season-stats.v1.json). Nothing here computes a statistic.
//
// HOUSEHOLD SCOPE: every view exposes `owner`, and EVERY query below filters
// `owner = ANY(householdIds)` and `grow_year = year` — householdScope() from ./household.js, the
// same membership-gated scope the rest of this Lambda uses. A non-member sees only their own rows.
//
// CACHE (plan D5): 60 s in module memory, keyed household|year|sections. The page is a season review
// that changes at most a few times a day; the cache only absorbs the page's own re-renders and
// tab flips. A warm Lambda serves a stale-by-≤60 s answer, which is the stated contract.
//
// Every date column is cast ::text in SQL so the wire carries 'YYYY-MM-DD' strings with no timezone
// math in JS (the driver would otherwise hand back a Date at UTC midnight — the previous ET evening).

import {
  STATS_VERSION, SECTION_IDS, LONGEST_LIMIT, parseSections, queriesFor, buildEnvelope,
} from './season-stats-sections.js';

export { STATS_VERSION, SECTION_IDS };

export const SEASON_STATS_PATH = '/api/harvests/season-stats';
export const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 64;

const HARVEST_TZ = 'America/New_York';

export function matchSeasonStatsRoute(method, rawPath) {
  if (rawPath !== SEASON_STATS_PATH) return null;
  if (method === 'GET') return { kind: 'season_stats_get' };
  // 405 rather than fall-through: the /api/harvests read model would answer about the wrong route.
  return { kind: 'method_not_allowed' };
}

// Grow-year "now" on the ET calendar (mirrors src/lib/growYear.js currentGrowYear).
export function currentGrowYear(now = new Date(), timeZone = HARVEST_TZ) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(now);
  const y = Number(parts.find((p) => p.type === 'year').value);
  const m = Number(parts.find((p) => p.type === 'month').value);
  return m >= 11 ? y + 1 : y;
}

// null = invalid. Absent = the current grow-year.
export function parseSeason(raw, now = new Date()) {
  if (raw == null || raw === '') return currentGrowYear(now);
  if (!/^\d{4}$/.test(String(raw))) return null;
  const y = Number(raw);
  return y >= 2000 && y <= 2100 ? y : null;
}

// One statement per view, every one filtered on owner + grow_year. Kept as separate tagged templates
// (not a UNION) so each result keeps its own columns, and so lambda/harvests/stat-views-columns.test.js
// and scripts/dev-main-schema-audit.py can read each binding.
const QUERIES = {
  weather: (sql, ids, y) => sql`
    SELECT w.owner, w.day::text AS day, w.tmax_f, w.tmin_f, w.precip_in
      FROM public.stat_weather_day w
     WHERE w.owner = ANY(${ids}::text[]) AND w.grow_year = ${y}::int
     ORDER BY w.day`,
  care: (sql, ids, y) => sql`
    SELECT c.owner, c.day::text AS day, c.care_kind
      FROM public.stat_care_day c
     WHERE c.owner = ANY(${ids}::text[]) AND c.grow_year = ${y}::int`,
  pins: (sql, ids, y) => sql`
    SELECT sn.owner, sn.first_sow::text AS first_sow, sn.first_setout::text AS first_setout,
           sn.hottest_day::text AS hottest_day, sn.hottest_tmax_f,
           sn.wettest_day::text AS wettest_day, sn.wettest_precip_in,
           sn.weather_from::text AS weather_from
      FROM public.stat_season_pins sn
     WHERE sn.owner = ANY(${ids}::text[]) AND sn.grow_year = ${y}::int`,
  weeks: (sql, ids, y) => sql`
    SELECT wk.owner, wk.week_start::text AS week_start, wk.heat_units, wk.cool_nights, wk.rain_in,
           wk.tomato_fruit, wk.pepper_pods
      FROM public.stat_weekly_heat_fruit wk
     WHERE wk.owner = ANY(${ids}::text[]) AND wk.grow_year = ${y}::int
     ORDER BY wk.week_start`,
  mix: (sql, ids, y) => sql`
    SELECT sm.owner, sm.source_group, sm.plantings, sm.plants
      FROM public.stat_source_mix sm
     WHERE sm.owner = ANY(${ids}::text[]) AND sm.grow_year = ${y}::int`,
  cards: (sql, ids, y) => sql`
    SELECT sc.owner, sc.source_id, sc.name, sc.kind, sc.plantings, sc.plants, sc.picked, sc.lost,
           sc.lb, sc.saved_lots
      FROM public.stat_source_card sc
     WHERE sc.owner = ANY(${ids}::text[]) AND sc.grow_year = ${y}::int`,
  crops: (sql, ids, y) => sql`
    SELECT hc.owner, hc.crop_slug, hc.crop_name, hc.first_pick::text AS first_pick,
           hc.origin_date::text AS origin_date, hc.heat_units
      FROM public.stat_heat_clock_crop hc
     WHERE hc.owner = ANY(${ids}::text[]) AND hc.grow_year = ${y}::int`,
  cultivars: (sql, ids, y) => sql`
    SELECT hv.owner, hv.planting_id, hv.crop_slug, hv.cultivar, hv.transplanted_at::text AS transplanted_at,
           hv.first_pick::text AS first_pick, hv.days, hv.heat_units, hv.heat_band, hv.crop_median_heat
      FROM public.stat_heat_clock_cultivar hv
     WHERE hv.owner = ANY(${ids}::text[]) AND hv.grow_year = ${y}::int`,
  bands: (sql, ids, y) => sql`
    SELECT hl.owner, hl.band, hl.plantings, hl.plants, hl.pods, hl.lb
      FROM public.stat_heat_ladder hl
     WHERE hl.owner = ANY(${ids}::text[]) AND hl.grow_year = ${y}::int`,
  best: (sql, ids, y) => sql`
    SELECT pb.owner, pb.planting_id, pb.band, pb.cultivar, pb.pods, pb.lb, pb.rank_in_band, pb.scoville_max
      FROM public.stat_pepper_best pb
     WHERE pb.owner = ANY(${ids}::text[]) AND pb.grow_year = ${y}::int`,
  tomatoKeep: (sql, ids, y) => sql`
    SELECT tk.owner, tk.planting_id, tk.cultivar, tk.lb, tk.fruit, tk.g_per_fruit, tk.container_size,
           tk.measured_share, tk.late_aug, tk.median_lb, tk.x_median, tk.verdict
      FROM public.stat_tomato_keep tk
     WHERE tk.owner = ANY(${ids}::text[]) AND tk.grow_year = ${y}::int`,
  longest: (sql, ids, y) => sql`
    SELECT lg.owner, lg.planting_id, lg.cultivar, lg.crop_name, lg.plants,
           lg.first_pick::text AS first_pick, lg.last_pick::text AS last_pick, lg.window_days,
           lg.pick_days::text[] AS pick_days, lg.still_picking, lg.lb, lg.lb_per_plant_week,
           lg.season_last_pick::text AS season_last_pick
      FROM public.stat_longest_giving lg
     WHERE lg.owner = ANY(${ids}::text[]) AND lg.grow_year = ${y}::int
       AND lg.rank_by_window <= ${LONGEST_LIMIT}::int`,
  sepSize: (sql, ids, y) => sql`
    SELECT ms.owner, ms.cultivar, ms.aug_grams, ms.aug_fruit, ms.sep_grams, ms.sep_fruit, ms.aug_g,
           ms.sep_g, ms.ratio, ms.fruit_weighted_ratio
      FROM public.stat_tomato_month_size ms
     WHERE ms.owner = ANY(${ids}::text[]) AND ms.grow_year = ${y}::int`,
  lots: (sql, ids, y) => sql`
    SELECT sl.owner, sl.lot_id, sl.cultivar, sl.crop_slug, sl.seed_count, sl.count_estimated, sl.stage,
           sl.saved_on::text AS saved_on, sl.saved_at::text AS saved_at, sl.parent_planting_id, sl.parent_name, sl.parent_lb,
           sl.source_id, sl.source_name, sl.source_kind, sl.source_locality, sl.source_address,
           sl.source_website_url, sl.source_instagram_url, sl.source_facebook_url, sl.via_name
      FROM public.stat_saved_lot sl
     WHERE sl.owner = ANY(${ids}::text[]) AND sl.grow_year = ${y}::int`,
};

export const QUERY_NAMES = Object.freeze(Object.keys(QUERIES));

const _cache = new Map();
export function _resetSeasonStatsCache() { _cache.clear(); }

function cacheKey(householdIds, year, sections) {
  return `${[...householdIds].sort().join(',')}|${year}|${sections.join(',')}`;
}

export async function handleSeasonStatsGet(ctx) {
  const { sql, householdIds, query = {}, now = () => Date.now() } = ctx;
  const year = parseSeason(query.season, new Date(now()));
  if (year == null) return { statusCode: 400, body: { error: 'season must be a four-digit grow-year, e.g. season=2026' } };
  let sections;
  try {
    sections = parseSections(query.sections);
  } catch (e) {
    return { statusCode: 400, body: { error: e.message, allowed: SECTION_IDS } };
  }

  const key = cacheKey(householdIds, year, sections);
  const hit = _cache.get(key);
  if (hit && now() - hit.at < CACHE_TTL_MS) return { statusCode: 200, body: hit.body };

  const names = queriesFor(sections);
  const rows = await Promise.all(names.map((n) => QUERIES[n](sql, householdIds, year)));
  const results = Object.fromEntries(names.map((n, i) => [n, rows[i] ?? []]));
  const body = buildEnvelope({ year, sections, results, generatedAt: new Date(now()).toISOString() });

  if (_cache.size >= CACHE_MAX) _cache.delete(_cache.keys().next().value);
  _cache.set(key, { at: now(), body });
  return { statusCode: 200, body };
}
