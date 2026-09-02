// DRG-WXROLL-001 — thin React wrapper over fetchLiveRain. On mount (and when coords change) it fetches live
// precip once and returns { liveHydrology, refreshedAt, loading }. No coords -> no fetch (returns nulls).
// Never throws; a failed/absent refresh yields null liveHydrology and the widget falls back to the nightly
// snapshot. The watering recommendation is NOT recomputed from this — it stays the server's nightly plan.
// EVERY precip field on liveHydrology is NULLABLE and null means NOT KNOWN, never 0 — see
// BUG-LIVEWEATHERNUMOR0-001 in ../lib/liveWeather.js. A consumer that defaults one to 0 re-creates the
// defect: a cue on that path fires hardest exactly when the forecast is unavailable.
import { useState, useEffect } from 'react'
import { fetchLiveRain } from '../lib/liveWeather.js'

export function useLiveRain(coords) {
  const lat = coords?.lat ?? null
  const lng = coords?.lng ?? null
  const [state, setState] = useState({ liveHydrology: null, refreshedAt: null, loading: false })

  useEffect(() => {
    if (lat == null || lng == null) {
      setState({ liveHydrology: null, refreshedAt: null, loading: false })
      return
    }
    let cancelled = false
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
    setState((s) => ({ ...s, loading: true }))
    fetchLiveRain({ lat, lng }, { signal: ctrl?.signal }).then((r) => {
      if (cancelled) return
      setState(r
        ? { liveHydrology: r.hydrology, refreshedAt: r.refreshedAt, loading: false }
        : { liveHydrology: null, refreshedAt: null, loading: false })
    })
    return () => { cancelled = true; ctrl?.abort() }
  }, [lat, lng])

  return state
}
