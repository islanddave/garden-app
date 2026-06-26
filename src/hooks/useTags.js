// useTags / useEntityTags — frontend wire for the V4-TAGSUB-001 faceted tag substrate
// (garden-tags Lambda: /api/tags + /api/entity-tags). Backend shipped v3.2.0; this is the
// read/write seam GARDENIA + PlantingUI will consume. No surface renders tags yet (wire-only).
//
// GUARD (D-WIRE): both hooks are inert when import.meta.env.VITE_API_TAGS is falsy — no fetch,
// loading resolves false, lists empty, mutations return { error: 'Tags API not configured' }.
// Lets the hooks land + ship before the repo var / build wiring is live (ship-then-wire, the
// VITE_API_VARIETIES precedent) without a relative-origin 404 from resolveUrl's '' base fallback.
//
// Contracts mirror lambda/tags/index.js:
//   GET    /api/tags?facet=&q=                       -> Tag[]              (canonical visibility predicate)
//   POST   /api/tags                                 -> Tag (201|200)     { facet, label, visibility? }
//   PATCH  /api/tags/:id                             -> Tag               { label?, visibility? }
//   DELETE /api/tags/:id                             -> { ok:true }       (also soft-detaches its links)
//   POST   /api/tags/:id/merge                       -> { ok, into_id, links_repointed }   { into_id }
//   GET    /api/entity-tags?entity_type=&entity_id=  -> { direct:Tag[], projected:Tag[] }
//   POST   /api/entity-tags                          -> { id } (201|200)  { tag_id, entity_type, entity_id }
//   DELETE /api/entity-tags/:id                      -> { ok:true }       (detach by entity_tag surrogate id)
//
// Tag: { id, facet, label, slug, source, owner_id, visibility, created_by, created_at, updated_at }
// NOTE: the entity-tags GET returns tag rows (t.*), not the entity_tag link id; detachTag therefore
// takes the entity_tag surrogate id, which the render surface (PLANTINGUI) must source — tracked gap.

import { useState, useEffect, useCallback, useRef } from 'react'
import { useApiFetch } from '../lib/api.js'

const tagsEnabled = () => Boolean(import.meta.env.VITE_API_TAGS)
const DISABLED = { error: 'Tags API not configured' }

export function useTags(initial = {}) {
  const { fetch } = useApiFetch()
  const [tags, setTags] = useState([])
  const [loading, setLoading] = useState(() => tagsEnabled())
  const [error, setError] = useState(null)
  const loadCounterRef = useRef(0)
  const facetRef = useRef(initial.facet ?? null)

  const reload = useCallback(async (facet = facetRef.current, q = null) => {
    if (!tagsEnabled()) { setTags([]); setLoading(false); setError(null); return }
    facetRef.current = facet ?? null
    const my = ++loadCounterRef.current
    setLoading(true); setError(null)
    try {
      const params = new URLSearchParams()
      if (facet) params.set('facet', facet)
      if (q) params.set('q', q)
      const qs = params.toString()
      const data = await fetch(`/api/tags${qs ? `?${qs}` : ''}`)
      if (loadCounterRef.current !== my) return
      setTags(Array.isArray(data) ? data : [])
    } catch (err) {
      if (loadCounterRef.current !== my) return
      setError(err?.message ?? 'Failed to load tags')
    } finally {
      if (loadCounterRef.current === my) setLoading(false)
    }
  }, [fetch])

  useEffect(() => { reload() }, [reload])

  const search = useCallback((q) => reload(facetRef.current, q), [reload])
  const filterByFacet = useCallback((facet) => reload(facet, null), [reload])

  const createTag = useCallback(async (payload) => {
    if (!tagsEnabled()) return DISABLED
    try {
      const created = await fetch('/api/tags', { method: 'POST', body: JSON.stringify(payload) })
      // Revive-or-insert may return an existing live row (200) — de-dupe by id.
      setTags(prev => prev.some(t => t.id === created.id)
        ? prev.map(t => (t.id === created.id ? created : t))
        : [created, ...prev])
      return { tag: created }
    } catch (err) {
      return { error: err?.message ?? 'Failed to create tag' }
    }
  }, [fetch])

  const updateTag = useCallback(async (id, payload) => {
    if (!tagsEnabled()) return DISABLED
    try {
      const updated = await fetch(`/api/tags/${id}`, { method: 'PATCH', body: JSON.stringify(payload) })
      setTags(prev => prev.map(t => (t.id === id ? updated : t)))
      return { tag: updated }
    } catch (err) {
      return { error: err?.message ?? 'Failed to update tag' }
    }
  }, [fetch])

  const deleteTag = useCallback(async (id) => {
    if (!tagsEnabled()) return DISABLED
    try {
      await fetch(`/api/tags/${id}`, { method: 'DELETE' })
      setTags(prev => prev.filter(t => t.id !== id))
      return { ok: true }
    } catch (err) {
      return { error: err?.message ?? 'Failed to delete tag' }
    }
  }, [fetch])

  const mergeTags = useCallback(async (fromId, intoId) => {
    if (!tagsEnabled()) return DISABLED
    try {
      const res = await fetch(`/api/tags/${fromId}/merge`, {
        method: 'POST', body: JSON.stringify({ into_id: intoId }),
      })
      setTags(prev => prev.filter(t => t.id !== fromId))
      return res
    } catch (err) {
      return { error: err?.message ?? 'Failed to merge tags' }
    }
  }, [fetch])

  return { tags, loading, error, reload, search, filterByFacet, createTag, updateTag, deleteTag, mergeTags }
}

export function useEntityTags(entityType, entityId) {
  const { fetch } = useApiFetch()
  const [direct, setDirect] = useState([])
  const [projected, setProjected] = useState([])
  const [loading, setLoading] = useState(() => tagsEnabled() && Boolean(entityType) && Boolean(entityId))
  const [error, setError] = useState(null)
  const loadCounterRef = useRef(0)

  const active = tagsEnabled() && Boolean(entityType) && Boolean(entityId)

  const reload = useCallback(async () => {
    if (!tagsEnabled() || !entityType || !entityId) {
      setDirect([]); setProjected([]); setLoading(false); setError(null); return
    }
    const my = ++loadCounterRef.current
    setLoading(true); setError(null)
    try {
      const params = new URLSearchParams({ entity_type: entityType, entity_id: entityId })
      const data = await fetch(`/api/entity-tags?${params.toString()}`)
      if (loadCounterRef.current !== my) return
      setDirect(Array.isArray(data?.direct) ? data.direct : [])
      setProjected(Array.isArray(data?.projected) ? data.projected : [])
    } catch (err) {
      if (loadCounterRef.current !== my) return
      setError(err?.message ?? 'Failed to load entity tags')
    } finally {
      if (loadCounterRef.current === my) setLoading(false)
    }
  }, [fetch, entityType, entityId])

  useEffect(() => { reload() }, [reload])

  const attachTag = useCallback(async (tagId) => {
    if (!active) return DISABLED
    try {
      const res = await fetch('/api/entity-tags', {
        method: 'POST',
        body: JSON.stringify({ tag_id: tagId, entity_type: entityType, entity_id: entityId }),
      })
      await reload()
      return { id: res?.id }
    } catch (err) {
      return { error: err?.message ?? 'Failed to attach tag' }
    }
  }, [fetch, active, entityType, entityId, reload])

  const detachTag = useCallback(async (entityTagId) => {
    if (!active) return DISABLED
    try {
      await fetch(`/api/entity-tags/${entityTagId}`, { method: 'DELETE' })
      await reload()
      return { ok: true }
    } catch (err) {
      return { error: err?.message ?? 'Failed to detach tag' }
    }
  }, [fetch, active, reload])

  return { direct, projected, loading, error, reload, attachTag, detachTag }
}
