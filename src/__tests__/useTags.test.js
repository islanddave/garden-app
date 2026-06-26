/**
 * src/__tests__/useTags.test.js
 * Unit tests for useTags + useEntityTags (V4-TAGSUB-001 frontend wire).
 *
 * Strategy mirrors useVarieties.test.js: mock useApiFetch from src/lib/api.js so tests run
 * with no network / no Clerk dep. The VITE_API_TAGS env guard is controlled with vi.stubEnv —
 * enabled by default in these suites, with a dedicated "disabled" suite that leaves it unset.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy }),
}))

import { useTags, useEntityTags } from '../hooks/useTags.js'

const TAG = {
  id: 'tag-1', facet: 'group', label: 'Salsa Garden', slug: 'salsa-garden',
  source: 'user', owner_id: 'user_test', visibility: 'shared',
  created_by: 'user_test', created_at: '2026-06-26T00:00:00Z', updated_at: '2026-06-26T00:00:00Z',
}
const TAG2 = { ...TAG, id: 'tag-2', label: 'Peppers', slug: 'peppers' }
const DERIVED = { ...TAG, id: 'tag-3', facet: 'type', label: 'type:pepper', slug: 'type-pepper', source: 'derived', owner_id: 'system' }

beforeEach(() => {
  fetchSpy.mockReset()
  vi.stubEnv('VITE_API_TAGS', 'https://test-tags.lambda/')
})
afterEach(() => { vi.unstubAllEnvs() })

// ── useTags: load / search / facet ─────────────────────────────────────────────
describe('useTags — load', () => {
  it('loads tags on mount and calls /api/tags', async () => {
    fetchSpy.mockResolvedValueOnce([TAG, TAG2])
    const { result } = renderHook(() => useTags())
    expect(result.current.loading).toBe(true)
    expect(result.current.tags).toEqual([])
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.tags).toHaveLength(2)
    expect(result.current.error).toBeNull()
    expect(fetchSpy).toHaveBeenCalledWith('/api/tags')
  })

  it('sets error on load failure', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('network down'))
    const { result } = renderHook(() => useTags())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe('network down')
    expect(result.current.tags).toEqual([])
  })

  it('falls back to generic message when error has no message', async () => {
    fetchSpy.mockRejectedValueOnce({})
    const { result } = renderHook(() => useTags())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe('Failed to load tags')
  })

  it('handles non-array response gracefully', async () => {
    fetchSpy.mockResolvedValueOnce(null)
    const { result } = renderHook(() => useTags())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.tags).toEqual([])
  })

  it('initial facet is sent on first load', async () => {
    fetchSpy.mockResolvedValueOnce([TAG])
    const { result } = renderHook(() => useTags({ facet: 'group' }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(fetchSpy).toHaveBeenCalledWith('/api/tags?facet=group')
  })
})

describe('useTags — search & facet', () => {
  it('search issues ?q= and preserves current facet', async () => {
    fetchSpy.mockResolvedValueOnce([TAG, TAG2])
    const { result } = renderHook(() => useTags({ facet: 'group' }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    fetchSpy.mockResolvedValueOnce([TAG2])
    await act(async () => { await result.current.search('pep') })
    const last = fetchSpy.mock.calls.at(-1)[0]
    expect(last).toBe('/api/tags?facet=group&q=pep')
    expect(result.current.tags).toEqual([TAG2])
  })

  it('filterByFacet switches facet and clears q', async () => {
    fetchSpy.mockResolvedValueOnce([TAG])
    const { result } = renderHook(() => useTags())
    await waitFor(() => expect(result.current.loading).toBe(false))
    fetchSpy.mockResolvedValueOnce([DERIVED])
    await act(async () => { await result.current.filterByFacet('type') })
    expect(fetchSpy.mock.calls.at(-1)[0]).toBe('/api/tags?facet=type')
  })

  it('URL-encodes special characters in q', async () => {
    fetchSpy.mockResolvedValueOnce([])
    const { result } = renderHook(() => useTags())
    await waitFor(() => expect(result.current.loading).toBe(false))
    fetchSpy.mockResolvedValueOnce([])
    await act(async () => { await result.current.search('a & b') })
    expect(fetchSpy.mock.calls.at(-1)[0]).toBe('/api/tags?q=a+%26+b')
  })
})

// ── useTags: mutations ─────────────────────────────────────────────────────────
describe('useTags — createTag', () => {
  it('POSTs and prepends a new tag', async () => {
    fetchSpy.mockResolvedValueOnce([TAG])
    const { result } = renderHook(() => useTags())
    await waitFor(() => expect(result.current.loading).toBe(false))
    fetchSpy.mockResolvedValueOnce(TAG2)
    let res
    await act(async () => { res = await result.current.createTag({ facet: 'group', label: 'Peppers' }) })
    expect(res).toEqual({ tag: TAG2 })
    expect(result.current.tags[0].id).toBe('tag-2')
    expect(result.current.tags).toHaveLength(2)
    const call = fetchSpy.mock.calls.at(-1)
    expect(call[0]).toBe('/api/tags')
    expect(call[1].method).toBe('POST')
    expect(JSON.parse(call[1].body)).toEqual({ facet: 'group', label: 'Peppers' })
  })

  it('de-dupes when revive-or-insert returns an existing live row', async () => {
    fetchSpy.mockResolvedValueOnce([TAG])
    const { result } = renderHook(() => useTags())
    await waitFor(() => expect(result.current.loading).toBe(false))
    fetchSpy.mockResolvedValueOnce({ ...TAG, label: 'Salsa Garden' })
    await act(async () => { await result.current.createTag({ facet: 'group', label: 'Salsa Garden' }) })
    expect(result.current.tags).toHaveLength(1)
    expect(result.current.tags[0].id).toBe('tag-1')
  })

  it('returns { error } on create failure', async () => {
    fetchSpy.mockResolvedValueOnce([])
    const { result } = renderHook(() => useTags())
    await waitFor(() => expect(result.current.loading).toBe(false))
    fetchSpy.mockRejectedValueOnce(new Error('Rate limit exceeded'))
    let res
    await act(async () => { res = await result.current.createTag({ facet: 'group', label: 'x' }) })
    expect(res).toEqual({ error: 'Rate limit exceeded' })
  })
})

describe('useTags — updateTag', () => {
  it('PATCHes and replaces in list', async () => {
    fetchSpy.mockResolvedValueOnce([TAG])
    const { result } = renderHook(() => useTags())
    await waitFor(() => expect(result.current.loading).toBe(false))
    const updated = { ...TAG, label: 'Salsa', slug: 'salsa' }
    fetchSpy.mockResolvedValueOnce(updated)
    let res
    await act(async () => { res = await result.current.updateTag('tag-1', { label: 'Salsa' }) })
    expect(res).toEqual({ tag: updated })
    expect(result.current.tags[0].label).toBe('Salsa')
    const call = fetchSpy.mock.calls.at(-1)
    expect(call[0]).toBe('/api/tags/tag-1')
    expect(call[1].method).toBe('PATCH')
  })

  it('returns error on PATCH failure without mutating list', async () => {
    fetchSpy.mockResolvedValueOnce([TAG])
    const { result } = renderHook(() => useTags())
    await waitFor(() => expect(result.current.loading).toBe(false))
    fetchSpy.mockRejectedValueOnce(new Error('404 Not Found'))
    let res
    await act(async () => { res = await result.current.updateTag('tag-1', { label: 'X' }) })
    expect(res).toEqual({ error: '404 Not Found' })
    expect(result.current.tags[0].label).toBe('Salsa Garden')
  })
})

describe('useTags — deleteTag & mergeTags', () => {
  it('DELETEs and removes from list', async () => {
    fetchSpy.mockResolvedValueOnce([TAG, TAG2])
    const { result } = renderHook(() => useTags())
    await waitFor(() => expect(result.current.loading).toBe(false))
    fetchSpy.mockResolvedValueOnce({ ok: true })
    let res
    await act(async () => { res = await result.current.deleteTag('tag-1') })
    expect(res).toEqual({ ok: true })
    expect(result.current.tags).toHaveLength(1)
    expect(result.current.tags[0].id).toBe('tag-2')
    const call = fetchSpy.mock.calls.at(-1)
    expect(call[0]).toBe('/api/tags/tag-1')
    expect(call[1].method).toBe('DELETE')
  })

  it('mergeTags POSTs to :id/merge and drops the merged-away tag', async () => {
    fetchSpy.mockResolvedValueOnce([TAG, TAG2])
    const { result } = renderHook(() => useTags())
    await waitFor(() => expect(result.current.loading).toBe(false))
    fetchSpy.mockResolvedValueOnce({ ok: true, into_id: 'tag-2', links_repointed: 3 })
    let res
    await act(async () => { res = await result.current.mergeTags('tag-1', 'tag-2') })
    expect(res).toEqual({ ok: true, into_id: 'tag-2', links_repointed: 3 })
    expect(result.current.tags.map(t => t.id)).toEqual(['tag-2'])
    const call = fetchSpy.mock.calls.at(-1)
    expect(call[0]).toBe('/api/tags/tag-1/merge')
    expect(JSON.parse(call[1].body)).toEqual({ into_id: 'tag-2' })
  })
})

// ── useTags: disabled (no VITE_API_TAGS) ────────────────────────────────────────
describe('useTags — disabled when VITE_API_TAGS unset', () => {
  beforeEach(() => { vi.stubEnv('VITE_API_TAGS', '') })
  it('never fetches, resolves empty + not loading', async () => {
    const { result } = renderHook(() => useTags())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.tags).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })
  it('mutations return the not-configured error', async () => {
    const { result } = renderHook(() => useTags())
    await waitFor(() => expect(result.current.loading).toBe(false))
    let c, u, d, m
    await act(async () => {
      c = await result.current.createTag({ facet: 'group', label: 'x' })
      u = await result.current.updateTag('tag-1', { label: 'x' })
      d = await result.current.deleteTag('tag-1')
      m = await result.current.mergeTags('tag-1', 'tag-2')
    })
    expect(c).toEqual({ error: 'Tags API not configured' })
    expect(u).toEqual({ error: 'Tags API not configured' })
    expect(d).toEqual({ error: 'Tags API not configured' })
    expect(m).toEqual({ error: 'Tags API not configured' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

// ── useEntityTags ───────────────────────────────────────────────────────────────
describe('useEntityTags', () => {
  it('loads direct + projected for an entity', async () => {
    fetchSpy.mockResolvedValueOnce({ direct: [TAG], projected: [DERIVED] })
    const { result } = renderHook(() => useEntityTags('plant', 'gn-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.direct).toEqual([TAG])
    expect(result.current.projected).toEqual([DERIVED])
    expect(fetchSpy).toHaveBeenCalledWith('/api/entity-tags?entity_type=plant&entity_id=gn-1')
  })

  it('is inert when entityId is missing', async () => {
    const { result } = renderHook(() => useEntityTags('plant', null))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.direct).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('attachTag POSTs then reloads', async () => {
    fetchSpy.mockResolvedValueOnce({ direct: [], projected: [] })
    const { result } = renderHook(() => useEntityTags('cultivar', 'cv-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    fetchSpy.mockResolvedValueOnce({ id: 'et-9' })          // POST
    fetchSpy.mockResolvedValueOnce({ direct: [TAG], projected: [] }) // reload
    let res
    await act(async () => { res = await result.current.attachTag('tag-1') })
    expect(res).toEqual({ id: 'et-9' })
    const post = fetchSpy.mock.calls.find(c => c[0] === '/api/entity-tags' && c[1]?.method === 'POST')
    expect(JSON.parse(post[1].body)).toEqual({ tag_id: 'tag-1', entity_type: 'cultivar', entity_id: 'cv-1' })
    await waitFor(() => expect(result.current.direct).toEqual([TAG]))
  })

  it('detachTag DELETEs by entity_tag id then reloads', async () => {
    fetchSpy.mockResolvedValueOnce({ direct: [TAG], projected: [] })
    const { result } = renderHook(() => useEntityTags('cultivar', 'cv-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    fetchSpy.mockResolvedValueOnce({ ok: true })            // DELETE
    fetchSpy.mockResolvedValueOnce({ direct: [], projected: [] }) // reload
    let res
    await act(async () => { res = await result.current.detachTag('et-9') })
    expect(res).toEqual({ ok: true })
    const del = fetchSpy.mock.calls.find(c => c[0] === '/api/entity-tags/et-9')
    expect(del[1].method).toBe('DELETE')
  })
})
