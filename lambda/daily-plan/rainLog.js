'use strict';
// Decides whether tonight's run turns yesterday's gauge reading into rain EVENTS, and how much
// (V4-RAINAUTOLOG-001 part 2).
//
// Pure by construction, like frostEval.js: no clock read, no network, no DB. Everything time-varying is an
// argument. The SQL lives in handler.js; every DECISION lives here so it can be unit-tested without a
// database.
//
// Why it exists: 'rain' events are READ in many places (daily-plan, dashboard, doneEvents, overwinter, the
// events undo cascade) but nothing automatic WROTE them; the gauge fed the precip fields and nobody
// bridged a reading to an event row. migrations/v4-rainbackfill-001 repaired the history; this file keeps
// the gap from reopening.
//
// Constraints from the product owner:
//   * ONCE A DAY IS A HARD CAP; the hour is negotiable.
//   * STRICTLY greater than 0.10 in, and MEASURED (see the gauge-only rule below).
//
// WHY THE NIGHTLY SLOT AND NOT 23:55 ET. Three EventBridge rules invoke this Lambda (nightly 02:00 ET,
// intraday-am 05:30 ET, intraday-pm 15:30 ET), all with an EMPTY detail, so the run is identified from the
// ET hour index.js reads, the same way resolveFrostRun does it. Logging at 02:00 for the PREVIOUS ET day
// beats 23:55: at 23:55 the day is not over, so late rain is lost and the next night would not pick it up,
// while at 02:00 the day is closed and the gauge reading has settled.
//
// The window is 00:00-05:59 ET rather than one hour because the crons are fixed in UTC while ET shifts
// (02:00 EDT, 01:00 EST). intraday-am at 05:30 ET is INSIDE the window, which is why the
// day-already-logged guard in handler.js is load-bearing: only it keeps the cap at once a day.
//
// GAUGE-ONLY: a model day must not produce an event. A row whose precip_source is 'openmeteo_archive' or
// 'openmeteo_live' is an ESTIMATE and the model is materially wrong at this site (it has said 1.00 in where
// the gauge measured 2.22 in). A rain EVENT is a row in the user's own history that suppresses watering
// reminders; logging one off an estimate would state something the instrument never said. See
// migrations/v4-rainbackfill-001/README.md, "Known, deliberate gap".
//
// NO REWARD SIDE EFFECTS. THIS IS BINDING. Auto-logged rain must NEVER award XP, roll a critter, advance a
// logging streak, evaluate an achievement or emit app_events telemetry: reward-ux-guideline-V102 scopes
// rewards to USER activity, and rain the sky delivered is not something the user did. handler.js therefore
// writes the event rows and the CARE CACHE directly and does NOT call lambda/events/batchSideEffects.js.
// Routing this through POST /api/events/batch would reintroduce the defect.

// All three env vars this module reads (RAIN_AUTOLOG_ENABLED, RAIN_LOG_THRESHOLD_IN, RAIN_RUN_END_HOUR) are
// declared in scripts/lambda-config-expected.json: the two numeric ones expected-ABSENT (the defaults
// below are the shipped behaviour), the arming flag PRESENT and "true" (BUG-RAINAUTOLOGCLIFF-001), because
// a switch whose live state can only be read off an absence cannot be audited.
// scripts/test_check_lambda_config.py walks this directory and fails CI on any undeclared env read. Its
// regex matches only the dotted static form and also scans COMMENTS, so never write that form in a comment
// (it once declared a variable named NAME), and declare a bracket-read var such as numEnv's by hand.
const THRESHOLD_IN = numEnv('RAIN_LOG_THRESHOLD_IN', 0.10);
const RAIN_RUN_END_HOUR = numEnv('RAIN_RUN_END_HOUR', 5);   // inclusive; 00:00–05:59 ET is the nightly slot
const GAUGE_SOURCE = 'gauge_merged';
const BACKFILL_TAG = 'v4-rainbackfill-001';                 // shared with the migration, on purpose (see rainMetadata)

function numEnv(name, dflt) {
  const raw = process.env[name];
  if (raw == null || raw === '') return dflt;
  const n = Number(raw);
  return Number.isFinite(n) ? n : dflt;
}

// null / undefined / '' / booleans must NOT coerce. Number(null) and Number('') are both 0 and finite, so
// a bare Number() would read a DROPPED STATION READING as a dry day, which is invisible: a silent 0 looks
// exactly like a real measurement of no rain. rainLog.test.js pins it ("a null precip is NOT treated as
// zero").
function finite(v) {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ── Run identity: which of the three daily runs may log rain ─────────────────────────────────────
// `event.rainLog === true` forces logging and `=== false` suppresses it: the rehearsal lever, via
// scripts/rerun-daily-plan.sh, mirroring event.frostEval. Neither can bypass the threshold, the
// gauge-only rule or the already-logged guard; those are correctness, not scheduling.
// RAIN_AUTOLOG_ENABLED is its OWN switch, deliberately NOT CARE_WATER_LEDGER_ENABLED: that flag is unset
// on the prod Lambda, so reusing it would ship a feature that could never run.
//
// It defaults ON and disarms only on the exact string 'false', the opposite polarity to
// CARE_WATER_LEDGER_ENABLED (arms only on 'true'), and the asymmetry is intentional: that flag guards a
// read that could blank the nightly plan, so it fails safe by staying off; this one guards a fail-open
// write that runs after the plan is durable, so it fails safe by staying on. A typo in the env must not
// silently stop rain being logged for months.
//
// BUG-RAINAUTOLOGCLIFF-001: ARMED BY A VALUE, NEVER BY AN ABSENCE. The polarity above is right. The
// problem was that the gate read only as `!== 'false'`, so the live state (key ABSENT) armed the writer
// with nothing anywhere saying so, and absence-arming is invisible to recon. So the state resolves into a
// NAMED config source, carried through resolveRainRun into handler.js's structured `rain-log` line.
// Absence still ARMS, but as 'default_key_absent', which is visible in CloudWatch, assertable in a test,
// and distinct from a deliberate 'explicit_on'.
//
// FAIL DIRECTION: OPEN. A missing or unrecognised value ARMS; failing closed would silently stop the
// nightly event rows, a behaviour change disguised as a safety improvement. The key is declared PRESENT
// ("true") in scripts/lambda-config-expected.json and ensured by deploy-lambda.yml's daily-plan env merge,
// so in prod the absence branch is unreachable once that has run.
const AUTOLOG_DEFAULT = true;

// Returns { enabled, config }; `config` names WHERE the answer came from. Deliberately NOT a widened
// truthiness parse: '0', 'no', 'off' and '' all still ARM, because a typo must not disarm a fail-open
// writer (rainLog.test.js pins that); they report as 'default_unrecognised'.
//
// Read through the DOTTED static form on purpose, not numEnv's bracket lookup: only that form is visible
// to scripts/test_check_lambda_config.py's "daily-plan declares every env var it reads" guard.
function rainAutologState() {
  const raw = process.env.RAIN_AUTOLOG_ENABLED;
  if (raw === 'true') return { enabled: true, config: 'explicit_on' };
  if (raw === 'false') return { enabled: false, config: 'explicit_off' };
  if (raw === undefined) return { enabled: AUTOLOG_DEFAULT, config: 'default_key_absent' };
  return { enabled: AUTOLOG_DEFAULT, config: 'default_unrecognised' };
}

function rainAutologEnabled() {
  return rainAutologState().enabled;
}

function resolveRainRun(event, { etHour } = {}) {
  // `flag` rides on EVERY return: "the writer ran" and "the writer ran because nobody set the key" are
  // different facts and only one is a decision.
  const { enabled, config: flag } = rainAutologState();
  if (!enabled) return { log: false, slot: 'disabled', reason: 'flag_off', flag };
  if (event && event.rainLog === true) return { log: true, slot: 'forced', reason: 'event_override', flag };
  if (event && event.rainLog === false) return { log: false, slot: 'suppressed', reason: 'event_override', flag };
  const h = finite(etHour);
  if (h == null) return { log: false, slot: 'unknown', reason: 'no_et_hour', flag };
  const inWindow = h <= RAIN_RUN_END_HOUR;
  return {
    log: inWindow,
    slot: inWindow ? 'nightly' : 'other',
    reason: inWindow ? 'nightly_window' : 'outside_nightly_window',
    flag,
  };
}

// ── The decision, given one weather_daily row ────────────────────────────────────────────────────
// Returns { log: boolean, amountIn: number|null, reason: string }. Every rejection carries a REASON,
// because "no rain was logged last night" and "the station was offline last night" look identical from
// outside.
function rainDecision(row, { thresholdIn = THRESHOLD_IN } = {}) {
  if (!row) return { log: false, amountIn: null, reason: 'no_weather_row' };
  const src = row.precip_source;
  if (src !== GAUGE_SOURCE) {
    // Includes the model sources AND null. Deliberately not a fallback: see the gauge-only rule.
    return { log: false, amountIn: null, reason: src ? `not_gauge_sourced:${src}` : 'no_precip_source' };
  }
  const amt = finite(row.precip_in);
  if (amt == null) return { log: false, amountIn: null, reason: 'no_precip_value' };
  // STRICTLY greater than: "above 0.10 inches"; an exact 0.10 day is not an event.
  if (!(amt > thresholdIn)) return { log: false, amountIn: amt, reason: 'below_threshold' };
  return { log: true, amountIn: amt, reason: 'above_threshold' };
}

// ── The day to log ──────────────────────────────────────────────────────────────────────────────
// The PREVIOUS ET day. `today` is the plan date the handler already works in ET terms, so this is pure
// string arithmetic on YYYY-MM-DD with no clock read, which keeps it testable and stable across a run that
// straddles midnight.
function previousDay(today) {
  if (typeof today !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return null;
  const d = new Date(`${today}T12:00:00Z`);   // noon anchor: immune to DST and to off-by-one at the boundary
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// The metadata written onto every auto-logged rain row.
//
// It carries the SAME `rain_backfill` tag as the migration, deliberately (it looks like a copy-paste
// error and is not): the tag means "written by a machine from a gauge reading, not by a person", true of
// both. Tell them apart without a second tag: autologger rows carry `auto_logged: true`; the migration's
// rows carry neither `auto_logged` nor `backfilled`. Do not key on `backfilled: true`: no production
// caller passes it. Two tags for one meaning would mean every future consumer must remember both.
function rainMetadata(amountIn, { backfilled = false } = {}) {
  return {
    rain_backfill: BACKFILL_TAG,
    gauge_in: amountIn,
    precip_source: 'awn_gauge',
    station_series: 'awn_dailyrainin',
    ...(backfilled ? { backfilled: true } : { auto_logged: true }),
  };
}

module.exports = {
  rainAutologState,
  rainAutologEnabled,
  resolveRainRun,
  rainDecision,
  previousDay,
  rainMetadata,
  THRESHOLD_IN,
  GAUGE_SOURCE,
  BACKFILL_TAG,
};
