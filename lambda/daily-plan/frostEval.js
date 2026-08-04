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

function evalImminentCrops(tonightLow, byCropType, fallbackT) {
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
    else untripped.push({ ...c, level: null });
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
  return { fires: true, reason: 'crop_threshold', lowF: low, level: siteLevel, siteLevel, cropLevel, tripped, untripped };
}

function evalAdvisoryCrops(minLowF, byCropType, fallbackT) {
  const low = finite(minLowF);
  const rows = Array.isArray(byCropType) ? byCropType : [];
  if (low == null) return { fires: false, tripped: [], untripped: [] };
  const tripped = []; const untripped = [];
  for (const c of rows) {
    if (!c) continue;
    const t = cropThresholds(c, fallbackT);   // explicit null = hardy = never advised (§3-4)
    if (t && low <= t.ADVISORY_LOW_F) tripped.push({ ...c, level: 'advisory' });
    else untripped.push({ ...c, level: null });
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

function advisoryMessage(a, exposure, cropResult) {
  const when = a.dayOffset === 1 ? 'tomorrow night' : `in ${a.dayOffset} days`;
  const on = a.date ? `, ${a.date}` : '';
  const head = `FROST ADVISORY — frost possible ${when} (low ${a.lowF ?? a.minLowF}°F${on}).`;
  if (cropResult && cropResult.tripped && cropResult.tripped.length) {
    return truncate(`${head} At risk: ${cropListPhrase(cropResult.tripped)}. ${totalsPhrase(cropResult.tripped, exposure)} ` +
      'Harvest ahead and stage row cover.');
  }
  return `${head} ${exposurePhrase(exposure)} Harvest ahead and stage row cover.`;
}

function imminentMessage(im, exposure) {
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
const FROST_RUN_START_HOUR = numEnv('FROST_RUN_START_HOUR', 14);
const FROST_RUN_END_HOUR = numEnv('FROST_RUN_END_HOUR', 17);
function resolveFrostRun(event, { etHour } = {}) {
  if (event && event.frostEval === true) return { evaluate: true, slot: 'forced', reason: 'event_override' };
  if (event && event.frostEval === false) return { evaluate: false, slot: 'suppressed', reason: 'event_override' };
  const h = finite(etHour);
  if (h == null) return { evaluate: false, slot: 'unknown', reason: 'no_et_hour' };
  const inWindow = h >= FROST_RUN_START_HOUR && h <= FROST_RUN_END_HOUR;
  return {
    evaluate: inWindow,
    slot: inWindow ? 'intraday-pm' : (h < 6 ? 'nightly-or-am' : 'other'),
    reason: inWindow ? 'pm_window' : 'outside_pm_window',
  };
}

// ── Entry point ───────────────────────────────────────────────────────────────────────────────────
// Pure: no clock read, no network, no DB. Everything time-varying is an argument.
//   input.tonightLow        station-adjusted low for TONIGHT (15:30 run only — G3)
//   input.highToday         today's high (heat tier)
//   input.forecastLows      Open-Meteo temperature_2m_min for D1..D3 (F1 adds this param — G5)
//   input.forecastDates     parallel YYYY-MM-DD labels (message only)
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

  const advisory = evalAdvisory(input.forecastLows, input.forecastDates, T);
  const advisoryCrops = crops ? evalAdvisoryCrops(advisory.minLowF, crops, T) : null;
  const imminentGlobal = evalImminent(input.tonightLow, T);
  const imminent = crops ? evalImminentCrops(input.tonightLow, crops, T) : imminentGlobal;
  const heat = evalHeat(input.highToday, T, heatEnabled);

  // §3-7 fail loud: a null tonightLow inside frost season is NOT "no frost tonight". The caller publishes
  // a `frost_eval_degraded` ops alert on this flag. Outside frost season it is merely noted.
  const degraded = imminentGlobal.lowF == null;
  const degradedAlert = degraded && !!opts.frostSeason;

  // Highest-severity tier wins the single outbound message; the others remain in the record for the log.
  // D6: "single outbound message" is now literal — every crop that tripped is inside it.
  let tier = null; let level = null; let message = null; let trippedCrops = null;
  if (imminent.fires) {
    tier = 'imminent'; level = imminent.level; message = imminentMessage(imminent, exposure);
    trippedCrops = imminent.tripped || null;
  } else if (advisory.fires && (!crops || (advisoryCrops && advisoryCrops.fires))) {
    // With a crop breakdown the advisory only fires if some crop's OWN advisory point is met — otherwise a
    // 40°F window would page about a bed of kale.
    tier = 'advisory'; level = 'advisory'; message = advisoryMessage(advisory, exposure, advisoryCrops);
    trippedCrops = (advisoryCrops && advisoryCrops.tripped) || null;
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
    trippedCrops,
    degraded, degradedAlert,
    // §3-8 — logged on EVERY evaluation, alert or not; also the 2026 corpus for the 2027 learned offset.
    observability: {
      tonightLowF: imminentGlobal.lowF,
      lowSource: input.lowSource || null,
      highTodayF: heat.highF,
      forecastMinLowF: advisory.minLowF,
      forecastCoveredDays: advisory.coveredDays,
      tier, level,
      tenderCount: exposure ? Number(exposure.tender || 0) : null,
      unknownCount: exposure ? Number(exposure.unknown || 0) : null,
      atRiskCount: exposure ? Number(exposure.atRisk || 0) : null,
      coveredExcluded: exposure ? Number(exposure.coveredExcluded || 0) : null,
      cropTypesAtRisk: crops ? crops.length : null,
      cropTypesTripped: trippedCrops ? summarizeCrops(trippedCrops) : null,
      thresholds: T,
      heatEnabled,
    },
    dedupKey: tier ? dedupKey({ spaceId: input.spaceId, eventDate: input.eventDate, tier, level, crops: trippedCrops }) : null,
  };
}

module.exports = {
  frostEval, resolveThresholds, dedupKey, cropDigest,
  evalAdvisory, evalImminent, evalHeat, evalImminentCrops, evalAdvisoryCrops,
  advisoryMessage, imminentMessage, heatMessage, exposurePhrase, cropListPhrase, totalsPhrase, truncate,
  isFrostSeason, resolveFrostRun,
  DEFAULT_THRESHOLDS, HEAT_ENABLED, MAX_NAMED_CROPS, MAX_MESSAGE_CHARS,
};
