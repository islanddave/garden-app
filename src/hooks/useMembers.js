// useMembers — read hook for GET /api/members (PLANT-ASSIGN-001 caretaker roster).
// Contract: { members, loading, error, reload } where members = [{ id, display_name }] and error is a
// string or null. (email dropped 0A.6 — no consumer rendered it; roster is household-scoped server-side.)
// Clerk is the roster source (no DB table).
//
// BUG-GARDENSPOTCREEP-001 — served from the app's SWR store (useCachedFetch/dataCache), not a bare
// fetch-on-mount. Uncached, every mount started with members = [] and the household landed a round trip
// later. On Garden that is not cosmetic: the caretaker row (Mine / Jen / Everyone) sits ABOVE the list and
// renders only once the roster has two members, so on every return to the tab it appeared ~64px tall a
// round trip after Garden had already restored its spot into a page without it. Chrome's scroll anchoring
// then held that (one row too far down) content still by adding the row's height to the offset, Garden's
// recorder filed the offset as the spot, and each Today → Garden round trip landed one more row further
// down the list: the planting left on screen came back 64 / 128 / 192px up it, flag on and off
// (_seedstab12_20260925/gardencreep-v2-red-*.txt). With the cache, a return paints the household it had
// last time on its first render, and the revalidate every mount still does changes the page only when the
// household actually changed. A COLD roster (the first visit, or the key evicted from the store) still
// lands one row off once; it cannot compound, because the next return has the row cached.
//
// Not behind SCROLL_MANAGER_ENABLED: undoing it is a revert of this file (featureFlags.js' runbook says so).
//
// Kept for every caller: `loading` is true only while there is nothing to show (a cache hit makes it false
// on the first render); `error` is a string, and — the store's rule — only a COLD failure surfaces one:
// a failed revalidate keeps serving the cached household with error null. `reload` is the store's refetch.
// No Clerk sub (no AuthProvider, a signed-out moment) is useCachedFetch's PLAIN mode: a plain fetch that
// caches nothing, as before.
import { useMemo } from 'react'
import { useCachedFetch } from './useCachedFetch.js'

export function useMembers() {
  const { data, loading, error, refetch } = useCachedFetch('/api/members')
  // The route answers { members: [...] }; useCachedFetch stores that object as-is (its fetcher only
  // coerces an absent body to []). The store keeps a revalidate's prior `data` ref only for ARRAYS
  // (dataCache's merge-by-id), so every revalidate of this object is a new ref even when the household
  // is unchanged — and a new `members` array per mount would recompute every memo keyed on it (Garden's
  // lens options and caretaker map, Findings'). So the list is keyed on its CONTENT: an unchanged
  // household keeps the same array, a changed one is a new array.
  const key = useMemo(() => JSON.stringify(Array.isArray(data?.members) ? data.members : []), [data])
  const members = useMemo(() => JSON.parse(key), [key])
  return { members, loading, error: error ? (error.message ?? 'Failed to load caretakers') : null, reload: refetch }
}
