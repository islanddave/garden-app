// BUG-WXBANNERSHOWERYCOPY-001 — the Today weather card's caveat when the rain forecast is MISSING.
//
// engine.hydrologyStatus raises uncertainty.flag for two different states: a showery regime (ok:true)
// and missing precip data (ok:false, "precip data incomplete"). WeatherWidget printed "Showery pattern —
// these amounts can still change" for both, and the flag also opened the rain line with its showery
// "could climb" hedge over a chance floored from null ("0% chance tomorrow · little so far, could climb").
//
// The stored shapes here are BUILT BY THE REAL CODE, not typed in: the gauge cases go through
// station.deriveStation -> station.mergeStationHydrology(null, …) (Open-Meteo down, the 2026-09-02 shape)
// -> engine.generatePlan, and the station bag is spread on exactly as handler.js writes it. So the card is
// tested against the status the engine really emits. "The watering call above" is the two lanes, so each
// banner claim about counting rain is checked against wateringScale.measuredWater, what the lanes read
// (and engine.windowPrecip where the care list differs, which it does for a gauge still warming up).
//
// MUTATION LOG — 2026-09-18, lane-nextfixes-20260918. Each applied alone; this file, hydrologyStatus.test.js
// and WeatherWidget.test.jsx run; RED observed; file restored byte-for-byte (sha256 checked):
//   * no split (`incomplete = false`, the pre-fix card)               -> 5 RED
//   * softened note / rain-line gate still read `uncertain`           -> 1 RED each (partial, unbound)
//   * showery banner shown for the incomplete flag too                -> 2 RED
//   * gauge never named / named only for recent / only for a today
//     reading / named whenever a station bag exists                   -> 4 / 2 / 1 / 2 RED
//   * recent-rain branch keyed on provenance / made unconditional     -> 2 / 3 RED
//   * incomplete keyed on a null recent field instead of status.ok    -> 2 RED
//   * incomplete no longer yields to stale / hidden under live        -> 1 / 1 RED
//   * engine reason reverted / its condition inverted                 -> 1 / 2 RED (hydrologyStatus.test.js)
//   * showery banner deleted                                          -> 7 RED (6 in WeatherWidget.test.jsx)
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import WeatherWidget, { incompleteForecastCopy } from '../components/today/WeatherWidget.jsx'
import { measuredWater } from '../lib/wateringScale.js'
import engine from '../../lambda/daily-plan/engine.js'
import station from '../../lambda/daily-plan/station.js'
import cad from '../../lambda/daily-plan/cadence-data-v2.json'
import fm from '../../lambda/daily-plan/fertilization-model.json'

const MAC = 'AA:BB:CC:DD:EE:FF'
const DAY = '2026-07-06'
const NOW = Date.parse('2026-07-06T06:10:00Z')        // 02:10 ET -> D0 07-06, D1 07-05, D2 07-04
const GEN = '2026-07-06T10:00:00Z'                    // 06:00 ET the same day, so never the stale banner
const weather = { tonightLow: 58, highToday: 78, code: 3, hot: false }
const rec = (day, hh, dailyrainin, tempf) => ({ dateutc: Date.parse(`${day}T${hh}:00:00-04:00`), dailyrainin, tempf })
// station.test.js fixtures: a full 2-day lookback (recent 0.50), and a gauge that came online today.
const FULL = { mac: MAC, records: [rec(DAY, '02', 0.01, 62), rec('2026-07-05', '18', 0.30, 70), rec('2026-07-04', '18', 0.20, 72), rec('2026-07-03', '18', 0.0, 65)] }
const WARMUP = { mac: MAC, records: [rec(DAY, '02', 0.01, 62), rec(DAY, '01', 0.0, 61)] }

beforeEach(() => {
  vi.stubEnv('AWN_STATIONS_JSON', JSON.stringify([{ mac: MAC, tz: 'America/New_York', lat: 41.8888, lng: -70.7777, schema_version: 1 }]))
})
afterEach(() => { vi.unstubAllEnvs() })

// What daily_plan.items.hydrology holds for this Open-Meteo result (null = the fetch came back empty).
function stored(hy, prov = {}) {
  const plan = engine.generatePlan({ plantings: [], cadence: cad, fertModel: fm, today: DAY, weather, hydrology: hy, ownerFallback: 'dave' })
  return Object.keys(prov).length ? { ...plan.hydrology, station: prov } : plan.hydrology
}
function gaugeOnly(payload) {
  const { merged, prov } = station.mergeStationHydrology(null, station.deriveStation(payload, { nowMs: NOW }), { planDay: DAY })
  return { merged, h: stored(merged, prov), prov }
}
const card = (h, extra = {}) => render(<WeatherWidget weather={weather} hydrology={h} generatedAt={GEN} planDate={DAY} {...extra} />)
const LEAD = /The rain forecast didn’t fully come through for today’s plan/

describe('BUG-WXBANNERSHOWERYCOPY-001 — missing forecast gets its own caveat, true bound and unbound', () => {
  it('UNBOUND outage: says no rain is counted, and nothing on the card claims a showery pattern', () => {
    const h = stored(null)
    expect(h.status.ok).toBe(false)                              // the engine's verdict for this shape
    expect(measuredWater(h)).toBe(0)                             // the lanes have no rain to count...
    expect(engine.windowPrecip(null)).toBeNull()                 // ...and neither does the care list
    card(h)
    expect(screen.getByText(LEAD).textContent).toBe('⚠ The rain forecast didn’t fully come through for today’s plan, so the watering call above doesn’t count on any rain.')
    expect(screen.queryByText(/Showery pattern/)).toBeNull()
    expect(screen.queryByText(/could climb/)).toBeNull()
    expect(screen.queryByText(/% chance/)).toBeNull()             // no chance floored from null
  })

  it('BOUND outage (fresh gauge, Open-Meteo down): names the gauge, because its rain still credits', () => {
    const { merged, h, prov } = gaugeOnly(FULL)
    expect(prov.recent_source).toBe('station')
    expect(h.status.ok).toBe(false)
    expect(measuredWater(h)).toBeCloseTo(0.51)                   // gauge recent 0.50 + today 0.01, in the lanes
    expect(engine.windowPrecip(merged)).toBeCloseTo(0.51)       // ...and in the care list's credit
    card(h)
    expect(screen.getByText(LEAD).textContent).toMatch(/still counts what the rain gauge measured\.$/)
    expect(screen.queryByText(/doesn’t count on any rain/)).toBeNull()
    expect(screen.queryByText(/Showery pattern/)).toBeNull()
  })

  it('BOUND outage with a gauge still warming up: the lanes count its today reading, so it is named', () => {
    // No 2-day lookback yet, so recent is null and the ENGINE's care list credits nothing — but the lanes
    // above the banner read measuredWater, which includes today's gauge reading. The sentence is about
    // the lanes; "doesn't count on any rain" would be false there.
    const { merged, h, prov } = gaugeOnly(WARMUP)
    expect(prov.recent_source).toBe('unavailable')
    expect(prov.today_source).toBe('station')
    expect(measuredWater(h)).toBeCloseTo(0.01)
    expect(engine.windowPrecip(merged)).toBeNull()
    card(h)
    expect(screen.getByText(LEAD).textContent).toMatch(/still counts what the rain gauge measured\.$/)
    expect(screen.queryByText(/doesn’t count on any rain/)).toBeNull()
  })

  it('PARTIAL forecast, no gauge (recent present, D+1..D+2 missing): still counts recent rain', () => {
    const hy = { recent_precip_in: 0.05, today_precip_in: 0.1, today_pop: 40, upcoming_precip_in: null, tomorrow_precip_in: null, tomorrow_pop: null }
    const h = stored(hy)
    expect(h.status.ok).toBe(false)
    expect(measuredWater(h)).toBeCloseTo(0.05)
    card(h)
    expect(screen.getByText(LEAD).textContent).toMatch(/still counts recent rain\.$/)
    // the figures that DID arrive print in the ordinary wording — not the showery "could climb" hedge
    expect(screen.getByText(/0\.10″ today · 40% chance/)).toBeTruthy()
    expect(screen.queryByText(/could climb/)).toBeNull()
  })

  it('a GENUINE showery snapshot is unchanged: Showery pattern + the could-climb note, no outage copy', () => {
    const hy = { recent_precip_in: 0.05, today_precip_in: 0.21, today_pop: 88, upcoming_precip_in: 0.95, tomorrow_precip_in: 0.74, tomorrow_pop: 63 }
    const h = stored(hy)
    expect(h.status).toMatchObject({ ok: true, uncertainty: { flag: true } })
    card(h)
    expect(screen.getByText(/Showery pattern/)).toBeTruthy()
    expect(screen.getByText(/could climb/)).toBeTruthy()
    expect(screen.queryByText(LEAD)).toBeNull()
  })

  it('stale still outranks it (one banner, not two)', () => {
    card(stored(null), { generatedAt: '2026-07-04T10:00:00Z' })
    expect(screen.getByText(/older snapshot/)).toBeTruthy()
    expect(screen.queryByText(LEAD)).toBeNull()
  })

  it('with the live overlay: the caveat stays (it is about the plan) and the live rain line is not hedged', () => {
    const live = { today_precip_in: 0.3, today_pop: 60, tomorrow_precip_in: 0.1, tomorrow_pop: 20 }
    card(stored(null), { liveHydrology: live, refreshedAt: '2026-07-06T16:10:00Z' })
    expect(screen.getByText(LEAD)).toBeTruthy()
    expect(screen.getByText(/0\.30″ today · 60% chance/)).toBeTruthy()
    expect(screen.queryByText(/could climb/)).toBeNull()
  })
})

describe('incompleteForecastCopy — chosen by what the lanes read; the gauge named only when it supplied a figure', () => {
  it.each([
    [{}, /doesn’t count on any rain\.$/],
    [{ recent_precip_in: null, today_observed_in: null, station: { recent_source: 'unavailable', today_source: 'unavailable' } }, /doesn’t count on any rain\.$/],
    [{ recent_precip_in: 0, station: { recent_source: 'station' } }, /what the rain gauge measured\.$/],
    [{ recent_precip_in: null, today_observed_in: 0, station: { recent_source: 'unavailable', today_source: 'station' } }, /what the rain gauge measured\.$/],
    [{ recent_precip_in: 0.2, station: { recent_source: 'forecast' } }, /still counts recent rain\.$/],
    [{ recent_precip_in: 0.2 }, /still counts recent rain\.$/],
  ])('%j', (h, want) => {
    expect(incompleteForecastCopy(h)).toMatch(want)
  })
})
