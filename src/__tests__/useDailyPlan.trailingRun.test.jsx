// BUG-TODAYHOUSEHOLDRELOADDROP-001 — useDailyPlan's in-flight guard dropped a call that asked a DIFFERENT
// question from the open request, and nothing ever asked it again. Today asks with includeHousehold =
// showOthers && canShowOthers; a cold roster lands while the first plan request is open and flips it, so the
// household plan was never requested until the next wake (60 s floor) or a toggle off/on (QA probe P13,
// _mainsync12_20260925/T-todayorder/review-qa.md). The contract pinned here: when a request settles and the
// page's question changed while it was open, exactly ONE trailing request asks the CURRENT question; a plan
// already on screen stays on screen while it runs. A call asking the SAME question still coalesces.
//
// Every request stays open until the test answers it, so "while the request is open" is exact, not timing.
// Requests are told apart by their parsed query (include=household), never by string equality.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, cleanup } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))

import { useDailyPlan } from '../hooks/useDailyPlan.js'

let open, renders, api
beforeEach(() => {
  open = []
  renders = []
  api = null
  fetchSpy.mockReset()
  fetchSpy.mockImplementation((path) => new Promise((resolve, reject) => { open.push({ path, resolve, reject }) }))
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function Probe({ includeHousehold }) {
  const s = useDailyPlan({ includeHousehold })
  api = s
  renders.push({ loading: s.loading, refreshing: s.refreshing, error: s.error, shown: s.data?.generated_at ?? null })
  return null
}

const asked = () => fetchSpy.mock.calls.map((c) => c[0])
const household = (path) => new URL(path, 'http://x').searchParams.getAll('include').includes('household')
const planFor = (tag) => ({ schema_version: 1, plan_date: '2026-09-28', generated_at: tag, has_plan: true, plan: { water_due: [] } })
const answer = (i, tag) => act(async () => { open[i].resolve(planFor(tag)) })
const fail = (i, msg) => act(async () => { open[i].reject(new Error(msg)) })
const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve() }) }
// The index of the first render that showed a plan (not loading). Every render from there on is "data shown".
const firstPaint = (tag) => renders.findIndex((r) => r.shown === tag && !r.loading)

describe('useDailyPlan — a question that changes while a request is open (BUG-TODAYHOUSEHOLDRELOADDROP-001)', () => {
  it('the cold-roster race: includeHousehold turns on mid-flight -> after the open request settles, ONE more request, asking for the household', async () => {
    const { rerender } = render(<Probe includeHousehold={false} />)
    expect(asked().map(household)).toEqual([false])
    rerender(<Probe includeHousehold />)                     // the roster landed; the first request is still open
    expect(asked()).toHaveLength(1)                           // nothing competes with the open request
    await answer(0, 'mine')
    expect(asked().map(household)).toEqual([false, true])
    expect(new URL(asked()[1], 'http://x').pathname).toBe('/api/daily-plan')
    await answer(1, 'with-household')
    await settle()
    expect(asked()).toHaveLength(2)
    expect(renders.at(-1)).toMatchObject({ shown: 'with-household', loading: false, refreshing: false, error: null })
  })

  it('NEVER BLANK: the plan paints on the first answer and loading never comes back on while the trailing request is open', async () => {
    const { rerender } = render(<Probe includeHousehold={false} />)
    rerender(<Probe includeHousehold />)
    await answer(0, 'mine')
    const from = firstPaint('mine')
    expect(from).toBeGreaterThan(-1)
    // The trailing request reports through `refreshing`, over the plan already on screen.
    expect(renders.at(-1)).toMatchObject({ shown: 'mine', loading: false, refreshing: true, error: null })
    await answer(1, 'with-household')
    expect(renders.slice(from).filter((r) => r.loading)).toEqual([])
    expect(renders.at(-1)).toMatchObject({ shown: 'with-household', loading: false, refreshing: false })
  })

  it('NO PILE-UP: five question changes, explicit reloads and a wake double-fire during ONE open request -> exactly one trailing request, with the LATEST question', async () => {
    const { rerender } = render(<Probe includeHousehold={false} />)
    for (const v of [true, false, true, false, true]) rerender(<Probe includeHousehold={v} />)
    await act(async () => {
      api.reload(); api.reload(); api.refresh()
      window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(asked()).toHaveLength(1)
    await answer(0, 'mine')
    expect(asked().map(household)).toEqual([false, true])
    await answer(1, 'with-household')
    await settle()
    expect(asked()).toHaveLength(2)
    expect(renders.at(-1)).toMatchObject({ shown: 'with-household', loading: false, refreshing: false })
  })

  it('the LATEST question wins in the other direction too: on, then off, then on, then off again -> the trailing request does NOT ask for the household', async () => {
    const { rerender } = render(<Probe includeHousehold />)
    for (const v of [false, true, false]) rerender(<Probe includeHousehold={v} />)
    // The open request asked WITH the household; the page now asks without it (the toggle turned off mid-flight).
    await answer(0, 'with-household')
    expect(asked().map(household)).toEqual([true, false])
    await answer(1, 'mine')
    await settle()
    expect(asked()).toHaveLength(2)
    expect(renders.at(-1)).toMatchObject({ shown: 'mine', loading: false, refreshing: false })
  })

  it('changed and changed BACK while the request is open: the open request already answers the current question, so nothing trails', async () => {
    const { rerender } = render(<Probe includeHousehold={false} />)
    rerender(<Probe includeHousehold />)
    rerender(<Probe includeHousehold={false} />)
    await answer(0, 'mine')
    await settle()
    expect(asked().map(household)).toEqual([false])
    expect(renders.at(-1)).toMatchObject({ shown: 'mine', loading: false, refreshing: false, error: null })
  })

  it('SAME QUESTION still coalesces: StrictMode\'s double mount effect makes ONE request, a double refresh ONE more, and nothing trails either', async () => {
    render(<React.StrictMode><Probe includeHousehold={false} /></React.StrictMode>)
    expect(asked()).toHaveLength(1)
    await answer(0, 'mine')
    await settle()
    expect(asked()).toHaveLength(1)
    await act(async () => { api.refresh(); api.refresh(); api.reload() })
    expect(asked()).toHaveLength(2)
    await answer(1, 'mine-again')
    await settle()
    expect(asked()).toHaveLength(2)
  })

  it('the question changes while a REVALIDATION is open (the toggle tapped mid-refresh): one trailing request asks it, and the plan never blanks', async () => {
    const { rerender } = render(<Probe includeHousehold={false} />)
    await answer(0, 'mine')
    await act(async () => { api.refresh() })
    expect(asked().map(household)).toEqual([false, false])
    const from = renders.length
    rerender(<Probe includeHousehold />)
    await answer(1, 'mine-again')
    expect(asked().map(household)).toEqual([false, false, true])
    await answer(2, 'with-household')
    await settle()
    expect(asked()).toHaveLength(3)
    expect(renders.slice(from).filter((r) => r.loading)).toEqual([])
    expect(renders.at(-1)).toMatchObject({ shown: 'with-household', loading: false, refreshing: false, error: null })
  })

  it('STALE BEATS BLANK: the trailing request fails -> the plan on screen stays, and no error is set', async () => {
    const { rerender } = render(<Probe includeHousehold={false} />)
    rerender(<Probe includeHousehold />)
    await answer(0, 'mine')
    expect(asked().map(household)).toEqual([false, true])
    await fail(1, 'dead zone')
    await settle()
    expect(renders.at(-1)).toMatchObject({ shown: 'mine', loading: false, refreshing: false, error: null })
    expect(asked()).toHaveLength(2)
  })

  it('nothing on screen yet (the open request FAILED): the trailing request is an initial load — loading holds, no error flashes, then its plan shows', async () => {
    const { rerender } = render(<Probe includeHousehold={false} />)
    rerender(<Probe includeHousehold />)
    await fail(0, 'timed out')
    expect(asked().map(household)).toEqual([false, true])
    // The failure answered a question nobody is asking any more: it is never shown.
    expect(renders.filter((r) => r.error)).toEqual([])
    expect(renders.every((r) => r.loading)).toBe(true)
    await answer(1, 'with-household')
    expect(renders.at(-1)).toMatchObject({ shown: 'with-household', loading: false, refreshing: false, error: null })
  })

  it('nothing on screen yet and the trailing request fails too: ITS error shows (the never-loaded case keeps its error)', async () => {
    const { rerender } = render(<Probe includeHousehold={false} />)
    rerender(<Probe includeHousehold />)
    await fail(0, 'timed out')
    await fail(1, 'still timed out')
    await settle()
    expect(renders.at(-1)).toMatchObject({ shown: null, loading: false, refreshing: false, error: 'still timed out' })
    expect(asked()).toHaveLength(2)
  })

  it('unmounted while a changed question is open: nothing is requested after the open request settles', async () => {
    const { rerender, unmount } = render(<Probe includeHousehold={false} />)
    rerender(<Probe includeHousehold />)
    unmount()
    await answer(0, 'mine')
    await settle()
    expect(asked()).toHaveLength(1)
  })
})
