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

// DRG-GAUGESANITY-001 — upper plausibility bound on the daily accumulator. FRESHNESS_MAX_MIN only ever
// established that the gauge is REPORTING; nothing established that the number was POSSIBLE. A tipping bucket
// that phantom-tips (spider in the funnel, debris, a hail strike on the cone) reports an unbounded total, and
// the engine reads that as real rain — which SUPPRESSES watering, and the measured-rain soak basis outranks
// both the bagHeatGate and freshTransplant carve-outs. The failure mode's cost is dead plants.
//
// Anchored on the PHYSICAL ceiling for this location, deliberately NOT on this site's recent weather. The
// Massachusetts 24-hour rainfall record is 18.15" (Westfield, 1955-08-18/19, Hurricane Diane); 20" clears it
// with headroom, so no locally possible event can ever be rejected. For scale on the other side: the 94 days
// of weather_daily for this Space (2026-05-14..2026-08-15, 42.5089/-72.6466) top out at 2.23" with p99 1.31",
// mean 0.16", and exactly ONE day above 2" — a fault has to read ~9x anything the site has actually seen to
// trip this. A tighter, distribution-fitted bound (say 4-5") was rejected: it would throw away a genuine
// tropical remnant — Irene put 5-10" on western MA in 2011 — and discarding real rain during a flood is the
// same wrong watering signal from the other direction.
//
// `Number(...) || 20` rather than the FRESHNESS_MAX_MIN `Number(x || 90)` shape on purpose: a garbage override
// must fall back to the default, not to NaN, because every `> NaN` compares false and would silently disable
// the bound entirely.
const RAIN_MAX_DAILY_IN = Number(process.env.AWN_RAIN_MAX_DAILY_IN) || 20;

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// Civil-day label (YYYY-MM-DD) for an epoch-ms instant in a named tz. dailyrainin resets at station-LOCAL
// midnight, so buckets MUST be tz-local, not UTC (V200 B1). History records carry tz:null, so the configured
// station tz is authoritative.
function civilDay(ms, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}
// Civil HOUR (0-23) of an instant in a named tz. h23 so midnight is 0, not 24. Same tz as civilDay, so the
// (day, hour) pair the H5 hourly scope is built from is internally consistent — the hour can never be read
// against a different day than the buckets are. Returns null rather than NaN on a bad input.
function civilHour(ms, tz) {
  const n = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(new Date(ms)));
  return Number.isFinite(n) ? n : null;
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
// Open-Meteo + uncertainty. Never coerces an absent field to 0.0 (V200 B7). A day whose accumulator exceeds
// RAIN_MAX_DAILY_IN is dropped outright (DRG-GAUGESANITY-001) and surfaces as implausibleDays[].
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
  // DRG-GAUGESANITY-001 — drop any day whose total is physically impossible (see RAIN_MAX_DAILY_IN). Checking
  // the finished bucket rather than each record is exactly equivalent — a bucket IS the max of its records, so
  // `bucket > bound` holds iff some record for that day was impossible — and it costs one pass, not a branch
  // in the hot loop. The day is DELETED, never clamped and never zeroed: a clamped total is a fabricated
  // observation, and a zeroed one fabricates "no rain", which is itself a wrong watering signal. Deleting
  // routes each affected field down the SAME already-tested absent-bucket path a stale station takes — the
  // labelled Open-Meteo fallback — instead of inventing a second failure mode.
  const implausibleDays = [];
  for (const d of Object.keys(buckets)) {
    if (buckets[d] > RAIN_MAX_DAILY_IN) { implausibleDays.push(d); delete buckets[d]; }
  }
  implausibleDays.sort();

  const D0 = civilDay(nowMs, tz), D1 = dayBefore(D0), D2 = dayBefore(D1);
  const daysPresent = Object.keys(buckets).sort();
  const earliest = daysPresent[0];
  // Full coverage of D-2 requires data starting BEFORE D-2 (so D-2's midnight-to-midnight is captured) and
  // both prior-day buckets present. String compare is valid for YYYY-MM-DD.
  const coversLookback = !!earliest && earliest < D2 && (D1 in buckets) && (D2 in buckets);
  const recentPrecipIn = coversLookback ? round2((buckets[D1] || 0) + (buckets[D2] || 0)) : null;
  // 'implausible' sits ABOVE 'warmup' because a rejected bucket is frequently what BROKE coverage, and calling
  // that a warm-up names the wrong cause on the one signal an operator would read. It deliberately does NOT
  // touch `fresh`: the feed is current, one number inside it was not. Forcing fresh=false would also strip the
  // temperature floor in mergeStationWeather — a rain-gauge fault must never be able to disarm frost warning.
  const uncertainty = !fresh ? 'stale' : (implausibleDays.length ? 'implausible' : (!coversLookback ? 'warmup' : null));

  // BUG-RAINACTUAL-001 H1 — expose the D0 / D-1 buckets that were already being computed and thrown away.
  // todayPrecipIn needs NO coverage gate: dailyrainin is the STATION's own since-local-midnight accumulator,
  // so a single record at 15:00 already carries the whole day to that point. It is partial by nature — that
  // is the point (it grows through the day). yesterdayPrecipIn is a COMPLETED day and is gated by the
  // caller on coversLookback (design §3-4: reuse the existing gate, no new freshness concept).
  const todayPrecipIn = Number.isFinite(buckets[D0]) ? round2(buckets[D0]) : null;
  const yesterdayPrecipIn = Number.isFinite(buckets[D1]) ? round2(buckets[D1]) : null;

  return { mac: raw.mac, lat: cfg.lat, lng: cfg.lng, tz, fresh, dataAgeMin, tempF, recentPrecipIn, coversLookback, buckets, uncertainty,
    day0: D0, day1: D1, day2: D2, hour0: civilHour(nowMs, tz), todayPrecipIn, yesterdayPrecipIn, implausibleDays };
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

// ── H5 (BUG-RAINACTUAL-001, supersedes the H2 whole-day subtraction) ──────────────────────────────
// Sum the HOURLY forecast for the hours of `day` that have NOT YET ELAPSED, i.e. strictly after `hourNow`.
//
// Why this replaces `max(0, wholeDayForecast - observed)`: that subtraction made today_precip_in
// (= observed + remaining) UNABLE TO FALL BELOW the whole-day forecast. On the real 2026-08-03 event the
// gauge measured 2.22" against a 4.63" forecast, so remaining came out 2.41" and the total landed right back
// on 4.63" — identical to the pre-fix bug. The gauge could only ever move the number when it EXCEEDED the
// forecast, which is the opposite of the failure being fixed. Scoping remaining to the unelapsed hours makes
// a forecast that busted HIGH in the morning decay out of the number as the day passes.
//
// Matching is by DATE-STRING PREFIX on the local ISO timestamps, never by array index. That is what makes it
// safe against (a) an hourly array whose first day differs from the daily array's first day, and (b) DST:
// spring-forward days carry 23 rows (no 02:00) and fall-back days carry 25 (two 01:00 rows, both counted —
// both are genuinely still ahead). An index-based window would silently slide on either.
//
// Returns null — never 0 — whenever the data cannot support an answer, so the caller falls back to the H2
// whole-day behaviour rather than reporting "no more rain coming" and over-watering into an incoming storm.
function remainingHourlyIn(hourly, day, hourNow) {
  if (!hourly || !Array.isArray(hourly.time) || !Array.isArray(hourly.precipitation)) return null;
  if (typeof day !== 'string' || !Number.isFinite(hourNow)) return null;
  const t = hourly.time, p = hourly.precipitation;
  let dayRows = 0, futureRows = 0, finiteRows = 0, sum = 0;
  for (let i = 0; i < t.length; i++) {
    const s = t[i];
    if (typeof s !== 'string' || s.slice(0, 10) !== day) continue;
    dayRows++;
    const h = Number(s.slice(11, 13));
    if (!Number.isFinite(h) || h <= hourNow) continue;
    futureRows++;
    const v = p[i];
    if (!Number.isFinite(v)) continue;
    finiteRows++;
    sum += v;
  }
  if (!dayRows) return null;                   // the plan day is not inside the hourly window at all
  if (futureRows && !finiteRows) return null;  // hours remain but every value is null/absent -> unusable
  return round2(sum);                          // futureRows === 0 (late-day / replay) legitimately sums to 0
}

// Which hour of `day` we are standing in, from the STATION's own clock (same tz as its buckets).
// Replay-aware: a plan day in the past is fully elapsed (nothing left to come); a plan day in the future has
// its whole day ahead. Returns null when the station cannot say, which routes the caller to the fallback.
function effectiveHour(st, day) {
  if (!st || !day || !st.day0 || !Number.isFinite(st.hour0)) return null;
  if (day === st.day0) return st.hour0;
  return day < st.day0 ? 23 : -1;
}

// Resolve remaining-for-today from the hourly forecast, or say why it could not be. `why` is carried into
// provenance: a fallback to the whole-day number is allowed, but — like every other substitution here — it
// is never silent.
function remainingForecast(base, st, day) {
  const hourly = base && base.hourly_precip;
  if (!hourly) return { in: null, why: 'no_hourly' };
  // The hourly timestamps are LOCAL to whatever tz Open-Meteo was asked for. Reading them against a station
  // in a different tz would misalign the day boundary, so refuse rather than guess (single-station today;
  // this is the guard for the V200 §3 multi-station evolution).
  if (hourly.timezone && st && st.tz && hourly.timezone !== st.tz) return { in: null, why: 'tz_mismatch' };
  const hour = effectiveHour(st, day);
  if (hour == null) return { in: null, why: 'no_hour' };
  const v = remainingHourlyIn(hourly, day, hour);
  if (v == null) return { in: null, why: 'hourly_unusable' };
  return { in: v, hour, why: null };
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

  // ── H2 (design §3-1) as CORRECTED BY H5 — split TODAY into what the gauge has already MEASURED and what
  // the forecast still expects. `today_precip_in` keeps its name AND its meaning (the day's total), so every
  // downstream consumer — windowPrecip, rainCreditDays, rainCreditDaysTiered, saturationSuppressed,
  // todayQualifies, computeCallout, hydrologyStatus — is untouched. The two new fields are additive
  // observability.
  //
  // H5: `remaining` is the HOURLY forecast for the hours not yet elapsed (see remainingHourlyIn), NOT the
  // whole-day forecast minus the gauge. The subtraction form shipped in H2 could never let the gauge pull the
  // total DOWN — it floored today_precip_in at the whole-day forecast — which left the original bug intact
  // whenever the forecast busted high. The hourly form is what actually makes the gauge drive the number
  // through the day: at 02:00 nearly the whole day is still ahead so remaining ~= the full forecast (parity
  // with the nightly baseline); by 15:30 only the evening tail is left and the number is essentially the gauge.
  //
  // FALLBACK: no hourly data / wrong tz / day outside the hourly window -> the H2 whole-day subtraction, so
  // the degraded path is never WORSE than what already ships, and is LABELLED in prov.today_remaining_basis.
  // A missing hourly array must never resolve to remaining=0 — that would under-report incoming rain and
  // over-water into a storm (remainingHourlyIn returns null, never 0, for unusable data).
  //
  // Gated on `fresh` ONLY, not coversLookback: a station that came online this morning still reports today's
  // accumulator truthfully (warm-up is a statement about the 2-day LOOKBACK, not about today).
  const fToday = Number.isFinite(base.today_precip_in) ? base.today_precip_in : null;
  if (st && st.fresh && gw.observed != null) {
    const observed = gw.observed;
    const rf = remainingForecast(base, st, gw.day);
    let remaining;
    if (rf.in != null) {
      remaining = rf.in;
      prov.today_remaining_basis = 'hourly';
      prov.today_remaining_from_hour = rf.hour;
    } else {
      // H2 legacy path. CLAMPED AT ZERO: when the gauge already exceeds the forecast the remainder is 0,
      // never negative — a busted-LOW forecast must never be able to SUBTRACT water that has physically fallen.
      remaining = fToday != null ? Math.max(0, round2(fToday - observed)) : 0;
      prov.today_remaining_basis = 'wholeday';
      prov.today_remaining_fallback = rf.why;
    }
    merged.today_observed_in = observed;
    merged.today_remaining_in = remaining;
    merged.today_precip_in = round2(observed + remaining);
    prov.today_source = remaining > 0 ? 'station+forecast' : 'station';
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

  if (st) { prov.station_age_min = st.dataAgeMin; prov.station_fresh = st.fresh; prov.station_mac = st.mac;
    // DRG-GAUGESANITY-001. Recorded UNCONDITIONALLY, unlike station_uncertainty above, which is only written
    // on the recent-fallback branch: a rejection confined to D0 leaves recent and yesterday gauge-sourced, so
    // that branch never runs and the drop would otherwise be invisible. A discarded reading is never silent.
    if (st.implausibleDays && st.implausibleDays.length) prov.station_rejected_days = st.implausibleDays; }
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

module.exports = { stationConfig, deriveStation, gaugeWindow, bindStationToSpace, mergeStationHydrology, mergeStationWeather, civilDay, civilHour, dayBefore, remainingHourlyIn, effectiveHour, FRESHNESS_MAX_MIN, RAIN_MAX_DAILY_IN, COORD_TOL };
