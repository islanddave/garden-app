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
//
// `doctored` joins pest because it DISPLACED `pest_treatment` in practice, not alongside it: on live
// prod `doctored` carries 510 events (239 in the last 30 days) while `pest_treatment` stopped dead at
// 2026-07-17 with 405 lifetime and ZERO in 30 days. The set was written against the vocabulary that
// existed before `doctored` shipped (2026-06-08) and never followed it, so the treatment event Dave
// actually logs could not retire the task it satisfies. Measured present damage is 1 item only
// because he pairs an `observation` with most `doctored` rows and `observation` already satisfies —
// this is a forward risk that the masking hides, not a live incident. REJECTED: dropping
// `pest_treatment`. 405 historical rows still exist, nothing forbids the type, and removing a
// satisfying type can only ever un-check a task that used to check off.
export const DONE_EVENTS = {
  water_due:  ['watering', 'rain', 'moisture_check'],
  no_history: ['watering', 'rain'],
  fertilize:  ['fertilizing'],
  pest:       ['observation', 'pest_treatment', 'doctored'],
  cold:       ['brought_inside', 'cover'],
  // V4-OVERWINTER-001 — the reduced-cadence winter soil check. `moisture_check` is FIRST because it is
  // the expected answer: in January the honest outcome of feeling the medium is usually "still damp",
  // and that must retire the card. `watering` and `rain` satisfy it too — if the medium was dry enough
  // to water, it has plainly been checked. Deliberately NOT `observation`: an observation is the pest
  // vocabulary, and letting it satisfy here would make one pest tap silently clear a watering-adjacent
  // task, which is the exact cross-bucket leak moisture_check was minted as its own type to avoid.
  overwintering: ['moisture_check', 'watering', 'rain'],
};

// Every plant id referenced by an actionable bucket, for the done-derivation query's = ANY($1).
export function planItemIds(plan) {
  const ids = [];
  for (const k of Object.keys(DONE_EVENTS)) {
    for (const it of (plan?.[k] || [])) if (it && it.id) ids.push(it.id);
  }
  return ids;
}

// Whole days from `b` to `a`, both 'YYYY-MM-DD'. Dependency-free on purpose (see file header) and
// UTC-anchored so it counts calendar days, never wall-clock hours across a DST boundary.
export function daysBetweenISO(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return null;
  const ta = Date.parse(a + 'T00:00:00Z');
  const tb = Date.parse(b + 'T00:00:00Z');
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.round((ta - tb) / 86400000);
}

// BUG-BACKDATEDFEED-001 — the FEED bucket checks off on its own CADENCE, not on the calendar day.
//
// The defect: `sat` is built from events dated TODAY in ET, so a feeding recorded today but DATED an
// earlier day satisfied nothing and the card stayed up. That is Dave's actual workflow — he logs the
// whole bag area the morning after doing it — and it happened live on 2026-08-25: 173 fertilizing
// events written at 07:07 ET, all dated 08-24, and both feed cards on that morning's plan stayed
// un-checked with zero rows matching the day predicate.
//
// Why feeding and NOT watering. A feed bucket is a cadence: "fed 1 day ago on a 14-day interval"
// genuinely means not due, whoever typed it when. A water row is a calendar-day claim — a watering
// dated three days ago does NOT mean the planting got water today, so widening the water window
// would check off a task nobody performed. Same asymmetry the `moisture_check` 24h carve-out is
// scoped around: widen the arm whose semantics are elapsed-time, never the one asserting today.
//
// FALLS BACK TO THE DAY RULE when the item carries no numeric `interval` — i.e. a plan stored before
// engine.js started emitting it. That direction is deliberate: an absent interval means we cannot
// price the cadence, and guessing one could retire a card that is genuinely due. Plans regenerate
// three times a day, so the fallback path is live for hours, not days.
export function fedWithinInterval(bucket, it, ctx) {
  if (bucket !== 'fertilize') return false;
  if (!it || !it.id || !ctx || typeof ctx.today !== 'string' || !ctx.lastFert) return false;
  const iv = typeof it.interval === 'number' ? it.interval : null;
  if (!(iv > 0)) return false;
  const last = ctx.lastFert instanceof Map ? ctx.lastFert.get(it.id) : ctx.lastFert[it.id];
  const d = daysBetweenISO(ctx.today, last);
  // d < 0 is a future-dated feed: not evidence the plant has been fed, so it does not retire the card.
  return d != null && d >= 0 && d < iv;
}

// Pure fold: stamp `done` on each item of each actionable bucket. `sat` is a Set of
// `${plant_id}|${event_type}` strings built from the satisfying rows. `ctx` is optional
// ({ today: 'YYYY-MM-DD' ET, lastFert: Map<plantId, 'YYYY-MM-DD'> }) and only ever ADDS done-ness,
// via fedWithinInterval — omitting it reproduces the pre-BUG-BACKDATEDFEED-001 behaviour exactly.
// Non-array buckets (and the plan's non-bucket keys) pass through untouched, so the response
// envelope never changes shape.
export function applyDone(plan, sat, ctx) {
  const out = { ...plan };
  for (const [k, types] of Object.entries(DONE_EVENTS)) {
    if (!Array.isArray(plan?.[k])) continue;
    out[k] = plan[k].map((it) => ({
      ...it,
      done: !!(it && it.id && (types.some((t) => sat.has(`${it.id}|${t}`)) || fedWithinInterval(k, it, ctx))),
    }));
  }
  return out;
}
