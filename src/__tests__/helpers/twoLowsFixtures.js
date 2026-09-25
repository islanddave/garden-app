// V5-FROSTTWOMODELS-001 — shared fixtures for tonightLow.test.js (pure) and TodayTwoLows.test.jsx
// (Today mount). Every plan here is ENGINE-SHAPED from the REAL engine: the stored callout is
// computeCallout's output for the plan low, and the Protect bucket is coldFor's output for the same
// low, pushed with the fields generatePlanForUser pushes (engine.js `cold.push`). Nothing about what
// the engine writes is typed out by hand, so an engine change moves these fixtures with it.
import engine from '../../../lambda/daily-plan/engine.js'

const { computeCallout, coldFor, resolveCadence } = engine

// Fri 2026-10-09. An advisory is sent on a 14:00-17:59 ET run (frostEval resolveFrostRun) and stored
// on that plan date's row, so every entry below carries a 15:05 ET send time.
export const PLAN_DATE = '2026-10-09'
export const GEN = '2026-10-09T19:10:00.000Z'
const AT = '2026-10-09T19:05:00.000Z'

// Handler-shaped alerts_sent entries (handler.js publish block + frostWeatherFacts).
// `tonight`: D1's minimum before dawn -> the night that starts this evening (nightOffset 0).
export const tonight = (lowF, over = {}) => ({
  key: `sp1|${PLAN_DATE}|advisory|advisory|t${lowF}`, tier: 'advisory', level: 'advisory', at: AT,
  lowF, dayOffset: 1, date: '2026-10-10', nightOffset: 0, ...over,
})
// `tomorrowNight`: D2's minimum before dawn -> the night that starts tomorrow evening.
export const tomorrowNight = (lowF, over = {}) => ({
  key: `sp1|${PLAN_DATE}|advisory|advisory|m${lowF}`, tier: 'advisory', level: 'advisory', at: AT,
  lowF, dayOffset: 2, date: '2026-10-11', nightOffset: 1, ...over,
})
// The imminent entry frostWeatherFacts writes: { lowF, dayOffset: 0 } and no night.
export const imminent = (lowF) => ({
  key: `sp1|${PLAN_DATE}|imminent|protect`, tier: 'imminent', level: 'protect', at: AT, lowF, dayOffset: 0,
})

export const DRY = { recent_precip_in: 0.05, today_precip_in: 0, today_pop: 0, tomorrow_precip_in: 0, tomorrow_pop: 0, upcoming_precip_in: 0 }
// Reaches computeCallout's rain branch (0.45in at 80%), and nothing colder than it.
export const RAINY = { ...DRY, tomorrow_precip_in: 0.45, tomorrow_pop: 80, upcoming_precip_in: 0.45 }

// Two plantings that reach two different coldFor paths: the solanaceous band (genus Capsicum,
// flowering, so 40-44 gives the optional card) and the tender-profile path (a DB cold profile at 60F,
// the Fittonia threshold measured on prod in engine.js's BUG-COLDCARDDISCARD-001 note).
// No digit in either name: the grid reads every number printed on a Protect row.
const CAD = { default: { crop: 'unknown' }, by_variety: {}, by_genus_fallback: {} }
export const PEPPER = {
  id: 'pl-pepper', name: 'Pepper Aji', genus: 'Capsicum', crop_type_slug: 'pepper', status: 'flowering',
  container_type: 'pot', project: 'Bag Area', project_id: 'pj-bag',
}
export const FITTONIA = {
  id: 'pl-fittonia', name: 'Fittonia Red', genus: 'Fittonia', crop_type_slug: 'fittonia', status: 'active',
  container_type: 'pot', project: 'Bag Area', project_id: 'pj-bag',
  cadence_scopes: ['cultivar'], db_cadence: { crop: 'fittonia', cold: { tender: true, protect_below_F: 60 } },
}

// The Protect bucket the engine would store for this plan low.
export function coldBucket(low) {
  const out = []
  for (const p of [PEPPER, FITTONIA]) {
    const c = resolveCadence(p, CAD)
    const cd = coldFor(p, CAD, low)
    if (cd) out.push({ id: p.id, name: p.name, crop: c.crop, project: p.project, project_id: p.project_id, ...cd })
  }
  return out
}

// A stored plan as daily-plan-read returns it, for one plan low and one alerts_sent list.
export function planFor(low, entries = [], hydrology = DRY) {
  return {
    weather: { tonightLow: low, highToday: 70, code: 3, short: 'Cloudy', unit: 'F', callout: computeCallout({ tonightLow: low, highToday: 70 }, hydrology) },
    hydrology,
    water_due: [], no_history: [], fertilize: [], pest: [], dormant: [],
    cold: coldBucket(low),
    alerts_sent: entries,
  }
}

export function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o)
    for (const v of Object.values(o)) deepFreeze(v)
  }
  return o
}

export const freezeText = (t) => `Freeze tonight (${t}°F) — cover or bring peppers & tomatoes in`
export const coldText = (t) => `Cool night (${t}°F) — protect flowering peppers/tomatoes`
export const lineTonight = (t) => `Frost possible tonight — low ${t}°F. Plan cover for tender plants.`
export const lineTomorrow = (t) => `Frost possible tomorrow night — low ${t}°F. Plan cover for tender plants.`
// BUG-RAINFCSTONEMODEL-001: was '0.36"' — RAINY's 0.45" x 80%. The callout now prints the amount and the chance.
export const RAIN_CUE = '0.45" rain tomorrow (80% chance) — did the containers get watered today? In-ground beds can wait for it.'
export const BRING = 'bring inside tonight'
export const OPTIONAL = 'optional: protect flowering plant'
export const TROPICAL = 'tender tropical — bring in tonight'

// The spec's before -> after table (twolows-spec.md §3), plan date Fri 2026-10-09. `before` is what the
// page printed at the base commit; `after` is what it prints now. card = the moon figure's text without
// its degree sign. model = the impression's model_version, null where no cue renders.
export const ROWS = [
  { n: 1, low: 55, entries: [tonight(37.6)], hy: DRY,
    before: { card: '55', cue: null, line: lineTonight(38), protect: [`${TROPICAL} (low 55°F ≤ 60°F)`] },
    after: { card: '38', cue: null, line: lineTonight(38), model: null, protect: [TROPICAL] } },
  { n: 2, low: 43, entries: [tonight(37.6)], hy: DRY,
    before: { card: '43', cue: coldText(43), line: lineTonight(38), protect: [`${OPTIONAL} (low 43°F)`, `${TROPICAL} (low 43°F ≤ 60°F)`] },
    after: { card: '38', cue: freezeText(38), line: lineTonight(38), model: 'wxcue-v1-agreed', protect: [OPTIONAL, TROPICAL] } },
  { n: 3, low: 39, entries: [tonight(37.6)], hy: DRY,
    before: { card: '39', cue: freezeText(39), line: lineTonight(38), protect: [`${BRING} (low 39°F)`, `${TROPICAL} (low 39°F ≤ 60°F)`] },
    after: { card: '38', cue: freezeText(38), line: lineTonight(38), model: 'wxcue-v1-agreed', protect: [BRING, TROPICAL] } },
  { n: 4, low: 36, entries: [tonight(37.6)], hy: DRY,
    before: { card: '36', cue: freezeText(36), line: lineTonight(38), protect: [`${BRING} (low 36°F)`, `${TROPICAL} (low 36°F ≤ 60°F)`] },
    after: { card: '36', cue: freezeText(36), line: lineTonight(36), model: 'wxcue-v2', protect: [BRING, TROPICAL] } },
  { n: 5, low: 55, entries: [tomorrowNight(36.4)], hy: DRY,
    before: { card: '55', cue: null, line: lineTomorrow(36), protect: [`${TROPICAL} (low 55°F ≤ 60°F)`] },
    after: { card: '55', cue: null, line: lineTomorrow(36), model: null, protect: [`${TROPICAL} (low 55°F ≤ 60°F)`] } },
  { n: 6, low: 43, entries: [], hy: DRY,
    before: { card: '43', cue: coldText(43), line: null, protect: [`${OPTIONAL} (low 43°F)`, `${TROPICAL} (low 43°F ≤ 60°F)`] },
    after: { card: '43', cue: coldText(43), line: null, model: 'wxcue-v2', protect: [`${OPTIONAL} (low 43°F)`, `${TROPICAL} (low 43°F ≤ 60°F)`] } },
  // A radiative-only advisory is stored in the same shape (frostWeatherFacts, nightOffset 0).
  { n: 7, low: 47, entries: [tonight(42, { key: `sp1|${PLAN_DATE}|advisory|advisory|rad` })], hy: DRY,
    before: { card: '47', cue: null, line: lineTonight(42), protect: [`${TROPICAL} (low 47°F ≤ 60°F)`] },
    after: { card: '42', cue: null, line: lineTonight(42), model: null, protect: [TROPICAL] } },
  { n: 8, low: 44, entries: [tonight(42)], hy: DRY,
    before: { card: '44', cue: coldText(44), line: lineTonight(42), protect: [`${OPTIONAL} (low 44°F)`, `${TROPICAL} (low 44°F ≤ 60°F)`] },
    after: { card: '42', cue: coldText(42), line: lineTonight(42), model: 'wxcue-v1-agreed', protect: [OPTIONAL, TROPICAL] } },
  { n: 9, low: 37.8, entries: [tonight(37.6)], hy: DRY,
    before: { card: '37.8', cue: freezeText(37.8), line: lineTonight(38), protect: [`${BRING} (low 37.8°F)`, `${TROPICAL} (low 37.8°F ≤ 60°F)`] },
    after: { card: '38', cue: freezeText(38), line: lineTonight(38), model: 'wxcue-v1-agreed', protect: [BRING, TROPICAL] } },
  { n: 10, low: null, entries: [tonight(37.6)], hy: DRY,
    before: { card: '', cue: null, line: lineTonight(38), protect: [] },
    after: { card: '38', cue: null, line: lineTonight(38), model: null, protect: [] } },
  { n: 11, low: 36, entries: [imminent(36)], hy: DRY,
    before: { card: '36', cue: freezeText(36), line: null, protect: [`${BRING} (low 36°F)`, `${TROPICAL} (low 36°F ≤ 60°F)`] },
    after: { card: '36', cue: freezeText(36), line: null, model: 'wxcue-v2', protect: [`${BRING} (low 36°F)`, `${TROPICAL} (low 36°F ≤ 60°F)`] } },
  { n: 12, low: 50, entries: [tonight(37.6)], hy: RAINY,
    before: { card: '50', cue: RAIN_CUE, line: lineTonight(38), protect: [`${TROPICAL} (low 50°F ≤ 60°F)`] },
    after: { card: '38', cue: RAIN_CUE, line: lineTonight(38), model: 'wxcue-v2', protect: [TROPICAL] } },
]

// The spec's grid (§4 Tests): plan low x entry, over the REAL callout.
export const GRID_LOWS = [null, 30, 36, 39, 39.6, 40, 43, 44, 47, 55, 37.8]
export const GRID_ENTRIES = [
  { name: 'none', entries: [], tonightLow: null },
  { name: 'tonight 33.4', entries: [tonight(33.4)], tonightLow: 33.4 },
  { name: 'tonight 37.6', entries: [tonight(37.6)], tonightLow: 37.6 },
  { name: 'tonight 40', entries: [tonight(40)], tonightLow: 40 },
  { name: 'tonight 42', entries: [tonight(42)], tonightLow: 42 },
  { name: 'tonight 44', entries: [tonight(44)], tonightLow: 44 },
  { name: 'tomorrow night 36.4', entries: [tomorrowNight(36.4)], tonightLow: null },
]

export { computeCallout, coldFor }
