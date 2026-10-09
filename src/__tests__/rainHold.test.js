// BUG-DEFERNOSTRESSOVERRIDE-001 (Design A) — lib/rainHold.js: the plan's rain_skipped bucket split into the
// plantings WAITING on a forecast and the ones rain COVERED. The seam with the engine lane is one field path:
// plan.rain_skipped[i].sat_kind, kinds = engine.FORECAST_SAT_KINDS, plus the amount inside `reason`. The
// engine-shaped fixtures below are the real generatePlan's output, passed through the read Lambda's fold —
// never typed — so a renamed field, a new kind, or a reworded reason reds here. No jest-dom (L-182).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import engine from '../../lambda/daily-plan/engine.js'
import coverFlags from '../../lambda/daily-plan/_coverFlags.js'
import { applyDone, DONE_EVENTS } from '../../lambda/daily-plan-read/doneEvents.js'
import {
  FORECAST_SAT_KINDS, RAIN_HOLD_NEED, RAIN_HOLD_AUTO_SHOW, isForecastHold, rainSplit, rainHoldReason, waitingRows,
  waitingLine, coveredLine, rainNoteSentences, rainReasoningLines,
} from '../lib/rainHold.js'
import { EXPAND_ROW_BUDGET, NEED_LABEL, NEED_ORDER, NEED_EVENT_TYPE, buildCareNeeded } from '../lib/careNeeded.js'
import { buildReasoningLines } from '../lib/drgReasoning.js'
import { eventBody } from '../components/today/useCareActions.js'

const F = (p) => JSON.parse(readFileSync(resolve(process.cwd(), p), 'utf8'))
const cadence = F('lambda/daily-plan/cadence-data-v2.json')
const fertModel = F('lambda/daily-plan/fertilization-model.json')
const USER = 'user_dave'
const SEED = { _seeded: true, crop: 'pepper', water_interval_days_container: 1, water_interval_days_inground: 2, water_method: 'soak', soil_moisture_target: 'moist', drought_tolerance: 'medium' }
const planting = (id, extra = {}) => coverFlags.withCoverFlags({
  id, name: `pepper ${id}`, project_id: 'pj1', status: 'fruiting', container_type: 'in_ground', container_size: null, rain_exposed: null,
  variety: 'pepper', genus: null, project: 'Garden', project_status: 'active', workspace_id: 'sp1', crop_type_slug: 'pepper', covered: false,
  assignee_user_id: USER, db_cadence: SEED, last_water: '2026-09-18', last_fert: '2026-09-01', substrate_start: '2026-05-01', transplant_at: null, ...extra,
})
// The plan as the client receives it: the engine's tasks spread into the stored items (handler.js), then the
// read Lambda's done fold (index.js annotateDone → applyDone). `sat` = the satisfying `${plant}|${type}` rows.
function served(hydrology, flags = {}, sat = new Set()) {
  const out = engine.generatePlan({
    plantings: [planting('bed'), planting('bag', { container_type: 'fabric_bag', container_size: '5 gal' })], cadence, fertModel,
    today: '2026-09-28', weather: { tonightLow: 52, highToday: 66 }, hydrology, ownerFallback: USER, todayAwareEnabled: true, rainCreditEnabled: true, ...flags,
  })
  return applyDone({ hydrology, ...Object.values(out.users)[0].tasks }, sat)
}
const DRY = { recent_precip_in: 0, today_precip_in: 0, today_pop: 5, tomorrow_precip_in: 0, tomorrow_pop: 5 }
const TOMORROW = () => served({ ...DRY, tomorrow_precip_in: 0.74, tomorrow_pop: 70 }, { deferDryBedsEnabled: true })
const TODAY = () => served({ ...DRY, today_precip_in: 0.6, today_pop: 70 })
const SOON = () => served({ ...DRY, today_precip_in: 0.1, today_pop: 70, today_next_in: 0.3 }, { soonAwareEnabled: true })
const SOAKED = () => served({ ...DRY, recent_precip_in: 1.2, yesterday_precip_actual_in: 1.2 })

describe('the kind list is the engine\'s', () => {
  it('FORECAST_SAT_KINDS mirrors engine.FORECAST_SAT_KINDS exactly', () => {
    expect([...FORECAST_SAT_KINDS].sort()).toEqual([...engine.FORECAST_SAT_KINDS].sort())
    expect(FORECAST_SAT_KINDS.size).toBe(3)
  })
  it('every forecast kind has its own plain reason; no other kind has one', () => {
    for (const k of engine.FORECAST_SAT_KINDS) expect(rainHoldReason({ sat_kind: k, reason: '' }), k).toMatch(/^Rain expected /)
    for (const k of ['soak', 'incoming', 'nope', undefined]) expect(rainHoldReason({ sat_kind: k, reason: 'Skip — 0.8" x' })).toBe('')
  })
  it('auto-show uses the page\'s chunk size', () => { expect(RAIN_HOLD_AUTO_SHOW).toBe(EXPAND_ROW_BUDGET) })
})

describe('THE SEAM — the real engine\'s rain_skipped item, through the read Lambda\'s fold', () => {
  it('tomorrow\'s rain (incoming_dry): the bed is WAITING, with when and how much; nothing is covered', () => {
    const plan = TOMORROW()
    expect(plan.rain_skipped.map((it) => it.id)).toEqual(['bed'])
    expect(plan.rain_skipped[0].sat_kind).toBe('incoming_dry')
    const s = rainSplit(plan)
    expect(s.waiting.map((it) => it.id)).toEqual(['bed'])
    expect(s.covered).toBe(0)
    expect(waitingRows(plan)).toEqual([{
      key: 'bed:rain_skipped', plantingId: 'bed', name: 'pepper bed', crop: 'pepper', project: 'Garden', projectId: 'pj1',
      need: 'rain_skipped', eventType: 'watering', reason: 'Rain expected tomorrow · 0.74 in', tier: 'gold', interval: 2,
      overdueBy: null, inGround: true, never: false, reasonRedundant: false,
    }])
  })
  it('rain later today (today): both plantings wait — "Rain expected later today · 0.6 in"', () => {
    const rows = waitingRows(TODAY())
    expect(rows.map((r) => r.plantingId).sort()).toEqual(['bag', 'bed'])
    for (const r of rows) expect(r.reason).toBe('Rain expected later today · 0.6 in')
  })
  it('rain in the next few hours (soon): waiting, and the reason carries no amount', () => {
    const rows = waitingRows(SOON())
    expect(rows.length).toBe(2)
    for (const r of rows) expect(r.reason).toBe('Rain expected in the next few hours')
  })
  it('a soak that FELL (soak) is covered, never waiting — it carries a sat_kind and an amount too', () => {
    const plan = SOAKED()
    expect(plan.rain_skipped.length).toBe(2)
    expect(plan.rain_skipped.every((it) => it.sat_kind === 'soak')).toBe(true)
    expect(rainSplit(plan)).toEqual({ waiting: [], covered: 2 })
    expect(waitingRows(plan)).toEqual([])
  })
  it('no row ever prints the engine\'s own sentence', () => {
    for (const plan of [TOMORROW(), TODAY(), SOON()]) {
      for (const r of waitingRows(plan)) expect(r.reason).not.toMatch(/@|%|Skip|deferred|saturat|"/i)
    }
  })
  it('a watering today stamps the held item done (DONE_EVENTS.rain_skipped) and it stops waiting; a rain or a moist check does not', () => {
    expect(DONE_EVENTS.rain_skipped).toEqual(['watering'])
    const hy = { ...DRY, tomorrow_precip_in: 0.74, tomorrow_pop: 70 }
    const watered = served(hy, { deferDryBedsEnabled: true }, new Set(['bed|watering']))
    expect(watered.rain_skipped[0].done).toBe(true)
    expect(rainSplit(watered)).toEqual({ waiting: [], covered: 0 })
    for (const t of ['rain', 'moisture_check', 'observation']) {
      const other = served(hy, { deferDryBedsEnabled: true }, new Set(['bed|' + t]))
      expect(other.rain_skipped[0].done, t).toBe(false)
      expect(waitingRows(other).length, t).toBe(1)
    }
  })
})

describe('rainSplit — forecast kinds only; anything else is covered', () => {
  const it0 = (id, extra) => ({ id, name: 'P ' + id, project_id: 'pr', reason: 'Skip — 0.8" rain expected tomorrow @ 80%; waiting for it beats watering twice', ...extra })
  it('a missing sat_kind (a rain-credit item, a plan stored before the field) is covered, never waiting', () => {
    const plan = { rain_skipped: [it0('a'), it0('b', { sat_kind: null }), it0('c', { sat_kind: 'incoming' }), it0('d', { sat_kind: 'made_up' }), it0('e', { sat_kind: 'incoming_dry' })] }
    const s = rainSplit(plan)
    expect(s.waiting.map((it) => it.id)).toEqual(['e'])
    expect(s.covered).toBe(4)
    expect(isForecastHold(it0('a'))).toBe(false)
  })
  it('a done forecast hold is neither waiting nor covered; a done covered item is still covered', () => {
    const plan = { rain_skipped: [it0('a', { sat_kind: 'today', done: true }), it0('b', { sat_kind: 'today' }), it0('c', { done: true })] }
    expect(rainSplit(plan).waiting.map((it) => it.id)).toEqual(['b'])
    expect(rainSplit(plan).covered).toBe(1)
  })
  it('nothing to read → nothing', () => {
    for (const p of [null, undefined, {}, { rain_skipped: null }, { rain_skipped: [null] }]) expect(rainSplit(p)).toEqual({ waiting: [], covered: 0 })
  })
  it('an amount it cannot read prints none', () => {
    expect(rainHoldReason({ sat_kind: 'incoming_dry', reason: 'Skip — rain expected' })).toBe('Rain expected tomorrow')
    expect(rainHoldReason({ sat_kind: 'today' })).toBe('Rain expected later today')
  })
})

describe('a waiting row is the ordinary Water — and never a Needs care row', () => {
  it('posts the body a water_due row posts (eventBody), default depth metadata included', () => {
    const plan = { water_due: [{ id: 'p1', name: 'X', project_id: 'pj1', interval: 2, days_since: 4, overdue_by: 2 }], rain_skipped: [{ id: 'p1', name: 'X', project_id: 'pj1', sat_kind: 'today', reason: 'Skip — 0.6" rain falling today @ 70%' }] }
    const listed = buildCareNeeded(plan)[0]
    const waiting = waitingRows(plan)[0]
    expect(eventBody(waiting)).toEqual(eventBody(listed))
    expect(eventBody(waiting).event_type).toBe('watering')
    expect(eventBody(waiting).metadata).toBeTruthy()
  })
  it('the chip reads Water; rain_skipped is in no list-building map', () => {
    expect(NEED_LABEL[RAIN_HOLD_NEED]).toBe('Water')
    expect(NEED_ORDER).not.toContain(RAIN_HOLD_NEED)
    expect(RAIN_HOLD_NEED in NEED_EVENT_TYPE).toBe(false)
    expect(buildCareNeeded(TOMORROW()).some((r) => r.plantingId === 'bed' && (r.eventType === 'watering' || r.need === RAIN_HOLD_NEED))).toBe(false)
  })
})

describe('the words — a forecast hold is never rain that fell', () => {
  const FELL = /recent rain|covered|handled|already fell|counted/i
  it('V2 lines', () => {
    expect(waitingLine(12)).toBe('Waiting for rain · 12')
    expect(coveredLine(58)).toBe('Rain covered 58 — it already fell.')
    expect(waitingLine(3)).not.toMatch(FELL)
  })
  it('V1 note: holds only → one waiting sentence; fell only → the rain sentence; both → both, waiting first', () => {
    expect(rainNoteSentences(TOMORROW())).toEqual(['Waiting for rain: 1 planting — it is forecast, not fallen yet.'])
    expect(rainNoteSentences(TODAY())).toEqual(['Waiting for rain: 2 plantings — it is forecast, not fallen yet.'])
    expect(rainNoteSentences(SOAKED())).toEqual(['Rain handled watering for 2 plantings — recent rain counts.'])
    const both = { rain_skipped: [...TOMORROW().rain_skipped, ...SOAKED().rain_skipped] }
    expect(rainNoteSentences(both)).toEqual(['Waiting for rain: 1 planting — it is forecast, not fallen yet.', 'Rain handled watering for 2 plantings — recent rain counts.'])
    for (const plan of [TOMORROW(), TODAY(), SOON()]) for (const t of rainNoteSentences(plan)) expect(t).not.toMatch(FELL)
    expect(rainNoteSentences({})).toEqual([])
  })
  it('DrG: the same split', () => {
    expect(rainReasoningLines(TODAY())).toEqual(['Holding 2 plantings for forecast rain — not watered yet.'])
    expect(rainReasoningLines(SOAKED())).toEqual(['Skipped watering 2 plantings — recent rain counted.'])
    for (const plan of [TOMORROW(), TODAY(), SOON()]) {
      const lines = buildReasoningLines({ has_plan: true, plan }).lines
      expect(lines.some((t) => /^Holding /.test(t))).toBe(true)
      for (const t of lines) expect(t).not.toMatch(FELL)
    }
    expect(buildReasoningLines({ has_plan: true, plan: SOAKED() }).lines).toContain('Skipped watering 2 plantings — recent rain counted.')
  })
})
