'use strict';
// Lambda entrypoint for the overnight Daily Plan generator (EventBridge nightly, DRY_RUN-gated, no Fn URL).
// Pure plan logic is in ./handler (run) + ./engine; the real HTTP fetchers live here and are injected into run.
// Trap: the Open-Meteo daily index map [D-2,D-1,D0,D1,D2,D3] (past_days=2, forecast_days=4) must hold;
// openmeteo-indices.test.js guards the indexing against drift.
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
// Pool + ws via neonConfig.webSocketConstructor: the pinned @neondatabase/serverless@^0.10.0 neon() http client has
// no .query(text,params) method, and Pool needs an explicit WebSocket constructor. Pool.query(text,params)->{rows}
// is the pg contract handler.run expects.
const { Pool, neonConfig } = require('@neondatabase/serverless');
const ws = require('ws');
neonConfig.webSocketConstructor = ws;
const { run, resolveInvokeOptions } = require('./handler');
const { stationConfig } = require('./station');
const rainForecast = require('./rainForecast');

const SECRET_NAME = process.env.SECRET_NAME || 'garden-app/secrets';
let _secrets;
async function getSecrets() {
  if (_secrets) return _secrets;
  const sm = new SecretsManagerClient({});
  const res = await sm.send(new GetSecretValueCommand({ SecretId: SECRET_NAME }));
  _secrets = JSON.parse(res.SecretString || '{}');
  return _secrets;
}

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
// ET0 needs a third decimal: it runs ~0.15-0.25 in/day, so round2 quantises the useful range into about ten buckets
// and injects a few percent of error into the ledger's ET0-to-monthly-reference demand ratio.
const round3 = (n) => Math.round((n + Number.EPSILON) * 1000) / 1000;

// ET calendar date — plan_date must be the LOCAL day even when the cron fires after UTC midnight.
function todayET() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// The ET hour is the only way to tell the three daily runs apart: all three EventBridge targets invoke this function
// with an empty detail. hourCycle h23 so midnight is 0, not 24. Consumed by frostEval.resolveFrostRun, which is pure.
function hourET() {
  return Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23',
  }).format(new Date()));
}

// SNS delivery (frost channel, separate ops topic). ARNs are env-overridable; the defaults must name topics that exist
// in us-east-1 (the account id already appears in .github/workflows, it is not a secret).
// DELIBERATELY NOT wrapped in try/catch, unlike every other fetcher in this file: a swallowed frost publish is the one
// failure this feature cannot have. handler.run catches it, logs at ERROR, finishes writing the plan, then throws so
// garden-daily-plan-errors (Errors > 0) pages.
// Trap: both defaults are garden-ops-alerts, the topic with the confirmed email subscription; a default naming a topic
// that does not exist fails only at the first frost. scripts/lambda-config-expected.json declares FROST_TOPIC_ARN as an
// exact string, not the `true` any-value sentinel, so the drift guard checks the value. Do not put the sentinel back.
const FROST_TOPIC_ARN = process.env.FROST_TOPIC_ARN || 'arn:aws:sns:us-east-1:769788341849:garden-ops-alerts';
const OPS_TOPIC_ARN = process.env.OPS_TOPIC_ARN || 'arn:aws:sns:us-east-1:769788341849:garden-ops-alerts';
let _sns;
async function publishAlert({ topic, subject, message }) {
  if (!_sns) _sns = new SNSClient({});
  const TopicArn = topic === 'ops' ? OPS_TOPIC_ARN : FROST_TOPIC_ARN;
  const res = await _sns.send(new PublishCommand({ TopicArn, Subject: subject, Message: message }));
  console.log(JSON.stringify({ msg: 'sns-publish', topic: TopicArn, messageId: res && res.MessageId }));
  return { topicArn: TopicArn, messageId: res && res.MessageId };
}

// zip -> {lat,lng} (public, no key). Upstream caches to spaces.weather_lat/lng.
// Every external fetch below is bounded (AbortSignal.timeout) so a hung upstream cannot eat the Lambda budget, and each
// caller degrades to null on failure. The DB Pool is deliberately UNBOUNDED: the Neon cold-resume stall must be waited
// out (aborting the connect turns a slow success into a failure); the 120s fn timeout covers it.
async function geocodeZip(zip) {
  const r = await fetch(`https://api.zippopotam.us/us/${encodeURIComponent(zip)}`, { signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error(`geocodeZip ${zip} -> ${r.status}`);
  const j = await r.json();
  const p = j.places && j.places[0];
  return { lat: parseFloat(p.latitude), lng: parseFloat(p.longitude) };
}

// NWS = authoritative cold low + high (its precip fields are unreliable here). WMO `code` for the widget
// icon comes from Open-Meteo daily (NWS returns text/icon, not WMO codes).
// Wrapped in try/catch: api.weather.gov intermittently returns HTML (503/outage) which throws on .json().
// Weather is optional — handler.weatherForSpace returns null safely; engine runs without it.
async function fetchNWS(lat, lng) {
  try {
    const hdr = { 'User-Agent': 'garden-app daily-plan (islanddave@gmail.com)', Accept: 'application/geo+json' };
    const pts = await (await fetch(`https://api.weather.gov/points/${lat},${lng}`, { headers: hdr, signal: AbortSignal.timeout(6000) })).json();
    const fc = await (await fetch(pts.properties.forecast, { headers: hdr, signal: AbortSignal.timeout(6000) })).json();
    const periods = (fc.properties && fc.properties.periods) || [];
    const day = periods.find((p) => p.isDaytime);
    const night = periods.find((p) => !p.isDaytime);
    let code = null;
    try {
      const om = await (await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&daily=weather_code&timezone=America/New_York&forecast_days=1`, { signal: AbortSignal.timeout(6000) })).json();
      code = om.daily && om.daily.weather_code && om.daily.weather_code[0];
    } catch (_) { /* code is cosmetic (icon); proceed without */ }
    return {
      tonightLow: night ? night.temperature : null,
      highToday: day ? day.temperature : null,
      code, unit: 'F', short: (day || night || {}).shortForecast || '',
    };
  } catch (e) {
    console.warn(JSON.stringify({ msg: 'fetchNWS failed — weather null', lat, lng, error: e.message }));
    return null;
  }
}

// Open-Meteo = full hydrology window in inches. recent = D-2+D-1 actuals; upcoming = D1+D2; tomorrow + PoP.
// Wrapped in try/catch: network failures should not crash the entire run — hydrology degrades gracefully to null.
async function fetchPrecip(lat, lng) {
  try {
    // Append-only: a new `daily=` field goes at the END of that list and a new `hourly=` field at the end of its list.
    // past_days sets D0's offset, so every index below (ps[0..4], pop[2..3], tmin[3..5]) keeps its meaning only while
    // nothing is inserted ahead of an existing field; the archive backfill (scripts/backfill-weather-daily.mjs) reads the
    // same names in the same order. `hourly` is a separate response object, so appending there cannot shift `daily`.
    // openmeteo-indices.test.js pins the list prefix and the append.
    //
    // Units are not assumed and nothing here converts: precipitation_unit=inch also governs ET0 (no mm->in anywhere),
    // wind_speed_unit=mph the wind fields, temperature_unit=fahrenheit the temperatures. The two duration fields
    // (daylight_duration, sunshine_duration) are stored in SECONDS exactly as served; divide at the point of display.
    //
    // temperature_2m_max is here because weather_daily.tmax_f feeds the fabric-bag heat ramp and nothing else in this run
    // fetches a daily max (NWS highToday is today's forecast; the writer persists COMPLETED days).
    // dew_point_2m, cloud_cover and wind_speed_10m are the radiative-frost inputs (see radiativeFrost.js): a grid-cell
    // forecast cannot represent radiational frost and misses most real frost nights at this site. hourly temperature_2m
    // tells frostEval.locateNight which night an advisory's civil-day minimum belongs to.
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
      `&daily=precipitation_sum,precipitation_probability_max,temperature_2m_min,et0_fao_evapotranspiration,temperature_2m_max,daylight_duration,sunshine_duration,shortwave_radiation_sum,wind_speed_10m_max,precipitation_hours&hourly=precipitation,dew_point_2m,cloud_cover,wind_speed_10m,temperature_2m&temperature_unit=fahrenheit&precipitation_unit=inch&wind_speed_unit=mph&timezone=America/New_York&past_days=2&forecast_days=4`;
    // An Open-Meteo ERROR is JSON, so `.json()` succeeds on it (an invalid variable answers HTTP 400 with
    // {"error":true,"reason":...} and no `daily`). A non-ok status and a body with no `daily` block both THROW into the
    // catch below, taking the path an HTML 503 always took: a WARN, then null, which every consumer reads as "Open-Meteo
    // down" (station.mergeStationHydrology's null base, engine.hydrologyStatus's incomplete flag). Mapping such a body
    // field by field would produce a non-null hydrology of fabricated zeros that reports complete. Partial DAILY data is
    // still kept below, field by field. The reason is capped: it is Open-Meteo's free text and can echo a parameter.
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    const reasonOf = (b) => (b && typeof b.reason === 'string' ? `: ${b.reason.slice(0, 200)}` : '');
    if (!r.ok) {
      let why = '';
      try { why = reasonOf(await r.json()); } catch (_) { /* HTML or empty error body: the status says enough */ }
      throw new Error(`Open-Meteo HTTP ${r.status}${why}`);
    }
    const j = await r.json();
    if (!j || !j.daily || typeof j.daily !== 'object') throw new Error(`Open-Meteo body has no daily block${reasonOf(j)}`);
    const ps = (j.daily && j.daily.precipitation_sum) || [];   // [D-2, D-1, D0, D1, D2, D3]
    const pop = (j.daily && j.daily.precipitation_probability_max) || [];
    const tmin = (j.daily && j.daily.temperature_2m_min) || [];  // same indexing as ps
    const et0 = (j.daily && j.daily.et0_fao_evapotranspiration) || [];  // same indexing as ps
    const tmax = (j.daily && j.daily.temperature_2m_max) || [];         // same indexing as ps
    const daylight = (j.daily && j.daily.daylight_duration) || [];      // same indexing as ps
    const sunshine = (j.daily && j.daily.sunshine_duration) || [];      // same indexing as ps
    const solar = (j.daily && j.daily.shortwave_radiation_sum) || [];   // same indexing as ps
    const windmax = (j.daily && j.daily.wind_speed_10m_max) || [];      // same indexing as ps
    const preciph = (j.daily && j.daily.precipitation_hours) || [];     // same indexing as ps
    const times = (j.daily && j.daily.time) || [];
    // Rain amounts take the null-never-0 rule: 0 in. is a real dry day, so an absent entry must not read as one. Same
    // semantics as the client mirror, src/lib/liveWeather.js, including the sum rule: a sum is null unless every term is
    // known (D-2 + D-1 with one day missing would read like a measurement). round2 is guarded because round2(null) is 0.
    const numOrNull = (v) => (Number.isFinite(v) ? v : null);
    const sumOrNull = (...vs) => (vs.some((v) => v == null) ? null : vs.reduce((a, v) => a + v, 0));
    const round2OrNull = (v) => (v == null ? null : round2(v));
    const tomorrow = numOrNull(ps[3]);
    // Absence is NEVER coerced to a temperature: a missing entry stays null so evalAdvisory skips it rather than
    // reading it as 0°F.
    const lowOrNull = (v) => (Number.isFinite(v) ? v : null);
    return {
      // The D1..D3 forecast-low window and its date labels, read by handler's frost evaluation. While FROST_ALERT_ENABLED
      // is on, engine.generatePlan also stores both in the plan's hydrology; with the flag off neither enters the stored
      // plan (flag-OFF byte-parity holds).
      forecast_lows: [lowOrNull(tmin[3]), lowOrNull(tmin[4]), lowOrNull(tmin[5])],
      forecast_dates: [times[3] || null, times[4] || null, times[5] || null],
      recent_precip_in: round2OrNull(sumOrNull(numOrNull(ps[0]), numOrNull(ps[1]))),   // D-2 + D-1
      today_precip_in: round2OrNull(numOrNull(ps[2])),       // D0 — rain falling TODAY
      today_pop: pop[2] != null ? pop[2] : null,
      upcoming_precip_in: round2OrNull(sumOrNull(tomorrow, numOrNull(ps[4]))),        // D1 + D2
      tomorrow_precip_in: round2OrNull(tomorrow),
      tomorrow_pop: pop[3] != null ? pop[3] : null,
      // D+2's PROBABILITY, so the two-day horizon (upcoming_precip_in, D1+D2) can be gated: the suppression design bars
      // everything on a PoP, and an unprobabilised amount is unusable. Null-not-zero: a missing probability must never
      // read as 0%.
      upcoming_pop: pop[4] != null ? pop[4] : null,
      // D2 on its own, with its date, for Today's following-day rain line, so the card never has to subtract D1 back out
      // of upcoming_precip_in. Display only: no watering decision reads these.
      day2_precip_in: round2OrNull(numOrNull(ps[4])),
      day2_pop: pop[4] != null ? pop[4] : null,
      day2_date: typeof times[4] === 'string' ? times[4] : null,
      // D-1 OBSERVED rain on its own: recent_precip_in is the D-2+D-1 sum, so a busted forecast was unrecoverable after the
      // fact. Consumed ONLY by handler.backfillYesterdayActual (onto YESTERDAY's plan row); engine.generatePlan copies
      // hydrology by NAMED key, so this never enters the current day's stored plan (byte-parity safe). null, NEVER 0, when
      // Open-Meteo omits the value: absence of data must not be recorded as "no rain fell".
      yesterday_precip_actual_in: Number.isFinite(ps[1]) ? round2(ps[1]) : null,
      // D0's live forecast ET0 + Tmax (daily index 2; no URL change). weather_daily holds COMPLETED days only, so without
      // these today's ledger demand would always degrade to the 1.0 branch. Engine copies hydrology by NAMED key, so
      // flag-OFF byte-parity holds; null (never 0) on absence.
      today_et0_in: Number.isFinite(et0[2]) ? round3(et0[2]) : null,
      today_tmax_f: Number.isFinite(tmax[2]) ? round2(tmax[2]) : null,
      // The D-2..D+3 wetness window, from arrays already fetched. A SERIES rather than a D0 scalar because the cue is about
      // runs of wet days, and the forecast half is only reachable here (weather_daily stores completed days only).
      // An absent hour count is null, never 0: 0 hours is a real dry day.
      wetness_window: times.map((t, i) => ({
        date: t,
        precip_hours: Number.isFinite(preciph[i]) ? round2(preciph[i]) : null,
        tmax_f: Number.isFinite(tmax[i]) ? round2(tmax[i]) : null,
        tmin_f: Number.isFinite(tmin[i]) ? round2(tmin[i]) : null,
      })).filter((d) => d.date),
      // The hour-resolution forecast, carried VERBATIM (local ISO timestamps + their timezone) so station.remainingHourlyIn
      // can scope "still to come" to the hours not yet elapsed. Untransformed on purpose: its date-string matching is what
      // keeps the window DST-safe. null (never []) when omitted, so the merge falls back to whole-day behaviour and labels
      // it, rather than reading "no more rain coming".
      hourly_precip: (j.hourly && Array.isArray(j.hourly.time) && Array.isArray(j.hourly.precipitation))
        ? { time: j.hourly.time, precipitation: j.hourly.precipitation, timezone: j.timezone || null }
        : null,
      // The three radiative-frost inputs, carried VERBATIM with their local ISO timestamps so radiativeFrost.nightsFrom can
      // bucket them into 18:00->08:00 windows by string arithmetic (DST-safe, like hourly_precip).
      // null (never {} or []) when any is omitted: a missing block must degrade to "no radiative signal", not to a night
      // reading 0% cloud and 0 mph wind. 0/0 is the EXACT positive case this feature looks for, so coercing would
      // manufacture the trip it is supposed to detect.
      hourly_frost: (j.hourly && Array.isArray(j.hourly.time) && Array.isArray(j.hourly.dew_point_2m)
        && Array.isArray(j.hourly.cloud_cover) && Array.isArray(j.hourly.wind_speed_10m))
        ? {
          time: j.hourly.time,
          dew_point_2m: j.hourly.dew_point_2m,
          cloud_cover: j.hourly.cloud_cover,
          wind_speed_10m: j.hourly.wind_speed_10m,
          timezone: j.timezone || null,
        }
        : null,
      // The hourly temperature, VERBATIM with its local stamps, so frostEval.locateNight can find the hour of the advisory
      // day's minimum. Its OWN key, guarded on its OWN array, deliberately NOT folded into hourly_frost (null unless all
      // three radiative arrays arrive): a missing dewpoint must not cost the advisory its night. null (never {}) when
      // absent -> the advisory names the base-rate night.
      hourly_temp: (j.hourly && Array.isArray(j.hourly.time) && Array.isArray(j.hourly.temperature_2m))
        ? { time: j.hourly.time, temperature_2m: j.hourly.temperature_2m, timezone: j.timezone || null }
        : null,
      // The COMPLETED days in this response, as the rows weather_daily will hold. Indices 0 and 1 are D-2 and D-1; index 2
      // (D0) is deliberately EXCLUDED: intraday runs must never persist a partial day, which reads back as a real dry day.
      // `date` is Open-Meteo's own America/New_York day label, the civil day weather_daily is contracted to hold; deriving
      // it from the fetch clock would misplace the row when a run straddles midnight.
      // precip_in is the RAW model value, never the gauge: the D-1 gauge merge happens in station.mergeStationHydrology and
      // lands on yesterday_precip_actual_in, which handler.writeWeatherDaily prefers, so precip_source stays honest.
      // These keys ride on the hydrology bag but never reach the stored plan: engine.generatePlan copies by NAMED key.
      settled_days: [0, 1].map((i) => ({
        date: times[i] || null,
        et0_in: Number.isFinite(et0[i]) ? round3(et0[i]) : null,
        tmax_f: Number.isFinite(tmax[i]) ? round2(tmax[i]) : null,
        tmin_f: Number.isFinite(tmin[i]) ? round2(tmin[i]) : null,
        // null, NEVER 0 — absence of data must not be recorded as "no rain fell".
        precip_in: Number.isFinite(ps[i]) ? round2(ps[i]) : null,
        // Same null-never-0 rule: 0 sunshine seconds is a real overcast day and 0 precipitation_hours a real dry one.
        // round2 is the endpoint's own resolution for these five, so it loses nothing (ET0 needs round3).
        daylight_s: Number.isFinite(daylight[i]) ? round2(daylight[i]) : null,
        sunshine_s: Number.isFinite(sunshine[i]) ? round2(sunshine[i]) : null,
        solar_mj_m2: Number.isFinite(solar[i]) ? round2(solar[i]) : null,
        wind_max_mph: Number.isFinite(windmax[i]) ? round2(windmax[i]) : null,
        precip_hours: Number.isFinite(preciph[i]) ? round2(preciph[i]) : null,
      })).filter((d) => d.date),
    };
  } catch (e) {
    console.warn(JSON.stringify({ msg: 'fetchPrecip failed — hydrology null', lat, lng, error: e.message }));
    return null;
  }
}

// Tomorrow's and the day after's rain from five models (see rainForecast.js). Its OWN request, deliberately never folded
// into fetchPrecip's URL: `models=` there suffixes every daily and hourly key or, with one model, moves the frost lows.
// Placed after fetchPrecip and named without its prefix because the source-text harnesses (openmeteo-indices,
// fetchprecip-errorbody, nightly-timeout) cut fetchPrecip out by name. Any failure returns null, and the run keeps
// best_match for every day-ahead field.
async function fetchRainForecast(lat, lng, today) {
  try {
    const r = await fetch(rainForecast.rainForecastUrl(lat, lng), { signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error(`Open-Meteo HTTP ${r.status}`);
    const rf = rainForecast.fromOpenMeteoModels(await r.json(), today);
    if (!rf) throw new Error('five-model body incomplete for D1/D2');
    return rf;
  } catch (e) {
    console.warn(JSON.stringify({ msg: 'fetchRainForecast failed — day-ahead stays best_match', lat, lng, error: e.message }));
    return null;
  }
}

// On-site AmbientWeather station. Read lazily and fully guarded: a missing or broken AWN secret or a station outage must
// NEVER empty the nightly plan, so any failure returns null and the run falls back to Open-Meteo/NWS. Kept in a SEPARATE
// secret (garden-app/awn-keys) from the NEON/CLERK blob.
const AWN_SECRET_NAME = process.env.AWN_SECRET_NAME || 'garden-app/awn-keys';
let _awn; // cache: object {apiKey,appKey} or null (resolved once); undefined = not yet read
async function getAwnKeys() {
  if (_awn !== undefined) return _awn;
  try {
    const sm = new SecretsManagerClient({});
    const res = await sm.send(new GetSecretValueCommand({ SecretId: AWN_SECRET_NAME }));
    const j = JSON.parse(res.SecretString || '{}');
    _awn = (j.apiKey && j.appKey) ? { apiKey: j.apiKey, appKey: j.appKey } : null;
  } catch (e) {
    console.warn(JSON.stringify({ msg: 'AWN secret read failed — station disabled', error: e.message }));
    _awn = null;
  }
  return _awn;
}
async function awnGet(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) }); // under the 30s Lambda ceiling
  if (!r.ok) throw new Error(`AWN ${r.status}`);
  return r.json();
}
// Paginated device history (newest-first, 5-min records). Up to 3 pages of 288 (~3 civil days) chained by
// endDate, spaced >=1.1s for the AWN 1 req/sec limit. Returns { mac, records[] } or null on any failure.
async function fetchStation() {
  try {
    const keys = await getAwnKeys();
    if (!keys) return null;
    const st = stationConfig()[0];
    // AWN_STATIONS_JSON unset/malformed: no gauge to fetch. Return null (== gauge offline) rather than
    // throwing on st.mac inside this try, so the failure is named in the log instead of swallowed.
    if (!st) { console.warn('station: no station config (AWN_STATIONS_JSON unset?) — skipping gauge fetch'); return null; }
    const mac = st.mac;
    const base = `https://api.ambientweather.net/v1/devices/${encodeURIComponent(mac)}` +
      `?apiKey=${encodeURIComponent(keys.apiKey)}&applicationKey=${encodeURIComponent(keys.appKey)}`;
    let records = [];
    let endDate = null;
    for (let page = 0; page < 3; page++) {
      const url = base + `&limit=288` + (endDate ? `&endDate=${endDate}` : '');
      const chunk = await awnGet(url);
      if (!Array.isArray(chunk) || !chunk.length) break;
      records = records.concat(chunk);
      const oldest = chunk[chunk.length - 1];
      if (!oldest || !Number.isFinite(oldest.dateutc)) break;
      endDate = oldest.dateutc - 1;
      if (page < 2) await new Promise((r) => setTimeout(r, 1100));
    }
    return records.length ? { mac, records } : null;
  } catch (e) {
    console.warn(JSON.stringify({ msg: 'fetchStation failed — station disabled', error: e.message }));
    return null;
  }
}

exports.handler = async (event) => {
  // A0.2-EVENT-OVERRIDES sentinel — scripts/rerun-daily-plan.sh greps the DEPLOYED zip's index.js for this exact marker
  // before ANY invoke. Do not rename/remove. Overrides are fail-safe-only (handler.resolveInvokeOptions): the payload can
  // force DRY or override the date, never force live.
  // A0.4-FLAG-OVERRIDES sentinel — dry-run-ONLY engine-flag overrides (event.flagOverrides, whitelisted + strict-boolean,
  // hard-rejected on any live run by handler.resolveInvokeOptions). The wrapper greps the deployed zip for this marker
  // before any --flag-overrides invoke. Do not rename/remove.
  const { dryRun, today, ping, flagOverrides } = resolveInvokeOptions(event, {
    envDryRun: process.env.DRY_RUN, todayDefault: todayET(),
  });
  if (ping) return { ok: true, ping: true, eventOverrides: true, today, dryRun };
  const started = Date.now();
  const { NEON_DATABASE_URL } = await getSecrets();
  const pool = new Pool({ connectionString: NEON_DATABASE_URL });
  // The pool re-emits an IDLE client's connection loss as a pool 'error' event; with no listener Node throws it as an
  // uncaught exception and the runtime kills the invocation (Neon closes idle pooler sockets). Nothing is lost when an
  // idle client drops: the next pool.query opens a fresh connection, and a query that fails still rejects into the
  // catch below, so a real outage still fails the invocation, retries and pages.
  // Log message and code ONLY: the error carries `client`, whose config holds the DSN with its password.
  pool.on('error', (err) => {
    console.warn(JSON.stringify({ msg: 'db-pool-idle-error', error: err && err.message, code: (err && err.code) || null, ms: Date.now() - started }));
  });
  try {
    const res = await run({ pg: pool, today, dryRun, flagOverrides, geocodeZip, fetchNWS, fetchPrecip, fetchRainForecast, fetchStation, publishAlert, etHour: hourET(), event });
    console.log(JSON.stringify({ msg: 'daily-plan', today, dryRun, rows: res.rows, ms: Date.now() - started }));
    // A0.3-DRY-PLANS sentinel — DRY responses carry the computed plans so scripts/rerun-daily-plan.sh --diff can compare
    // a zero-write replay against the stored rows (it greps the deployed zip for this marker). LIVE responses stay lean.
    return { ok: true, today, dryRun, rows: res.rows, ...(dryRun ? { plans: res.plans } : {}) };
  } catch (e) {
    console.error(JSON.stringify({ msg: 'daily-plan ERROR', today, dryRun, error: e.message }));
    throw e;
  } finally {
    await pool.end().catch(() => {});
  }
};
