'use strict';
// V4-FROST-001 slice F1 — pure frost/heat trigger evaluation. HTTP-free, deterministic, unit-testable
// (house pattern: lambda/daily-plan/station.js). The real I/O — the `temperature_2m_min` param on
// index.js:fetchPrecip, index.js:fetchNWS, and the SNS publish — lives in index.js and is NOT here.
// Design ref: frost-alert-design-V100-20260803.md §3-3 (trigger criteria), §3-5 (dedup key), §3-7 (fail loud),
// §3-8 (observability), as amended by decisions D2/D5/D6.
//
// D6 (Dave, 2026-08-04): trip points are PER CROP TYPE (frostClass.js bands), but delivery is ONE COALESCED
// alert per frost event naming the crop types that each tripped THEIR OWN threshold — never one message per
// crop. The global single-threshold path below is retained as the fallback for callers with no crop
// breakdown (and as the shape every D2 boundary test is written against).
//
// D2 (approved): advisory <=40°F, imminent <=38°F, hard-freeze copy <=33°F. Every trip point remains a NAMED
// constant, overridable per-call via `thresholds` and per-deploy via env, exactly as prepared. Under D6 these
// three env names retarget the TENDER band in frostClass.js as well, so the two modules cannot drift.

// Env override lets F5's forced-trigger rehearsal raise/lower a trip point on a deployed Lambda without a
// code change (design §5 F5: "a prod dry-run with the threshold temporarily raised to a value today's
// forecast exceeds"). For the per-crop bands the equivalent lever is FROST_THRESHOLD_OFFSET_F (frostClass).
const { radiativeTrips, nightFor, mostPermissiveNight, prevDate } = require('./radiativeFrost');

const numEnv = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
};

const DEFAULT_THRESHOLDS = {
  // Tier 1 ADVISORY — fires on the 3-day forecast minimum. D2 approved: 40°F.
  ADVISORY_LOW_F: numEnv('FROST_ADVISORY_LOW_F', 40),
  // Tier 2 IMMINENT — fires on tonight's (station-adjusted) low. D2 approved: 38°F.
  // The load-bearing number: it trades false positives for radiational-frost margin.
  IMMINENT_LOW_F: numEnv('FROST_IMMINENT_LOW_F', 38),
  // Tier 2 escalation — copy split only, same tier. D2 approved: 33°F.
  HARD_FREEZE_LOW_F: numEnv('FROST_HARD_FREEZE_LOW_F', 33),
  // Heat, Tier-2-equivalent, same channel + same dedup. §3-3 proposal: 95°F.
  // D5: heat is OUT for 2026 — evaluation is present, tested, and OFF by default.
  HEAT_HIGH_F: numEnv('FROST_HEAT_HIGH_F', 95),
  // Advisory lookahead horizon in days (D1..D3 of the Open-Meteo window, §3-3 / G5).
  ADVISORY_HORIZON_DAYS: numEnv('FROST_ADVISORY_HORIZON_DAYS', 3),
};

// D5: frost ships alone in 2026. Heat evaluation is present, tested, and OFF by default.
const HEAT_ENABLED = String(process.env.FROST_HEAT_ENABLED || 'false') === 'true';

// D6 message shaping. The alert names CROP TYPES, not plantings — 183 at-risk plantings collapse to ~10
// names. These caps are the backstop against an SMS that runs past the 1600-char SNS limit anyway.
const MAX_NAMED_CROPS = numEnv('FROST_MAX_NAMED_CROPS', 6);
const MAX_MESSAGE_CHARS = numEnv('FROST_MAX_MESSAGE_CHARS', 900);

// §3-7 frost season — the window in which SILENCE is itself an alertable condition.
const FROST_SEASON_START_MMDD = process.env.FROST_SEASON_START_MMDD || '09-01';
const FROST_SEASON_END_MMDD = process.env.FROST_SEASON_END_MMDD || '11-15';

// Resolve the effective threshold set. Caller overrides win over env, env wins over the D2 default.
// Unknown keys are rejected loudly rather than silently ignored — a typo'd override that silently kept
// the default is exactly the failure this feature cannot afford (§3-7 fails loud).
function resolveThresholds(overrides) {
  const t = { ...DEFAULT_THRESHOLDS };
  if (overrides) {
    for (const [k, v] of Object.entries(overrides)) {
      if (!(k in DEFAULT_THRESHOLDS)) throw new Error(`frostEval: unknown threshold "${k}"`);
      if (v != null) {
        if (!Number.isFinite(Number(v))) throw new Error(`frostEval: non-numeric threshold ${k}=${v}`);
        t[k] = Number(v);
      }
    }
  }
  return t;
}

const finite = (n) => (n != null && Number.isFinite(Number(n)) ? Number(n) : null);

// ── Tier 1 — ADVISORY (planning lead time, §3-3) ──────────────────────────────────────────────────
// Input `forecastLows` is the Open-Meteo daily `temperature_2m_min` slice for D1..D3 (G5 — the parameter
// F1 adds to the fetchPrecip call that is already being made). Entries may be null/absent: Open-Meteo
// omits values rather than zeroing them, and 0 is a legitimate temperature, so absence must NEVER be
// read as 0°F (same rule as index.js:yesterday_precip_actual_in).
// `forecastDates` is the parallel YYYY-MM-DD label array; used only for the message, never for the trigger.
function evalAdvisory(forecastLows, forecastDates, T) {
  const horizon = Math.max(0, Math.trunc(T.ADVISORY_HORIZON_DAYS));
  const raw = Array.isArray(forecastLows) ? forecastLows.slice(0, horizon) : [];
  const usable = [];
  for (let i = 0; i < raw.length; i++) {
    const v = finite(raw[i]);
    if (v != null) usable.push({ lowF: v, dayOffset: i + 1, date: (forecastDates && forecastDates[i]) || null });
  }
  if (!usable.length) return { fires: false, reason: 'no_forecast_lows', minLowF: null, coveredDays: 0, horizonDays: horizon };
  // Coldest night in the window; earliest day wins a tie so the message states the soonest risk.
  let pick = usable[0];
  for (const u of usable) if (u.lowF < pick.lowF) pick = u;
  return {
    fires: pick.lowF <= T.ADVISORY_LOW_F,
    reason: pick.lowF <= T.ADVISORY_LOW_F ? 'advisory_threshold' : 'above_threshold',
    minLowF: pick.lowF,
    dayOffset: pick.dayOffset,
    date: pick.date,
    coveredDays: usable.length,
    horizonDays: horizon,
    // Partial coverage is surfaced, not hidden: a 1-of-3-day window can miss a colder D3.
    partial: usable.length < horizon,
  };
}

// ── BUG-FROSTADVISORYNIGHTWORDING-001 — WHICH NIGHT the advisory is about ────────────────────────────
// `dayOffset`/`date` name a CIVIL DAY and `minLowF` is that day's minimum. A civil day holds the END of one
// night and the START of the next, and here the minimum usually lands at the end of the earlier one: 295 of
// 380 autumn days (77.6%) bottom out before noon, and 79 of the 101 days whose minimum was <= 40F (78.2%)
// (ERA5 at this Space's coordinates, Sep 1 - Nov 15 2021-2025, re-measured 2026-09-18). So D1's minimum is
// usually TONIGHT's, and wording the night from dayOffset ("tomorrow night" for D1) put most advisories one
// night late: the reader was told he had a day he did not have. The radiative trigger has to know the same
// fact: whose SKY to judge (radiativeAdvisoryPairing, BUG-RADIATIVEPAIRINGNIGHT-001).
//
// The hourly series locates it: the hour of that day's minimum before noon -> the night that ENDED that
// morning (it started the evening before); noon or later -> the night that STARTS that evening. The earliest
// hour wins a tie. `nightOffset` counts nights from the plan date, 0 = tonight; `nightDate` is the date the
// night STARTS on, the key radiativeFrost.nightsFrom uses.
//
// The hourly figure must VOUCH for the printed one: some hour of that date must hold the advisory's own
// minimum (Open-Meteo aggregates the daily value from the same hours: equal on 380/380 archive days and
// 6/6 live forecast days, measured 2026-09-18). Anything
// else — no series, no hours for the date, a series whose minimum is not the printed figure — takes the base
// rate, the night that ended that morning. That fallback errs EARLY, the safe direction for frost: a night
// early costs a cover put out one night too soon, a night late costs the plant.
const NIGHT_SPLIT_HOUR = 12;
const NIGHT_MATCH_TOLERANCE_F = 0.05;
const STAMP_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):/;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

// The base-rate night: the one that ended on the minimum's morning. Also the answer for an advisory record
// that predates this change or was built without an hourly series.
function baseNight(a) {
  const d = a && Number.isInteger(a.dayOffset) && a.dayOffset >= 1 ? a.dayOffset : null;
  if (d == null) return null;
  const date = a && typeof a.date === 'string' && YMD_RE.test(a.date) ? a.date : null;
  return { nightOffset: d - 1, nightDate: date ? prevDate(date) : null };
}

function locateNight(a, hourly) {
  const base = baseNight(a);
  if (!base) return { nightOffset: null, nightDate: null, nightBasis: null };
  const fallback = { ...base, nightBasis: 'base_rate' };
  const low = finite(a.minLowF);
  const date = typeof a.date === 'string' && YMD_RE.test(a.date) ? a.date : null;
  const t = hourly && Array.isArray(hourly.time) ? hourly.time : null;
  const v = hourly && Array.isArray(hourly.temperature_2m) ? hourly.temperature_2m : null;
  if (low == null || !date || !t || !v || t.length !== v.length) return fallback;
  let minV = null; let minHour = null;
  for (let i = 0; i < t.length; i++) {
    const m = typeof t[i] === 'string' ? STAMP_RE.exec(t[i]) : null;
    if (!m || m[1] !== date) continue;
    const x = finite(v[i]);
    if (x == null) continue;
    if (minV == null || x < minV) { minV = x; minHour = Number(m[2]); }
  }
  if (minV == null || Math.abs(minV - low) > NIGHT_MATCH_TOLERANCE_F) return fallback;
  return minHour < NIGHT_SPLIT_HOUR
    ? { nightOffset: a.dayOffset - 1, nightDate: prevDate(date), nightBasis: 'hourly', minHour }
    : { nightOffset: a.dayOffset, nightDate: date, nightBasis: 'hourly', minHour };
}

// The night a record names: its own when it carries one, else the base rate.
function advisoryNight(a) {
  if (a && Number.isInteger(a.nightOffset) && a.nightOffset >= 0) {
    return { nightOffset: a.nightOffset, nightDate: typeof a.nightDate === 'string' && YMD_RE.test(a.nightDate) ? a.nightDate : null };
  }
  return baseNight(a);
}

// Weekday of a YYYY-MM-DD label, read in UTC from a UTC anchor so neither the Lambda's zone nor DST can move
// it (a local read of the same instant is the PREVIOUS day anywhere west of UTC). The label is the only input.
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function weekdayOf(ymd) {
  if (typeof ymd !== 'string' || !YMD_RE.test(ymd)) return null;
  const [y, m, d] = ymd.split('-').map(Number);
  const at = new Date(Date.UTC(y, m - 1, d));
  if (at.getUTCFullYear() !== y || at.getUTCMonth() !== m - 1 || at.getUTCDate() !== d) return null;
  return WEEKDAYS[at.getUTCDay()];
}

// "tonight" / "tomorrow night" / "Sunday night". src/lib/frostAlertLine.js words the Today line with the same
// rule from the same persisted fields; advisorynight.test.js holds the two to each other.
function nightPhrase(night) {
  if (!night || !Number.isInteger(night.nightOffset) || night.nightOffset < 0) return null;
  if (night.nightOffset === 0) return 'tonight';
  if (night.nightOffset === 1) return 'tomorrow night';
  const wd = weekdayOf(night.nightDate);
  return wd ? `${wd} night` : `in ${night.nightOffset} days`;
}

const advisoryWhen = (a) => nightPhrase(advisoryNight(a)) || `in ${a && a.dayOffset} days`;

// ── BUG-RADIATIVEPAIRINGNIGHT-001 — WHOSE SKY the radiative advisory trigger judges ──────────────────────────
// The radiative test asks whether the night that makes the pick's minimum is clear and calm enough to fall below
// its forecast. It used to judge the night keyed D-1 (the one that ENDED on D's morning) whatever hour the
// minimum fell: right for a morning minimum, the wrong night's sky for an evening one (~22% of days here), where
// it could miss the minimum's own clear night or fire on the previous night's. Now:
//   'hourly'    the series located the minimum (locateNight): judge THAT night, and only that night. When the
//               forecast window holds too few of its hours (a D3 evening minimum needs night D3, which runs
//               past the last forecast day), there is no sky to judge and, as everywhere in radiativeFrost.js,
//               absence is no signal — never another night's. The next day's run sees it as night D2.
//   'base_rate' the series could not vouch (no block, misaligned, no hours for the date): the night is one of
//               two, the one keyed D-1 or the one keyed D. Judge BOTH and trip if either would
//               (mostPermissiveNight). Either single guess can miss when the minimum belongs to the other
//               night; the union can only add a false alarm, and it is a superset of the old D-1 pairing, so a
//               missing hourly block can never cost an alert this trigger used to send.
// `nightOffset` is the judged night counted from the plan date (as advisoryNight counts), so the radiative-only
// copy can name the night whose sky it quotes. No valid pick date -> nothing to pair (and nothing to throw on:
// the old `prevDate(advisory.date)` threw on the no-lows record whenever radiative was on).
function radiativeAdvisoryPairing(nights, a) {
  const date = a && typeof a.date === 'string' && YMD_RE.test(a.date) ? a.date : null;
  const day = a && Number.isInteger(a.dayOffset) && a.dayOffset >= 1 ? a.dayOffset : null;
  if (!date || day == null) return { night: null, nightDate: null, nightOffset: null, basis: null };
  const located = a.nightBasis === 'hourly' && typeof a.nightDate === 'string' && YMD_RE.test(a.nightDate);
  const night = located ? nightFor(nights, a.nightDate)
    : mostPermissiveNight([nightFor(nights, prevDate(date)), nightFor(nights, date)]);
  return {
    night,
    nightDate: night ? night.date : null,
    nightOffset: night ? (night.date === date ? day : day - 1) : null,
    basis: located ? 'hourly' : 'base_rate',
  };
}

// ── Tier 2 — IMMINENT (tonight, actionable, §3-3) ─────────────────────────────────────────────────
// `tonightLow` MUST be the station-adjusted low from station.js:mergeStationWeather, and this MUST be
// evaluated in the 15:30 ET intraday-pm run only — per G3 `tonightLow` means three different nights
// depending on which of the three daily runs reads it. `lowSource` ('forecast' | 'station_floor' |
// 'forecast_absent') is carried through for §3-8 observability; per G4 the station floor is expected to
// be inert at 15:30, which is exactly why the IMMINENT_LOW_F margin — not the station — carries the risk.
// Escalation is a COPY SPLIT inside one tier (§3-3): both levels are `imminent`, and §3-5 explicitly
// permits a PROTECT -> HARD_FREEZE re-send on the same night because the action materially changes.
function evalImminent(tonightLow, T) {
  const low = finite(tonightLow);
  if (low == null) return { fires: false, reason: 'no_tonight_low', lowF: null, level: null };
  if (low <= T.HARD_FREEZE_LOW_F) return { fires: true, reason: 'hard_freeze_threshold', lowF: low, level: 'hard_freeze' };
  if (low <= T.IMMINENT_LOW_F) return { fires: true, reason: 'imminent_threshold', lowF: low, level: 'protect' };
  return { fires: false, reason: 'above_threshold', lowF: low, level: null };
}

// ── D6 — per-crop-type evaluation, ONE coalesced result ───────────────────────────────────────────
// `byCropType` is frostClass.summarize().byCropType: each entry carries its OWN {ADVISORY_LOW_F,
// IMMINENT_LOW_F, HARD_FREEZE_LOW_F} from its band. A crop trips only against its own numbers, and every
// crop that trips on the same night joins ONE alert — that is the whole of D6.
// `fallbackT` covers a crop entry whose thresholds are missing (should not happen; a hardy entry carries
// null thresholds and is simply never tripped).
// `thresholds: null` is the hardy sentinel and must survive as null; an ABSENT key is a caller that simply
// did not supply per-crop numbers and gets the global set.
const cropThresholds = (c, fallbackT) => ('thresholds' in c ? c.thresholds : fallbackT);

function evalImminentCrops(tonightLow, byCropType, fallbackT, radiativeNight) {
  const low = finite(tonightLow);
  const rows = Array.isArray(byCropType) ? byCropType : [];
  if (low == null) return { fires: false, reason: 'no_tonight_low', lowF: null, level: null, tripped: [], untripped: [] };
  const tripped = []; const untripped = [];
  for (const c of rows) {
    if (!c) continue;
    // An EXPLICIT null thresholds means hardy: never alerted (§3-4), however cold it gets. Only a MISSING
    // key falls back to the global set — conflating the two would let a hardy crop trip on the D2 numbers.
    const t = cropThresholds(c, fallbackT);
    if (!t) { untripped.push({ ...c, level: null }); continue; }
    if (low <= t.HARD_FREEZE_LOW_F) tripped.push({ ...c, level: 'hard_freeze' });
    else if (low <= t.IMMINENT_LOW_F) tripped.push({ ...c, level: 'protect' });
    // V5-RADIATIVEFROST-001. Deliberately the LAST branch and deliberately INSIDE this loop.
    //
    // Inside, because the two guards above it are the ones that must not be bypassed: the hardy
    // `continue` (a hardy crop is never alerted, radiative or not) and the per-crop threshold `t`
    // (a radiative trip is judged against the crop's OWN trip point, not the global one). A separate
    // pass over `rows` would have to re-implement both, and the failure mode of getting it wrong is
    // paging Dave about a bed of kale.
    //
    // Last, and at 'protect' ONLY, because the level feeds `siteLevel` -> the alert HEADLINE. The
    // rejected alternative was to lower the input `low` until it tripped: that crosses
    // fallbackT.HARD_FREEZE_LOW_F on a 39F night and rewrites the headline to "HARD FREEZE TONIGHT —
    // Harvest what you want to keep; cover will not save", i.e. it instructs an IRREVERSIBLE action on
    // a night that was never forecast below 38F. Count-monotone, severity-catastrophic. `low` stays the
    // true forecast value everywhere in this function for exactly that reason.
    else if (radiativeTrips(radiativeNight, low, t.IMMINENT_LOW_F)) {
      tripped.push({ ...c, level: 'protect', trip: 'radiative' });
    } else untripped.push({ ...c, level: null });
  }
  if (!tripped.length) {
    return { fires: false, reason: rows.length ? 'above_all_crop_thresholds' : 'no_crops_at_risk', lowF: low, level: null, siteLevel: null, cropLevel: null, tripped, untripped };
  }
  // Two levels, deliberately distinct:
  //   siteLevel — the D2 site-wide copy decision (hard-freeze copy at <=33°F). Drives the HEADLINE and the
  //               §3-5 dedup level, so a PROTECT -> HARD FREEZE escalation still re-sends exactly as designed.
  //   cropLevel — the most severe PER-CROP verdict present. Recorded for §3-8; it decides which crops land in
  //               the "harvest now" clause, not what the headline says.
  const siteLevel = (fallbackT && low <= fallbackT.HARD_FREEZE_LOW_F) ? 'hard_freeze' : 'protect';
  const cropLevel = tripped.some((c) => c.level === 'hard_freeze') ? 'hard_freeze' : 'protect';
  // `low` is untouched, so siteLevel cannot be escalated by a radiative trip: a radiative trip only
  // happens when low > IMMINENT_LOW_F, and IMMINENT_LOW_F (38) > HARD_FREEZE_LOW_F (33). Guarded by
  // test rather than left to that reading.
  const radiativeOnly = tripped.every((c) => c.trip === 'radiative');
  return {
    fires: true,
    reason: radiativeOnly ? 'radiative_threshold' : 'crop_threshold',
    lowF: low, level: siteLevel, siteLevel, cropLevel, tripped, untripped,
    radiativeOnly, radiativeNight: radiativeNight || null,
  };
}

function evalAdvisoryCrops(minLowF, byCropType, fallbackT, radiativeNight) {
  const low = finite(minLowF);
  const rows = Array.isArray(byCropType) ? byCropType : [];
  if (low == null) return { fires: false, tripped: [], untripped: [] };
  const tripped = []; const untripped = [];
  for (const c of rows) {
    if (!c) continue;
    const t = cropThresholds(c, fallbackT);   // explicit null = hardy = never advised (§3-4)
    if (t && low <= t.ADVISORY_LOW_F) tripped.push({ ...c, level: 'advisory' });
    // V5-RADIATIVEFROST-001 — same discipline as the imminent path: inside the loop so the hardy
    // sentinel and the per-crop trip point both still apply, and at the tier's own level only.
    else if (t && radiativeTrips(radiativeNight, low, t.ADVISORY_LOW_F)) {
      tripped.push({ ...c, level: 'advisory', trip: 'radiative' });
    } else untripped.push({ ...c, level: null });
  }
  return { fires: tripped.length > 0, tripped, untripped };
}

// ── Heat (Tier-2-equivalent, same channel + dedup, §3-3) ──────────────────────────────────────────
function evalHeat(highToday, T, enabled) {
  if (!enabled) return { fires: false, reason: 'heat_disabled', highF: finite(highToday), level: null };
  const high = finite(highToday);
  if (high == null) return { fires: false, reason: 'no_high_today', highF: null, level: null };
  if (high >= T.HEAT_HIGH_F) return { fires: true, reason: 'heat_threshold', highF: high, level: 'heat' };
  return { fires: false, reason: 'below_threshold', highF: high, level: null };
}

// ── Message copy (§3-3, coalesced per D6) ─────────────────────────────────────────────────────────
// `exposure` comes from frostClass.summarize(). unknown is stated SEPARATELY (§3-4) so a mapping gap reads
// as a mapping gap rather than silently shrinking the alert. Containers are named first (§3-4).
function exposurePhrase(exposure) {
  if (!exposure) return '';
  const parts = [];
  const tender = Number(exposure.tender || 0);
  const unknown = Number(exposure.unknown || 0);
  const containers = Number(exposure.tenderContainers || 0);
  parts.push(`~${tender} tender planting${tender === 1 ? '' : 's'}`);
  if (containers > 0) parts.push(`${containers} in containers`);
  if (unknown > 0) parts.push(`${unknown} unclassified (treated as tender)`);
  return parts.join(', ') + '.';
}

// The synthetic 'unclassified' bucket (slug === null) is never NAMED in a crop list — §3-4 requires the
// unknown count be stated SEPARATELY, and the totals line carries it. It still counts toward the totals.
const namedCrops = (crops) => (Array.isArray(crops) ? crops : []).filter((c) => c && c.slug);

// "peppers (58), tomatoes (44), basil (7) +3 more" — crop TYPES, capped. The cap is what keeps a
// 183-planting night inside one SMS; the "+N more" clause makes the truncation visible rather than silent.
function cropListPhrase(crops, max = MAX_NAMED_CROPS) {
  const rows = namedCrops(crops);
  if (!rows.length) return '';
  const cap = Math.max(1, Math.trunc(max));
  const named = rows.slice(0, cap).map((c) => `${c.label} (${c.count})`);
  const rest = rows.length - cap;
  return named.join(', ') + (rest > 0 ? ` +${rest} more` : '');
}

// Totals line: what the named list does NOT convey — how many plantings, how many are pots you can move.
function totalsPhrase(crops, exposure) {
  const rows = (Array.isArray(crops) ? crops : []).filter(Boolean);
  const n = rows.reduce((a, c) => a + Number(c.count || 0), 0);
  const pots = rows.reduce((a, c) => a + Number(c.containers || 0), 0);
  const parts = [`${n} planting${n === 1 ? '' : 's'}`];
  if (pots > 0) parts.push(`${pots} in containers`);
  const unknown = Number((exposure && exposure.unknown) || 0);
  if (unknown > 0) parts.push(`${unknown} unclassified (treated as tender)`);
  return parts.join(', ') + '.';
}

function truncate(msg, max = MAX_MESSAGE_CHARS) {
  const cap = Math.max(40, Math.trunc(max));
  return msg.length <= cap ? msg : `${msg.slice(0, cap - 1).trimEnd()}…`;
}

// Every crop the message names tripped on radiative grounds alone.
const radiativeOnlyNamed = (cropResult) => !!(cropResult && Array.isArray(cropResult.tripped)
  && cropResult.tripped.length && cropResult.tripped.every((c) => c && c.trip === 'radiative'));

function advisoryMessage(a, exposure, cropResult, radiativeNight) {
  // BUG-FROSTADVISORYNIGHTWORDING-001 — the night comes from the record (located by frostEval, else the
  // base rate); dayOffset alone named most nights one day late.
  const when = advisoryWhen(a);
  const on = a.date ? `, ${a.date}` : '';
  // V5-RADIATIVEFROST-001 — same rule as imminentMessage: when the ONLY reason this fired is the
  // radiative signal, the forecast low printed here sits ABOVE the trip point and needs its reason
  // stated, or the reader is left to wonder why 42°F produced an advisory.
  // V5-RADIATIVESUBJECTCOPY-001 — and it is a WATCH, the name the imminent tier already gives the same case: a
  // low above the trip point under "FROST ADVISORY" reads as a forecast crossing that did not happen. Copy only:
  // tier, level and dedup key stay 'advisory'. The email subject says the same (handler.frostSubject).
  const radOnly = radiativeOnlyNamed(cropResult);
  const head = radOnly
    ? `FROST WATCH — ${when} looks clear and calm (low ${a.lowF ?? a.minLowF}°F${on}` +
      `${radiativeNight && radiativeNight.minDewpointF != null ? `, dewpoint ${radiativeNight.minDewpointF}°F` : ''}), ` +
      'so it can fall further than the forecast.'
    : `FROST ADVISORY — frost possible ${when} (low ${a.lowF ?? a.minLowF}°F${on}).`;
  // V5-TODAYFROSTLINEGAPS-001 (Dave 2026-09-21) — an advisory about TONIGHT says what to do tonight, as the watch's
  // same-night clause does; "Harvest ahead and stage row cover" is lead time for a night still to come. The night is
  // the one the head names (advisoryNight, the predicate the imminent branch's `sameNight` uses), both heads alike.
  const night = advisoryNight(a);
  const close = night && night.nightOffset === 0 ? 'Pick what\'s ripe and cover tender plants tonight.' : 'Harvest ahead and stage row cover.';
  if (cropResult && cropResult.tripped && cropResult.tripped.length) {
    return truncate(`${head} At risk: ${cropListPhrase(cropResult.tripped)}. ${totalsPhrase(cropResult.tripped, exposure)} ` +
      close);
  }
  return `${head} ${exposurePhrase(exposure)} ${close}`;
}

function imminentMessage(im, exposure) {
  // V5-RADIATIVEFROST-001. When EVERY tripped crop tripped on radiative grounds, the threshold copy
  // would be actively misleading: it prints `im.lowF`, so it would read "FROST PROTECT TONIGHT — low
  // 39.8F" on a night whose trip point is 38F, i.e. it states a number that does not explain itself.
  // This alert has a different reason and says so, naming the dewpoint as the floor it could reach.
  if (im && im.radiativeOnly && Array.isArray(im.tripped) && im.tripped.length) {
    const n = im.radiativeNight || {};
    const dew = n.minDewpointF != null ? `${n.minDewpointF}°F` : 'below the trip point';
    const sky = [n.meanCloudPct != null ? `${Math.round(n.meanCloudPct)}% cloud` : null,
      n.meanWindMph != null ? `wind ${n.meanWindMph} mph` : null].filter(Boolean).join(', ');
    return truncate(`FROST WATCH TONIGHT — forecast low ${im.lowF}°F, but clear and calm` +
      `${sky ? ` (${sky})` : ''} and the dewpoint is ${dew}, so it can fall further than the forecast. ` +
      `Cover, or bring containers in: ${cropListPhrase(im.tripped)}. ${totalsPhrase(im.tripped, exposure)}`);
  }
  // D6 coalesced path — one message, every tripped crop type named, each having tripped its own threshold.
  if (im && Array.isArray(im.tripped) && im.tripped.length) {
    const hard = im.tripped.filter((c) => c.level === 'hard_freeze');
    const protect = im.tripped.filter((c) => c.level === 'protect');
    const totals = totalsPhrase(im.tripped, exposure);   // ALWAYS over every tripped crop, not one branch
    // HEADLINE severity is the SITE-level D2 call (hard-freeze copy at <=33°F), not "any crop past its own
    // hard-freeze point". Without this, a 38°F night reads "HARD FREEZE TONIGHT" because two potted
    // tropicals (band hard-freeze 40°F) tripped, while 161 plantings sat in the also-cover clause — the
    // headline would contradict its own body. Per-crop still decides WHICH crops get which instruction.
    if (im.siteLevel === 'hard_freeze') {
      const also = protect.length ? ` Also cover: ${cropListPhrase(protect)}.` : '';
      return truncate(`FROST — HARD FREEZE TONIGHT, low ${im.lowF}°F. Harvest what you want to keep; cover will not ` +
        `save: ${cropListPhrase(hard.length ? hard : im.tripped)}.${also} ${totals}`);
    }
    const tooCold = hard.length ? ` Too cold to save, harvest now: ${cropListPhrase(hard)}.` : '';
    return truncate(`FROST PROTECT TONIGHT — low ${im.lowF}°F. Cover, or bring containers in: ` +
      `${cropListPhrase(protect.length ? protect : im.tripped)}.${tooCold} ${totals}`);
  }
  // Legacy single-threshold path (no crop breakdown supplied).
  if (im.level === 'hard_freeze') {
    return `HARD FREEZE TONIGHT — low ${im.lowF}°F. ${exposurePhrase(exposure)} ` +
      'Harvest what you want to keep; cover will not save fruiting tender crops.';
  }
  return `FROST PROTECT TONIGHT — low ${im.lowF}°F. ${exposurePhrase(exposure)} ` +
    'Cover, or bring containers in.';
}

function heatMessage(h, exposure) {
  return `HEAT — high ${h.highF}°F today. ${exposurePhrase(exposure)} Deep-water early; shade wilting containers.`;
}

// ── §3-5 dedup key — pure key construction only; the STORE (alerts_sent[] on the daily-plan payload) is F3.
// Key is (space_id, event_date, tier); the escalation level is appended so a PROTECT -> HARD_FREEZE
// upgrade on the same night is a DIFFERENT key and is therefore allowed to re-send (§3-5).
// D6 adds a digest of the TRIPPED CROP SET for the same reason the level is there: if a re-evaluation names
// a materially different set of crops, the action materially changed and the operator needs the new list.
// Omitted when there is no crop breakdown, so the pre-D6 key shape is unchanged.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}
function cropDigest(tripped) {
  const rows = (Array.isArray(tripped) ? tripped : []).filter(Boolean);
  if (!rows.length) return null;
  return fnv1a(rows.map((c) => `${c.slug || c.label}:${c.level}`).sort().join(','));
}
function dedupKey({ spaceId, eventDate, tier, level, crops }) {
  const base = [spaceId, eventDate, tier, level || 'none'];
  const d = crops ? cropDigest(crops) : null;
  return (d ? [...base, d] : base).join('|');
}

// ── OPS-PLANHOURLY-001 §escalation-only — key equality is not enough once the day holds 19 runs ────
//
// The dedup key above is CHANGE-detection: a different level or a different tripped-crop set is a new
// key and re-sends. With one evaluation per evening that is exactly right — the only way to get a
// second key was a real escalation. The hourly schedule puts FOUR evaluations in the 14:00-17:59 ET
// window, and across an afternoon the forecast low genuinely wanders: a crop crosses a band and comes
// back, the set gains one and loses another, the site low ticks 33.4 -> 32.8 -> 33.1. Every one of
// those is a new key, and every new key is an email. Dave's ruling (2026-09-13): re-check hourly,
// but only tell me if it gets WORSE.
//
// So the key still establishes IDENTITY (have I sent exactly this?) and this function establishes
// DIRECTION (is this worse than everything I have already sent tonight?). Both must pass to publish.
//
// "Worse" is ordinal and evaluated on two axes, because either can move alone:
//   - the SITE level escalating (advisory -> protect -> hard_freeze), which changes the headline; and
//   - any INDIVIDUAL crop escalating, including a crop that was not tripped at all before (rank 0),
//     which changes what Dave has to go out and cover.
// A shrinking set, a de-escalating crop, and a low that wobbles without crossing a band are all
// explicitly NOT worse and stay silent — that is the noise this exists to remove.
//
// Heat is deliberately OUT of scope: it is a separate tier on a separate axis (a hot day is not a
// colder night), its key already admits one send per space per day, and comparing it against frost
// ranks would be a category error. handler.js applies this gate to frost tiers only.
const FROST_SEVERITY_RANK = { advisory: 1, protect: 2, hard_freeze: 3 };
function severityRank(level) { return FROST_SEVERITY_RANK[level] || 0; }

// A crop's identity in a persisted `crops` map: the same slug||label fallback as cropDigest, named once so
// sentCoverage (BUG-INGROUNDPOSTWINDOW-001) reads the map with exactly the key cropLevels wrote it with.
const cropKey = (c) => c.slug || c.label;

// Compact {slug: level} map persisted on each alerts_sent entry so a later run can compare per-crop
// rather than re-deriving from a hash. Uses the same slug||label fallback as cropDigest so the two
// cannot disagree about a crop's identity.
function cropLevels(trippedCrops) {
  const rows = (Array.isArray(trippedCrops) ? trippedCrops : []).filter(Boolean);
  if (!rows.length) return null;
  const out = {};
  for (const c of rows) {
    const k = cropKey(c);
    if (!k) continue;
    if (severityRank(c.level) > severityRank(out[k])) out[k] = c.level;
  }
  return Object.keys(out).length ? out : null;
}

// BUG-FROSTESCALATENIGHTMOVE-001 — the NIGHT a sent entry warned about, in nights after the plan date
// (0 = tonight): an imminent send is about tonight by construction (evalImminent reads tonightLow), an
// advisory about the nightOffset its message named (handler.frostWeatherFacts persists it). Everything
// else is null, no night on record: heat, and an advisory written before nightOffset was persisted.
// handler.js calls this on the entry it is about to write as well as on the stored ones, so the night
// it compares and the night it records cannot disagree.
function sentNight(a) {
  if (!a) return null;
  if (a.tier === 'imminent') return 0;
  if (a.tier === 'advisory' && Number.isInteger(a.nightOffset) && a.nightOffset >= 0) return a.nightOffset;
  return null;
}

// BUG-FROSTREHEARSALSWALLOWS-001 — does a stored send count as "already sent"? Not when a FORCED run made it (`run`
// 'forced', OPS-FROSTREHEARSALMARK-001: event.frostEval, the F5 rehearsal lever, whose trip points may be raised). A
// rehearsal sent before 14:00 ET stored the same key and night as the day's real advisory, and the 14-17 ET runs read
// it as sent: the real warning never went out. Dave's call (2026-09-21, "Tests never count"): a test run is ignored
// by every "already sent?" gate — the key gate in handler.js run(), escalatesBeyond, sentCoverage — so a real warning
// always sends; the accepted cost is that a REAL alert forced before the window is sent again by the next scheduled
// evaluation. An entry with no `run` was stored before the field existed and counts. src/lib/frostAlertLine.js
// applies the same rule to the Today line (frostrehearsal.test.js holds the two together).
function countsAsSent(a) {
  return !!a && a.run !== 'forced';
}

// `sent` is the alerts_sent array as stored (entries: { tier, level, crops?, nightOffset? }). Returns true
// when the decision is strictly worse than the high-water mark of everything already sent for the same
// plan date.
//
// An entry written before this change carries no `crops`. Its level still counts toward the site
// high-water mark, but it contributes NO per-crop history — so a crop tripped tonight reads as new and
// the alert goes out. That errs toward sending for the one evening that spans the deploy, which is the
// posture §3-7 states repeatedly: a swallowed frost alert is the failure this feature exists to
// prevent, and a duplicate is merely annoying.
//
// BUG-FROSTESCALATENIGHTMOVE-001 — the third axis is TIME. An advisory that told him "tomorrow night" is
// not news about tonight: when a later run moves the cold night EARLIER than every night already
// warned about, the frost arrives before the one he is preparing for, and that is worse at the same
// level and the same crops. Once per earlier night, because the send records its night and the next run
// compares against it. A night moving LATER is not worse (he is ready early). `night` absent (a caller
// with no night, every pre-existing one) skips the axis. Stored entries with no night on record
// contribute nothing to it, the same deploy-evening posture as `crops` above: if none of the prior sends
// has one, a decision that has one goes out once.
// BUG-FROSTREHEARSALSWALLOWS-001 — a forced (test) send is no high-water mark on any axis (countsAsSent).
function escalatesBeyond(sent, { level, crops, night } = {}) {
  const prior = (Array.isArray(sent) ? sent : []).filter((a) => countsAsSent(a) && severityRank(a.level) > 0);
  if (!prior.length) return true;                       // nothing sent tonight — anything is an escalation
  const maxSent = Math.max(...prior.map((a) => severityRank(a.level)));
  if (severityRank(level) > maxSent) return true;       // the headline got worse
  if (Number.isInteger(night) && night >= 0) {
    const warned = prior.map(sentNight).filter((n) => n != null);
    if (!warned.length || night < Math.min(...warned)) return true;   // the cold night moved earlier
  }
  const seen = {};
  for (const a of prior) {
    for (const [k, lv] of Object.entries(a.crops || {})) {
      if (severityRank(lv) > severityRank(seen[k])) seen[k] = lv;
    }
  }
  const now = crops || {};
  for (const [k, lv] of Object.entries(now)) {
    if (severityRank(lv) > severityRank(seen[k])) return true;   // a crop got worse, or is newly at risk
  }
  return false;
}

// ── §3-7 frost season — Sep 1 to Nov 15 inclusive, from the plan_date CALENDAR LABEL (never a clock read).
// Inside this window a null tonightLow is an alertable degradation, not "no frost tonight".
function isFrostSeason(planDate, opts = {}) {
  if (typeof planDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(planDate)) return false;
  const mmdd = planDate.slice(5);
  const start = opts.start || FROST_SEASON_START_MMDD;
  const end = opts.end || FROST_SEASON_END_MMDD;
  return start <= end ? (mmdd >= start && mmdd <= end) : (mmdd >= start || mmdd <= end);
}

// ── G3 run identity — WHICH of the three daily runs may evaluate frost ────────────────────────────
// `tonightLow` means three different nights depending on the run (G3): at 02:00 it is the night already in
// progress, at 05:30 most likely TOMORROW night, and only at 15:30 ET is it genuinely tonight. The three
// EventBridge rules all invoke this Lambda with an EMPTY detail (verified in AWS 2026-08-04 — no Input on
// any target), so the run cannot be identified from the payload; it is identified from the ET hour, which
// index.js reads and passes in. The window is deliberately wide (14:00–17:59 ET) because the cron is fixed
// in UTC — cron(30 19) is 15:30 EDT and 14:30 EST — while the other two runs land at 01:00–05:59 ET and
// cannot collide with it.
// `event.frostEval === true` forces evaluation (the F5 rehearsal lever, via scripts/rerun-daily-plan.sh);
// `event.frostEval === false` suppresses it. Neither can force a PUBLISH — that stays behind
// FROST_ALERT_ENABLED and the dry-run gate in handler.js.
//
// V5-STATIONHEALTHYEAR-001 — `firstOfDay` marks the FIRST evaluating run of the ET day (the 14:00 ET run on
// the hourly schedule, in EDT and EST alike). It is the stateless once-per-day cap for the station-health
// alerts: the in-invocation dedup store forgets between runs, so a condition that holds all afternoon would
// otherwise send once per evaluating run. Derived HERE, from the same window as `evaluate`, so the cap hour
// cannot drift out of the window if FROST_RUN_START_HOUR moves. False for a forced or suppressed run.
//
// BUG-INGROUNDPOSTWINDOW-001 — `beforeWindow` marks a run EARLIER in the ET day than the window: the evaluating
// runs still follow it on the same plan date and re-decide, so its in-ground coverage may stay a prediction
// (handler.js). Every other run that does not evaluate — after the window, forced off, or with no ET hour — has
// no later evaluation that night and reads what was actually sent. False unless the hour is known to be earlier.
const FROST_RUN_START_HOUR = numEnv('FROST_RUN_START_HOUR', 14);
const FROST_RUN_END_HOUR = numEnv('FROST_RUN_END_HOUR', 17);
function resolveFrostRun(event, { etHour } = {}) {
  if (event && event.frostEval === true) return { evaluate: true, slot: 'forced', reason: 'event_override', firstOfDay: false, beforeWindow: false };
  if (event && event.frostEval === false) return { evaluate: false, slot: 'suppressed', reason: 'event_override', firstOfDay: false, beforeWindow: false };
  const h = finite(etHour);
  if (h == null) return { evaluate: false, slot: 'unknown', reason: 'no_et_hour', firstOfDay: false, beforeWindow: false };
  const inWindow = h >= FROST_RUN_START_HOUR && h <= FROST_RUN_END_HOUR;
  return {
    evaluate: inWindow,
    slot: inWindow ? 'intraday-pm' : (h < 6 ? 'nightly-or-am' : 'other'),
    reason: inWindow ? 'pm_window' : 'outside_pm_window',
    firstOfDay: inWindow && h === FROST_RUN_START_HOUR,
    beforeWindow: h < FROST_RUN_START_HOUR,
  };
}

// ── Entry point ───────────────────────────────────────────────────────────────────────────────────
// Pure: no clock read, no network, no DB. Everything time-varying is an argument.
//   input.tonightLow        station-adjusted low for TONIGHT (15:30 run only — G3)
//   input.highToday         today's high (heat tier)
//   input.forecastLows      Open-Meteo temperature_2m_min for D1..D3 (F1 adds this param — G5)
//   input.forecastDates     parallel YYYY-MM-DD labels (message only)
//   input.forecastHourly    index.js hourly_temp {time, temperature_2m}: which NIGHT the pick is (message + entry only)
//   input.lowSource         'forecast' | 'station_floor' | 'forecast_absent' (§3-8 observability)
//   input.exposure          frostClass.summarize() output; its .byCropType drives the D6 per-crop path
//   input.spaceId/eventDate identity for the §3-5 dedup key
//   opts.thresholds         D2 overrides for the GLOBAL fallback path
//   opts.heatEnabled        D5; defaults to env FROST_HEAT_ENABLED (false)
//   opts.frostSeason        §3-7: true during Sep 1 – Nov 15 (isFrostSeason(planDate))
// Returns a decision record that is ALSO the §3-8 observability log line: it is emitted on every
// evaluation whether or not it alerts.
function frostEval(input = {}, opts = {}) {
  const T = resolveThresholds(opts.thresholds);
  const heatEnabled = opts.heatEnabled != null ? !!opts.heatEnabled : HEAT_ENABLED;
  const exposure = input.exposure || null;
  // The crop path engages whenever a breakdown was SUPPLIED — including an EMPTY one. An empty byCropType
  // means "nothing at risk in this Space tonight", which must suppress the alert; falling back to the global
  // threshold there would page about a garden of kale. A caller with no breakdown at all (legacy/global)
  // passes no byCropType key and keeps the pre-D6 behaviour.
  const crops = exposure && Array.isArray(exposure.byCropType) ? exposure.byCropType : null;

  // V5-RADIATIVEFROST-001. OFF by default. When off, both night objects resolve to null and
  // radiativeTrips returns false on a null night, so every path below is byte-identical to pre-V5 —
  // which is asserted by test, not inferred from this comment.
  // Read at CALL time, not module load. A module-load constant cannot be moved on a deployed Lambda
  // without a cold start, and — the reason it changed — it is unreachable from an end-to-end test,
  // which is precisely how the delivery seam below went unguarded.
  const radiativeEnabled = opts.radiativeEnabled != null ? !!opts.radiativeEnabled
    : String(process.env.FROST_RADIATIVE_ENABLED || 'false') === 'true';
  // The caller hands the whole night ARRAY, not two resolved nights, because the advisory's night is
  // not knowable until evalAdvisory has picked the coldest of D1..D3 — resolving it caller-side would
  // duplicate that selection and the two copies would drift.
  // Two views of the same array, deliberately separate. `allNights` is what ARRIVED and feeds the
  // corpus; `radNights` is what may TRIP and is flag-gated. Recording only the gated one meant the
  // corpus filled exclusively on nights the feature was already enabled for — selected on its own
  // outcome, and empty for as long as the flag stays off, which is correct-and-indefinite until there
  // is site truth to justify enabling it. Nothing here can be backfilled later.
  const allNights = Array.isArray(input.radiativeNights) ? input.radiativeNights : null;
  const radNights = radiativeEnabled ? allNights : null;
  // Tonight's window is keyed on the PLAN DATE, because nightsFrom labels a night by the date it
  // STARTS on: 22:00 today and 03:00 tomorrow are the same night, labelled today.
  const radTonight = radNights ? nightFor(radNights, input.eventDate) : null;

  // BUG-FROSTADVISORYNIGHTWORDING-001 — the pick plus the night it belongs to, located from the hourly
  // series (input.forecastHourly = index.js hourly_temp). The threshold trigger never reads it: whether, and at
  // what level, the advisory fires on its trip point is the same located or not. The RADIATIVE trigger does
  // (BUG-RADIATIVEPAIRINGNIGHT-001, below): the night is whose sky it judges.
  const picked = evalAdvisory(input.forecastLows, input.forecastDates, T);
  const advisory = { ...picked, ...locateNight(picked, input.forecastHourly) };
  // OFF-BY-ONE-NIGHT, and it is not obvious: `advisory.date` is a CIVIL DAY label and
  // `temperature_2m_min[D]` is that day's minimum — usually set shortly after SUNRISE, i.e. by the night
  // that STARTED on D-1 (nightsFrom keys a night by the date it starts on), but on an evening-minimum day
  // by the night that starts on D.
  //
  // Measured at this Space's coordinates over 5 autumns (380 nights): the daily minimum falls at hour
  // <=08:00 on 295/380 = 77.6% of days, and the `radiative` verdict of night(D) vs night(D-1)
  // DISAGREES on 137/380 = 36.1% of pairs — 68 false alarms and 69 misses. So the pairing is not a
  // constant: radiativeAdvisoryPairing judges the night the hours put the minimum in, and judges both
  // candidates when they cannot say. `pairing` is resolved from `allNights` so the frost-eval line records
  // it flag-off too (the corpus rule above); only the flag-gated view can trip.
  const pairing = radiativeAdvisoryPairing(allNights, advisory);
  const radAdvisory = radNights ? pairing.night : null;
  const advisoryCrops = crops ? evalAdvisoryCrops(advisory.minLowF, crops, T, radAdvisory) : null;
  const imminentGlobal = evalImminent(input.tonightLow, T);
  const imminent = crops ? evalImminentCrops(input.tonightLow, crops, T, radTonight) : imminentGlobal;
  const heat = evalHeat(input.highToday, T, heatEnabled);
  const advisoryRadiative = !!(advisoryCrops && Array.isArray(advisoryCrops.tripped)
    && advisoryCrops.tripped.some((c) => c && c.trip === 'radiative'));
  // When the tier opens ONLY because of a radiative trip, name ONLY the radiatively-tripped crops.
  // `advisory.fires` is the GLOBAL gate; a crop whose own band sits ABOVE it (settable via
  // FROST_BAND_THRESHOLDS_JSON — frostClass.js records tropical 52/50/40 and chill_sensitive 47/45/36
  // as "the thing to restore") can satisfy advisoryCrops.fires while the global gate holds the tier
  // shut. Without this filter the disjunct would CONDITIONALLY resurrect that suppressed crop — it
  // would be alerted or not depending on whether some UNRELATED crop happened to have a clear night,
  // which is indefensible either way. Whether the global gate should suppress it at all is a real
  // question and a pre-existing one; it is NOT this feature's to settle silently.
  const advisoryNamed = (advisory.fires || !advisoryCrops) ? advisoryCrops : {
    ...advisoryCrops,
    tripped: advisoryCrops.tripped.filter((c) => c && c.trip === 'radiative'),
  };

  // §3-7 fail loud: a null tonightLow inside frost season is NOT "no frost tonight". The caller publishes
  // a `frost_eval_degraded` ops alert on this flag. Outside frost season it is merely noted.
  const degraded = imminentGlobal.lowF == null;
  const degradedAlert = degraded && !!opts.frostSeason;
  // BUG-HYDROLOGYNULLSILENT-001 — the same §3-7 rule for the ADVISORY tier, kept as its own flag because
  // `degraded` means "no tonight low" and drives that message. Zero usable D1..D3 lows is not "no frost
  // ahead": it is the 48-72 h lead time gone. Both shapes land here — a null hydrology (fetchPrecip
  // returns null on any throw) and a hydrology with no usable temperature_2m_min (fetchPrecip checks neither
  // r.ok nor that `daily` exists, so a JSON error body would parse into an object of nulls; that shape —
  // hydrology present, zero lows, no hourly block — was logged live on 2026-09-02 at the 15:30 run). A
  // horizon of 0 is the tier switched off, not blind. Partial coverage (1-2 of 3 nights) still evaluates
  // and is not flagged.
  const advisoryDegraded = advisory.coveredDays === 0 && advisory.horizonDays > 0;
  const advisoryDegradedAlert = advisoryDegraded && !!opts.frostSeason;

  // Highest-severity tier wins the single outbound message; the others remain in the record for the log.
  // D6: "single outbound message" is now literal — every crop that tripped is inside it.
  let tier = null; let level = null; let message = null; let trippedCrops = null;
  // V5-TODAYFROSTLINEGAPS-001 — the colder advisory a watch message carries (the clause below), as the facts an advisory
  // entry stores (handler.frostWeatherFacts' advisory branch): its low, its civil day, and the night the clause NAMED.
  // The advisory entry is never written when the imminent tier wins the single message, so this is the only record of a
  // figure the email printed ("Colder on a second forecast: 35°F tonight", "Colder ahead: 34°F Monday night").
  // handler.js stores it on the imminent entry as `colder`; the Today client reads it (src/lib/frostAlertLine.js).
  // null whenever no clause is carried.
  let colder = null;
  if (imminent.fires) {
    tier = 'imminent'; level = imminent.level; message = imminentMessage(imminent, exposure);
    trippedCrops = imminent.tripped || null;
    // MESSAGE-MONOTONICITY, which is a different and stronger property than count-monotonicity.
    // "Highest-severity tier wins the single outbound message" means a radiative imminent trip — by
    // construction the LEAST certain trip in the system, since it only fires when the forecast low is
    // ABOVE the trip point — would otherwise DELETE a hard-forecast advisory about a genuinely colder
    // future night, and the advisory's dedup key is never written, so the Tier-1 lead time §3-3 exists
    // to provide is lost for that day. Adding an alert while removing a better one is a regression, not
    // a monotone improvement. Carrying the clause keeps ONE outbound message (D6) and loses neither.
    if (imminent.radiativeOnly && advisory.fires && finite(advisory.minLowF) != null
        && finite(imminent.lowF) != null && Number(advisory.minLowF) < Number(imminent.lowF)) {
      const when = advisoryWhen(advisory);
      // V5-RADIATIVESUBJECTCOPY-001 — this message is about TONIGHT. An advisory whose night is tonight too is
      // not "ahead": it is the second forecast's lower low for the same night (Open-Meteo vs the NWS low above).
      const night = advisoryNight(advisory);
      const sameNight = !!night && night.nightOffset === 0;
      const lead = sameNight ? 'Colder on a second forecast:' : 'Colder ahead:';
      // V5-TODAYFROSTLINEGAPS-001 (Dave 2026-09-21) — the same-night close is about TONIGHT, so it says what to do
      // tonight; "harvest ahead and stage row cover" is lead time for a night still to come, and stays on that branch.
      const close = sameNight ? 'pick what\'s ripe and cover tender plants tonight.' : 'harvest ahead and stage row cover.';
      message = truncate(`${message} ${lead} ${advisory.minLowF}°F ${when}` +
        `${advisory.date ? `, ${advisory.date}` : ''} — ${close}`);
      colder = {
        lowF: Number(advisory.minLowF),
        ...(advisory.dayOffset != null ? { dayOffset: advisory.dayOffset } : {}),
        ...(advisory.date ? { date: advisory.date } : {}),
        ...(night && Number.isInteger(night.nightOffset) && night.nightOffset >= 0 ? { nightOffset: night.nightOffset } : {}),
      };
    }
  } else if ((advisory.fires || advisoryRadiative) && (!crops || (advisoryCrops && advisoryCrops.fires))) {
    // With a crop breakdown the advisory only fires if some crop's OWN advisory point is met — otherwise a
    // 40°F window would page about a bed of kale.
    //
    // V5-RADIATIVEFROST-001: `advisory.fires` is the GLOBAL threshold gate, and it short-circuits. A
    // radiative trip happens precisely when the forecast low is ABOVE the trip point, so without the
    // disjunct the per-crop radiative result could never reach this branch and the advisory half of
    // the feature was dead — every per-crop assertion passed while the tier stayed null. Caught by
    // test, not by reading. The second clause is UNCHANGED, so crop-level agreement is still required
    // and the kale case stays closed.
    //
    // BUG-FROSTADVISORYNIGHTWORDING-001 — the radiative-only copy says "<night> looks clear and calm", and it
    // must name the night whose sky it quotes, radAdvisory. BUG-RADIATIVEPAIRINGNIGHT-001: when the hours
    // located the minimum that IS the located night, already named ('hourly' stays). Otherwise it is whichever
    // candidate night tripped, which can be the later one: name that, basis 'radiative'.
    // V5-RADIATIVESUBJECTCOPY-001 — `radiativeOnly` marks the record the way imminent.radiativeOnly marks that tier,
    // so the email subject labels it a watch from the same predicate the body used. Absent otherwise.
    if (radiativeOnlyNamed(advisoryNamed)) {
      if (pairing.basis !== 'hourly') {
        Object.assign(advisory, { nightOffset: pairing.nightOffset, nightDate: pairing.nightDate, nightBasis: 'radiative' });
      }
      advisory.radiativeOnly = true;
    }
    tier = 'advisory'; level = 'advisory'; message = advisoryMessage(advisory, exposure, advisoryNamed, radAdvisory);
    trippedCrops = (advisoryNamed && advisoryNamed.tripped) || null;
  } else if (heat.fires) {
    tier = 'heat'; level = 'heat'; message = heatMessage(heat, exposure);
  }

  const summarizeCrops = (rows) => (Array.isArray(rows) ? rows : []).map((c) => ({
    slug: c.slug, label: c.label, band: c.band, count: c.count, containers: c.containers, level: c.level,
  }));

  return {
    tier, level, message,
    alert: tier != null,
    advisory, advisoryCrops, imminent, imminentGlobal, heat,
    trippedCrops, colder,
    degraded, degradedAlert, advisoryDegraded, advisoryDegradedAlert,
    // §3-8 — logged on EVERY evaluation, alert or not; also the 2026 corpus for the 2027 learned offset.
    observability: {
      tonightLowF: imminentGlobal.lowF,
      lowSource: input.lowSource || null,
      highTodayF: heat.highF,
      forecastMinLowF: advisory.minLowF,
      forecastCoveredDays: advisory.coveredDays,
      // BUG-FROSTADVISORYNIGHTWORDING-001 — which night the advisory names and HOW it knew: 'hourly' (located),
      // 'base_rate' (the series could not vouch for the figure) or 'radiative'. A rise in base_rate is the
      // hourly block going missing, visible here rather than as a silent return to guessing.
      forecastMinHour: advisory.minHour ?? null,
      advisoryNightOffset: advisory.nightOffset,
      advisoryNightBasis: advisory.nightBasis,
      // BUG-RADIATIVEPAIRINGNIGHT-001 — whose sky the radiative advisory trigger judged, in the same vocabulary:
      // 'hourly' = the night the hours located (null date: that night has no sky in the window, so no radiative
      // verdict), 'base_rate' = the hours could not say, so both candidate nights were judged and this is the one
      // that counted. Resolved flag-off too; null basis = no pick to pair.
      radiativeAdvisoryNight: pairing.nightDate,
      radiativeAdvisoryNightBasis: pairing.basis,
      tier, level,
      tenderCount: exposure ? Number(exposure.tender || 0) : null,
      unknownCount: exposure ? Number(exposure.unknown || 0) : null,
      atRiskCount: exposure ? Number(exposure.atRisk || 0) : null,
      coveredExcluded: exposure ? Number(exposure.coveredExcluded || 0) : null,
      cropTypesAtRisk: crops ? crops.length : null,
      cropTypesTripped: trippedCrops ? summarizeCrops(trippedCrops) : null,
      thresholds: T,
      heatEnabled,
      // V5-RADIATIVEFROST-001 — the 2026 corpus for the 2027 learned offset. Logged on EVERY
      // evaluation, trip or no trip, and whether or not the flag is on: the whole point is to
      // accumulate paired (forecast, conditions) rows against which a site offset can later be fitted
      // from Dave's own station observations. A row only written when the feature fires would be
      // selected on the outcome and useless for fitting.
      radiativeEnabled,
      // Recorded UNCONDITIONALLY, from `input` rather than from the flag-gated `radNights`. Two
      // mutations that severed the delivery seam entirely — handler passing `nightsFrom(null)`, and
      // index.js emitting a null `hourly_frost` — both survived the whole suite, because every
      // assertion about that seam was a regex over SOURCE TEXT (index.js cannot be imported; it pulls
      // AWS/neon at module load) and the string shape still matched while the value was inverted.
      // This is the one number that says the data actually ARRIVED, it is observable flag-off, and it
      // lands in the frost-eval CloudWatch line so the seam is checkable in prod as well as in test.
      radiativeNightsAvailable: Array.isArray(input.radiativeNights) ? input.radiativeNights.length : null,
      // UNCONDITIONAL — resolved from `allNights`, not the flag-gated view. This is the conditions half
      // of the (conditions, observed minimum) pair a 2027 bias correction has to be fitted on; the
      // observed half is station.js:overnightMins, carried on the durable plan payload.
      radiativeTonight: (allNights ? nightFor(allNights, input.eventDate) : null) ? {
        ...(({ date, minDewpointF, meanCloudPct, meanWindMph, hours, radiative }) =>
          ({ date, minDewpointF, meanCloudPct, meanWindMph, hours, radiative }))(nightFor(allNights, input.eventDate)),
      } : null,
      radiativeTripped: !!(imminent && imminent.radiativeOnly),
    },
    dedupKey: tier ? dedupKey({ spaceId: input.spaceId, eventDate: input.eventDate, tier, level, crops: trippedCrops }) : null,
    // OPS-PLANHOURLY-001 — the per-crop severity map the escalation gate compares against, and what
    // handler.js persists on the alerts_sent entry. Null on the no-crop-breakdown (legacy) path, which
    // the gate handles by falling back to the site level alone.
    cropLevels: tier ? cropLevels(trippedCrops) : null,
  };
}

// ── BUG-INGROUND39FSLIVER-001 — what the frost email does about each at-risk planting tonight ──────────
// engine.coldFor drops an in-ground planting's bring-in card on the premise "the frost email covers it"
// (V5-COLDCARDREACHABLE-001; Dave 2026-09-17: a bed cannot be carried inside, so in-ground plantings rely on
// the email). The premise used to be checked by CLASS only (not hardy, not heated), so the card dropped on
// nights the email never sent: NWS 39F with Open-Meteo D1 42F trips neither the imminent tier (tonightLow
// <= 38, NWS) nor the advisory (D1..D3 <= 40, Open-Meteo), and an in-ground potato got no card and no email
// (real run(), 2026-10-05). This answers the premise from the email's OWN decision, so the two cannot drift.
// Returns Map(planting id -> standing), over every planting in the exposure the decision was evaluated on:
//   'named'      its crop is in decision.trippedCrops, whichever tier won the single message (imminent,
//                advisory or radiative). Per crop, not per night: when the imminent tier fires, a crop that
//                met only its advisory point is not in the message, and reads 'unnamed' here too.
//   'above_band' not named, and tonightLow does not meet its crop's own ADVISORY point (evalAdvisoryCrops, the
//                email's per-crop predicate, run on the card's low): the channel is silent BY DESIGN here —
//                frostClass.js "THE ACCEPTED COST", which Dave extended to the in-ground card 2026-09-17.
//   'unnamed'    at or inside its band and not named: the email is silent about a night it covers. The card
//                is the only message left, so coldFor keeps it.
// A planting summarize leaves out (hardy by class, heated, dormant) has no entry and keeps its card. A null
// tonightLow proves nothing is above any band, and a crop whose band carries no trip points (an explicit null
// via FROST_BAND_THRESHOLDS_JSON) has no band to be above: both read 'unnamed'. No decision -> null.
function frostCoverage(decision, exposure, tonightLow) {
  if (!decision) return null;
  const T = (decision.observability && decision.observability.thresholds) || resolveThresholds();
  const ids = (c) => (c && Array.isArray(c.ids) ? c.ids : []);
  const named = new Set((Array.isArray(decision.trippedCrops) ? decision.trippedCrops : []).flatMap(ids));
  const low = finite(tonightLow);
  const out = new Map();
  for (const g of (exposure && Array.isArray(exposure.byCropType) ? exposure.byCropType : [])) {
    if (!g) continue;
    const aboveBand = low != null && !!cropThresholds(g, T) && !evalAdvisoryCrops(low, [g], T, null).fires;
    for (const id of ids(g)) out.set(id, named.has(id) ? 'named' : (aboveBand ? 'above_band' : 'unnamed'));
  }
  return out;
}

// ── BUG-INGROUNDPOSTWINDOW-001 — after the window, 'named' must be an email that WENT OUT ──────────────────
// frostCoverage asks "does THIS decision name the planting?". In a 14-17 ET run that decision IS the email: it
// is published, or held because an earlier send already said as much. A run after the window makes the same
// decision from its own forecast and publishes nothing, so there 'named' predicted an email nobody sends: a low
// that crossed the trip after 17:59 dropped the bed's card and no email followed (real run(): 16 ET NWS 39 /
// OM 42 carded, 20 ET NWS 38 / OM 45 no card, 0 emails).
// So only the 'named' entries are restated, against `sent` — the alerts_sent entries recorded for this Space
// today (handler.readSpaceAlertsSent). A planting stays 'named' only when a sent email named its crop at least
// as severely as this decision does, the same per-crop comparison escalatesBeyond makes before it re-sends; a
// crop that got worse after the window, or was never named, reads 'unnamed' and coldFor keeps its card.
// 'above_band' and 'unnamed' are returned as they are: neither ever relied on an email. An entry with no
// `crops` (a send with no crop breakdown) names nothing. No coverage -> null.
// BUG-FROSTREHEARSALSWALLOWS-001 — nor does a forced (test) send (countsAsSent): the bed keeps its card.
function sentCoverage(decision, coverage, sent) {
  if (!coverage) return null;
  const sentRank = {};
  for (const a of (Array.isArray(sent) ? sent : [])) {
    if (!countsAsSent(a) || !a.crops || typeof a.crops !== 'object') continue;
    for (const [k, lv] of Object.entries(a.crops)) sentRank[k] = Math.max(sentRank[k] || 0, severityRank(lv));
  }
  const out = new Map(coverage);
  for (const c of (decision && Array.isArray(decision.trippedCrops) ? decision.trippedCrops : [])) {
    if (!c) continue;
    const s = sentRank[cropKey(c)] || 0;
    if (s > 0 && s >= severityRank(c.level)) continue;
    for (const id of (Array.isArray(c.ids) ? c.ids : [])) out.set(id, 'unnamed');
  }
  return out;
}

module.exports = {
  frostEval, frostCoverage, sentCoverage, resolveThresholds, dedupKey, cropDigest,
  escalatesBeyond, sentNight, countsAsSent, cropLevels, severityRank, FROST_SEVERITY_RANK,
  evalAdvisory, evalImminent, evalHeat, evalImminentCrops, evalAdvisoryCrops,
  locateNight, advisoryNight, nightPhrase, weekdayOf, NIGHT_SPLIT_HOUR, radiativeAdvisoryPairing,
  advisoryMessage, imminentMessage, heatMessage, exposurePhrase, cropListPhrase, totalsPhrase, truncate,
  isFrostSeason, resolveFrostRun, FROST_RUN_START_HOUR, FROST_RUN_END_HOUR,
  DEFAULT_THRESHOLDS, HEAT_ENABLED, MAX_NAMED_CROPS, MAX_MESSAGE_CHARS,
};
