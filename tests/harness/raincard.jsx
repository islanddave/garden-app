// BUG-RAINCARDFORECASTONLY-001 — real-browser check of the WeatherWidget rain line.
//
// The vitest suite asserts the exact strings; what it cannot show is the line rendering in a real
// layout beside its icon at Dave's width, which is where a too-long sentence would wrap badly. Both
// halves ("0.14″ fallen · 0.15″ more expected · 40%") is the longest form this line can take, so it
// is the case worth looking at. Payloads are verbatim from prod daily_plan.items->hydrology on
// 2026-09-06 (the 05:30 and 15:30 runs) plus the no-gauge control.
import React from 'react'
import { createRoot } from 'react-dom/client'
import WeatherWidget from '../../src/components/today/WeatherWidget.jsx'

const weather = { tonightLow: 55, highToday: 70, code: 3, hot: false, short: 'Patchy Fog then Partly Sunny' }
const station = { station_fresh: true, today_source: 'station', station_mac: 'F8:B3:B7:82:1F:0D', station_age_min: 5 }

// 15:30 ET run — rain finished, gauge total 0.29"
const settled = { recent_precip_in: 0.05, today_precip_in: 0.29, today_observed_in: 0.29, today_remaining_in: 0,
  today_pop: 40, tomorrow_precip_in: 0, tomorrow_pop: 0, rain_coming: false, station }
// 05:30 ET run — still raining: the longest form of the sentence
const midRain = { ...settled, today_observed_in: 0.14, today_remaining_in: 0.15 }
// no bound gauge — the pre-existing forecast wording must be untouched
const noGauge = { recent_precip_in: 0.05, today_precip_in: 0.21, today_pop: 88, tomorrow_precip_in: 0.74, tomorrow_pop: 63, rain_coming: true }

// BUG-RAINFCSTONEMODEL-001 — 2026-09-25 17:30 ET, the evening Today printed "0.05″ rain expected tomorrow"
// (best_match 0.14″ x 37%). The five-model day-ahead figures from that hour, with the following-day line.
const sep25 = { recent_precip_in: 0, today_precip_in: 0, today_pop: 5, tomorrow_precip_in: 0.58, tomorrow_pop: 100,
  upcoming_precip_in: 1.8, day2_precip_in: 1.22, day2_pop: 100, day2_date: '2026-09-27', rain_coming: true,
  forecast_source: 'mean5-v1', bm_tomorrow_precip_in: 0.14, bm_tomorrow_pop: 37, status: { ok: true, uncertainty: { flag: false } } }

const CASES = [
  ['15:30 — 0.29" measured, nothing more coming', settled],
  ['05:30 — 0.14" measured, 0.15" still expected (longest form)', midRain],
  ['no gauge — forecast wording unchanged', noGauge],
  ['2026-09-25 — five-model tomorrow + the Sunday line', sep25],
]

createRoot(document.getElementById('root')).render(
  <>{CASES.map(([label, hy]) => (
    <div key={label}><h2>{label}</h2><WeatherWidget weather={weather} hydrology={hy} /></div>
  ))}</>
)
