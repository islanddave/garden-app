// V5-FROSTTWOMODELS-001 — one low per night on Today: the MOUNT. The pure half is tonightLow.test.js.
//
// The wiring is what these cases exist for. Every helper in src/lib/tonightLow.js can be right while
// Today passes the wrong thing to the wrong component, and then the page still prints two lows for one
// night with every unit test green. So each case below hands Today an ENGINE-SHAPED stored plan (the
// REAL computeCallout and coldFor, helpers/twoLowsFixtures.js) and reads what Today renders: the moon
// figure on the forecast card, the cue, the frost line, the Protect rows and the impression beacon.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, cleanup } from '@testing-library/react'

const { planState, fetchMock, toastMock } = vi.hoisted(() => ({
  planState: { current: null },
  fetchMock: vi.fn(async () => ({ accepted: 1 })),
  toastMock: { show: vi.fn(), showUndo: vi.fn(), dismiss: vi.fn() },
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock }) }))
vi.mock('../hooks/useDailyPlan.js', () => ({ useDailyPlan: () => planState.current }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useLocation: () => ({ pathname: '/today' }),
  useNavigate: () => vi.fn(),
}))
vi.mock('../context/ToastContext.jsx', () => ({ useOptionalToast: () => toastMock }))
// The REAL watering scale, recorded: the care guard below asserts what the card hands it.
vi.mock('../lib/wateringScale.js', async (orig) => {
  const real = await orig()
  return { ...real, computeWateringScale: vi.fn(real.computeWateringScale) }
})

import Today from '../pages/Today.jsx'
import WeatherWidget from '../components/today/WeatherWidget.jsx'
import FrostAlertLine from '../components/today/FrostAlertLine.jsx'
import { computeWateringScale } from '../lib/wateringScale.js'
import { CUE_IMPRESSIONS_PATH } from '../lib/weatherCueImpressions.js'
import { buildCueLine } from '../lib/weatherCue.js'
import { buildFrostAlertLine } from '../lib/frostAlertLine.js'
import {
  ROWS, GRID_LOWS, GRID_ENTRIES, PLAN_DATE, GEN, DRY, planFor, coldBucket, deepFreeze, tonight, tomorrowNight,
  PEPPER, FITTONIA,
} from './helpers/twoLowsFixtures.js'

const mountData = (plan) => ({ data: { has_plan: true, plan_date: PLAN_DATE, generated_at: GEN, plan }, loading: false, error: null })
const impressions = () => fetchMock.mock.calls.filter((c) => c[0] === CUE_IMPRESSIONS_PATH).map((c) => JSON.parse(c[1].body))

// A CareNeeded row is [link: name + reason][Skip][chip]; the chip's accessible name is "Log <verb> for
// <name>" and the row is its parent. The reason is the link text after the name.
function careRows(container) {
  return within(container).queryAllByRole('button', { name: /^Log \S+ for / }).map((b) => {
    const row = b.parentElement
    const link = row.querySelector('a')
    const name = b.getAttribute('aria-label').replace(/^Log \S+ for /, '')
    return { label: b.getAttribute('aria-label'), name, reason: link.textContent.slice(name.length), text: row.textContent }
  })
}

function readPage(container) {
  const q = within(container)
  const card = q.getByTestId('weather-night-low').textContent
  expect(card.endsWith('°')).toBe(true)
  return {
    card: card.slice(0, -1),
    cue: q.queryByTestId('weather-cue-line')?.textContent ?? null,
    line: q.queryByTestId('frost-alert-line')?.textContent ?? null,
    protect: careRows(container).filter((r) => r.label.startsWith('Log Protect for ')).map((r) => r.reason),
  }
}

beforeEach(() => { fetchMock.mockClear(); computeWateringScale.mockClear(); planState.current = null })

describe('the spec table on Today — rows 1-12 render as specified, and bill as specified', () => {
  it.each(ROWS.map((r) => [r.n, r]))('row %i', (_n, row) => {
    planState.current = mountData(planFor(row.low, row.entries, row.hy))
    const { container } = render(<Today />)
    const page = readPage(container)
    expect(page).toEqual({ card: row.after.card, cue: row.after.cue, line: row.after.line, protect: row.after.protect })
    const billed = impressions()
    if (row.after.model == null) {
      expect(billed).toEqual([])
    } else {
      expect(billed).toHaveLength(1)
      expect(billed[0].model_version).toBe(row.after.model)
      expect(billed[0].cue).toBe(screen.getByTestId('weather-cue-line').dataset.cue)
    }
  })

  it('row 2 bills { cue: freeze, form: imperative, model_version: wxcue-v1-agreed }', () => {
    planState.current = mountData(planFor(43, [tonight(37.6)]))
    render(<Today />)
    expect(impressions()).toEqual([{ cue: 'freeze', form: 'imperative', model_version: 'wxcue-v1-agreed', plan_generated_at: GEN }])
    expect(screen.getByTestId('weather-cue-line').dataset.cue).toBe('freeze')
  })

  it('no source name, asterisk or "adjusted" mark anywhere on a trigger night', () => {
    planState.current = mountData(planFor(43, [tonight(37.6)]))
    const { container } = render(<Today />)
    const text = container.textContent
    expect(text).not.toMatch(/\*|adjusted|NWS|Open-Meteo forecast low|advisory low|station/i)
    // Control: the page did change — the card and the cue both print the agreed 38.
    expect(screen.getByTestId('weather-night-low').textContent).toBe('38°')
    expect(screen.getByTestId('weather-cue-line').textContent).toMatch(/\(38°F\)/)
  })
})

describe('the grid — plan low x entry x the REAL callout: ONE number for tonight when the trigger is on', () => {
  it('every combination', () => {
    const nums = (s) => (s == null ? [] : (s.match(/-?\d+(?:\.\d+)?/g) || []).map(Number))
    let on = 0, off = 0
    for (const low of GRID_LOWS) {
      for (const { name, entries, tonightLow } of GRID_ENTRIES) {
        fetchMock.mockClear()
        const plan = planFor(low, structuredClone(entries))
        planState.current = mountData(plan)
        const { container, unmount } = render(<Today />)
        const page = readPage(container)
        const where = `plan low ${low} x ${name}`
        if (tonightLow != null) {
          const T = Math.round(low == null ? tonightLow : Math.min(low, tonightLow))
          const seen = new Set([...nums(page.card), ...nums(page.cue), ...nums(page.line), ...page.protect.flatMap(nums)])
          expect([...seen], where).toEqual([T])
          expect(page.card, where).toBe(String(T))
          expect(page.line, where).toMatch(new RegExp(`^Frost possible tonight — low ${T}°F\\.`))
          // A silent cue stays silent (Q1); a cue that spoke still speaks.
          expect(page.cue == null, where).toBe(plan.weather.callout == null)
          on++
        } else {
          // No trigger: exactly what the base commit rendered.
          expect(page.card, where).toBe(low == null ? '' : String(low))
          expect(page.cue, where).toBe(buildCueLine(plan.weather.callout)?.text ?? null)
          expect(page.line, where).toBe(buildFrostAlertLine(entries)?.text ?? null)
          expect(page.protect, where).toEqual(coldBucket(low).map((c) => c.text))
          off++
        }
        unmount()
        cleanup()
      }
    }
    expect([on, off]).toEqual([GRID_LOWS.length * 5, GRID_LOWS.length * 2])
  })
})

describe('the care guard — deep-frozen plan; the lanes and the care list do not move', () => {
  // A realistic list: water, feed, pest and two Protect cards, on a dry day so both lanes speak.
  const richPlan = (entries) => ({
    ...planFor(43, entries),
    water_due: [
      { id: 'w1', name: 'Basil Row', crop: 'basil', project: 'Bag Area', project_id: 'pj-bag', interval: 3, overdue_by: 2, days_since: 5 },
      { id: 'w2', name: 'Chard Bed', crop: 'chard', project: 'Bed', project_id: 'pj-bed', interval: 2, overdue_by: 1, days_since: 3, in_ground: true },
    ],
    fertilize: [{ id: 'f1', name: 'Tomato Big', crop: 'tomato', project: 'Bag Area', project_id: 'pj-bag', item: 'Fish emulsion', apply: 'half strength' }],
    pest: [{ id: 'p1', name: 'Kale Row', crop: 'kale', project: 'Bed', project_id: 'pj-bed', label: 'Scout for aphids' }],
  })

  function snapshot(entries) {
    const plan = richPlan(structuredClone(entries))
    planState.current = deepFreeze(mountData(plan))
    const { container, unmount } = render(<Today />)
    const lanes = within(container).getAllByRole('img', { name: /^(Containers|In-ground beds): / }).map((el) => el.getAttribute('aria-label'))
    const rows = careRows(container).map((r) => r.text)
    const scaleWeather = computeWateringScale.mock.calls.map(([, w]) => w)
    const card = within(container).getByTestId('weather-night-low').textContent
    unmount()
    cleanup()
    computeWateringScale.mockClear()
    return { plan, lanes, rows, scaleWeather, card }
  }

  it('trigger on vs off: identical lanes and rows apart from the removed "(low …)", and no write to the plan', () => {
    // OFF is the near-miss: the SAME advisory, naming tomorrow night instead of tonight.
    const offS = snapshot([tonight(37.6, { nightOffset: 1 })])
    const onS = snapshot([tonight(37.6)])
    expect(onS.card).toBe('38°')                         // the trigger really fired…
    expect(offS.card).toBe('43°')                        // …and really did not
    expect(onS.lanes).toEqual(offS.lanes)
    expect(onS.lanes).toHaveLength(2)
    expect(onS.rows).toHaveLength(offS.rows.length)
    expect(onS.rows.length).toBeGreaterThanOrEqual(6)
    expect(onS.rows).toEqual(offS.rows.map((t) => t.replace(/ \(low [^()]*\)/, '')))
    // Control: the off rows DID carry the number the on rows dropped.
    expect(offS.rows.filter((t) => / \(low /.test(t))).toHaveLength(2)
    expect(onS.rows.filter((t) => / \(low /.test(t))).toHaveLength(0)
  })

  it('the watering scale is handed the STORED plan.weather itself — never the agreed low', () => {
    const onS = snapshot([tonight(37.6)])
    expect(onS.scaleWeather.length).toBeGreaterThan(0)
    for (const w of onS.scaleWeather) expect(w).toBe(onS.plan.weather)
    expect(onS.plan.weather.tonightLow).toBe(43)
  })
})

describe('the components on their own', () => {
  it('WeatherWidget prints lowShown in the moon figure when set, the plan low otherwise', () => {
    const weather = { tonightLow: 55, highToday: 70, code: 3, hot: false }
    const { unmount } = render(<WeatherWidget weather={weather} hydrology={DRY} lowShown={38} />)
    expect(screen.getByTestId('weather-night-low').textContent).toBe('38°')
    unmount()
    render(<WeatherWidget weather={weather} hydrology={DRY} />)
    expect(screen.getByTestId('weather-night-low').textContent).toBe('55°')
  })

  it('FrostAlertLine prints lowShown when set, its own figure otherwise', () => {
    const { unmount } = render(<FrostAlertLine alertsSent={[tonight(37.6)]} lowShown={36} />)
    expect(screen.getByTestId('frost-alert-line').textContent).toBe('Frost possible tonight — low 36°F. Plan cover for tender plants.')
    unmount()
    render(<FrostAlertLine alertsSent={[tomorrowNight(36.4)]} />)
    expect(screen.getByTestId('frost-alert-line').textContent).toBe('Frost possible tomorrow night — low 36°F. Plan cover for tender plants.')
  })

  it('the two plantings reach the two coldFor paths the rows depend on', () => {
    expect(coldBucket(39).map((c) => [c.id, c.level])).toEqual([[PEPPER.id, 'bring_in'], [FITTONIA.id, 'protect']])
    expect(coldBucket(43).map((c) => c.level)).toEqual(['optional', 'protect'])
  })
})
