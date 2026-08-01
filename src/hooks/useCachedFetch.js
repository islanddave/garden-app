// src/hooks/useCachedFetch.js — V4-IMGCACHE-001 D-1. SWR read hook over dataCache, gated by
// IMAGE_LIST_CACHE_ENABLED AND a live household identity.
//
// Three modes (rules-of-hooks: all hooks are called every render; the return selects the mode):
//  • CACHED   (flag ON + a Clerk sub + a non-null path): identity-scoped key `${sub}|${path}`.
//    Subscribes to the store, serves cache on first paint, revalidates on EVERY mount, returns
//    { data, loading, error, isValidating, refetch }. `loading` is true until data OR an error exists.
//  • PLAIN    (flag OFF, OR flag ON but no sub yet — path present): a plain fetch-on-mount that writes
//    NO cache entry — byte-identical to the pre-D1 useState+useEffect sites. The no-sub branch is the
//    security boundary: nothing is EVER cached under an absent sub, so user B can never read a
//    `u:undefined|…` bucket (the request still goes out, uncached, exactly as today). It also means a
//    provider-less unit test just plain-fetches — no AuthProvider harness needed.
//  • IDLE     (no path): pending, no fetch, no cache.
//
// `error` surfaces ONLY on a COLD failure (no usable data); a background-revalidate failure keeps the
// cached list (error:null) so a transient blip never blows away good photos.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useApiFetch } from '../lib/api.js'
import { useAuthOptional } from '../context/AuthContext.jsx'
import * as cache from '../lib/dataCache.js'
import { IMAGE_LIST_CACHE_ENABLED } from '../lib/featureFlags.js'

// `stale` (SW-STALEAPI-001): the last commit came from the service worker's offline cache rather
// than the network. Carried through so a surface can say so; the correctness half — never
// advancing the freshness clock — lives in dataCache and does not depend on anyone reading this.
const EMPTY_SNAP = { status: 'empty', data: undefined, error: null, isValidating: false, stale: false }
const _noopUnsub = () => () => {}

export function useCachedFetch(path) {
  const { fetch } = useApiFetch()
  const { user } = useAuthOptional()
  const sub = user?.id ?? null
  const flagOn = IMAGE_LIST_CACHE_ENABLED
  const cached = flagOn && !!path && !!sub
  const usePlain = !cached && !!path            // flag OFF, or flag ON but no sub yet — plain fetch, no cache
  const key = cached ? cache.keyFor(sub, path) : null   // D-2: shared builder, or boot-warm misses

  // Latest fetch fn behind a ref so the fetcher identity stays stable across token refreshes.
  const fetchRef = useRef(fetch); fetchRef.current = fetch
  const fetcher = useCallback(
    () => fetchRef.current(path).then((d) => (Array.isArray(d) ? d : (d ?? []))),
    [path],
  )

  // ── CACHED path (no-ops when key is null) ──
  const subscribe = useCallback((cb) => (key ? cache.subscribe(key, cb) : _noopUnsub()), [key])
  const getSnap = useCallback(() => (key ? cache.getSnapshot(key) : EMPTY_SNAP), [key])
  const snap = useSyncExternalStore(subscribe, getSnap, getSnap)
  useEffect(() => {
    if (!key) return
    cache.register(key, fetcher)
    cache.revalidate(key)            // serve cache (already in snap) + revalidate on every mount
  }, [key, fetcher])

  // ── PLAIN fallback (flag OFF only) ──
  const [local, setLocal] = useState({ data: undefined, loading: usePlain, error: null })
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!usePlain) return
    let alive = true
    // Keep any prior data during a re-fetch (SWR-like) so a refetch()/events-trigger never blanks the
    // list mid-view; `loading` is true only when there is nothing to show yet (cold).
    setLocal((prev) => ({ data: prev.data, loading: prev.data === undefined, error: null }))
    fetchRef.current(path).then(
      (d) => { if (alive) setLocal({ data: Array.isArray(d) ? d : (d ?? []), loading: false, error: null }) },
      (err) => { if (alive) setLocal((prev) => ({ data: prev.data ?? [], loading: false, error: err })) },
    )
    return () => { alive = false }
  }, [usePlain, path, tick])

  const refetch = useCallback(() => { if (key) cache.revalidate(key); else setTick((t) => t + 1) }, [key])

  if (cached) {
    const loading = snap.data === undefined && snap.status !== 'error'
    return { data: snap.data, loading, error: snap.error, isValidating: snap.isValidating, stale: !!snap.stale, refetch }
  }
  if (usePlain) return { data: local.data, loading: local.loading, error: local.error, isValidating: false, stale: false, refetch }
  return { data: undefined, loading: false, error: null, isValidating: false, stale: false, refetch }   // IDLE (no path)
}
