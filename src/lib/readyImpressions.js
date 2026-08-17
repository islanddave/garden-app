// V4-READYTRAYIMPRESSION-001 — the weigh-in tray's impression beacon.
//
// WHAT THIS BUYS. The harvest-session tray (/log?session=harvest) offers up to 14 plantings at the
// top of the weigh-in flow. Which of them get tapped is already the signal "was this the right thing
// to surface" — but nothing records what was OFFERED, so a chip that was correct-and-not-yet-picked
// is today indistinguishable from a chip that was never on the screen. This module records the
// offer; the negative label is derived later by anti-joining the harvests logged that ET day. There
// is NO reject/defer control and none is planned (recon §D): a "not yet" button on a seeding tray,
// in a flow the user entered specifically to log harvests, would be UX noise.
//
// HARD RULE, inherited verbatim from src/lib/uxEvents.js: telemetry must NEVER block, delay, or
// throw into a user flow. sendReadyImpressions returns a promise that CANNOT reject and is never
// awaited by its caller. A failed beacon — offline, 500, the migration not yet applied — is
// invisible to the weigh-in, which is the only property here that actually matters.
//
// WHY IT RIDES apiFetch RATHER THAN A BESPOKE fetch LIKE uxEvents. uxEvents predates the prefix
// table and reads VITE_API_UX_EVENTS itself. /api/harvests is already in FUNCTION_URLS, so going
// through apiFetch means no new repo variable, the Clerk token is attached by the one code path that
// does that, and clientRouteLambdaContract.test.js covers the route automatically — a bespoke base
// URL would opt this path out of the guard that exists because a band once shipped fetching a route
// no Lambda served.

import { READY_MODEL_VERSION } from './harvestReadiness.js'

export { READY_MODEL_VERSION }

export const READY_IMPRESSIONS_PATH = '/api/harvests/ready-impressions'

// PURE. Turn the merged tray list into impression rows.
//
// `visiblePlantIds` is what selectTrayChips() actually rendered in the COLLAPSED tray — pass the
// output of that function, never a re-derived cap, so the label cannot drift from the pixels. Chips
// outside it are 'tray_tail': offered, but behind the "Show N more" disclosure and therefore not
// necessarily seen. That distinction is the difference between a precision claim and a guess, and it
// is the reason region is a column rather than a constant.
//
// slot is 1-based WITHIN each region, in tray order (rankHarvestReady's order for the ready block,
// then the recency fallback's) — mirroring watch_impression's per-region slot convention.
export function buildReadyImpressions(chips, visiblePlantIds) {
  const visible = visiblePlantIds instanceof Set ? visiblePlantIds : new Set(visiblePlantIds ?? [])
  const seen = new Set()
  const slots = { tray: 0, tray_tail: 0 }
  const out = []
  for (const c of chips ?? []) {
    if (!c?.plant_id || seen.has(c.plant_id)) continue
    seen.add(c.plant_id)
    const region = visible.has(c.plant_id) ? 'tray' : 'tray_tail'
    slots[region] += 1
    // The model's claim, frozen as shown — same rationale as the dismissal snapshot: recomputing it
    // later reads corrected reference data and a moved pick history, so a fit would train on numbers
    // the user never saw. A 'recent' chip came from the recency fallback and has NO model claim to
    // freeze; sending zeros there would launder a fallback into a model row.
    const isReady = c.source === 'ready'
    out.push({
      plant_id: c.plant_id,
      slot: slots[region],
      region,
      source: isReady ? 'ready' : 'recent',
      overdue_ratio: isReady && Number.isFinite(Number(c.overdue_ratio)) ? Number(c.overdue_ratio) : null,
      days_since_last_harvest: isReady ? nOrNull(c.days_since_last_harvest) : null,
      repeat_interval_days: isReady ? nOrNull(c.repeat_interval_days) : null,
    })
  }
  // A 'ready' chip whose ratio did not survive the freeze is dropped rather than downgraded to
  // 'recent': a model row with no rank coordinate cannot be calibrated against, and relabelling it
  // would quietly move it into the fallback population it was never part of.
  return out.filter((r) => r.source === 'recent' || r.overdue_ratio != null)
}

function nOrNull(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// Fire-and-forget. Swallows everything; never rejects; never returns anything the caller should act
// on. `keepalive` so a beacon issued as the tray settles survives the user immediately navigating or
// backgrounding the tab — the weigh-in flow is exactly the place someone taps away mid-request.
export async function sendReadyImpressions(apiFetch, chips, visiblePlantIds) {
  try {
    if (typeof apiFetch !== 'function') return
    const impressions = buildReadyImpressions(chips, visiblePlantIds)
    if (impressions.length === 0) return
    await apiFetch(READY_IMPRESSIONS_PATH, {
      method: 'POST',
      body: JSON.stringify({ model_version: READY_MODEL_VERSION, impressions }),
      keepalive: true,
    })
  } catch {
    // telemetry must never affect the weigh-in — swallow
  }
}
