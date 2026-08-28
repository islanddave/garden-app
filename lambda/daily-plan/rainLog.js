'use strict';
// rainLog.js — V4-RAINAUTOLOG-001 part 2: decide whether tonight's run should turn yesterday's
// gauge reading into rain EVENTS, and how much.
//
// Pure by construction, exactly like frostEval.js: no clock read, no network, no DB. Everything
// time-varying is an argument. The SQL lives in handler.js; every DECISION lives here so it can be
// unit-tested without a database.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────────
// 'rain' is READ in ten places across daily-plan, dashboard, doneEvents, overwinter and the events
// undo cascade, and until 2026-08-28 was WRITTEN by nothing automatic. RAIN-EVENT-001 created the
// type, DRG-WXSTATION-001 supplied the gauge, BUG-RAINACTUAL-001 pointed the precip FIELDS at the
// gauge — and nobody built the bridge from a reading to an event row. Dave logged rain by hand until
// 2026-07-18 and then stopped, believing it was automatic. migrations/v4-rainbackfill-001 repaired
// the history; this file is what stops the gap reopening tomorrow.
//
// ── DAVE'S CONSTRAINTS, VERBATIM ─────────────────────────────────────────────────────────────────
//   "Once a day is fine, 11:55pm ET or so to run the day's total or whatever works best. Once a day
//    at most."          -> ONCE A DAY IS A HARD CAP. The hour is explicitly negotiable.
//   "above 0.10 inches measured. Below that is not an event."
//                       -> strictly greater than 0.10, and MEASURED — see the gauge-only rule below.
//
// ── WHY THE NIGHTLY SLOT AND NOT 23:55 ET ────────────────────────────────────────────────────────
// Three EventBridge rules invoke this Lambda: nightly cron(0 6) = 02:00 ET, intraday-am cron(30 9)
// = 05:30 ET, intraday-pm cron(30 19) = 15:30 ET. All three pass an EMPTY detail (verified in AWS
// 2026-08-04), so the run is identified from the ET hour index.js reads — the same mechanism
// resolveFrostRun uses, and for the same reason.
//
// Logging at 02:00 ET for the PREVIOUS ET day is strictly better than Dave's suggested 23:55:
//   * at 23:55 the day is not over, so any rain in the last five minutes is silently lost, and the
//     following night would not pick it up either because the day would already be logged;
//   * at 02:00 the previous day is complete and closed, and its gauge reading has settled.
// Adding a fourth 23:55 rule would also have SPENT the once-a-day budget on a worse reading.
//
// The window is 00:00–05:59 ET rather than a single hour because the crons are fixed in UTC while ET
// shifts: cron(0 6) is 02:00 EDT and 01:00 EST. intraday-am at 05:30 ET is INSIDE that window and is
// the reason the day-already-logged guard in handler.js is load-bearing rather than belt-and-braces:
// the two runs are 3.5 hours apart, both in the window, and only that guard keeps the cap at once.
//
// ── GAUGE-ONLY, AND WHY A MODEL DAY MUST NOT PRODUCE AN EVENT ────────────────────────────────────
// Dave's threshold is "above 0.10 inches MEASURED". A row whose precip_source is 'openmeteo_archive'
// or 'openmeteo_live' carries an ESTIMATE, not a measurement, and the model is materially wrong at
// this site: on 2026-08-03 it said 1.00" where the gauge measured 2.22". Logging a rain EVENT — a
// row in the user's own history, which suppresses watering reminders — off an estimate would state
// something the instrument never said. 2026-08-01 is the live case: 0.12" model, no gauge record, no
// event, deliberately. See migrations/v4-rainbackfill-001/README.md §Known, deliberate gap.
//
// ── NO REWARD SIDE EFFECTS. THIS IS BINDING, NOT A PREFERENCE ────────────────────────────────────
// Auto-logged rain must NEVER award XP, roll a critter, advance a logging streak, evaluate an
// achievement or emit app_events telemetry. reward-ux-guideline-V102 scopes reward surfaces to USER
// activity, and its streaks rule permits streaks only on cadence-UTILITY surfaces with break
// recovery. Rain the sky delivered is not something Dave did; crediting it would make the watering
// streak partly a measure of the weather and would hand out rewards for staying indoors.
// handler.js therefore writes the event rows and the CARE CACHE directly and does NOT call
// lambda/events/batchSideEffects.js. If a future change routes this through POST /api/events/batch,
// it re-introduces exactly that defect.

// All three env vars this module reads — RAIN_AUTOLOG_ENABLED, RAIN_LOG_THRESHOLD_IN and
// RAIN_RUN_END_HOUR — are declared in scripts/lambda-config-expected.json as expected-ABSENT (null),
// i.e. the defaults below are the shipped behaviour. That declaration is not optional bookkeeping:
// scripts/test_check_lambda_config.py walks this directory for process.env reads and fails CI on any
// that are undeclared, because "a read-but-undeclared var is how CARE_WATER_LEDGER_ENABLED stayed
// invisible". Note its regex only matches the dotted static form (process dot env dot THE_NAME), so
// the two read through numEnv's bracket lookup were invisible to it and were declared by hand. If
// you add another, add it there too — the manifest's own note claims to be the COMPLETE set.
// (Spelled out in words above on purpose: that scanner reads COMMENTS too, so writing the dotted
// form here would have declared a variable named NAME. It did, once.)
const THRESHOLD_IN = numEnv('RAIN_LOG_THRESHOLD_IN', 0.10);
const RAIN_RUN_END_HOUR = numEnv('RAIN_RUN_END_HOUR', 5);   // inclusive; 00:00–05:59 ET is the nightly slot
const GAUGE_SOURCE = 'gauge_merged';
const BACKFILL_TAG = 'v4-rainbackfill-001';                 // shared with the migration, on purpose — see below

function numEnv(name, dflt) {
  const raw = process.env[name];
  if (raw == null || raw === '') return dflt;
  const n = Number(raw);
  return Number.isFinite(n) ? n : dflt;
}

// null / undefined / '' / booleans must NOT coerce. Number(null) and Number('') are both 0 and both
// pass Number.isFinite, so a bare Number() here would read a DROPPED STATION READING as a dry day —
// the single worst failure this module could have, because it is invisible: a silent 0 looks exactly
// like a real measurement of no rain. Caught by rainLog.test.js's "a null precip is NOT treated as
// zero", which failed against the first version of this function.
function finite(v) {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ── Run identity — WHICH of the three daily runs may log rain ────────────────────────────────────
// `event.rainLog === true` forces logging and `=== false` suppresses it: the rehearsal lever, via
// scripts/rerun-daily-plan.sh, mirroring event.frostEval. Neither can bypass the threshold, the
// gauge-only rule or the already-logged guard — those are correctness, not scheduling.
// RAIN_AUTOLOG_ENABLED is its OWN switch and is deliberately NOT CARE_WATER_LEDGER_ENABLED, even
// though both features read weather_daily. That flag is unset on the prod Lambda and therefore
// evaluates false, so reusing it would have shipped a feature that could never run — the failure
// mode where everything looks wired and nothing happens.
//
// It defaults ON and disarms only on the exact string 'false'. That is the opposite polarity to
// CARE_WATER_LEDGER_ENABLED, which arms only on the exact string 'true', and the asymmetry is
// intentional: that flag guards a read that could blank the nightly plan, so it fails safe by
// staying off; this one guards a fail-open write that runs after the plan is durable, so it fails
// safe by staying on. A typo in the env should not silently stop rain being logged for months —
// which is the precise shape of the bug this whole ticket exists to fix.
function rainAutologEnabled() {
  return process.env.RAIN_AUTOLOG_ENABLED !== 'false';
}

function resolveRainRun(event, { etHour } = {}) {
  if (!rainAutologEnabled()) return { log: false, slot: 'disabled', reason: 'flag_off' };
  if (event && event.rainLog === true) return { log: true, slot: 'forced', reason: 'event_override' };
  if (event && event.rainLog === false) return { log: false, slot: 'suppressed', reason: 'event_override' };
  const h = finite(etHour);
  if (h == null) return { log: false, slot: 'unknown', reason: 'no_et_hour' };
  const inWindow = h <= RAIN_RUN_END_HOUR;
  return {
    log: inWindow,
    slot: inWindow ? 'nightly' : 'other',
    reason: inWindow ? 'nightly_window' : 'outside_nightly_window',
  };
}

// ── The decision, given one weather_daily row ────────────────────────────────────────────────────
// Returns { log: boolean, amountIn: number|null, reason: string }. Every rejection carries a REASON
// rather than a bare false, because "no rain was logged last night" and "the station was offline
// last night" look identical from the outside and mean very different things.
function rainDecision(row, { thresholdIn = THRESHOLD_IN } = {}) {
  if (!row) return { log: false, amountIn: null, reason: 'no_weather_row' };
  const src = row.precip_source;
  if (src !== GAUGE_SOURCE) {
    // Includes the model sources AND null. Deliberately not a fallback: see the gauge-only rule.
    return { log: false, amountIn: null, reason: src ? `not_gauge_sourced:${src}` : 'no_precip_source' };
  }
  const amt = finite(row.precip_in);
  if (amt == null) return { log: false, amountIn: null, reason: 'no_precip_value' };
  // STRICTLY greater than. Dave's "above 0.10 inches"; an exact 0.10 day (2026-07-22 measured
  // exactly that) is not an event.
  if (!(amt > thresholdIn)) return { log: false, amountIn: amt, reason: 'below_threshold' };
  return { log: true, amountIn: amt, reason: 'above_threshold' };
}

// ── The day to log ──────────────────────────────────────────────────────────────────────────────
// The PREVIOUS ET day. `today` is the plan date the handler is already working in ET terms, so this
// is pure string arithmetic on YYYY-MM-DD and does no clock read of its own — which is what keeps
// this module testable and keeps the answer stable across a run that straddles midnight.
function previousDay(today) {
  if (typeof today !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return null;
  const d = new Date(`${today}T12:00:00Z`);   // noon anchor: immune to DST and to off-by-one at the boundary
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// The metadata written onto every auto-logged rain row.
//
// It carries the SAME `rain_backfill` tag as the migration, deliberately, and this is worth stating
// because it looks like a copy-paste error and is not: the tag's job is "this rain row was written
// by a machine from a gauge reading, not by a person", and that is equally true of both. Anything
// that needs to tell them apart can, without a second tag — the migration's rows all predate
// 2026-08-28 and carry `backfilled: true`. Two tags for one meaning would mean every future consumer
// has to remember both, and the one that forgets silently under-counts.
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
  rainAutologEnabled,
  resolveRainRun,
  rainDecision,
  previousDay,
  rainMetadata,
  THRESHOLD_IN,
  GAUGE_SOURCE,
  BACKFILL_TAG,
};
