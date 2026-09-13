// BUG-PLANNOREVALIDATE-001 — the wake-revalidation half of DRG-INTRADAY-002, which shipped with
// everything EXCEPT the listener registration. `refresh` existed and nothing called it, so the plan
// was fetched once per Today mount and never again. These tests exist because that defect was
// invisible to the whole suite: no test asserted a SECOND fetch, so "never revalidates" and "always
// revalidates" were indistinguishable to CI for as long as the hook has existed.
//
// The load-bearing assertions are the NEGATIVE ones (no listener => no second fetch; both events on
// one wake => exactly ONE extra fetch). A test that only asserted "fetch was called" would pass
// against the broken hook, which is the trap this file is written to avoid.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor, act } from '@testing-library/react'
import React from 'react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))

import { useDailyPlan } from '../hooks/useDailyPlan.js'

const PLAN_A = { plan_date: '2026-09-13', generated_at: 'A', has_plan: true, plan: { water_due: [1, 2, 3] } }
const PLAN_B = { plan_date: '2026-09-13', generated_at: 'B', has_plan: true, plan: { water_due: [1] } }

let nowMs
beforeEach(() => {
  fetchSpy.mockReset()
  nowMs = 1_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => nowMs)
  // jsdom defaults to 'visible'; make it explicit and controllable.
  setVisibility('visible')
})
afterEach(() => { vi.restoreAllMocks() })

function setVisibility(state) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
}

function Probe() {
  const { data, loading, refreshing, error } = useDailyPlan()
  return (
    <div>
      <span data-testid="gen">{data?.generated_at ?? ''}</span>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="refreshing">{String(refreshing)}</span>
      <span data-testid="error">{error ?? ''}</span>
    </div>
  )
}
const gen = (c) => c.querySelector('[data-testid="gen"]').textContent
const err = (c) => c.querySelector('[data-testid="error"]').textContent

async function mountLoaded() {
  fetchSpy.mockResolvedValueOnce(PLAN_A)
  const { container, unmount } = render(<Probe />)
  await waitFor(() => expect(gen(container)).toBe('A'))
  expect(fetchSpy).toHaveBeenCalledTimes(1)
  return { container, unmount }
}

// Past the REVALIDATE_MIN_MS floor (60_000). Every wake test must move the clock first, or it is
// asserting the throttle rather than the listener.
const advancePastFloor = () => { nowMs += 60_001 }

describe('useDailyPlan — wake revalidation', () => {
  it('MOUNT ONLY: no wake event => exactly one fetch (the pre-fix behaviour, now pinned as wrong)', async () => {
    const { container } = await mountLoaded()
    advancePastFloor()
    // No event dispatched. Nothing should refetch on its own — this is the control.
    await new Promise((r) => setTimeout(r, 20))
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(gen(container)).toBe('A')
  })

  it('focus after the floor revalidates and swaps in the newer plan', async () => {
    const { container } = await mountLoaded()
    fetchSpy.mockResolvedValueOnce(PLAN_B)
    advancePastFloor()
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => expect(gen(container)).toBe('B'))
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('visibilitychange after the floor revalidates', async () => {
    const { container } = await mountLoaded()
    fetchSpy.mockResolvedValueOnce(PLAN_B)
    advancePastFloor()
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await waitFor(() => expect(gen(container)).toBe('B'))
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('ANDROID DOUBLE-FIRE: focus + visibilitychange on one wake => exactly ONE extra fetch', async () => {
    await mountLoaded()
    let resolve
    fetchSpy.mockImplementationOnce(() => new Promise((r) => { resolve = r }))
    advancePastFloor()
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
    })
    // Second event lands while the first request is still open: inflightRef must swallow it.
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    await act(async () => { resolve(PLAN_B) })
  })

  it('THROTTLE: a wake inside the floor does not refetch', async () => {
    await mountLoaded()
    nowMs += 59_000 // inside REVALIDATE_MIN_MS
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('GOING AWAY is not a wake: visibilitychange while hidden does not refetch', async () => {
    await mountLoaded()
    advancePastFloor()
    setVisibility('hidden')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('STALE BEATS BLANK: a failed revalidation keeps the last good plan and sets no error', async () => {
    const { container } = await mountLoaded()
    fetchSpy.mockRejectedValueOnce(new Error('dead zone'))
    advancePastFloor()
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2))
    expect(gen(container)).toBe('A')   // previous plan retained
    expect(err(container)).toBe('')    // and NOT surfaced as an error
  })

  it('a failed revalidation still arms the floor, so a dead zone cannot busy-loop the radio', async () => {
    await mountLoaded()
    fetchSpy.mockRejectedValueOnce(new Error('dead zone'))
    advancePastFloor()
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2))
    // Immediately after the failure settles, another wake must be throttled, not retried.
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('UNMOUNT: listeners are removed — a wake after unmount fetches nothing', async () => {
    const { unmount } = await mountLoaded()
    unmount()
    advancePastFloor()
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})
