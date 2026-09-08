'use strict';
// V5-RADIATIVEFROST-001 — radiative-cooling frost detection. Pure, HTTP-free, deterministic,
// unit-testable (house pattern: station.js, frostEval.js). The I/O — the three hourly params on
// index.js:fetchPrecip — lives in index.js and is NOT here.
//
// WHY THIS EXISTS. The frost path evaluates ONE deterministic number, `wx.tonightLow` from a grid
// forecast, against fixed trip points. A grid cell cannot represent radiational frost: the site is a
// drained shoulder and the documented ERA5 error here is ~+8F on sub-32F minima, missing ~62% of real
// frost nights (src/lib/sowEngine.js:63-68). The three quantities that distinguish a radiative night —
// dewpoint, cloud cover, wind — were fetched NOWHERE in the system before this module, though all
// three ride the Open-Meteo call fetchPrecip was already making.
//
// THE TWO PHYSICAL FACTS, both unfitted, both measured against 380 real nights at this site
// (5 autumns, Sep 1 - Nov 15, 2021-2025; see project-state/_wx-radiativefrost-spec-20260908.md):
//   (1) Air temperature rarely falls below the dewpoint — latent heat release as condensation begins
//       arrests the fall. MEASURED: minTemp fell below minDewpoint on 0 of 380 nights (median gap
//       +3.4F, minimum +0.0F). The dewpoint is a practical FLOOR.
//   (2) Clear + calm is the condition for maximum radiative cooling.
//
// The MAGNITUDE of this site's grid-vs-yard offset is deliberately NOT encoded here. It needs a season
// of paired forecast-vs-station data that does not exist yet; inventing a number would be the one
// mistake this module cannot recover from. That is the bias-correction work this feeds, via the
// observability block frostEval.js already describes as "the 2026 corpus for the 2027 learned offset".
//
// THE PROXIMITY TERM IS LOAD-BEARING — DO NOT REMOVE IT. An earlier draft tripped on
// `radiative AND minDewpoint <= T` alone. That keys on airmass DRYNESS as much as on frost risk,
// because minDewpoint <= T is close to automatic in dry air. Measured false alarms it produced:
// 2024-10-17 (dewpoint 24.4F, 0% cloud, 5.6mph) bottomed at 39.3F, and 2025-09-19 bottomed at 47.3F —
// 9F above the trip point. Requiring the forecast low to be within RADIATIVE_PROXIMITY_F of the trip
// point drops the worst added alert from 47.3F to 40.8F and loses none of the genuinely-near nights.
//
// AND DO NOT "IMPROVE" IT BY TREATING A LOWER DEWPOINT AS MORE RISK. Binning 380 nights on 18:00
// dewpoint depression to control for airmass, radiative nights ran 3.9F COLDER than non-radiative in
// the 10-15F bin but 2.3F WARMER in the driest (15F+) bin — that bin is dominated by ADVECTIVE cold
// (windy frontal nights carrying dry cold air), a different mechanism. The relationship inverts.

const numEnv = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
};

// Env-overridable on a deployed Lambda without a code change, same lever frostEval.js gives its trip
// points. Defaults are the operational rules of thumb, confirmed against the 380-night set.
const DEFAULTS = Object.freeze({
  CLOUD_MAX_PCT: numEnv('FROST_RADIATIVE_CLOUD_MAX_PCT', 40),
  WIND_MAX_MPH: numEnv('FROST_RADIATIVE_WIND_MAX_MPH', 6),
  PROXIMITY_F: numEnv('FROST_RADIATIVE_PROXIMITY_F', 4),
});

// Ships OFF. Flag-off behaviour must be byte-identical to pre-V5 — guarded by test, not by assertion.
const RADIATIVE_ENABLED = String(process.env.FROST_RADIATIVE_ENABLED || 'false') === 'true';

// The overnight window, in LOCAL hours. 18:00 through 08:00 next day spans the whole cooling curve:
// radiative loss starts around sunset and the minimum lands shortly after sunrise.
const NIGHT_START_HOUR = numEnv('FROST_RADIATIVE_NIGHT_START_HOUR', 18);
const NIGHT_END_HOUR = numEnv('FROST_RADIATIVE_NIGHT_END_HOUR', 8);
// A night missing more than half its hours is not scored at all — a 3-hour sample can call a windy
// night calm. null (never a default) is the answer when the data cannot support one.
const MIN_HOURS = numEnv('FROST_RADIATIVE_MIN_HOURS', 12);

const finite = (n) => (n != null && Number.isFinite(Number(n)) ? Number(n) : null);
const round1 = (n) => Math.round((n + Number.EPSILON) * 10) / 10;

// Which night an hour belongs to, as the DATE THE NIGHT STARTS ON. 22:00 on the 9th and 03:00 on the
// 10th are the same night, labelled '...-09'. Hours between NIGHT_END and NIGHT_START (daytime) belong
// to no night and are dropped.
//
// Pure string arithmetic on the LOCAL ISO stamps Open-Meteo returns, exactly as
// station.remainingHourlyIn does it (station.js:249-251). This is what makes the module DST-safe: the
// spring-forward night is 23 hours long and the fall-back night 25, and constructing a Date to shift a
// day would land on the wrong civil date on precisely the two nights per year that are hardest to
// reason about. Subtracting a day from a YYYY-MM-DD label has no such problem.
function nightKeyFor(stamp) {
  if (typeof stamp !== 'string' || stamp.length < 13) return null;
  const date = stamp.slice(0, 10);
  const h = Number(stamp.slice(11, 13));
  if (!Number.isFinite(h)) return null;
  if (h >= NIGHT_START_HOUR) return date;
  if (h <= NIGHT_END_HOUR) return prevDate(date);
  return null;
}

// Calendar-only previous day. No Date object, no timezone, no DST.
function prevDate(d) {
  const [y, m, dd] = d.split('-').map(Number);
  if (![y, m, dd].every(Number.isFinite)) return null;
  const days = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28,
    31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const p = (n) => String(n).padStart(2, '0');
  if (dd > 1) return `${y}-${p(m)}-${p(dd - 1)}`;
  if (m > 1) return `${y}-${p(m - 1)}-${p(days[m - 2])}`;
  return `${y - 1}-12-31`;
}

// Derive per-night statistics from the verbatim hourly block index.js carries through.
//
// `hourly` shape: { time: [...], dew_point_2m: [...], cloud_cover: [...], wind_speed_10m: [...] }.
// Absent block, absent array, or a night below MIN_HOURS -> that night is simply not returned. A caller
// that finds no entry for a date gets NO radiative signal for it, which routes to existing behaviour.
//
// Every derived value is null (NEVER 0) when its source hour is absent. 0% cloud and 0mph wind are the
// EXACT conditions this module is looking for, so a coerced 0 would not merely be wrong — it would
// manufacture the positive case. Same rule as index.js:lowOrNull and station.remainingHourlyIn, and it
// bites harder here than anywhere else in the codebase.
function nightsFrom(hourly) {
  if (!hourly || !Array.isArray(hourly.time)) return [];
  const t = hourly.time;
  const dp = Array.isArray(hourly.dew_point_2m) ? hourly.dew_point_2m : null;
  const cc = Array.isArray(hourly.cloud_cover) ? hourly.cloud_cover : null;
  const ws = Array.isArray(hourly.wind_speed_10m) ? hourly.wind_speed_10m : null;
  if (!dp || !cc || !ws) return [];

  const buckets = new Map();
  for (let i = 0; i < t.length; i++) {
    const key = nightKeyFor(t[i]);
    if (!key) continue;
    const d = finite(dp[i]), c = finite(cc[i]), w = finite(ws[i]);
    // An hour missing ANY of the three cannot contribute to a calm-and-clear judgement.
    if (d == null || c == null || w == null) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push([d, c, w]);
  }

  const out = [];
  for (const [date, rows] of [...buckets.entries()].sort()) {
    if (rows.length < MIN_HOURS) continue;
    const mean = (idx) => rows.reduce((a, r) => a + r[idx], 0) / rows.length;
    // reduce, not Math.min(...spread): this function is exported and the obvious next consumer
    // is a multi-season replay harness, where a spread over ~200k elements throws RangeError.
    const minDewpointF = rows.reduce((a, r) => Math.min(a, r[0]), Infinity);
    const meanCloudPct = mean(1);
    const meanWindMph = mean(2);
    out.push({
      date,
      minDewpointF: round1(minDewpointF),
      meanCloudPct: round1(meanCloudPct),
      meanWindMph: round1(meanWindMph),
      hours: rows.length,
      radiative: meanCloudPct < DEFAULTS.CLOUD_MAX_PCT && meanWindMph < DEFAULTS.WIND_MAX_MPH,
    });
  }
  return out;
}

const nightFor = (nights, date) =>
  (Array.isArray(nights) ? nights.find((n) => n && n.date === date) : null) || null;

// THE TRIP TEST. Three conditions, all required:
//   radiative                      the night can cool radiatively at all
//   minDewpointF <= tripF          the floor is at or below the trip point, so reaching it is possible
//   lowF <= tripF + PROXIMITY_F    the forecast is close enough that undercooling could bridge the gap
//
// Returns false — never throws, never null — on any missing input. Absence of a radiative signal must
// degrade to "existing behaviour", never to a trip.
function radiativeTrips(night, lowF, tripF, opts) {
  const o = opts || {};   // a default only covers `undefined`; an explicit null would throw
  if (!night || !night.radiative) return false;
  const low = finite(lowF), trip = finite(tripF);
  const dew = finite(night.minDewpointF);
  if (low == null || trip == null || dew == null) return false;
  const prox = finite(o.proximityF) != null ? Number(o.proximityF) : DEFAULTS.PROXIMITY_F;
  return dew <= trip && low <= trip + prox;
}

module.exports = {
  nightsFrom, nightFor, radiativeTrips, nightKeyFor, prevDate,
  DEFAULTS, RADIATIVE_ENABLED, NIGHT_START_HOUR, NIGHT_END_HOUR, MIN_HOURS,
};
