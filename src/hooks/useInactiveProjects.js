// useInactiveProjects — live data hook for the inactive-projects surface (V1.2a-2 S3 W4).
// Wraps useApiFetch with a stateful projects list, optimistic dismiss, and a
// stale-response guard so a concurrent refetch can't clobber an in-flight dismiss.
//
// Contract:
//   { projects, loading, error,
//     refetch() -> Promise<void>,
//     dismiss(projectId) -> { ok: true } | { error } }
//
// API:
//   GET  /api/projects/inactive               -> Array<{ id, name, variety, status,
//                                                         start_date, last_event_at,
//                                                         last_harvested_at,
//                                                         dismissed, dismissed_at }>
//   POST /api/projects/inactive/:id/dismiss    -> { dismissed: true, dismissed_at }
//
// Notes:
//   - Server already sorts: undismissed first, then last_event_at DESC NULLS LAST.
//   - dismiss is optimistic: marks dismissed:true + a local dismissed_at immediately,
//     captures the prior state, POSTs, then reconciles dismissed_at from the server
//     response. On error it reverts to the captured state (original row position
//     preserved — we never reorder).
//   - dismissingSet (a useRef Set of in-flight project ids) protects optimistic
//     dismiss state from a concurrent refetch: refetch results merge so in-flight
//     dismisses survive (Plan §7 landmine).
//   - loadCounterRef mirrors useVarieties — a slow refetch can't overwrite a newer one.

import { useState, useEffect, useCallback, useRef } from 'react'
import { useApiFetch } from '../lib/api.js'

export function useInactiveProjects() {
  const { fetch } = useApiFetch()
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const loadCounterRef = useRef(0)
  // Set of project ids with an in-flight dismiss POST — used to protect
  // optimistic dismiss state from a concurrent refetch clobbering it.
  const dismissingSetRef = useRef(new Set())
  // Mirror of the current projects state. React invokes functional-setState
  // updaters lazily (at render time), so capturing prior state inside an
  // updater isn't reliable for a synchronous revert after an awaited POST —
  // this ref gives dismiss() a synchronous read of the pre-mutation state.
  const projectsRef = useRef(projects)
  projectsRef.current = projects

  const refetch = useCallback(async () => {
    const my = ++loadCounterRef.current
    setLoading(true)
    setError(null)
    try {
      const data = await fetch('/api/projects/inactive')
      if (loadCounterRef.current !== my) return
      const fresh = Array.isArray(data) ? data : []
      // Merge guard: for any project with an in-flight dismiss, keep our optimistic
      // row (dismissed:true + local dismissed_at) rather than the server's row,
      // which may still report dismissed:false.
      const dismissing = dismissingSetRef.current
      if (dismissing.size === 0) {
        setProjects(fresh)
      } else {
        setProjects(prev => {
          const prevById = new Map(prev.map(p => [p.id, p]))
          return fresh.map(row =>
            dismissing.has(row.id) && prevById.has(row.id)
              ? prevById.get(row.id)
              : row
          )
        })
      }
    } catch (err) {
      if (loadCounterRef.current !== my) return
      setError(err?.message ?? 'Failed to load inactive projects')
    } finally {
      if (loadCounterRef.current === my) setLoading(false)
    }
  }, [fetch])

  useEffect(() => { refetch() }, [refetch])

  const dismiss = useCallback(async (projectId) => {
    // Capture prior state synchronously for revert-on-error (position preserved).
    const prevState = projectsRef.current
    const dismissedAt = new Date().toISOString()
    setProjects(prev => prev.map(p =>
      p.id === projectId
        ? { ...p, dismissed: true, dismissed_at: dismissedAt }
        : p
    ))

    dismissingSetRef.current.add(projectId)
    try {
      const res = await fetch(`/api/projects/inactive/${projectId}/dismiss`, {
        method: 'POST',
      })
      // Reconcile dismissed_at from the server response.
      setProjects(prev => prev.map(p =>
        p.id === projectId
          ? { ...p, dismissed: true, dismissed_at: res?.dismissed_at ?? p.dismissed_at }
          : p
      ))
      return { ok: true }
    } catch (err) {
      // Revert to captured state — preserves original row position.
      setProjects(prevState)
      return { error: err?.message ?? 'Failed to dismiss project' }
    } finally {
      dismissingSetRef.current.delete(projectId)
    }
  }, [fetch])

  return { projects, loading, error, refetch, dismiss }
}
