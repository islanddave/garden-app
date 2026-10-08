// V5-TODAYREDESIGN-001 S3a — rainSentences (src/lib/rainSentences.js): the Today weather card's rain line and
// following-day line, lifted verbatim out of WeatherWidget.jsx so the V2 glance card prints the same sentences.
// The card's own strings stay pinned where they always were (WeatherWidget.test.jsx, rainCardEngineParity,
// todayWaterHonesty — none edited by the move). This file pins the pure function directly, so a second
// consumer inherits the three deliberate behaviours: amount and chance side by side, never their product;
// the following-day line only for >= 0.10″ and only when it brings more than the line above; a gauge
// measurement outranks a forecast.
import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import { rainSentences, basisTimeLabel } from '../lib/rainSentences.js'
import WeatherWidget from '../components/today/WeatherWidget.jsx'

const rs = (hydrology, flags = {}) => rainSentences({ hydrology, ...flags })
const deepFreeze = (o) => { if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o) } return o }
const DRY = { today_precip_in: 0, today_pop: 0, tomorrow_precip_in: 0, tomorrow_pop: 0 }

afterEach(() => { vi.useRealTimers(); cleanup() })

describe('amount and chance side by side, never their product', () => {
  it('2026-09-25 evening: 0.14″ at 37% prints both figures, not the 0.05″ expected value', () => {
    const r = rs({ recent_precip_in: 0, today_precip_in: 0, today_pop: 5, tomorrow_precip_in: 0.14, tomorrow_pop: 37 })
    expect(r).toEqual({ rainNote: '0.14″ tomorrow · 37% chance', nextNote: null, gaugeMeasured: false })
    expect(r.rainNote).not.toContain('0.05')
  })

  it('across amounts and chances the printed amount is the forecast amount, and the product never appears', () => {
    let checked = 0
    for (const amt of [0.14, 0.3, 0.58, 1.72]) {
      for (const pop of [5, 29, 37, 63, 99]) {
        const { rainNote } = rs({ ...DRY, tomorrow_precip_in: amt, tomorrow_pop: pop })
        expect(rainNote).toBe(`${amt.toFixed(2)}″ tomorrow · ${pop}% chance`)
        const product = `${(amt * pop / 100).toFixed(2)}″`
        if (product !== `${amt.toFixed(2)}″`) { expect(rainNote).not.toContain(product); checked++ }
      }
    }
    expect(checked).toBeGreaterThan(15)
  })

  it('today’s own rain leads when today has an amount', () => {
    expect(rs({ today_precip_in: 0.21, today_pop: 88, tomorrow_precip_in: 0.74, tomorrow_pop: 63 }))
      .toEqual({ rainNote: '0.21″ today · 88% chance', nextNote: '0.74″ tomorrow · 63% chance', gaugeMeasured: false })
  })

  it('an unknown, zero or sub-hundredth amount prints the chance alone, never an invented amount', () => {
    expect(rs({ ...DRY, today_pop: 10, tomorrow_precip_in: null, tomorrow_pop: 63 }).rainNote).toBe('63% chance of rain tomorrow')
    expect(rs({ ...DRY, tomorrow_pop: 40 }).rainNote).toBe('40% chance of rain tomorrow')
    expect(rs({ ...DRY, tomorrow_precip_in: 0.004, tomorrow_pop: 40 }).rainNote).toBe('40% chance of rain tomorrow')
  })

  it('an unknown tomorrow never borrows upcoming_precip_in, the two-day total', () => {
    const r = rs({ ...DRY, tomorrow_precip_in: null, tomorrow_pop: 63, upcoming_precip_in: 1.8 })
    expect(r.rainNote).toBe('63% chance of rain tomorrow')
    expect(r.nextNote).toBeNull()
  })

  it('a dry, quiet day prints no line; a 30% chance on its own opens it', () => {
    expect(rs({ ...DRY, tomorrow_pop: 29 })).toEqual({ rainNote: null, nextNote: null, gaugeMeasured: false })
    expect(rs({ ...DRY, tomorrow_pop: 30 }).rainNote).toBe('30% chance of rain tomorrow')
  })
})

describe('the following-day line', () => {
  const SEP25 = { recent_precip_in: 0, today_precip_in: 0, today_pop: 5, tomorrow_precip_in: 0.58, tomorrow_pop: 100,
    upcoming_precip_in: 1.8, day2_precip_in: 1.22, day2_pop: 100, day2_date: '2026-09-27' }

  it('names the day after tomorrow when it brings more, and never prints the two-day total', () => {
    const r = rs(SEP25)
    expect(r.rainNote).toBe('0.58″ tomorrow · 100% chance')
    expect(r.nextNote).toBe('1.22″ Sunday · 100% chance')
    expect(`${r.rainNote} ${r.nextNote}`).not.toContain('1.80')
  })

  it('opens at exactly 0.10″ and not below, even while the first line is shut', () => {
    const dayAfter = (amt) => rs({ ...DRY, tomorrow_pop: 10, day2_precip_in: amt, day2_pop: 70, day2_date: '2026-09-27' })
    expect(dayAfter(0.1)).toEqual({ rainNote: null, nextNote: '0.10″ Sunday · 70% chance', gaugeMeasured: false })
    expect(dayAfter(0.09).nextNote).toBeNull()
  })

  it('must bring MORE than the line above, compared in printed hundredths', () => {
    const vs = (t, d) => rs({ ...DRY, tomorrow_precip_in: t, tomorrow_pop: 60, day2_precip_in: d, day2_pop: 80, day2_date: '2026-09-27' }).nextNote
    expect(vs(0.4, 0.41)).toBe('0.41″ Sunday · 80% chance')
    expect(vs(0.4, 0.4)).toBeNull()
    expect(vs(0.4, 0.3)).toBeNull()
    expect(vs(0.404, 0.396)).toBeNull()
  })

  it('when the first line is today, the next line is tomorrow — never the day after', () => {
    const h = { today_precip_in: 0.21, today_pop: 88, tomorrow_precip_in: 0.1, tomorrow_pop: 40, day2_precip_in: 2.5, day2_pop: 90, day2_date: '2026-09-27' }
    expect(rs(h).nextNote).toBeNull()
    expect(rs({ ...h, tomorrow_precip_in: 0.3 }).nextNote).toBe('0.30″ tomorrow · 40% chance')
  })

  it('a measured day is the first line even when the forecast calls today dry, so the next line is tomorrow', () => {
    const h = { ...DRY, today_observed_in: 0.29, today_remaining_in: 0, tomorrow_precip_in: 0.5, tomorrow_pop: 60,
      day2_precip_in: 1, day2_pop: 80, day2_date: '2026-09-27' }
    expect(rs(h)).toEqual({ rainNote: '0.29″ fallen today', nextNote: '0.50″ tomorrow · 60% chance', gaugeMeasured: true })
  })

  it('after a measured line it must beat fallen + still-expected', () => {
    const h = { today_precip_in: 0.03, today_pop: 40, today_observed_in: 0.14, today_remaining_in: 0.15, tomorrow_pop: 55 }
    expect(rs({ ...h, tomorrow_precip_in: 0.25 }).nextNote).toBeNull()
    expect(rs({ ...h, tomorrow_precip_in: 0.35 }).nextNote).toBe('0.35″ tomorrow · 55% chance')
  })

  it('prints the amount alone with no chance, and nothing for a day it cannot name', () => {
    const d2 = (extra) => rs({ ...DRY, day2_precip_in: 1.72, day2_date: '2026-09-27', ...extra }).nextNote
    expect(d2({})).toBe('1.72″ Sunday')
    expect(d2({ day2_pop: null })).toBe('1.72″ Sunday')
    expect(d2({ day2_date: '2026-9-27' })).toBeNull()
    expect(d2({ day2_date: '2026-13-40' })).toBeNull()
  })
})

describe('a gauge measurement outranks a forecast', () => {
  const SETTLED = { recent_precip_in: 0.05, today_precip_in: 0.03, today_observed_in: 0.29, today_remaining_in: 0,
    today_pop: 40, tomorrow_precip_in: 0, tomorrow_pop: 0, station: { today_source: 'station' } }

  it('the gauge figure leads; the forecast figure for the day is not printed', () => {
    const r = rs(SETTLED)
    expect(r).toEqual({ rainNote: '0.29″ fallen today · none more expected', nextNote: null, gaugeMeasured: true })
    expect(r.rainNote).not.toContain('0.03')
  })

  it('mid-rain: fallen, still expected, and the plan’s chance — unweighted', () => {
    expect(rs({ ...SETTLED, today_observed_in: 0.14, today_remaining_in: 0.15 }).rainNote).toBe('0.14″ fallen · 0.15″ more expected · 40%')
  })

  it('with no forecast behind it the measurement stands alone', () => {
    expect(rs(SETTLED, { noForecast: true }).rainNote).toBe('0.29″ fallen today')
  })

  it('a measurement opens the line when every forecast field reads zero; a zero reading does not', () => {
    expect(rs({ ...DRY, today_observed_in: 0.29, today_remaining_in: 0 }).rainNote).toBe('0.29″ fallen today · none more expected')
    expect(rs({ ...DRY, today_observed_in: 0, today_remaining_in: 0 })).toEqual({ rainNote: null, nextNote: null, gaugeMeasured: false })
  })

  it('under the live overlay the measurement keeps the plan’s figures and carries its own basis time', () => {
    const live = { today_precip_in: 0.38, today_pop: 83, tomorrow_precip_in: 0 }
    const r = rs({ ...SETTLED, today_observed_in: 0.14, today_remaining_in: 0.15, today_precip_in: 0.07 },
      { live: true, liveHydrology: live, generatedAt: '2026-09-13T09:30:00Z' })
    expect(r).toEqual({ rainNote: '0.14″ fallen as of 5:30 AM · 0.15″ more expected · 40%', nextNote: null, gaugeMeasured: true })
    expect(rs(SETTLED, { live: true, liveHydrology: live, generatedAt: '2026-09-13T09:30:00Z' }).rainNote)
      .toBe('0.29″ fallen as of 5:30 AM · none more expected')
  })
})

describe('the card’s regime flags', () => {
  it('showery (not live) softens the note', () => {
    const f = { uncertain: true, showery: true }
    expect(rs({ today_precip_in: 0.21, today_pop: 88, tomorrow_precip_in: 0.05, tomorrow_pop: 20 }, f).rainNote).toBe('~0.21″ today · 88% — could climb')
    expect(rs({ today_precip_in: 0, today_pop: 88, tomorrow_precip_in: 0, tomorrow_pop: 20 }, f).rainNote).toBe('88% chance today · little so far, could climb')
  })

  it('showery beside tomorrow\'s note: softened and short', () => {
    const f = { uncertain: true, showery: true }
    expect(rs({ today_precip_in: 0.21, today_pop: 88, tomorrow_precip_in: 0.74, tomorrow_pop: 63 }, f)).toMatchObject({ rainNote: '~0.21″ today · 88%', nextNote: '0.74″ tomorrow · 63% chance' })
    expect(rs({ today_precip_in: 0, today_pop: 88, tomorrow_precip_in: 0.74, tomorrow_pop: 63 }, f)).toMatchObject({ rainNote: '88% chance today', nextNote: '0.74″ tomorrow · 63% chance' })
  })

  it('showery opens the line on its own', () => {
    const h = { ...DRY, today_pop: 10, tomorrow_pop: 10 }
    expect(rs(h).rainNote).toBeNull()
    expect(rs(h, { uncertain: true, showery: true }).rainNote).toBe('10% chance tomorrow · little so far, could climb')
  })

  it('under the live overlay the note is not softened', () => {
    expect(rs(DRY, { uncertain: true, showery: true, live: true, liveHydrology: { today_precip_in: 0.21, today_pop: 88 } }).rainNote)
      .toBe('0.21″ today · 88% chance')
  })

  it('uncertain alone (the missing-data verdict) moves the line to today at a 50% chance', () => {
    const h = { today_precip_in: 0, today_pop: 60, tomorrow_precip_in: 0.5, tomorrow_pop: 70 }
    expect(rs(h).rainNote).toBe('0.50″ tomorrow · 70% chance')
    expect(rs(h, { uncertain: true }).rainNote).toBe('60% chance of rain today')
    expect(rs({ ...h, today_pop: 49 }, { uncertain: true }).rainNote).toBe('0.50″ tomorrow · 70% chance')
  })

  it('the live overlay supplies the forecast half and always opens the line; unflagged it is ignored', () => {
    const h = { ...DRY, tomorrow_precip_in: 0.8, tomorrow_pop: 90 }
    const overlay = { today_precip_in: 0, today_pop: 0, tomorrow_precip_in: 0.12, tomorrow_pop: 45 }
    expect(rs(h, { live: true, liveHydrology: overlay }).rainNote).toBe('0.12″ tomorrow · 45% chance')
    expect(rs(h, { live: true, liveHydrology: DRY }).rainNote).toBe('0% chance of rain tomorrow')
    expect(rs(h, { liveHydrology: overlay }).rainNote).toBe('0.80″ tomorrow · 90% chance')
  })
})

describe('pure', () => {
  it('reads nothing but its arguments: frozen inputs, repeat calls and a moved clock give one answer', () => {
    const args = deepFreeze({
      hydrology: { today_observed_in: 0.14, today_remaining_in: 0.15, today_pop: 40, tomorrow_precip_in: 0.5, tomorrow_pop: 60 },
      liveHydrology: { today_precip_in: 0.38, today_pop: 83, tomorrow_precip_in: 0.6, tomorrow_pop: 70 },
      live: true, uncertain: true, showery: true, generatedAt: '2026-09-13T09:30:00Z',
    })
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const a = rainSentences(args)
    vi.setSystemTime(new Date('2027-07-04T23:59:00Z'))
    expect(rainSentences(args)).toEqual(a)
    expect(a).toEqual({ rainNote: '0.14″ fallen · 0.15″ more', nextNote: '0.60″ tomorrow · 70% chance', gaugeMeasured: true })
  })

  it('basisTimeLabel is the ET clock time, or null', () => {
    expect(basisTimeLabel('2026-09-13T09:30:00Z')).toBe('5:30 AM')
    expect(basisTimeLabel('2026-01-15T17:05:00Z')).toBe('12:05 PM')
    expect(basisTimeLabel(null)).toBeNull()
    expect(basisTimeLabel('bad')).toBeNull()
  })
})

describe('WeatherWidget prints what rainSentences returns', () => {
  it('both lines, verbatim, and no line while the gate is shut', () => {
    const WX = { tonightLow: 50, highToday: 70, code: 3, hot: false }
    const cases = [
      { ...DRY, tomorrow_precip_in: 0.14, tomorrow_pop: 37 },
      { today_precip_in: 0.21, today_pop: 88, tomorrow_precip_in: 0.74, tomorrow_pop: 63 },
      { ...DRY, tomorrow_precip_in: 0.58, tomorrow_pop: 100, day2_precip_in: 1.22, day2_pop: 100, day2_date: '2026-09-27' },
      { ...DRY, tomorrow_pop: 10, day2_precip_in: 0.1, day2_pop: 70, day2_date: '2026-09-27' },
      { ...DRY, today_observed_in: 0.14, today_remaining_in: 0.15, today_pop: 40 },
      { ...DRY, tomorrow_pop: 29 },
    ]
    let lines = 0
    for (const h of cases) {
      const { rainNote, nextNote } = rs(h)
      const { container } = render(<WeatherWidget weather={WX} hydrology={h} />)
      const text = container.textContent
      if (rainNote) { expect(text.split(rainNote).length - 1).toBe(1); lines++ } else expect(nextNote ? text.replace(nextNote, '') : text).not.toMatch(/chance|fallen|could climb/)
      const next = screen.queryByTestId('weather-next-rain')
      expect(next ? next.textContent : null).toBe(nextNote)
      cleanup()
    }
    expect(lines).toBe(4)
  })
})
