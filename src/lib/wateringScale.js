// Watering-can scale (0-3, half steps). Derives the widget-level watering suggestion
// for Today's two lanes: containers (dry fast; rain under-serves dense/covered bags) and in-ground
// beds (hold moisture; benefit from rain). 0 = don't water · 1 = light · 2 = normal · 3 = deep soak,
// rounded to nearest 0.5. Intentionally COARSE: a glanceable widget cue, NOT per-plant cadence (that
// lives in the per-task rows). DrG (drgReasoning.js) is the WHY surface, Today the ACTION surface.
//
// ── THE THRESHOLDS ARE NOT HERE ──────────────────────────────────────────────────────────────────
// This module once carried its own private thresholds, separate from the daily-plan engine's, and
// the two straddled the same number: Today printed "All set — no watering needed today." directly
// above a full watering list. Nobody owned keeping two models consistent, and marking one "locked"
// only froze one of two models that had to move together. So the thresholds are imported from
// lambda/daily-plan/wateringThresholds.json, the same file the engine requires, and
// wateringModelParity.test.js fails if either side reintroduces a private copy. A number can still be
// tuned; it can no longer be tuned in one model only.
//
// Two rules follow, both toward the engine and toward watering:
//
//  1. HARMONIZED TO THE ENGINE. The engine is the more conservative model and it wins. Suppression is
//     the engine's three branches — soak (measured actuals >= SOAK_CAP_IN), incoming (already wet
//     AND >= SOAK_FCST_QPF_IN more coming at >= SOAK_FCST_POP_PCT), today (that same bar applied to
//     the still-expected part of today). The probability gate matters: a bare amount with a 28%
//     chance attached is not a reason to tell someone their garden is fine.
//
//  2. CONTAINERS ARE EXEMPT FROM FORECAST-BASED SUPPRESSION, ENTIRELY. A pot catches rain only over
//     its own footprint and a mature canopy sheds water away from it, so a forecast inch does not
//     reach a fabric bag the way it reaches a bed. The container lane therefore responds to MEASURED
//     water only (recent actuals + today's gauge reading) and never to a prediction — not the today
//     branch, not the tomorrow branch. The error costs are ~50:1 apart: a false WATER on a free-
//     draining bag costs nothing, while a false SKIP in August aborts flowers within 24h and locks in
//     blossom-end rot that shows up two weeks later. Under-watering is the expensive direction.
//
// Both rules move the widget toward saying "water", the agronomically safe direction and the one that
// stops it contradicting the list. The headline's absolute "All set" sentence carries a separate
// belt-and-braces guard in WeatherWidget.headlineFor, so a divergence cannot be silent.

import THRESHOLDS from '../../lambda/daily-plan/wateringThresholds.json'

// Named imports, not a bag spread: a typo'd key becomes undefined and silently disables a gate, so
// pull them out once, here, where the parity test can see them.
export const { SOAK_CAP_IN, SOAK_WET_FLOOR_IN, SOAK_FCST_QPF_IN, SOAK_FCST_POP_PCT } = THRESHOLDS

const clampHalf = (n) => Math.max(0, Math.min(3, Math.round(n * 2) / 2));

// Water actually IN the medium: recent actuals + what the gauge has already measured today. Mirrors
// the engine's `soakBasis` exactly (engine.js saturationSuppressed, today-aware branch). With no
// bound station `today_observed_in` is absent, so this degrades to `recent` and the whole D0 term is
// judged as forecast below — which is what it is on those plans.
export function measuredWater(hydrology = {}) {
  return (hydrology.recent_precip_in || 0) + (hydrology.today_observed_in || 0);
}

// The STILL-EXPECTED part of today. `??` not `||`: a real 0 remaining must not fall back to the day
// total. Mirrors the engine's todayForecastIn(). today_precip_in is measured + still-expected, so the
// measured share is counted once (above) and never re-gated here.
export function todayForecastIn(hydrology = {}) {
  return hydrology.today_remaining_in ?? hydrology.today_precip_in ?? 0;
}

// Tomorrow's rain defers a DRY bed. Mirrors the engine's 'incoming_dry' branch, which runs for every
// in-ground planting not transplanted in the last three weeks (generatePlan deferDryBedsEnabled;
// handler.js). Same bars as the wet-media branch, but a null PoP fails CLOSED toward watering: a dry bed
// is not deferred on an amount with no confidence attached. A missing recent_precip_in bails, as the
// engine's windowPrecip does. Containers never read this — a bag's top catches too little of a forecast
// inch (rule 2 above). The one client-side copy of the rule: the beds lane below, CareNeeded's
// bulk-water exclusion (careNeeded.bedWaitActive) and the parity sweep all go through it.
export function bedsWaitForRain(hydrology = {}) {
  if (hydrology.recent_precip_in == null) return false;
  const tmrwIn = hydrology.tomorrow_precip_in;
  const tmrwPop = hydrology.tomorrow_pop;
  return tmrwIn != null && tmrwIn >= SOAK_FCST_QPF_IN && tmrwPop != null && tmrwPop >= SOAK_FCST_POP_PCT;
}

// hydrology: { recent_precip_in, today_precip_in, today_pop, today_observed_in?, today_remaining_in?,
//              tomorrow_precip_in, tomorrow_pop, rain_coming }
// weather:   { hot:boolean, highToday:number }
export function computeWateringScale(hydrology = {}, weather = {}) {
  const hot = !!weather.hot;
  const measured = measuredWater(hydrology);
  const todayFcst = todayForecastIn(hydrology);
  const todayPop = hydrology.today_pop;
  // `tomorrow_precip_in` ONLY. A `?? upcoming_precip_in` fallback would diverge silently: the engine's
  // incoming branch reads tomorrow_precip_in and nothing else, so a plan carrying `upcoming` but not
  // `tomorrow` could hold the beds here while the engine watered them. The plan payload emits
  // tomorrow_precip_in unconditionally (engine.js generatePlan).
  const tmrwIn = hydrology.tomorrow_precip_in;
  const tmrwPop = hydrology.tomorrow_pop;
  // Missing precip means we know nothing, so we suppress nothing — the engine's windowPrecip returns
  // null on a null recent_precip_in and saturationSuppressed bails, and this mirrors that bail exactly.
  // Uncertainty resolves toward WATERING on both sides.
  const noData = hydrology.recent_precip_in == null;

  // The engine's three suppression branches, same constants, same fail-safe directions. Every bar
  // reads either the measured half or the forecast half, never the sum, so one event can never
  // satisfy both a wet floor and a more-coming bar.
  const soaked = !noData && measured >= SOAK_CAP_IN;
  // The "already wet" prerequisite reads MEASURED water, not `measured + todayFcst` (mirrors engine.js
  // saturationSuppressed): summing would let today's unelapsed hourly forecast pose as wetness and then
  // skip the beds on a second forecast. Both sides move together; the parity sweep in
  // wateringModelParity.test.js fails on a one-sided edit.
  // A null tomorrow PoP is permissive (matches the engine): tomorrow gets re-evaluated overnight
  // before anyone acts on it.
  const incoming = !noData && measured >= SOAK_WET_FLOOR_IN
    && tmrwIn != null && tmrwIn >= SOAK_FCST_QPF_IN
    && (tmrwPop == null || tmrwPop >= SOAK_FCST_POP_PCT);
  // A null TODAY PoP fails CLOSED toward watering (also matches the engine): fetchPrecip sets
  // today_pop:null whenever Open-Meteo omits it, and unknown probability is a data problem, not a
  // certainty.
  const todaySkip = !noData && todayFcst != null && todayFcst >= SOAK_FCST_QPF_IN
    && todayPop != null && todayPop >= SOAK_FCST_POP_PCT;

  // Containers: base 2 (normal), +1 when hot. MEASURED water only — no forecast may lower this lane.
  let containers = 2;
  if (hot) containers += 1;
  if (soaked) containers = 0;                            // rain that actually landed reached the bags
  else if (measured >= SOAK_WET_FLOOR_IN) containers -= 1;

  // In-ground beds: base 1.5 (hold moisture longer than containers), +1 when hot. Beds DO benefit
  // from forecast rain — they present the whole bed area to the sky — so all three branches apply,
  // plus the dry-bed deferral (bedsWaitForRain) the engine runs for in-ground plantings.
  let beds = 1.5;
  if (hot) beds += 1;
  if (measured >= SOAK_WET_FLOOR_IN) beds = Math.min(beds, 0.5);
  if (soaked || incoming || todaySkip || bedsWaitForRain(hydrology)) beds = 0;

  return {
    containers: clampHalf(containers),
    beds: clampHalf(beds),
    // Reported for callers/tests. `rain_coming` off the plan is deliberately NOT honoured as a lane
    // override any more: the engine emits it on a 0.3"/50% bar for DISPLAY only (it reaches no engine
    // gate — engine.js generatePlan), so letting it zero a lane would smuggle a third threshold set
    // back into a module whose entire defect was owning more than one.
    rainComing: incoming,
    rainToday: todaySkip,
  };
}

// Map a 0-3 level to a 3-slot can rail: [fill0, fill1, fill2] where each is 1 | 0.5 | 0.
export function canRail(level) {
  return [0, 1, 2].map((i) => clampHalf(Math.max(0, Math.min(1, level - i))));
}

// Pill state: active (>=0.5 -> emerald "do") vs wait (0 -> coral "pause").
export function pillState(level) {
  return level >= 0.5 ? 'do' : 'wait';
}
