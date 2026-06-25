import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
import { useCropTypes } from '../hooks/useCropTypes.js'

beforeEach(() => { fetchSpy.mockReset() })

describe('useCropTypes', () => {
  it('loads the vocab from /api/varieties/crop-types', async () => {
    const vocab = [{ slug: 'pepper', display_name: 'Pepper', default_lifecycle: 'tender_perennial', category: 'vegetable', sort_order: 0 }]
    fetchSpy.mockResolvedValueOnce(vocab)
    const { result } = renderHook(() => useCropTypes())
    await waitFor(() => expect(result.current.cropTypes.length).toBe(1))
    expect(result.current.cropTypes[0].slug).toBe('pepper')
    expect(fetchSpy).toHaveBeenCalledWith('/api/varieties/crop-types')
  })

  it('degrades to [] on fetch rejection', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('boom'))
    const { result } = renderHook(() => useCropTypes())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.cropTypes).toEqual([])
  })

  it('degrades to [] when the mock returns a non-Promise / undefined', async () => {
    fetchSpy.mockReturnValueOnce(undefined)
    const { result } = renderHook(() => useCropTypes())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.cropTypes).toEqual([])
  })
})
