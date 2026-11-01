'use strict';
// The drought signal (V5-LEGACYEXCEPTIONCARE-001, V5-DROUGHTSPACE-001): consecutive settled days with NO
// ROOT-ZONE-WETTING RAIN. Product ruling: fire after 20 consecutive days without a single day of >=0.60 in.
//
// WHAT THIS IS NOT, and the distinction is load-bearing in every user-visible string this file emits:
// 0.60 in is the in-ground **deep** class of RAIN_DEPTH_TIERS, not `light` (0.10) and not a gauge's tipping
// resolution (0.01). The statistic is "no DEEP SOAK in N days", NEVER "no rain in N days". Calling a deep-soak
// threshold "rain" is the category slip that falsified the first version of crucible Verdict 3 (see the
// correction block in project-state/crucible-weathercue-verdict-V100-20260908.md).
//
// WHY (0.60, 20). Depth and day-count are ONE parameter. Over the first season's weather_daily, runs of
// 20+ days occurred at 0.60 in but not at 0.10 or 0.25. (0.60, 20) is the only pairing not read off that
// season's own maxima (it was specified before any measurement), so it is the only one not fitted to the
// single sample it would be validated against.
//
// DO NOT REINTRODUCE ET0 DEFICIT. Rejected on measurement: a Kc between 0.55 and 1.00 swings the stress-day
// count 0% -> 64%, and the schema carries no column for Kc, root depth or soil texture. Deficit is good
// EVIDENCE (published in the bergamot guide), not a trigger.
//
// THE COUNTER MUST HONOUR WHAT THE GARDENER ACTUALLY DID (V5-DROUGHTSPACE-001): "not just watering events
// but also rain events auto logged". The two sources got different answers:
//
//   AUTO-LOGGED RAIN EVENTS -> REFUSED AS A RESET SOURCE. They are weather_daily.precip_in under a different
//   primary key, not a second observation: handler.js logRainEvents selects the day's weather_daily row,
//   rainLog.rainDecision gates it on precip_source='gauge_merged' AND precip_in > 0.10, and the event's
//   quantity_numeric IS that precip_in. A rain event is a strict subset of what this counter already reads,
//   so adding it would double-count. Manual rain events carry no quantity and cannot be compared to a 0.60 in
//   bar. weather_daily's upsert is quality-ranked (WEATHER_DAILY_CONFLICT_SET), so a gauge figure is never
//   downgraded by a later model pass. droughtsignal.test.js pins this with a 0.29 in day carrying hundreds
//   of auto-logged rain events, which MUST still count as dry; it guards against a future lane "fixing"
//   this by adding rain events as a second source.
//
//   WATERING EVENTS -> ACCEPTED, at Space scope only, and NOT by a fabricated depth. No volume exists
//   (quantity_numeric is NULL on watering events). What exists is metadata.water_depth, the app's own
//   ordinal class ('light'|'normal'|'deep', the values ledger.rainDepthClass maps precip into). A 'deep'
//   watering and a >=0.60 in rain day are the same class in the app's own model: its existing vocabulary,
//   not an inches equivalence invented here. An UNANNOTATED watering is NOT evidence of a deep soak:
//   ledger.js rules that absent/unknown reads as 'normal', and this module honours that.
const LP = require('./ledgerParams');

// DERIVED, deliberately not a literal: this IS the in-ground `deep` class, and saying so in code keeps the
// trigger and the credit model describing the same physical event. RAIN_DEPTH_TIERS is the #1 soak-tune
// target, so a retune would silently move this trigger; droughtsignal.test.js pins today's value (0.60) as a
// canary so a retune goes red in a named test instead of quietly re-ruling a product decision.
const DEEP_SOAK_IN = LP.RAIN_DEPTH_TIERS.in_ground.deep;
// The product ruling. A literal, because it is a judgement about the plants, not a derivable quantity.
const DRY_DAYS = 20;
// Read window. Must exceed DRY_DAYS: 20 is the minimum to make the CLAIM, the headroom lets the note report
// the run's true length instead of capping at 20.
const WINDOW_DAYS = 30;

// ── THE AGGREGATION RULE ─────────────────────────────────────────────────────────────────────────
// Rain falls on the whole Space; watering is logged per planting. "Did ANY planting get deep water" does
// not answer "did the GARDEN get deep water" (watering two plants in a hundred is not a garden-wide soak).
// A day resets the garden-wide counter only when a deep watering SESSION covered at least this fraction of
// the plantings the run generated a plan for.
//
// A THIRD IS A JUDGEMENT AND IS LABELLED AS ONE: not derivable, so a named constant with a canary, like
// DRY_DAYS. It was chosen from the CLAIM (the fraction below which "the garden had deep water" stops being
// fair) and only then checked against the record, because a bar read off the sample is the free-variable
// objection that killed ET0 deficit. The recorded deep-watering days were bimodal: real sessions
// (roughly half the plan population) versus spot-watering (under 10%). 1/3 sits about 19 points from the
// nearest day on either side; 1/2 would clear the lowest session day by 2.3 points and flip on a change in
// annotation habit rather than in the garden. It also errs toward the failure the owner named: the app
// saying the garden is dry on a day it was watered.
const DEEP_WATER_SPACE_FRACTION = 1 / 3;
// A watering carrying an explicit water_depth_source of 'default' is the SYSTEM's assumption, not the
// user's statement, and must never reset a garden-wide claim about what they did. A missing source is
// treated as a declaration (fail-OPEN) because validators.js permits water_depth without a source, and a
// guard that goes silent the day the client stops sending an optional key is not a guard.
const SYSTEM_DEPTH_SOURCE = 'default';
const DEEP = 'deep';

const DAY = 86400000;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
function isIso(d) { return typeof d === 'string' && ISO.test(d.slice(0, 10)); }
function shiftDays(iso, n) {
  return new Date(new Date(iso.slice(0, 10) + 'T00:00:00Z').getTime() + n * DAY).toISOString().slice(0, 10);
}
function windowStart(today, days = WINDOW_DAYS) { return shiftDays(today, -days); }

// The 30-day precip series, read UNCONDITIONALLY: that is the point of the module.
//
// It does NOT ride readWeatherDaily, which is gated on CARE_WATER_LEDGER_ENABLED and so returns null in every
// production run (the flag is absent from the live env). Flipping it would arm the whole Water Ledger fold
// for both users at once, which the verdict forbids as an opening move; the drought path gets its own series
// and the ledger path behaves as before whether the flag is on or off.
//
// The seededgate reachability argument for gating readWeatherDaily does not apply: this handler already
// writes weather_daily UNCONDITIONALLY on every non-dry run (writeWeatherDaily, just above the call site),
// so the relation exists by the time this read is issued.
//
// Fails to null, for OBSERVABILITY not safety (evaluateDrought's coverage check refuses an empty or short
// series on its own): null lets the handler log "read failed" distinctly from "read fine, 5 dry days".
async function readDroughtSeries(pg, spaceId, fromDate, toDate) {
  try {
    const { rows } = await pg.query(
      `select "date"::text as date, precip_in
         from weather_daily
        where space_id = $1::uuid and "date" >= $2::date and "date" <= $3::date
        order by "date"`,
      [spaceId, fromDate, toDate]);
    return rows;
  } catch (e) {
    console.warn(JSON.stringify({ msg: 'drought series read failed — drought signal withheld', space: spaceId, error: e?.message }));
    return null;
  }
}

// The window's DEEP watering events, one row per (ET day, planting). V5-DROUGHTSPACE-001.
//
// BUCKETED IN America/New_York, NOT by a bare ::date. The Lambda's session is GMT, so an evening watering
// logged at 00:57 UTC is 20:57 ET the PREVIOUS day; a bare event_date::date would file it under tomorrow,
// out of step with weather_daily (whose "date" is the ET civil day) and with the day the user watered.
// ledger.js buckets by America/New_York for the same reason.
//
// NOT space-scoped in SQL: the caller intersects against the Space's own planting set, which is both the
// scope AND the denominator, so the two cannot drift. Read once per run, not once per Space. The +-1 day
// margins absorb the date->timestamptz cast, as readLedgerEvents does.
//
// Fails to null, and null is NOT "no waterings": see evaluateDrought's water_events_unavailable branch. A
// failed read means we cannot say whether they watered, so the signal refuses rather than answers wrongly.
async function readDeepWaterDays(pg, fromDate, toDate) {
  try {
    const { rows } = await pg.query(
      `select (e.event_date at time zone 'America/New_York')::date::text as date, e.plant_id
         from event_log e
        where e.event_type = 'watering'
          and e.deleted_at is null
          and e.plant_id is not null
          and e.metadata->>'water_depth' = $3::text
          and coalesce(e.metadata->>'water_depth_source', '') <> $4::text
          and e.event_date >= ($1::date - interval '1 day')
          and e.event_date <  ($2::date + interval '2 days')`,
      [fromDate, toDate, DEEP, SYSTEM_DEPTH_SOURCE]);
    return rows;
  } catch (e) {
    console.warn(JSON.stringify({ msg: 'deep-water event read failed — drought signal withheld', error: e?.message }));
    return null;
  }
}

// Pure. Rows -> the set of ET days on which a deep watering SESSION covered enough of this Space to falsify
// a garden-wide "no deep soak" claim. `plantIds` is the Space's plan population and is BOTH the scope
// filter and the denominator, so the fraction is never computed against a population the numerator was not
// drawn from.
//
// `coverage` carries every candidate day's count whether it qualified or not: a day that missed the bar by
// one planting differs from a day with no waterings, and only one is worth attention in CloudWatch.
function deepWaterResetDays(rows, plantIds, opts = {}) {
  const fraction = opts.fraction != null ? opts.fraction : DEEP_WATER_SPACE_FRACTION;
  const pop = plantIds instanceof Set ? plantIds : new Set(Array.isArray(plantIds) ? plantIds.map(String) : []);
  const out = { days: new Set(), coverage: {}, population: pop.size, fraction, required: 0, unavailable: false };
  // A Space with no plantings has no garden to claim about: a legitimate empty answer, NOT an unavailable read.
  if (!Array.isArray(rows)) { out.unavailable = true; return out; }
  if (pop.size === 0) return out;
  out.required = Math.max(1, Math.ceil(fraction * pop.size));
  const byDay = new Map();
  for (const r of rows) {
    if (!r || !isIso(r.date) || r.plant_id == null) continue;
    const id = String(r.plant_id);
    if (!pop.has(id)) continue;            // another Space, or a planting this run no longer plans for
    const d = r.date.slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, new Set());
    byDay.get(d).add(id);
  }
  for (const [d, ids] of byDay) {
    out.coverage[d] = ids.size;
    if (ids.size >= out.required) out.days.add(d);
  }
  return out;
}

// Walk back from `asOfDate` counting days whose measured precip is under the deep-soak bar.
//
// THE COVERAGE GUARD IS THE POINT. The claim is "no deep soak in the 20 days ENDING asOfDate". A counter
// handed 14 days would report "no deep soak in 14 days" and never fire, and one that skips a hole treats a
// possibly very wet day as dry. So a missing or non-finite day is ABSENT, never dry: the walk stops there,
// and if it stopped before 20 confirmed days the verdict is `insufficient`. Every day the fire decision
// rests on is one this function actually saw a number for.
//
// `>=` matches ledger.rainDepthClass's `precipIn >= t.deep`, so a day that classifies as a deep soak for
// rain credit also resets this counter. Exactly 0.60 in resets.
//
// V5-DROUGHTSPACE-001: `opts.waterResetDays` (a Set of ET days from deepWaterResetDays) resets the counter
// too. Omit it and this function behaves as it did before that change.
//
// status: 'dry' (fire) | 'ok' (no fire, and we know it) | 'insufficient' (cannot say; never fires)
function evaluateDrought(rows, opts = {}) {
  const deepSoakIn = opts.deepSoakIn != null ? opts.deepSoakIn : DEEP_SOAK_IN;
  const dryDaysRequired = opts.dryDays != null ? opts.dryDays : DRY_DAYS;
  const windowDays = opts.windowDays != null ? opts.windowDays : WINDOW_DAYS;
  const asOfDate = opts.asOfDate;
  const waterDays = opts.waterResetDays instanceof Set ? opts.waterResetDays : new Set();
  const base = { deepSoakIn, dryDaysRequired, dryDays: 0, lastDeepSoakDate: null, lastDeepWaterDate: null,
    resetBy: null, truncated: false, asOfDate: asOfDate || null };
  if (!isIso(asOfDate)) return { ...base, status: 'insufficient', gap: 'no_as_of_date', covered: 0 };
  // The watering read failed. "Did not water" and "could not find out whether they watered" are different
  // answers, and only the first supports saying the garden is dry. Refuse, as the short-series guard does.
  if (opts.waterEventsUnavailable === true) {
    return { ...base, status: 'insufficient', gap: 'water_events_unavailable', covered: 0 };
  }
  if (!Array.isArray(rows)) return { ...base, status: 'insufficient', gap: 'series_unavailable', covered: 0 };

  const byDate = new Map();
  for (const r of rows) {
    if (!r || !isIso(r.date)) continue;
    // Number(null) and Number('') are both 0, which would make a MISSING reading the driest possible day.
    // Rejected before the coercion; the numeric guard alone cannot see it.
    if (r.precip_in == null || r.precip_in === '') continue;
    const p = Number(r.precip_in);                   // pg numeric arrives as a string
    if (!Number.isFinite(p) || p < 0) continue;      // garbage: absent, NOT dry
    byDate.set(r.date.slice(0, 10), p);
  }

  let dryDays = 0, lastDeepSoakDate = null, lastDeepWaterDate = null, resetBy = null, truncated = false, day = asOfDate;
  for (;;) {
    // CHECKED FIRST, ahead of the coverage hole: a logged deep watering is direct evidence that does not
    // depend on the weather archive having a row for that day.
    if (waterDays.has(day)) { lastDeepWaterDate = day; resetBy = 'watering'; break; }
    if (!byDate.has(day)) { truncated = true; break; }           // hole: cannot claim past here
    if (byDate.get(day) >= deepSoakIn) { lastDeepSoakDate = day; resetBy = 'rain'; break; }   // reset
    dryDays++;
    if (dryDays >= windowDays) { truncated = true; break; }      // window exhausted, run is "at least" this
    day = shiftDays(day, -1);
  }
  // Stopped on a hole before we had enough confirmed days -> the honest answer is "don't know".
  // Stopping on a hole AFTER 20 confirmed dry days is fine: those 20 days were all observed.
  if (truncated && dryDays < dryDaysRequired) {
    return { ...base, status: 'insufficient', gap: 'short_series', covered: dryDays, needed: dryDaysRequired };
  }
  return { ...base, status: dryDays >= dryDaysRequired ? 'dry' : 'ok', dryDays, lastDeepSoakDate,
    lastDeepWaterDate, resetBy, truncated, covered: dryDays };
}

// The user-visible string. WORDING IS PART OF THE RULING: it names the DEEP SOAK, never "rain in N days".
// droughtsignal.test.js asserts both halves (the presence of "deep soak", the absence of a bare "no rain
// in"), so the category slip cannot come back through a reword.
function droughtNote(state) {
  if (!state || state.status !== 'dry') return null;
  return `Drought signal — no deep soak (>=${state.deepSoakIn.toFixed(2)} in of rain in one day) in `
    + `${state.truncated ? 'at least ' : ''}${state.dryDays} days. Check soil moisture at root depth.`;
}

// ── V5-DROUGHTSPACE-001: the GARDEN-WIDE line (one line, once, not per plant) ──────────────────────
// Dryness is measured per Space and is identical for every planting in it, so per-plant repetition would
// say the same sentence once per planting.
//
// SAME WORDING DISCIPLINE, pinned by the test suite here too: it names the DEEP SOAK, never "no rain in N
// days". It also names the watering half of the rule, because a number the user cannot explain ("why 6 days
// when it hasn't rained in 28?") is one they stop trusting.
function gardenDroughtNote(state) {
  if (!state || state.status !== 'dry') return null;
  return `The garden has not had a deep soak in ${state.truncated ? 'at least ' : ''}${state.dryDays} days`
    + ` — no day at or above ${state.deepSoakIn.toFixed(2)} in of rain, and no garden-wide deep watering.`
    + ' Check soil moisture at root depth.';
}

// The Space-level payload key, or null when the signal is not firing. Null means the caller spreads
// NOTHING, so a non-firing day writes a byte-identical plan row (the hydrology station keys do the same).
function gardenDrought(state) {
  const note = gardenDroughtNote(state);
  if (!note) return null;
  return {
    note,
    dry_days: state.dryDays,
    deep_soak_in: state.deepSoakIn,
    last_deep_soak: state.lastDeepSoakDate,
    last_deep_water: state.lastDeepWaterDate,
    truncated: state.truncated,
  };
}

module.exports = { DEEP_SOAK_IN, DRY_DAYS, WINDOW_DAYS, DEEP_WATER_SPACE_FRACTION, windowStart,
  readDroughtSeries, readDeepWaterDays, deepWaterResetDays, evaluateDrought, droughtNote,
  gardenDroughtNote, gardenDrought };
