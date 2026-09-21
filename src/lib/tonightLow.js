// src/lib/tonightLow.js — V5-FROSTTWOMODELS-001. One low per night on Today.
//
// Today prints the night low in up to three places: the forecast card's moon figure, the weather cue
// ("Freeze tonight (N°F) — …") and the frost line ("Frost possible tonight — low N°F. …"). The first
// two read the PLAN low (NWS night period, floored by the yard station — lambda/daily-plan/index.js
// fetchNWS + station.js mergeStationWeather). The frost line reads the ADVISORY's own low (Open-Meteo's
// coldest D1..D3 day, or a radiative sky), and since BUG-FROSTADVISORYNIGHTWORDING-001 it can name
// TONIGHT. On those nights the screen carried two numbers for one night — "55°" on the card above
// "Frost possible tonight — low 38°F" — which is a contradiction the reader has to settle, and settling
// it costs trust in every figure on the page. Dave's call (2026-09-19): make them agree.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE RULE
//
// Trigger: the frost line Today renders (buildFrostAlertLine(plan.alerts_sent)) names tonight,
// nightOffset 0. No trigger -> null here, and every caller renders exactly what it rendered before.
// A line naming tomorrow night or a weekday is about a DIFFERENT night: tonight keeps the plan low and
// the line keeps its own number. A THRESHOLD imminent entry never renders as the frost line
// (frostAlertLine.js pickFrostLines), so it never triggers — the card and the cue already share the plan low
// on those nights. A RADIATIVE imminent entry renders as tonight's watch line (V5-TODAYRADIATIVEWATCH-001)
// and triggers like any line naming tonight: its low is the plan low it was sent at, and min() below keeps
// whichever is colder if a later run has moved the plan low.
// V5-TODAYFROSTLINEGAPS-001 — Today can render two frost lines now, one per night; the trigger is the one naming
// tonight (frostAlertLine.js tonightLineLow). A watch whose email printed a colder SECOND forecast for tonight
// ("Colder on a second forecast: 35°F tonight", stored as the entry's `colder`) contributes that figure: the line
// says "as low as 35°F", so the card and the cue say 35 too. That is this rule's own reason applied to one more
// number: the email named 35 for tonight, the line names it, and a card left at 39 would put two lows for one
// night back on the screen. The colder figure wins, as it does between the plan low and an advisory's. The
// "Forecast warmed to …" line names tonight too but never triggers: it prints the plan low itself.
//
// Shared low: Traw = min(plan low, the line's raw lowF), the colder one winning in both directions
// (a missing plan low leaves the advisory's). Every surface prints T = round(Traw), one whole number.
// The cue's freeze/cold split is taken on Traw, never on T, so rounding can never soften freeze into
// cold: a plan low of 39.6 keeps the freeze words and prints "(40°F)", exactly as the engine keys its
// own split on the unrounded low.
//
// WHAT THIS DOES NOT DO, deliberately (orchestrator decisions on the spec's Q1/Q2, 2026-09-19):
//   - A silent cue stays silent. When the frost line already says "Frost possible tonight", a second
//     line saying it again is noise, so agreeCallout never makes a cue speak that the engine left quiet,
//     and never touches heat/rain/wet — those carry no low to disagree with.
//   - Protect cards do not react to the colder low. That would change WHICH plants get a card, which
//     is care logic the engine owns (engine.js coldFor). careNeeded.js only drops the trailing
//     "(low …)" from their reason on trigger nights, so no third number stands beside the agreed one.
//   - The plan is never written. Everything here is pure and reads the stored plan; the server's care
//     decisions (Protect cards, the imminent tier and its emails) keep using the plan low they used.
//
// No source name, asterisk or "adjusted" mark on any surface (Jen-invisible rule): a mark raises a
// question the screen cannot answer, the same reasoning frostAlertLine.js gives for a line with no low.
//
// THE WORDING IS A COPY, AND THE COPY IS GUARDED. The engine is a CommonJS Lambda module and is not
// imported into the bundle, so agreeCallout carries a copy of engine.js computeCallout's freeze/cold
// branches. src/__tests__/tonightLow.test.js sweeps every whole-degree low 20..44 against the REAL
// computeCallout and deep-compares the result, so an engine copy change or a retuned threshold reds
// that test instead of leaving two wordings of one cue on the page.
import { tonightLineLow, FREEZE_BELOW_F } from './frostAlertLine.js'

/** The impression partition for a cue this module RE-WORDED (weatherCueImpressions.js bills it). A
 *  cue whose words and number came through unchanged keeps weatherCue.js WX_CUE_MODEL_VERSION: the
 *  version names the model that produced the line the reader saw, and here that is only true of the
 *  lines this module actually changed. The server stores any 1..40-character string
 *  (lambda/daily-plan-read/cue-impression.js resolveModelVersion), so no Lambda change goes with it. */
export const AGREED_CUE_MODEL_VERSION = 'wxcue-v1-agreed'

// engine.js computeCallout: `low<40` -> freeze, `low<45` -> cold. On a consistent plan the agreed low
// is never warmer than the plan low the engine keyed on (it is a min), so of these two the 40 split is
// the only one that can move; the 45 bound is kept so the copy reads as the engine's two branches.
// FREEZE_BELOW_F is imported from frostAlertLine.js (V5-TODAYFROSTLINEGAPS-001), whose "Forecast warmed" line
// starts exactly where this cue's freeze branch stops; tonightLow.test.js's PARITY sweep guards the one value for both.
const COLD_BELOW_F = 45
const freezeText = (t) => `Freeze tonight (${t}°F) — cover or bring peppers & tomatoes in`
const coldText = (t) => `Cool night (${t}°F) — protect flowering peppers/tomatoes`

// A number, or a non-empty numeric string, else null — the same acceptance frostAlertLine.js applies
// to an entry's lowF, so a plan low and an advisory low are read by one rule.
function finiteOrNull(v) {
  if (typeof v !== 'number' && !(typeof v === 'string' && v.trim() !== '')) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * PURE. The one low Today prints for tonight, or null when no frost line names tonight.
 * -> { lowF: T (whole °F), lowRaw: Traw } | null. Reads plan.alerts_sent and plan.weather.tonightLow;
 * writes nothing.
 */
export function agreedTonightLow(plan) {
  const alertsSent = plan ? plan.alerts_sent : null
  const lineRaw = tonightLineLow(alertsSent)
  if (lineRaw == null) return null
  const planRaw = finiteOrNull(plan.weather ? plan.weather.tonightLow : null)
  const lowRaw = planRaw == null ? lineRaw : Math.min(planRaw, lineRaw)
  return { lowF: Math.round(lowRaw), lowRaw }
}

/**
 * PURE. The engine's callout as Today renders it once `agreed` (agreedTonightLow's result) is set.
 * Returns the SAME object when nothing changes — no trigger, no callout, a heat/rain/wet cue, or a
 * freeze/cold cue whose words and number already match — so an un-triggered page is untouched down to
 * object identity. A re-worded cue is a new object carrying `modelVersion`, which buildCueLine passes
 * through to the impression beacon.
 */
export function agreeCallout(callout, agreed) {
  if (!agreed || !callout) return callout
  if (callout.icon !== 'freeze' && callout.icon !== 'cold') return callout
  let next = null
  if (agreed.lowRaw < FREEZE_BELOW_F) next = { icon: 'freeze', text: freezeText(agreed.lowF) }
  else if (agreed.lowRaw < COLD_BELOW_F) next = { icon: 'cold', text: coldText(agreed.lowF) }
  // Unreachable on a stored plan (see COLD_BELOW_F). An inconsistent payload keeps the engine's cue
  // rather than inventing a sentence the engine would not have written.
  if (!next) return callout
  if (next.icon === callout.icon && next.text === callout.text) return callout
  return { ...next, modelVersion: AGREED_CUE_MODEL_VERSION }
}

// coldFor's reasons end in one parenthesised low: "(low 39°F)", or "(low 55°F ≤ 60°F)" for a tender
// tropical. Only that trailing clause goes; the instruction in front of it is care logic and stays.
const LOW_CLAUSE = / \(low [^()]*\)$/

/** PURE. A Protect card's reason without its trailing " (low …)". Anything else comes back as given. */
export function withoutLowClause(text) {
  return typeof text === 'string' ? text.replace(LOW_CLAUSE, '') : text
}
