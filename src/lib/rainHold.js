// rainHold.js — the plan's rain_skipped bucket, split by WHY the engine skipped the watering
// (BUG-DEFERNOSTRESSOVERRIDE-001, Design A; Dave 2026-10-09: "water it on the spot").
//
// The engine puts two different claims in one bucket (lambda/daily-plan/engine.js rainSkipped):
//   WAITING  held on a FORECAST — sat_kind in engine.FORECAST_SAT_KINDS. Nothing has fallen for it; if the
//            plant is dry it should be watered, so it is listed with a Water button.
//   COVERED  rain that actually fell — the measured kinds ('soak', 'incoming') and the rain-credit items,
//            which carry no sat_kind at all. An item with no sat_kind, or a kind this file does not know, is
//            COVERED, never waiting: a plan stored before sat_kind shipped must not grow a Water button.
// The item is read as the engine writes it: { id, name, crop, project, project_id, in_ground, days_since,
// interval, saturated, sat_kind, sat_wp, today_in, today_pop, reason }. The forecast AMOUNT (the engine's
// sat.fq) is not a field — it rides only in `reason` (satReason: `Skip — 0.8" rain expected tomorrow @ 80%…`),
// so it is read from there, and a reason it cannot be read from prints no amount.
//
// PURE. Mirrors the engine's kind list; src/__tests__/rainHold.test.js pins it to engine.FORECAST_SAT_KINDS.
export const FORECAST_SAT_KINDS = new Set(['today', 'incoming_dry', 'soon'])
export const RAIN_HOLD_NEED = 'rain_skipped'
// Auto-show the waiting list at the page's chunk size (careNeeded.js EXPAND_ROW_BUDGET) or fewer.
export const RAIN_HOLD_AUTO_SHOW = 8

export const isForecastHold = (it) => !!it && FORECAST_SAT_KINDS.has(it.sat_kind)

// { waiting: the forecast-held items not yet watered today, covered: how many rain covered }.
// `done` is the read path's check-off (lambda/daily-plan-read DONE_EVENTS.rain_skipped = a watering today):
// a held plant already watered is no longer waiting. It is not "covered" either — rain did not do it.
export function rainSplit(plan) {
  const items = Array.isArray(plan && plan.rain_skipped) ? plan.rain_skipped : []
  const waiting = []
  let covered = 0
  for (const it of items) {
    if (!it) continue
    if (!isForecastHold(it)) { covered++; continue }
    if (it.id && !it.done) waiting.push(it)
  }
  return { waiting, covered }
}

const WHEN = {
  today: 'Rain expected later today',
  incoming_dry: 'Rain expected tomorrow',
  soon: 'Rain expected in the next few hours',
}
function holdAmount(it) {
  const m = /(\d+(?:\.\d+)?)"/.exec(typeof it.reason === 'string' ? it.reason : '')
  return m ? m[1] : null
}
// The waiting row's reason: when, then how much. Never the engine's own sentence ("Skip — … @ 80%"): the
// percentage is a share of models, not a chance of that amount. The amount is written as the weather card
// above the rows writes its own (rainSentences.js: two decimals and ″), so the screen has one notation.
export function rainHoldReason(it) {
  const when = it ? WHEN[it.sat_kind] : null
  if (!when) return ''
  if (it.sat_kind === 'soon') return when
  const amt = holdAmount(it)
  return amt ? when + ' · ' + Number(amt).toFixed(2) + '″' : when
}

// The waiting plantings as care rows (careNeeded.js buildCareNeeded's row shape), so the page's own row and
// write path take them unchanged: a Water tap posts the ordinary `watering` event (useCareActions eventBody).
export function waitingRows(plan) {
  return rainSplit(plan).waiting.map((it) => ({
    key: it.id + ':' + RAIN_HOLD_NEED,
    plantingId: it.id,
    name: it.name || it.crop || 'Planting',
    crop: it.crop || null,
    project: it.project || null,
    projectId: it.project_id || null,
    need: RAIN_HOLD_NEED,
    eventType: 'watering',
    reason: rainHoldReason(it),
    tier: 'gold',
    interval: typeof it.interval === 'number' ? it.interval : null,
    overdueBy: null,
    inGround: !!it.in_ground,
    never: false,
    reasonRedundant: false,
  }))
}

const plantings = (n) => n + ' planting' + (n === 1 ? '' : 's')
export const waitingLine = (n) => 'Waiting for rain · ' + n
// Parallel to the waiting line, and not "covered": that is this screen's word for a frost cover.
export const coveredLine = (n) => 'Already watered by rain · ' + n
// Today V1's note and DrG's rationale: sentences, no list. The rain-that-fell sentence is each surface's own,
// unchanged — it was only ever false for the forecast holds, which now get the sentence before it.
export function rainNoteSentences(plan) {
  const { waiting, covered } = rainSplit(plan)
  return [
    waiting.length ? 'Waiting for rain: ' + plantings(waiting.length) + ' — it is forecast, not fallen yet.' : null,
    covered ? 'Rain handled watering for ' + plantings(covered) + ' — recent rain counts.' : null,
  ].filter(Boolean)
}
export function rainReasoningLines(plan) {
  const { waiting, covered } = rainSplit(plan)
  return [
    waiting.length ? 'Holding ' + plantings(waiting.length) + ' for forecast rain — not watered yet.' : null,
    covered ? 'Skipped watering ' + plantings(covered) + ' — recent rain counted.' : null,
  ].filter(Boolean)
}
