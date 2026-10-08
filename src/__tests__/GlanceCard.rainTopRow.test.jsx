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
    expect(rowB(plan)).toEqual(['0.45″ fallen today', '0.40″ tomorrow · 70% chance'])
    const w = widgetLines(plan)
    expect(w.text).toContain('0.45″ fallen today')
    expect(w.text).not.toContain('none more expected')
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

// Row B is 360 px wide at 426 and holds both notes on ONE row (gate:today-shape:v2, state v2-frost-rain). The
// measured line is the long one, so beside tomorrow's note it keeps its amounts and drops the rest; alone it is
// the sentence it always was. rainSentences picks the form, so the row and the weather card print the same words.
describe('the measured line is short beside tomorrow\'s note and whole when it stands alone', () => {
  const rs = (hydrology, flags = {}) => rainSentences({ hydrology, ...flags })
  const BASE = { today_precip_in: 0, today_pop: 40 }
  const WET = { tomorrow_precip_in: 0.4, tomorrow_pop: 70 }
  const QUIET = { tomorrow_precip_in: 0.05, tomorrow_pop: 20 }
  const LIVE = (tomorrow) => ({ live: true, generatedAt: '2026-09-24T09:30:00.000Z', liveHydrology: { today_precip_in: 0, today_pop: 40, ...tomorrow } })

  it('nothing more expected: "N″ fallen today" beside, the full sentence alone', () => {
    const fallen = { ...BASE, today_observed_in: 0.45, today_remaining_in: 0 }
    expect(rs({ ...fallen, ...WET })).toMatchObject({ rainNote: '0.45″ fallen today', nextNote: '0.40″ tomorrow · 70% chance' })
    expect(rs({ ...fallen, ...QUIET })).toMatchObject({ rainNote: '0.45″ fallen today · none more expected', nextNote: null })
    // no forecast behind the day: alone it was already the bare measurement, and beside it is the same words
    expect(rs({ ...fallen, ...QUIET }, { noForecast: true }).rainNote).toBe('0.45″ fallen today')
    expect(rs({ ...fallen, ...WET }, { noForecast: true }).rainNote).toBe('0.45″ fallen today')
  })

  it('more expected: "N″ fallen · M″ more" beside (no chance), the full sentence alone', () => {
    const mid = { ...BASE, today_observed_in: 0.14, today_remaining_in: 0.15 }
    expect(rs({ ...mid, ...WET })).toMatchObject({ rainNote: '0.14″ fallen · 0.15″ more', nextNote: '0.40″ tomorrow · 70% chance' })
    expect(rs({ ...mid, ...QUIET })).toMatchObject({ rainNote: '0.14″ fallen · 0.15″ more expected · 40%', nextNote: null })
  })

  it('under the live overlay the "as of H:MM" is dropped only beside tomorrow\'s note', () => {
    const fallen = { ...BASE, today_observed_in: 0.45, today_remaining_in: 0 }
    const mid = { ...BASE, today_observed_in: 0.14, today_remaining_in: 0.15 }
    expect(rs(fallen, LIVE(QUIET))).toMatchObject({ rainNote: '0.45″ fallen as of 5:30 AM · none more expected', nextNote: null })
    expect(rs(fallen, LIVE(WET))).toMatchObject({ rainNote: '0.45″ fallen today', nextNote: '0.40″ tomorrow · 70% chance' })
    expect(rs(mid, LIVE(QUIET))).toMatchObject({ rainNote: '0.14″ fallen as of 5:30 AM · 0.15″ more expected · 40%', nextNote: null })
    expect(rs(mid, LIVE(WET))).toMatchObject({ rainNote: '0.14″ fallen · 0.15″ more', nextNote: '0.40″ tomorrow · 70% chance' })
  })

  it('a tomorrow that is only BIGGER (under the watering bar) puts the same short line beside it', () => {
    const fallen = { ...BASE, today_observed_in: 0.05, today_remaining_in: 0 }
    expect(rs({ ...fallen, tomorrow_precip_in: 0.2, tomorrow_pop: 40 })).toMatchObject({ rainNote: '0.05″ fallen today', nextNote: '0.20″ tomorrow · 40% chance' })
  })

  it('a forecast today line is the same beside tomorrow\'s note as alone', () => {
    const today = { today_precip_in: 0.5, today_pop: 80 }
    expect(rs({ ...today, ...WET }).rainNote).toBe('0.50″ today · 80% chance')
    expect(rs({ ...today, ...QUIET }).rainNote).toBe('0.50″ today · 80% chance')
  })

  // The showery line (no live overlay) follows the same rule: its caveat is dropped only beside the next note.
  describe('the showery line', () => {
    const SHOWERY = { uncertain: true, showery: true }
    const TOMORROW = '0.40″ tomorrow · 70% chance'

    it('an amount: "~N″ today · P%" beside, "— could climb" alone', () => {
      const amt = { today_precip_in: 0.21, today_pop: 40 }
      expect(rs({ ...amt, ...WET }, SHOWERY)).toMatchObject({ rainNote: '~0.21″ today · 40%', nextNote: TOMORROW })
      expect(rs({ ...amt, ...QUIET }, SHOWERY)).toMatchObject({ rainNote: '~0.21″ today · 40% — could climb', nextNote: null })
      // no chance reported: the amount alone, no stray separator
      expect(rs({ today_precip_in: 0.21, ...WET }, SHOWERY)).toMatchObject({ rainNote: '~0.21″ today', nextNote: TOMORROW })
    })

    it('a chance and little rain: "P% chance today" beside, the full line alone', () => {
      const pop = { today_precip_in: 0.04, today_pop: 60 }
      expect(rs({ ...pop, ...WET }, SHOWERY)).toMatchObject({ rainNote: '60% chance today', nextNote: TOMORROW })
      expect(rs({ ...pop, ...QUIET }, SHOWERY)).toMatchObject({ rainNote: '60% chance today · little so far, could climb', nextNote: null })
    })

    it('neither: "Showers today" beside, the full line alone', () => {
      const bare = { today_precip_in: 0.04 }
      expect(rs({ ...bare, ...WET }, SHOWERY)).toMatchObject({ rainNote: 'Showers today', nextNote: TOMORROW })
      expect(rs({ ...bare, ...QUIET }, SHOWERY)).toMatchObject({ rainNote: 'Showers today · little so far, could climb', nextNote: null })
    })

    it('the row and the weather card both print the short pair', () => {
      const status = { ok: true, uncertainty: { flag: true } }
      const plan = planFor({ today_precip_in: 0.21, today_pop: 40, ...WET, status })
      expect(rowB(plan)).toEqual(['~0.21″ today · 40%', TOMORROW])
      const w = widgetLines(plan)
      expect(w.text).toContain('~0.21″ today · 40%')
      expect(w.text).not.toContain('could climb')
      expect(w.next).toBe(TOMORROW)
      expect(rowB(planFor({ today_precip_in: 0.21, today_pop: 40, ...QUIET, status }))).toEqual(['~0.21″ today · 40% — could climb'])
    })
  })

  it('the row and the weather card print the same two lines', () => {
    for (const hy of [
      { today_observed_in: 0.45, today_remaining_in: 0, ...WET },
      { today_observed_in: 0.14, today_remaining_in: 0.15, today_pop: 40, ...WET },
      { today_observed_in: 0.45, today_remaining_in: 0, tomorrow_precip_in: 0.4, tomorrow_pop: null },
      { today_observed_in: 0.45, today_remaining_in: 0, ...QUIET },
    ]) {
      const plan = planFor(hy)
      const notes = rowB(plan)
      const w = widgetLines(plan)
      expect(notes.length, JSON.stringify(hy)).toBeGreaterThan(0)
      for (const n of notes) expect(w.text.split(n).length - 1, n).toBe(1)
      expect(w.next).toBe(notes[1] ?? null)
      for (const n of notes) expect(n).not.toMatch(/ · $|^ · | ·  · |null|undefined|NaN/)
    }
  })
})

describe('a line with neither an amount nor a chance prints nothing at all', () => {
  it('no empty note, no lone icon, no stray separator on either surface', () => {
    const plan = planFor({ today_precip_in: null, today_pop: null, tomorrow_precip_in: null, tomorrow_pop: null })
    expect(rainSentences({ hydrology: plan.hydrology })).toEqual({ rainNote: null, nextNote: null, gaugeMeasured: false })
    expect(rowB(plan)).toEqual([])
    const { container } = rtlRender(<WeatherWidget weather={plan.weather} hydrology={plan.hydrology} generatedAt={D.generated_at} planDate={D.plan_date} />)
    expect(screen.queryByTestId('weather-next-rain')).toBeNull()
    expect(container.textContent).not.toMatch(/chance|fallen|tomorrow|could climb|″/)
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
    // no amount and no chance on a showery day: the line still says which day it is about
    expect(rs({}, { uncertain: true, showery: true }).rainNote).toBe('Showers tomorrow · little so far, could climb')
    expect(rs({ today_precip_in: 0.04 }, { uncertain: true, showery: true }).rainNote).toBe('Showers today · little so far, could climb')
    expect(rs({ today_precip_in: 0.04, today_pop: 60 }, { uncertain: true, showery: true }).rainNote).toBe('60% chance today · little so far, could climb')
    // nothing known at all: no line, where the overlay used to open one reading "0% chance of rain tomorrow"
    expect(rs({}, { live: true, liveHydrology: { today_precip_in: 0, tomorrow_precip_in: null } })).toEqual({ rainNote: null, nextNote: null, gaugeMeasured: false })
  })

  it('a reported 0% is still printed', () => {
    expect(rs({ today_precip_in: 0.5, today_pop: 0, tomorrow_precip_in: 0.14, tomorrow_pop: 0 }).rainNote).toBe('0.50″ today · 0% chance')
    expect(rs({}, { live: true, liveHydrology: { today_precip_in: 0, today_pop: 0, tomorrow_precip_in: 0, tomorrow_pop: 0 } }).rainNote).toBe('0% chance of rain tomorrow')
  })
})
