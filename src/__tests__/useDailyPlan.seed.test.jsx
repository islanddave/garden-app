// V5-TODAYREDESIGN-001 S2 — useDailyPlan's opt-in `seed` (plan-v2 §6.3). Absent (every existing caller), the
// hook is unchanged: the first render is a load. Present, a remount in the same plan day paints the user's last
// good plan at once and revalidates without blanking.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock }) }))

import { useDailyPlan, __resetDailyPlanSeed } from '../hooks/useDailyPlan.js'
import { todayLocalISO } from '../lib/dateLocal.js'

const today = () => todayLocalISO()
const env = (planDate, tag) => ({ has_plan: true, plan_date: planDate, plan: { water_due: [], tag } })

beforeEach(() => { __resetDailyPlanSeed(); fetchMock.mockReset() })

describe('useDailyPlan seed', () => {
  it('without a seed the first render is a load, exactly as before', async () => {
    fetchMock.mockResolvedValue(env(today(), 'a'))
    const { result } = renderHook(() => useDailyPlan({ includeHousehold: true }))
    expect(result.current.loading).toBe(true)
    expect(result.current.data).toBeNull()
    await waitFor(() => expect(result.current.data?.plan.tag).toBe('a'))
    // …and it stored nothing: a later seeded mount starts cold.
    fetchMock.mockReturnValue(new Promise(() => {}))
    const again = renderHook(() => useDailyPlan({ includeHousehold: true, seed: 'u' }))
    expect(again.result.current.loading).toBe(true)
  })

  it('a seeded remount paints the last good plan at once and revalidates as a refresh (never blanks)', async () => {
    fetchMock.mockResolvedValue(env(today(), 'first'))
    const first = renderHook(() => useDailyPlan({ includeHousehold: true, seed: 'u' }))
    await waitFor(() => expect(first.result.current.data?.plan.tag).toBe('first'))
    first.unmount()

    let resolve
    fetchMock.mockReturnValue(new Promise((r) => { resolve = r }))
    const second = renderHook(() => useDailyPlan({ includeHousehold: true, seed: 'u' }))
    expect(second.result.current.loading).toBe(false)
    expect(second.result.current.data.plan.tag).toBe('first')
    await waitFor(() => expect(second.result.current.refreshing).toBe(true))
    expect(second.result.current.loading).toBe(false)
    expect(fetchMock).toHaveBeenLastCalledWith('/api/daily-plan?include=household')
    await act(async () => { resolve(env(today(), 'second')) })
    expect(second.result.current.data.plan.tag).toBe('second')
  })

  it('a failed revalidation keeps the seeded plan and raises no error', async () => {
    fetchMock.mockResolvedValue(env(today(), 'good'))
    const a = renderHook(() => useDailyPlan({ seed: 'u' }))
    await waitFor(() => expect(a.result.current.data).not.toBeNull())
    a.unmount()
    fetchMock.mockRejectedValue(new Error('offline'))
    const b = renderHook(() => useDailyPlan({ seed: 'u' }))
    await waitFor(() => expect(b.result.current.refreshing).toBe(false))
    expect(b.result.current.data.plan.tag).toBe('good')
    expect(b.result.current.error).toBeNull()
  })

  it('never paints yesterday\'s plan as today\'s, another user\'s plan, or another question\'s', async () => {
    fetchMock.mockResolvedValue(env('2020-01-01', 'old'))
    const a = renderHook(() => useDailyPlan({ seed: 'u' }))
    await waitFor(() => expect(a.result.current.data).not.toBeNull())
    a.unmount()
    fetchMock.mockReturnValue(new Promise(() => {}))
    expect(renderHook(() => useDailyPlan({ seed: 'u' })).result.current.loading).toBe(true)

    fetchMock.mockResolvedValue(env(today(), 'mine'))
    const c = renderHook(() => useDailyPlan({ seed: 'u' }))
    await waitFor(() => expect(c.result.current.data?.plan.tag).toBe('mine'))
    c.unmount()
    fetchMock.mockReturnValue(new Promise(() => {}))
    expect(renderHook(() => useDailyPlan({ seed: 'other' })).result.current.loading).toBe(true)
    expect(renderHook(() => useDailyPlan({ seed: 'u', includeHousehold: true })).result.current.loading).toBe(true)
    expect(renderHook(() => useDailyPlan({ seed: 'u' })).result.current.loading).toBe(false)
  })
})
