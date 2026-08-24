import { useState, useCallback, useEffect, useRef } from 'react'
import { useApiFetch } from '../lib/api.js'

// useHarvests — V4-HARVESTVIEW-001 S2a/S2b. Reads the Harvests model (GET /api/harvests): keyset-
// paginated entries (opaque `cursor`) + live aggregates. loadMore APPENDS the next page. Filters
// (timeframe/crop/project — S2b) narrow the query; a filter change cancels the in-flight request
// (AbortController) and a stale load-more is dropped (reqRef guard) so results never interleave.
export function useHarvests({ timeframe, crop, project } = {}) {
  const { fetch: apiFetch } = useApiFetch()
  const [entries, setEntries] = useState([])
  const [aggregates, setAggregates] = useState(null)
  const [cursor, setCursor] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState(null)
  const reqRef = useRef(0)
  const abortRef = useRef(null)

  const buildQs = useCallback((cur) => {
    const p = new URLSearchParams()
    p.set('include', 'entries,aggregates')
    if (timeframe) p.set('timeframe', timeframe)
    if (crop) p.set('crop', crop)
    if (project) p.set('project', project)
    if (cur) p.set('cursor', cur)
    return `?${p.toString()}`
  }, [timeframe, crop, project])

  const load = useCallback(async () => {
    const rid = ++reqRef.current
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch('/api/harvests' + buildQs(null), { signal: ac.signal })
      if (reqRef.current !== rid) return
      setEntries(Array.isArray(data?.entries) ? data.entries : [])
      setAggregates(data?.aggregates ?? null)
      setCursor(data?.cursor ?? null)
    } catch (err) {
      if (ac.signal.aborted || reqRef.current !== rid) return // superseded by a newer filter — ignore
      setError(err?.body?.message || err?.message || 'Could not load your harvests.')
      setEntries([])
      setAggregates(null)
      setCursor(null)
    } finally {
      if (reqRef.current === rid) setLoading(false)
    }
  }, [apiFetch, buildQs])

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return
    const rid = reqRef.current // pin: if a filter change bumps reqRef mid-flight, drop this page
    setLoadingMore(true)
    try {
      const data = await apiFetch('/api/harvests' + buildQs(cursor))
      if (reqRef.current !== rid) return // filter changed under us — the appended page would be wrong
      // BUG-HARVCURSORDUPE-001. A cursor minted by one deploy can be re-walked by the next, so a
      // page may repeat rows already appended — duplicate event_id, and event_id IS the React key
      // (Harvests.jsx:519). Dedupe on append rather than at the cursor: it also covers any other
      // duplicate source, and it is a no-op when the page is clean.
      setEntries((prev) => {
        const page = Array.isArray(data?.entries) ? data.entries : []
        const seen = new Set(prev.map((e) => e?.event_id).filter((id) => id != null))
        const add = []
        for (const e of page) {
          const id = e?.event_id
          if (id == null) { add.push(e); continue } // no identity to dedupe on — pass through unchanged
          if (seen.has(id)) continue
          seen.add(id) // also collapses duplicates WITHIN one page
          add.push(e)
        }
        return add.length ? [...prev, ...add] : prev
      })
      setCursor(data?.cursor ?? null)
    } catch {
      /* keep the existing feed — a failed load-more must not wipe it */
    } finally {
      setLoadingMore(false)
    }
  }, [apiFetch, buildQs, cursor, loadingMore])

  useEffect(() => {
    load()
    return () => abortRef.current?.abort()
  }, [load])

  return { entries, aggregates, cursor, hasMore: !!cursor, loading, loadingMore, error, reload: load, loadMore }
}
