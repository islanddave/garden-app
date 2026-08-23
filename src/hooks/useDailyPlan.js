// useDailyPlan — fetch hook for GET /api/daily-plan (DRG-TODAY-002 read model).
// Contract: { data, loading, refreshing, error, reload, refresh }
//   data: { schema_version, plan_date, generated_at, has_plan, plan } | null
//     plan (when has_plan): { weather, hydrology, substrate, counts,
//                             water_due[], no_history[], fertilize[], pest[], cold[], dormant[] }
// Mirrors useFindings (load-counter guards against out-of-order responses).
//
// DRG-INTRADAY-002 — TWO fetch modes, because they have opposite failure requirements.
//
// `reload` (INITIAL) is unchanged, byte-for-byte in behaviour: it sets `loading`, clears `error`, and
// is what the mount effect and an includeHousehold toggle call. Today.jsx gates the whole plan block
// on `!loading && !error`, so this mode is allowed to blank the screen — there is nothing on it yet.
//
// `refresh` (REVALIDATE) is the intraday path, and it must NEVER blank the screen. Calling `reload`
// on focus/visibilitychange was the original DRG-INTRADAY-002 proposal and it is a full teardown: it
// sets loading=true, Today.jsx then unmounts <CareNeeded>, and every piece of in-memory list state
// dies with it — grouping mode, manual expand/collapse, the "Show N more" state, an open bulk sheet
// and its hand-checked subset, in-flight pending rows, and the scroll position of a ~200-row list the
// user is physically walking. So `refresh` holds `data` and reports through `refreshing` instead.
//
// STALE ROWS BEAT BLANK ROWS. On a refresh failure we keep the last good plan and do NOT set `error`
// — the same rule src/lib/useAmbientBandFetch.js:18-20 already applies, for the same reason: this app
// treats rural dead zones as normal operating conditions, and replacing a complete, still-actionable
// watering list with a red one-line string because one revalidation timed out is a strictly worse
// answer than showing slightly older truth. `error` stays reserved for the never-loaded case.
//
// The in-flight guard is a ref, not state, so it cannot cause a render or go stale in a closure
// (house pattern — TodayBand.jsx:48, useAmbientBandFetch.js:48). It matters here because Android
// fires BOTH `focus` and `visibilitychange` on a single wake, which without it is two concurrent
// fetches per wake.
import { useState, useEffect, useCallback, useRef } from 'react'
import { useApiFetch } from '../lib/api.js'

export function useDailyPlan({ includeHousehold = false } = {}) {
  const { fetch } = useApiFetch()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)
  const loadCounterRef = useRef(0)
  const inflightRef = useRef(false)
  // Tracks "we have shown a real plan at least once" WITHOUT reading `data` in the callback, which
  // would put `data` in the useCallback deps and change `refresh`'s identity on every successful
  // fetch — re-registering the focus/visibility listeners each time.
  const hasDataRef = useRef(false)

  const run = useCallback(async (isRefresh) => {
    // Coalesce: a second wake while one request is open is a no-op, not a competing chain.
    if (inflightRef.current) return
    inflightRef.current = true
    const my = ++loadCounterRef.current
    if (isRefresh) setRefreshing(true)
    else { setLoading(true); setError(null) }
    try {
      const d = await fetch(includeHousehold ? '/api/daily-plan?include=household' : '/api/daily-plan')
      if (loadCounterRef.current !== my) return
      setData(d)
      hasDataRef.current = true
      setError(null)
    } catch (err) {
      if (loadCounterRef.current !== my) return
      // Only an initial load — or a refresh that has never had data to fall back on — may surface an
      // error. A failed revalidation over a good plan is silent by design (see header).
      if (!isRefresh || !hasDataRef.current) setError(err?.message ?? 'Failed to load your plan')
    } finally {
      if (loadCounterRef.current === my) { setLoading(false); setRefreshing(false) }
      inflightRef.current = false
    }
  }, [fetch, includeHousehold])

  const reload  = useCallback(() => run(false), [run])
  const refresh = useCallback(() => run(true),  [run])

  useEffect(() => { reload() }, [reload])
  return { data, loading, refreshing, error, reload, refresh }
}
