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
// Contract: { cropTypes: [{ slug, display_name, default_lifecycle, category, sort_order }], loading,
//             createCropType(payload) -> { cropType } | { error, existing, reason } }

import { useState, useEffect, useCallback } from 'react'
import { useApiFetch } from '../lib/api.js'

export function useCropTypes() {
  const { fetch } = useApiFetch()
  const [cropTypes, setCropTypes] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    Promise.resolve(fetch('/api/varieties/crop-types'))
      .then(data => { if (alive) setCropTypes(Array.isArray(data) ? data : []) })
      .catch(() => { if (alive) setCropTypes([]) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [fetch])

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

  return { cropTypes, loading, createCropType }
}
