// BUG-RAINTOMORROWMISLABEL-001 (b) — the rain row (the glance card's row B and the older Today's weather card,
// both rainSentences) shows tomorrow's rain whenever enough is coming to change watering, even when today holds
// the row's first line; and a chance nobody reported is never printed as 0%. The engine's rain cue reads tomorrow
// alone (engine.js rainCalloutFires) and loses the one cue slot to a freeze, cold or heat cue, so on those days
// this row is the only place on Today the figure can be.
import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render as rtlRender, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import engine from '../../lambda/daily-plan/engine.js'

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn(async () => ({ ok: true })) }))
vi.mock('../lib/api.js', async (orig) => ({ ...(await orig()), useApiFetch: () => ({ fetch: fetchMock }) }))

import GlanceCard from '../components/today/v2/GlanceCard.jsx'
import WeatherWidget from '../components/today/WeatherWidget.jsx'
import { rainSentences } from '../lib/rainSentences.js'
import { agreedTonightLow, agreeCallout } from '../lib/tonightLow.js'
import { currentLows } from '../lib/frostAlertLine.js'

const { computeCallout } = engine
const D = JSON.parse(readFileSync(resolve(process.cwd(), 'tests/harness/_todaymeasure/dailyplan.dave.json'), 'utf8'))
const COLD = { tonightLow: 42, highToday: 65 }
const MILD = { tonightLow: 60, highToday: 75 }   // no temperature cue: the engine's rain cue can speak

// A plan with the given hydrology on a cold night, carrying the one cue the engine computes for it.
function planFor(hy) {
  const weather = { ...D.plan.weather, ...COLD }
  const hydrology = { ...D.plan.hydrology, today_precip_in: 0, today_pop: 0, today_observed_in: null, today_remaining_in: null, ...hy }
  return { ...D.plan, alerts_sent: [], hydrology, weather: { ...weather, callout: computeCallout(weather, hydrology) } }
}
// The closed card's row B, one string per painted note.
function rowB(plan) {
  const agreed = agreedTonightLow(plan)
  const { container } = rtlRender(
    <MemoryRouter>
      <GlanceCard plan={plan} generatedAt={D.generated_at} planDate={D.plan_date} agreed={agreed} current={currentLows(plan)}
        cueCallout={agreeCallout(plan.weather?.callout, agreed)} open={false} onToggle={() => {}} />
    </MemoryRouter>,
  )
  const notes = [...container.querySelectorAll('[data-testid="today-glance"] [aria-expanded] > span:nth-of-type(3) > span')].map((n) => n.textContent)
  cleanup()
  return notes
}
// The older Today's card (also the glance card, opened): the rain line and the following-day line.
function widgetLines(plan) {
  const { container } = rtlRender(<WeatherWidget weather={plan.weather} hydrology={plan.hydrology} generatedAt={D.generated_at} planDate={D.plan_date} />)
  const text = container.textContent
  const next = screen.queryByTestId('weather-next-rain')?.textContent ?? null
  cleanup()
  return { text, next }
}
const cueSpeaksRain = (hy) => computeCallout(MILD, hy)?.icon === 'rain'

afterEach(cleanup)

describe('the rain row carries tomorrow whenever tomorrow is enough to change watering', () => {
  it('cold day, 0.50″ at 80% today, 0.40″ at 70% tomorrow: today AND tomorrow', () => {
    const plan = planFor({ today_precip_in: 0.5, today_pop: 80, tomorrow_precip_in: 0.4, tomorrow_pop: 70 })
    expect(plan.weather.callout.icon).toBe('cold')          // the cue slot is taken…
    expect(cueSpeaksRain(plan.hydrology)).toBe(true)        // …on a day the engine's rain rule fires
    expect(rowB(plan)).toEqual(['0.50″ today · 80% chance', '0.40″ tomorrow · 70% chance'])
    const w = widgetLines(plan)
    expect(w.text).toContain('0.50″ today · 80% chance')
    expect(w.next).toBe('0.40″ tomorrow · 70% chance')
  })

  it('cold day, the gauge has measured 0.45″ today, 0.40″ at 70% tomorrow: the measurement AND tomorrow', () => {
    const plan = planFor({ today_observed_in: 0.45, today_remaining_in: 0, tomorrow_precip_in: 0.4, tomorrow_pop: 70 })
    expect(cueSpeaksRain(plan.hydrology)).toBe(true)
    expect(rowB(plan)).toEqual(['0.45″ fallen today · none more expected', '0.40″ tomorrow · 70% chance'])
    const w = widgetLines(plan)
    expect(w.text).toContain('0.45″ fallen today · none more expected')
    expect(w.next).toBe('0.40″ tomorrow · 70% chance')
  })

  it('cold day, 0.40″ tomorrow with no chance given: the amount alone, as the engine prints it', () => {
    const plan = planFor({ tomorrow_precip_in: 0.4, tomorrow_pop: null })
    expect(computeCallout(MILD, plan.hydrology).text).toMatch(/^0\.40" rain tomorrow — /)
    expect(rowB(plan)).toEqual(['0.40″ tomorrow'])
    const w = widgetLines(plan)
    expect(w.text).toContain('0.40″ tomorrow')
    expect(w.text).not.toMatch(/\d% chance|null|undefined|NaN/)
  })

  it('rain today and tomorrow, neither with a chance: both amounts, no chance invented for either', () => {
    const plan = planFor({ today_precip_in: 0.5, today_pop: null, tomorrow_precip_in: 0.4, tomorrow_pop: null })
    expect(rowB(plan)).toEqual(['0.50″ today', '0.40″ tomorrow'])
    expect(widgetLines(plan).text).not.toMatch(/\d% chance|null|undefined|NaN/)
  })
})

describe('what did not move', () => {
  it('tomorrow under the watering bar and no bigger than today: today only', () => {
    for (const tomorrow of [{ tomorrow_precip_in: 0.29, tomorrow_pop: 90 }, { tomorrow_precip_in: 0.4, tomorrow_pop: 49 }, { tomorrow_precip_in: 0.5, tomorrow_pop: 0 }]) {
      const plan = planFor({ today_precip_in: 0.5, today_pop: 80, ...tomorrow })
      expect(cueSpeaksRain(plan.hydrology), JSON.stringify(tomorrow)).toBe(false)
      expect(rowB(plan)).toEqual(['0.50″ today · 80% chance'])
      expect(widgetLines(plan).next).toBeNull()
    }
  })

  it('a smaller tomorrow that still beats today keeps its line, as before', () => {
    const plan = planFor({ today_precip_in: 0.12, today_pop: 80, tomorrow_precip_in: 0.2, tomorrow_pop: 40 })
    expect(cueSpeaksRain(plan.hydrology)).toBe(false)
    expect(rowB(plan)).toEqual(['0.12″ today · 80% chance', '0.20″ tomorrow · 40% chance'])
  })

  it('dry today: tomorrow leads alone, and the day after still has to bring more', () => {
    expect(rowB(planFor({ tomorrow_precip_in: 0.4, tomorrow_pop: 70 }))).toEqual(['0.40″ tomorrow · 70% chance'])
    const d2 = { day2_precip_in: 0.4, day2_pop: 90, day2_date: '2026-09-26' }
    expect(rowB(planFor({ tomorrow_precip_in: 0.4, tomorrow_pop: 70, ...d2 }))).toEqual(['0.40″ tomorrow · 70% chance'])
    expect(rowB(planFor({ tomorrow_precip_in: 0.4, tomorrow_pop: 70, ...d2, day2_precip_in: 0.6 }))).toEqual(['0.40″ tomorrow · 70% chance', '0.60″ Saturday · 90% chance'])
    expect(rowB(planFor({ tomorrow_precip_in: 0, tomorrow_pop: 0 }))).toEqual([])
  })
})

describe('a chance nobody reported is left out of every sentence', () => {
  const rs = (hydrology, flags = {}) => rainSentences({ hydrology, ...flags })
  it('each sentence shape, with the chance missing', () => {
    expect(rs({ today_precip_in: 0.5 }).rainNote).toBe('0.50″ today')
    expect(rs({ tomorrow_precip_in: 0.14 }).rainNote).toBe('0.14″ tomorrow')
    expect(rs({ today_observed_in: 0.14, today_remaining_in: 0.15 }).rainNote).toBe('0.14″ fallen · 0.15″ more expected')
    expect(rs({ today_precip_in: 0.21 }, { uncertain: true, showery: true }).rainNote).toBe('~0.21″ today — could climb')
    expect(rs({}, { uncertain: true, showery: true }).rainNote).toBe('little so far, could climb')
    // nothing known at all: no line, where the overlay used to open one reading "0% chance of rain tomorrow"
    expect(rs({}, { live: true, liveHydrology: { today_precip_in: 0, tomorrow_precip_in: null } })).toEqual({ rainNote: null, nextNote: null, gaugeMeasured: false })
  })

  it('a reported 0% is still printed', () => {
    expect(rs({ today_precip_in: 0.5, today_pop: 0, tomorrow_precip_in: 0.14, tomorrow_pop: 0 }).rainNote).toBe('0.50″ today · 0% chance')
    expect(rs({}, { live: true, liveHydrology: { today_precip_in: 0, today_pop: 0, tomorrow_precip_in: 0, tomorrow_pop: 0 } }).rainNote).toBe('0% chance of rain tomorrow')
  })
})
