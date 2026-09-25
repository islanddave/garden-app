// BUG-WXOUTAGESTAMPCOPY-001 — during a forecast outage the Today weather card named sources it did not have.
//
// Beside the incomplete-forecast banner (BUG-WXBANNERSHOWERYCOPY-001), with the forecast fetch returning
// nothing: no gauge -> the stamp read "As of … · Open-Meteo"; a bound gauge -> "As of … · rain gauge +
// forecast" and "0.01″ fallen today · none more expected". The last one reads today_remaining_in, which
// station.mergeStationHydrology sets to 0 when there is no forecast to subtract from ("no forecast to add"),
// so it printed an absence as a forecast of a dry evening. Now: the gauge alone, or no source at all, and the
// measurement without the forecast clause. A complete snapshot must not move by a single character.
//
// The stored shapes are BUILT BY THE REAL CODE (station.deriveStation -> mergeStationHydrology(null, …) ->
// engine.generatePlan, bag spread as handler.js writes it), as in wxBannerIncomplete.test.jsx.
//
// MUTATION LOG — 2026-09-18, lane-outagecopy-20260918. Each applied alone to WeatherWidget.jsx; this file,
// WeatherWidget.test.jsx and wxBannerIncomplete.test.jsx run under TZ=UTC; RED observed; source restored
// byte-for-byte (sha256 checked). 30/30 RED, and every test here is killed by at least one:
//   * forecastMissing always false (the pre-fix card)                     -> 8 RED
//   * status gate removed / any status counts                             -> 2 / 1 RED
//   * one of the four forecast-only fields forgotten (each, x4)           -> 1 RED each
//   * forecast-only fields or the no-bag recent checked by truthiness     -> 1 / 1 RED (a 0 is a figure)
//   * bag provenance: recent / today / part of today / hourly ignored     -> 1 RED each
//   * bag branch always "missing" / every incomplete snapshot "missing"   -> 4 / 12 RED
//   * no bag: recent or today figure ignored                              -> 1 RED each
//   * label ignores the option / stamp not told / Open-Meteo kept          -> 5 / 4 / 2 RED
//   * "none more expected" ungated                                        -> 4 RED
//   * over-corrections: never "none more expected" / never "+ forecast" /
//     never Open-Meteo                                                    -> 5 / 7 / 6 RED (incl. WeatherWidget.test.jsx)
//   * keyed on the banner's stale-gated `incomplete` / on status.ok alone /
//     on the 'no_hourly' provenance pair                                  -> 3 / 2 / 3 RED
//   * skipped under the live overlay / on a previous-day snapshot         -> 1 / 1 RED
//   * an empty forecast credits "rain gauge" to a STALE gauge's bag       -> 1 RED
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import WeatherWidget, { forecastMissing, hydrologySourceLabel } from '../components/today/WeatherWidget.jsx'
import engine from '../../lambda/daily-plan/engine.js'
import station from '../../lambda/daily-plan/station.js'
import cad from '../../lambda/daily-plan/cadence-data-v2.json'
import fm from '../../lambda/daily-plan/fertilization-model.json'

const MAC = 'AA:BB:CC:DD:EE:FF'
const DAY = '2026-07-06'
const NOW = Date.parse('2026-07-06T06:10:00Z')        // 02:10 ET -> D0 07-06, D1 07-05, D2 07-04
const GEN = '2026-07-06T10:00:00Z'                    // 06:00 ET the same day, so never the stale banner
const PREV = '2026-07-05T19:30:00Z'                   // 15:30 ET the day before: the stale banner
const weather = { tonightLow: 58, highToday: 78, code: 3, hot: false }
const rec = (day, hh, dailyrainin, tempf) => ({ dateutc: Date.parse(`${day}T${hh}:00:00-04:00`), dailyrainin, tempf })
// station.test.js fixtures: a full 2-day lookback (recent 0.50), a dry morning, and a gauge that came online today.
const FULL = { mac: MAC, records: [rec(DAY, '02', 0.01, 62), rec('2026-07-05', '18', 0.30, 70), rec('2026-07-04', '18', 0.20, 72), rec('2026-07-03', '18', 0.0, 65)] }
const DRY = { mac: MAC, records: [rec(DAY, '02', 0.0, 62), rec('2026-07-05', '18', 0.30, 70), rec('2026-07-04', '18', 0.20, 72), rec('2026-07-03', '18', 0.0, 65)] }
const WARMUP = { mac: MAC, records: [rec(DAY, '02', 0.01, 62), rec(DAY, '01', 0.0, 61)] }
// Open-Meteo's hourly block in its own shape (local ISO hours), wet only where `perHour` says so on DAY.
const hourly = (perHour) => {
  const time = [], precipitation = []
  for (const d of ['2026-07-05', DAY, '2026-07-07']) for (let h = 0; h < 24; h++) {
    time.push(`${d}T${String(h).padStart(2, '0')}:00`)
    precipitation.push(d === DAY ? (perHour[h] || 0) : 0)
  }
  return { time, precipitation, timezone: 'America/New_York' }
}
// A forecast that came through: 0.2″ due at 14:00, a showery-ish 40% today.
const forecast = (over = {}) => ({ recent_precip_in: 0.05, today_precip_in: 0.21, today_pop: 40, upcoming_precip_in: 0.3,
  tomorrow_precip_in: 0.2, tomorrow_pop: 35, yesterday_precip_actual_in: 0.3, hourly_precip: hourly({ 14: 0.2 }), ...over })

beforeEach(() => {
  vi.stubEnv('AWN_STATIONS_JSON', JSON.stringify([{ mac: MAC, tz: 'America/New_York', lat: 41.8888, lng: -70.7777, schema_version: 1 }]))
})
afterEach(() => { vi.unstubAllEnvs() })

// What daily_plan.items.hydrology holds (hy null = the forecast fetch came back empty).
function stored(hy, prov = {}) {
  const plan = engine.generatePlan({ plantings: [], cadence: cad, fertModel: fm, today: DAY, weather, hydrology: hy, ownerFallback: 'dave' })
  return Object.keys(prov).length ? { ...plan.hydrology, station: prov } : plan.hydrology
}
function bound(hy, payload, nowMs = NOW) {
  const { merged, prov } = station.mergeStationHydrology(hy, station.deriveStation(payload, { nowMs }), { planDay: DAY })
  return stored(merged, prov)
}
const card = (h, extra = {}) => render(<WeatherWidget weather={weather} hydrology={h} generatedAt={GEN} planDate={DAY} {...extra} />)
// Every line the card prints, top to bottom (the lanes by their accessible names).
function cardLines(h, extra = {}) {
  const { container } = card(h, extra)
  const out = [...container.firstChild.children].map((el) => {
    const lanes = [...el.querySelectorAll('[role="img"][aria-label]')].map((n) => n.getAttribute('aria-label')).filter((l) => /Containers|beds/.test(l))
    return lanes.length ? `LANES: ${lanes.join(' | ')}` : el.textContent.replace(/\s+/g, ' ').trim()
  })
  cleanup()
  return out
}
const stamp = () => screen.getByText(/^(As of|Updated)/).textContent
const rainLine = () => screen.getByText(/fallen/).textContent
const LIVE = { liveHydrology: { today_precip_in: 0.3, today_pop: 60, tomorrow_precip_in: 0.1, tomorrow_pop: 20 }, refreshedAt: '2026-07-06T16:10:00Z' }
const OUTAGE_BANNER = /The rain forecast didn’t fully come through for today’s plan/
const FORECAST_NULL = { today_pop: null, upcoming_precip_in: null, tomorrow_precip_in: null, tomorrow_pop: null }

describe('BUG-WXOUTAGESTAMPCOPY-001 — an empty forecast is credited to nobody', () => {
  it('UNBOUND outage: the stamp claims no source, beside a banner that says no rain is counted', () => {
    const h = stored(null)
    expect(Object.keys(h)).toEqual(['status'])               // the fetch returned nothing to attribute
    expect(h.status.ok).toBe(false)
    expect(forecastMissing(h)).toBe(true)
    card(h)
    expect(stamp()).toBe('As of Jul 6 · 6:00 AM')
    expect(screen.queryByText(/Open-Meteo/)).toBeNull()
    expect(screen.getByText(OUTAGE_BANNER).textContent).toMatch(/doesn’t count on any rain\.$/)
  })

  it('BOUND outage: the measurement stands alone and the stamp names only the gauge', () => {
    const h = bound(null, FULL)
    // The 0 the old line read as "none more expected" is the merge's placeholder, not a forecast.
    expect(h).toMatchObject({ today_observed_in: 0.01, today_remaining_in: 0, ...FORECAST_NULL })
    expect(h.station).toMatchObject({ recent_source: 'station', today_source: 'station', today_remaining_basis: 'wholeday', today_remaining_fallback: 'no_hourly' })
    card(h)
    expect(rainLine()).toBe('0.01″ fallen today')
    expect(screen.queryByText(/more expected/)).toBeNull()
    expect(stamp()).toBe('As of Jul 6 · 6:00 AM · rain gauge')
    expect(screen.queryByText(/forecast$/)).toBeNull()
    // …and the banner beside them still says the gauge is what the watering call counts. No contradiction.
    expect(screen.getByText(OUTAGE_BANNER).textContent).toMatch(/still counts what the rain gauge measured\.$/)
  })

  it('BOUND outage with a gauge still warming up: same two lines', () => {
    const h = bound(null, WARMUP)
    expect(h.station).toMatchObject({ recent_source: 'unavailable', today_source: 'station', station_uncertainty: 'warmup' })
    card(h)
    expect(rainLine()).toBe('0.01″ fallen today')
    expect(stamp()).toBe('As of Jul 6 · 6:00 AM · rain gauge')
  })

  it('BOUND outage on a dry morning: no rain line at all, and the stamp names only the gauge', () => {
    const h = bound(null, DRY)
    expect(h).toMatchObject({ today_observed_in: 0, recent_precip_in: 0.5, ...FORECAST_NULL })
    card(h)
    expect(screen.queryByText(/fallen|chance|expected/)).toBeNull()
    expect(stamp()).toBe('As of Jul 6 · 6:00 AM · rain gauge')
  })

  it('a STALE gauge and no forecast still claims nothing (unchanged)', () => {
    const h = bound(null, FULL, NOW + 6 * 3600 * 1000)
    expect(h.station).toMatchObject({ recent_source: 'unavailable', today_source: 'unavailable', station_uncertainty: 'stale' })
    card(h)
    expect(stamp()).toBe('As of Jul 6 · 6:00 AM')
  })

  it('with the live overlay: the stored placeholder is still not read as a forecast; the live stamp is unchanged', () => {
    card(bound(null, FULL), LIVE)
    expect(rainLine()).toBe('0.01″ fallen as of 6:00 AM')
    expect(stamp()).toBe('Updated 12:10 PM · live forecast')   // the live fetch DID return, so it is named
    cleanup()
    card(stored(null), LIVE)
    expect(stamp()).toBe('Updated 12:10 PM · live')
  })

  it('a previous-day outage snapshot: the stale banner still wins, and the lines still name only what came back', () => {
    card(stored(null), { generatedAt: PREV })
    expect(stamp()).toBe('As of Jul 5 · 3:30 PM')
    expect(screen.getByText(/older snapshot/)).toBeTruthy()
    expect(screen.queryByText(OUTAGE_BANNER)).toBeNull()      // one banner, not two (precedence unchanged)
    cleanup()
    card(bound(null, FULL), { generatedAt: PREV })
    expect(rainLine()).toBe('0.01″ fallen today')
    expect(stamp()).toBe('As of Jul 5 · 3:30 PM · rain gauge')
  })
})

describe('complete and partial snapshots do not move — every line of the card, pinned', () => {
  const HEAD = ['78°58°', 'Water both — containers and beds today.Water both — containers and beds today.']
  const SHOWERY = '⚠ Showery pattern — these amounts can still change through the day. The watering call above already plays it safe.'
  const cases = [
    ['COMPLETE, no gauge', () => stored(forecast()), {}, [...HEAD,
      'LANES: Containers: water — 2 of 3 cans | In-ground beds: water — 2 of 3 cans',
      '~0.21″ today · 40% — could climb', 'As of Jul 6 · 6:00 AM · Open-Meteo', SHOWERY]],
    ['COMPLETE, no gauge, settled day', () => stored(forecast({ today_precip_in: 0, today_pop: 10 })), {}, [...HEAD,
      'LANES: Containers: water — 2 of 3 cans | In-ground beds: water — 2 of 3 cans',
      '0.20″ tomorrow · 35% chance', 'As of Jul 6 · 6:00 AM · Open-Meteo']],
    ['COMPLETE, gauge, 0.2″ still due on the hourly forecast', () => bound(forecast(), FULL), {}, [...HEAD,
      'LANES: Containers: water — 1 of 3 cans | In-ground beds: water — 1 of 3 cans',
      '0.01″ fallen · 0.20″ more expected · 40%', 'As of Jul 6 · 6:00 AM · rain gauge + forecast', SHOWERY]],
    ['COMPLETE, gauge, the hourly forecast has nothing left', () => bound(forecast({ hourly_precip: hourly({}) }), FULL), {}, [...HEAD,
      'LANES: Containers: water — 1 of 3 cans | In-ground beds: water — 1 of 3 cans',
      '0.01″ fallen today · none more expected', '0.20″ tomorrow · 35% chance', 'As of Jul 6 · 6:00 AM · rain gauge + forecast']],
    // Same provenance pair as the outage ('wholeday'/'no_hourly'), but a real whole-day forecast the gauge has
    // already beaten: "none more expected" is TRUE here and must stay.
    ['COMPLETE, gauge, no hourly block, whole-day forecast exceeded', () => bound(forecast({ hourly_precip: null, today_precip_in: 0.005 }), FULL), {}, [...HEAD,
      'LANES: Containers: water — 1 of 3 cans | In-ground beds: water — 1 of 3 cans',
      '0.01″ fallen today · none more expected', '0.20″ tomorrow · 35% chance', 'As of Jul 6 · 6:00 AM · rain gauge + forecast']],
    ['COMPLETE, gauge, live overlay', () => bound(forecast({ hourly_precip: hourly({}) }), FULL), LIVE, [...HEAD,
      'LANES: Containers: water — 1 of 3 cans | In-ground beds: water — 1 of 3 cans',
      '0.01″ fallen as of 6:00 AM · none more expected', '0.10″ tomorrow · 20% chance', 'Updated 12:10 PM · live forecast']],
    // PARTIAL: the forecast did return figures, so whatever arrived keeps its source.
    ['PARTIAL, no gauge (D+1..D+2 missing)', () => stored({ recent_precip_in: 0.05, today_precip_in: 0.1, today_pop: 40, upcoming_precip_in: null, tomorrow_precip_in: null, tomorrow_pop: null }), {}, [...HEAD,
      'LANES: Containers: water — 2 of 3 cans | In-ground beds: water — 2 of 3 cans',
      '0.10″ today · 40% chance', 'As of Jul 6 · 6:00 AM · Open-Meteo',
      '⚠ The rain forecast didn’t fully come through for today’s plan. The watering call above still counts recent rain.']],
    ['PARTIAL, gauge, the hourly forecast has nothing left', () => bound(forecast({ hourly_precip: hourly({}), upcoming_precip_in: null, tomorrow_precip_in: null, tomorrow_pop: null }), FULL), {}, [...HEAD,
      'LANES: Containers: water — 1 of 3 cans | In-ground beds: water — 1 of 3 cans',
      '0.01″ fallen today · none more expected', 'As of Jul 6 · 6:00 AM · rain gauge + forecast',
      '⚠ The rain forecast didn’t fully come through for today’s plan. The watering call above still counts what the rain gauge measured.']],
  ]
  it.each(cases)('%s', (_name, build, extra, want) => {
    const h = build()
    expect(forecastMissing(h)).toBe(false)
    expect(cardLines(h, extra)).toEqual(want)
  })
})

describe('forecastMissing — only an EMPTY forecast on an incomplete snapshot counts', () => {
  const bad = { ok: false, uncertainty: { flag: true, reason: 'precip data incomplete' } }
  const gauge = { recent_source: 'station', today_source: 'station', today_remaining_basis: 'wholeday', today_remaining_fallback: 'no_hourly' }
  it.each([
    ['legacy snapshot with no status', {}, false],
    ['complete status', { status: { ok: true } }, false],
    ['incomplete, nothing at all', { status: bad }, true],
    ['incomplete, today_pop arrived', { status: bad, today_pop: 40 }, false],
    ['incomplete, tomorrow_precip_in arrived', { status: bad, tomorrow_precip_in: 0.2 }, false],
    ['incomplete, tomorrow_pop arrived (a 0 is a figure)', { status: bad, tomorrow_pop: 0 }, false],
    ['incomplete, upcoming_precip_in arrived', { status: bad, upcoming_precip_in: 0.3 }, false],
    ['incomplete, no bag, recent arrived (a 0 is a figure)', { status: bad, recent_precip_in: 0 }, false],
    ['incomplete, no bag, today arrived', { status: bad, today_precip_in: 0.1 }, false],
    ['incomplete, gauge figures only', { status: bad, recent_precip_in: 0.5, today_precip_in: 0.01, today_observed_in: 0.01, today_remaining_in: 0, station: gauge }, true],
    ['incomplete, bag credits recent to the forecast', { status: bad, recent_precip_in: 0.5, station: { ...gauge, recent_source: 'forecast' } }, false],
    ['incomplete, bag credits today to the forecast', { status: bad, station: { ...gauge, today_source: 'forecast' } }, false],
    ['incomplete, bag credits part of today to the forecast', { status: bad, station: { ...gauge, today_source: 'station+forecast' } }, false],
    ['incomplete, remainder from the hourly forecast', { status: bad, station: { ...gauge, today_remaining_basis: 'hourly' } }, false],
  ])('%s', (_name, h, want) => {
    expect(forecastMissing(h)).toBe(want)
  })

  it('hydrologySourceLabel names the gauge alone only when told the forecast is missing', () => {
    expect(hydrologySourceLabel(gauge)).toBe('rain gauge + forecast')
    expect(hydrologySourceLabel(gauge, { forecast: true })).toBe('rain gauge + forecast')
    expect(hydrologySourceLabel(gauge, { forecast: false })).toBe('rain gauge')
    expect(hydrologySourceLabel({ recent_source: 'unavailable', today_source: 'unavailable' }, { forecast: false })).toBeNull()
  })
})
