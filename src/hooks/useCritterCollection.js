// useCritterCollection — fetch hook for /api/critters/collection (Stickerbook Phase 2).
//
// Contract:
//   { collected, loading, error, reload }
//   collected — Map<rosterId, {speciesId, count, firstSeenAt, lastSeenAt}>
//
// Failure semantics:
//   - fetchCollection NEVER throws (critterClient pattern); null = no-op (env unset OR
//     auth fail OR network fail). We surface a single string for the page's error banner.
//   - collected stays an empty Map on any failure; the page still renders silhouettes.
//
// Mirrors useAchievements shape (data/loading/error/reload) but uses a Map instead of
// a list because every page render does O(1) `collected.has(rosterId)` lookups against
// 168 entries.

import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from '@clerk/react'
import { fetchCollection } from '../lib/critterClient.js'
import { indexCollectionRows } from '../lib/critterCollection.js'

export function useCritterCollection() {
  const { getToken } = useAuth()
  const [collected, setCollected] = useState(() => new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const loadCounterRef = useRef(0)

  const reload = useCallback(async () => {
    const my = ++loadCounterRef.current
    setLoading(true)
    setError(null)
    try {
      const result = await fetchCollection({ getToken })
      if (loadCounterRef.current !== my) return
      if (result == null) {
        setError('Could not load your collection')
        setCollected(new Map())
      } else {
        setCollected(indexCollectionRows(result.species ?? []))
      }
    } catch (err) {
      if (loadCounterRef.current !== my) return
      setError(err?.message ?? 'Could not load your collection')
      setCollected(new Map())
    } finally {
      if (loadCounterRef.current === my) setLoading(false)
    }
  }, [getToken])

  useEffect(() => { reload() }, [reload])

  return { collected, loading, error, reload }
}
