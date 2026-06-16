// useFindings — fetch hook for GET /api/findings (DRG Care Knowledge Engine read model, slice 8).
// Contract: { data, loading, error, reload }
//   data: { schema_version, generated_at, count, findings: [...] } | null
import { useState, useEffect, useCallback, useRef } from 'react'
import { useApiFetch } from '../lib/api.js'

export function useFindings() {
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
      const d = await fetch('/api/findings')
      if (loadCounterRef.current !== my) return
      setData(d)
    } catch (err) {
      if (loadCounterRef.current !== my) return
      setError(err?.message ?? 'Failed to load findings')
    } finally {
      if (loadCounterRef.current === my) setLoading(false)
    }
  }, [fetch])

  useEffect(() => { reload() }, [reload])
  return { data, loading, error, reload }
}
