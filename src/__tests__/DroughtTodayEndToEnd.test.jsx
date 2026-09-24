// BUG-DROUGHTNEVERFIRED-001 — the drought signal, engine to screen, on the REAL prod rain record.
//
// WHY THIS FILE EXISTS. The signal had never been emitted on prod (0 daily_plan rows with a `drought`
// key, 0 per-planting drought notes, all time, checked 2026-09-24), and "never fired" looks exactly like
// "cannot fire" from the plan table. The chain has four hops and each had its own green suite:
//   droughtSignal.js + handler.run()   -> the stored row      (lambda/daily-plan/droughtsignal.test.js)
//   daily-plan-read                    -> `plan` in the body  (static source guards only)
//   <DroughtLine> / CareNeeded's list  -> the screen          (DroughtLine.test.jsx, CareNeededDrought.test.jsx)
//   Today.jsx                          -> mounts both         (TodayDroughtMount.test.js, a source grep)
// but every seam between them was bridged by a HAND-COPIED payload. The client suites assert against a
// fixture that says in a comment it is "the exact shape droughtSignal.gardenDrought emits", which is a
// claim, not a check: rename `dry_days` on the server, update the server test, and every suite stays
// green while Today renders nothing forever. So this file runs the real thing end to end — the nightly
// run() writes a row, the real read Lambda serves it, the real Today page renders what it served — and
// asserts on the screen.
//
// THE RAIN RECORD IS VERBATIM PROD, not invented. weather_daily for Space 1, 2026-07-25..2026-09-23,
// read-only 2026-09-24. 60 of the 61 rows are gauge_merged; 2026-08-01 is openmeteo_archive. 2026-09-02's
// 1.12 is very probably the station's midnight-reset carry-over of 2026-09-01's total (identical to the
// hundredth; the Open-Meteo archive has 0.00 that day) — kept as stored, because this file pins what the
// engine was actually fed.
//
// WHAT IT PROVES, both directions:
//   FIRES — plan date 2026-08-24, the one real August day the shipped engine would have fired (08-04..08-23
//     is exactly 20 days under 0.60 in, bounded by 2.22 in on 08-03). The line and the per-planting list
//     reach the rendered Today page, carrying the server's own sentence.
//   SILENT — every plan date since the feature reached prod (v4.125.0, first plan 2026-09-09) through
//     2026-09-24. The counter was live and counting (status `ok`, never `insufficient`), and the dry-day
//     counts below are exactly what the deployed Lambda logged to CloudWatch on those dates. It peaked at
//     10 because 0.60 in+ fell on 2026-09-13 (1.48) and 2026-09-20 (0.97). So "never fired" was correct.
//
// DEEP WATERINGS ARE DELIBERATELY NOT FED IN, and that makes the silent half conservative rather than
// loose: a watering can only RESET the counter, never lengthen a run, so silence without them implies
// silence with them. The real record agrees: the last deep watering was 2026-09-03, the only one that
// clears the garden-wide bar is 2026-08-24, and all 195 post-ship runs logged `resetBy: rain`. The
// watering reset itself is proved through run() in droughtsignal.test.js.
//
// MUTATION-PROVEN 2026-09-24 (each applied alone, then reverted; count = failing tests of 6 here):
//   handler.js — drop `...(gardenDrought ? { drought: gardenDrought } : {})` from the row      3 red
//   droughtSignal.js gardenDrought — rename `dry_days` to `dryDays`                            3 red
//     (the five client-side drought suites, 39 tests, stay GREEN under this one: the drift this
//     file exists for. droughtsignal.test.js reds on its own shape assertions, which a deliberate
//     rename would update in the same commit.)
//   daily-plan-read PLAN_SCHEMA_VERSION 1 -> 2 (the read Lambda refuses the stored row)        4 red
//   Today.jsx — `<DroughtLine plan={plan.drought} />` (right component, wrong prop)            1 red
//   CareNeeded.jsx — `<DroughtList plan={plan} />` removed                                     1 red
//   droughtSignal.js DRY_DAYS 20 -> 21 (the real 08-24 run is exactly 20)                      3 red
//   droughtSignal.js DRY_DAYS 20 -> 10 (the silent half must be able to fail)                  2 red
//   handler.js — evaluate asOf the plan date instead of prevPlanDate (no settled row there, so
//     the counter reads `insufficient` every night: silent for the WRONG reason)              4 red
//     The peak-day render test stays green under that last one, as it must: silence cannot tell
//     "never fired" from "cannot fire". The sweep's `status: 'ok'` + exact day counts are what can.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'

const { planState, fetchMock, toastMock } = vi.hoisted(() => ({
  planState: { current: null },
  fetchMock: vi.fn(async () => ({ accepted: 1 })),
  toastMock: { show: vi.fn(), showUndo: vi.fn(), dismiss: vi.fn() },
}))

// The same harness seams LeafWetnessLine.test.jsx mounts Today through. useDailyPlan is replaced by the
// read Lambda's own response body below, so the page renders exactly what the server served.
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock }) }))
vi.mock('../hooks/useDailyPlan.js', () => ({ useDailyPlan: () => planState.current }))
// The stored row carries real coords, and this hook would otherwise go to Open-Meteo from a unit test.
// It feeds only the display-only live rain figure, never the drought line.
vi.mock('../hooks/useLiveRain.js', () => ({ useLiveRain: () => ({ liveHydrology: null, refreshedAt: null }) }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useLocation: () => ({ pathname: '/today' }),
  useNavigate: () => vi.fn(),
}))
vi.mock('../context/ToastContext.jsx', () => ({ useOptionalToast: () => toastMock }))

import dailyPlan from '../../lambda/daily-plan/handler.js'
import { handler as readPlan } from '../../lambda/daily-plan-read/index.js'
import { stubState, resetStubs } from '../../lambda/_test-stubs/state.js'
import { buildDroughtLine } from '../lib/droughtLine.js'
import Today from '../pages/Today.jsx'

const SPACE = '00000000-0000-0000-0000-000000000001'
const USER = 'user_e2e'

// Verbatim prod weather_daily.precip_in, Space 1, 2026-07-25..2026-09-23 (read-only, 2026-09-24).
const PROD_PRECIP = [
  ['2026-07-25', 0.00], ['2026-07-26', 0.00], ['2026-07-27', 0.00], ['2026-07-28', 0.80], ['2026-07-29', 2.84],
  ['2026-07-30', 0.54], ['2026-07-31', 0.64], ['2026-08-01', 0.12], ['2026-08-02', 0.00], ['2026-08-03', 2.22],
  ['2026-08-04', 0.00], ['2026-08-05', 0.00], ['2026-08-06', 0.02], ['2026-08-07', 0.00], ['2026-08-08', 0.09],
  ['2026-08-09', 0.00], ['2026-08-10', 0.00], ['2026-08-11', 0.00], ['2026-08-12', 0.00], ['2026-08-13', 0.01],
  ['2026-08-14', 0.00], ['2026-08-15', 0.00], ['2026-08-16', 0.00], ['2026-08-17', 0.21], ['2026-08-18', 0.01],
  ['2026-08-19', 0.00], ['2026-08-20', 0.09], ['2026-08-21', 0.00], ['2026-08-22', 0.04], ['2026-08-23', 0.34],
  ['2026-08-24', 0.00], ['2026-08-25', 0.00], ['2026-08-26', 0.00], ['2026-08-27', 0.00], ['2026-08-28', 0.00],
  ['2026-08-29', 0.00], ['2026-08-30', 0.00], ['2026-08-31', 0.00], ['2026-09-01', 1.12], ['2026-09-02', 1.12],
  ['2026-09-03', 0.04], ['2026-09-04', 0.04], ['2026-09-05', 0.01], ['2026-09-06', 0.29], ['2026-09-07', 0.00],
  ['2026-09-08', 0.00], ['2026-09-09', 0.05], ['2026-09-10', 0.05], ['2026-09-11', 0.00], ['2026-09-12', 0.00],
  ['2026-09-13', 1.48], ['2026-09-14', 0.01], ['2026-09-15', 0.00], ['2026-09-16', 0.00], ['2026-09-17', 0.17],
  ['2026-09-18', 0.00], ['2026-09-19', 0.00], ['2026-09-20', 0.97], ['2026-09-21', 0.00], ['2026-09-22', 0.00],
  ['2026-09-23', 0.00],
].map(([date, precip_in]) => ({ date, precip_in }))

// What the deployed garden-daily-plan logged as `drought-signal` on each plan date since v4.125.0
// (CloudWatch, 195 lines, every one `status: ok`). The last run of each day is the one shown; every run
// within a day agreed.
const PROD_DRY_DAYS = {
  '2026-09-09': 6, '2026-09-10': 7, '2026-09-11': 8, '2026-09-12': 9, '2026-09-13': 10,
  '2026-09-14': 0, '2026-09-15': 1, '2026-09-16': 2, '2026-09-17': 3, '2026-09-18': 4,
  '2026-09-19': 5, '2026-09-20': 6, '2026-09-21': 0, '2026-09-22': 1, '2026-09-23': 2,
  '2026-09-24': 3,
}

// A planting on a no-calendar-water profile, so BOTH drought surfaces are reachable: the garden-wide
// line (plan.drought) and the per-planting list (dormancy_suppressed[].drought). Same shape as the run()
// fixture in droughtsignal.test.js.
const NO_CAL_WATER = {
  _seeded: true, crop: 'blueberry', no_calendar_water: true, water_method: 'soak_then_dry',
  drought_tolerance: 'medium', water_interval_days_inground: 7, fertilize_interval_days: 0,
  soil_moisture_target: 'evenly moist; water on plant signal',
}
const PLANTINGS = [{
  id: 'bb1', name: 'Blueberry', project_id: 'pj1', status: 'harvested', container_type: 'in_ground',
  container_size: null, rain_exposed: null, variety: 'blueberry', genus: null, project: 'Beds',
  project_status: 'active', workspace_id: SPACE, crop_type_slug: 'blueberry', covered: false,
  frost_covered_resolved: false, assignee_user_id: USER, db_cadence: NO_CAL_WATER,
  last_water: '2026-07-20', last_fert: '2026-08-01', substrate_start: '2026-05-01', transplant_at: null,
}]

// Answers the drought series read the way Postgres would: only the rows inside the window the handler
// asked for ($2..$3). Every other statement gets nothing, including the deep-watering read (see header).
function prodPg() {
  return {
    query: vi.fn(async (sql, params = []) => {
      if (/select "date"::text as date, precip_in\s+from weather_daily/.test(sql)) {
        const [, from, to] = params
        return { rows: PROD_PRECIP.filter((r) => r.date >= from && r.date <= to) }
      }
      if (/from plants/.test(sql)) return { rows: PLANTINGS }
      if (/from spaces/.test(sql)) return { rows: [{ id: SPACE, postal_code: '01373', weather_lat: 42.5, weather_lng: -72.6 }] }
      return { rows: [] }
    }),
  }
}

// Hop 1: the real nightly entry point, with CARE_WATER_LEDGER_ENABLED unset (production's configuration).
// Returns the row it wrote and the `drought-signal` line it logged.
async function generate(planDate) {
  const logged = []
  const spy = vi.spyOn(console, 'log').mockImplementation((line) => { logged.push(line) })
  const pg = prodPg()
  try {
    await dailyPlan.run({
      pg, today: planDate, dryRun: false,
      geocodeZip: async () => ({ lat: 42.5, lng: -72.6 }),
      fetchNWS: async () => ({ tonightLow: 55, highToday: 75, code: 1, unit: 'F', short: 'Clear' }),
      fetchPrecip: async () => ({
        forecast_lows: [null, null, null], forecast_dates: [null, null, null],
        recent_precip_in: 0, today_precip_in: 0, today_pop: 0, upcoming_precip_in: 0,
        tomorrow_precip_in: 0, tomorrow_pop: 0, yesterday_precip_actual_in: 0, settled_days: [],
      }),
      fetchStation: async () => null, publishAlert: vi.fn(async () => ({ messageId: 'm1' })),
      etHour: 2, event: { rainLog: false },
    })
  } finally { spy.mockRestore() }
  const rows = pg.query.mock.calls
    .filter(([sql]) => /insert into daily_plan/.test(sql))
    .map(([, p]) => ({ user: p[0], planDate: p[1], items: JSON.parse(p[2]) }))
  const signal = logged
    .map((l) => { try { return JSON.parse(l) } catch { return null } })
    .find((j) => j && j.msg === 'drought-signal')
  return { rows, signal }
}

// Hop 2: the real read Lambda, handed that row the way the Neon driver returns jsonb (an object).
async function serve(items, planDate) {
  resetStubs()
  stubState.verifyTokenResult = { sub: USER }
  stubState.sqlHandler = (text) => (/_seed/.test(text)
    ? [{ plan_date: planDate, items: structuredClone(items), generated_at: `${planDate}T06:00:00.000Z` }]
    : [])
  const res = await readPlan({
    requestContext: { http: { method: 'GET' } }, rawPath: '/api/daily-plan',
    headers: { authorization: 'Bearer e2e' },
  })
  expect(res.statusCode).toBe(200)
  return JSON.parse(res.body)
}

// Hop 3: the real Today page, fed exactly the body the read Lambda returned.
function renderToday(body) {
  planState.current = { data: body, loading: false, error: null }
  return render(<Today />)
}

async function chain(planDate) {
  const { rows, signal } = await generate(planDate)
  expect(rows).toHaveLength(1)
  expect(rows[0].user).toBe(USER)
  const body = await serve(rows[0].items, planDate)
  return { stored: rows[0].items, signal, body }
}

beforeEach(() => { planState.current = null })
afterEach(() => { vi.restoreAllMocks(); resetStubs() })

describe('FIRES — the real 2026-08-04..08-23 run reaches the screen', () => {
  it('the nightly run writes the garden-wide line for plan date 2026-08-24 (exactly 20 dry days)', async () => {
    const { stored, signal } = await chain('2026-08-24')
    expect(signal).toMatchObject({ status: 'dry', dryDays: 20, lastDeepSoakDate: '2026-08-03', resetBy: 'rain', rows: 30 })
    expect(stored.drought).toMatchObject({ dry_days: 20, deep_soak_in: 0.6, last_deep_soak: '2026-08-03', truncated: false })
    expect(stored.drought.note).toMatch(/deep soak in 20 days/)
    expect(stored.dormancy_suppressed[0].drought).toMatchObject({ dry_days: 20 })
  })

  it('the read Lambda serves it as plan.drought, and the Today reader accepts what the server wrote', async () => {
    const { stored, body } = await chain('2026-08-24')
    expect(body.has_plan).toBe(true)
    expect(body.schema_stale).toBe(false)
    expect(body.plan.drought).toEqual(stored.drought)
    const line = buildDroughtLine(body.plan)
    expect(line).not.toBe(null)
    expect(line.text).toBe(stored.drought.note)
    expect(line.dryDays).toBe(20)
  })

  it('Today renders the server\'s own sentence, once, and lists the held-off planting', async () => {
    const { stored, body } = await chain('2026-08-24')
    renderToday(body)
    const lines = screen.getAllByTestId('drought-line')
    expect(lines).toHaveLength(1)
    expect(lines[0].textContent).toBe(stored.drought.note)
    expect(lines[0].getAttribute('data-drought-days')).toBe('20')
    const list = screen.getByTestId('care-drought-list')
    expect(within(list).getByText('Blueberry')).toBeTruthy()
    expect(list.textContent).toMatch(/No deep soak \(≥0\.60 in\) in 20 days/)
  })
})

describe('SILENT — every plan date since it reached prod, on the rain that actually fell', () => {
  it('counted every night (never `insufficient`) and matched what the deployed Lambda logged', async () => {
    for (const [planDate, dryDays] of Object.entries(PROD_DRY_DAYS)) {
      const { stored, signal, body } = await chain(planDate)
      expect({ planDate, status: signal.status, dryDays: signal.dryDays, rows: signal.rows })
        .toEqual({ planDate, status: 'ok', dryDays, rows: 30 })
      expect(stored.drought).toBeUndefined()
      expect(stored.dormancy_suppressed[0].drought).toBeUndefined()
      expect(body.has_plan).toBe(true)
      expect(buildDroughtLine(body.plan)).toBe(null)
    }
  })

  it('the peak day (2026-09-13, 10 dry days) renders a real plan with no drought line and no list', async () => {
    const { body } = await chain('2026-09-13')
    renderToday(body)
    // The page rendered a PLAN, so the absences below are the engine's silence, not a blank page.
    expect(screen.getByTestId('today-plan-stack')).toBeTruthy()
    expect(screen.queryByTestId('today-noplan-card')).toBe(null)
    expect(screen.queryByTestId('drought-line')).toBe(null)
    expect(screen.queryByTestId('care-drought-list')).toBe(null)
  })

  it('the longest run since ship is half the ruling, bounded by real deep-soak days', () => {
    const peak = Math.max(...Object.values(PROD_DRY_DAYS))
    expect(peak).toBe(10)
    const soaks = PROD_PRECIP.filter((r) => r.date >= '2026-09-01' && r.precip_in >= 0.6).map((r) => r.date)
    expect(soaks).toEqual(['2026-09-01', '2026-09-02', '2026-09-13', '2026-09-20'])
  })
})
