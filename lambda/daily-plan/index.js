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
const { run } = require('./handler');

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
      upcoming_precip_in: round2(tomorrow + (ps[4] || 0)),
      tomorrow_precip_in: round2(tomorrow),
      tomorrow_pop: pop[3] != null ? pop[3] : null,
    };
  } catch (e) {
    console.warn(JSON.stringify({ msg: 'fetchPrecip failed — hydrology null', lat, lng, error: e.message }));
    return null;
  }
}

exports.handler = async () => {
  const dryRun = (process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false';
  const today = todayET();
  const started = Date.now();
  const { NEON_DATABASE_URL } = await getSecrets();
  const pool = new Pool({ connectionString: NEON_DATABASE_URL });
  try {
    const res = await run({ pg: pool, today, dryRun, geocodeZip, fetchNWS, fetchPrecip });
    console.log(JSON.stringify({ msg: 'daily-plan', today, dryRun, rows: res.rows, ms: Date.now() - started }));
    return { ok: true, today, dryRun, rows: res.rows };
  } catch (e) {
    console.error(JSON.stringify({ msg: 'daily-plan ERROR', today, dryRun, error: e.message }));
    throw e;
  } finally {
    await pool.end().catch(() => {});
  }
};
