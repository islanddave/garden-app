import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))

import { useHarvestSnapshot } from '../hooks/useHarvestSnapshot.js'

beforeEach(() => fetchSpy.mockReset())

// Two requests, one per WINDOW. BUG-HARVSNAPSHOT7D-001: the hook used to make one season-scoped
// request and filter its `entries` down to 7 days client-side — but `entries` is a 50-row page, so
// the tile read 50 against a true 163 and the crop phrase beside it came from ~3.5 days.
const bySpec = (season, last7) => (url) => Promise.resolve(String(url).includes('timeframe=7d') ? last7 : season)

describe('useHarvestSnapshot', () => {
  it('fetches season-scoped and derives the snapshot', async () => {
    fetchSpy.mockImplementation(bySpec(
      { entries: [{ event_id: 'a', day_key: '2026-07-20', crop_name: 'Kale' }], aggregates: { crop_list: [{}, {}] }, cursor: null },
      { aggregates: { crops: [], other: [] } },
    ))
    const { result } = renderHook(() => useHarvestSnapshot())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(fetchSpy.mock.calls.some(([u]) => u.includes('timeframe=season:'))).toBe(true)
    expect(result.current.snapshot.seasonCropCount).toBe(2)
    expect(result.current.snapshot.lastHarvest.event_id).toBe('a')
  })

  it('asks the SERVER for the 7-day window, and never drains a cursor for it', async () => {
    fetchSpy.mockImplementation(bySpec({ entries: [], aggregates: { crop_list: [] } }, { aggregates: { crops: [], other: [] } }))
    const { result } = renderHook(() => useHarvestSnapshot())
    await waitFor(() => expect(result.current.loading).toBe(false))
    const urls = fetchSpy.mock.calls.map(([u]) => u)
    expect(urls).toHaveLength(2)
    // The 7-day request takes the UNCAPPED half of the response. `include=entries` would reintroduce
    // the page, and a `cursor=` anywhere would mean the drain this fix exists to avoid.
    const window7 = urls.find((u) => u.includes('timeframe=7d'))
    expect(window7).toContain('include=aggregates')
    expect(window7).not.toContain('include=entries')
    expect(urls.every((u) => !u.includes('cursor='))).toBe(true)
  })

  it('THE REGRESSION: the 7-day count is the server aggregate, not the length of the entries page', async () => {
    // A full page of entries in hand (the shipped bug's exact shape: entries.length === PAGE_LIMIT)
    // against a window the server says holds 163 picks.
    const page = Array.from({ length: 50 }, (_, i) => ({ event_id: `e${i}`, day_key: '2026-08-17', crop_name: 'Tomato', crop_type_slug: 'tomato' }))
    fetchSpy.mockImplementation(bySpec(
      { entries: page, aggregates: { crop_list: [{}] }, cursor: 'more' },
      { aggregates: { crops: [{ crop_type_slug: 'tomato', crop_name: 'Tomato', units: [{ unit: 'count', unit_key: 'count', total: 400, count: 163 }], unquantified: 0 }], other: [] } },
    ))
    const { result } = renderHook(() => useHarvestSnapshot())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.snapshot.last7.count).toBe(163)
    expect(result.current.snapshot.last7.count).not.toBe(page.length)
  })

  it('leaves snapshot null on failure (ambient — never blocks the page)', async () => {
    // One *Once implementation per request rather than a blanket mockRejectedValue. Harness
    // constraint, verified rather than guessed: under vitest 2.1.9 a spy whose SINGLE standing
    // implementation returns a rejection hands both concurrent callers a promise it then reports as
    // unhandled, with or without Promise.allSettled — reproduced against a bare
    // `Promise.allSettled([spy(), spy()])` and no hook at all. Distinct per-call rejections are
    // also closer to the real failure, where the two requests fail independently.
    fetchSpy
      .mockImplementationOnce(() => Promise.reject(new Error('season down')))
      .mockImplementationOnce(() => Promise.reject(new Error('7d down')))
    const { result } = renderHook(() => useHarvestSnapshot())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.snapshot).toBeNull()
  })

  it('a failed 7-day request blanks the WHOLE strip rather than reporting a quiet week', async () => {
    // Wrong is worse than absent, and this is the exact wrong: a zeroed window rendered as
    // "A quiet week" beside two tiles that answered correctly.
    fetchSpy.mockImplementation((url) => (String(url).includes('timeframe=7d')
      ? Promise.reject(new Error('down'))
      : Promise.resolve({ entries: [{ event_id: 'a', day_key: '2026-08-17' }], aggregates: { crop_list: [{}, {}] } })))
    const { result } = renderHook(() => useHarvestSnapshot())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.snapshot).toBeNull()
  })
})
