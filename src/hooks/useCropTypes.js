// useCropTypes — V4-PLANTTYPE-001 controlled crop-type vocabulary (GET /api/varieties/crop-types).
// Loaded once per mount; globally readable. Non-fatal by design: any failure (or a test mock that
// returns a non-Promise) resolves to an empty list so consumers (VarietyPicker) degrade to the
// legacy no-type create path rather than blocking variety creation. Promise.resolve() wraps the
// fetch so a synchronous/undefined mock return can't throw.
//
// V4-CROPTYPE-001 adds WRITES: the vocabulary is no longer read-only from the app. Previously a
// crop with no matching type had to be saved with crop_type_slug = NULL, which dropped it out of
// every type-grouped view.
//
// V4-MATURITYBASIS-001 adds `dtm_basis` ('from-sow' | 'from-transplant' | null) to the row shape —
// the DTM basis for the crop kind. Additive; null means uncurated.
//
// V4-PUTUPFOODCATEGORY-001 adds SCOPE. crop_types now also carries non-plant food classes (bread,
// cheese, milk, butter, yogurt, meat, fish — category 'non_plant_food') so that Put-Up can record
// and browse food that never grew in a garden. Those rows are correct in the pantry and wrong
// everywhere else: `Bread` must never be offerable as a crop to plant, to type a variety to, or to
// classify a garden project as.
//
// The default is 'garden', i.e. FAIL-CLOSED. The one surface that wants the food classes
// (PutUp's crop field) opts in explicitly with scope: 'all'; every other caller — present and
// future — gets the garden vocabulary without having to know this paragraph exists. The inverse
// default would put a loaf of bread in the planting picker the first time somebody added a call
// site without reading this file, and nothing would have failed.
//
// OPS-CROPTYPEALIASCLIENT-001 adds `search_aliases` to the row shape — the comma-separated alternate
// names for the crop ('melon' -> 'cantaloupe, muskmelon, honeydew'), null for most types. It is a
// MATCHING column, never a display one: split it with splitCropAliases() and filter against it, and
// do not render it. The reason it is a column of its own rather than more parentheticals inside
// display_name is that display_name reaches the text of a public Facebook/Instagram post
// (lambda/facebook-share/index.js:319), and the alias list must not follow it there.
//
// Contract: { cropTypes: [{ slug, display_name, default_lifecycle, category, sort_order, dtm_basis,
//                           search_aliases }], loading,
//             createCropType(payload) -> { cropType } | { error, existing, reason } }
// Options:  { scope: 'garden' | 'all', enabled: boolean }

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useApiFetch } from '../lib/api.js'

// The gating category, seeded by migrations/v4-putupfood-001. Exported so the parity test can bind
// this constant to the migration's own VALUES tuples rather than re-typing the string.
export const NON_PLANT_FOOD_CATEGORY = 'non_plant_food'

export function useCropTypes({ scope = 'garden', enabled = true } = {}) {
  const { fetch } = useApiFetch()
  const [cropTypes, setCropTypes] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // OPS-CROPTYPEALIASCLIENT-001 — `enabled` exists for ONE call site and one invariant.
    // PlantingSelect needs this vocabulary to match a crop's aliases, but in CONTROLLED mode
    // (`plants` supplied by the host) it is contractually forbidden to hit the network at all —
    // BUG-PLANTFETCHSILENT-001, and PlantingSelect.test.jsx asserts the fetch spy was never called
    // on mount OR on focus. The vocabulary is read only inside the typed filter, so that site defers
    // until a query exists and this flag is what lets it. Default true: every other caller
    // (VarietyPicker, PutUp, VarietyEdit, ProjectsAdminClassify, Search, VoiceHarvest) is unchanged
    // and still loads once per mount.
    //
    // `loading` must resolve even when disabled, or a consumer gating render on it hangs forever
    // on a page that was never going to fetch.
    if (!enabled) { setLoading(false); return undefined }
    let alive = true
    setLoading(true)
    Promise.resolve(fetch('/api/varieties/crop-types'))
      .then(data => { if (alive) setCropTypes(Array.isArray(data) ? data : []) })
      .catch(() => { if (alive) setCropTypes([]) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [fetch, enabled])

  // { cropType } on success, or { error, existing, reason } when the server steers to an existing
  // type. `reason` is 'exists' | 'plural' | 'coupled_synonym'; the last means the requested name is
  // another word for a crop whose DERIVED facets a duplicate type would silently lose, so the UI
  // should present adopting the existing type as the correct action rather than as a failure.
  // Inserts locally in sort order so the picker reflects it without a refetch.
  const createCropType = useCallback(async (payload) => {
    try {
      const created = await fetch('/api/varieties/crop-types', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      setCropTypes(prev => [...prev.filter(c => c.slug !== created.slug), created].sort((a, b) =>
        (a.sort_order - b.sort_order) || String(a.display_name).localeCompare(String(b.display_name))))
      return { cropType: created }
    } catch (err) {
      return {
        error: err?.message ?? 'Failed to create crop type',
        existing: err?.body?.existing ?? null,
        reason: err?.body?.reason ?? null,
      }
    }
  }, [fetch])

  // Filtered on the way OUT, never on the way in: createCropType above still reconciles against the
  // full list, so minting a type that this scope hides cannot produce a duplicate row locally.
  // Depends on the scope STRING rather than the options object, so an inline literal at the call
  // site does not re-derive on every render.
  const scoped = useMemo(
    () => (scope === 'all' ? cropTypes : cropTypes.filter(c => c.category !== NON_PLANT_FOOD_CATEGORY)),
    [cropTypes, scope],
  )

  return { cropTypes: scoped, loading, createCropType }
}
