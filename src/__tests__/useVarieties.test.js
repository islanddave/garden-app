/**
 * src/__tests__/useVarieties.test.js
 * Unit tests for useVarieties hook — covers load, search, createVariety
 * (incl. 409 fuzzy-match disambiguation + allowDuplicate override), updateVariety,
 * deleteVariety, reload, and stale-load race protection.
 *
 * Strategy mirrors useInventory.test.js: mock useApiFetch from src/lib/api.js so
 * tests run with no network, no Clerk dep. Each test gets a fresh fetch spy with
 * controllable responses.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy }),
}))

import { useVarieties } from '../hooks/useVarieties.js'

const SAMPLE_VARIETY = {
  id: 'var-1',
  name: 'Black Krim',
  species: 'Solanum lycopersicum',
  common_name: 'tomato',
  source: 'Baker Creek',
  notes: null,
  created_by: 'user_test',
  user_id: 'user_test',
  deleted_at: null,
}

const SAMPLE_VARIETY_2 = {
  ...SAMPLE_VARIETY,
  id: 'var-2',
  name: 'Cherokee Purple',
}

beforeEach(() => {
  fetchSpy.mockReset()
})

// ── Load ─────────────────────────────────────────────────────────────────────
describe('useVarieties — load', () => {
  it('starts in loading state and populates varieties on mount', async () => {
    fetchSpy.mockResolvedValueOnce([SAMPLE_VARIETY, SAMPLE_VARIETY_2])
    const { result } = renderHook(() => useVarieties())

    expect(result.current.loading).toBe(true)
    expect(result.current.varieties).toEqual([])

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.varieties).toHaveLength(2)
    expect(result.current.error).toBeNull()
    expect(fetchSpy).toHaveBeenCalledWith('/api/varieties')
  })

  it('sets error on load failure', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('network down'))
    const { result } = renderHook(() => useVarieties())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe('network down')
    expect(result.current.varieties).toEqual([])
  })

  it('falls back to generic message when error has no message', async () => {
    fetchSpy.mockRejectedValueOnce({})
    const { result } = renderHook(() => useVarieties())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe('Failed to load varieties')
  })

  it('handles non-array response gracefully', async () => {
    fetchSpy.mockResolvedValueOnce(null)
    const { result } = renderHook(() => useVarieties())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.varieties).toEqual([])
  })

  it('reload re-fetches the list', async () => {
    fetchSpy.mockResolvedValueOnce([SAMPLE_VARIETY])
    const { result } = renderHook(() => useVarieties())
    await waitFor(() => expect(result.current.loading).toBe(false))

    fetchSpy.mockResolvedValueOnce([SAMPLE_VARIETY, SAMPLE_VARIETY_2])
    await act(async () => { await result.current.reload() })
    expect(result.current.varieties).toHaveLength(2)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})

// ── Search ───────────────────────────────────────────────────────────────────
describe('useVarieties — search', () => {
  it('issues GET with q= when search called with non-empty string', async () => {
    fetchSpy.mockResolvedValueOnce([SAMPLE_VARIETY, SAMPLE_VARIETY_2])
    const { result } = renderHook(() => useVarieties())
    await waitFor(() => expect(result.current.loading).toBe(false))

    fetchSpy.mockResolvedValueOnce([SAMPLE_VARIETY])
    await act(async () => { await result.current.search('Krim') })

    const lastCall = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1]
    expect(lastCall[0]).toBe('/api/varieties?q=Krim')
    expect(result.current.varieties).toHaveLength(1)
  })

  it('URL-encodes query strings with special characters', async () => {
    fetchSpy.mockResolvedValueOnce([])
    const { result } = renderHook(() => useVarieties())
    await waitFor(() => expect(result.current.loading).toBe(false))

    fetchSpy.mockResolvedValueOnce([])
    await act(async () => { await result.current.search('a & b') })
    const lastCall = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1]
    expect(lastCall[0]).toBe('/api/varieties?q=a%20%26%20b')
  })

  it('search(null) lists all', async () => {
    fetchSpy.mockResolvedValueOnce([SAMPLE_VARIETY])
    const { result } = renderHook(() => useVarieties())
    await waitFor(() => expect(result.current.loading).toBe(false))

    fetchSpy.mockResolvedValueOnce([SAMPLE_VARIETY, SAMPLE_VARIETY_2])
    await act(async () => { await result.current.search(null) })
    const lastCall = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1]
    expect(lastCall[0]).toBe('/api/varieties')
  })

  it('stale search responses are discarded (race protection)', async () => {
    fetchSpy.mockResolvedValueOnce([SAMPLE_VARIETY])
    const { result } = renderHook(() => useVarieties())
    await waitFor(() => expect(result.current.loading).toBe(false))

    // Fire two searches; resolve them out of order — older second.
    let resolveOld, resolveNew
    fetchSpy.mockImplementationOnce(() => new Promise(r => { resolveOld = r }))
    fetchSpy.mockImplementationOnce(() => new Promise(r => { resolveNew = r }))

    let oldPromise, newPromise
    act(() => { oldPromise = result.current.search('old') })
    act(() => { newPromise = result.current.search('new') })

    await act(async () => {
      resolveNew([SAMPLE_VARIETY_2])
      await newPromise
      resolveOld([SAMPLE_VARIETY])
      await oldPromise
    })

    // newest (resolved second-to-last but counter-most-recent) wins
    expect(result.current.varieties).toEqual([SAMPLE_VARIETY_2])
  })
})

// ── createVariety ────────────────────────────────────────────────────────────
describe('useVarieties — createVariety', () => {
  it('POSTs to /api/varieties and prepends the result', async () => {
    fetchSpy.mockResolvedValueOnce([SAMPLE_VARIETY])
    const { result } = renderHook(() => useVarieties())
    await waitFor(() => expect(result.current.loading).toBe(false))

    const newVariety = { ...SAMPLE_VARIETY_2 }
    fetchSpy.mockResolvedValueOnce(newVariety)

    let res
    await act(async () => {
      res = await result.current.createVariety({
        name: 'Cherokee Purple',
        species: 'Solanum lycopersicum',
      })
    })
    expect(res).toEqual({ variety: newVariety })
    expect(result.current.varieties[0].id).toBe('var-2')
    expect(result.current.varieties).toHaveLength(2)

    const call = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1]
    expect(call[0]).toBe('/api/varieties')
    expect(call[1].method).toBe('POST')
    const body = JSON.parse(call[1].body)
    expect(body.name).toBe('Cherokee Purple')
    expect(body.allow_duplicate).toBeUndefined()
  })

  it('sets allow_duplicate=true when opts.allowDuplicate passed', async () => {
    fetchSpy.mockResolvedValueOnce([])
    const { result } = renderHook(() => useVarieties())
    await waitFor(() => expect(result.current.loading).toBe(false))

    fetchSpy.mockResolvedValueOnce(SAMPLE_VARIETY)
    await act(async () => {
      await result.current.createVariety(
        { name: 'Black Krim', species: 'Solanum lycopersicum' },
        { allowDuplicate: true }
      )
    })
    const call = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1]
    const body = JSON.parse(call[1].body)
    expect(body.allow_duplicate).toBe(true)
    expect(body.name).toBe('Black Krim')
  })

  it('returns { error, existing } when server returns 409 with existing variety', async () => {
    fetchSpy.mockResolvedValueOnce([])
    const { result } = renderHook(() => useVarieties())
    await waitFor(() => expect(result.current.loading).toBe(false))

    const conflictErr = new Error('Variety already exists')
    conflictErr.status = 409
    conflictErr.body = { error: 'Variety already exists', existing: SAMPLE_VARIETY }
    fetchSpy.mockRejectedValueOnce(conflictErr)

    let res
    await act(async () => {
      res = await result.current.createVariety({ name: 'Black Krim' })
    })
    expect(res.error).toBe('Variety already exists')
    expect(res.existing).toEqual(SAMPLE_VARIETY)
    expect(result.current.varieties).toEqual([])
  })

  it('returns { error, existing: null } on generic create failure', async () => {
    fetchSpy.mockResolvedValueOnce([])
    const { result } = renderHook(() => useVarieties())
    await waitFor(() => expect(result.current.loading).toBe(false))

    fetchSpy.mockRejectedValueOnce(new Error('400 Bad Request'))
    let res
    await act(async () => { res = await result.current.createVariety({ name: '' }) })
    expect(res.error).toBe('400 Bad Request')
    expect(res.existing).toBeNull()
  })

  it('uses generic message when error has no message', async () => {
    fetchSpy.mockResolvedValueOnce([])
    const { result } = renderHook(() => useVarieties())
    await waitFor(() => expect(result.current.loading).toBe(false))

    fetchSpy.mockRejectedValueOnce({})
    let res
    await act(async () => { res = await result.current.createVariety({ name: 'x' }) })
    expect(res.error).toBe('Failed to create variety')
  })
})

// ── updateVariety ────────────────────────────────────────────────────────────
describe('useVarieties — updateVariety', () => {
  it('PUTs to /api/varieties/:id and replaces in list', async () => {
    fetchSpy.mockResolvedValueOnce([SAMPLE_VARIETY])
    const { result } = renderHook(() => useVarieties())
    await waitFor(() => expect(result.current.loading).toBe(false))

    const updated = { ...SAMPLE_VARIETY, notes: 'Heirloom from grandma' }
    fetchSpy.mockResolvedValueOnce(updated)

    let res
    await act(async () => {
      res = await result.current.updateVariety('var-1', { notes: 'Heirloom from grandma' })
    })
    expect(res).toEqual({ variety: updated })
    expect(result.current.varieties[0].notes).toBe('Heirloom from grandma')

    const call = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1]
    expect(call[0]).toBe('/api/varieties/var-1')
    expect(call[1].method).toBe('PUT')
  })

  it('returns error on PUT failure without mutating list', async () => {
    fetchSpy.mockResolvedValueOnce([SAMPLE_VARIETY])
    const { result } = renderHook(() => useVarieties())
    await waitFor(() => expect(result.current.loading).toBe(false))

    fetchSpy.mockRejectedValueOnce(new Error('409 Conflict'))
    let res
    await act(async () => {
      res = await result.current.updateVariety('var-1', { name: 'X' })
    })
    expect(res).toEqual({ error: '409 Conflict' })
    expect(result.current.varieties[0].name).toBe('Black Krim')
  })
})

// ── deleteVariety ────────────────────────────────────────────────────────────
describe('useVarieties — deleteVariety', () => {
  it('DELETEs and removes variety from list', async () => {
    fetchSpy.mockResolvedValueOnce([SAMPLE_VARIETY, SAMPLE_VARIETY_2])
    const { result } = renderHook(() => useVarieties())
    await waitFor(() => expect(result.current.loading).toBe(false))

    fetchSpy.mockResolvedValueOnce({ ok: true })
    let res
    await act(async () => { res = await result.current.deleteVariety('var-1') })
    expect(res).toEqual({ ok: true })
    expect(result.current.varieties).toHaveLength(1)
    expect(result.current.varieties[0].id).toBe('var-2')

    const call = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1]
    expect(call[0]).toBe('/api/varieties/var-1')
    expect(call[1].method).toBe('DELETE')
  })

  it('returns error on DELETE failure without modifying list', async () => {
    fetchSpy.mockResolvedValueOnce([SAMPLE_VARIETY])
    const { result } = renderHook(() => useVarieties())
    await waitFor(() => expect(result.current.loading).toBe(false))

    fetchSpy.mockRejectedValueOnce(new Error('404 Not Found'))
    let res
    await act(async () => { res = await result.current.deleteVariety('var-1') })
    expect(res).toEqual({ error: '404 Not Found' })
    expect(result.current.varieties).toHaveLength(1)
  })
})
