import { useState, useEffect, useCallback } from 'react'
import { useApiFetch } from '../lib/api.js'

// useHarvestFilterOptions — V4-HARVESTVIEW-001 S2b (part 2). Supplies the crop + project pickers with
// a STABLE option universe that is independent of the Log's active crop/project filter.
//
// Why not source the crop list from the main useHarvests aggregates: the server computes aggregates
// over the SAME filtered query (lambda/harvests/index.js AND cv.crop_type_slug = crop), so once a
// crop filter is applied aggregates.crop_list collapses to just that one crop — the picker would then
// lose every other option and you could never switch crops without clearing first. So the crop list
// comes from one unfiltered all-time `include=aggregates` call (no entries payload), and the project
// list from the existing /api/projects. Both are best-effort: a failure leaves that picker empty and
// never blocks the page (the Log owns the error surface).
export function useHarvestFilterOptions() {
  const { fetch: apiFetch } = useApiFetch()
  const [crops, setCrops] = useState([])
  const [projects, setProjects] = useState([])
  // V4-HARVESTVIEW-001 S4: the season sheet's year universe rides this SAME unfiltered all-time
  // call (design §2b — never the page's timeframe-scoped aggregates, which would collapse the
  // universe to the selected season on first use, the exact trap documented above for crop_list).
  // Retained as the MIN first_pick day key; the page derives the continuous grow-year range from it.
  const [minFirstPickDay, setMinFirstPickDay] = useState(null)

  const load = useCallback(async () => {
    try {
      const data = await apiFetch('/api/harvests?include=aggregates')
      const list = data?.aggregates?.crop_list
      setCrops(Array.isArray(list) ? list : [])
      const fp = Array.isArray(data?.aggregates?.first_pick) ? data.aggregates.first_pick : []
      let min = null
      for (const f of fp) {
        const k = f?.first_pick_date
        if (k && (min == null || k < min)) min = k
      }
      setMinFirstPickDay(min)
    } catch { /* leave crops empty — the picker just shows its empty text */ }
    try {
      const rows = await apiFetch('/api/projects')
      const ps = (Array.isArray(rows) ? rows : [])
        .filter((p) => p && p.id != null)
        .map((p) => ({ id: p.id, name: p.name ?? '' }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)))
      setProjects(ps)
    } catch { /* leave projects empty */ }
  }, [apiFetch])

  useEffect(() => { load() }, [load])
  return { crops, projects, minFirstPickDay }
}
