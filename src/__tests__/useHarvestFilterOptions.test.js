import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))

import { useHarvestFilterOptions } from '../hooks/useHarvestFilterOptions.js'

beforeEach(() => fetchSpy.mockReset())

describe('useHarvestFilterOptions', () => {
  it('reads the UNFILTERED crop universe and returns name-sorted projects', async () => {
    fetchSpy.mockImplementation((url) => {
      if (url === '/api/projects') {
        return Promise.resolve([{ id: 'p2', name: 'Zinnia Bed' }, { id: 'p1', name: 'Alpha Bed' }])
      }
      return Promise.resolve({ aggregates: { crop_list: [{ crop_type_slug: 'tomato', display_name: 'Tomato' }] } })
    })
    const { result } = renderHook(() => useHarvestFilterOptions())
    await waitFor(() => expect(result.current.projects.length).toBe(2))

    expect(result.current.crops).toEqual([{ crop_type_slug: 'tomato', display_name: 'Tomato' }])
    // the crop-options call must be unfiltered (aggregates only, no crop=/project=, no entries payload)
    const cropCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes('include=aggregates'))
    expect(cropCall[0]).not.toContain('crop=')
    expect(cropCall[0]).not.toContain('project=')
    expect(cropCall[0]).not.toContain('entries')
    // projects sorted by display name (Alpha before Zinnia)
    expect(result.current.projects.map((p) => p.id)).toEqual(['p1', 'p2'])
  })

  it('leaves both lists empty when the calls fail (never blocks the page)', async () => {
    // two single-shot rejections (persistent mockRejectedValue trips vitest unhandled-rejection)
    fetchSpy.mockRejectedValueOnce(new Error('down')).mockRejectedValueOnce(new Error('down'))
    const { result } = renderHook(() => useHarvestFilterOptions())
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2))
    expect(result.current.crops).toEqual([])
    expect(result.current.projects).toEqual([])
  })
})
