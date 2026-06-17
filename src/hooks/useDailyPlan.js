// useDailyPlan — fetch hook for GET /api/daily-plan (DRG-TODAY-002 read model).
// Contract: { data, loading, error, reload }
//   data: { schema_version, plan_date, generated_at, has_plan, plan } | null
//     plan (when has_plan): { weather, hydrology, substrate, counts,
//                             water_due[], no_history[], fertilize[], pest[], cold[], dormant[] }
// Mirrors useFindings (load-counter guards against out-of-order responses).
import { useState, useEffect, useCallback, useRef } from 'react'
import { useApiFetch } from '../lib/api.js'

export function useDailyPlan() {
  const { fetch } = useApiFetch()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const loadCounterRef = useRef(0)

  const reload = useCallback(async () => {
    const my = ++loadCounterRef.current
    setLoading(true)
    setError(null)
    try {
      const d = await fetch('/api/daily-plan')
      if (loadCounterRef.current !== my) return
      setData(d)
    } catch (err) {
      if (loadCounterRef.current !== my) return
      setError(err?.message ?? 'Failed to load your plan')
    } finally {
      if (loadCounterRef.current === my) setLoading(false)
    }
  }, [fetch])

  useEffect(() => { reload() }, [reload])
  return { data, loading, error, reload }
}
