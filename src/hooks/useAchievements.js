// useAchievements — fetch hook for /api/achievements.
//
// Contract:
//   { data, loading, error, reload }
//   data: { earned, locked, total_earned, total_visible, secret_locked_count } | null

import { useState, useEffect, useCallback, useRef } from 'react'
import { useApiFetch } from '../lib/api.js'

export function useAchievements() {
  const { fetch } = useApiFetch()
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)
  const loadCounterRef = useRef(0)

  const reload = useCallback(async () => {
    const my = ++loadCounterRef.current
    setLoading(true)
    setError(null)
    try {
      const d = await fetch('/api/achievements')
      if (loadCounterRef.current !== my) return
      setData(d)
    } catch (err) {
      if (loadCounterRef.current !== my) return
      setError(err?.message ?? 'Failed to load achievements')
    } finally {
      if (loadCounterRef.current === my) setLoading(false)
    }
  }, [fetch])

  useEffect(() => { reload() }, [reload])

  return { data, loading, error, reload }
}
