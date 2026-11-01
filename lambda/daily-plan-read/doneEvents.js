// V3-TODAYDONE-001: read-time check-off vocabulary + the pure fold.
//
// DEPENDENCY-FREE ON PURPOSE. index.js imports @neondatabase/serverless + @clerk/backend +
// @aws-sdk/client-secrets-manager, none of which CI installs (ci.yml runs ONE root `npm ci`), so no test can
// import index.js and every guard on it is source-text-only. Holding the vocabulary + the fold here makes the
// part that DECIDES "is this plan item done" executable in CI.
//
// DEPLOY: each Lambda is zipped from its OWN directory, so this `./`-relative sibling IS packaged (the
// per-dir rule household.js documents). A `../` import would not be.

// The event types that satisfy each actionable plan bucket for the day.
//
// `moisture_check` ("Not thirsty") joins water_due (V4-WATERMATH-001 F0). It is its OWN event_type rather
// than an 'observation' because 'observation' is in the pest set below: mapping the snooze onto it would
// have one tap silently check off PEST tasks too. It is deliberately NOT in `no_history`, which means "never
// watered": declaring the soil damp establishes no watering history.
//
// Interim (pre-F2) freshness asymmetry: watering/rain satisfy for the ET calendar day, while a
// moisture_check also satisfies on a rolling `now() - 24h` window (see annotateDone in index.js and canon
// watering-cadence-math-design-V100 "Pre-F2 interim snooze semantics"). Without it a 09:00 snooze re-nags at
// the next morning's run ~21h later, the extinction pattern the design exists to avoid. Superseded by the
// engine fold at F2.
//
// `doctored` joins pest because it DISPLACED `pest_treatment` in practice: `pest_treatment` stopped dead on
// 2026-07-17 while `doctored` carries the events actually logged, so the treatment event could not retire
// the task it satisfies. Present damage is small only because an `observation` is usually paired with it.
// REJECTED: dropping `pest_treatment`. Historical rows exist, nothing forbids the type, and removing a
// satisfying type can only un-check a task that used to check off.
export const DONE_EVENTS = {
  water_due:  ['watering', 'rain', 'moisture_check'],
  no_history: ['watering', 'rain'],
  fertilize:  ['fertilizing'],
  pest:       ['observation', 'pest_treatment', 'doctored'],
  cold:       ['brought_inside', 'cover'],
  // V4-OVERWINTER-001: the reduced-cadence winter soil check. `moisture_check` is FIRST because "still damp"
  // is the expected winter answer and must retire the card. `watering` and `rain` satisfy it too (if the
  // medium was dry enough to water, it was checked). Deliberately NOT `observation`: that is the pest
  // vocabulary, and letting it satisfy here would let one pest tap clear a watering-adjacent task, the
  // cross-bucket leak moisture_check was minted as its own type to avoid.
  overwintering: ['moisture_check', 'watering', 'rain'],
  // BUG-DEFERNOSTRESSOVERRIDE-001: a planting the engine held back for rain, watered anyway. Today lists the
  // forecast-held ones with a Water button; without this entry the watered row is back on reload and on the
  // other phone until the hourly run drops it, inviting a second log. `watering` ONLY: a rain event is what
  // this bucket is waiting for, and "still moist" on a held plant changes nothing the engine decided. The
  // stamp lands on every rain_skipped item; the client reads `done` only on the forecast kinds
  // (src/lib/rainHold.js rainSplit).
  rain_skipped: ['watering'],
};

// Every plant id referenced by an actionable bucket, for the done-derivation query's = ANY($1).
export function planItemIds(plan) {
  const ids = [];
  for (const k of Object.keys(DONE_EVENTS)) {
    for (const it of (plan?.[k] || [])) if (it && it.id) ids.push(it.id);
  }
  return ids;
}

// Whole days from `b` to `a`, both 'YYYY-MM-DD'. UTC-anchored so it counts calendar days, never
// wall-clock hours across a DST boundary.
export function daysBetweenISO(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return null;
  const ta = Date.parse(a + 'T00:00:00Z');
  const tb = Date.parse(b + 'T00:00:00Z');
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.round((ta - tb) / 86400000);
}

// BUG-BACKDATEDFEED-001: the FEED bucket checks off on its own CADENCE, not on the calendar day. `sat` is
// built from events dated TODAY in ET, so a feeding recorded today but DATED an earlier day satisfied
// nothing and the card stayed up (Dave logs the whole bag area the morning after doing it).
//
// Why feeding and NOT watering: a feed bucket is a cadence ("fed 1 day ago on a 14-day interval" means not
// due, whoever typed it when). A water row is a calendar-day claim, so widening the water window would check
// off a task nobody performed. Widen the arm whose semantics are elapsed-time, never the one asserting today.
//
// FALLS BACK TO THE DAY RULE when the item carries no numeric `interval` (a plan stored before engine.js
// emitted it): an absent interval means we cannot price the cadence, and guessing could retire a card that
// is genuinely due.
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

// Pure fold: stamp `done` on each item of each actionable bucket. `sat` is a Set of `${plant_id}|${event_type}`
// strings built from the satisfying rows. `ctx` is optional ({ today: 'YYYY-MM-DD' ET, lastFert:
// Map<plantId, 'YYYY-MM-DD'> }) and only ever ADDS done-ness, via fedWithinInterval. Non-array buckets (and
// the plan's non-bucket keys) pass through untouched, so the response envelope never changes shape.
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
