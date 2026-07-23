import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))

import { useHarvests } from '../hooks/useHarvests.js'

beforeEach(() => fetchSpy.mockReset())

describe('useHarvests', () => {
  it('loads entries + aggregates and requests include=entries,aggregates', async () => {
    fetchSpy.mockResolvedValue({ entries: [{ event_id: 'a', day_key: '2026-07-20' }], aggregates: { crops: [] }, cursor: null })
    const { result } = renderHook(() => useHarvests())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.entries).toHaveLength(1)
    expect(result.current.aggregates).toEqual({ crops: [] })
    expect(result.current.hasMore).toBe(false)
    expect(fetchSpy.mock.calls[0][0]).toContain('include=entries%2Caggregates')
  })

  it('surfaces a friendly error on failure and clears the feed', async () => {
    fetchSpy.mockRejectedValueOnce(Object.assign(new Error('boom'), { body: { message: 'nope' } }))
    const { result } = renderHook(() => useHarvests())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe('nope')
    expect(result.current.entries).toEqual([])
  })

  it('includes timeframe + crop + project filters in the query', async () => {
    fetchSpy.mockResolvedValue({ entries: [], aggregates: null, cursor: null })
    const { result } = renderHook(() => useHarvests({ timeframe: '7d', crop: 'tomato', project: 'pr1' }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    const url = fetchSpy.mock.calls[0][0]
    expect(url).toContain('timeframe=7d')
    expect(url).toContain('crop=tomato')
    expect(url).toContain('project=pr1')
  })

  it('loadMore appends the next page and advances the cursor', async () => {
    fetchSpy
      .mockResolvedValueOnce({ entries: [{ event_id: 'a' }], aggregates: null, cursor: 'CUR1' })
      .mockResolvedValueOnce({ entries: [{ event_id: 'b' }], aggregates: null, cursor: null })
    const { result } = renderHook(() => useHarvests())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.hasMore).toBe(true)
    await act(async () => { await result.current.loadMore() })
    expect(result.current.entries.map((e) => e.event_id)).toEqual(['a', 'b'])
    expect(result.current.hasMore).toBe(false)
    expect(fetchSpy.mock.calls[1][0]).toContain('cursor=CUR1')
  })
})
