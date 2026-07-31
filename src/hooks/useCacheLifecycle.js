// src/hooks/useCacheLifecycle.js — V4-IMGCACHE-002 D-2. The lifecycle half of the image-list cache:
// B3 boot-warm and B5 resume-revalidate. D-1 shipped the store and the read hook; on its own the cache
// only fills as a side effect of visiting a surface, and never refreshes while the app sits open.
//
// WHY B5 MATTERS AFTER D-1 (this is the regression D-1 quietly introduced):
//   PhotoImg seeds its proactive-remint clock from the initialUrl it is handed at mount, on the
//   assumption that URL "came from a recent list fetch" (PhotoImg.jsx _seed). D-1 made that assumption
//   false — a cache-served list can be arbitrarily old, so a photo can mount with an already-expired
//   presign stamped as fresh, skip the proactive re-mint, render the dead URL, 403, and only then heal
//   reactively. Visible as a flash. Revalidating watched keys on foreground pushes fresh URLs into
//   already-mounted <img>s through PhotoImg's initialUrl-change adoption path (NEW-1), which also
//   resets its retry budget — so the heal happens before the stale URL is ever painted.
//
// Deliberately NOT done here: threading the cache entry's real age into PhotoImg as an `initialUrlAt`
// prop. That is the correct root fix but it reopens the frozen A1 prop contract across ~13 adopted
// sites; the wake revalidate closes the same window without touching it.
//
// Everything below is a no-op when IMAGE_LIST_CACHE_ENABLED is off — D-2 must degrade exactly like
// D-1 does, back to plain per-mount fetches.
import { useCallback, useEffect, useRef } from 'react'
import { useApiFetch } from '../lib/api.js'
import * as cache from '../lib/dataCache.js'
import { IMAGE_LIST_CACHE_ENABLED } from '../lib/featureFlags.js'

// Paths worth warming at boot. ONLY globally-knowable keys belong here: per-planting and per-location
// photo paths depend on a route param nobody has navigated to yet, so warming them would be guesswork
// that costs a request and usually misses.
export const BOOT_WARM_PATHS = ['/api/photos']

// Foreground revalidate is gated on entry age. Below this, a wake is treated as an app-switch glance
// and skipped: visibilitychange fires on every alt-tab, and an ungated version would refetch every
// watched photo list constantly. Above it, the list is old enough that both its membership and its
// 900s presigns are worth refreshing. Chosen under the presign TTL so a resumed tab gets fresh URLs
// BEFORE they expire rather than after.
export const RESUME_MIN_AGE_MS = 5 * 60 * 1000

export function useCacheLifecycle(sub) {
  const { fetch } = useApiFetch()
  const fetchRef = useRef(fetch); fetchRef.current = fetch

  // B3 — boot-warm, once per resolved identity. Gated on `sub` for the same reason useCachedFetch is:
  // nothing may be cached under an absent sub, or a later user could read the previous bucket.
  useEffect(() => {
    if (!IMAGE_LIST_CACHE_ENABLED || !sub) return
    for (const path of BOOT_WARM_PATHS) {
      cache.warm(
        cache.keyFor(sub, path),
        () => fetchRef.current(path).then((d) => (Array.isArray(d) ? d : (d ?? []))),
      )
    }
  }, [sub])

  // B5 — revalidate watched keys on foreground / bfcache restore / Chromium resume. Same three
  // listeners PhotoImg uses, so the list refresh and the per-image proactive re-mint wake together.
  useEffect(() => {
    if (!IMAGE_LIST_CACHE_ENABLED) return
    const onWake = () => {
      if (document.visibilityState === 'hidden') return
      cache.revalidateLive(RESUME_MIN_AGE_MS)
    }
    document.addEventListener('visibilitychange', onWake)
    window.addEventListener('pageshow', onWake)
    document.addEventListener('resume', onWake)
    return () => {
      document.removeEventListener('visibilitychange', onWake)
      window.removeEventListener('pageshow', onWake)
      document.removeEventListener('resume', onWake)
    }
  }, [])
}

// B4 hook-point for a pull-to-refresh gesture. The cache half is done and tested; the app has no
// pull-to-refresh affordance today, so nothing calls this yet — wiring it is a UI decision, not a
// cache one. Returns the number of watched keys refreshed.
export function useRefreshAll() {
  return useCallback(() => (IMAGE_LIST_CACHE_ENABLED ? cache.refreshAll() : 0), [])
}
