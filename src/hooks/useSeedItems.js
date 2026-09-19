// src/hooks/useSeedItems.js — V5-SEEDSTAB-001. The Seeds page's ONE copy of the seed rows.
//
// My seeds and Saved seeds render the same ~330 rows (`GET /api/inventory-items?category=seeds`,
// ~437 kB), and the ferment line under the switch reads them on all three views. Each used to fetch
// its own copy, which on one page means a stage moved in Saved seeds leaves My seeds' chip wrong until
// a remount, and a switch between views re-downloads the lot. The page owns this fetch — Put-Up's
// "one GET, not two" — and hands it down; every write either patches a row in place or reloads.
//
// NOT useCachedFetch. That hook revalidates on every mount, and the views mount and unmount on every
// switch; the store has to live above them for the same reason the fetch does.
//
// `fromCache`: offline, the service worker answers with the last copy it held and api.js marks the
// parsed value (SW-STALEAPI-001). The page shows a stale band with Retry rather than presenting a
// cached list as fresh — the ferment line in particular must not say "day 3" off a copy from last week.
import { useState, useEffect, useCallback, useRef } from 'react'
import { useApiFetch, isFromCache } from '../lib/api.js'

export const SEED_ITEMS_PATH = '/api/inventory-items?category=seeds'

export function useSeedItems() {
  const { fetch } = useApiFetch()
  // null until the first answer, so "not loaded yet" and "loaded, no seed" are different states.
  const [items, setItems] = useState(null)
  const [error, setError] = useState(null)
  const [fromCache, setFromCache] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  // Rows as they are NOW, for callbacks that outlive the render that made them — the quantity
  // adjuster's undo is the one that matters (BUG-INVUNDOQTY-001). Assigned synchronously by commit().
  const itemsRef = useRef(null)
  const seqRef = useRef(0)

  const commit = useCallback((updater) => {
    const next = typeof updater === 'function' ? updater(itemsRef.current) : updater
    itemsRef.current = next
    setItems(next)
  }, [])

  const reload = useCallback(async () => {
    const my = ++seqRef.current
    setError(null)
    setRefreshing(true)
    try {
      const rows = await fetch(SEED_ITEMS_PATH)
      if (seqRef.current !== my) return
      commit(Array.isArray(rows) ? rows : [])
      setFromCache(isFromCache(rows))
    } catch (e) {
      if (seqRef.current !== my) return
      setError(e?.message || 'Could not load your seed inventory.')
    } finally {
      if (seqRef.current === my) setRefreshing(false)
    }
  }, [fetch, commit])

  useEffect(() => { reload() }, [reload])

  const getRow = useCallback((id) => (itemsRef.current ?? []).find((r) => r.id === id), [])

  // In-place edit of one row. A no-op before the first load rather than inventing a list.
  const patch = useCallback((id, next) => {
    commit((prev) => (prev ? prev.map((r) => (r.id === id ? next(r) : r)) : prev))
  }, [commit])

  return {
    items,
    // First load only. A reload keeps the rows on screen and reports through `refreshing` / `error`.
    loading: items === null && !error,
    error,
    fromCache,
    refreshing,
    reload,
    patch,
    getRow,
  }
}
