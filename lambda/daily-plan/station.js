'use strict';
// DRG-WXSTATION-001 — pure derivation + merge helpers for the on-site AmbientWeather WS-2902.
// Everything here is HTTP-free and deterministic for unit testing (L-104). The real HTTP fetch + Secrets
// Manager read live in index.js:fetchStation and are exercised only by the staging dry-run.
// Design ref: weather-station-integration-plan-V200-20260706.md §2 (B1-B8) / §3.

// Single-station config. schema_version supports the single-MAC -> array-of-stations evolution (V200 §3).
// MAC + tz are NOT in the DB (no DDL — V200 Out-of-scope); coords ARE (spaces.weather_lat/lng) and are the
// binding key. Overridable via env AWN_STATIONS_JSON for a future station without redeploying this module.
const DEFAULT_STATIONS = [
  { mac: 'F8:B3:B7:82:1F:0D', tz: 'America/New_York', lat: 42.5089, lng: -72.6466, schema_version: 1 },
];
function stationConfig() {
  const raw = process.env.AWN_STATIONS_JSON;
  if (raw) { try { const a = JSON.parse(raw); if (Array.isArray(a) && a.length) return a; } catch (_) { /* fall through to default */ } }
  return DEFAULT_STATIONS;
}

const FRESHNESS_MAX_MIN = Number(process.env.AWN_FRESHNESS_MAX_MIN || 90); // B7: newest reading older than this => treat offline
const COORD_TOL = 0.02; // ~1.5km: bind a station to a Space by matching stored coords

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// Civil-day label (YYYY-MM-DD) for an epoch-ms instant in a named tz. dailyrainin resets at station-LOCAL
// midnight, so buckets MUST be tz-local, not UTC (V200 B1). History records carry tz:null, so the configured
// station tz is authoritative.
function civilDay(ms, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}
// Previous civil-day LABEL (pure string/date-label math; noon-UTC anchor dodges DST edges — labels only).
function dayBefore(dayStr) {
  const d = new Date(dayStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Derive a normalized station reading from the raw AWN history payload {mac, records[]}.
// records: newest-first array of AWN data points (dateutc epoch-ms, dailyrainin accumulator, tempf, ...).
// Returns null when there is no usable data. recentPrecipIn is populated ONLY when the lookback is fully
// covered (warm-up gate, V200 §3) AND the numbers are finite; otherwise null => caller falls back to
// Open-Meteo + uncertainty. Never coerces an absent field to 0.0 (V200 B7).
function deriveStation(raw, { nowMs }) {
  if (!raw || !Array.isArray(raw.records) || !raw.records.length) return null;
  const cfg = stationConfig().find((s) => s.mac === raw.mac) || stationConfig()[0];
  const tz = cfg.tz;
  const recs = raw.records.filter((r) => r && Number.isFinite(r.dateutc)).sort((a, b) => b.dateutc - a.dateutc);
  if (!recs.length) return null;

  const newest = recs[0];
  const dataAgeMin = Math.round((nowMs - newest.dateutc) / 60000);
  const fresh = dataAgeMin <= FRESHNESS_MAX_MIN;
  const tempF = Number.isFinite(newest.tempf) ? newest.tempf : null;

  // Max dailyrainin per civil day == that day's total (accumulator peak before the midnight reset). Records
  // with a non-finite dailyrainin are skipped (not treated as 0) so a malformed point can't poison a bucket.
  const buckets = {};
  for (const r of recs) {
    if (!Number.isFinite(r.dailyrainin)) continue;
    const d = civilDay(r.dateutc, tz);
    buckets[d] = Math.max(buckets[d] ?? 0, r.dailyrainin);
  }
  const D0 = civilDay(nowMs, tz), D1 = dayBefore(D0), D2 = dayBefore(D1);
  const daysPresent = Object.keys(buckets).sort();
  const earliest = daysPresent[0];
  // Full coverage of D-2 requires data starting BEFORE D-2 (so D-2's midnight-to-midnight is captured) and
  // both prior-day buckets present. String compare is valid for YYYY-MM-DD.
  const coversLookback = !!earliest && earliest < D2 && (D1 in buckets) && (D2 in buckets);
  const recentPrecipIn = coversLookback ? round2((buckets[D1] || 0) + (buckets[D2] || 0)) : null;
  const uncertainty = !fresh ? 'stale' : (!coversLookback ? 'warmup' : null);

  return { mac: raw.mac, lat: cfg.lat, lng: cfg.lng, tz, fresh, dataAgeMin, tempF, recentPrecipIn, coversLookback, buckets, uncertainty };
}

// Bind a station to a Space by coordinate proximity (coords live in spaces.weather_lat/lng — no DDL). Exact
// enough for a single yard; returns the station or null. Never falls through to a wrong Space.
function bindStationToSpace(space, station) {
  if (!station) return null;
  const lat = space.weather_lat, lng = space.weather_lng;
  if (lat == null || lng == null) return null;
  if (Math.abs(Number(lat) - station.lat) <= COORD_TOL && Math.abs(Number(lng) - station.lng) <= COORD_TOL) return station;
  return null;
}

// Field-granular merge (V200 B2): station supplies recent_precip_in ONLY; Open-Meteo still fills the forecast
// fields (tomorrow_/upcoming_) that the gauge can never provide. Covered/indoor credit is handled downstream
// by the engine's rainClass (B5) — this only sets the space-level recent actual. Returns {merged, prov}.
function mergeStationHydrology(hy, st) {
  const base = hy || { recent_precip_in: null, today_precip_in: null, today_pop: null, upcoming_precip_in: null, tomorrow_precip_in: null, tomorrow_pop: null };
  const merged = { ...base };
  const prov = {};
  const useStation = !!(st && st.fresh && st.coversLookback && st.recentPrecipIn != null);
  if (useStation) {
    merged.recent_precip_in = st.recentPrecipIn;
    prov.recent_source = 'station';
  } else {
    prov.recent_source = base.recent_precip_in != null ? 'forecast' : 'unavailable';
    if (st && st.uncertainty) prov.station_uncertainty = st.uncertainty;
  }
  if (st) { prov.station_age_min = st.dataAgeMin; prov.station_fresh = st.fresh; prov.station_mac = st.mac; }
  return { merged, prov };
}

// Station tempf CALIBRATES the forecast low as a conservative floor — never replaces it (V200 B4). A spot
// 02:00 reading is not the overnight minimum, so we only ever push the low COLDER (min), which cannot mask a
// freeze; the pre-emptive forecast trigger stays intact. Inert in summer (station warmer than the nightly low).
function mergeStationWeather(wx, st) {
  if (!wx) return { merged: wx, prov: (st && st.tempF != null) ? { station_temp_f: st.tempF, low_source: 'forecast_absent' } : {} };
  const prov = {};
  let low = wx.tonightLow;
  if (st && st.fresh && st.tempF != null && low != null) {
    const floored = Math.min(low, st.tempF);
    prov.station_temp_f = st.tempF;
    prov.microclimate_offset = Math.round((floored - low) * 10) / 10; // <=0 when station colder than forecast
    prov.low_source = floored < low ? 'station_floor' : 'forecast';
    low = floored;
  } else if (st && st.tempF != null) {
    prov.station_temp_f = st.tempF; prov.low_source = 'forecast';
  }
  return { merged: { ...wx, tonightLow: low }, prov };
}

module.exports = { stationConfig, deriveStation, bindStationToSpace, mergeStationHydrology, mergeStationWeather, civilDay, dayBefore, FRESHNESS_MAX_MIN, COORD_TOL };
