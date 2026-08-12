// doneEvents.js — V3-TODAYDONE-001 read-time check-off vocabulary + the pure fold.
//
// DEPENDENCY-FREE ON PURPOSE. index.js imports @neondatabase/serverless + @clerk/backend +
// @aws-sdk/client-secrets-manager, none of which CI installs (ci.yml runs ONE root
// `npm ci --legacy-peer-deps`; there is no per-Lambda install), so no test can import index.js and
// every guard on it is source-text-only. Holding the vocabulary + the fold here makes the part that
// actually DECIDES "is this plan item done" executable in CI instead of merely regex-asserted.
//
// DEPLOY NOTE: deploy-lambda.yml / deploy-staging.yml zip each Lambda from its OWN directory
// (`cd lambda/<fn> && zip -r ../<fn>.zip .`), so this `./`-relative sibling IS packaged — the same
// per-dir rule household.js documents. A `../` import would not be.

// The event types that satisfy each actionable plan bucket for the day.
//
// V4-WATERMATH-001 F0 — `moisture_check` ("Not thirsty") joins water_due. It is its OWN event_type
// rather than an 'observation' precisely because 'observation' is in the pest set below: mapping the
// snooze onto 'observation' would have made one tap silently check off PEST tasks too.
//
// It is deliberately NOT in `no_history`. no_history means "this planting has never been watered";
// declaring the soil damp establishes no watering history, so a moisture_check must not retire it.
//
// Interim (pre-F2) freshness asymmetry: watering/rain satisfy for the ET calendar day, while a
// moisture_check also satisfies on a rolling `now() - 24h` window — see the annotateDone query in
// index.js and canon watering-cadence-math-design-V100 §"Pre-F2 interim snooze semantics". Without
// the rolling window a 09:00 snooze re-nags at the next morning's run ~21h later, which is the
// extinction pattern the design exists to avoid. Superseded by the engine fold at F2.
export const DONE_EVENTS = {
  water_due:  ['watering', 'rain', 'moisture_check'],
  no_history: ['watering', 'rain'],
  fertilize:  ['fertilizing'],
  pest:       ['observation', 'pest_treatment'],
  cold:       ['brought_inside', 'cover'],
};

// Every plant id referenced by an actionable bucket, for the done-derivation query's = ANY($1).
export function planItemIds(plan) {
  const ids = [];
  for (const k of Object.keys(DONE_EVENTS)) {
    for (const it of (plan?.[k] || [])) if (it && it.id) ids.push(it.id);
  }
  return ids;
}

// Pure fold: stamp `done` on each item of each actionable bucket. `sat` is a Set of
// `${plant_id}|${event_type}` strings built from the satisfying rows. Non-array buckets (and the
// plan's non-bucket keys) pass through untouched, so the response envelope never changes shape.
export function applyDone(plan, sat) {
  const out = { ...plan };
  for (const [k, types] of Object.entries(DONE_EVENTS)) {
    if (!Array.isArray(plan?.[k])) continue;
    out[k] = plan[k].map((it) => ({
      ...it,
      done: !!(it && it.id && types.some((t) => sat.has(`${it.id}|${t}`))),
    }));
  }
  return out;
}
