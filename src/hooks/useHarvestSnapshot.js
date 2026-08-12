import { useState, useEffect, useCallback } from 'react'
import { useApiFetch } from '../lib/api.js'
import { snapshotStats } from '../lib/snapshotStats.js'
import { etDay, addDays } from '../lib/harvestSummary.js'

// useHarvestSnapshot — V4-HARVESTVIEW-001 S2b. The snapshot strip self-labels FIXED windows
// (design §3b), so it fetches season-scoped independently of the Log's filters. One request:
// season entries (most-recent first → last harvest + last-7-days derivation) + aggregates
// (this-season distinct-crop count). Grow-year = Nov 1 – Oct 31; "2026 season" ends Oct 2026.
// S4: grow-year derivation moved to the ONE shared helper (src/lib/growYear.js) — this file held
// one of the two duplicated copies the design §2b consolidation names.
import { currentGrowYear, HARVEST_TZ } from '../lib/growYear.js'

export function useHarvestSnapshot() {
  const { fetch: apiFetch } = useApiFetch()
  const [snapshot, setSnapshot] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const now = new Date()
      const year = currentGrowYear(now)
      const data = await apiFetch(`/api/harvests?include=entries,aggregates&timeframe=season:${year}`)
      const todayKey = etDay(now, HARVEST_TZ)
      const sevenDaysAgoKey = addDays(todayKey, -6) // rolling last-7-days, inclusive
      setSnapshot(snapshotStats(data?.entries ?? [], data?.aggregates ?? null, { todayKey, sevenDaysAgoKey }))
    } catch {
      setSnapshot(null) // snapshot is ambient — never blocks the page; the Log owns the error surface
    } finally {
      setLoading(false)
    }
  }, [apiFetch])

  useEffect(() => { load() }, [load])
  return { snapshot, loading }
}
