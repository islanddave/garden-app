import { useState, useCallback, useEffect, useRef } from 'react'
import { useApiFetch } from '../lib/api.js'

// useHarvests — V4-HARVESTVIEW-001 S2a. Reads the Harvests model (GET /api/harvests): keyset-paginated
// entries (opaque `cursor`) + live aggregates in one call. loadMore APPENDS the next page. Filters
// (timeframe/crop/project) arrive in S2b; S2a passes an optional timeframe only.
//
// A stale-response guard (reqRef) drops out-of-order initial loads; loadMore is guarded on `cursor`
// and never wipes the existing feed on failure (a failed "load more" must not erase what's shown).
export function useHarvests({ timeframe } = {}) {
  const { fetch: apiFetch } = useApiFetch()
  const [entries, setEntries] = useState([])
  const [aggregates, setAggregates] = useState(null)
  const [cursor, setCursor] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState(null)
  const reqRef = useRef(0)

  const buildQs = useCallback((cur) => {
    const p = new URLSearchParams()
    p.set('include', 'entries,aggregates')
    if (timeframe) p.set('timeframe', timeframe)
    if (cur) p.set('cursor', cur)
    return `?${p.toString()}`
  }, [timeframe])

  const load = useCallback(async () => {
    const rid = ++reqRef.current
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch('/api/harvests' + buildQs(null))
      if (reqRef.current !== rid) return
      setEntries(Array.isArray(data?.entries) ? data.entries : [])
      setAggregates(data?.aggregates ?? null)
      setCursor(data?.cursor ?? null)
    } catch (err) {
      if (reqRef.current !== rid) return
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
    setLoadingMore(true)
    try {
      const data = await apiFetch('/api/harvests' + buildQs(cursor))
      setEntries((prev) => [...prev, ...(Array.isArray(data?.entries) ? data.entries : [])])
      setCursor(data?.cursor ?? null)
    } catch {
      /* keep the existing feed — a failed load-more must not wipe it */
    } finally {
      setLoadingMore(false)
    }
  }, [apiFetch, buildQs, cursor, loadingMore])

  useEffect(() => { load() }, [load])

  return { entries, aggregates, cursor, hasMore: !!cursor, loading, loadingMore, error, reload: load, loadMore }
}
