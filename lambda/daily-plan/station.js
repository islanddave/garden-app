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

  // BUG-RAINACTUAL-001 H1 — expose the D0 / D-1 buckets that were already being computed and thrown away.
  // todayPrecipIn needs NO coverage gate: dailyrainin is the STATION's own since-local-midnight accumulator,
  // so a single record at 15:00 already carries the whole day to that point. It is partial by nature — that
  // is the point (it grows through the day). yesterdayPrecipIn is a COMPLETED day and is gated by the
  // caller on coversLookback (design §3-4: reuse the existing gate, no new freshness concept).
  const todayPrecipIn = Number.isFinite(buckets[D0]) ? round2(buckets[D0]) : null;
  const yesterdayPrecipIn = Number.isFinite(buckets[D1]) ? round2(buckets[D1]) : null;

  return { mac: raw.mac, lat: cfg.lat, lng: cfg.lng, tz, fresh, dataAgeMin, tempF, recentPrecipIn, coversLookback, buckets, uncertainty,
    day0: D0, day1: D1, day2: D2, todayPrecipIn, yesterdayPrecipIn };
}

// Gauge totals addressed by CIVIL-DAY LABEL rather than by the fetch instant. deriveStation's D0/D1/D2 are
// anchored to `nowMs`; a replay (rerun-daily-plan.sh --today) is about a DIFFERENT day, and reading "today's"
// bucket for it would attribute the wrong day's rain. In the live nightly/intraday runs planDay is
// todayET() === st.day0 (same America/New_York tz), so every value below is identical to what deriveStation
// already exposes — this is a correctness widening for replay, not a behaviour change for the real runs.
function gaugeWindow(st, planDay) {
  const none = { day: null, observed: null, yesterday: null, recent: null, coversLookback: false };
  if (!st || !st.buckets) return none;
  const d0 = planDay || st.day0;
  if (!d0) return none;
  const d1 = dayBefore(d0), d2 = dayBefore(d1);
  const b = st.buckets;
  const at = (k) => (Number.isFinite(b[k]) ? round2(b[k]) : null);
  const earliest = Object.keys(b).sort()[0];
  const covers = !!earliest && earliest < d2 && Number.isFinite(b[d1]) && Number.isFinite(b[d2]);
  return { day: d0, observed: at(d0), yesterday: at(d1), recent: covers ? round2(b[d1] + b[d2]) : null, coversLookback: covers };
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

// Field-granular merge (V200 B2, widened by BUG-RAINACTUAL-001): the gauge now supplies every field that is
// an OBSERVATION — recent (D-2+D-1), the already-fallen part of today, and yesterday's actual — while
// Open-Meteo keeps the fields a gauge genuinely cannot provide (tomorrow_/upcoming_, PoP, and the part of
// today that has not fallen yet). Covered/indoor credit is handled downstream by the engine's rainClass (B5).
// `opts.planDay` is the plan's civil date; omit it and the fetch-day labels are used (see gaugeWindow).
// Returns {merged, prov}. Every substitution is recorded in prov — a silent fallback is the defect this
// whole change exists to remove.
function mergeStationHydrology(hy, st, opts) {
  const base = hy || { recent_precip_in: null, today_precip_in: null, today_pop: null, upcoming_precip_in: null, tomorrow_precip_in: null, tomorrow_pop: null };
  const merged = { ...base };
  const prov = {};
  const gw = gaugeWindow(st, opts && opts.planDay);
  const useStation = !!(st && st.fresh && gw.coversLookback && gw.recent != null);
  if (useStation) {
    merged.recent_precip_in = gw.recent;
    prov.recent_source = 'station';
  } else {
    prov.recent_source = base.recent_precip_in != null ? 'forecast' : 'unavailable';
    if (st && st.uncertainty) prov.station_uncertainty = st.uncertainty;
  }

  // ── H2 (design §3-1) — split TODAY into what the gauge has already MEASURED and what the forecast still
  // expects. `today_precip_in` keeps its name AND its meaning (the day's total), so every downstream
  // consumer — windowPrecip, rainCreditDays, rainCreditDaysTiered, saturationSuppressed, todayQualifies,
  // computeCallout, hydrologyStatus — is untouched. The two new fields are additive observability.
  // This is what makes the gauge "drive throughout the day": at the 02:00 run observed is ~0 and remaining
  // is ~the whole forecast (behaviour identical to before); by the 15:30 run observed is nearly the entire
  // day and the forecast contributes only the tail.
  // Gated on `fresh` ONLY, not coversLookback: a station that came online this morning still reports today's
  // accumulator truthfully (warm-up is a statement about the 2-day LOOKBACK, not about today).
  const fToday = Number.isFinite(base.today_precip_in) ? base.today_precip_in : null;
  if (st && st.fresh && gw.observed != null) {
    const observed = gw.observed;
    // CLAMPED AT ZERO. When the gauge already exceeds the forecast the remainder is 0, never negative — a
    // busted-LOW forecast must never be able to SUBTRACT water that has physically fallen.
    const remaining = fToday != null ? Math.max(0, round2(fToday - observed)) : 0;
    merged.today_observed_in = observed;
    merged.today_remaining_in = remaining;
    merged.today_precip_in = round2(observed + remaining);
    prov.today_source = (fToday == null || remaining === 0) ? 'station' : 'station+forecast';
  } else {
    prov.today_source = fToday != null ? 'forecast' : 'unavailable';
  }

  // ── H3 (design §3-2) — THE BUG. yesterday_precip_actual_in was Open-Meteo's own past_days HINDCAST: the
  // one field built to answer "did we skip on a forecast that busted?" was itself sourced from the forecast
  // (4.63" recorded for 2026-08-03 against 2.22" on the on-site gauge). The station's D-1 bucket is an
  // OBSERVATION and wins. Falling back to the forecast is allowed — but it is ALWAYS LABELLED. An "actual"
  // that is silently a forecast is the entire defect; see also handler.backfillYesterdayActual, which
  // persists this label alongside the value.
  // Gated on coversLookback because D-1 is a COMPLETED day: a partial D-1 must never be published as its total.
  const fYest = Number.isFinite(base.yesterday_precip_actual_in) ? base.yesterday_precip_actual_in : null;
  if (st && st.fresh && gw.coversLookback && gw.yesterday != null) {
    merged.yesterday_precip_actual_in = gw.yesterday;
    prov.yesterday_actual_source = 'station';
  } else {
    prov.yesterday_actual_source = fYest != null ? 'forecast' : 'unavailable';
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

module.exports = { stationConfig, deriveStation, gaugeWindow, bindStationToSpace, mergeStationHydrology, mergeStationWeather, civilDay, dayBefore, FRESHNESS_MAX_MIN, COORD_TOL };
