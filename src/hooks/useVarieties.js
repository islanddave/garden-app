// useVarieties — live data hook for plant_varieties (VARIETY-REF Session 2).
// Wraps useApiFetch with stateful varieties list + search via ?q= server-side filter.
//
// Contract:
//   { varieties, loading, error, search,
//     createVariety(payload, { allowDuplicate }) -> { variety } | { error, existing },
//     updateVariety(id, payload) -> { variety } | { error },
//     deleteVariety(id) -> { ok: true } | { error },
//     reload() -> Promise<void> }
//
// Notes:
//   - search(q) re-fetches from server (LIKE on name, max 50). Empty string = list all (max 50).
//   - createVariety returns 409 with { existing } if name+species collision; pass
//     { allowDuplicate: true } to override.

import { useState, useEffect, useCallback, useRef } from 'react'
import { useApiFetch } from '../lib/api.js'

export function useVarieties() {
  const { fetch } = useApiFetch()
  const [varieties, setVarieties] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const loadCounterRef = useRef(0)

  const reload = useCallback(async (q = null) => {
    const my = ++loadCounterRef.current
    setLoading(true)
    setError(null)
    try {
      const path = q ? `/api/varieties?q=${encodeURIComponent(q)}` : '/api/varieties'
      const data = await fetch(path)
      if (loadCounterRef.current !== my) return
      setVarieties(Array.isArray(data) ? data : [])
    } catch (err) {
      if (loadCounterRef.current !== my) return
      setError(err?.message ?? 'Failed to load varieties')
    } finally {
      if (loadCounterRef.current === my) setLoading(false)
    }
  }, [fetch])

  useEffect(() => { reload() }, [reload])

  const search = useCallback((q) => reload(q), [reload])

  const createVariety = useCallback(async (payload, opts = {}) => {
    try {
      const body = opts.allowDuplicate ? { ...payload, allow_duplicate: true } : payload
      const created = await fetch('/api/varieties', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      setVarieties(prev => [created, ...prev])
      return { variety: created }
    } catch (err) {
      const msg = err?.message ?? 'Failed to create variety'
      const existing = err?.body?.existing ?? null
      return { error: msg, existing }
    }
  }, [fetch])

  const updateVariety = useCallback(async (id, payload) => {
    try {
      const updated = await fetch(`/api/varieties/${id}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      })
      setVarieties(prev => prev.map(v => v.id === id ? updated : v))
      return { variety: updated }
    } catch (err) {
      return { error: err?.message ?? 'Failed to update variety' }
    }
  }, [fetch])

  const deleteVariety = useCallback(async (id) => {
    try {
      await fetch(`/api/varieties/${id}`, { method: 'DELETE' })
      setVarieties(prev => prev.filter(v => v.id !== id))
      return { ok: true }
    } catch (err) {
      return { error: err?.message ?? 'Failed to delete variety' }
    }
  }, [fetch])

  return { varieties, loading, error, search, createVariety, updateVariety, deleteVariety, reload }
}
