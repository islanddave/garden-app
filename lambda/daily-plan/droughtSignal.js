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
// status: 'dry' (fire) | 'ok' (no fire, and we know it) | 'insufficient' (cannot say — never fires)
function evaluateDrought(rows, opts = {}) {
  const deepSoakIn = opts.deepSoakIn != null ? opts.deepSoakIn : DEEP_SOAK_IN;
  const dryDaysRequired = opts.dryDays != null ? opts.dryDays : DRY_DAYS;
  const windowDays = opts.windowDays != null ? opts.windowDays : WINDOW_DAYS;
  const asOfDate = opts.asOfDate;
  const base = { deepSoakIn, dryDaysRequired, dryDays: 0, lastDeepSoakDate: null, truncated: false, asOfDate: asOfDate || null };
  if (!isIso(asOfDate)) return { ...base, status: 'insufficient', gap: 'no_as_of_date', covered: 0 };
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

  let dryDays = 0, lastDeepSoakDate = null, truncated = false, day = asOfDate;
  for (;;) {
    if (!byDate.has(day)) { truncated = true; break; }           // hole: cannot claim past here
    if (byDate.get(day) >= deepSoakIn) { lastDeepSoakDate = day; break; }   // reset
    dryDays++;
    if (dryDays >= windowDays) { truncated = true; break; }      // window exhausted, run is "at least" this
    day = shiftDays(day, -1);
  }
  // Stopped on a hole before we had enough confirmed days -> the honest answer is "don't know".
  // Stopping on a hole AFTER 20 confirmed dry days is fine: those 20 days were all observed.
  if (truncated && dryDays < dryDaysRequired) {
    return { ...base, status: 'insufficient', gap: 'short_series', covered: dryDays, needed: dryDaysRequired };
  }
  return { ...base, status: dryDays >= dryDaysRequired ? 'dry' : 'ok', dryDays, lastDeepSoakDate, truncated, covered: dryDays };
}

// The user-visible string. WORDING IS PART OF DAVE'S RULING: it names the DEEP SOAK, never "rain in N
// days". droughtsignal.test.js asserts both halves of that — the presence of "deep soak" and the absence
// of a bare "no rain in" — so the category slip cannot come back through a reword.
function droughtNote(state) {
  if (!state || state.status !== 'dry') return null;
  return `Drought signal — no deep soak (>=${state.deepSoakIn.toFixed(2)} in of rain in one day) in `
    + `${state.truncated ? 'at least ' : ''}${state.dryDays} days. Check soil moisture at root depth.`;
}

module.exports = { DEEP_SOAK_IN, DRY_DAYS, WINDOW_DAYS, windowStart, readDroughtSeries, evaluateDrought, droughtNote };
