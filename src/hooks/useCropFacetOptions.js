// useCropFacetOptions — V5-PHOTOFILTERPARITY-001 (BD0901-01). THE shared derivation behind every
// crop-chip row: the option universe (count-descending, drawn from the rows on screen), the labels
// (from the controlled crop-type vocabulary), and the derived pins FilterChipRow collapses around.
//
// MINTED BECAUSE IT WAS ABOUT TO BE WRITTEN A FOURTH TIME. The same twelve lines already exist in
// PlantingSelect.jsx (`cropUniverse` + `pinnedSlugs`, entangled with bandOrder's recents band) and
// TWICE inside SavedSeeds.jsx (`cropOptions`/`cropPinned` for the packet picker and
// `trackedCropOptions`/`trackedCropPinned` for the page). Photos would have been the fourth copy and
// Log Many's crop filter the fifth — ScopeChecklist.jsx ADOPTED this hook instead
// (V4-LOGMANYCROPFILTER-001), which is what put the controlled `display_name` on its chips in place
// of a titleized slug. This is the seam; the remaining copies are a tracked follow-up rather than
// part of this change, because PlantingSelect's pins are NOT simply the top two (it layers a recents
// band and a tie-preference on top) and re-pointing a chooser that eight surfaces open is its own
// regression surface. Adopting it in SavedSeeds is a drop-in and is deliberately left to the lane
// that owns that file.
//
// THE SEAM IS rows + slugOf, not rows + a field name, because the three shapes reach their crop
// differently and only one of them reads a column: a seed lot has `crop_slug`, a planting has
// `variety_ref.crop_type_slug`, and a PHOTO has none at all — its crop comes from JOINING plant_id
// against the planting list (photoFilters.cropOfPhoto). An accessor covers all three; a field name
// would have covered two and quietly excluded the caller this was minted for.
//
// COUNT-DESC, NOT ALPHABETICAL, and derived from the ROWS rather than from the vocabulary. Both are
// SavedSeeds' recorded reasoning and both hold generally: a chip that matches nothing is a control
// that can only disappoint, and frequency order puts the reachable answers where the thumb already
// is. FilterChipRow's pinned-first re-sort is stable (FilterChipRow.jsx:55-63), so this order
// survives into the More tray untouched.
//
// PASS THE PRE-FILTER ROWS. Deriving the universe from the already-chip-filtered set is the
// self-collapse trap useHarvestFilterOptions.js documents: one tap on Tomato and Tomato is the only
// chip left, so no second crop is reachable without clearing first.
import { useMemo } from 'react'
import { useCropTypes } from './useCropTypes.js'
import { prettySlug } from '../lib/photoFilters.js'

// Two, matching SavedSeeds. The collapsed FilterChipRow shows pinned ∪ selected, so this is how many
// crops are one tap away before the More tray; a bigger number wraps the row on a 390px phone.
export const DEFAULT_CROP_PIN_COUNT = 2

// `slugOf` MUST be referentially stable (useCallback at the call site) — it is a memo dep, and an
// inline arrow re-derives the whole universe on every render of a page that holds ~1,400 rows.
export function useCropFacetOptions(rows, slugOf, { pinCount = DEFAULT_CROP_PIN_COUNT, enabled = true } = {}) {
  // The app's naming authority. Non-fatal by design (it resolves to an empty list on any failure),
  // so prettySlug below is its documented degrade path, not a guess — and NOT a second naming
  // authority, which is how two surfaces start disagreeing about what a crop is called.
  const { cropTypes } = useCropTypes({ enabled })
  const labelBySlug = useMemo(() => {
    const m = new Map()
    for (const t of cropTypes ?? []) if (t?.slug) m.set(t.slug, t.display_name || prettySlug(t.slug))
    return m
  }, [cropTypes])
  // V4-LOGMANYCROPFILTER-001 — the ROWS, not just their labels, and additive so PhotoLibrary's
  // destructure is untouched. A chip row and the search box beside it must answer to the same
  // vocabulary: ScopeChecklist labels a chip "Summer Squash" from `labelBySlug` and then feeds
  // `looseIncludesCropType(slug, q, bySlug.get(slug))` — the ONE crop-type matcher Search,
  // PlantingSelect and VarietyPicker already share (comboboxInput.js) — so typing that same label,
  // or an alias ('cantaloupe' for melon), finds the row. Exposing the row here rather than calling
  // useCropTypes a second time at the call site is the point: two calls are two GETs of the same
  // endpoint, and search_aliases lives only on the row.
  const bySlug = useMemo(() => {
    const m = new Map()
    for (const t of cropTypes ?? []) if (t?.slug) m.set(t.slug, t)
    return m
  }, [cropTypes])

  const counts = useMemo(() => {
    const m = new Map()
    if (!enabled) return m
    for (const r of rows ?? []) {
      const slug = slugOf?.(r)
      if (!slug) continue
      m.set(slug, (m.get(slug) ?? 0) + 1)
    }
    return m
  }, [rows, slugOf, enabled])

  const options = useMemo(() => (
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([slug]) => ({ value: slug, label: labelBySlug.get(slug) || prettySlug(slug) }))
  ), [counts, labelBySlug])

  // DERIVED, never a literal pair of slugs. Whichever two crops dominate the rows in hand ARE the
  // two worth pinning, and that changes with the season — hardcoding today's answer freezes one
  // month into the source. `options` is already count-descending, so the head is the answer.
  const pinned = useMemo(() => options.slice(0, pinCount).map(o => o.value), [options, pinCount])

  return { options, pinned, labelBySlug, counts, bySlug }
}
