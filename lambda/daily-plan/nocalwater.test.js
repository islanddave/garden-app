// DRG-NOCALWATER-001 — dormancy/growth-cycle watering suppression.
// The care system stored no_calendar_water / water_rule:'growth_gated' in care profiles but NO code read
// them; the nightly plan issued interval watering for a summer-dormant Lithops (watering during dormancy
// rots it — the plant died). These tests pin the fix: suppressed plantings get NO calendar watering item
// and land LOUDLY on tasks.dormancy_suppressed + counts.dormancy_suppressed.
//
// Real-path tests: engine.generatePlan with the engine's own bundled cadence + fert model, no mocked engine
// internals. PROVEN-FAILING PRE-CHANGE: run against the pre-change engine (git show 81d4c013:...engine.js),
// every suppression assertion here fails (dormancy_suppressed undefined; Lithops in water_due) — see commit body.
import { describe, it, expect } from 'vitest'
import engine from './engine.js'
import cad from './cadence-data-v2.json'
import fm from './fertilization-model.json'
import _cf from './_coverFlags.js';
const { withCoverFlags } = _cf;  // BUG-NOLOCOUTDOOR-001 fixture bridge

const { generatePlan, waterSuppression } = engine

// Lithops-like SEEDED profile (resolveCadence adopts it as db cadence).
const LITHOPS_SEEDED = {
  _seeded: true, crop: 'succulent (Lithops / living stone)', indoor: true,
  no_calendar_water: true, water_rule: 'growth_gated', water_method: 'soak_then_dry',
  drought_tolerance: 'very_high', water_interval_days_container: 30, fertilize_interval_days: 0,
  soil_moisture_target: 'OVERRIDE: water ONLY when actively growing AND old leaf pair not renewing AND slight wrinkling; otherwise DO NOT WATER',
}
// LIVE-SHAPE profile: the real prod cultivar row carries the signals WITHOUT `_seeded`, so resolveCadence
// FALLS BACK to the bundled JSON and drops the profile — the exact silent-loss path that killed the plant.
// The suppression gate must still see the raw db_cadence signal.
const LITHOPS_UNSEEDED = { ...LITHOPS_SEEDED }
delete LITHOPS_UNSEEDED._seeded
const GROWTH_GATED_ONLY = { _seeded: true, crop: 'bulb (summer dormant)', water_rule: 'growth_gated', water_interval_days_container: 7, fertilize_interval_days: 0 }
const PEPPER = { _seeded: true, crop: 'pepper', water_interval_days_container: 3, water_method: 'deep_even', soil_moisture_target: 'evenly_moist', drought_tolerance: 'medium', fertilize_interval_days: 14 }

const P = (o) => withCoverFlags({
  assignee_user_id: 'dave', project: 'Bench', project_id: 'pb', project_status: 'active',
  variety: null, genus: null, container_type: 'pot', container_size: '4 in',
  substrate_start: '2026-01-01', transplant_at: null, last_fert: null, covered: true, ...o,
})
// Lithops last watered 40d ago — WAY past the 30d fallback interval, so the PRE-change engine puts it in
// water_due (the lethal behavior). Post-change it must not, under any flag combination.
const LITHOPS = P({ id: 'li1', name: 'Lithops', status: 'active', last_water: '2026-06-24', db_cadence: LITHOPS_SEEDED })
const LITHOPS_LIVE = P({ id: 'li2', name: 'Lithops (live shape)', status: 'active', last_water: '2026-06-24', db_cadence: LITHOPS_UNSEEDED })
const BULB = P({ id: 'gg1', name: 'Summer-dormant Bulb', status: 'active', last_water: '2026-06-24', db_cadence: GROWTH_GATED_ONLY })
const NORMAL = P({ id: 'pep1', name: 'Bench Pepper', status: 'fruiting', last_water: '2026-07-25', db_cadence: PEPPER, covered: false })
const NEVER_WATERED = P({ id: 'li3', name: 'Lithops (no history)', status: 'active', last_water: null, db_cadence: LITHOPS_SEEDED })

const planFor = (plantings, opts = {}) => generatePlan({
  plantings, cadence: cad, fertModel: fm, today: '2026-08-03',
  weather: { tonightLow: 66, highToday: 82, unit: 'F' },
  hydrology: { recent_precip_in: 0, today_precip_in: 0, today_pop: 0, upcoming_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0 },
  ownerFallback: 'dave', ...opts,
}).users.dave

const inAnyWaterList = (u, id) =>
  u.tasks.water_due.some((x) => x.id === id) || u.tasks.no_history.some((x) => x.id === id) || u.tasks.rain_skipped.some((x) => x.id === id)

describe('waterSuppression (pure)', () => {
  it('reads no_calendar_water from the resolved cadence', () => {
    expect(waterSuppression({}, { no_calendar_water: true })).toBe('no_calendar_water')
  })
  it('reads the RAW db_cadence even when resolveCadence dropped it (live unseeded shape)', () => {
    expect(waterSuppression({ db_cadence: LITHOPS_UNSEEDED }, { crop: 'unknown' })).toBe('no_calendar_water')
  })
  it('no_calendar_water outranks growth_gated when both present', () => {
    expect(waterSuppression({}, { no_calendar_water: true, water_rule: 'growth_gated' })).toBe('no_calendar_water')
  })
  it('growth_gated alone suppresses', () => {
    expect(waterSuppression({}, { water_rule: 'growth_gated' })).toBe('growth_gated')
  })
  it('null for a plain profile; truthy-but-not-true no_calendar_water does NOT suppress', () => {
    expect(waterSuppression({}, PEPPER)).toBe(null)
    expect(waterSuppression({}, { no_calendar_water: 'yes' })).toBe(null)
    expect(waterSuppression({}, { water_rule: 'calendar' })).toBe(null)
  })
})

describe('DRG-NOCALWATER-001 — suppressed plantings never get calendar watering items', () => {
  it('Lithops (no_calendar_water, 40d overdue) gets NO watering item and is counted LOUDLY', () => {
    const u = planFor([LITHOPS, NORMAL])
    expect(inAnyWaterList(u, 'li1')).toBe(false)
    const row = u.tasks.dormancy_suppressed.find((x) => x.id === 'li1')
    expect(row).toBeTruthy()
    expect(row.rule).toBe('no_calendar_water')
    expect(row.reason).toMatch(/suppressed/i)
    expect(row.moisture).toMatch(/DO NOT WATER/)
    expect(u.counts.dormancy_suppressed).toBe(1)
  })
  it('LIVE prod shape — signals WITHOUT _seeded still suppress (regression for the lethal fallback path)', () => {
    const u = planFor([LITHOPS_LIVE])
    expect(inAnyWaterList(u, 'li2')).toBe(false)
    expect(u.tasks.dormancy_suppressed.map((x) => x.id)).toContain('li2')
    expect(u.counts.dormancy_suppressed).toBe(1)
  })
  it('growth_gated alone suppresses, with its own rule label', () => {
    const u = planFor([BULB])
    expect(inAnyWaterList(u, 'gg1')).toBe(false)
    const row = u.tasks.dormancy_suppressed.find((x) => x.id === 'gg1')
    expect(row.rule).toBe('growth_gated')
    expect(row.reason).toMatch(/growth/i)
  })
  it('a never-watered suppressed planting is suppressed too (not routed to no_history)', () => {
    const u = planFor([NEVER_WATERED])
    expect(u.tasks.no_history.some((x) => x.id === 'li3')).toBe(false)
    expect(u.tasks.dormancy_suppressed.map((x) => x.id)).toContain('li3')
  })
  it('a normal planting is unaffected: waters, and the suppressed count is 0 (gate ran, found nothing)', () => {
    const u = planFor([NORMAL])
    expect(u.tasks.water_due.map((x) => x.id)).toContain('pep1')
    expect(u.counts.dormancy_suppressed).toBe(0)
    expect(u.tasks.dormancy_suppressed).toEqual([])
  })
  it('status=dormant still routes to the dormant bucket, not double-counted as suppressed', () => {
    const u = planFor([P({ id: 'dm1', name: 'Dormant Lithops', status: 'dormant', last_water: '2026-06-24', db_cadence: LITHOPS_SEEDED })])
    expect(u.tasks.dormant.map((x) => x.id)).toContain('dm1')
    expect(u.tasks.dormancy_suppressed).toEqual([])
    expect(u.counts.dormant).toBe(1)
  })
})

describe('flag parity — suppression binds identically in EVERY engine flag branch (house lesson: a guard in one branch is deleted when the flag flips)', () => {
  // Rain-heavy hydrology + heat so the todayAware fork, rain-credit, and saturation branches all engage.
  const wetOpts = { hydrology: { recent_precip_in: 0.2, today_precip_in: 1.0, today_pop: 80, upcoming_precip_in: 0.1, tomorrow_precip_in: 0.1, tomorrow_pop: 20 }, weather: { tonightLow: 68, highToday: 86, unit: 'F' } }
  const OUTDOOR_LITHOPS = { ...LITHOPS, covered: false }
  for (const todayAwareEnabled of [false, true]) {
    for (const rainCreditEnabled of [false, true]) {
      it(`todayAware=${todayAwareEnabled} rainCredit=${rainCreditEnabled}: Lithops suppressed, pepper still surfaces`, () => {
        const u = planFor([OUTDOOR_LITHOPS, { ...NORMAL, covered: false }], { ...wetOpts, todayAwareEnabled, rainCreditEnabled })
        expect(inAnyWaterList(u, 'li1')).toBe(false)
        expect(u.tasks.dormancy_suppressed.map((x) => x.id)).toContain('li1')
        expect(u.counts.dormancy_suppressed).toBe(1)
        // The normal planting must still be handled by the ordinary watering machinery under every flag
        // combo (water_due or a rain/saturation skip — never dormancy_suppressed).
        expect(inAnyWaterList(u, 'pep1')).toBe(true)
        expect(u.tasks.dormancy_suppressed.some((x) => x.id === 'pep1')).toBe(false)
      })
    }
  }
})
