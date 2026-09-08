'use strict';
// ── V5-LEGACYEXCEPTIONCARE-001 — the drought signal ───────────────────────────────────────────────
// Consecutive settled days with NO ROOT-ZONE-WETTING RAIN. Dave's ruling, 2026-09-08: fire after 20
// consecutive days without a single day of >=0.60 in.
//
// WHAT THIS IS NOT, and the distinction is load-bearing in every user-visible string this file emits:
// 0.60 in is the in-ground **deep** class of the app's own RAIN_DEPTH_TIERS, not `light` (0.10) and not
// a gauge's tipping resolution (0.01). So the statistic is "no DEEP SOAK in N days" — NEVER "no rain in
// N days". Calling a deep-soak threshold "rain" is the exact category slip that falsified the first
// version of crucible Verdict 3 (project-state/crucible-weathercue-verdict-V100-20260908.md, the
// correction block): that verdict fixed the depth from the `light` row and the day-count from
// `deep`-row evidence, which specified a branch that fires zero times in the whole archive.
//
// WHY (0.60, 20) AND NOT A PAIR THAT FITS THIS SEASON BETTER. Depth and day-count are ONE parameter.
// Measured over live weather_daily 2026-05-10..2026-09-07 (121 rows, zero null precip_in), runs >=20d
// at 0.10 in: 0. At 0.25 in: 0. At 0.60 in: 2 (2026-05-25..2026-06-21 and 2026-08-04..2026-08-31, the
// latter taking 0.81 in across 28 days). (0.60, 20) is the only pairing NOT read off this season's own
// maxima — Dave described it before any measurement — so it is the only one that is not fitted to the
// single sample it would then be validated against. The alternatives (0.10 in with 13 or 10 days) are
// the same free-variable objection that rejected ET0-deficit's crop coefficient, wearing a new coat.
//
// DO NOT REINTRODUCE ET0 DEFICIT. Rejected on measurement, not taste: a Kc between 0.55 and 1.00 swings
// the peach's stress-day count 0% -> 64%, and the schema carries no column for Kc, root depth or soil
// texture. Deficit remains excellent EVIDENCE and is published in the bergamot guide; it is not a trigger.
//
// ── V5-DROUGHTSPACE-001 (Dave, 2026-09-08) — THE COUNTER MUST HONOUR WHAT HE ACTUALLY DID ────────
// Verbatim: "ensure it is not just about watering events but also rain events auto logged."
// Two sources were investigated against live prod (garden_ro, 2026-09-08). They did NOT get the same
// answer, and the difference is the whole of this change:
//
//   AUTO-LOGGED RAIN EVENTS -> REFUSED AS A RESET SOURCE. They are weather_daily.precip_in under a
//   different primary key, not a second observation. handler.js logRainEvents SELECTS the day's
//   weather_daily row, rainLog.rainDecision gates it on precip_source='gauge_merged' AND
//   precip_in > 0.10, and the amount written to event_log.quantity_numeric IS that precip_in.
//   Measured: 17 rain-event days in the whole record, ZERO without a matching weather_daily row,
//   ZERO whose quantity differs from that row's precip_in. So a rain event is a STRICT SUBSET of what
//   this counter already reads (gauge-only, and the counter reads every source), and can never reset a
//   day weather_daily does not already reset. Adding it would be double-counting by definition.
//   Manual rain events (686 rows, 6 days, all pre-2026-07-19 — Dave logging rain by hand) carry NO
//   quantity at all and cannot be compared to a 0.60 in bar. weather_daily's upsert is quality-ranked
//   (WEATHER_DAILY_CONFLICT_SET) so a gauge figure can never be downgraded by a later model pass
//   either, which closes the last door in which a rain event could be the more faithful record.
//   droughtsignal.test.js pins this with the live 2026-09-06 day: 0.29 in, 218 auto-logged rain
//   events, and it MUST still count as a dry day. That test is the guard against a future lane
//   "fixing" this by adding rain events as a second source.
//
//   WATERING EVENTS -> ACCEPTED, at Space scope only, and NOT by a fabricated depth. There is no
//   volume anywhere: quantity_numeric is NULL on all 10,229 watering events. What exists is
//   metadata.water_depth, the app's OWN ordinal class ('light'|'normal'|'deep' — the same three
//   values, same spelling, that ledger.rainDepthClass maps precip into), on 1,337 of them. A
//   'deep' watering and a >=0.60 in rain day are the same class in the app's own model, so this is
//   the app's existing vocabulary, not an inches equivalence invented here. An UNANNOTATED watering
//   is NOT evidence of a deep soak: ledger.js already rules that absent/unknown reads as 'normal',
//   and this module honours that ruling rather than inventing a second one.
const LP = require('./ledgerParams');

// DERIVED, deliberately not a literal — this IS the in-ground `deep` class, and saying so in code is
// what keeps the trigger and the credit model talking about the same physical event. Same posture as
// ledgerParams' RAIN_DEPTH.unknown derivation, and it carries the same obligation: RAIN_DEPTH_TIERS is
// documented as the #1 soak-tune target, so a retune would silently move this trigger. That is why
// droughtsignal.test.js pins what this evaluates to TODAY (0.60) as a canary — a retune goes red in a
// named test and reaches Dave, instead of quietly re-ruling a decision he made.
const DEEP_SOAK_IN = LP.RAIN_DEPTH_TIERS.in_ground.deep;
// Dave's ruling. A literal, because it is a judgement about his plants and not a derivable quantity.
const DRY_DAYS = 20;
// Read window. Must exceed DRY_DAYS: 20 is the minimum needed to make the CLAIM, the headroom is what
// lets the note report the run's true length (the real 2026-08 run is 28 days) instead of capping at 20.
const WINDOW_DAYS = 30;

// ── THE AGGREGATION RULE, AND WHY IT IS THIS ONE ─────────────────────────────────────────────────
// Rain falls on the whole Space; watering is logged per planting. So "did the GARDEN get deep water"
// cannot be answered by "did ANY planting get deep water" — Dave's own framing: watering two plants in
// a hundred-plant Space is not a garden-wide soak. A day resets the garden-wide counter only when a
// deep watering SESSION covered at least this fraction of the plantings the run generated a plan for.
//
// A THIRD IS A JUDGEMENT AND IS LABELLED AS ONE. It is not derivable, so it is a named constant with a
// canary, exactly like DRY_DAYS. It was chosen from the CLAIM (a fraction below which "the garden had
// deep water" stops being a fair description of the day) and only then checked against the record —
// that order matters, because a bar read off the sample is the free-variable objection that killed
// ET0 deficit. Measured live 2026-09-08 over every deep-watering day in the record, against a plan
// population of 216:
//     ET 2026-08-24  113/216 = 52.3%   a real session (186 of 216 watered that evening)  -> RESETS
//     ET 2026-08-28   20/216 =  9.3%   spot-watering                                     -> does not
//     ET 2026-08-31   10/216 =  4.6%   spot-watering                                     -> does not
//     ET 2026-09-03    5/216 =  2.3%   spot-watering                                     -> does not
// The distribution is bimodal (he waters the garden, or he spots a few plants), so 1/3 and 1/2 agree
// on every day in the record; 1/3 is chosen because it sits ~19 points above the highest non-session
// day and ~19 below the lowest session day, where 1/2 clears 2026-08-24 by 2.3 points and would flip
// on a change in annotation habit rather than in the garden. It also errs toward the failure Dave
// named — the app telling him the garden is dry on a day he watered it.
const DEEP_WATER_SPACE_FRACTION = 1 / 3;
// A watering carrying an explicit water_depth_source of 'default' is the SYSTEM's assumption, not
// Dave's statement, and must never reset a garden-wide claim about what he did. A missing source is
// treated as a declaration (fail-OPEN) because validators.js permits water_depth without a source, and
// a guard that goes silent the day the client stops sending an optional key is a guard that is not there.
const SYSTEM_DEPTH_SOURCE = 'default';
const DEEP = 'deep';

const DAY = 86400000;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
function isIso(d) { return typeof d === 'string' && ISO.test(d.slice(0, 10)); }
function shiftDays(iso, n) {
  return new Date(new Date(iso.slice(0, 10) + 'T00:00:00Z').getTime() + n * DAY).toISOString().slice(0, 10);
}
function windowStart(today, days = WINDOW_DAYS) { return shiftDays(today, -days); }

// The 30-day precip series, read UNCONDITIONALLY — this is the whole point of the module.
//
// It does NOT ride readWeatherDaily, which is gated on CARE_WATER_LEDGER_ENABLED and therefore returns
// null in every production run (the flag is absent from the live garden-daily-plan env, verified in AWS
// 2026-09-08). Flipping that flag would arm the entire Water Ledger fold for both users at once, which
// the verdict's "What NOT to do" forbids as an opening move; so the drought path gets its own series and
// the ledger path keeps behaving exactly as it does today whether the flag is on or off.
//
// The seededgate reachability argument that justifies gating readWeatherDaily does not apply here: this
// same handler already writes weather_daily UNCONDITIONALLY on every non-dry run (writeWeatherDaily,
// immediately above the call site), so the relation is known to exist by the time this read is issued.
//
// Fails to null, and the null is for OBSERVABILITY, not for safety — evaluateDrought's coverage check
// refuses an empty or short series on its own, so a fail-open [] would be equally safe. Returning null
// lets the handler log "read failed" distinctly from "read fine, 5 dry days".
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
// BUCKETED IN America/New_York, NOT by a bare ::date. The Lambda's session is GMT, and the 130-planting
// session that this whole change exists to honour was logged at 00:57 UTC — 20:57 ET the PREVIOUS
// evening. A bare event_date::date files an evening watering under tomorrow, one day out of step with
// weather_daily (whose "date" is the ET civil day) and with the day Dave believes he watered. ledger.js
// buckets by America/New_York for the same reason; this matches it rather than inventing a second clock.
//
// NOT space-scoped in SQL: the caller intersects against the Space's own planting set, which is both the
// scope AND the denominator, so the two cannot drift. Read once per run, not once per Space.
// The +-1 day margins absorb the date->timestamptz cast, exactly as readLedgerEvents does.
//
// Fails to null, and null here is NOT "no waterings" — see evaluateDrought's water_events_unavailable
// branch. A failed read means we cannot say whether he watered, and this signal refuses rather than
// answers wrongly.
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

// Pure. Rows -> the set of ET days on which a deep watering SESSION covered enough of this Space to
// falsify a garden-wide "no deep soak" claim. `plantIds` is the Space's plan population and serves as
// BOTH the scope filter and the denominator, so the fraction can never be computed against a
// population the numerator was not drawn from.
//
// `coverage` carries every candidate day's count whether it qualified or not — a day that missed the
// bar by one planting and a day with no waterings at all are different facts, and only one of them is
// worth Dave's attention in CloudWatch.
function deepWaterResetDays(rows, plantIds, opts = {}) {
  const fraction = opts.fraction != null ? opts.fraction : DEEP_WATER_SPACE_FRACTION;
  const pop = plantIds instanceof Set ? plantIds : new Set(Array.isArray(plantIds) ? plantIds.map(String) : []);
  const out = { days: new Set(), coverage: {}, population: pop.size, fraction, required: 0, unavailable: false };
  // A Space with no plantings has no garden to make a claim about and no watering that could reset one.
  // That is a legitimate empty answer, NOT an unavailable read.
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
// THE COVERAGE GUARD IS THE POINT, not decoration. The claim being made is "no deep soak in the 20 days
// ENDING asOfDate". A 20-day counter handed 14 days of data will happily report "no deep soak in 14
// days" and never fire, and a counter that skips a hole treats a day that may have carried 2 in of rain
// as dry. So a missing or non-finite day is ABSENT, never dry: the walk stops there, and if it stopped
// before 20 confirmed days the verdict is `insufficient` — refuse loudly rather than answer wrongly.
// Every day the fire decision rests on is one this function has actually seen a number for.
//
// `>=` matches ledger.rainDepthClass's `precipIn >= t.deep`, so a day that classifies as a deep soak for
// rain credit is the same day that resets this counter. Exactly 0.60 in resets.
//
// V5-DROUGHTSPACE-001 — `opts.waterResetDays` (a Set of ET days from deepWaterResetDays) resets the
// counter too. Omit it and this function behaves exactly as it did before the change.
//
// status: 'dry' (fire) | 'ok' (no fire, and we know it) | 'insufficient' (cannot say — never fires)
function evaluateDrought(rows, opts = {}) {
  const deepSoakIn = opts.deepSoakIn != null ? opts.deepSoakIn : DEEP_SOAK_IN;
  const dryDaysRequired = opts.dryDays != null ? opts.dryDays : DRY_DAYS;
  const windowDays = opts.windowDays != null ? opts.windowDays : WINDOW_DAYS;
  const asOfDate = opts.asOfDate;
  const waterDays = opts.waterResetDays instanceof Set ? opts.waterResetDays : new Set();
  const base = { deepSoakIn, dryDaysRequired, dryDays: 0, lastDeepSoakDate: null, lastDeepWaterDate: null,
    resetBy: null, truncated: false, asOfDate: asOfDate || null };
  if (!isIso(asOfDate)) return { ...base, status: 'insufficient', gap: 'no_as_of_date', covered: 0 };
  // The watering read failed. "He did not water" and "we could not find out whether he watered" are
  // different answers, and only one of them supports telling him his garden is dry — the failure this
  // whole change exists to stop. Refuse, loudly, exactly as the short-series guard does.
  if (opts.waterEventsUnavailable === true) {
    return { ...base, status: 'insufficient', gap: 'water_events_unavailable', covered: 0 };
  }
  if (!Array.isArray(rows)) return { ...base, status: 'insufficient', gap: 'series_unavailable', covered: 0 };

  const byDate = new Map();
  for (const r of rows) {
    if (!r || !isIso(r.date)) continue;
    // Number(null) and Number('') are both 0, which would silently make a MISSING reading the driest
    // possible day. Rejected before the coercion, not after — the numeric guard alone cannot see it.
    if (r.precip_in == null || r.precip_in === '') continue;
    const p = Number(r.precip_in);                   // pg numeric arrives as a string
    if (!Number.isFinite(p) || p < 0) continue;      // garbage: absent, NOT dry
    byDate.set(r.date.slice(0, 10), p);
  }

  let dryDays = 0, lastDeepSoakDate = null, lastDeepWaterDate = null, resetBy = null, truncated = false, day = asOfDate;
  for (;;) {
    // CHECKED FIRST, ahead of the coverage hole. A logged deep watering is direct evidence of what
    // happened in the garden and does not depend on the weather archive having a row for that day, so a
    // gap in weather_daily must not blind the counter to a soak Dave logged himself.
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

// The user-visible string. WORDING IS PART OF DAVE'S RULING: it names the DEEP SOAK, never "rain in N
// days". droughtsignal.test.js asserts both halves of that — the presence of "deep soak" and the absence
// of a bare "no rain in" — so the category slip cannot come back through a reword.
function droughtNote(state) {
  if (!state || state.status !== 'dry') return null;
  return `Drought signal — no deep soak (>=${state.deepSoakIn.toFixed(2)} in of rain in one day) in `
    + `${state.truncated ? 'at least ' : ''}${state.dryDays} days. Check soil moisture at root depth.`;
}

// ── V5-DROUGHTSPACE-001 — the GARDEN-WIDE line (Dave's ruling: one line, once, not per plant) ─────
// The dryness is measured per Space and is identical for every planting in it, so per-plant repetition
// would say the same sentence up to 216 times. It is also how he described the problem: he noticed THE
// GARDEN was dry.
//
// SAME WORDING DISCIPLINE, and the test suite pins it here too: it names the DEEP SOAK and never says
// "no rain in N days". It also names the watering half of the rule, because a number Dave cannot
// explain to himself ("why does it say 6 days when it hasn't rained in 28?") is a number he stops
// trusting — and after this change the answer really is "because you watered the garden on the 24th".
function gardenDroughtNote(state) {
  if (!state || state.status !== 'dry') return null;
  return `The garden has not had a deep soak in ${state.truncated ? 'at least ' : ''}${state.dryDays} days`
    + ` — no day at or above ${state.deepSoakIn.toFixed(2)} in of rain, and no garden-wide deep watering.`
    + ' Check soil moisture at root depth.';
}

// The Space-level payload key, or null when the signal is not firing. Null means the caller spreads
// NOTHING, so a non-firing day writes a byte-identical plan row — the same conditional-spread discipline
// the hydrology station keys use.
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
