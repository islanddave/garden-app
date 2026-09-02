// src/lib/weatherCueImpressions.js — OPS-CUEINSTRUMENT-001. The weather cue's impression beacon.
//
// WHAT THIS BUYS. V5-WXCALLOUTRENDER-001 puts one weather line on Today to find out whether Dave
// acts on it. Nothing else records that the line was on screen, so without this a cue that was shown
// and correctly ignored is indistinguishable from a cue that never fired, and every later claim
// about the surface is unfalsifiable. This module records the exposure; the label is derived later
// from what was logged that ET day. It is a PRECONDITION of the render, not a follow-up — the app
// already ran this experiment once with public.ready_impression, lost the instrument to
// V4-WEIGHQUEUEKILL-001, and the six surviving days are still the only evidence anyone has.
//
// HARD RULE, inherited verbatim from src/lib/uxEvents.js and src/lib/readyImpressions.js: telemetry
// must NEVER block, delay, or throw into a user flow. sendCueImpression returns a promise that
// CANNOT reject and is never awaited by its caller. A failed beacon — offline, 500, the migration
// not yet applied — is invisible to Today, which is the only property here that actually matters.
//
// WHY IT RIDES apiFetch. /api/daily-plan is already in FUNCTION_URLS and resolution is first-match
// on prefix, so '/api/daily-plan/cue-impressions' lands on lambda/daily-plan-read with no new repo
// variable and no api.js edit, the Clerk token is attached by the one code path that does that, and
// clientRouteLambdaContract.test.js covers the route automatically — a bespoke base URL would opt
// this path out of the guard that exists because a band once shipped fetching a route no Lambda
// served.
//
// NO CLIENT-SIDE DAY DEDUPE, DELIBERATELY. The per-day grain is enforced SERVER-side by
// uq_weather_cue_impression_day + ON CONFLICT DO NOTHING, against the server's ET clock. Duplicating
// that in the browser would put the dedupe grain on a device clock and split one evening across two
// "days" for five hours every night. The caller's per-render guard exists only to stop React
// re-renders issuing needless requests, not to own correctness.

import { WX_CUE_MODEL_VERSION } from './weatherCue.js'

export { WX_CUE_MODEL_VERSION }

export const CUE_IMPRESSIONS_PATH = '/api/daily-plan/cue-impressions'

/**
 * Fire-and-forget. Swallows everything; never rejects; never returns anything the caller should act
 * on. `keepalive` so a beacon issued as Today paints survives the user immediately navigating —
 * the first tap after opening Today is exactly the moment this fires.
 *
 * `line` is buildCueLine's output: the cue that was rendered and the FORM it was rendered in.
 * Sending the form is what makes the check-form/imperative split measurable rather than assumed.
 * `planGeneratedAt` is the read model's own generated_at — which nightly run produced the cue.
 */
export async function sendCueImpression(apiFetch, line, planGeneratedAt = null) {
  try {
    if (typeof apiFetch !== 'function') return
    if (!line?.cue || !line?.form) return
    await apiFetch(CUE_IMPRESSIONS_PATH, {
      method: 'POST',
      body: JSON.stringify({
        cue: line.cue,
        form: line.form,
        model_version: WX_CUE_MODEL_VERSION,
        plan_generated_at: planGeneratedAt ?? null,
      }),
      keepalive: true,
    })
  } catch {
    // telemetry must never affect Today — swallow
  }
}
