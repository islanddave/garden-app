'use strict';
// DRG-TODAY-001 — AWS Lambda ENTRYPOINT for the overnight Daily Plan generator. STAGED, HELD at dev.
// Mirrors lambda/xp-reconcile: Secrets Manager -> Neon, EventBridge nightly, DRY_RUN-gated, no Fn URL.
// Pure plan logic is in ./handler (run) + ./engine; the real HTTP fetchers live here (injected into run).
// ⚠️ GATE-0 before first non-dry run: validate the NWS forecast parsing + zippopotam + Open-Meteo daily
//    field names/indices against LIVE responses. The daily index assumption [D-2,D-1,D0,D1,D2] (past_days=2,
//    forecast_days=3) must hold. Confirm @neondatabase/serverless Pool .query() shape matches handler's pg.
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
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

// zip -> {lat,lng} (public, no key). Upstream caches to spaces.weather_lat/lng.
async function geocodeZip(zip) {
  const r = await fetch(`https://api.zippopotam.us/us/${encodeURIComponent(zip)}`);
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
    const pts = await (await fetch(`https://api.weather.gov/points/${lat},${lng}`, { headers: hdr })).json();
    const fc = await (await fetch(pts.properties.forecast, { headers: hdr })).json();
    const periods = (fc.properties && fc.properties.periods) || [];
    const day = periods.find((p) => p.isDaytime);
    const night = periods.find((p) => !p.isDaytime);
    let code = null;
    try {
      const om = await (await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&daily=weather_code&timezone=America/New_York&forecast_days=1`)).json();
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
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
      `&daily=precipitation_sum,precipitation_probability_max&precipitation_unit=inch&timezone=America/New_York&past_days=2&forecast_days=3`;
    const j = await (await fetch(url)).json();
    const ps = (j.daily && j.daily.precipitation_sum) || [];   // [D-2, D-1, D0, D1, D2]
    const pop = (j.daily && j.daily.precipitation_probability_max) || [];
    const tomorrow = ps[3] || 0;
    return {
      recent_precip_in: round2((ps[0] || 0) + (ps[1] || 0)),
      today_precip_in: round2(ps[2] || 0),                 // D0 — rain falling TODAY (was fetched but dropped; DRG-WX-TODAY-FIX)
      today_pop: pop[2] != null ? pop[2] : null,
      upcoming_precip_in: round2(tomorrow + (ps[4] || 0)),
      tomorrow_precip_in: round2(tomorrow),
      tomorrow_pop: pop[3] != null ? pop[3] : null,
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
    const res = await run({ pg: pool, today, dryRun, geocodeZip, fetchNWS, fetchPrecip, fetchStation });
    console.log(JSON.stringify({ msg: 'daily-plan', today, dryRun, rows: res.rows, ms: Date.now() - started }));
    return { ok: true, today, dryRun, rows: res.rows };
  } catch (e) {
    console.error(JSON.stringify({ msg: 'daily-plan ERROR', today, dryRun, error: e.message }));
    throw e;
  } finally {
    await pool.end().catch(() => {});
  }
};
