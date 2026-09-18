// BUG-WXICONNULLCLEAR-001 — a stored null weather code drew a sun titled "clear".
//
// fetchNWS (lambda/daily-plan/index.js) starts the cosmetic Open-Meteo weather_code call at `code = null` and
// keeps that whenever the call throws — a timeout, a network error, an HTML 503 — and engine.generatePlan
// stores `weather.code` verbatim. ConditionIcon's old `{ code = 3 }` default covered only an ABSENT code (a
// JSON error body leaves it undefined, and JSON drops the key), so a null reached Number(null) === 0, which is
// WMO "clear sky". A failed icon fetch now draws the file's intended unknown glyph, overcast, exactly as an
// absent code does; a real 0 still draws clear.
//
// The weather here is what Today actually receives: the real engine's plan.weather after a JSON round trip
// (the JSONB store and the read API). Premise measured against the REAL fetchNWS source (compiled, fetch
// stubbed) on 2026-09-18: timeout / network error / HTML 503 / `daily: null` -> code null -> sun; a JSON
// error body -> key absent -> overcast.
//
// MUTATION LOG — 2026-09-18, lane-outagecopy-20260918. Each applied alone to WeatherWidget.jsx; this file and
// the three other widget test files run under TZ=UTC; RED observed; source restored byte-for-byte (sha256
// checked). 14/14 RED, and every test here is killed by at least one:
//   * the pre-fix `{ code = 3 }` + Number(code)                        -> 2 RED (null; null == absent)
//   * unknown defaults to clear (?? 0) / to partly cloudy (?? 2)        -> 2 / 2 RED
//   * the call site coerces null to 0                                    -> 2 RED
//   * over-reach: `code || 3` / `Number(code) || 3` (a real 0 lost)      -> 1 / 1 RED
//   * clear bucket loses 0 / loses 1                                     -> 1 / 1 RED
//   * partly cloudy moved / 3 no longer overcast                         -> 1 / 3 RED
//   * fog loses 45 / snow loses 71 / rain loses 61 / showers lose 81     -> 1 each
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import WeatherWidget from '../components/today/WeatherWidget.jsx'
import engine from '../../lambda/daily-plan/engine.js'
import cad from '../../lambda/daily-plan/cadence-data-v2.json'
import fm from '../../lambda/daily-plan/fertilization-model.json'

const CONDITIONS = ['clear', 'partly cloudy', 'rain', 'snow', 'fog', 'overcast']
const hydrology = { recent_precip_in: 0.05, today_precip_in: 0, today_pop: 10, upcoming_precip_in: 0.3, tomorrow_precip_in: 0.2, tomorrow_pop: 35 }

// The card's one condition glyph, by accessible name (the high/low minis are "day high" / "night low").
function condition(weather) {
  const { container } = render(<WeatherWidget weather={weather} hydrology={hydrology} />)
  const hits = [...container.querySelectorAll('[aria-label]')].map((n) => n.getAttribute('aria-label')).filter((l) => CONDITIONS.includes(l))
  expect(hits).toHaveLength(1)
  return hits[0]
}
// plan.weather as Today receives it, for a fetchNWS return carrying `code`.
function served(code) {
  const wx = { tonightLow: 58, highToday: 78, code, unit: 'F', short: 'Mostly Sunny' }
  const plan = engine.generatePlan({ plantings: [], cadence: cad, fertModel: fm, today: '2026-07-06', weather: wx, hydrology, ownerFallback: 'dave' })
  return JSON.parse(JSON.stringify(plan.weather))
}

describe('BUG-WXICONNULLCLEAR-001 — a missing weather code is unknown, never clear', () => {
  it('a stored null (the icon fetch threw) draws overcast, not a sun', () => {
    const w = served(null)
    expect(w).toHaveProperty('code', null)              // null survives the store: this is the shape Today gets
    expect(condition(w)).toBe('overcast')
  })

  it('an absent code (the icon fetch got an error body) still draws overcast, so null and absent agree', () => {
    const w = served(undefined)
    expect('code' in w).toBe(false)                     // JSON dropped the key
    expect(condition(w)).toBe('overcast')
    expect(condition(served(null))).toBe(condition(w))
  })

  it.each([
    [0, 'clear'],                                       // a REAL 0 is WMO "clear sky" and must stay a sun
    [1, 'clear'],
    [2, 'partly cloudy'],
    [3, 'overcast'],
    [45, 'fog'],
    [61, 'rain'],
    [71, 'snow'],
    [81, 'rain'],
  ])('a real code %i still draws %s', (code, want) => {
    expect(condition(served(code))).toBe(want)
  })
})
