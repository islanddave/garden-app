'use strict';
// Pure derivation + merge helpers for the on-site AmbientWeather WS-2902 (DRG-WXSTATION-001). Everything here
// is HTTP-free and deterministic for unit testing. The real HTTP fetch + Secrets Manager read live in
// index.js:fetchStation. Design ref: weather-station-integration-plan-V200-20260706.md §2 (B1-B8) / §3.

// Single-station config. schema_version supports the single-MAC -> array-of-stations evolution (V200 §3).
// MAC + tz are NOT in the DB (no DDL); coords ARE (spaces.weather_lat/lng) and are the binding key.
//
// The real config lives ONLY in env AWN_STATIONS_JSON and is deliberately NOT in this repo: the repo is
// PUBLIC, and this record is the gauge MAC plus the site coordinate to 4dp, which for a garden at a house
// is the house. The deploy workflow's env step is a jq read-merge, so it survives deploys, and
// verify-daily-plan invariant 1 hard-fails if it goes missing (the ONLY thing between a wiped env and a
// silently gauge-less engine).
//
// Empty default = fail SAFE, not fail SILENT: with no config the engine binds no station and falls back to
// forecast hydrology. Callers must handle [] (see the guards in deriveStation() and fetchStation() in
// index.js).
const DEFAULT_STATIONS = [];
function stationConfig() {
  const raw = process.env.AWN_STATIONS_JSON;
  if (raw) { try { const a = JSON.parse(raw); if (Array.isArray(a) && a.length) return a; } catch (_) { /* fall through to default */ } }
  return DEFAULT_STATIONS;
}

const FRESHNESS_MAX_MIN = Number(process.env.AWN_FRESHNESS_MAX_MIN || 90); // B7: newest reading older than this => treat offline
const COORD_TOL = 0.02; // ~1.5km: bind a station to a Space by matching stored coords

// How far ahead the NEAR-TERM rain window looks, in hours ("the next few hours: is it going to give us
// another quarter inch?"). 3 is a compromise: long enough that a shower already visible on the hourly grid
// lands inside it, short enough to stay a near-nowcast. Only actionable because the plan regenerates HOURLY
// (OPS-PLANHOURLY-001).
const NEAR_TERM_WINDOW_H = 3;

// DRG-GAUGESANITY-001: upper plausibility bound on the daily accumulator. FRESHNESS_MAX_MIN only establishes
// that the gauge is REPORTING, not that the number was POSSIBLE. A tipping bucket that phantom-tips (spider
// in the funnel, debris, a hail strike) reports an unbounded total, and the engine reads that as real rain,
// which SUPPRESSES watering and outranks both the bagHeatGate and freshTransplant carve-outs. The cost is
// dead plants.
//
// Anchored on the PHYSICAL ceiling for this location, deliberately NOT on recent weather: the Massachusetts
// 24-hour rainfall record is 18.15", so 20" clears it and no locally possible event can be rejected. A fault
// has to read about 9x anything the site has seen to trip it. A tighter, distribution-fitted bound (4-5")
// was rejected: it would throw away a genuine tropical remnant, and discarding real rain during a flood is
// the same wrong watering signal from the other direction.
//
// `Number(...) || 20` rather than the FRESHNESS_MAX_MIN `Number(x || 90)` shape on purpose: a garbage
// override must fall back to the default, not to NaN, because every `> NaN` compares false and would
// silently disable the bound.
const RAIN_MAX_DAILY_IN = Number(process.env.AWN_RAIN_MAX_DAILY_IN) || 20;

// DRG-GAUGENEG-001: the LOWER half of the same plausibility rule. dailyrainin is a since-local-midnight TIP
// COUNTER, so 0 is its floor by construction; a negative is never weather, it is a corrupt sample
// (out-of-range sentinel, sign wrap, unit-conversion bug), and index.js:fetchStation hands the AWN payload
// through with zero value validation.
//
// An over-reading was merely believed; a negative was LAUNDERED: the bucket loop's `Math.max(b ?? 0, v)` seed
// floors every bucket at 0, so a day whose records were ALL negative published a confident 0.00", the same
// fabricated dry day GAUGESANITY closed from the top, and a dry day is the input that RELEASES watering
// suppression. It also hides well: `today_observed_in: 0` is the modal value of that field in prod.
//
// Deliberately NOT env-overridable, unlike RAIN_MAX_DAILY_IN: that bound is a judgement about weather; this
// one is the instrument's physical floor, and an override could only re-open the hole.
const RAIN_MIN_DAILY_IN = 0;

// DRG-WXSTATION-003 / BUG-GAUGEFROZENZERO-001: a FROZEN gauge reads a false zero. The WS-2902 rain gauge is
// a tipping bucket; at or below freezing the funnel ices over and snow sits in it, so `dailyrainin` stays
// at 0.00 while precipitation falls. Neither plausibility bound above can see that (0 is the most ordinary
// value the field has), and a dry day RELEASES watering suppression: the plan asks for watering on a day it
// is snowing.
//
// THE RULE ("Automatic, by temperature"): a civil day on which the station's OWN outdoor thermometer read
// at or below this in ANY record has no trusted gauge total. One reading is enough, in either order (a
// frozen dawn holds the night's precipitation back from a thawed afternoon; an evening freeze stops the
// count while it is still falling). The day's bucket is deleted and each field takes the labelled
// Open-Meteo fallback, exactly as a rejected day does. No switch, no season, no calendar date: the
// thermometer on the same mast is the only input. The one difference from a rejected day is what the
// NEIGHBOURING days keep: a frozen day still counts as a day the station was reporting when the next day's
// completed total is judged (see yesterdayCovered), so it costs its own total and nothing else.
//
// Env-overridable only inside 20..40F; anything else is 32: unset, empty, garbage (NaN, where every
// `<= NaN` compares false and would silently switch the rule off) and any number outside the band.
// Unbounded, 'Infinity' or '212' would freeze every day and '-40' would turn the rule off, which is the
// switch the decision says does not exist.
//
// KNOWN LIMIT, NOT HANDLED: the first thawed day after a freeze can post the earlier snow as melt, so that
// day's total can OVER-read. Left alone because the error only suppresses watering on a day the ground
// really is receiving that water.
const GAUGE_FROZEN_DEFAULT_F = 32, GAUGE_FROZEN_OVERRIDE_MIN_F = 20, GAUGE_FROZEN_OVERRIDE_MAX_F = 40;
const GAUGE_FROZEN_MAX_F = (() => {
  const n = Number(process.env.AWN_GAUGE_FROZEN_MAX_F);
  return n >= GAUGE_FROZEN_OVERRIDE_MIN_F && n <= GAUGE_FROZEN_OVERRIDE_MAX_F ? n : GAUGE_FROZEN_DEFAULT_F;
})();

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// Civil-day label (YYYY-MM-DD) for an epoch-ms instant in a named tz. dailyrainin resets at station-LOCAL
// midnight, so buckets MUST be tz-local, not UTC (V200 B1). History records carry tz:null, so the
// configured station tz is authoritative.
function civilDay(ms, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}
// Civil HOUR (0-23) of an instant in a named tz. h23 so midnight is 0, not 24. Same tz as civilDay, so the
// (day, hour) pair the H5 hourly scope is built from is consistent. Returns null rather than NaN on bad input.
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

// V5-RADIATIVEFROST-001: the OVERNIGHT MINIMUM, which is the corpus's truth column.
//
// `tempF` in deriveStation is `newest.tempf`, the reading at FETCH time. The three daily runs land at 02:00,
// 05:30 and 15:30 ET, so NONE observes the night's actual minimum (shortly after sunrise). That was fine for
// flooring the forecast low in mergeStationWeather and useless for fitting a local bias correction. The
// minimum is derived from the ~3 civil days of 5-minute records the fetch already pulls.
//
// NOTHING CAN BE BACKFILLED: `weather_daily.tmin_f` is Open-Meteo's model value (never station-sourced)
// and the AWN API serves only a rolling ~3-day window, so every unrecorded night is unrecoverable.
//
// Night key = the date the night STARTS on, matching radiativeFrost.nightsFrom, so a night's observed
// minimum and its forecast conditions join on the same key.
const OVERNIGHT_MIN_SAMPLES = Number(process.env.AWN_OVERNIGHT_MIN_SAMPLES || 24);   // 2h of 5-min records

// ── V5-WXSTATIONCOVARIATES-001: the CALM/CLEAR covariates, and why they live inside this loop ──────
// The minimum ALONE cannot answer "does the forecast run warm on CALM, CLEAR frost nights here", because
// nothing recorded whether a night WAS calm or clear. The loop used to read two fields off each record
// (`dateutc`, `tempf`) and drop the other twenty-five, wind among them.
//
// This is the half with a deadline: the forecast side (WeatherNext) is archived and can be rebuilt any
// time, but the AWN API serves a ~3-day rolling window, so a night that ages out takes its wind, dewpoint
// and duration-below-threshold with it permanently. The cost here is arithmetic inside a loop that
// already visits every record.
//
// FIELD NAMES ARE VERIFIED AGAINST A LIVE RECORD, NOT INFERRED:
//   windspeedmph  windgustmph  winddir  maxdailygust  humidity  solarradiation   all lowercase
//   dewPoint                                                                     camelCase, ALONE
// That last one is a trap: every sibling is lowercase, so `dewpoint` or `dewpointf` returns undefined for
// every record forever, and a `Number.isFinite` guard turns that into "this station has no such sensor",
// silent, permanent and indistinguishable from the truth. Do NOT normalize the capitalization.
// `windSamples`/`dewSamples` exist so that if AWN renames a field, the corpus reports a covariate that
// stopped arriving instead of a night that was merely calm.
//
// Counts, not minutes. `samplesBelow` is a raw count: the 5-minute interval is AWN's choice, and baking 5
// into a stored "minutes" figure would misreport every night if they change it. The consumer multiplies by
// the observed interval.
const COVARIATE_THRESHOLDS_F = [40, 38, 33, 32];   // the app's own frost tiers, plus freezing

// Accrue one record's covariates into the night's bucket. Pure, total, and never throws on a missing or
// malformed field: absence is recorded as absence (a sample that does not increment `windSamples`), never
// coerced to zero. 0 mph is a real and important value (a dead-calm night is the radiative case);
// conflating "no anemometer reading" with "no wind" would invent exactly the signal this covariate measures.
function accrueCovariates(b, r, hour) {
  if (b.windSamples === undefined) {
    b.windSamples = 0; b.windMinMph = null; b.windMaxMph = null; b.windSumMph = 0;
    b.dewSamples = 0; b.dewPointMinF = null;
    b.samplesBelow = {}; for (const t of COVARIATE_THRESHOLDS_F) b.samplesBelow[t] = 0;
    b.hourly = {};
  }
  const w = r.windspeedmph;
  if (Number.isFinite(w)) {
    b.windSamples += 1; b.windSumMph += w;
    if (b.windMinMph == null || w < b.windMinMph) b.windMinMph = w;
    if (b.windMaxMph == null || w > b.windMaxMph) b.windMaxMph = w;
  }
  const dp = r.dewPoint;                       // camelCase, see the note above; not a typo
  if (Number.isFinite(dp)) {
    b.dewSamples += 1;
    if (b.dewPointMinF == null || dp < b.dewPointMinF) b.dewPointMinF = dp;
  }
  for (const t of COVARIATE_THRESHOLDS_F) if (r.tempf < t) b.samplesBelow[t] += 1;
  // Per-hour minimum AND the reading nearest the top of the hour. Both, because a later comparison against an
  // hourly forecast can mean either "coldest within the hour" or "the value at the hour mark", and picking
  // one now cannot be undone once the raw 5-minute records age out. About 14 numbers a night.
  const h = b.hourly[hour] || (b.hourly[hour] = { min: null, at: null, atOff: null });
  if (h.min == null || r.tempf < h.min) h.min = r.tempf;
  // Minutes past the hour needs no timezone: every US civil offset is a whole number of hours, so the minute
  // field is identical in UTC and local time.
  const mins = Math.floor(r.dateutc / 60000) % 60;
  if (h.atOff == null || mins < h.atOff) { h.atOff = mins; h.at = r.tempf; }
}

function overnightMins(recs, tz) {
  const out = {};
  if (!Array.isArray(recs) || !tz) return out;
  for (const r of recs) {
    if (!r || !Number.isFinite(r.dateutc) || !Number.isFinite(r.tempf)) continue;
    const day = civilDay(r.dateutc, tz);
    const hour = civilHour(r.dateutc, tz);
    if (hour == null) continue;
    let key = null;
    if (hour >= 18) key = day;
    else if (hour <= 8) key = dayBefore(day);
    if (!key) continue;
    const b = out[key] || (out[key] = { minF: null, samples: 0, endHour: null });
    b.samples += 1;
    if (b.minF == null || r.tempf < b.minF) b.minF = r.tempf;
    // Covariates are computed defensively and SEPARATELY from the minimum. A throw here must never cost the
    // night its temperature, and because `deriveStation` is called bare at handler.js (unlike the guarded
    // `fetchStation`), a throw anywhere in this function ends the whole invocation: no daily_plan row for any
    // Space and no frost alert. The try/catch is the difference between losing a covariate and losing the
    // nightly plan.
    try { accrueCovariates(b, r, hour); } catch { b.covariateError = true; }
    // The LAST morning hour seen. Tracks only hours <= 8, so it stays null when the night has no morning
    // coverage at all, the honest signal that the minimum may not have been observed yet.
    if (hour <= 8 && (b.endHour == null || hour > b.endHour)) b.endHour = hour;
  }
  // A night observed for a couple of hours is not a minimum. Drop it rather than publish a number that reads
  // like a measurement (same discipline as radiativeFrost's MIN_HOURS gate: absence must not be dressed as data).
  for (const k of Object.keys(out)) {
    if (out[k].samples < OVERNIGHT_MIN_SAMPLES || out[k].minF == null) { delete out[k]; continue; }
    const b = out[k];
    b.minF = Math.round(b.minF * 10) / 10;
    // Finalize the covariates. A night whose covariates never initialized keeps its minimum and reports them
    // as absent: it does not lose the night, and does not claim a calm night it never measured.
    if (b.windSamples === undefined) { b.covariatesAvailable = false; continue; }
    b.covariatesAvailable = true;
    b.windMeanMph = b.windSamples ? Math.round((b.windSumMph / b.windSamples) * 10) / 10 : null;
    delete b.windSumMph;
    if (b.dewPointMinF != null) b.dewPointMinF = Math.round(b.dewPointMinF * 10) / 10;
    for (const h of Object.values(b.hourly)) {
      h.min = Math.round(h.min * 10) / 10;
      if (h.at != null) h.at = Math.round(h.at * 10) / 10;
      delete h.atOff;                       // an accumulator, not a measurement
    }
    // Coverage, not just presence. `windSamples` well below `samples` means the anemometer dropped out
    // mid-night, so a mean over the survivors differs from a mean over the night. Reported, never used to
    // silently discard the night.
    b.windCoverage = b.samples ? Math.round((b.windSamples / b.samples) * 100) / 100 : 0;
  }
  return out;
}

// ── V5-STATIONHEALTHYEAR-001: the outdoor ARRAY going quiet while the console stays online ──────────
// `fresh` is decided by the newest record's TIMESTAMP alone, and the indoor console keeps uploading when the
// outdoor array stops transmitting. A dead or battery-starved array therefore reads fresh and binds while
// everything outdoor is gone: `tempf` (the tonightLow floor and the overnight minima) and `dailyrainin`
// (every gauge rain figure). Neither station_unbound nor station_stale can see it.
//
// WHY A WINDOW, NOT THE NEWEST RECORD. Alkaline AAs fail near +10F and the array loses signal at night:
// solar carries it by day, the batteries fail in the coldest dark hours. The alert is checked once a day at
// the afternoon run, when such an array is usually transmitting again, so a newest-record test would miss
// the very failure it exists for. This reads the trailing ARRAY_SILENT_WINDOW_MIN of records the fetch
// already holds (~72 h); 24 h is the spacing of the daily check, so every dropout is examined by exactly
// one check.
//
// A field is silent when its longest run of consecutive records WITHOUT a finite value spans at least
// ARRAY_SILENT_MIN_GAP_MIN, measured first-missing to last-missing record (it under-reads a gap by one
// reporting interval, which errs toward not alerting). An isolated missing sample never counts. Timestamps,
// not record counts (the samplesBelow rule above).
const ARRAY_SILENT_WINDOW_MIN = 24 * 60;
const ARRAY_SILENT_MIN_GAP_MIN = 60;
const ARRAY_FIELDS = ['tempf', 'dailyrainin'];

function arraySilence(recs, { nowMs } = {}) {
  if (!Array.isArray(recs) || !Number.isFinite(nowMs)) return null;
  const since = nowMs - ARRAY_SILENT_WINDOW_MIN * 60000;
  const win = recs.filter((r) => r && Number.isFinite(r.dateutc) && r.dateutc >= since)
    .sort((a, b) => a.dateutc - b.dateutc);
  const last = win[win.length - 1];
  const gaps = {};
  const silent = [];
  for (const f of ARRAY_FIELDS) {
    let missing = 0; let run = null; let longest = null;
    for (const r of win) {
      if (Number.isFinite(r[f])) { run = null; continue; }
      missing += 1;
      if (run) run.toMs = r.dateutc; else run = { fromMs: r.dateutc, toMs: r.dateutc };
      // >= so the LATER of two equal runs is reported (the more recent is more useful to name).
      if (!longest || run.toMs - run.fromMs >= longest.toMs - longest.fromMs) longest = run;
    }
    const longestMin = longest ? Math.round((longest.toMs - longest.fromMs) / 60000) : 0;
    // missingNow reads the NEWEST record, not the longest run: a long gap can have recovered while a new,
    // shorter one is running at the check, and the email must not call the array recovered then.
    gaps[f] = { missing, longestMin, fromMs: longest ? longest.fromMs : null, toMs: longest ? longest.toMs : null,
      missingNow: !!(last && !Number.isFinite(last[f])) };
    if (longestMin >= ARRAY_SILENT_MIN_GAP_MIN) silent.push(f);
  }
  return { windowMin: ARRAY_SILENT_WINDOW_MIN, records: win.length, gaps, silent };
}

// Derive a normalized station reading from the raw AWN history payload {mac, records[]}.
// records: newest-first array of AWN data points (dateutc epoch-ms, dailyrainin accumulator, tempf, ...).
// Returns null when there is no usable data. recentPrecipIn is populated ONLY when the lookback is fully
// covered (warm-up gate, V200 §3) AND the numbers are finite; otherwise null => the caller falls back to
// Open-Meteo + uncertainty. Never coerces an absent field to 0.0 (V200 B7). A day whose accumulator exceeds
// RAIN_MAX_DAILY_IN is dropped outright (DRG-GAUGESANITY-001) and surfaces as implausibleDays[]; a record
// below RAIN_MIN_DAILY_IN is dropped individually (DRG-GAUGENEG-001) and surfaces as negativeDays[], which
// costs the whole day only when nothing plausible is left to bucket.
function deriveStation(raw, { nowMs }) {
  if (!raw || !Array.isArray(raw.records) || !raw.records.length) return null;
  const cfg = stationConfig().find((s) => s.mac === raw.mac) || stationConfig()[0];
  // No configured station (AWN_STATIONS_JSON unset/malformed): fall back to forecast hydrology rather than
  // throwing on cfg.tz. Warn, because this is a config fault, not a normal offline gauge.
  if (!cfg) { console.warn('station: no station config (AWN_STATIONS_JSON unset?) — no gauge bound'); return null; }
  const tz = cfg.tz;
  const recs = raw.records.filter((r) => r && Number.isFinite(r.dateutc)).sort((a, b) => b.dateutc - a.dateutc);
  if (!recs.length) return null;

  const newest = recs[0];
  const dataAgeMin = Math.round((nowMs - newest.dateutc) / 60000);
  const fresh = dataAgeMin <= FRESHNESS_MAX_MIN;
  const tempF = Number.isFinite(newest.tempf) ? newest.tempf : null;
  // V5-RADIATIVEFROST-001: the site-truth column (see the note above OVERNIGHT_MIN_SAMPLES).
  const nightMins = overnightMins(recs, tz);

  // Max dailyrainin per civil day == that day's total (accumulator peak before the midnight reset). Records
  // with a non-finite dailyrainin are skipped (not treated as 0) so a malformed point can't poison a bucket.
  //
  // BUG-GAUGERESETLAG-001: THE RESET IS NOT EXACTLY AT MIDNIGHT, so a plain max over the civil day inherits
  // the PREVIOUS day's total. The WS-2902 accumulator reset at 00:05, so the records from 00:00 to 00:04
  // still read yesterday's finished total and `Math.max` carried it into today's bucket (a plan published
  // `today_observed_in: 0.29` on a day the gauge finished at ZERO). EVERY bucket's first minutes precede
  // that day's own reset; it only shows when a dry day follows a wet one, which is also when it does the
  // most damage: a spurious total RELEASES watering suppression.
  //
  // THE FIX USES THE ACCUMULATOR'S OWN SEMANTICS: dailyrainin is monotonic non-decreasing WITHIN a day and
  // drops only at the reset, so a decrease inside a civil day IS the reset and everything before it belongs
  // to yesterday. Take the max only over records AFTER the last decrease. On a clean day there is no
  // decrease and this is byte-identical to the old behaviour, which is why it is a max-since-reset and not a
  // "last record" (that would also change clean days and give a late-day gap or an out-of-order sample a
  // different answer).
  const byDay = {};
  const negSeen = new Set();
  for (const r of recs) {
    if (!Number.isFinite(r.dailyrainin)) continue;
    const d = civilDay(r.dateutc, tz);
    // DRG-GAUGENEG-001: the lower bound acts per RECORD where the upper one acts per bucket, and the levels
    // are forced. A bucket is a MAX, so `bucket > RAIN_MAX_DAILY_IN` faithfully tests "some record was
    // impossible", but `bucket < RAIN_MIN_DAILY_IN` can never be true (the `?? 0` seed below floors it), so
    // written at bucket level it would be dead code. Per-record is also the right ACTION: an over-reading
    // accumulator is monotonic and stays high to midnight, so the day really is lost, whereas a negative
    // cannot be an accumulator state and is a transient bad sample; drop it and the day keeps its real total.
    if (r.dailyrainin < RAIN_MIN_DAILY_IN) { negSeen.add(d); continue; }
    (byDay[d] ||= []).push([r.dateutc, r.dailyrainin]);
  }
  const buckets = {};
  for (const [d, pts] of Object.entries(byDay)) {
    // Sort ASCENDING by time. `recs` is newest-first, and "the last decrease" is meaningless against an
    // unknown order (backwards, every genuine accumulation would look like a reset).
    pts.sort((a, b) => a[0] - b[0]);
    let from = 0;
    for (let i = 1; i < pts.length; i++) if (pts[i][1] < pts[i - 1][1]) from = i;   // the reset
    let v = 0;
    for (let i = from; i < pts.length; i++) v = Math.max(v, pts[i][1]);
    buckets[d] = v;
  }
  // DRG-GAUGESANITY-001: drop any day whose total is physically impossible (see RAIN_MAX_DAILY_IN). Checking
  // the finished bucket is equivalent to checking each record (a bucket IS the max of its records) and costs
  // one pass. The day is DELETED, never clamped and never zeroed: a clamped total is a fabricated
  // observation, and a zeroed one fabricates "no rain". Deleting routes each affected field down the SAME
  // tested absent-bucket path a stale station takes (the labelled Open-Meteo fallback) instead of a second
  // failure mode.
  const implausibleDays = [];
  for (const d of Object.keys(buckets)) {
    if (buckets[d] > RAIN_MAX_DAILY_IN) { implausibleDays.push(d); delete buckets[d]; }
  }
  // DRG-GAUGENEG-001: a day whose every record was negative leaves no bucket behind, which is REJECTED by the
  // same definition as above: the gauge's total for that day is gone. So it joins implausibleDays and
  // inherits the whole tested rejection path (uncertainty, provenance, the absent-bucket fallback). A day that
  // also had a plausible record keeps its bucket and stays only in negativeDays; those three states are what
  // station_negative_days exists to tell apart. Guarded against listing a day the upper bound already deleted.
  for (const d of negSeen) if (!(d in buckets) && !implausibleDays.includes(d)) implausibleDays.push(d);
  implausibleDays.sort();
  const negativeDays = [...negSeen].sort();
  // DRG-WXSTATION-003: drop every day the station's own thermometer saw at or below freezing (see
  // GAUGE_FROZEN_MAX_F). Its OWN list, not implausibleDays: that list means "the reading was impossible", a
  // fault to chase, where this is a healthy instrument in weather it cannot measure. The ACTION is the same
  // delete, so a frozen day reaches every consumer down the same absent-bucket path. A record with a
  // non-finite tempf says nothing either way: unknown is not frozen.
  // Runs AFTER both plausibility passes on purpose: run first, it would hide an impossible total on a frozen
  // day from implausibleDays, and its delete would make a frozen day with one stray negative sample look
  // negative-ONLY to the `!(d in buckets)` test above. A day can sit in both lists; each stays true alone.
  // Reads only `tempf` and writes only `buckets`: `fresh`, `tempF` and `nightMins` are already final, so the
  // frost floor in mergeStationWeather cannot be weakened from here.
  const frozenSeen = new Set();
  for (const r of recs) {
    if (Number.isFinite(r.tempf) && r.tempf <= GAUGE_FROZEN_MAX_F) frozenSeen.add(civilDay(r.dateutc, tz));
  }
  const frozenDays = [...frozenSeen].sort();
  // Which of them held a plausible rain bucket, taken BEFORE the delete because the delete erases the
  // difference. A frozen day the rain field was absent from all day is not a day the GAUGE was reporting, and
  // yesterdayCovered must not let it vouch for the next day's total. [] with no frozen day.
  const frozenRainDays = frozenDays.filter((d) => d in buckets);
  for (const d of frozenDays) delete buckets[d];

  const D0 = civilDay(nowMs, tz), D1 = dayBefore(D0), D2 = dayBefore(D1);
  const daysPresent = Object.keys(buckets).sort();
  const earliest = daysPresent[0];
  // Full coverage of D-2 requires data starting BEFORE D-2 (so its midnight-to-midnight is captured) and both
  // prior-day buckets present. String compare is valid for YYYY-MM-DD.
  const coversLookback = !!earliest && earliest < D2 && (D1 in buckets) && (D2 in buckets);
  const recentPrecipIn = coversLookback ? round2((buckets[D1] || 0) + (buckets[D2] || 0)) : null;
  // 'implausible' sits ABOVE 'warmup' because a rejected bucket is frequently what BROKE coverage, and
  // calling that a warm-up names the wrong cause. It deliberately does NOT touch `fresh`: the feed is current,
  // one number inside it was not, and forcing fresh=false would strip the temperature floor in
  // mergeStationWeather (a rain-gauge fault must never disarm frost warning). A negative-only day reaches
  // this through implausibleDays; a day that merely HAD a negative sample and survived it does not.
  // 'frozen' sits BELOW 'implausible' (one string; an impossible reading is the fault an operator must act
  // on, while a freeze is expected and listed in full in frozenDays) and ABOVE 'warmup' (a dropped frozen
  // day is what broke the lookback).
  const uncertainty = !fresh ? 'stale'
    : (implausibleDays.length ? 'implausible' : (frozenDays.length ? 'frozen' : (!coversLookback ? 'warmup' : null)));

  // BUG-RAINACTUAL-001 H1: expose the D0 / D-1 buckets. todayPrecipIn needs NO coverage gate: dailyrainin is
  // the STATION's own since-local-midnight accumulator, so one record at 15:00 already carries the day so far
  // (partial by nature; it grows through the day). yesterdayPrecipIn is a COMPLETED day and is gated by the
  // caller (design §3-4) on gaugeWindow's coversYesterday, with a frozen day counted as a day the station was
  // reporting (see yesterdayCovered).
  const todayPrecipIn = Number.isFinite(buckets[D0]) ? round2(buckets[D0]) : null;
  const yesterdayPrecipIn = Number.isFinite(buckets[D1]) ? round2(buckets[D1]) : null;

  // V5-STATIONHEALTHYEAR-001: its own try/catch, like the covariates. It only feeds an ops alert, and a throw
  // must never cost the gauge (the handler degrades a throwing deriveStation to no station at all). null =
  // could not be computed, which the handler reads as "no alert", never as "array healthy".
  let silence = null;
  try { silence = arraySilence(recs, { nowMs }); } catch { silence = null; }

  return { mac: raw.mac, lat: cfg.lat, lng: cfg.lng, tz, fresh, dataAgeMin, tempF, nightMins, recentPrecipIn, coversLookback, buckets, uncertainty,
    day0: D0, day1: D1, day2: D2, hour0: civilHour(nowMs, tz), todayPrecipIn, yesterdayPrecipIn, implausibleDays, negativeDays,
    frozenDays, frozenRainDays, arraySilence: silence };
}

// DRG-WXSTATION-003: the coverage test for YESTERDAY's total, apart from coversLookback's for the two-day
// sum. A frozen day loses ITS OWN total and nothing else. coversLookback asks for three BUCKETS (D-1, D-2 and
// an anchor before D-2), and the frozen pass deletes buckets, so on that gate one frosty dawn F also cost the
// measured figure for F+1 and F+2 and the 02:00 run on F+3, days the gauge counted correctly; with frost
// every second or third night the rain autologger (rainLog.js, gauge-sourced rows only) then wrote no rain
// event for weeks.
//
// What the gate protects is that D-1 is a COMPLETED day, seen from before its midnight to after it: a claim
// about the station REPORTING, not about D-2's rain total being usable. A frozen day that held a rain bucket
// until the frozen pass deleted it (frozenRainDays) was reporting, so it still stands as D-2 or as the
// anchor. A frozen day with temperature records and NO usable rain record does not: the thermometer cannot
// vouch for the rain field. Neither can ever stand as D-1: a frozen yesterday has no total to publish.
//
// A REJECTED day does not get this. An implausible or negative-only day is an instrument fault and what else
// its records can vouch for is unknown, so it stays missing: with no frozen day in the feed this is
// coversLookback's own expression, term for term. A day that is BOTH frozen and rejected is rejected.
// `recent` keeps coversLookback untouched: a two-day sum with either day missing is not a sum.
function yesterdayCovered(st, d1, d2) {
  const b = (st && st.buckets) || {};
  if (!Number.isFinite(b[d1])) return false;
  const rejected = new Set((st && st.implausibleDays) || []);
  const frozen = new Set(((st && st.frozenRainDays) || []).filter((d) => !rejected.has(d)));
  const earliest = [...Object.keys(b), ...frozen].sort()[0];
  return !!earliest && earliest < d2 && (Number.isFinite(b[d2]) || frozen.has(d2));
}

// Gauge totals addressed by CIVIL-DAY LABEL rather than by the fetch instant. deriveStation's D0/D1/D2 are
// anchored to `nowMs`; a replay (rerun-daily-plan.sh --today) is about a DIFFERENT day, and reading "today's"
// bucket would attribute the wrong day's rain. In live runs planDay === st.day0, so every value is identical
// to what deriveStation exposes: a correctness widening for replay, not a behaviour change.
function gaugeWindow(st, planDay) {
  const none = { day: null, observed: null, yesterday: null, recent: null, coversLookback: false, coversYesterday: false };
  if (!st || !st.buckets) return none;
  const d0 = planDay || st.day0;
  if (!d0) return none;
  const d1 = dayBefore(d0), d2 = dayBefore(d1);
  const b = st.buckets;
  const at = (k) => (Number.isFinite(b[k]) ? round2(b[k]) : null);
  const earliest = Object.keys(b).sort()[0];
  const covers = !!earliest && earliest < d2 && Number.isFinite(b[d1]) && Number.isFinite(b[d2]);
  return { day: d0, observed: at(d0), yesterday: at(d1), recent: covers ? round2(b[d1] + b[d2]) : null, coversLookback: covers,
    coversYesterday: yesterdayCovered(st, d1, d2) };
}

// ── H5 (BUG-RAINACTUAL-001, supersedes the H2 whole-day subtraction) ──────────────────────────────
// Sum the HOURLY forecast for the hours of `day` that have NOT YET ELAPSED, i.e. strictly after `hourNow`.
//
// Why this replaces `max(0, wholeDayForecast - observed)`: that made today_precip_in (= observed +
// remaining) UNABLE TO FALL BELOW the whole-day forecast (a 2.22" gauge against a 4.63" forecast landed
// right back on 4.63"), so the gauge could only move the number when it EXCEEDED the forecast, the opposite
// of the failure being fixed. Scoping remaining to the unelapsed hours lets a forecast that busted HIGH in
// the morning decay out of the number as the day passes.
//
// Matching is by DATE-STRING PREFIX on the local ISO timestamps, never by array index. That is safe against
// (a) an hourly array whose first day differs from the daily array's, and (b) DST: spring-forward days carry
// 23 rows and fall-back days 25 (two 01:00 rows, both counted: both are genuinely still ahead). An
// index-based window would slide on either.
//
// Returns null, never 0, whenever the data cannot support an answer, so the caller falls back to the H2
// whole-day behaviour rather than reporting "no more rain coming" and over-watering into an incoming storm.
// `windowH` (OPS-PLANHOURLY-001 sequel) bounds the sum to the NEXT N hours instead of the rest of the day;
// omitted => unbounded, byte-identical to the original. "In the next few hours, is it going to give us
// another quarter inch?" is a question the rest-of-day sum cannot answer at 07:00.
//
// The window deliberately does NOT cross midnight: rows are matched by DATE-STRING PREFIX on `day` (what
// makes this DST-safe), so admitting tomorrow's hours would mean matching two dates and re-deriving the
// boundary, and rain after midnight is not a reason to skip TODAY's watering anyway. Cost: in the 21:00 run
// the window shrinks to 2-3 hours and then nothing, so the near-term branch quietly stops contributing late
// in the evening.
function remainingHourlyIn(hourly, day, hourNow, windowH) {
  if (!hourly || !Array.isArray(hourly.time) || !Array.isArray(hourly.precipitation)) return null;
  if (typeof day !== 'string' || !Number.isFinite(hourNow)) return null;
  const bounded = Number.isFinite(windowH) && windowH > 0;
  const t = hourly.time, p = hourly.precipitation;
  let dayRows = 0, futureRows = 0, finiteRows = 0, sum = 0;
  for (let i = 0; i < t.length; i++) {
    const s = t[i];
    if (typeof s !== 'string' || s.slice(0, 10) !== day) continue;
    dayRows++;
    const h = Number(s.slice(11, 13));
    if (!Number.isFinite(h) || h <= hourNow) continue;
    if (bounded && h > hourNow + windowH) continue;
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
// Replay-aware: a plan day in the past is fully elapsed; a plan day in the future has its whole day ahead.
// Returns null when the station cannot say, which routes the caller to the fallback.
function effectiveHour(st, day) {
  if (!st || !day || !st.day0 || !Number.isFinite(st.hour0)) return null;
  if (day === st.day0) return st.hour0;
  return day < st.day0 ? 23 : -1;
}

// Resolve remaining-for-today from the hourly forecast, or say why it could not be. `why` is carried into
// provenance: a fallback to the whole-day number is allowed but never silent.
function remainingForecast(base, st, day) {
  const hourly = base && base.hourly_precip;
  if (!hourly) return { in: null, why: 'no_hourly' };
  // The hourly timestamps are LOCAL to whatever tz Open-Meteo was asked for. Reading them against a station in
  // a different tz would misalign the day boundary, so refuse rather than guess (the guard for the V200 §3
  // multi-station evolution).
  if (hourly.timezone && st && st.tz && hourly.timezone !== st.tz) return { in: null, why: 'tz_mismatch' };
  const hour = effectiveHour(st, day);
  if (hour == null) return { in: null, why: 'no_hour' };
  const v = remainingHourlyIn(hourly, day, hour);
  if (v == null) return { in: null, why: 'hourly_unusable' };
  // The near-term window rides the SAME hourly array and the SAME resolved hour, so it can never disagree
  // with `remaining` about what time it is. null when the bounded sum is unusable: the caller must not read
  // a missing near-term figure as "no rain coming soon".
  const soon = remainingHourlyIn(hourly, day, hour, NEAR_TERM_WINDOW_H);
  return { in: v, hour, soon, why: null };
}

// Bind a station to a Space by coordinate proximity (coords live in spaces.weather_lat/lng). Exact enough
// for a single yard; returns the station or null. Never falls through to a wrong Space.
function bindStationToSpace(space, station) {
  if (!station) return null;
  const lat = space.weather_lat, lng = space.weather_lng;
  if (lat == null || lng == null) return null;
  if (Math.abs(Number(lat) - station.lat) <= COORD_TOL && Math.abs(Number(lng) - station.lng) <= COORD_TOL) return station;
  return null;
}

// Field-granular merge (V200 B2, widened by BUG-RAINACTUAL-001): the gauge supplies every field that is an
// OBSERVATION (recent D-2+D-1, the already-fallen part of today, yesterday's actual) while Open-Meteo keeps
// the fields a gauge cannot provide (tomorrow_/upcoming_, PoP, the part of today not yet fallen).
// Covered/indoor credit is handled downstream by the engine's rainClass (B5).
// `opts.planDay` is the plan's civil date; omit it and the fetch-day labels are used (see gaugeWindow).
// Returns {merged, prov}. Every substitution is recorded in prov: a silent fallback is the defect this
// change exists to remove.
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

  // ── H2 (design §3-1) as CORRECTED BY H5: split TODAY into what the gauge has already MEASURED and what the
  // forecast still expects. `today_precip_in` keeps its name AND meaning (the day's total), so every
  // downstream consumer (windowPrecip, rainCreditDays, rainCreditDaysTiered, saturationSuppressed,
  // todayQualifies, computeCallout, hydrologyStatus) is untouched; the two new fields are additive.
  //
  // H5: `remaining` is the HOURLY forecast for the hours not yet elapsed (see remainingHourlyIn), NOT the
  // whole-day forecast minus the gauge, which floored today_precip_in at the whole-day forecast and left the
  // original bug intact whenever the forecast busted high. At 02:00 nearly the whole day is ahead so
  // remaining ~= the full forecast (parity with the nightly baseline); by 15:30 only the evening tail is
  // left and the number is essentially the gauge.
  //
  // FALLBACK: no hourly data / wrong tz / day outside the hourly window -> the H2 whole-day subtraction, so
  // the degraded path is never WORSE than what already ships, and is LABELLED in prov.today_remaining_basis.
  // A missing hourly array must never resolve to remaining=0 (it would under-report incoming rain and
  // over-water into a storm); remainingHourlyIn returns null, never 0, for unusable data.
  //
  // Gated on `fresh` ONLY, not coversLookback: a station that came online this morning still reports today's
  // accumulator truthfully (warm-up is about the 2-day LOOKBACK, not about today).
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
      // H2 legacy path. CLAMPED AT ZERO: when the gauge already exceeds the forecast the remainder is 0, never
      // negative; a busted-LOW forecast must never SUBTRACT water that has physically fallen.
      remaining = fToday != null ? Math.max(0, round2(fToday - observed)) : 0;
      prov.today_remaining_basis = 'wholeday';
      prov.today_remaining_fallback = rf.why;
    }
    merged.today_observed_in = observed;
    merged.today_remaining_in = remaining;
    merged.today_precip_in = round2(observed + remaining);
    prov.today_source = remaining > 0 ? 'station+forecast' : 'station';
    // Near-term (next NEAR_TERM_WINDOW_H hours). Spread CONDITIONALLY: an absent key keeps an unaffected run
    // byte-identical against the parity goldens (the house pattern for additive hydrology fields). Only
    // meaningful on the hourly basis; the whole-day fallback has no intra-day resolution to bound.
    if (rf.in != null && rf.soon != null) {
      merged.today_next_in = rf.soon;
      prov.today_next_window_h = NEAR_TERM_WINDOW_H;
    }
  } else {
    prov.today_source = fToday != null ? 'forecast' : 'unavailable';
  }

  // ── H3 (design §3-2): yesterday_precip_actual_in was Open-Meteo's own past_days HINDCAST, so the field built
  // to answer "did we skip on a forecast that busted?" was itself sourced from the forecast (4.63" recorded
  // against 2.22" on the gauge). The station's D-1 bucket is an OBSERVATION and wins. Falling back to the
  // forecast is allowed but ALWAYS LABELLED; an "actual" that is silently a forecast is the defect (see
  // also handler.backfillYesterdayActual, which persists this label with the value).
  // Gated on coverage because D-1 is a COMPLETED day: a partial D-1 must never be published as its total.
  // coversYesterday, not coversLookback: the same test, except that a frozen D-2 or anchor still counts as a
  // day the station was reporting (see yesterdayCovered).
  const fYest = Number.isFinite(base.yesterday_precip_actual_in) ? base.yesterday_precip_actual_in : null;
  if (st && st.fresh && gw.coversYesterday && gw.yesterday != null) {
    merged.yesterday_precip_actual_in = gw.yesterday;
    prov.yesterday_actual_source = 'station';
  } else {
    prov.yesterday_actual_source = fYest != null ? 'forecast' : 'unavailable';
  }

  if (st) { prov.station_age_min = st.dataAgeMin; prov.station_fresh = st.fresh; prov.station_mac = st.mac;
    // DRG-GAUGESANITY-001. Recorded UNCONDITIONALLY, unlike station_uncertainty above (written only on the
    // recent-fallback branch): a rejection confined to D0 leaves recent and yesterday gauge-sourced, so that
    // branch never runs and the drop would be invisible. A discarded reading is never silent.
    if (st.implausibleDays && st.implausibleDays.length) prov.station_rejected_days = st.implausibleDays;
    // DRG-GAUGENEG-001: its OWN key, not folded into station_rejected_days, because the two bounds fail for
    // different physical reasons and the reader must tell which fired: rejected only => over the ceiling;
    // both => the day was lost to negative samples; negative only => bad samples were dropped and the day's
    // published total is still real. Unconditional, like the line above.
    if (st.negativeDays && st.negativeDays.length) prov.station_negative_days = st.negativeDays;
    // DRG-WXSTATION-003: its OWN key again, and unconditional: "gauge frozen" is not "gauge reading
    // impossible", and a freeze confined to D0 leaves recent and yesterday gauge-sourced like any other drop.
    if (st.frozenDays && st.frozenDays.length) prov.station_frozen_days = st.frozenDays;
    // V5-RADIATIVEFROST-001: the observed overnight minima, keyed by the night's START date so they join a
    // forecast night's conditions without either side re-deriving the key. Carried into the stored plan
    // payload (daily_plan.items), the DURABLE store; the observability block goes only to a CloudWatch log
    // subject to retention, and this is the half that cannot be reconstructed afterwards. At most ~3 nights.
    if (st.nightMins && Object.keys(st.nightMins).length) prov.station_overnight_mins = st.nightMins; }
  return { merged, prov };
}

// Station tempf CALIBRATES the forecast low as a conservative floor, never replaces it (V200 B4). A spot
// 02:00 reading is not the overnight minimum, so we only push the low COLDER (min), which cannot mask a
// freeze; the pre-emptive forecast trigger stays intact. Inert in summer (station warmer than the low).
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

module.exports = { stationConfig, deriveStation, overnightMins, OVERNIGHT_MIN_SAMPLES, arraySilence, ARRAY_SILENT_WINDOW_MIN, ARRAY_SILENT_MIN_GAP_MIN, ARRAY_FIELDS, gaugeWindow, yesterdayCovered, bindStationToSpace, mergeStationHydrology, mergeStationWeather, civilDay, civilHour, dayBefore, remainingHourlyIn, effectiveHour, FRESHNESS_MAX_MIN, RAIN_MAX_DAILY_IN, RAIN_MIN_DAILY_IN, GAUGE_FROZEN_MAX_F, COORD_TOL, NEAR_TERM_WINDOW_H };
