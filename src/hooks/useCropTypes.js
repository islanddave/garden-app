// useCropTypes — V4-PLANTTYPE-001 controlled crop-type vocabulary (GET /api/varieties/crop-types).
// Loaded once per mount; globally readable. Non-fatal by design: any failure (or a test mock that
// returns a non-Promise) resolves to an empty list so consumers (VarietyPicker) degrade to the
// legacy no-type create path rather than blocking variety creation. Promise.resolve() wraps the
// fetch so a synchronous/undefined mock return can't throw.
//
// Contract: { cropTypes: [{ slug, display_name, default_lifecycle, category, sort_order }], loading }

import { useState, useEffect } from 'react'
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

  return { cropTypes, loading }
}
