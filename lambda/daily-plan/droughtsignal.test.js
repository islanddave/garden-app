// V5-LEGACYEXCEPTIONCARE-001 — the drought signal: 20 consecutive days with no >=0.60 in deep soak.
//
// THIS SUITE IS DELIBERATELY TWO-SIDED. The previous lane refused to build this trigger precisely
// because at the depth the crucible verdict named (0.10 in, the in-ground `light` class) NO fixture
// could fire at all — a one-sided suite would have passed against a dead branch. Dave settled the pair
// at (0.60 in, 20 d) on 2026-09-08, which fires twice in the live 121-day archive, so both directions
// are now testable and both are tested: it fires, it declines at 19, it RESETS on an intervening soak,
// and it REFUSES on a series too short to support the claim.
//
// The firing fixture is not invented. REAL_AUG_2026 is the verbatim live weather_daily precip series
// for 2026-08-02..2026-09-02 (prod Neon, read-only as garden_ro, 2026-09-08), including the 2.22 in day
// that opens the run and the 1.12 in day that closes it. Its interior is the 2026-08-04..2026-08-31
// stretch that took 0.81 in across 28 days with no single day at or above 0.60.
//
// MUTATION-PROVEN 2026-09-08 (each mutation applied alone, then reverted):
//   droughtSignal.js `byDate.get(day) >= deepSoakIn`  -> `>`   redded "exactly 0.60 in resets the counter"
//   droughtSignal.js `dryDays >= dryDaysRequired`     -> `>`   redded "fires at exactly 20 dry days"
//   droughtSignal.js reset branch (never break on a soak) ->   redded "an intervening deep soak resets"
//   droughtSignal.js coverage refusal (return ok not insufficient) -> redded the short-series guard
import { describe, it, expect, vi, afterEach } from 'vitest'
import handler from './handler.js'
import dr from './droughtSignal.js'
import LP from './ledgerParams.js'
import engine from './engine.js'
import cad from './cadence-data-v2.json'
import fm from './fertilization-model.json'
import _cf from './_coverFlags.js'

const { evaluateDrought, droughtNote, DEEP_SOAK_IN, DRY_DAYS, WINDOW_DAYS } = dr
const { withCoverFlags } = _cf
const { generatePlan } = engine

const DAY = 86400000
const shift = (iso, n) => new Date(new Date(iso + 'T00:00:00Z').getTime() + n * DAY).toISOString().slice(0, 10)
// n days ending at `end`, each carrying `precip` (a number, or a fn(index-from-oldest) -> number).
const series = (end, n, precip) => Array.from({ length: n }, (_, i) => ({
  date: shift(end, -(n - 1 - i)),
  precip_in: typeof precip === 'function' ? precip(i) : precip,
}))

// Verbatim prod weather_daily, space Conway MA, 2026-08-02..2026-09-02.
const REAL_AUG_2026 = [
  ['2026-08-02', 0.00], ['2026-08-03', 2.22], ['2026-08-04', 0.00], ['2026-08-05', 0.00],
  ['2026-08-06', 0.02], ['2026-08-07', 0.00], ['2026-08-08', 0.09], ['2026-08-09', 0.00],
  ['2026-08-10', 0.00], ['2026-08-11', 0.00], ['2026-08-12', 0.00], ['2026-08-13', 0.01],
  ['2026-08-14', 0.00], ['2026-08-15', 0.00], ['2026-08-16', 0.00], ['2026-08-17', 0.21],
  ['2026-08-18', 0.01], ['2026-08-19', 0.00], ['2026-08-20', 0.09], ['2026-08-21', 0.00],
  ['2026-08-22', 0.04], ['2026-08-23', 0.34], ['2026-08-24', 0.00], ['2026-08-25', 0.00],
  ['2026-08-26', 0.00], ['2026-08-27', 0.00], ['2026-08-28', 0.00], ['2026-08-29', 0.00],
  ['2026-08-30', 0.00], ['2026-08-31', 0.00], ['2026-09-01', 1.12], ['2026-09-02', 1.12],
].map(([date, precip_in]) => ({ date, precip_in }))

describe('the settled parameters (canaries — a retune must reach Dave, not slip through)', () => {
  it('the depth IS the app\'s own in-ground `deep` class, and it is 0.60 in', () => {
    expect(DEEP_SOAK_IN).toBe(LP.RAIN_DEPTH_TIERS.in_ground.deep)
    expect(DEEP_SOAK_IN).toBe(0.60)
    // Not `light` (0.10). The whole correction to crucible Verdict 3 is that these are different numbers.
    expect(DEEP_SOAK_IN).not.toBe(LP.RAIN_DEPTH_TIERS.in_ground.light)
  })
  it('the day count is 20, and the read window is wide enough to make the claim', () => {
    expect(DRY_DAYS).toBe(20)
    expect(WINDOW_DAYS).toBeGreaterThanOrEqual(DRY_DAYS)
  })
})

describe('FIRES — the real 2026-08-04..2026-08-31 window', () => {
  it('fires on the live archive stretch: 28 days, 0.81 in total, no single day >= 0.60', () => {
    const interior = REAL_AUG_2026.filter((r) => r.date >= '2026-08-04' && r.date <= '2026-08-31')
    expect(interior).toHaveLength(28)
    expect(interior.every((r) => r.precip_in < 0.60)).toBe(true)
    expect(interior.reduce((a, r) => a + r.precip_in, 0)).toBeCloseTo(0.81, 5)

    const st = evaluateDrought(REAL_AUG_2026, { asOfDate: '2026-08-31' })
    expect(st.status).toBe('dry')
    expect(st.dryDays).toBe(28)
    expect(st.lastDeepSoakDate).toBe('2026-08-03')   // the 2.22 in day that opened the run
    expect(st.truncated).toBe(false)
  })
  it('fires at exactly 20 dry days — the boundary, not a comfortable margin', () => {
    const rows = [{ date: '2026-08-11', precip_in: 0.75 }, ...series('2026-08-31', 20, 0.0)]
    const st = evaluateDrought(rows, { asOfDate: '2026-08-31' })
    expect(st.status).toBe('dry')
    expect(st.dryDays).toBe(20)
    expect(st.lastDeepSoakDate).toBe('2026-08-11')
  })
  it('exactly 0.60 in resets the counter (>=, matching ledger.rainDepthClass); 0.59 does not', () => {
    // index 10 of 30 == 2026-08-12, leaving 19 dry days behind it. At 0.60 that is a reset and the
    // trigger stays quiet; at 0.59 nothing resets and the run walks the whole window.
    const at = evaluateDrought(series('2026-08-31', 30, (i) => (i === 10 ? 0.60 : 0.0)), { asOfDate: '2026-08-31' })
    expect(at.status).toBe('ok')
    expect(at.dryDays).toBe(19)
    expect(at.lastDeepSoakDate).toBe('2026-08-12')

    const under = evaluateDrought(series('2026-08-31', 30, (i) => (i === 10 ? 0.59 : 0.0)), { asOfDate: '2026-08-31' })
    expect(under.status).toBe('dry')
    expect(under.dryDays).toBe(30)
    expect(under.lastDeepSoakDate).toBe(null)
  })
})

describe('DOES NOT FIRE', () => {
  it('19 consecutive dry days does not fire — one short of the ruling', () => {
    const rows = [{ date: '2026-08-12', precip_in: 0.75 }, ...series('2026-08-31', 19, 0.0)]
    const st = evaluateDrought(rows, { asOfDate: '2026-08-31' })
    expect(st.status).toBe('ok')
    expect(st.dryDays).toBe(19)
    expect(droughtNote(st)).toBe(null)
  })
  it('an intervening deep soak resets: 25 days with one 0.80 in day in the middle', () => {
    // 25 days ending 2026-08-31; day index 12 (2026-08-19) takes 0.80 in. That leaves 12 dry days
    // after it. A day-counter that ignores the reset would call this 25 and fire; a drought trigger
    // must call it 12 and stay quiet.
    const rows = series('2026-08-31', 25, (i) => (i === 12 ? 0.80 : 0.0))
    const st = evaluateDrought(rows, { asOfDate: '2026-08-31' })
    expect(st.status).toBe('ok')
    expect(st.dryDays).toBe(12)
    expect(st.lastDeepSoakDate).toBe('2026-08-19')
    expect(droughtNote(st)).toBe(null)
  })
})

describe('SHORT-ARRAY GUARD — refuse, never report a false negative', () => {
  it('14 dry days refuses rather than reporting "no deep soak in 14 days"', () => {
    const st = evaluateDrought(series('2026-08-31', 14, 0.0), { asOfDate: '2026-08-31' })
    expect(st.status).toBe('insufficient')     // NOT 'ok' — 'ok' would assert a fact we cannot support
    expect(st.gap).toBe('short_series')
    expect(st.covered).toBe(14)
    expect(st.needed).toBe(20)
    expect(droughtNote(st)).toBe(null)
  })
  it('an empty series, a null series, and a missing asOfDate all refuse', () => {
    expect(evaluateDrought([], { asOfDate: '2026-08-31' }).status).toBe('insufficient')
    expect(evaluateDrought(null, { asOfDate: '2026-08-31' }).status).toBe('insufficient')
    expect(evaluateDrought(null, { asOfDate: '2026-08-31' }).gap).toBe('series_unavailable')
    expect(evaluateDrought(series('2026-08-31', 30, 0.0), {}).status).toBe('insufficient')
  })
  it('a HOLE inside the window refuses — a missing day is absent, never dry', () => {
    // 30 dry days with 2026-08-20 removed. That day could have carried two inches; the counter that
    // walks past it is claiming 30 observed days when it has seen 11.
    const rows = series('2026-08-31', 30, 0.0).filter((r) => r.date !== '2026-08-20')
    const st = evaluateDrought(rows, { asOfDate: '2026-08-31' })
    expect(st.status).toBe('insufficient')
    expect(st.covered).toBe(11)                // 2026-08-21..2026-08-31
  })
  it('a null precip_in is a hole, not a dry day', () => {
    const rows = series('2026-08-31', 30, (i) => (i === 22 ? null : 0.0))
    expect(evaluateDrought(rows, { asOfDate: '2026-08-31' }).status).toBe('insufficient')
  })
  it('a hole PAST 20 confirmed dry days still fires — those 20 days were observed', () => {
    const rows = series('2026-08-31', 30, 0.0).filter((r) => r.date !== '2026-08-05')
    const st = evaluateDrought(rows, { asOfDate: '2026-08-31' })
    expect(st.status).toBe('dry')
    expect(st.dryDays).toBe(26)                // 2026-08-06..2026-08-31
    expect(st.truncated).toBe(true)
  })
})

describe('WORDING — Dave\'s ruling: "no deep soak", never "no rain"', () => {
  const st = evaluateDrought(REAL_AUG_2026, { asOfDate: '2026-08-31' })
  it('names the deep soak and its depth', () => {
    expect(droughtNote(st)).toMatch(/deep soak/i)
    expect(droughtNote(st)).toMatch(/0\.60 in/)
    expect(droughtNote(st)).toMatch(/28 days/)
  })
  it('never says "no rain in N days" — that is the category slip this trigger exists to avoid', () => {
    expect(droughtNote(st)).not.toMatch(/no rain in/i)
    expect(droughtNote(st)).not.toMatch(/no measurable rain/i)
  })
  it('says "at least" when the run was cut off by the window rather than by a soak', () => {
    const trunc = evaluateDrought(series('2026-08-31', 30, 0.0), { asOfDate: '2026-08-31' })
    expect(trunc.truncated).toBe(true)
    expect(droughtNote(trunc)).toMatch(/at least 30 days/)
  })
})

// ── Delivery surface: the dormancy_suppressed hook (6 of 219 live plantings) ──────────────────────
const NO_CAL_WATER = {
  _seeded: true, crop: 'blueberry', no_calendar_water: true, water_method: 'soak_then_dry',
  drought_tolerance: 'medium', water_interval_days_inground: 7, fertilize_interval_days: 0,
  soil_moisture_target: 'evenly moist; water on plant signal',
}
const P = (o) => withCoverFlags({
  assignee_user_id: 'dave', project: 'Beds', project_id: 'pb', project_status: 'active',
  variety: null, genus: null, container_type: 'in_ground', container_size: null,
  substrate_start: '2026-01-01', transplant_at: null, last_fert: null, covered: false, ...o,
})
const BLUEBERRY = P({ id: 'bb1', name: 'Blueberry', status: 'harvested', last_water: '2026-07-20', db_cadence: NO_CAL_WATER })
const planWith = (droughtState) => generatePlan({
  plantings: [BLUEBERRY], cadence: cad, fertModel: fm, today: '2026-09-01',
  weather: { tonightLow: 60, highToday: 80, unit: 'F' },
  hydrology: { recent_precip_in: 0, today_precip_in: 0, today_pop: 0, upcoming_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0 },
  ownerFallback: 'dave', droughtState,
}).users.dave

describe('dormancy_suppressed delivery', () => {
  const DRY = evaluateDrought(REAL_AUG_2026, { asOfDate: '2026-08-31' })
  it('a suppressed planting carries the drought note and the structured key when the signal fires', () => {
    const row = planWith(DRY).tasks.dormancy_suppressed.find((x) => x.id === 'bb1')
    expect(row).toBeTruthy()
    expect(row.rule).toBe('no_calendar_water')
    expect(row.reason).toMatch(/deep soak/i)
    expect(row.reason).toMatch(/28 days/)
    expect(row.drought).toEqual({ dry_days: 28, deep_soak_in: 0.60, last_deep_soak: '2026-08-03', truncated: false })
  })
  it('the shipped suppression policy is UNCHANGED — the signal never routes it to water_due', () => {
    const u = planWith(DRY)
    expect(u.tasks.water_due.some((x) => x.id === 'bb1')).toBe(false)
    expect(u.tasks.no_history.some((x) => x.id === 'bb1')).toBe(false)
    expect(u.counts.dormancy_suppressed).toBe(1)
    expect(u.tasks.dormancy_suppressed[0].reason).toMatch(/never by interval/)
  })
  it('INERT when the signal does not fire, and byte-identical to an un-updated caller', () => {
    const off = planWith(null).tasks.dormancy_suppressed[0]
    const ok = planWith(evaluateDrought(series('2026-08-31', 25, (i) => (i === 12 ? 0.80 : 0.0)), { asOfDate: '2026-08-31' })).tasks.dormancy_suppressed[0]
    const short = planWith(evaluateDrought(series('2026-08-31', 14, 0.0), { asOfDate: '2026-08-31' })).tasks.dormancy_suppressed[0]
    expect(off.drought).toBeUndefined()
    expect(off.reason).not.toMatch(/deep soak/i)
    expect(ok).toEqual(off)
    expect(short).toEqual(off)
  })
})

// ── END-TO-END: run() -> series read -> evaluate -> engine -> the STORED plan ─────────────────────
// Everything above tests one link. This drives the real nightly entry point with the flag OFF (its
// production state) and reads the note back out of the daily_plan payload that was actually written.
// Without this the chain is inferred, and an inert feature whose engine half is perfect but whose
// input never arrives is the exact failure this row keeps hitting.
const E2E_SPACE = 'sp-1'
const E2E_USER = 'user_1'
const E2E_TODAY = '2026-09-01'      // asOfDate = 2026-08-31, the last day of the real 28-day run
const E2E_PLANTINGS = [{
  id: 'bb1', name: 'Blueberry', project_id: 'pj1', status: 'harvested', container_type: 'in_ground',
  container_size: null, rain_exposed: null, variety: 'blueberry', genus: null, project: 'Beds',
  project_status: 'active', workspace_id: E2E_SPACE, crop_type_slug: 'blueberry', covered: false,
  frost_covered_resolved: false, assignee_user_id: E2E_USER, db_cadence: NO_CAL_WATER,
  last_water: '2026-07-20', last_fert: '2026-08-01', substrate_start: '2026-05-01', transplant_at: null,
}]

function e2ePg(weatherRows) {
  const calls = []
  return {
    calls,
    query: vi.fn(async (sql) => {
      calls.push({ sql })
      if (/weather_daily/.test(sql)) return { rows: /^\s*select/i.test(sql) ? weatherRows : [] }
      if (/from plants/.test(sql)) return { rows: E2E_PLANTINGS }
      if (/from spaces/.test(sql)) return { rows: [{ id: E2E_SPACE, postal_code: null, weather_lat: 42.5, weather_lng: -72.6 }] }
      return { rows: [] }
    }),
  }
}
const storedPlans = (pg) => pg.query.mock.calls
  .filter(([sql]) => /insert into daily_plan/.test(sql))
  .map(([, params]) => JSON.parse(params[2]))

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

const driveRun = (weatherRows) => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const pg = e2ePg(weatherRows)
  return handler.run({
    pg, today: E2E_TODAY, dryRun: false,
    geocodeZip: async () => ({ lat: 42.5, lng: -72.6 }),
    fetchNWS: async () => ({ tonightLow: 60, highToday: 80, code: 1, unit: 'F', short: 'Clear' }),
    fetchPrecip: async () => ({
      forecast_lows: [null, null, null], forecast_dates: [null, null, null],
      recent_precip_in: 0, today_precip_in: 0, today_pop: 0, upcoming_precip_in: 0,
      tomorrow_precip_in: 0, tomorrow_pop: 0, yesterday_precip_actual_in: 0, settled_days: [],
    }),
    fetchStation: async () => null, publishAlert: vi.fn(async () => ({ messageId: 'm1' })),
    etHour: 2, event: { rainLog: false },
  }).then(() => pg)
}

describe('END-TO-END — the note reaches the STORED plan with CARE_WATER_LEDGER_ENABLED unset', () => {
  it('fires through run(): the real archive series lands as a drought note on the stored row', async () => {
    // The flag is deliberately NOT stubbed. This is production's configuration: absent from the live
    // garden-daily-plan env, so weatherDaily is null and the ledger fold never runs — and the drought
    // signal must still arrive.
    expect(process.env.CARE_WATER_LEDGER_ENABLED).toBeUndefined()
    const pg = await driveRun(REAL_AUG_2026)
    const [stored] = storedPlans(pg)
    expect(stored).toBeTruthy()
    expect(stored.counts.dormancy_suppressed).toBe(1)
    const row = stored.dormancy_suppressed[0]
    expect(row.id).toBe('bb1')
    expect(row.reason).toMatch(/no deep soak \(>=0\.60 in of rain in one day\) in 28 days/)
    expect(row.drought).toMatchObject({ dry_days: 28, deep_soak_in: 0.60, last_deep_soak: '2026-08-03' })
  })

  it('does NOT fire through run() when the returned window is too short — no false negative on the row', async () => {
    // The window you ASK for and the window you RECEIVE are different questions. Here the read comes
    // back with 14 days; a counter that trusted the request would report "no deep soak in 14 days".
    const pg = await driveRun(REAL_AUG_2026.filter((r) => r.date >= '2026-08-18' && r.date <= '2026-08-31'))
    const [stored] = storedPlans(pg)
    expect(stored.counts.dormancy_suppressed).toBe(1)
    expect(stored.dormancy_suppressed[0].reason).not.toMatch(/deep soak/i)
    expect(stored.dormancy_suppressed[0].drought).toBeUndefined()
  })
})
