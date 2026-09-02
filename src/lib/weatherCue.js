// src/lib/weatherCue.js — V5-WXCALLOUTRENDER-001. The display model for the daily weather cue.
//
// THE ENGINE IS NOT REWRITTEN AND ITS THRESHOLDS ARE NOT TOUCHED. lambda/daily-plan/engine.js
// computeCallout already decides WHICH cue fires: priority-ordered, one cue per day, an explicit
// silence branch, and it fired on 34 of 77 archived days (44% fire / 56% silent). It has had zero
// client consumers since it was written. The gap was never the reasoning — it was the render. This
// module does exactly one thing to the engine's output: it decides how the cue is WORDED.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY THREE OF THE FIVE RULES ARE RE-WORDED INTO CHECK-FORM
//
// Three of computeCallout's five rules are imperative ("cover or bring peppers & tomatoes in"). On
// 4 of 34 archived cue-days the cue FIRST EXISTED at the 15:30 run — i.e. after the action window
// had closed — on a surface Dave reads at 08:00. Shipping those unchanged ships a line that is
// sometimes stale and always commanding, which is precisely how a reader learns to discount a
// surface. Check-form ("did this get done?", "worth checking X") reads correctly whether the window
// is still open or already past, so it costs nothing on the days the cue is timely and stops
// lying on the days it is not.
//
// freeze and cold are EXEMPT and stay imperative. Both key on tonight's low, which is a forward
// statement about a night that has not happened yet at any hour Dave reads this — so unlike the
// other three they are not stale at 08:00, and softening "cover the peppers" into a question would
// weaken the one cue whose cost of inaction is a dead plant.
//
// THE CONDITION HALF IS THE ENGINE'S, VERBATIM. Every cue string is "<condition> — <action>". The
// condition half carries the engine's numbers (including the probability-weighted rain figure
// DRG-WXPROB-001 computes) and is passed through untouched; only the action half is replaced. It is
// NOT re-derived client-side from plan.weather/plan.hydrology: re-deriving would duplicate engine
// arithmetic in a second place and let the two drift, which is the failure mode BUG-TODAYWATER-001
// already produced once on this screen.
//
// AND IT FAILS CLOSED. If a check-form cue's text does not carry the separator, this module returns
// null and the line does not render at all, rather than falling back to the imperative string. A
// check-form rule is a binding condition of the render, so "could not honour it" must mean silence,
// not a quiet reversion. weatherCue.test.js runs the REAL computeCallout output through here so an
// engine copy change reds a test instead of silently darkening the cue.
//
// NO THRESHOLD LIVES HERE, AND NONE MAY. The crucible established that PoP is skilful at this site
// (POD 0.727, FAR 0.11, BSS +0.589 at the >0.10in event) while forecast AMOUNT is not (FAR 0.61),
// so any gate must key on probability. This module gates on nothing at all — it takes the cue the
// engine chose and words it — which is the only way to be certain it introduces no amount-keyed
// threshold. (The engine's own rain gate is a conjunction of amount and PoP; changing it is
// engine work, deliberately out of scope here.)

/** Mirrored server-side by lambda/daily-plan-read/cue-impression.js, pinned in lockstep by its test.
 *  Bump when the WORDING changes, not when the engine's gates do — this constant partitions
 *  impressions by the model that produced the line the reader saw. */
export const WX_CUE_MODEL_VERSION = 'wxcue-v1'

/** engine.js computeCallout's five icons -> the form each renders in. Closed set: a cue not named
 *  here renders nothing, so a sixth engine rule cannot ship an un-reviewed wording by inheritance. */
export const CUE_FORM = {
  freeze: 'imperative',
  cold: 'imperative',
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

/** The engine's own separator between the condition and the action halves (engine.js:970-984). */
export const CUE_SEPARATOR = ' — '

/**
 * PURE. Turn one engine callout into the line Today renders, or null for "render nothing".
 *
 * Returns { cue, form, text }. `cue` is the engine's rule name and is what the impression row
 * records — the icon field is a rule identity here, not a glyph.
 */
export function buildCueLine(callout) {
  const cue = callout?.icon
  const text = typeof callout?.text === 'string' ? callout.text : ''
  const form = CUE_FORM[cue]
  if (!form || !text) return null

  if (form === 'imperative') return { cue, form, text }

  const i = text.indexOf(CUE_SEPARATOR)
  const condition = i > 0 ? text.slice(0, i) : ''
  const clause = CHECK_CLAUSE[cue]
  // Fail closed, not back to the imperative string — see the header.
  if (!condition || !clause) return null
  return { cue, form, text: `${condition}${CUE_SEPARATOR}${clause}` }
}
