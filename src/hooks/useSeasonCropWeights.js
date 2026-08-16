// useSeasonCropWeights — V4-HARVWEIGHTSURF-001, the Garden slice. This season's harvest weight per
// crop, keyed by crop_type_slug, so the Garden's crop-type groups can say what that crop has actually
// produced instead of only how many plantings of it exist.
//
// THE AGGREGATE, NOT THE ENTRIES. GET /api/harvests pages `entries` at 50 rows (PAGE_LIMIT in
// lambda/harvests/index.js) while `aggregates` is computed over the FULL filter range with no cursor
// and no limit. A garden-wide per-crop sum derived from entries would therefore be a fraction of the
// truth — the Lambda's own comment records a ~4x undercount from exactly that mistake — and walking
// the cursor to fix it would be ~8 round trips on the app's most-used surface. `include=aggregates`
// alone also skips the entries query server-side, so this is the cheaper request as well.
//
// THERE IS NO PER-PLANTING EQUIVALENT, and that is a wire fact rather than a choice: the weight
// aggregate is GROUP BY GROUPING SETS ((), (cv.crop_type_slug)) — a grand total and per-crop totals,
// nothing per plant_id. A per-tile number would need a server change and its own deploy leg, so the
// crop group (which is what the Garden groups by under PROJECTS_HIDDEN) is the finest grain this
// surface can state truthfully today.
import { useMemo } from 'react'
import { useCachedFetch } from './useCachedFetch.js'
import { currentGrowYear } from '../lib/growYear.js'

// `enabled` false → a null path, which useCachedFetch treats as IDLE: no request, no cache entry.
// Every Garden grouping other than crop-type has no key the harvest aggregate can be joined on, so
// this must not fire for them.
export function useSeasonCropWeights(enabled = true) {
  const path = enabled
    ? `/api/harvests?include=aggregates&timeframe=season:${currentGrowYear(new Date())}`
    : null
  const { data } = useCachedFetch(path)
  return useMemo(() => {
    const m = new Map()
    for (const c of data?.aggregates?.crops ?? []) {
      // SPLIT-ARTIFACT GUARD, same one PlantingDetail carries: the SPA and the harvests Lambda deploy
      // on separate legs, and `weight` is simply ABSENT from a crops[] row served by a Lambda older
      // than V4-HARVWEIGHTREAD-001. Skipped rather than zero-filled — "this API does not compute
      // weight" and "nothing under this crop was weighed" are different facts, and only the second is
      // safe to render.
      if (c?.crop_type_slug && c.weight) m.set(c.crop_type_slug, c.weight)
    }
    return m
  }, [data])
}
