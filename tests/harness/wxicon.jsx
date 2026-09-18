// BUG-WXICONNULLCLEAR-001 — real-browser check of the WeatherWidget condition icon at phone width.
//
// The vitest suite (src/__tests__/wxIconNullCode.test.jsx) asserts the glyph by accessible name; this shows
// it. Frame at a TRUE 390px with viewport.html?vw=390&page=wxicon.html (a bare --window-size lays out at
// ~500px and crops). The weather payloads are plan.weather as Today receives it — the real
// engine.generatePlan output after a JSON round trip, generated at lane-outagecopy-20260918 and pasted
// verbatim (the lambda modules are CommonJS and cannot be imported here). Same complete hydrology on every
// card, so the icon is the only thing that differs.
import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import WeatherWidget from '../../src/components/today/WeatherWidget.jsx'

const GEN = '2026-07-06T10:00:00Z'
const DAY = '2026-07-06'
const hydrology = { recent_precip_in: 0.05, today_precip_in: 0, today_pop: 10, upcoming_precip_in: 0.3, tomorrow_precip_in: 0.2,
  tomorrow_pop: 35, rain_coming: false, rain_horizon: null, status: { ok: true, uncertainty: { flag: false } } }
const base = { tonightLow: 58, highToday: 78, short: 'Mostly Sunny', unit: 'F', callout: null }

const CASES = [
  // fetchNWS's icon call threw (timeout / network / HTML 503): code stays null and is stored as null.
  ['icon fetch failed — code null', { ...base, code: null }],
  // fetchNWS's icon call got a JSON error body: code undefined, dropped from the stored JSON.
  ['icon fetch error body — code absent', { ...base }],
  ['real code 0 (clear sky)', { ...base, code: 0 }],
  ['real code 61 (rain)', { ...base, code: 61 }],
]

// Burned into the capture so the width is self-evidencing, not trusted.
function Badge() {
  const [t, setT] = useState('')
  useEffect(() => {
    const d = document.documentElement
    setT(`vw ${window.innerWidth} · scrollW ${d.scrollWidth} · hscroll ${d.scrollWidth > window.innerWidth ? 'YES' : 'no'}`)
  }, [])
  return <div id="badge">{t}</div>
}

createRoot(document.getElementById('root')).render(
  <>
    <Badge />
    {CASES.map(([label, weather]) => (
      <div key={label}><h2>{label}</h2><WeatherWidget weather={weather} hydrology={hydrology} generatedAt={GEN} planDate={DAY} /></div>
    ))}
  </>
)
