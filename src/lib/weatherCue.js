// The display model for the daily weather cue.
//
// THE ENGINE IS NOT REWRITTEN AND ITS THRESHOLDS ARE NOT TOUCHED. lambda/daily-plan/engine.js
// computeCallout already decides WHICH cue fires: priority-ordered, one cue per day, an explicit
// silence branch. The gap was never the reasoning, it was the render. This module does exactly one thing
// to the engine's output: it decides how the cue is WORDED.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY THREE OF THE SIX RULES ARE RE-WORDED INTO CHECK-FORM
//
// Three of computeCallout's rules are imperative ("cover or bring peppers & tomatoes in"), but some cues
// first exist at the 15:30 run, after the action window has closed, on a surface read at 08:00.
// Shipping those unchanged ships a line that is sometimes stale and always commanding, which is how a
// reader learns to discount a surface. Check-form ("did this get done?", "worth checking X") reads
// correctly whether the window is still open or already past.
//
// freeze, cold and cool are EXEMPT and stay imperative. They key on tonight's low, a forward statement
// about a night that has not happened at any hour this is read, so they are not stale at 08:00, and
// softening "cover the peppers" into a question would weaken the cue whose cost of inaction is a dead
// plant. For `cool` (a 45-50°F low between May 1 and Oct 31) there is one more reason: its action half
// is the engine's SEASON words, which a fixed check clause would discard.
//
// THE CONDITION HALF IS THE ENGINE'S, VERBATIM. Every cue string is "<condition> — <action>". The
// condition half carries the engine's numbers (including the rain amount and chance) and is passed
// through untouched; only the action half is replaced. It is NOT re-derived client-side from
// plan.weather/plan.hydrology: re-deriving would duplicate engine arithmetic in a second place and let
// the two drift.
// ONE EXCEPTION, OUTSIDE THIS MODULE: on a night the frost line names as tonight, Today hands this
// module a freeze/cold callout re-worded at the one low it prints for the night (src/lib/tonightLow.js
// agreeCallout — a copy of the engine's two branches, swept against the REAL computeCallout by
// tonightLow.test.js). Such a callout carries `modelVersion`, and buildCueLine passes it through so the
// impression is partitioned by the model that produced the words.
//
// AND IT FAILS CLOSED. If a check-form cue's text does not carry the separator, this module returns
// null and the line does not render at all, rather than falling back to the imperative string. A
// check-form rule is a binding condition of the render, so "could not honour it" must mean silence,
// not a quiet reversion. weatherCue.test.js runs the REAL computeCallout output through here so an
// engine copy change reds a test instead of silently darkening the cue.
//
// NO THRESHOLD LIVES HERE, AND NONE MAY. Forecast PROBABILITY is skilful at this site while forecast
// AMOUNT is not, so any gate must key on probability. This module gates on nothing at all — it takes
// the cue the engine chose and words it — which is the only way to be certain it introduces no
// amount-keyed threshold. (The engine's own rain gate is a conjunction of amount and PoP; changing it
// is engine work.)

/** Mirrored server-side by lambda/daily-plan-read/cue-impression.js, pinned in lockstep by its test.
 *  Bump when the WORDING changes, not when the engine's gates do — this constant partitions
 *  impressions by the model that produced the line the reader saw. */
// v2: the rain cue's condition half prints the amount and the chance side by side
// (`0.58" rain tomorrow (100% chance)`) instead of amount x PoP.
// v3: a sixth cue, `cool` (45-50°F, season words), and the cold cue's heading reads "Cold night" with
// fall words from Aug 15 to Oct 31.
export const WX_CUE_MODEL_VERSION = 'wxcue-v3'

/** engine.js computeCallout's six icons -> the form each renders in. Closed set: a cue not named
 *  here renders nothing, so a seventh engine rule cannot ship an un-reviewed wording by inheritance.
 *  `cool` is imperative because its action half is the engine's season words (cover
 *  young plants in spring, pick what is coloring in fall); a check clause is one fixed string and would
 *  throw the season away. Like freeze and cold it keys on tonight's low, so it is not stale at 08:00. */
export const CUE_FORM = {
  freeze: 'imperative',
  cold: 'imperative',
  cool: 'imperative',
  heat: 'check',
  rain: 'check',
  wet: 'check',
}

/** The replacement action clause for each check-form cue. Asks whether the thing was done, or offers
 *  it as something to check — never commands it. Written to read the same at 08:00 and at 18:00. */
export const CHECK_CLAUSE = {
  heat: 'did the thirsty crops get a deep soak? Worth a look for anything wilting.',
  rain: 'did the containers get watered today? In-ground beds can wait for it.',
  wet: 'worth checking the soil before watering anything outdoors.',
}

/** The engine's own separator between the condition and the action halves (engine.js computeCallout). */
export const CUE_SEPARATOR = ' — '

/**
 * PURE. Turn one engine callout into the line Today renders, or null for "render nothing".
 *
 * Returns { cue, form, text }. `cue` is the engine's rule name and is what the impression row
 * records — the icon field is a rule identity here, not a glyph.
 * `modelVersion` is added ONLY when the callout carries one as a non-empty string (a cue Today
 * re-worded, src/lib/tonightLow.js). An engine callout has none, and its line is the
 * same three keys as before.
 */
export function buildCueLine(callout) {
  const cue = callout?.icon
  const text = typeof callout?.text === 'string' ? callout.text : ''
  const form = CUE_FORM[cue]
  if (!form || !text) return null
  const mv = typeof callout.modelVersion === 'string' && callout.modelVersion ? { modelVersion: callout.modelVersion } : {}

  if (form === 'imperative') return { cue, form, text, ...mv }

  const i = text.indexOf(CUE_SEPARATOR)
  const condition = i > 0 ? text.slice(0, i) : ''
  const clause = CHECK_CLAUSE[cue]
  // Fail closed, not back to the imperative string — see the header.
  if (!condition || !clause) return null
  return { cue, form, text: `${condition}${CUE_SEPARATOR}${clause}`, ...mv }
}
