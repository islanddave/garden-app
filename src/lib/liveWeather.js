// DRG-WXROLL-001 — intraday weather freshness (client-side). The Today rain figure is otherwise a FROZEN
// ~2AM snapshot (the nightly daily-plan engine); in showery/convective regimes the amount can move several-
// fold by midday. This module re-fetches precip LIVE from Open-Meteo using the EXACT same endpoint + field
// mapping as the engine's lambda/daily-plan/index.js fetchPrecip, so the displayed figure can be refreshed
// to "now" without re-running the engine (which would clobber per-plant task/done state). DISPLAY ONLY: the
// watering recommendation stays the server's nightly conservative plan. Open-Meteo is keyless + CORS-enabled.

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100
const numOr0 = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

// Same URL the engine uses (lambda/daily-plan/index.js fetchPrecip): past_days=2, forecast_days=3 ->
// daily arrays indexed [D-2, D-1, D0, D1, D2]; inches; America/New_York day buckets.
export function OPEN_METEO_PRECIP_URL(lat, lng) {
  return `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
    `&daily=precipitation_sum,precipitation_probability_max&precipitation_unit=inch&timezone=America/New_York&past_days=2&forecast_days=3`
}

// Map an Open-Meteo daily response to the SAME hydrology shape the engine produces (so the widget can use it
// interchangeably). Returns null on a malformed payload (caller falls back to the nightly snapshot).
export function mapOpenMeteoDailyToHydrology(json) {
  const d = json && json.daily
  const ps = d && Array.isArray(d.precipitation_sum) ? d.precipitation_sum : null
  const pop = d && Array.isArray(d.precipitation_probability_max) ? d.precipitation_probability_max : []
  if (!ps || ps.length < 4) return null // need at least D-2..D1
  const tomorrow = numOr0(ps[3])
  return {
    recent_precip_in: round2(numOr0(ps[0]) + numOr0(ps[1])), // D-2 + D-1 actuals
    today_precip_in: round2(numOr0(ps[2])),                  // D0
    today_pop: pop[2] != null ? pop[2] : null,
    upcoming_precip_in: round2(tomorrow + numOr0(ps[4])),    // D1 + D2
    tomorrow_precip_in: round2(tomorrow),                    // D1
    tomorrow_pop: pop[3] != null ? pop[3] : null,
  }
}

// Fetch live precip for a coordinate and map it. Returns { hydrology, refreshedAt } or null on ANY failure
// (no coords, no fetch impl, http error, network throw, malformed body) — a refresh failure must NEVER break
// the Today surface; the caller keeps showing the nightly snapshot. fetch is injectable for tests.
export async function fetchLiveRain(coords, { fetchImpl, signal } = {}) {
  const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null)
  if (!coords || coords.lat == null || coords.lng == null || !f) return null
  try {
    const res = await f(OPEN_METEO_PRECIP_URL(coords.lat, coords.lng), { signal })
    if (!res || !res.ok) return null
    const json = await res.json()
    const hydrology = mapOpenMeteoDailyToHydrology(json)
    if (!hydrology) return null
    return { hydrology, refreshedAt: new Date().toISOString() }
  } catch (_) {
    return null
  }
}
