/**
 * src/__tests__/useInactiveProjects.test.js
 * Unit tests for the useInactiveProjects hook (V1.2a-2 S3 W4).
 * Covers: initial load, stable refetch/dismiss references, optimistic dismiss +
 * POST, revert on POST error, and the concurrent-refetch-vs-in-flight-dismiss
 * stale-response guard.
 *
 * Strategy mirrors useVarieties.test.js: mock useApiFetch from src/lib/api.js so
 * tests run with no network and no Clerk dependency.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy }),
}))

import { useInactiveProjects } from '../hooks/useInactiveProjects.js'

const PROJ_A = {
  id: 'p-a',
  name: 'Black Krim',
  variety: 'tomato',
  status: 'growing',
  start_date: '2026-03-01',
  last_event_at: '2026-04-20T12:00:00.000Z',
  last_harvested_at: null,
  dismissed: false,
  dismissed_at: null,
}

const PROJ_B = {
  ...PROJ_A,
  id: 'p-b',
  name: 'Cherokee Purple',
  last_event_at: '2026-04-10T12:00:00.000Z',
}

beforeEach(() => {
  fetchSpy.mockReset()
})

describe('useInactiveProjects — load', () => {
  it('starts loading and populates projects on mount', async () => {
    fetchSpy.mockResolvedValueOnce([PROJ_A, PROJ_B])
    const { result } = renderHook(() => useInactiveProjects())

    expect(result.current.loading).toBe(true)
    expect(result.current.projects).toEqual([])

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.projects).toHaveLength(2)
    expect(result.current.error).toBeNull()
    expect(fetchSpy).toHaveBeenCalledWith('/api/projects/inactive')
  })

  it('sets error on load failure', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('network down'))
    const { result } = renderHook(() => useInactiveProjects())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe('network down')
    expect(result.current.projects).toEqual([])
  })

  it('handles non-array response gracefully', async () => {
    fetchSpy.mockResolvedValueOnce(null)
    const { result } = renderHook(() => useInactiveProjects())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.projects).toEqual([])
  })

  it('refetch re-fetches the list', async () => {
    fetchSpy.mockResolvedValueOnce([PROJ_A])
    const { result } = renderHook(() => useInactiveProjects())
    await waitFor(() => expect(result.current.loading).toBe(false))

    fetchSpy.mockResolvedValueOnce([PROJ_A, PROJ_B])
    await act(async () => { await result.current.refetch() })
    expect(result.current.projects).toHaveLength(2)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})

describe('useInactiveProjects — stable references', () => {
  it('refetch and dismiss keep stable identities across a re-render', async () => {
    fetchSpy.mockResolvedValue([PROJ_A])
    const { result, rerender } = renderHook(() => useInactiveProjects())
    await waitFor(() => expect(result.current.loading).toBe(false))

    const refetchBefore = result.current.refetch
    const dismissBefore = result.current.dismiss

    rerender()

    expect(result.current.refetch).toBe(refetchBefore)
    expect(result.current.dismiss).toBe(dismissBefore)
  })
})

describe('useInactiveProjects — dismiss', () => {
  it('optimistically marks dismissed then POSTs and reconciles dismissed_at', async () => {
    fetchSpy.mockResolvedValueOnce([PROJ_A, PROJ_B])
    const { result } = renderHook(() => useInactiveProjects())
    await waitFor(() => expect(result.current.loading).toBe(false))

    const serverAt = '2026-05-14T09:00:00.000Z'
    fetchSpy.mockResolvedValueOnce({ dismissed: true, dismissed_at: serverAt })

    let res
    await act(async () => { res = await result.current.dismiss('p-a') })

    expect(res).toEqual({ ok: true })
    const row = result.current.projects.find(p => p.id === 'p-a')
    expect(row.dismissed).toBe(true)
    expect(row.dismissed_at).toBe(serverAt)
    // Position preserved — p-a still first.
    expect(result.current.projects[0].id).toBe('p-a')

    const call = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1]
    expect(call[0]).toBe('/api/projects/inactive/p-a/dismiss')
    expect(call[1].method).toBe('POST')
  })

  it('reverts state on POST error, preserving original row position', async () => {
    fetchSpy.mockResolvedValueOnce([PROJ_A, PROJ_B])
    const { result } = renderHook(() => useInactiveProjects())
    await waitFor(() => expect(result.current.loading).toBe(false))

    fetchSpy.mockRejectedValueOnce(new Error('404 Not Found'))

    let res
    await act(async () => { res = await result.current.dismiss('p-a') })

    expect(res).toEqual({ error: '404 Not Found' })
    const row = result.current.projects.find(p => p.id === 'p-a')
    expect(row.dismissed).toBe(false)
    expect(row.dismissed_at).toBeNull()
    expect(result.current.projects[0].id).toBe('p-a')
  })

  it('a refetch concurrent with an in-flight dismiss does not clobber the optimistic dismiss', async () => {
    fetchSpy.mockResolvedValueOnce([PROJ_A, PROJ_B])
    const { result } = renderHook(() => useInactiveProjects())
    await waitFor(() => expect(result.current.loading).toBe(false))

    // Dismiss POST stays pending until we resolve it.
    let resolveDismiss
    fetchSpy.mockImplementationOnce(() => new Promise(r => { resolveDismiss = r }))

    let dismissPromise
    act(() => { dismissPromise = result.current.dismiss('p-a') })

    // Optimistic state applied.
    expect(result.current.projects.find(p => p.id === 'p-a').dismissed).toBe(true)

    // While dismiss is in flight, a refetch resolves with the server's stale
    // view (p-a still dismissed:false). The merge guard must keep our optimistic row.
    fetchSpy.mockResolvedValueOnce([PROJ_A, PROJ_B])
    await act(async () => { await result.current.refetch() })

    expect(result.current.projects.find(p => p.id === 'p-a').dismissed).toBe(true)

    // Now let the dismiss POST complete.
    await act(async () => {
      resolveDismiss({ dismissed: true, dismissed_at: '2026-05-14T09:00:00.000Z' })
      await dismissPromise
    })

    expect(result.current.projects.find(p => p.id === 'p-a').dismissed).toBe(true)
  })
})
