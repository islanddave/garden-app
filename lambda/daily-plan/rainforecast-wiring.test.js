// BUG-RAINFCSTONEMODEL-001 — the five-model day-ahead forecast at the SEAM, through the real run().
//
// rainForecast.test.js proves the arithmetic. This file proves what can only go wrong in the wiring: that the
// overlay reaches the stored plan, that a missing / null / throwing fetcher leaves the plan exactly as the
// best_match run would have written it, that no Open-Meteo outage can be papered over by the forecast alone,
// that the showery banner keeps its best_match trigger, and — statically — that index.js actually hands the
// fetcher to run() and never folds `models=` into fetchPrecip's shared URL (no other test can see either).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import h from './handler.js';
import _cf from './_coverFlags.js';
import rf from './rainForecast.js';

const { withCoverFlags } = _cf;
const { run } = h;
const SRC = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'index.js'), 'utf8');

const USER = 'user_dave';
const SPACE = 'sp1';
const DATE = '2026-09-25';

const planting = (id, extra = {}) => withCoverFlags({
  id, name: `pepper ${id}`, project_id: 'pj1', status: 'fruiting', container_type: 'in_ground',
  container_size: null, rain_exposed: null, variety: 'pepper', genus: null, project: 'Garden',
  project_status: 'active', workspace_id: SPACE, crop_type_slug: 'pepper', covered: false,
  assignee_user_id: USER, db_cadence: null, last_water: '2026-09-22', last_fert: '2026-09-01',
  substrate_start: '2026-05-01', transplant_at: null, ...extra,
});

function pgStub() {
  const writes = [];
  const query = vi.fn(async (sql, params) => {
    if (/insert into daily_plan/.test(sql)) { writes.push(JSON.parse(params[2])); return { rows: [] }; }
    if (/from plants/.test(sql)) return { rows: [planting('p1'), planting('p2', { container_type: 'pot', container_size: '5gal' })] };
    if (/from spaces/.test(sql)) return { rows: [{ id: SPACE, postal_code: null, weather_lat: 42.5, weather_lng: -72.6 }] };
    return { rows: [] };
  });
  return { query, writes };
}

// fetchPrecip's best_match shape for 9/25 — the stored values behind "0.05″ rain expected tomorrow".
const BM = {
  forecast_lows: [58, 59, 60], forecast_dates: ['2026-09-26', '2026-09-27', '2026-09-28'],
  recent_precip_in: 0, today_precip_in: 0, today_pop: 5, upcoming_precip_in: 1.86, upcoming_pop: 82,
  tomorrow_precip_in: 0.14, tomorrow_pop: 37, day2_precip_in: 1.72, day2_pop: 82, day2_date: '2026-09-27',
  yesterday_precip_actual_in: 0,
};
const RF = rf.fromOpenMeteoModels({ daily: {
  time: ['2026-09-25', '2026-09-26', '2026-09-27'],
  precipitation_sum_gfs_global: [0, 0.37, 1.087], precipitation_sum_ecmwf_ifs025: [0, 0.846, 1.043],
  precipitation_sum_gem_seamless: [0, 0.949, 0.611], precipitation_sum_icon_seamless: [0, 0.555, 2.524],
  precipitation_sum_ncep_nbm_conus: [0, 0.165, 0.846] } }, DATE);

async function drive({ fetchRainForecast, fetchPrecip = async () => ({ ...BM }) } = {}) {
  const pg = pgStub();
  await run({
    pg, today: DATE, dryRun: false, geocodeZip: async () => ({ lat: 42.5, lng: -72.6 }),
    fetchNWS: async () => ({ tonightLow: 58, highToday: 72, code: 3, unit: 'F', short: 'Cloudy' }),
    fetchPrecip, ...(fetchRainForecast !== undefined ? { fetchRainForecast } : {}),
    fetchStation: async () => null, publishAlert: vi.fn(async () => ({ messageId: 'm' })), etHour: 9, event: {},
  });
  const plan = pg.writes.find((w) => w && w.hydrology) || pg.writes[0];
  return { plan, writes: pg.writes };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('BUG-RAINFCSTONEMODEL-001 — through the real run()', () => {
  it('stores the five-model day-ahead figures, the source, and the best_match pair they displaced', async () => {
    const fetcher = vi.fn(async () => RF);
    const { plan } = await drive({ fetchRainForecast: fetcher });
    expect(fetcher).toHaveBeenCalledWith(42.5, -72.6, DATE);
    expect(plan.hydrology).toMatchObject({
      tomorrow_precip_in: 0.58, tomorrow_pop: 100, upcoming_precip_in: 1.8,
      day2_precip_in: 1.22, day2_pop: 100, day2_date: '2026-09-27',
      forecast_source: 'mean5-v1', bm_tomorrow_precip_in: 0.14, bm_tomorrow_pop: 37,
      today_precip_in: 0, today_pop: 5,   // today stays best_match
    });
    // The advice callout under the card now speaks for the rain every source but HRRR expected.
    expect(plan.weather.callout.text).toBe('0.58" rain tomorrow (100% chance) — water containers today, let in-ground beds wait');
  });

  it('keeps the showery banner on its best_match trigger: 37% under the 50% bar, so no tomorrow flag', async () => {
    const { plan } = await drive({ fetchRainForecast: async () => RF });
    expect(plan.hydrology.status).toEqual({ ok: true, uncertainty: { flag: false } });
  });

  it('a null, an absent or a THROWING fetcher leaves the plan exactly as the best_match run writes it', async () => {
    const strip = (p) => JSON.parse(JSON.stringify(p, (k, v) => (/generated|_at$|^at$/.test(k) ? undefined : v)));
    const base = strip((await drive({ fetchRainForecast: undefined })).plan);
    expect(base.hydrology.tomorrow_precip_in).toBe(0.14);   // anti-vacuity: this IS the best_match plan
    expect(strip((await drive({ fetchRainForecast: async () => null })).plan)).toEqual(base);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const thrown = strip((await drive({ fetchRainForecast: async () => { throw new Error('boom'); } })).plan);
    expect(thrown).toEqual(base);
    const logged = err.mock.calls.map(([l]) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    expect(logged.some((l) => l.degraded === 'rain_forecast_failed' && l.space === SPACE)).toBe(true);
  });

  it('never runs without a best_match hydrology — the forecast alone cannot fabricate one', async () => {
    const fetcher = vi.fn(async () => RF);
    const { plan } = await drive({ fetchRainForecast: fetcher, fetchPrecip: async () => null });
    expect(fetcher).not.toHaveBeenCalled();
    expect(plan.hydrology.tomorrow_precip_in).toBeUndefined();
    expect(plan.hydrology.status.ok).toBe(false);
  });
});

describe('BUG-RAINFCSTONEMODEL-001 — index.js source guards', () => {
  const body = (name) => {
    const i = SRC.indexOf(`async function ${name}(`);
    expect(i, `${name} present`).toBeGreaterThan(-1);
    const j = SRC.indexOf('\n}\n', i);
    return SRC.slice(i, j);
  };

  it('fetchPrecip\'s shared call never asks for `models=` — it would empty or re-source every field it feeds', () => {
    expect(body('fetchPrecip')).not.toMatch(/models=/);
    expect(body('fetchPrecip')).not.toMatch(/rainForecast/);
  });

  it('fetchRainForecast is bounded at 6000ms and returns null on any failure', () => {
    const b = body('fetchRainForecast');
    expect(b).toContain('AbortSignal.timeout(6000)');
    expect(b).toMatch(/catch[\s\S]*return null/);
    expect(b).toContain('rainForecast.rainForecastUrl(');
    expect(b).toContain('rainForecast.fromOpenMeteoModels(');
  });

  it('exports.handler actually hands fetchRainForecast to run() — without it the feature ships dead and green', () => {
    const i = SRC.indexOf('exports.handler');
    const call = SRC.slice(i).match(/await run\(\{[^}]*\}\)/);
    expect(call, 'the run({...}) call in exports.handler').toBeTruthy();
    expect(call[0].length).toBeLessThan(800);
    expect(call[0]).toMatch(/\bfetchRainForecast\b/);
  });
});
