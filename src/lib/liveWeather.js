// DRG-WXROLL-001 — intraday weather freshness (client-side). The Today rain figure is otherwise a FROZEN
// ~2AM snapshot (the nightly daily-plan engine); in showery/convective regimes the amount can move several-
// fold by midday. This module re-fetches precip LIVE from Open-Meteo using the EXACT same endpoint + field
// mapping as the engine's lambda/daily-plan/index.js fetchPrecip, so the displayed figure can be refreshed
// to "now" without re-running the engine. DISPLAY ONLY: the watering recommendation stays the server's
// plan. Open-Meteo is keyless + CORS-enabled.
//
// CORRECTION (BUG-TODAYWATER-001, 2026-08-03): this comment used to justify display-only by saying a
// re-run "would clobber per-plant task/done state". That is FALSE and has been since V3-TODAYDONE-001 —
// `done` is computed at READ time from event_log (lambda/daily-plan-read), not stored on the plan, so
// regeneration loses no check-offs. The claim was load-bearing: it was the stated reason the engine could
// not simply be re-run with fresher data, and it blocked the actual fix for a plan that had gone 4x stale
// by mid-morning. The engine is now regenerated intraday on its own schedule (05:30 / 15:30 ET, see
// .github/workflows/deploy-lambda.yml). This module stays display-only for a different and still-valid
// reason: it is a client-side fetch, and the watering DECISION must come from the server so that every
// device and every reader agrees on one answer.

const round2 = (n) => (n == null ? null : Math.round((n + Number.EPSILON) * 100) / 100)

// BUG-LIVEWEATHERNUMOR0-001. This was `numOr0`, returning 0 for null, undefined, a string and NaN
// alike — so a payload with no precipitation in it produced a confident `0.00 in`, and anything
// keyed on that figure fired HARDEST exactly when the forecast was unavailable. The failure mode was
// inverted. The asymmetry is what proves it was a defect rather than a choice: precipitation_probability_max
// two lines below has always been `pop[i] != null ? pop[i] : null`. Absence is not zero; the two
// fields now say so the same way.
const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
// A sum is only as known as its least-known term. D-2 + D-1 with one day missing is not "the total
// so far", it is an understatement that reads like a measurement — the same lie one level up.
const sumOrNull = (...vs) => (vs.some((v) => v == null) ? null : vs.reduce((a, v) => a + v, 0))

// Same URL the engine uses (lambda/daily-plan/index.js fetchPrecip): past_days=2, forecast_days=3 ->
// daily arrays indexed [D-2, D-1, D0, D1, D2]; inches; America/New_York day buckets.
export function OPEN_METEO_PRECIP_URL(lat, lng) {
  return `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
    `&daily=precipitation_sum,precipitation_probability_max&precipitation_unit=inch&timezone=America/New_York&past_days=2&forecast_days=3`
}

// Map an Open-Meteo daily response to the SAME hydrology shape the engine produces (so the widget can use it
// interchangeably). Returns null on a malformed payload (caller falls back to the nightly snapshot).
//
// EVERY precipitation field here is NULLABLE, and callers must treat null as "not known" rather than
// as a number (BUG-LIVEWEATHERNUMOR0-001). A partially-populated `daily` block is a real Open-Meteo
// response — precipitation_sum can carry nulls at either end of the window — and the old mapping
// turned each one into 0.00 in. upcoming_precip_in in particular is null whenever D2 is absent,
// which includes the 4-element payload this function explicitly accepts: D1 + D2 is not knowable
// from D1 alone.
export function mapOpenMeteoDailyToHydrology(json) {
  const d = json && json.daily
  const ps = d && Array.isArray(d.precipitation_sum) ? d.precipitation_sum : null
  const pop = d && Array.isArray(d.precipitation_probability_max) ? d.precipitation_probability_max : []
  if (!ps || ps.length < 4) return null // need at least D-2..D1
  const tomorrow = numOrNull(ps[3])
  return {
    recent_precip_in: round2(sumOrNull(numOrNull(ps[0]), numOrNull(ps[1]))), // D-2 + D-1 actuals
    today_precip_in: round2(numOrNull(ps[2])),                               // D0
    today_pop: pop[2] != null ? pop[2] : null,
    upcoming_precip_in: round2(sumOrNull(tomorrow, numOrNull(ps[4]))),       // D1 + D2
    tomorrow_precip_in: round2(tomorrow),                                    // D1
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
