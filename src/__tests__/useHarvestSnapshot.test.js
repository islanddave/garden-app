import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))

import { useHarvestSnapshot } from '../hooks/useHarvestSnapshot.js'

beforeEach(() => fetchSpy.mockReset())

describe('useHarvestSnapshot', () => {
  it('fetches season-scoped and derives the snapshot', async () => {
    fetchSpy.mockResolvedValue({ entries: [{ event_id: 'a', day_key: '2026-07-20', crop_name: 'Kale' }], aggregates: { crop_list: [{}, {}] }, cursor: null })
    const { result } = renderHook(() => useHarvestSnapshot())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(fetchSpy.mock.calls[0][0]).toContain('timeframe=season:')
    expect(result.current.snapshot.seasonCropCount).toBe(2)
    expect(result.current.snapshot.lastHarvest.event_id).toBe('a')
  })

  it('leaves snapshot null on failure (ambient — never blocks the page)', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('down'))
    const { result } = renderHook(() => useHarvestSnapshot())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.snapshot).toBeNull()
  })
})
