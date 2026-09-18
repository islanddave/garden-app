// BUG-FETCHPRECIPZERO-001 — fetchPrecip on an Open-Meteo ERROR body, and what every consumer does with it.
//
// THE DEFECT. An Open-Meteo error is JSON (measured live 2026-09-18: an invalid daily variable answers
// HTTP 400 with {"error":true,"reason":"Cannot initialize ForecastVariableDaily from invalid String value
// ..."}), so `.json()` succeeds on it. fetchPrecip checked neither r.ok nor that `daily` existed, so the
// body became a NON-null hydrology whose four rain fields were `|| 0` zeros, hydrologyStatus called the
// data complete, and nothing was logged. 2026-09-02 19:30Z ran on exactly that shape: no `fetchPrecip
// failed` WARN, no `weather-daily-write` line, `remainingFallback: ["no_hourly"]`, `forecastCoveredDays: 0`.
//
// THE INSTRUMENT. index.js cannot be imported by the unit suite (AWS SDK + neon at load — see
// openmeteo-indices.test.js), and a source regex cannot tell a shape from a value. So the REAL source of
// fetchPrecip, and of the round2/round3 helpers it closes over, is compiled into a callable and handed a
// stubbed fetch. The consumer half then passes that real function into handler.run() — the production
// entry point — and reads back the row that would have been written.
//
// THE ORACLE for "not worse". The brief's bar is that a missing forecast must not water worse than the
// fabricated "no rain" did. That is asserted directly: the same run is driven with the OLD return value
// (reconstructed below from the base source) and with the new path, and everything in the stored row
// outside `hydrology` must be byte-identical — tasks, counts, callout, substrate — under default flags
// AND with every rain flag on. The only permitted differences are inside `hydrology`, and those are
// pinned exactly.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import handler from './handler.js';
import station from './station.js';
import { computeWateringScale } from '../../src/lib/wateringScale.js';
import { bedWaitActive } from '../../src/lib/careNeeded.js';
import { hydrologySourceLabel } from '../../src/components/today/WeatherWidget.jsx';

const { deriveStation, mergeStationHydrology } = station;
const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');

// ── the real fetchPrecip, compiled ────────────────────────────────────────────────────────────────
// Cut at the function's own closing brace at column 0 (same method as openmeteo-indices.test.js). Each
// extraction is checked so a refactor fails LOUDLY here instead of compiling something vacuous.
const compiled = (() => {
  const start = SRC.indexOf('async function fetchPrecip');
  if (start < 0) throw new Error('fetchPrecip not found in index.js');
  const tail = SRC.slice(start);
  const end = tail.indexOf('\n}\n');
  if (end < 0) throw new Error('fetchPrecip closing brace not found');
  const body = tail.slice(0, end + 3);
  if (!/recent_precip_in:/.test(body) || !/fetchPrecip failed/.test(body)) throw new Error('fetchPrecip extraction truncated');
  const r2 = SRC.match(/^const round2 = .*$/m);
  const r3 = SRC.match(/^const round3 = .*$/m);
  if (!r2 || !r3) throw new Error('round2/round3 not found in index.js');
  return new Function('fetch', 'AbortSignal', 'console', `${r2[0]}\n${r3[0]}\n${body}\nreturn fetchPrecip;`);
})();

// A Response-shaped stub: `ok` derived from the status exactly as the Fetch spec does, and `.json()`
// rejecting on a non-JSON body exactly as Response.json() does.
const respond = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => (typeof body === 'string' ? JSON.parse(body) : structuredClone(body)),
});

function realFetchPrecip(res) {
  const out = { warn: vi.fn(), log: vi.fn(), error: vi.fn() };
  const fetchImpl = vi.fn(async () => res);
  const fp = compiled(fetchImpl, { timeout: () => undefined }, out);
  return { fp, console: out, fetchImpl };
}

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────────
const TODAY = '2026-09-02';
const TIMES = ['2026-08-31', '2026-09-01', TODAY, '2026-09-03', '2026-09-04', '2026-09-05'];
const HEALTHY = {
  timezone: 'America/New_York',
  daily: {
    time: TIMES,
    precipitation_sum: [0.1, 0.213, 0.05, 0.3, 0.453, 0.102],
    precipitation_probability_max: [1, 52, 20, 70, 81, 72],
    temperature_2m_min: [51.2, 64.8, 57.3, 48.0, 44.6, 50.9],
    et0_fao_evapotranspiration: [0.151, 0.162, 0.173, 0.14, 0.13, 0.12],
    temperature_2m_max: [80, 81, 73, 75, 70, 68],
    daylight_duration: [47000, 46800, 46600, 46400, 46200, 46000],
    sunshine_duration: [30000, 12000, 20000, 25000, 5000, 28000],
    shortwave_radiation_sum: [18.1, 9.2, 14.3, 16.4, 6.5, 17.6],
    wind_speed_10m_max: [8.1, 9.2, 7.3, 6.4, 11.5, 5.6],
    precipitation_hours: [1, 3, 2, 4, 5, 1],
  },
  hourly: {
    time: [`${TODAY}T16:00`, `${TODAY}T17:00`], precipitation: [0.01, 0.02],
    dew_point_2m: [55, 54], cloud_cover: [80, 70], wind_speed_10m: [5, 4],
  },
};
const DRY = { ...HEALTHY, daily: { ...HEALTHY.daily, precipitation_sum: [0, 0, 0, 0, 0, 0] } };
// The real error shape, verbatim from the live probe. The brief's "09-02 shape" is this body with
// HTTP 200 (ok JSON, no daily, no hourly); a real Open-Meteo error arrives with 400.
const ERROR_BODY = { error: true, reason: 'Invalid value: Cannot initialize ForecastVariableDaily from invalid String value precipitation_sumX' };

// What the PRE-FIX fetchPrecip returned for a body with no `daily` and no `hourly`. Reconstructed from the
// base source (115a31f51ab15179bc35daaf9399a185956a0bda, index.js:196-325) and confirmed by executing that
// source against ERROR_BODY during this lane: the four `|| 0` fields are 0, everything else null or empty.
const OLD_FABRICATED = Object.freeze({
  forecast_lows: [null, null, null], forecast_dates: [null, null, null],
  recent_precip_in: 0, today_precip_in: 0, today_pop: null, upcoming_precip_in: 0,
  tomorrow_precip_in: 0, tomorrow_pop: null, upcoming_pop: null, yesterday_precip_actual_in: null,
  today_et0_in: null, today_tmax_f: null, wetness_window: [], hourly_precip: null, hourly_frost: null,
  settled_days: [],
});

const RAIN_KEYS = ['recent_precip_in', 'today_precip_in', 'upcoming_precip_in', 'tomorrow_precip_in'];

describe('fetchPrecip refuses an error response — null, the WARN, never zeros', () => {
  it('THE 09-02 SHAPE: HTTP 200 JSON with no daily and no hourly -> null, and the run is no longer silent', async () => {
    const { fp, console: c } = realFetchPrecip(respond(ERROR_BODY, 200));
    expect(await fp(42.5, -72.6)).toBeNull();
    expect(c.warn).toHaveBeenCalledTimes(1);
    const line = JSON.parse(c.warn.mock.calls[0][0]);
    expect(line.msg).toBe('fetchPrecip failed — hydrology null');   // the EXISTING line, unchanged
    expect(line.error).toMatch(/^Open-Meteo body has no daily block: /);
    expect(line.error).toContain('invalid String value precipitation_sumX');
  });

  it('a real Open-Meteo error (HTTP 400 + JSON reason) -> null, and the WARN names the status and reason', async () => {
    const { fp, console: c } = realFetchPrecip(respond(ERROR_BODY, 400));
    expect(await fp(42.5, -72.6)).toBeNull();
    const line = JSON.parse(c.warn.mock.calls[0][0]);
    expect(line.error).toMatch(/^Open-Meteo HTTP 400: Invalid value: Cannot initialize/);
  });

  it('the STATUS decides, not the body: a non-ok response carrying a full daily block is still refused', async () => {
    // Isolates the r.ok guard. Without it this body would map cleanly and the error would be invisible.
    const { fp, console: c } = realFetchPrecip(respond(HEALTHY, 500));
    expect(await fp(42.5, -72.6)).toBeNull();
    expect(JSON.parse(c.warn.mock.calls[0][0]).error).toBe('Open-Meteo HTTP 500');
  });

  it('an HTML 503 still degrades to null, and now says which status it was', async () => {
    const { fp, console: c } = realFetchPrecip(respond('<html><body>503 Service Unavailable</body></html>', 503));
    expect(await fp(42.5, -72.6)).toBeNull();
    expect(JSON.parse(c.warn.mock.calls[0][0]).error).toBe('Open-Meteo HTTP 503');
  });

  it('an empty 200 body -> null', async () => {
    const { fp } = realFetchPrecip(respond({}, 200));
    expect(await fp(42.5, -72.6)).toBeNull();
  });

  it('caps the upstream reason — it is Open-Meteo free text and can echo a request parameter', async () => {
    const { fp, console: c } = realFetchPrecip(respond({ error: true, reason: 'x'.repeat(5000) }, 429));
    expect(await fp(42.5, -72.6)).toBeNull();
    const err = JSON.parse(c.warn.mock.calls[0][0]).error;
    expect(err.startsWith('Open-Meteo HTTP 429: x')).toBe(true);
    expect(err.length).toBeLessThanOrEqual('Open-Meteo HTTP 429: '.length + 200);
  });
});

describe('fetchPrecip on a body that IS a forecast — keep what is really there, null what is not', () => {
  it('healthy body: the four rain fields are the real sums, and nothing is logged', async () => {
    const { fp, console: c } = realFetchPrecip(respond(HEALTHY));
    const hy = await fp(42.5, -72.6);
    expect(hy.recent_precip_in).toBe(0.31);       // D-2 + D-1 = 0.1 + 0.213
    expect(hy.today_precip_in).toBe(0.05);        // D0
    expect(hy.tomorrow_precip_in).toBe(0.3);      // D1
    expect(hy.upcoming_precip_in).toBe(0.75);     // D1 + D2 = 0.3 + 0.453
    expect([hy.today_pop, hy.tomorrow_pop, hy.upcoming_pop]).toEqual([20, 70, 81]);
    expect(hy.forecast_lows).toEqual([48.0, 44.6, 50.9]);
    expect(hy.hourly_precip).not.toBeNull();
    expect(c.warn).not.toHaveBeenCalled();
  });

  it('a genuinely DRY day stays 0 — real zeros are data, not absence', async () => {
    const { fp } = realFetchPrecip(respond(DRY));
    const hy = await fp(42.5, -72.6);
    for (const k of RAIN_KEYS) expect(hy[k], k).toBe(0);
  });

  it('partial daily: a missing term nulls its own field and every sum it is in, and nothing else', async () => {
    const partial = {
      timezone: 'America/New_York',   // no hourly block at all
      daily: {
        time: TIMES,
        precipitation_sum: [0.1, null, 0.05, 0.3, null, 0.1],   // D-1 and D2 missing
        temperature_2m_min: HEALTHY.daily.temperature_2m_min,   // no precipitation_probability_max array
      },
    };
    const { fp, console: c } = realFetchPrecip(respond(partial));
    const hy = await fp(42.5, -72.6);
    expect(hy.recent_precip_in).toBeNull();        // D-2 + (missing D-1) is not 0.1
    expect(hy.today_precip_in).toBe(0.05);         // present -> kept
    expect(hy.tomorrow_precip_in).toBe(0.3);       // present -> kept
    expect(hy.upcoming_precip_in).toBeNull();      // D1 + (missing D2) is not 0.3
    expect([hy.today_pop, hy.tomorrow_pop, hy.upcoming_pop]).toEqual([null, null, null]);
    expect(hy.yesterday_precip_actual_in).toBeNull();
    expect(hy.settled_days.map((d) => d.precip_in)).toEqual([0.1, null]);
    expect(hy.forecast_lows).toEqual([48.0, 44.6, 50.9]);   // the lows were really there
    expect(hy.hourly_precip).toBeNull();
    expect(hy.hourly_frost).toBeNull();
    expect(c.warn).not.toHaveBeenCalled();          // partial is data, not a failed fetch
  });

  it('a daily block with no precipitation_sum at all: all four rain fields null, the rest kept', async () => {
    const noRain = { ...HEALTHY, daily: { ...HEALTHY.daily } };
    delete noRain.daily.precipitation_sum;
    const { fp } = realFetchPrecip(respond(noRain));
    const hy = await fp(42.5, -72.6);
    for (const k of RAIN_KEYS) expect(hy[k], k).toBeNull();
    expect(hy.today_pop).toBe(20);
    expect(hy.today_et0_in).toBe(0.173);
    expect(hy.forecast_lows).toEqual([48.0, 44.6, 50.9]);
  });
});

// ── consumers, through the real entry point ─────────────────────────────────────────────────────────
const SPACE = 'sp-1';
const USER = 'user_1';
const MAC = 'AA:BB:CC:DD:EE:FF';
const planting = (id, over = {}) => ({
  id, name: `Planting ${id}`, project_id: 'pj1', project: 'Beds', project_status: 'active', status: 'growing',
  container_type: 'in_ground', container_size: null, rain_exposed: null, variety: null, genus: 'generic',
  workspace_id: SPACE, crop_type_slug: 'tomato', covered: false, assignee_user_id: USER,
  rain_exposed_resolved: true, frost_covered_resolved: false,
  db_cadence: { crop: 'generic', water_interval_days_container: 3, water_interval_days_inground: 3 },
  last_water: '2026-08-27', last_fert: '2026-08-01', substrate_start: '2026-05-01', transplant_at: null,
  ...over,
});
// An outdoor bed, an outdoor 5-gal fabric bag, a pot under cover, and a never-watered planting: the rain
// credit, the tiered credit, the covered exclusion and the never branch all get exercised. The bed was
// watered exactly one interval ago, so it is due on a dry day and a one-day rain credit covers it — the
// gap a credit can close (a bag last watered six days ago is still due after one).
const PLANTINGS = [
  planting('bed', { last_water: '2026-08-30' }),
  planting('bag', { container_type: 'fabric_bag', container_size: '5 gal' }),
  planting('pot', { container_type: 'plastic_pot', container_size: '1 gal', covered: true, rain_exposed_resolved: false, frost_covered_resolved: true }),
  planting('new', { last_water: null }),
];
const mockPg = () => ({
  query: vi.fn(async (sql) => {
    if (/from plants/.test(sql)) return { rows: PLANTINGS.map((p) => ({ ...p })) };
    if (/from spaces/.test(sql)) return { rows: [{ id: SPACE, postal_code: null, weather_lat: 42.5, weather_lng: -72.6 }] };
    return { rows: [] };
  }),
});
const storedPlan = (pg) => {
  const rows = pg.query.mock.calls.filter(([sql]) => /insert into daily_plan/.test(sql)).map(([, p]) => JSON.parse(p[2]));
  expect(rows).toHaveLength(1);
  return rows[0];
};
const withoutHydrology = ({ hydrology, ...rest }) => rest;   // eslint-disable-line no-unused-vars

// The 09-02 gauge, one record per civil day (EDT): D0 0.12 so far at 15:25, D-1 0.40, D-2 0.20, plus a
// coverage anchor on D-3 so the two-day lookback is complete. The clock is pinned 5 minutes later.
const rec = (day, hhmm, dailyrainin, tempf = 68) => ({ dateutc: Date.parse(`${day}T${hhmm}:00-04:00`), dailyrainin, tempf });
const STATION_RAW = { mac: MAC, records: [
  rec(TODAY, '15:25', 0.12), rec('2026-09-01', '23:00', 0.40), rec('2026-08-31', '18:00', 0.20), rec('2026-08-30', '18:00', 0),
] };
const NOW = Date.parse('2026-09-02T19:30:05Z');   // the 09-02 evaluating run, 15:30 EDT

const RAIN_FLAGS = ['CARE_RAIN_CREDIT_ENABLED', 'CARE_RAIN_MAXDAYS_ENABLED', 'CARE_TODAY_AWARE_ENABLED',
  'CARE_RAIN_MEASURED_CREDIT_ENABLED', 'CARE_RAIN_DEFER_DRY_ENABLED', 'CARE_RAIN_SOON_ENABLED'];

async function drive({ fetchPrecip, bound, flagsOn = false }) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubEnv('AWN_STATIONS_JSON', bound ? JSON.stringify([{ mac: MAC, tz: 'America/New_York', lat: 42.5, lng: -72.6, schema_version: 1 }]) : '');
  for (const f of RAIN_FLAGS) vi.stubEnv(f, flagsOn ? 'true' : '');
  const logs = [];
  vi.spyOn(console, 'log').mockImplementation((s) => { try { logs.push(JSON.parse(s)); } catch (_) { /* not a JSON line */ } });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const pg = mockPg();
  await handler.run({
    pg, today: TODAY, dryRun: false,
    geocodeZip: async () => ({ lat: 42.5, lng: -72.6 }),
    // NWS as it was on 09-02: tonight 61F, high 73F (the frost-eval line's tonightLowF / highTodayF).
    fetchNWS: async () => ({ tonightLow: 61, highToday: 73, code: 3, unit: 'F', short: 'Cloudy' }),
    fetchPrecip,
    fetchStation: async () => (bound ? STATION_RAW : null),
    publishAlert: vi.fn(async () => ({ messageId: 'm1' })),
    etHour: 15, event: {},
  });
  return { stored: storedPlan(pg), logs };
}
const oldPath = () => async () => structuredClone(OLD_FABRICATED);
const newPath = () => realFetchPrecip(respond(ERROR_BODY, 200)).fp;

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('consumers — no station bound', () => {
  it('stored hydrology is the designed "Open-Meteo down" shape: no invented rain, status incomplete', async () => {
    const { stored, logs } = await drive({ fetchPrecip: newPath(), bound: false });
    expect(stored.hydrology).toEqual({
      status: { ok: false, uncertainty: { flag: true, reason: 'precip data incomplete — watering advice assumes no rain credit' } },
    });
    // The space-wx observability line now tells the truth about the fetch (it read hy:true on the old shape).
    expect(logs.find((l) => l.msg === 'space-wx').hy).toBe(false);
  });

  for (const flagsOn of [false, true]) {
    it(`NOT WORSE (${flagsOn ? 'every rain flag on' : 'default flags'}): every task, count and callout is byte-identical to the fabricated-zero run`, async () => {
      const before = await drive({ fetchPrecip: oldPath(), bound: false, flagsOn });
      vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs();
      const after = await drive({ fetchPrecip: newPath(), bound: false, flagsOn });
      expect(withoutHydrology(after.stored)).toEqual(withoutHydrology(before.stored));
      expect(after.stored.water_due.map((r) => r.id).sort()).toEqual(['bag', 'bed', 'pot']);
      expect(after.stored.no_history.map((r) => r.id)).toEqual(['new']);
      expect(after.stored.rain_skipped).toEqual([]);
      // The client's watering call and bed-wait read the stored row: same answer from both rows.
      expect(computeWateringScale(after.stored.hydrology, after.stored.weather))
        .toEqual(computeWateringScale(before.stored.hydrology, before.stored.weather));
      expect(bedWaitActive(after.stored)).toBe(false);
      expect(bedWaitActive(before.stored)).toBe(false);
    });
  }
});

describe('consumers — the 09-02 configuration: fresh gauge bound to the Space', () => {
  it('replays the 09-02 log lines: frost path unchanged, and the station fallback is the one prod logged', async () => {
    const { logs } = await drive({ fetchPrecip: newPath(), bound: true });
    const frost = logs.find((l) => l.msg === 'frost-eval');
    expect(frost).toMatchObject({ forecastCoveredDays: 0, forecastMinLowF: null, tonightLowF: 61, degraded: false });
    const st = logs.find((l) => l.msg === 'station');
    expect(st).toMatchObject({ boundSpaces: 1, fresh: true, remainingBasis: ['wholeday'], remainingFallback: ['no_hourly'] });
  });

  it('stored hydrology: the gauge still supplies the measured rain; the forecast halves are null, not 0; status incomplete', async () => {
    const { stored } = await drive({ fetchPrecip: newPath(), bound: true });
    const { station: prov, ...hy } = stored.hydrology;
    expect(hy).toEqual({
      recent_precip_in: 0.6, today_precip_in: 0.12, today_pop: null,
      upcoming_precip_in: null, tomorrow_precip_in: null, tomorrow_pop: null,   // were 0 and 0
      today_observed_in: 0.12, today_remaining_in: 0,
      rain_coming: false, rain_horizon: null,
      // hydrologyStatus: recent is the gauge's, so it is upcoming == null alone that raises the flag here.
      status: { ok: false, uncertainty: { flag: true, reason: 'precip data incomplete — watering advice assumes no rain credit' } },
    });
    expect(prov).toMatchObject({ recent_source: 'station', today_source: 'station', yesterday_actual_source: 'station' });
  });

  for (const flagsOn of [false, true]) {
    it(`NOT WORSE (${flagsOn ? 'every rain flag on' : 'default flags'}): gauge credit and every verdict identical to the fabricated-zero run`, async () => {
      const before = await drive({ fetchPrecip: oldPath(), bound: true, flagsOn });
      vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs();
      const after = await drive({ fetchPrecip: newPath(), bound: true, flagsOn });
      expect(withoutHydrology(after.stored)).toEqual(withoutHydrology(before.stored));
      // The station provenance is identical too: the gauge was used both times.
      expect(after.stored.hydrology.station).toEqual(before.stored.hydrology.station);
      // Exactly three hydrology keys moved: the two forecast amounts and the status.
      const changed = Object.keys({ ...before.stored.hydrology, ...after.stored.hydrology })
        .filter((k) => JSON.stringify(before.stored.hydrology[k]) !== JSON.stringify(after.stored.hydrology[k])).sort();
      expect(changed).toEqual(['status', 'tomorrow_precip_in', 'upcoming_precip_in']);
      // Measured rain still credits the outdoor bed on both paths — the fix removes no real data.
      expect(after.stored.rain_skipped.map((r) => r.id)).toContain('bed');
      expect(computeWateringScale(after.stored.hydrology, after.stored.weather))
        .toEqual(computeWateringScale(before.stored.hydrology, before.stored.weather));
      expect(bedWaitActive(after.stored)).toBe(false);
    });
  }
});

describe('consumers — a bound but STALE gauge: provenance stops claiming a forecast it never had', () => {
  const stale = () => deriveStation(STATION_RAW, { nowMs: NOW + 6 * 3600 * 1000 });   // newest ~6h old

  it('recent/today are labelled unavailable, and the Today stamp claims no source', async () => {
    vi.stubEnv('AWN_STATIONS_JSON', JSON.stringify([{ mac: MAC, tz: 'America/New_York', lat: 42.5, lng: -72.6, schema_version: 1 }]));
    const st = stale();
    expect(st.fresh).toBe(false);                   // the fixture really is stale
    const hy = await realFetchPrecip(respond(ERROR_BODY, 200)).fp(42.5, -72.6);
    const { merged, prov } = mergeStationHydrology(hy, st, { planDay: TODAY });
    expect(prov).toMatchObject({ recent_source: 'unavailable', today_source: 'unavailable', station_uncertainty: 'stale' });
    for (const k of RAIN_KEYS) expect(merged[k], k).toBeNull();
    expect(hydrologySourceLabel(prov)).toBeNull();
    // What the fabricated zeros produced: a label asserting forecast rain that did not exist.
    const old = mergeStationHydrology(structuredClone(OLD_FABRICATED), st, { planDay: TODAY });
    expect(old.prov).toMatchObject({ recent_source: 'forecast', today_source: 'forecast' });
    expect(hydrologySourceLabel(old.prov)).toBe('forecast · gauge offline');
  });
});
