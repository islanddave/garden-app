// BUG-RAINFCSTONEMODEL-001 — the DAY-AHEAD rain forecast (tomorrow and the day after): amount AND chance from
// five weather models, replacing Open-Meteo `best_match` for those fields only.
//
// WHY. On 2026-09-25 Today said "0.05″ rain expected tomorrow" while every forecast Dave read said 0.5–1.5″.
// fetchPrecip asks Open-Meteo with no `models=`, and at this point best_match's day-ahead is HRRR: hour-for-hour
// identical to ncep_hrrr_conus on 82 of 82 days. Scored against the yard gauge, 2026-07-05..09-24, HRRR is the
// worst day-ahead source of 23 tried (MAE 0.166″) because of a heavy tail — 0.89–2.31″ forecast five times when
// 0.00–0.65″ fell — and on 9/26 it put Saturday at 0.14″ while ECMWF said 0.85″ and GEM 0.95″. The mean of the
// five models below scored 0.087″ (7-day block-bootstrap CI of the difference [-0.152, -0.013]). Evidence and
// scripts: Projects/Gardening/project-state/_rainfcst-20260925/ (seat-verification.md, seat-irrigation.md,
// seat-regression.md). One summer, 16 wet days: re-score after a full year.
//
// THE CHANCE IS THE SHARE OF MODELS FORECASTING MEASURABLE RAIN (0/20/40/60/80/100%), from the same five
// amounts. best_match's precipitation_probability_max is a max of hourly PoPs and was under-confident here (when
// it said 10–30%, rain came on half the days); the share scored Brier 0.104 vs 0.182. Amount and chance switch
// TOGETHER or not at all: HRRR's amount with a calibrated chance would have made 4 false "0.5″ coming" deferrals
// (the low PoP was what hid its spikes), and this amount with the old PoP loses a correct skip. With the pair,
// the engine's 0.50″/60% suppression gate fires on the same number of days with 0 false skips.
//
// SCOPE — day-ahead fields only. Today's figures (today_precip_in, today_pop, the hourly remainder) stay on
// best_match, where HRRR's hourly nowcast is what the same-day gates want; frost lows, ET0 and past days stay
// on fetchPrecip's call untouched. That is also why this is a SEPARATE request: `models=` on fetchPrecip's URL
// suffixes every daily and hourly key (all of them read as missing) or, with one model, moves the frost lows.
//
// ALL OR NOTHING. A partial answer — a model missing, a day missing — returns null and every day-ahead field
// keeps its best_match value. Mixing sources field by field would pair one system's amount with another's
// chance, which is exactly the combination measured to be worse than either.
//
// MIRRORED client-side by src/lib/rainForecast.js (the live overlay on Today must print what this computes);
// src/__tests__/rainForecastParity.test.js runs both on the same payloads.

const RAIN_FCST_MODELS = Object.freeze(['gfs_global', 'ecmwf_ifs025', 'gem_seamless', 'icon_seamless', 'ncep_nbm_conus']);
// A member counts toward the chance at 0.01″, the conventional "measurable precipitation" of a PoP.
const WET_MEMBER_IN = 0.01;
// Stamped on the hydrology so a stored plan says which method produced its day-ahead figures.
const RAIN_FCST_SOURCE = 'mean5-v1';

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function rainForecastUrl(lat, lng) {
  return `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
    `&daily=precipitation_sum&models=${RAIN_FCST_MODELS.join(',')}` +
    '&precipitation_unit=inch&timezone=America/New_York&forecast_days=3';
}

// 'YYYY-MM-DD' + n days. Noon UTC so no offset can carry it across midnight.
function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// One day's figures, found by DATE in the response's own America/New_York `time` row — never by position, so
// a request with a different past_days/forecast_days cannot silently shift tomorrow onto today.
function dayFromModels(daily, date) {
  const i = Array.isArray(daily.time) ? daily.time.indexOf(date) : -1;
  if (i < 0) return null;
  const members = [];
  for (const m of RAIN_FCST_MODELS) {
    const col = daily[`precipitation_sum_${m}`];
    const v = Array.isArray(col) ? col[i] : undefined;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;   // absent is NOT 0
    members.push(v);
  }
  const wet = members.filter((v) => v >= WET_MEMBER_IN).length;
  return {
    date,
    precip_in: round2(members.reduce((a, v) => a + v, 0) / members.length),
    pop: Math.round((100 * wet) / members.length),
  };
}

// Open-Meteo multi-model daily body + the plan's ET date -> { d1, d2, source } or null.
function fromOpenMeteoModels(json, today) {
  const daily = json && json.daily;
  if (!daily || typeof daily !== 'object' || typeof today !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return null;
  const d1 = dayFromModels(daily, addDays(today, 1));
  const d2 = dayFromModels(daily, addDays(today, 2));
  if (!d1 || !d2) return null;
  return { d1, d2, source: RAIN_FCST_SOURCE };
}

// Overlay the day-ahead fields onto a fetchPrecip hydrology. SPREAD, so every other key — frost lows, hourly
// blocks, settled days, today's and past figures — is the same value it was. No hydrology in, none out: the
// forecast alone never fabricates one. No forecast in, the hydrology comes back untouched.
//
// The displaced best_match day-ahead pair is kept as bm_tomorrow_* : the showery banner stays keyed on it
// (engine.hydrologyStatus — see the note there), and it is the shadow series for re-scoring this choice.
function applyRainForecast(hy, rf) {
  if (!hy || !rf) return hy;
  return {
    ...hy,
    bm_tomorrow_precip_in: hy.tomorrow_precip_in ?? null,
    bm_tomorrow_pop: hy.tomorrow_pop ?? null,
    tomorrow_precip_in: rf.d1.precip_in,
    tomorrow_pop: rf.d1.pop,
    upcoming_precip_in: round2(rf.d1.precip_in + rf.d2.precip_in),   // D1 + D2, as fetchPrecip defines it
    upcoming_pop: rf.d2.pop,
    day2_precip_in: rf.d2.precip_in,
    day2_pop: rf.d2.pop,
    day2_date: rf.d2.date,
    forecast_source: rf.source,
  };
}

module.exports = { RAIN_FCST_MODELS, WET_MEMBER_IN, RAIN_FCST_SOURCE, rainForecastUrl, addDays, fromOpenMeteoModels, applyRainForecast };
