import { useState, useEffect, useCallback } from 'react'
import { useApiFetch } from '../lib/api.js'
import { snapshotStats } from '../lib/snapshotStats.js'

// useHarvestSnapshot — the snapshot strip self-labels FIXED windows, so it fetches independently
// of the Log's filters. Grow-year = Nov 1 – Oct 31; the derivation is the ONE shared helper in
// src/lib/growYear.js.
//
// TWO REQUESTS, ONE PER WINDOW.
//
// Filtering a season-scoped request's `entries` client-side down to the last 7 days would count a
// PAGE, not a set: GET /api/harvests caps entries at PAGE_LIMIT = 50 (lambda/harvests/index.js)
// while `aggregates` is computed over the full filter range with no cursor and no limit. The tile
// would read "50 picks" against a true 163 — the 50 newest rows cover only a few days, and both the
// count AND the top-crop phrase under them would come from that slice while labelled "Last 7 days".
//
// NOT A CURSOR DRAIN. Walking the pages would be several round trips, growing every week, on a
// surface that needs one number; and RAISING PAGE_LIMIT only moves the cliff.
// The 7-day window is asked for as a window — `timeframe=7d&include=aggregates` — so the server
// counts it over the whole range and the answer is structurally uncappable.
//
// The season request stays, and stays entries-bearing, because the other two tiles need what only
// it can answer: `lastHarvest` is the most recent SEASON entry (entries are (event_date,id) DESC,
// so entries[0] is exact and unaffected by the cap), and Harvests.jsx's off-season re-anchor reads
// its day_key — sourcing it from the 7-day window instead would report "no harvest" every time the
// last pick was 8 days ago and silently re-anchor the page to last season.
//
// Both in flight together, and allSettled rather than all for two reasons. Mechanically, `all`
// rejects on the first failure and leaves the second rejection UNHANDLED — a real window
// `unhandledrejection` in the browser, not just test noise, since these two fail together whenever
// the network does. Semantically, the tiles are read as one sentence about the week, so any failure
// is a whole failure: "A quiet week" printed over a week that had 163 picks is a wrong number, and
// a strip that does not render says nothing false.
import { currentGrowYear } from '../lib/growYear.js'

export function useHarvestSnapshot() {
  const { fetch: apiFetch } = useApiFetch()
  const [snapshot, setSnapshot] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const year = currentGrowYear(new Date())
      const [season, last7] = await Promise.allSettled([
        apiFetch(`/api/harvests?include=entries,aggregates&timeframe=season:${year}`),
        apiFetch('/api/harvests?include=aggregates&timeframe=7d'),
      ])
      setSnapshot(season.status === 'fulfilled' && last7.status === 'fulfilled'
        ? snapshotStats(season.value?.entries ?? [], season.value?.aggregates ?? null, last7.value?.aggregates ?? null)
        : null)
    } catch {
      setSnapshot(null) // snapshot is ambient — never blocks the page; the Log owns the error surface
    } finally {
      setLoading(false)
    }
  }, [apiFetch])

  useEffect(() => { load() }, [load])
  return { snapshot, loading }
}
