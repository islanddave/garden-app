// useMembers — fetch hook for GET /api/members (PLANT-ASSIGN-001 caretaker roster).
// Contract: { members, loading, error } where members = [{ id, display_name }].
// (email dropped 0A.6 — no consumer rendered it; roster is household-scoped server-side.)
// Clerk is the roster source (no DB table). Mirrors useDailyPlan's load-counter guard.
import { useState, useEffect, useCallback, useRef } from 'react'
import { useApiFetch } from '../lib/api.js'

export function useMembers() {
  const { fetch } = useApiFetch()
  const [members, setMembers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const loadCounterRef = useRef(0)

  const reload = useCallback(async () => {
    const my = ++loadCounterRef.current
    setLoading(true)
    setError(null)
    try {
      const d = await fetch('/api/members')
      if (loadCounterRef.current !== my) return
      setMembers(Array.isArray(d?.members) ? d.members : [])
    } catch (err) {
      if (loadCounterRef.current !== my) return
      setError(err?.message ?? 'Failed to load caretakers')
    } finally {
      if (loadCounterRef.current === my) setLoading(false)
    }
  }, [fetch])

  useEffect(() => { reload() }, [reload])
  return { members, loading, error, reload }
}
