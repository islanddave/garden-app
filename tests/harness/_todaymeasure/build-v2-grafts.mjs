#!/usr/bin/env node
// build-v2-grafts.mjs — the Today V2 gate's state grafts, produced from the TRACKED fixtures by the
// ENGINE'S OWN FUNCTIONS, never typed (V5-TODAYREDESIGN-001 S0; plan-v2 §9.1 state table, §13 SF4).
//
//   node tests/harness/_todaymeasure/build-v2-grafts.mjs          # writes v2-grafts.json
//   node tests/harness/_todaymeasure/build-v2-grafts.mjs --check  # exit 1 if v2-grafts.json is stale
//
// Each graft is `busy` (dailyplan.dave.json / plants.json, the 2026-09-24 prod dump) with ONE thing moved,
// and says what moved and why in `provenance`. The harness (v2wire.js) applies them; it never computes
// them, because the engine is CommonJS Lambda code that does not belong in the browser bundle, and a
// graft computed at page load could drift from the one the budget was recorded over without a diff.
//
//   routine  the 8 tray-cell plantings moved to fabric_bag in /api/plants: water is due, nothing SMALL is.
//   hot      routine + weather {hot:true, highToday:91} (engine HOT_F = 88).
//   never    routine + one real water_due row moved to no_history exactly as the engine's never arm
//            writes it (engine.js `dW==null` arm: days_since null, overdue_by null, never:true).
//   bedwait  tomorrow 0.62″ @ 70%, run through the e6dbd74 gate (BUG-RAINBEDWAITCONFLICT-001): every
//            in-ground row the gate defers is moved to rain_skipped with the engine's own item shape and
//            satReason() wording; two are kept as fresh-transplant carve-outs (TRANSPLANT_CARVEOUT_DAYS),
//            which the fixture cannot date, so they are declared, not derived.
//   freeze   tonightLow 36 + SYNTHETIC bring_in cards for the container nightshades, worded with the
//            engine's `low<40` template (engine.js coldFor); the five real protect cards re-worded at 36°F.
//   gaugerain the yard gauge has measured 0.45″ today and the hourly forecast has nothing left: SYNTHETIC
//            (the 2026-09-24 gauge read 0), two fields of the plan's own hydrology, nothing else moved.
//   stale    busy served with plan_date one day back (2026-09-23) and generated_at moved with it.
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { groupsOfRows } from './v2groups.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../../..')
const require = createRequire(import.meta.url)
const engine = require(join(ROOT, 'lambda/daily-plan/engine.js'))
const OUT = join(HERE, 'v2-grafts.json')

const read = (f) => JSON.parse(readFileSync(join(HERE, f), 'utf8'))
const D = read('dailyplan.dave.json')
const PLANTS = read('plants.json')
const LOCS = read('locations.full.json')
const plan = D.plan
const plantById = new Map(PLANTS.map((p) => [p.id, p]))

// The trigger's "small" is container_type ∈ engine SMALL_VESSEL_TYPES (plan §3). That Set is module-private
// in engine.js and engine.isSmallVessel also reads container_size (absent from /api/plants, so it fails safe
// to "small" for 133 rows), so the Set is READ FROM THE ENGINE SOURCE rather than spelled here.
const smallSrc = [...readFileSync(join(ROOT, 'lambda/daily-plan/engine.js'), 'utf8').matchAll(/const SMALL_VESSEL_TYPES = new Set\(\[([^\]]*)\]\)/g)]
if (smallSrc.length !== 1) throw new Error(`engine.js declares SMALL_VESSEL_TYPES ${smallSrc.length} times; expected exactly 1`)
const SMALL_VESSEL_TYPES = new Set(smallSrc[0][1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean))
const small = plan.water_due.filter((r) => SMALL_VESSEL_TYPES.has(plantById.get(r.id)?.container_type))
if (small.length !== 8) throw new Error(`expected the 8 tray-cell water rows of 2026-09-24, found ${small.length} — the fixture moved; re-derive the routine graft`)

const routine = {
  plants_container_type: Object.fromEntries(small.map((r) => [r.id, 'fabric_bag'])),
  provenance: `the ${small.length} water_due plantings whose container_type is in engine SMALL_VESSEL_TYPES {${[...SMALL_VESSEL_TYPES].join(', ')}} (${[...new Set(small.map((r) => plantById.get(r.id).container_type))].join(', ')}) moved to fabric_bag in /api/plants; nothing else moved`,
  names: small.map((r) => r.name),
}

const hot = {
  weather: { hot: true, highToday: 91 },
  provenance: `routine + weather.hot true at highToday 91 (engine HOT_F = ${engine.HOT_F})`,
}

// The never row: the first container row that is not one of the small ones, so `never` and `small`
// stay separable in the trigger table.
const smallIds = new Set(small.map((r) => r.id))
const nv = plan.water_due.find((r) => !r.in_ground && !smallIds.has(r.id))
const never = {
  move_to_no_history: nv.id,
  row: { ...nv, days_since: null, overdue_by: null, never: true },
  provenance: `routine + real water_due row "${nv.name}" moved to no_history as engine.js's dW==null arm writes it (days_since null, overdue_by null, never true)`,
}

// bedwait — the engine's own gate on the engine's own inputs.
const hydrology = { ...plan.hydrology, tomorrow_precip_in: 0.62, tomorrow_pop: 70, rain_coming: true }
const sat = engine.saturationSuppressed('outdoor', hydrology, { todayAware: true, smallVessel: false, deferDry: true, soonAware: false })
if (!sat || sat.kind !== 'incoming_dry') throw new Error(`the e6dbd74 gate did not defer a dry bed at 0.62″/70%: ${JSON.stringify(sat)}`)
const beds = plan.water_due.filter((r) => r.in_ground)
const CARVE_OUTS = 2
const carve = beds.slice(-CARVE_OUTS)
const deferred = beds.slice(0, beds.length - CARVE_OUTS)
const bedwait = {
  hydrology: { tomorrow_precip_in: 0.62, tomorrow_pop: 70, rain_coming: true },
  move_to_rain_skipped: deferred.map((r) => r.id),
  rain_skipped_rows: deferred.map((r) => ({
    id: r.id, name: r.name, crop: r.crop, project: r.project, project_id: r.project_id, in_ground: true,
    days_since: r.days_since, interval: r.interval, saturated: true,
    sat_kind: sat.kind, sat_wp: sat.wp,
    today_in: hydrology.today_precip_in ?? null, today_pop: hydrology.today_pop ?? null,
    reason: engine.satReason(sat),
  })),
  carve_outs: carve.map((r) => r.id),
  provenance: `engine.saturationSuppressed('outdoor', hydrology{tomorrow 0.62″ @ 70%}, {deferDry:true}) = ${sat.kind}; ${deferred.length} of ${beds.length} in-ground water rows moved to rain_skipped with engine.js's rain_skipped shape and satReason() text ("${engine.satReason(sat)}"). The last ${CARVE_OUTS} in-ground rows (${carve.map((r) => r.name).join(', ')}) are DECLARED fresh-transplant carve-outs (TRANSPLANT_CARVEOUT_DAYS = ${engine.TRANSPLANT_CARVEOUT_DAYS}): the fixture carries no transplant_at to derive them from. They stay in water_due, and bedWaitActive(plan) keeps them out of Water all.`,
  // What the page should show, in D7's groups (v2groups.mjs, the gate's own reading, not the product's):
  // Outside water rows after the move, and Water all = those minus the carve-outs bed-wait excludes.
  expect: (() => {
    const left = plan.water_due.filter((r) => !deferred.some((d) => d.id === r.id))
    const g = groupsOfRows(left, PLANTS, LOCS)
    const outsideBeds = groupsOfRows(carve, PLANTS, LOCS).Outside || 0
    return { water_rows_by_group_after: g, outside_water_all_after: (g.Outside || 0) - outsideBeds }
  })(),
}

// freeze — SYNTHETIC cold cards, on the engine's own template.
const NIGHTSHADE = /tomato|pepper|tomatillo|eggplant/i
const shades = plan.water_due.filter((r) => !r.in_ground && NIGHTSHADE.test(r.crop || ''))
const LOW = 36
const freeze = {
  weather: { tonightLow: LOW },
  cold_add: shades.map((r) => ({ id: r.id, name: r.name, crop: r.crop, project: r.project, project_id: r.project_id, level: 'bring_in', text: `bring inside tonight (low ${LOW}°F)` })),
  cold_reword: { from: `low ${plan.weather.tonightLow}°F`, to: `low ${LOW}°F` },
  synthetic: true,
  provenance: `tonightLow ${LOW}; ${shades.length} SYNTHETIC bring_in cards for container nightshades (crop ~ ${NIGHTSHADE}), text on engine.js coldFor's low<40 template; the ${plan.cold.length} real protect cards re-worded from ${plan.weather.tonightLow}°F to ${LOW}°F`,
}

// gaugerain — SYNTHETIC: the two fields the card's measured rain line reads (src/lib/rainSentences.js).
if (plan.hydrology.station?.today_source !== 'station') throw new Error('the fixture day is not gauge-measured; gaugerain would graft a measurement onto a forecast-only day')
const gaugerain = {
  hydrology: { today_observed_in: 0.45, today_remaining_in: 0 },
  synthetic: true,
  provenance: `today_observed_in ${plan.hydrology.today_observed_in} -> 0.45 and today_remaining_in 0 on a day whose today_source is already "station"; SYNTHETIC figures (BUG-RAINTOMORROWMISLABEL-001 b: a measured today beside a tomorrow that changes watering)`,
}

const stale = {
  plan_date: '2026-09-23',
  generated_at_shift_days: -1,
  provenance: 'busy served with plan_date one day before the pinned clock (2026-09-24) — the shape a cached plan from yesterday takes',
}

const doc = {
  _: 'GENERATED by tests/harness/_todaymeasure/build-v2-grafts.mjs from dailyplan.dave.json + plants.json and lambda/daily-plan/engine.js. Do not hand-edit; re-run the builder. Applied by v2wire.js.',
  base: { plan_date: D.plan_date, generated_at: D.generated_at },
  routine, hot, never, bedwait, freeze, gaugerain, stale,
}
const text = JSON.stringify(doc, null, 1) + '\n'
if (process.argv.includes('--check')) {
  let cur = ''
  try { cur = readFileSync(OUT, 'utf8') } catch { /* missing */ }
  if (cur !== text) { console.error('[v2-grafts] STALE — v2-grafts.json does not match what the builder produces from the tracked fixtures and engine.js. Re-run the builder.'); process.exit(1) }
  console.log('[v2-grafts] up to date')
  process.exit(0)
}
writeFileSync(OUT, text)
console.log(`[v2-grafts] wrote ${OUT}: routine ${small.length} · never "${nv.name}" · bedwait ${deferred.length} deferred + ${CARVE_OUTS} carve-outs · freeze ${shades.length} bring_in · stale ${stale.plan_date}`)
