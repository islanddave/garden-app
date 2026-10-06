// season-stats-sections.js — V5-SEASONSTATS-001. PURE shapers for GET /api/harvests/season-stats.
//
// Every number is computed in the stat_* views (migrations/v5-seasonstats-001/0a-additive-ddl.sql).
// This module only does the three things a view cannot: merge rows across household OWNERS (a view
// is keyed by owner and cannot know the household, which lives in GARDEN_HOUSEHOLD_IDS), round for
// the wire (pounds to LB_DP only — display rounding is the client's), and lay each section out in the v1 contract. The contract is
// tests/fixtures/season-stats.v1.json — keys, nesting and types there are the source of truth, and
// season-stats-sections.test.js holds this module to that file.
//
// No verdict sentences and no Limits prose leave the server: meta carries numbers and limit codes,
// and the client writes the words (plan D4).
//
// DB-free so it unit-tests under the root vitest run without neon/clerk/aws (same split as
// aggregate.js / watch.js).

export const STATS_VERSION = 1;

// Order is the page order and the envelope's key order.
export const SECTION_IDS = Object.freeze([
  'ribbon', 'sources', 'heat_clock', 'heat_ladder', 'tomato_keep', 'longest', 'sep_size', 'seed_lots',
]);

// The six care kinds the ribbon shows, in legend order. stat_care_day also emits 'picking', which the
// ribbon leaves out (picks have their own sections).
export const CARE_KINDS = Object.freeze(['water', 'feed', 'pests', 'starts', 'upkeep', 'checkins']);

// Order + labels of stat_source_mix.source_group (mirrors SOURCE_GROUP in the reference compute.py).
export const SOURCE_GROUPS = Object.freeze(['nursery', 'seed', 'rescued', 'gift', 'other', 'none']);

// Slugs in ceiling order. MUST match HEAT_BANDS in lambda/varieties/crop-derive.js and the CASE in
// stat_planting — heat-bands-parity.test.js enforces all three. Labels are the v1 contract's
// ("Very hot", sentence case), not crop-derive's title-case "Very Hot".
export const HEAT_BANDS = Object.freeze([
  { slug: 'sweet', label: 'Sweet', max: 0 },
  { slug: 'mild', label: 'Mild', max: 999 },
  { slug: 'medium', label: 'Medium', max: 9999 },
  { slug: 'hot', label: 'Hot', max: 49999 },
  { slug: 'very_hot', label: 'Very hot', max: 249999 },
  { slug: 'superhot', label: 'Superhot', max: Infinity },
]);

export const LONGEST_LIMIT = 15;
export const TOMATO_MEASURED_SHARE_MIN = 0.7;
export const SEP_MIN_FRUIT = 5;
// Every pound figure leaves the server at 3 dp and is rounded ONCE, by the client, for display. Two
// sections rounding the same planting's pounds to different places (2 dp here, 1 dp there) put two
// different figures for one plant on one page (4.3 on the keep list, 4.2 on its saved-seed card).
export const LB_DP = 3;

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────

// Neon hands back numeric as a string and float8 as a number; null stays null.
export function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
export function round(v, dp = 0) {
  const n = num(v);
  if (n == null) return null;
  const f = 10 ** dp;
  return Math.round((n + Number.EPSILON * Math.sign(n)) * f) / f;
}
const int = (v) => round(v, 0) ?? 0;
// A date column arrives as 'YYYY-MM-DD' (the handler casts ::text); a Date is tolerated for tests.
export function day(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}
const minDay = (a, b) => (a == null ? b : b == null ? a : (a <= b ? a : b));
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// A per-owner statistic (a median, a pooled ratio) cannot be merged by summing. When a household has
// more than one owner contributing rows, report the owner with the most rows — documented as a limit
// of the per-owner views, and moot today (one owner holds every planting that produces).
function dominantOwnerValue(rows, key) {
  const byOwner = new Map();
  for (const r of rows) {
    const o = byOwner.get(r.owner) ?? { n: 0, v: r[key] };
    o.n += 1;
    byOwner.set(r.owner, o);
  }
  let best = null;
  for (const o of byOwner.values()) if (!best || o.n > best.n) best = o;
  return best ? best.v : null;
}

export function seasonSpan(year) {
  return { year, start: `${year - 1}-11-01`, end: `${year}-10-31` };
}

function section(id, generatedAt, meta, series) {
  return { section: id, version: STATS_VERSION, generatedAt, meta, series };
}

function mergePins(pins) {
  const out = { first_sow: null, first_setout: null, hottest: null, wettest: null, weather_from: null };
  for (const p of pins ?? []) {
    out.first_sow = minDay(out.first_sow, day(p.first_sow));
    out.first_setout = minDay(out.first_setout, day(p.first_setout));
    out.weather_from = minDay(out.weather_from, day(p.weather_from));
    const ht = num(p.hottest_tmax_f);
    if (ht != null && (!out.hottest || ht > out.hottest.tmax_f
        || (ht === out.hottest.tmax_f && day(p.hottest_day) < out.hottest.date))) {
      out.hottest = { date: day(p.hottest_day), tmax_f: ht };
    }
    const wp = num(p.wettest_precip_in);
    if (wp != null && (!out.wettest || wp > out.wettest.precip_in
        || (wp === out.wettest.precip_in && day(p.wettest_day) < out.wettest.date))) {
      out.wettest = { date: day(p.wettest_day), precip_in: wp };
    }
  }
  return out;
}

// ── sections ─────────────────────────────────────────────────────────────────────────────────────

export function shapeRibbon({ weather = [], care = [], pins = [], weeks = [] }, generatedAt) {
  const p = mergePins(pins);
  // Care kinds per day, union across owners. Totals count DAYS, not rows.
  const careByDay = new Map();
  const kindDays = new Map(CARE_KINDS.map((k) => [k, new Set()]));
  for (const c of care) {
    if (!kindDays.has(c.care_kind)) continue;
    const d = day(c.day);
    kindDays.get(c.care_kind).add(d);
    if (!careByDay.has(d)) careByDay.set(d, new Set());
    careByDay.get(d).add(c.care_kind);
  }
  const seen = new Set();
  const days = [];
  for (const w of [...weather].sort((a, b) => cmp(day(a.day), day(b.day)))) {
    const d = day(w.day);
    if (seen.has(d)) continue;
    seen.add(d);
    days.push({
      date: d, tmax_f: num(w.tmax_f), tmin_f: num(w.tmin_f), precip_in: num(w.precip_in),
      care: [...(careByDay.get(d) ?? [])].sort(),
    });
  }
  // One weather owner per week in practice; fruit sums across owners, heat is taken once per week.
  const wk = new Map();
  for (const w of weeks) {
    const k = day(w.week_start);
    const cur = wk.get(k);
    if (!cur) {
      wk.set(k, {
        week_start: k, heat_units: num(w.heat_units), cool_nights: num(w.cool_nights),
        rain_in: num(w.rain_in), tomato_fruit: num(w.tomato_fruit) ?? 0, pepper_pods: num(w.pepper_pods) ?? 0,
      });
    } else {
      cur.tomato_fruit += num(w.tomato_fruit) ?? 0;
      cur.pepper_pods += num(w.pepper_pods) ?? 0;
    }
  }
  const weekRows = [...wk.values()].sort((a, b) => cmp(a.week_start, b.week_start)).map((w) => ({
    week_start: w.week_start, heat_units: int(w.heat_units), cool_nights: int(w.cool_nights),
    rain_in: round(w.rain_in, 2) ?? 0, tomato_fruit: int(w.tomato_fruit), pepper_pods: int(w.pepper_pods),
  }));
  const weatherFrom = p.weather_from ?? days[0]?.date ?? null;
  return section('ribbon', generatedAt, {
    pins: { first_sow: p.first_sow, first_setout: p.first_setout, hottest: p.hottest, wettest: p.wettest },
    care_day_totals: Object.fromEntries(CARE_KINDS.map((k) => [k, kindDays.get(k).size])),
    limits: [{ code: 'weather_from', date: weatherFrom }, { code: 'care_counted_in_days' }],
  }, { days, weeks: weekRows });
}

export function shapeSources({ mix = [], cards = [] }, generatedAt) {
  const groups = new Map(SOURCE_GROUPS.map((g) => [g, { group: g, plantings: 0, plants: 0 }]));
  for (const m of mix) {
    const g = groups.get(m.source_group) ?? groups.get('other');
    g.plantings += num(m.plantings) ?? 0;
    g.plants += num(m.plants) ?? 0;
  }
  const bySource = new Map();
  for (const c of cards) {
    const key = c.source_id ?? null;
    const cur = bySource.get(key) ?? {
      source_id: key, name: c.name ?? null, kind: c.kind ?? null,
      plantings: 0, plants: 0, picked: 0, lost: 0, lb: 0, saved_lots: 0,
    };
    cur.plantings += num(c.plantings) ?? 0;
    cur.plants += num(c.plants) ?? 0;
    cur.picked += num(c.picked) ?? 0;
    cur.lost += num(c.lost) ?? 0;
    cur.lb += num(c.lb) ?? 0;
    cur.saved_lots += num(c.saved_lots) ?? 0;
    bySource.set(key, cur);
  }
  const none = bySource.get(null);
  bySource.delete(null);
  const total = [...bySource.values()].reduce((s, c) => s + c.lb, 0) + (none?.lb ?? 0);
  const out = [...bySource.values()]
    .map((c) => ({
      source_id: c.source_id, name: c.name, kind: c.kind, plantings: c.plantings, plants: int(c.plants),
      picked: c.picked, lost: c.lost, lb: round(c.lb, LB_DP), saved_lots: c.saved_lots,
    }))
    .sort((a, b) => b.lb - a.lb || b.plantings - a.plantings || cmp(a.name ?? '', b.name ?? ''));
  // The no-source card carries counts and pounds only: "plants/picked/lost from nowhere" reads as a
  // source of its own, which is exactly the misreading the card exists to prevent.
  if (none) {
    out.push({
      source_id: null, name: null, kind: null, plantings: none.plantings, plants: null, picked: null,
      lost: null, lb: round(none.lb, LB_DP), saved_lots: none.saved_lots,
    });
  }
  return section('sources', generatedAt, {
    total_lb: round(total, LB_DP),
    limits: [{ code: 'archived_included' }, { code: 'no_source_lb', lb: round(none?.lb ?? 0, LB_DP) }],
  }, {
    by_type: [...groups.values()].map((g) => ({ group: g.group, plantings: g.plantings, plants: int(g.plants) })),
    cards: out,
  });
}

export function shapeHeatClock({ crops = [], cultivars = [], pins = [] }, generatedAt) {
  const byCrop = new Map();
  for (const r of crops) {
    const cur = byCrop.get(r.crop_slug);
    if (!cur || day(r.first_pick) < day(cur.first_pick)) byCrop.set(r.crop_slug, r);
  }
  const origin = mergePins(pins).weather_from
    ?? crops.map((r) => day(r.origin_date)).reduce(minDay, null);
  const median = (crop) => {
    const rows = cultivars.filter((r) => r.crop_slug === crop);
    return rows.length ? round(dominantOwnerValue(rows, 'crop_median_heat')) : null;
  };
  return section('heat_clock', generatedAt, {
    origin_date: origin,
    median_heat: { tomato: median('tomato'), pepper: median('pepper') },
    limits: [
      { code: 'weather_from', date: origin }, { code: 'excluded_approx_tp' },
      { code: 'excluded_rescued_gift_swap' }, { code: 'excluded_under_21d' },
    ],
  }, {
    by_crop: [...byCrop.values()]
      .map((r) => ({
        crop_slug: r.crop_slug, crop_name: r.crop_name ?? null, first_pick: day(r.first_pick),
        heat_units: int(r.heat_units),
      }))
      .sort((a, b) => a.heat_units - b.heat_units || cmp(a.first_pick, b.first_pick) || cmp(a.crop_slug, b.crop_slug)),
    by_cultivar: cultivars
      .map((r) => ({
        planting_id: r.planting_id, crop_slug: r.crop_slug, cultivar: r.cultivar ?? null,
        transplanted_at: day(r.transplanted_at), first_pick: day(r.first_pick), days: int(r.days),
        heat_units: int(r.heat_units), heat_band: r.heat_band ?? null,
      }))
      .sort((a, b) => cmp(a.crop_slug, b.crop_slug) || a.heat_units - b.heat_units
        || cmp(a.cultivar ?? '', b.cultivar ?? '') || cmp(a.planting_id, b.planting_id)),
  });
}

export function shapeHeatLadder({ bands = [], best = [] }, generatedAt) {
  const acc = new Map(HEAT_BANDS.map((b) => [b.slug, { plantings: 0, plants: 0, pods: 0, lb: 0 }]));
  for (const r of bands) {
    const a = acc.get(r.band);
    if (!a) continue;
    a.plantings += num(r.plantings) ?? 0;
    a.plants += num(r.plants) ?? 0;
    a.pods += num(r.pods) ?? 0;
    a.lb += num(r.lb) ?? 0;
  }
  const order = new Map(HEAT_BANDS.map((b, i) => [b.slug, i]));
  return section('heat_ladder', generatedAt, {
    limits: [{ code: 'heat_is_catalogue_ceiling' }, { code: 'single_plant_only' }],
  }, {
    bands: HEAT_BANDS.map((b) => {
      const a = acc.get(b.slug);
      return { band: b.slug, label: b.label, plantings: a.plantings, plants: int(a.plants), pods: int(a.pods), lb: round(a.lb, LB_DP) };
    }),
    best: best
      .filter((r) => order.has(r.band))
      .map((r) => ({
        band: r.band, planting_id: r.planting_id, cultivar: r.cultivar ?? null, pods: int(r.pods),
        lb: round(r.lb, LB_DP), rank_in_band: int(r.rank_in_band), scoville_max: num(r.scoville_max),
      }))
      .sort((a, b) => order.get(a.band) - order.get(b.band) || a.rank_in_band - b.rank_in_band
        || cmp(a.planting_id, b.planting_id)),
  });
}

export function shapeTomatoKeep({ rows = [] }, generatedAt) {
  const median = rows.length ? num(dominantOwnerValue(rows, 'median_lb')) : null;
  return section('tomato_keep', generatedAt, {
    median_lb: round(median, LB_DP),
    limits: [{ code: 'single_plant_only' }, { code: 'measured_share_min', share: TOMATO_MEASURED_SHARE_MIN }],
  }, {
    rows: rows
      .map((r) => ({
        planting_id: r.planting_id, cultivar: r.cultivar ?? null, lb: round(r.lb, LB_DP), fruit: int(r.fruit),
        g_per_fruit: round(r.g_per_fruit), container_size: r.container_size ?? null,
        measured_share: round(r.measured_share, 2), x_median: round(r.x_median, 2), verdict: r.verdict,
        flags: r.late_aug ? ['late_aug'] : [],
      }))
      .sort((a, b) => b.lb - a.lb || cmp(a.cultivar ?? '', b.cultivar ?? '') || cmp(a.planting_id, b.planting_id)),
  });
}

export function shapeLongest({ rows = [] }, generatedAt) {
  const last = rows.map((r) => day(r.season_last_pick)).reduce((a, b) => (a == null || (b && b > a) ? b : a), null);
  const top = [...rows]
    .sort((a, b) => int(b.window_days) - int(a.window_days) || (num(b.lb) ?? 0) - (num(a.lb) ?? 0)
      || cmp(a.planting_id, b.planting_id))
    .slice(0, LONGEST_LIMIT);
  return section('longest', generatedAt, { last_pick: last, limits: [{ code: 'so_far' }] }, {
    rows: top.map((r) => ({
      planting_id: r.planting_id, cultivar: r.cultivar ?? null, crop_name: r.crop_name ?? null,
      plants: int(r.plants), first_pick: day(r.first_pick), last_pick: day(r.last_pick),
      window_days: int(r.window_days), pick_days: (r.pick_days ?? []).map(day),
      still_picking: Boolean(r.still_picking), lb: round(r.lb, LB_DP), lb_per_plant_week: round(r.lb_per_plant_week, LB_DP),
    })),
  });
}

export function shapeSepSize({ rows = [] }, generatedAt) {
  let ratio = null;
  if (rows.length) {
    if (new Set(rows.map((r) => r.owner)).size <= 1) {
      ratio = num(rows[0].fruit_weighted_ratio);
    } else {
      // Pooling is additive across owners, so this one merges exactly.
      const s = (k) => rows.reduce((t, r) => t + (num(r[k]) ?? 0), 0);
      ratio = (s('sep_grams') / s('sep_fruit')) / (s('aug_grams') / s('aug_fruit'));
    }
  }
  return section('sep_size', generatedAt, {
    fruit_weighted_ratio: round(ratio, 2),
    limits: [{ code: 'measured_counts_only' }, { code: 'min_fruit_per_month', n: SEP_MIN_FRUIT }],
  }, {
    rows: rows
      .map((r) => ({
        cultivar: r.cultivar ?? null, aug_g: int(r.aug_g), sep_g: int(r.sep_g),
        aug_n: int(r.aug_fruit), sep_n: int(r.sep_fruit), ratio: round(r.ratio, 2),
      }))
      .sort((a, b) => a.ratio - b.ratio || cmp(a.cultivar ?? '', b.cultivar ?? '')),
  });
}

export function shapeSeedLots({ rows = [] }, generatedAt) {
  return section('seed_lots', generatedAt, { limits: [{ code: 'chain_stops_at_nursery' }] }, {
    rows: [...rows]
      .sort((a, b) => cmp(String(a.saved_at ?? a.saved_on ?? ''), String(b.saved_at ?? b.saved_on ?? ''))
        || cmp(a.lot_id, b.lot_id))
      .map((r) => ({
        lot_id: r.lot_id, cultivar: r.cultivar ?? null, crop_slug: r.crop_slug ?? null,
        count: r.seed_count == null ? null : int(r.seed_count), count_estimated: Boolean(r.count_estimated),
        stage: r.stage ?? '', saved_on: day(r.saved_on),
        parent: r.parent_planting_id
          ? { planting_id: r.parent_planting_id, name: r.parent_name ?? null, lb: round(r.parent_lb, LB_DP) }
          : null,
        parent_count: int(r.parent_count),
        source: r.source_name
          ? {
            id: r.source_id, name: r.source_name, kind: r.source_kind ?? null, locality: r.source_locality ?? null,
            address: r.source_address ?? null, website_url: r.source_website_url ?? null,
            instagram_url: r.source_instagram_url ?? null, facebook_url: r.source_facebook_url ?? null,
            via: r.via_name ?? null,
          }
          : null,
      })),
  });
}

// Which query results each section needs. The handler runs the union for the requested sections.
export const SECTION_QUERIES = Object.freeze({
  ribbon: ['weather', 'care', 'pins', 'weeks'],
  sources: ['mix', 'cards'],
  heat_clock: ['crops', 'cultivars', 'pins'],
  heat_ladder: ['bands', 'best'],
  tomato_keep: ['tomatoKeep'],
  longest: ['longest'],
  sep_size: ['sepSize'],
  seed_lots: ['lots'],
});

const SHAPERS = {
  ribbon: (q, g) => shapeRibbon({ weather: q.weather, care: q.care, pins: q.pins, weeks: q.weeks }, g),
  sources: (q, g) => shapeSources({ mix: q.mix, cards: q.cards }, g),
  heat_clock: (q, g) => shapeHeatClock({ crops: q.crops, cultivars: q.cultivars, pins: q.pins }, g),
  heat_ladder: (q, g) => shapeHeatLadder({ bands: q.bands, best: q.best }, g),
  tomato_keep: (q, g) => shapeTomatoKeep({ rows: q.tomatoKeep }, g),
  longest: (q, g) => shapeLongest({ rows: q.longest }, g),
  sep_size: (q, g) => shapeSepSize({ rows: q.sepSize }, g),
  seed_lots: (q, g) => shapeSeedLots({ rows: q.lots }, g),
};

// null for no param (= every section); throws { unknown } on an id outside SECTION_IDS so the
// handler can 400 with the allowed list rather than silently returning less than was asked for.
export function parseSections(raw) {
  if (raw == null || String(raw).trim() === '') return [...SECTION_IDS];
  const asked = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = asked.filter((s) => !SECTION_IDS.includes(s));
  if (unknown.length) {
    const err = new Error(`unknown section(s): ${unknown.join(', ')}`);
    err.unknown = unknown;
    throw err;
  }
  return SECTION_IDS.filter((s) => asked.includes(s));
}

export function queriesFor(sections) {
  return [...new Set(sections.flatMap((s) => SECTION_QUERIES[s]))];
}

export function buildEnvelope({ year, sections, results, generatedAt }) {
  const out = {};
  for (const id of sections) out[id] = SHAPERS[id](results, generatedAt);
  return { version: STATS_VERSION, generatedAt, season: seasonSpan(year), sections: out };
}
