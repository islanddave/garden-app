/**
 * src/__tests__/Harvests.scrollRestore.test.jsx
 * V4-SCROLLRESTORE-001 (BD0806-05) — the Harvests page's half of the back-nav restore.
 *
 * Its own file rather than an addition to Harvests.test.jsx / .weight / .totalsWeight / .projhide,
 * which are shared across lanes: editing a shared suite to add coverage is how two green lanes merge
 * red.
 *
 * What is under test is NOT "the offset comes back". On this page the offset alone is meaningless.
 * Every Log row deep-links out, so Back-to-/harvests is the ordinary way back, and on that Back the
 * page rebuilds from nothing: TOTALS (the V4-HARVDEFAULT-001 bare-arrival default), no filters, one
 * page of entries. The claim is that the DOCUMENT THE OFFSET WAS MEASURED AGAINST is reassembled
 * first — view, the whole filter tuple, and the paging depth — and only then is the viewport aimed.
 * jsdom computes no layout, so this proves what is mounted and what is requested, never that the
 * pixels line up.
 *
 * Frame budgets: POSITIVE assertions pump until the restore lands (bounded by real time, inside the
 * hook's own ~20-frame budget); NEGATIVE ones ("nothing moved the viewport") spend a fixed budget,
 * because there is no event to wait for. A fixed budget on a positive assertion is a stopwatch and
 * goes red under fleet load on code that is fine.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act, cleanup } from '@testing-library/react'

const { fetchSpy, searchParamsRef } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  searchParamsRef: { current: new URLSearchParams() },
}))

// Pinned FALSE for the same reason Harvests.test.jsx pins it: this suite describes the
// projects-VISIBLE configuration. The flag-ON world has its own *.projhide suites.
vi.mock('../lib/featureFlags.js', async (importActual) => ({
  ...(await importActual()),
  PROJECTS_HIDDEN: false,
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useSearchParams: () => [searchParamsRef.current, () => {}],
}))

import Harvests from '../pages/Harvests.jsx'
import {
  __resetScrollRestoreStore,
  __seedScrollRestoreEntry,
  __peekScrollRestoreEntry,
} from '../hooks/useScrollRestore.js'
import { etDay, addDays } from '../lib/harvestSummary.js'

const TODAY = etDay(new Date())
// Distinct day per row so groupByDay renders them as separate sections — closer to the real page,
// and it keeps the row count independent of grouping.
const entry = (n) => ({
  event_id: `e${n}`, day_key: addDays(TODAY, -n), event_date: `${addDays(TODAY, -n)}T12:00:00Z`,
  plant_id: `p${n}`, project_id: 'pr1', crop_type_slug: 'tomato', crop_name: 'Tomato',
  variety_name: `Var-${n}`, quantity: 1, unit: 'count', quality_rating: null,
  harvest_log_id: `h${n}`, photos: [],
})
const entries = (from, count) => Array.from({ length: count }, (_, i) => entry(from + i))

// useHarvests percent-encodes its include list through URLSearchParams (include=entries%2Caggregates);
// useHarvestSnapshot builds its URL by hand with a literal comma. That difference is the only way to
// tell the Log's own request apart from the ambient snapshot request, and every assertion about
// requests below depends on it.
const isLogCall = (u) => u.includes('include=entries%2Caggregates')
const logCalls = () => fetchSpy.mock.calls.map((c) => String(c[0])).filter(isLogCall)
const cursorCalls = () => logCalls().filter((u) => u.includes('cursor='))
const rows = () => screen.queryAllByText(/^Var-\d+$/)

/**
 * @param pages  cursor key ('' for the first page) -> { entries, cursor }
 * @param endless every page answers full with a fresh cursor — what a long season looks like, and
 *                what the walk's request bound has to survive.
 */
function wire({ pages = { '': { entries: [], cursor: null } }, endless = false, pageSize = 2 } = {}) {
  fetchSpy.mockImplementation((url) => {
    const u = String(url)
    if (u === '/api/projects') return Promise.resolve([])
    // The filter-options universe (crop list + first_pick). first_pick empty keeps the off-season
    // re-anchor inert — it needs earlier-season history to fire, and a re-anchor mid-test would move
    // the timeframe under the assertions.
    if (u.includes('include=aggregates') && !u.includes('entries')) {
      return Promise.resolve({ aggregates: { crop_list: [{ crop_type_slug: 'tomato', display_name: 'Tomato' }], crops: [], other: [], first_pick: [] } })
    }
    if (!isLogCall(u)) return Promise.resolve({ entries: [], aggregates: { crops: [], other: [] }, cursor: null }) // snapshot
    const cur = /[?&]cursor=([^&]+)/.exec(u)?.[1] ?? ''
    if (endless) {
      const start = cur ? Number(cur) : 1
      return Promise.resolve({ entries: entries(start, pageSize), aggregates: { crops: [], other: [] }, cursor: String(start + pageSize) })
    }
    const p = pages[cur] ?? { entries: [], cursor: null }
    return Promise.resolve({ entries: p.entries, aggregates: { crops: [], other: [] }, cursor: p.cursor })
  })
}

let maxScroll = 0
let frameQueue = new Map()
let frameId = 0
let rowsAtScroll = []
function flushFrames(n = 1) {
  for (let i = 0; i < n; i++) {
    const due = [...frameQueue.values()]
    frameQueue.clear()
    for (const cb of due) cb()
  }
}
// WHERE THIS IS CALLED IS PART OF THE ASSERTION. It drains frames in a loop while the page's fetch
// promises are still resolving, so the restore fires on the first frame after it arms — which is the
// whole point of the ordering test below. Waiting for the content FIRST and pumping afterwards lets
// every frame land against a finished DOM, and passes against a page that restores far too early;
// that mistake let this file's first ordering test survive its own mutation.
async function pumpFramesUntil(done) {
  await waitFor(() => {
    act(() => flushFrames(1))
    if (!done()) throw new Error('not yet restored')
  }, { timeout: 5000, interval: 0 })
}
function setScrollY(y) {
  Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: y })
}

const SAVED_LOG = { v: 'log', tf: '', dtf: '', tt: false, c: '', cl: '', p: '', pl: '', n: 2 }

beforeEach(() => {
  __resetScrollRestoreStore()
  fetchSpy.mockReset()
  searchParamsRef.current = new URLSearchParams()
  maxScroll = 0
  frameQueue = new Map()
  frameId = 0
  rowsAtScroll = []
  setScrollY(0)
  window.scrollTo = vi.fn((x, y) => { rowsAtScroll.push(rows().length); setScrollY(Math.min(y, maxScroll)) })
  window.requestAnimationFrame = (cb) => { const id = ++frameId; frameQueue.set(id, cb); return id }
  window.cancelAnimationFrame = (id) => { frameQueue.delete(id) }
  window.history.replaceState({ key: 'harvests-entry' }, '')
})

afterEach(() => {
  cleanup()
  __resetScrollRestoreStore()
  window.history.replaceState(null, '')
})

describe('Harvests — back-nav restore', () => {
  it('a history entry it has never seen lands on Totals and never touches the viewport', async () => {
    wire({ pages: { '': { entries: entries(1, 2), cursor: null } } })
    render(<Harvests />)
    await waitFor(() => expect(logCalls().length).toBeGreaterThan(0))
    // Totals, not the Log: the shipped bare-arrival default is untouched by this change.
    await waitFor(() => expect(screen.queryByText('Var-1')).toBeNull())
    act(() => flushFrames(5))
    expect(window.scrollTo).not.toHaveBeenCalled()
  })

  // THE VIEW CLAIM. Restoring an offset onto Totals would aim a Log-sized target at a different
  // document. MUTATION: drop the `restored?.v` arm from the view initialiser -> RED (no Var- rows).
  it('comes back on the Log when that is the view the offset was measured against', async () => {
    wire({ pages: { '': { entries: entries(1, 2), cursor: null } } })
    __seedScrollRestoreEntry('harvests', 800, SAVED_LOG)
    maxScroll = 4000
    render(<Harvests />)
    await pumpFramesUntil(() => window.scrollTo.mock.calls.length > 0)
    expect(window.scrollTo).toHaveBeenCalledWith(0, 800)
    expect(window.scrollY).toBe(800)
    // Frames were being drained from the first render, so this says the restore waited for the Log
    // to paint rather than firing at the loading skeleton.
    expect(rowsAtScroll[0]).toBe(2)
  })

  // THE DEPTH CLAIM, and the ordering that makes it worth anything: the second keyset page must be
  // in the DOM the FIRST time the viewport is aimed.
  // MUTATION: pass `ready: !loading` (drop depthRestored) -> RED, first aim at 2 rows.
  it('re-walks the paging depth BEFORE the first restore attempt', async () => {
    wire({ pages: { '': { entries: entries(1, 2), cursor: 'c1' }, c1: { entries: entries(3, 2), cursor: null } } })
    __seedScrollRestoreEntry('harvests', 800, { ...SAVED_LOG, n: 4 })
    maxScroll = 4000
    render(<Harvests />)
    // Frames drain from the first render, so the FIRST aim is taken as early as the page allows it.
    // It must still find both keyset pages mounted.
    await pumpFramesUntil(() => window.scrollTo.mock.calls.length > 0)
    expect(rowsAtScroll[0]).toBe(4)
    // …and no click anywhere in this test: the second page was fetched by the restore itself.
    expect(cursorCalls()).toHaveLength(1)
  })

  // The request bound. useHarvests pages by opaque cursor, so there is no "ask for 4 rows" — only
  // "ask again". Without a bound a deep saved position is an unbounded fetch chain on a Back.
  // MUTATION: delete the depthWalks.current >= MAX_RESTORE_PAGES arm -> the chain does not settle.
  it('stops after two extra requests however deep the saved position was', async () => {
    wire({ endless: true })
    __seedScrollRestoreEntry('harvests', 800, { ...SAVED_LOG, n: 100000 })
    maxScroll = 4000
    render(<Harvests />)
    await pumpFramesUntil(() => window.scrollTo.mock.calls.length > 0)
    expect(rowsAtScroll[0]).toBe(6)
    expect(cursorCalls()).toHaveLength(2)
    expect(window.scrollTo).toHaveBeenCalledWith(0, 800)
  })

  // THE FILTER CLAIM. A filtered Log is a different, shorter list; restoring the offset without the
  // filter aims at a document that is not the one the number came from.
  it('restores the filter the Log was scoped by, and re-requests with it', async () => {
    wire({ pages: { '': { entries: entries(1, 2), cursor: null } } })
    __seedScrollRestoreEntry('harvests', 800, { ...SAVED_LOG, c: 'tomato', cl: 'Tomato' })
    maxScroll = 4000
    render(<Harvests />)
    await waitFor(() => expect(rows()).toHaveLength(2))
    expect(logCalls().every((u) => u.includes('crop=tomato'))).toBe(true)
    // …and the pill says so, rather than the page quietly filtering behind a "Crop" placeholder.
    expect(screen.getByRole('button', { name: 'Crop: Tomato. Change filter' })).toBeTruthy()
  })

  // The timeframe is restored WITH the default it is judged against. Restoring only the value makes
  // filterActive read true over an untouched default, which swaps the first-run empty state for
  // "No harvests match these filters" + a Clear filters button.
  // MUTATION: drop the `restored?.dtf` arm from defaultTimeframeRef -> RED.
  it('restores the timeframe together with the default it is judged against', async () => {
    wire({ pages: { '': { entries: [], cursor: null } } })
    __seedScrollRestoreEntry('harvests', 800, { ...SAVED_LOG, tf: 'season:2025', dtf: 'season:2025', n: 0 })
    maxScroll = 4000
    render(<Harvests />)
    await waitFor(() => expect(screen.queryByText('Your harvests will collect here')).not.toBeNull())
    expect(screen.queryByText('No harvests match these filters.')).toBeNull()
  })

  // THE GATE on all of the above. The hook only hands back view state for an entry that has a real
  // scroll offset, so a fresh forward navigation is inert even when this surface has an entry on
  // file. This is what keeps the change from being de-facto filter persistence.
  // MUTATION: return `saved.s` unconditionally from the hook -> RED (lands on the Log).
  it('ignores saved view state for an entry with no offset to restore', async () => {
    wire({ pages: { '': { entries: entries(1, 2), cursor: null } } })
    __seedScrollRestoreEntry('harvests', 0, { ...SAVED_LOG, c: 'tomato', cl: 'Tomato' })
    render(<Harvests />)
    await waitFor(() => expect(logCalls().length).toBeGreaterThan(0))
    expect(screen.queryByText('Var-1')).toBeNull()                 // Totals, the bare-arrival default
    expect(logCalls().some((u) => u.includes('crop=tomato'))).toBe(false)
    act(() => flushFrames(5))
    expect(window.scrollTo).not.toHaveBeenCalled()
  })

  it('records the view, filters and depth it was showing when the user navigated away', async () => {
    wire({ pages: { '': { entries: entries(1, 2), cursor: null } } })
    __seedScrollRestoreEntry('harvests', 800, SAVED_LOG)
    maxScroll = 4000
    const { unmount } = render(<Harvests />)
    await pumpFramesUntil(() => window.scrollTo.mock.calls.length > 0)
    await waitFor(() => expect(rows()).toHaveLength(2))
    act(() => { setScrollY(1250); window.dispatchEvent(new Event('scroll')) })
    unmount()
    const saved = __peekScrollRestoreEntry('harvests')
    expect(saved.y).toBe(1250)
    expect(saved.s).toMatchObject({ v: 'log', n: 2, c: '', p: '' })
  })
})
