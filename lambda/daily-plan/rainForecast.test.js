// BUG-RAINFCSTONEMODEL-001 — the five-model day-ahead rain forecast (rainForecast.js).
import { describe, it, expect } from 'vitest';
import rf from './rainForecast.js';

const { RAIN_FCST_MODELS, RAIN_FCST_SOURCE, rainForecastUrl, addDays, fromOpenMeteoModels, applyRainForecast } = rf;

// The live body at the garden point, 2026-09-25 ~17:30 ET, verbatim. Saturday is the day Today printed "0.05″".
const LIVE_0925 = {
  daily: {
    time: ['2026-09-25', '2026-09-26', '2026-09-27'],
    precipitation_sum_gfs_global: [0.0, 0.37, 1.087],
    precipitation_sum_ecmwf_ifs025: [0.0, 0.846, 1.043],
    precipitation_sum_gem_seamless: [0.0, 0.949, 0.611],
    precipitation_sum_icon_seamless: [0.0, 0.555, 2.524],
    precipitation_sum_ncep_nbm_conus: [0.0, 0.165, 0.846],
  },
};
const clone = (o) => JSON.parse(JSON.stringify(o));

describe('fromOpenMeteoModels', () => {
  it('2026-09-25: Saturday is 0.58″ with all five models wet, Sunday 1.22″', () => {
    expect(fromOpenMeteoModels(LIVE_0925, '2026-09-25')).toEqual({
      d1: { date: '2026-09-26', precip_in: 0.58, pop: 100 },
      d2: { date: '2026-09-27', precip_in: 1.22, pop: 100 },
      source: RAIN_FCST_SOURCE,
    });
  });

  it('finds the days by DATE, not by position — a body that starts a day earlier reads the same', () => {
    const shifted = clone(LIVE_0925);
    shifted.daily.time.unshift('2026-09-24');
    for (const m of RAIN_FCST_MODELS) shifted.daily[`precipitation_sum_${m}`].unshift(9.99);
    expect(fromOpenMeteoModels(shifted, '2026-09-25')).toEqual(fromOpenMeteoModels(LIVE_0925, '2026-09-25'));
  });

  it('the chance is the share of models at or above 0.01″ — 0.009″ is dry, 0.01″ is wet', () => {
    const b = clone(LIVE_0925);
    b.daily.precipitation_sum_gfs_global[1] = 0.009;
    b.daily.precipitation_sum_ncep_nbm_conus[1] = 0.01;
    b.daily.precipitation_sum_icon_seamless[1] = 0;
    expect(fromOpenMeteoModels(b, '2026-09-25').d1.pop).toBe(60);   // ecmwf, gem, nbm
  });

  it('reads only the SUFFIXED keys a multi-model body carries — an unsuffixed single-model body is null', () => {
    const single = { daily: { time: LIVE_0925.daily.time, precipitation_sum: [0, 0.142, 1.716] } };
    expect(fromOpenMeteoModels(single, '2026-09-25')).toBeNull();
  });

  it('is complete-or-null: one model missing on either day, or either day missing, is null — never a four-model mean', () => {
    const missing = clone(LIVE_0925); delete missing.daily.precipitation_sum_gem_seamless;
    expect(fromOpenMeteoModels(missing, '2026-09-25')).toBeNull();
    const holed = clone(LIVE_0925); holed.daily.precipitation_sum_icon_seamless[2] = null;
    expect(fromOpenMeteoModels(holed, '2026-09-25')).toBeNull();
    const nan = clone(LIVE_0925); nan.daily.precipitation_sum_ecmwf_ifs025[1] = 'NaN';
    expect(fromOpenMeteoModels(nan, '2026-09-25')).toBeNull();
    const neg = clone(LIVE_0925); neg.daily.precipitation_sum_ecmwf_ifs025[1] = -0.1;
    expect(fromOpenMeteoModels(neg, '2026-09-25')).toBeNull();
    // A replay of an old day: the forecast holds no row for the plan's tomorrow, so nothing is overlaid.
    expect(fromOpenMeteoModels(LIVE_0925, '2026-09-20')).toBeNull();
    expect(fromOpenMeteoModels(LIVE_0925, '2026-09-26')).toBeNull();   // D2 would be 09-28, absent
  });

  it('refuses malformed input', () => {
    for (const bad of [null, {}, { daily: null }, { error: true, reason: 'x' }]) expect(fromOpenMeteoModels(bad, '2026-09-25')).toBeNull();
    for (const day of [undefined, null, 20260925, '09/25/2026']) expect(fromOpenMeteoModels(LIVE_0925, day)).toBeNull();
  });

  it('rounds the mean to hundredths, the precision the card prints and the gates judge', () => {
    // 0.4951 average -> 0.50: the stored value is the value on the card and the value at the 0.50″ bar.
    const b = clone(LIVE_0925);
    RAIN_FCST_MODELS.forEach((m, i) => { b.daily[`precipitation_sum_${m}`][1] = [0.49, 0.5, 0.4955, 0.4955, 0.4945][i]; });
    expect(fromOpenMeteoModels(b, '2026-09-25').d1.precip_in).toBe(0.5);
  });
});

describe('rainForecastUrl / addDays', () => {
  it('asks for exactly the five models, daily precipitation only, inches, ET days, three days', () => {
    const u = new URL(rainForecastUrl(42.5, -72.6));
    expect(u.host).toBe('api.open-meteo.com');
    expect(u.searchParams.get('models')).toBe('gfs_global,ecmwf_ifs025,gem_seamless,icon_seamless,ncep_nbm_conus');
    expect(u.searchParams.get('daily')).toBe('precipitation_sum');
    expect(u.searchParams.get('precipitation_unit')).toBe('inch');
    expect(u.searchParams.get('timezone')).toBe('America/New_York');
    expect(u.searchParams.get('forecast_days')).toBe('3');
    expect(u.searchParams.has('hourly')).toBe(false);
    expect(u.searchParams.has('past_days')).toBe(false);
  });
  it('adds days across month ends and the DST change', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-10-31', 2)).toBe('2026-11-02');   // across 2026-11-01, the 25-hour day
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('applyRainForecast', () => {
  const HY = {
    recent_precip_in: 0, today_precip_in: 0, today_pop: 5, tomorrow_precip_in: 0.14, tomorrow_pop: 37,
    upcoming_precip_in: 1.86, upcoming_pop: 82, day2_precip_in: 1.72, day2_pop: 82, day2_date: '2026-09-27',
    forecast_lows: [52.1, 53.4, 55], forecast_dates: ['2026-09-26', '2026-09-27', '2026-09-28'],
    hourly_precip: { time: ['2026-09-25T17:00'], precipitation: [0] }, hourly_frost: { t: [1] }, hourly_temp: { t: [2] },
    settled_days: [{ date: '2026-09-24', precip_in: 0 }], wetness_window: [{ d: 1 }], yesterday_precip_actual_in: 0,
    today_et0_in: 0.12, today_tmax_f: 77,
  };
  const RF = fromOpenMeteoModels(LIVE_0925, '2026-09-25');

  it('overlays the day-ahead fields and keeps the displaced best_match pair', () => {
    const out = applyRainForecast(HY, RF);
    expect(out).toMatchObject({
      tomorrow_precip_in: 0.58, tomorrow_pop: 100, upcoming_precip_in: 1.8, upcoming_pop: 100,
      day2_precip_in: 1.22, day2_pop: 100, day2_date: '2026-09-27', forecast_source: 'mean5-v1',
      bm_tomorrow_precip_in: 0.14, bm_tomorrow_pop: 37,
    });
  });

  it('leaves every other key as the SAME value — the frost, ET0, hourly and settled-day inputs cannot move', () => {
    const out = applyRainForecast(HY, RF);
    const changed = new Set(['tomorrow_precip_in', 'tomorrow_pop', 'upcoming_precip_in', 'upcoming_pop', 'day2_precip_in',
      'day2_pop', 'day2_date', 'forecast_source', 'bm_tomorrow_precip_in', 'bm_tomorrow_pop']);
    for (const k of Object.keys(HY)) if (!changed.has(k)) expect(out[k], k).toBe(HY[k]);
    expect(Object.keys(out).filter((k) => !(k in HY)).sort()).toEqual(['bm_tomorrow_pop', 'bm_tomorrow_precip_in', 'forecast_source']);
    expect(HY.tomorrow_precip_in).toBe(0.14);   // the input object is not mutated
  });

  it('no hydrology in, none out — the forecast alone never fabricates one; no forecast in, hydrology untouched', () => {
    expect(applyRainForecast(null, RF)).toBeNull();
    expect(applyRainForecast(undefined, RF)).toBeUndefined();
    expect(applyRainForecast(HY, null)).toBe(HY);
  });

  it('an absent best_match pair is kept as null, not dropped — the shadow series says it was missing', () => {
    const { tomorrow_precip_in, tomorrow_pop, ...noTomorrow } = HY;
    expect(applyRainForecast(noTomorrow, RF)).toMatchObject({ bm_tomorrow_precip_in: null, bm_tomorrow_pop: null, tomorrow_precip_in: 0.58 });
  });
});
