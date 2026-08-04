'use strict';
// DRG-TODAY-001 — AWS Lambda ENTRYPOINT for the overnight Daily Plan generator. STAGED, HELD at dev.
// Mirrors lambda/xp-reconcile: Secrets Manager -> Neon, EventBridge nightly, DRY_RUN-gated, no Fn URL.
// Pure plan logic is in ./handler (run) + ./engine; the real HTTP fetchers live here (injected into run).
// ⚠️ GATE-0 before first non-dry run: validate the NWS forecast parsing + zippopotam + Open-Meteo daily
//    field names/indices against LIVE responses. The daily index assumption [D-2,D-1,D0,D1,D2,D3] (past_days=2,
//    forecast_days=4 since V4-FROST-001 G5) must hold. Confirm @neondatabase/serverless Pool .query() shape
//    matches handler's pg. openmeteo-indices.test.js guards the indexing against drift.
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns'); // V4-FROST-001 F3 delivery channel (D1/D3)
// Lambda nodejs20 has NO global WebSocket. The pinned @neondatabase/serverless@^0.10.0 neon() http client has
// NO .query(text,params) method (that was added in 1.x), and Pool needs an explicit WebSocket constructor.
// Fix: Pool + ws via neonConfig.webSocketConstructor. Pool.query(text,params)->{rows} matches handler's pg
// contract. Both failure modes caught by live DRY_RUN invokes; this combo validated against prod. (busy-brave-hamilton)
const { Pool, neonConfig } = require('@neondatabase/serverless');
const ws = require('ws');
neonConfig.webSocketConstructor = ws;
const { run, resolveInvokeOptions } = require('./handler');
const { stationConfig } = require('./station'); // DRG-WXSTATION-001

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

// ET calendar date — plan_date must be the LOCAL day even when the cron fires after UTC midnight.
function todayET() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// V4-FROST-001 G3 — the ET hour is the ONLY way to tell the three daily runs apart: all three EventBridge
// targets invoke this function with an empty detail (verified in AWS 2026-08-04, no Input on any target).
// hourCycle h23 so midnight is 0, not 24. Consumed by frostEval.resolveFrostRun, which is pure.
function hourET() {
  return Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23',
  }).format(new Date()));
}

// V4-FROST-001 F3 — SNS delivery (D1 channel, D3 separate topic). ARNs are env-overridable; the defaults
// are the live topics in us-east-1 (the account id already appears in .github/workflows, it is not a secret).
// DELIBERATELY NOT wrapped in try/catch, unlike every other fetcher in this file: design §3-7 makes a
// swallowed frost publish the one failure this feature cannot have. handler.run catches it, logs at ERROR,
// finishes writing the plan, then throws so garden-daily-plan-errors (Errors > 0) pages.
const FROST_TOPIC_ARN = process.env.FROST_TOPIC_ARN || 'arn:aws:sns:us-east-1:769788341849:garden-frost-alerts';
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
// DRG-NIGHTLYTIMEOUT-001: every external fetch below is bounded (AbortSignal.timeout) so a hung
// upstream can never eat the Lambda budget; each caller degrades to null on failure (never crashes
// the run). The DB Pool is deliberately UNBOUNDED — the Neon cold-resume stall must be waited out
// (aborting the connect just converts slow success into failure); the 120s fn timeout covers it.
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
    // V4-FROST-001 G5: temperature_2m_min added to a call already being made, and forecast_days 3 -> 4 so
    // the §3-3 48–72h advisory tier can actually see 3 future nights (D1,D2,D3). Both changes are strictly
    // APPENDING: with past_days=2 the daily arrays stay [D-2,D-1,D0,D1,D2,(D3)], so every existing index
    // below (ps[0..4], pop[2..3]) means exactly what it meant before. Guarded by openmeteo-indices.test.js.
    // BUG-RAINACTUAL-001 H5: `hourly=precipitation` is appended to THE SAME call (one request, not two).
    // `hourly` is a SEPARATE response object from `daily`, so this cannot shift ps[]/pop[]/tmin[] by even one
    // slot — the same append-only discipline G5 used, and openmeteo-indices.test.js pins both halves.
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
      `&daily=precipitation_sum,precipitation_probability_max,temperature_2m_min&hourly=precipitation&temperature_unit=fahrenheit&precipitation_unit=inch&timezone=America/New_York&past_days=2&forecast_days=4`;
    const j = await (await fetch(url, { signal: AbortSignal.timeout(6000) })).json();
    const ps = (j.daily && j.daily.precipitation_sum) || [];   // [D-2, D-1, D0, D1, D2, D3]
    const pop = (j.daily && j.daily.precipitation_probability_max) || [];
    const tmin = (j.daily && j.daily.temperature_2m_min) || [];  // same indexing as ps
    const times = (j.daily && j.daily.time) || [];
    const tomorrow = ps[3] || 0;
    // Absence is NEVER coerced to a temperature: a missing entry stays null so evalAdvisory skips it
    // rather than reading it as 0°F. Same rule as yesterday_precip_actual_in below.
    const lowOrNull = (v) => (Number.isFinite(v) ? v : null);
    return {
      // V4-FROST-001 §3-3 Tier 1 — the D1..D3 forecast-low window + its date labels. Consumed ONLY by
      // handler's frost evaluation; engine.generatePlan copies named hydrology keys, so neither field
      // enters the stored plan payload (flag-OFF byte-parity holds).
      forecast_lows: [lowOrNull(tmin[3]), lowOrNull(tmin[4]), lowOrNull(tmin[5])],
      forecast_dates: [times[3] || null, times[4] || null, times[5] || null],
      recent_precip_in: round2((ps[0] || 0) + (ps[1] || 0)),
      today_precip_in: round2(ps[2] || 0),                 // D0 — rain falling TODAY (was fetched but dropped; DRG-WX-TODAY-FIX)
      today_pop: pop[2] != null ? pop[2] : null,
      upcoming_precip_in: round2(tomorrow + (ps[4] || 0)),
      tomorrow_precip_in: round2(tomorrow),
      tomorrow_pop: pop[3] != null ? pop[3] : null,
      // BUG-TODAYWATER-001 actuals backfill: D-1 OBSERVED rain as its own field — recent_precip_in is the
      // D-2+D-1 SUM, so what actually fell on a given day was unrecoverable BY CONSTRUCTION, which made a
      // busted today-forecast undetectable after the fact. Consumed ONLY by handler.backfillYesterdayActual
      // (written onto YESTERDAY's plan row); engine.generatePlan copies named hydrology keys, so this never
      // enters the current day's stored plan (byte-parity safe). null, NEVER 0, when Open-Meteo omits the
      // value — absence of data must not be recorded as "no rain fell".
      yesterday_precip_actual_in: Number.isFinite(ps[1]) ? round2(ps[1]) : null,
      // BUG-RAINACTUAL-001 H5 — the hour-resolution forecast, carried VERBATIM (local ISO timestamps + the tz
      // they are expressed in) so station.remainingHourlyIn can scope "still to come" to the hours that have
      // not elapsed. Passed through untransformed on purpose: the date-string matching in that helper is what
      // makes the window DST-safe and immune to the hourly array starting on a different day than the daily
      // one. null (never []) when Open-Meteo omits it, so the merge falls back to the whole-day behaviour and
      // labels it, rather than reading "no more rain coming".
      hourly_precip: (j.hourly && Array.isArray(j.hourly.time) && Array.isArray(j.hourly.precipitation))
        ? { time: j.hourly.time, precipitation: j.hourly.precipitation, timezone: j.timezone || null }
        : null,
    };
  } catch (e) {
    console.warn(JSON.stringify({ msg: 'fetchPrecip failed — hydrology null', lat, lng, error: e.message }));
    return null;
  }
}

// DRG-WXSTATION-001 — on-site AmbientWeather WS-2902. Read lazily + fully guarded so a missing/broken AWN
// secret or a station outage NEVER empties the nightly plan (V200 B6): any failure returns null and the run
// falls back to Open-Meteo/NWS. Kept in a SEPARATE secret (garden-app/awn-keys) from the NEON/CLERK blob.
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
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) }); // < 30s Lambda ceiling (verified nodejs20, no VPC)
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
  // A0.2-EVENT-OVERRIDES sentinel — scripts/rerun-daily-plan.sh greps the DEPLOYED zip's index.js for
  // this exact marker before ANY invoke (older deploys ignored the payload entirely, so a "dry" invoke
  // against them would really run env-live). Do not rename/remove. Override semantics are fail-safe-only:
  // see handler.resolveInvokeOptions — the payload can force DRY or override the date, never force live.
  const { dryRun, today, ping } = resolveInvokeOptions(event, {
    envDryRun: process.env.DRY_RUN, todayDefault: todayET(),
  });
  if (ping) return { ok: true, ping: true, eventOverrides: true, today, dryRun };
  const started = Date.now();
  const { NEON_DATABASE_URL } = await getSecrets();
  const pool = new Pool({ connectionString: NEON_DATABASE_URL });
  try {
    const res = await run({ pg: pool, today, dryRun, geocodeZip, fetchNWS, fetchPrecip, fetchStation, publishAlert, etHour: hourET(), event });
    console.log(JSON.stringify({ msg: 'daily-plan', today, dryRun, rows: res.rows, ms: Date.now() - started }));
    // A0.3-DRY-PLANS sentinel — DRY responses carry the computed plans so scripts/rerun-daily-plan.sh
    // --diff can compare a zero-write replay against the stored rows (it preflight-greps the deployed zip
    // for this marker, same pattern as A0.2). LIVE responses stay lean; EventBridge nightly is unchanged.
    return { ok: true, today, dryRun, rows: res.rows, ...(dryRun ? { plans: res.plans } : {}) };
  } catch (e) {
    console.error(JSON.stringify({ msg: 'daily-plan ERROR', today, dryRun, error: e.message }));
    throw e;
  } finally {
    await pool.end().catch(() => {});
  }
};
