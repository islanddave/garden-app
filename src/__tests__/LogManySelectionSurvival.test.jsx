// V4-LOGMANYUXREFRESH-001 S0 — the Log Many selection must stop being destroyed.
//
// THE DEFECT, in one line: ScopeChecklist's dry-run effect opened with `setExcluded(new Set())` and
// closed by re-seeding from the stored default, and its deps are [scope, eventType, eventDate], so a
// hand-built selection over a 239-planting garden was wiped — with no warning and no undo — by a zone
// chip, an event-type tile, or a back-date. The selection was also absent from the draft snapshot AND
// from `hasUnsavedInput`, so a stray backdrop tap dismissed it and a deploy's reload was not held.
// Nothing anywhere pinned any of it: before this file, no test in the repo asserted selection
// survival across ANY of those five events.
//
// Harness mirrors LogManyDepthStash.test.jsx — the REAL <ScopeChecklist> (the state under test lives
// inside it, so a stub would leave the whole defect untested while the suite went green), the real
// reloadGate, and a stable module-scope `searchParams` (LogMany's loader effect depends on it).
//
// The five acceptance events from the row, one describe block each: zone change, event-type change,
// date change, dismiss, reload.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const navigate = vi.fn()
const location = { pathname: '/log/many', search: '', state: {} }
const searchParams = new URLSearchParams()
const setSearchParams = vi.fn()
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
  useSearchParams: () => [searchParams, setSearchParams],
  useLocation: () => location,
  Link: ({ children }) => children,
}))

const apiFetch = vi.fn()
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetch, getToken: vi.fn(async () => null) }) }))

import LogMany from '../pages/LogMany.jsx'
import { OverlayDirtyProvider } from '../context/OverlayContext.jsx'
import { isReloadBlocked, clearReloadBlocks } from '../lib/reloadGate.js'

// Two zones so a scope change is expressible, and a scope-dependent planting set so the "fell out of
// scope" case is real rather than notional: Pepper Row lives in the Bag Area only.
const LOCATIONS = [
  { id: 'bag', name: 'Bag Area', parent_id: null, sort_order: 1 },
  { id: 'trough', name: 'Trough', parent_id: null, sort_order: 2 },
]
const ALL = [
  { id: 'pl-1', name: 'Aji Dulce' },
  { id: 'pl-2', name: 'Basil Row' },
  { id: 'pl-3', name: 'Pepper Row' },
]
const TROUGH_ONLY = [{ id: 'pl-1', name: 'Aji Dulce' }, { id: 'pl-2', name: 'Basil Row' }]

const STASH_KEY = 'gardenApp.draft.logmany'
const batchPosts = []
const dryRuns = []

const readStash = () => {
  const raw = sessionStorage.getItem(STASH_KEY)
  return raw ? JSON.parse(raw).data : null
}
const seedStash = (data) => sessionStorage.setItem(STASH_KEY, JSON.stringify({ v: 1, data }))

beforeEach(() => {
  navigate.mockClear()
  batchPosts.length = 0
  dryRuns.length = 0
  try { sessionStorage.clear(); localStorage.clear() } catch { /* noop */ }
  clearReloadBlocks()
  apiFetch.mockImplementation((path, opts = {}) => {
    if (path === '/api/projects') return Promise.resolve([])
    if (path === '/api/locations') return Promise.resolve({ locations: LOCATIONS })
    if (path === '/api/events/batch' && opts.method === 'POST') {
      const body = JSON.parse(opts.body)
      if (body.dry_run) {
        dryRuns.push(body)
        // The Trough resolves a NARROWER set — Pepper Row is not in it. That is what makes the
        // "widen back and the skip is still there" assertion below a real test of the decisions map
        // rather than of a set that happens never to shrink.
        const rows = body.scope?.location_id === 'trough' ? TROUGH_ONLY : ALL
        return Promise.resolve({ count: rows.length, plantings: rows })
      }
      batchPosts.push(body)
      return Promise.resolve({ batch_id: 'b-1', count: body.exclude_plant_ids?.length ? 1 : ALL.length })
    }
    return Promise.resolve(null)
  })
})
afterEach(() => cleanup())

const renderReady = async (ui = <LogMany />) => {
  const out = render(ui)
  await screen.findByText(/Review \d+ plantings/)
  return out
}
// `showList` is component state and deliberately survives a re-preview, so the disclosure reads
// "Hide N plantings" on every call after the first. Idempotent-open rather than a bare click: a
// second click would CLOSE the list and every assertion after it would report on an absent row.
const openList = async () => {
  await screen.findByText(/(Review|Hide) \d+ plantings?/)
  const link = screen.queryByText(/Review \d+ plantings?/)
  if (link) fireEvent.click(link)
}
// The row toggle is the <button>; the name is its only direct text node, so getByText lands on the
// button itself and aria-pressed is readable straight off it.
const row = (name) => screen.getByText(name)
const pressed = (name) => row(name).getAttribute('aria-pressed')
const skip = (name) => fireEvent.click(row(name))

describe('S0 — the selection survives a re-preview', () => {
  it('survives an event-type change', async () => {
    await renderReady()
    await openList()
    skip('Basil Row')
    await waitFor(() => expect(pressed('Basil Row')).toBe('false'))
    fireEvent.click(screen.getByText('Fertilized / Fed'))
    await waitFor(() => expect(dryRuns.length).toBeGreaterThan(1))
    await openList()
    expect(pressed('Basil Row')).toBe('false')
    expect(pressed('Aji Dulce')).toBe('true')
  })

  it('survives a date change', async () => {
    await renderReady()
    await openList()
    skip('Aji Dulce')
    await waitFor(() => expect(pressed('Aji Dulce')).toBe('false'))
    fireEvent.change(screen.getByLabelText(/Event date/), { target: { value: '2026-08-20' } })
    await waitFor(() => expect(dryRuns.some(d => d.event_date === '2026-08-20')).toBe(true))
    await openList()
    expect(pressed('Aji Dulce')).toBe('false')
  })

  it('survives a zone change', async () => {
    await renderReady()
    await openList()
    skip('Basil Row')
    await waitFor(() => expect(pressed('Basil Row')).toBe('false'))
    fireEvent.click(screen.getByText('By zone'))
    await waitFor(() => expect(dryRuns.some(d => d.scope?.type === 'space')).toBe(true))
    await openList()
    expect(pressed('Basil Row')).toBe('false')
  })

  // THE ONE THAT MATTERS MOST, and the reason the implementation keeps a decisions MAP rather than
  // intersecting on write: narrowing the scope drops Pepper Row out of the preview entirely. If the
  // skip were discarded with the row, widening back would silently re-include a planting the user
  // deliberately took out — a quieter and worse bug than the one being fixed.
  it('a skip on a planting that FALLS OUT of scope is still there when the scope widens back', async () => {
    await renderReady()
    await openList()
    skip('Pepper Row')
    await waitFor(() => expect(pressed('Pepper Row')).toBe('false'))
    fireEvent.click(screen.getByText('By zone'))
    fireEvent.click(await screen.findByText('Trough'))
    await waitFor(() => expect(dryRuns.some(d => d.scope?.location_id === 'trough')).toBe(true))
    await openList()
    await waitFor(() => expect(screen.queryByText('Pepper Row')).toBeNull())
    fireEvent.click(screen.getByText('All active'))
    await waitFor(() => expect(screen.getByText(/(Review|Hide) 3 plantings/)).toBeDefined())
    await openList()
    expect(pressed('Pepper Row')).toBe('false')
  })

  // The intersection is taken at READ time, so an out-of-scope decision must not leak into the wire
  // body or the headline count — the confirm button would otherwise promise a number the server
  // cannot deliver.
  it('an out-of-scope skip is NOT reported in the count or the POST body', async () => {
    await renderReady()
    await openList()
    skip('Pepper Row')
    fireEvent.click(screen.getByText('By zone'))
    fireEvent.click(await screen.findByText('Trough'))
    await waitFor(() => expect(screen.getByText(/(Review|Hide) 2 plantings/)).toBeDefined())
    // 2 matched, none of them skipped → the net-count line is absent and the button says 2.
    expect(screen.queryByTestId('net-count')).toBeNull()
    fireEvent.click(screen.getByText('Log watered on 2'))
    await waitFor(() => expect(batchPosts.length).toBe(1))
    expect(batchPosts[0].exclude_plant_ids).toEqual([])
  })

  // The default flip is the one write that is still SUPPOSED to reset everything: stating a new
  // default while keeping the old default's consequences would be incoherent.
  it('flipping the stored "start with everything selected" preference still resets the selection', async () => {
    await renderReady()
    await openList()
    skip('Basil Row')
    await waitFor(() => expect(pressed('Basil Row')).toBe('false'))
    fireEvent.click(screen.getByLabelText('Start with everything selected'))   // → false, all skipped
    await waitFor(() => expect(pressed('Aji Dulce')).toBe('false'))
    fireEvent.click(screen.getByLabelText('Start with everything selected'))   // → true, all kept
    await waitFor(() => expect(pressed('Basil Row')).toBe('true'))
  })
})

describe('S0 — the selection reaches the guards and the stash', () => {
  it('a skip arms the backdrop guard AND holds the reload gate', async () => {
    const onDirtyChange = vi.fn()
    await renderReady(<OverlayDirtyProvider onDirtyChange={onDirtyChange}><LogMany /></OverlayDirtyProvider>)
    expect(isReloadBlocked()).toBe(false)
    await openList()
    skip('Basil Row')
    await waitFor(() => expect(isReloadBlocked()).toBe(true))
    expect(onDirtyChange).toHaveBeenCalledWith(true)
  })

  // Pristine-safety, the test every term added to these two channels has to pass: a bare mount with
  // zero user input must arm neither. This is not hypothetical — the review list is rendered on every
  // mount and the preference is read from localStorage.
  it('a bare mount arms neither channel — including with the "start with nothing selected" default', async () => {
    localStorage.setItem('quicklog.defaultAllSelected', '0')
    const onDirtyChange = vi.fn()
    await renderReady(<OverlayDirtyProvider onDirtyChange={onDirtyChange}><LogMany /></OverlayDirtyProvider>)
    await openList()
    // Every row starts skipped (the whole point of the preference) with no user tap behind it…
    expect(pressed('Basil Row')).toBe('false')
    // …so neither guard may be armed, and nothing may be stashed.
    expect(isReloadBlocked()).toBe(false)
    expect(onDirtyChange).not.toHaveBeenCalledWith(true)
    expect(readStash()).toBeNull()
  })

  it('a skip is written to the draft stash', async () => {
    await renderReady()
    await openList()
    skip('Basil Row')
    await waitFor(() => expect(readStash()?.selection?.decisions).toEqual({ 'pl-2': false }))
    expect(readStash().selection.touched).toBe(true)
  })

  // The read half — this is the "reload" acceptance event. draftStash is sessionStorage, so a fresh
  // mount IS the reload from the component's point of view.
  it('a stashed selection is restored on the next mount and reaches the POST', async () => {
    seedStash({
      eventType: 'watering', eventDate: '', scope: { type: 'all' }, notes: '',
      selection: { decisions: { 'pl-2': false, 'pl-3': false }, baseline: true, touched: true },
    })
    await renderReady()
    await openList()
    expect(pressed('Basil Row')).toBe('false')
    expect(pressed('Pepper Row')).toBe('false')
    expect(pressed('Aji Dulce')).toBe('true')
    fireEvent.click(screen.getByText('Log watered on 1'))
    await waitFor(() => expect(batchPosts.length).toBe(1))
    expect([...batchPosts[0].exclude_plant_ids].sort()).toEqual(['pl-2', 'pl-3'])
  })

  // Restoring a decision must not be mistaken for having MADE one on this mount in a way the
  // component then treats as pristine: a restored selection is still the user's unsaved work, so the
  // guards stay armed exactly as they were when it was stashed (same rule `eventDate` follows).
  it('a restored selection keeps the guards armed', async () => {
    seedStash({
      eventType: 'watering', eventDate: '', scope: { type: 'all' }, notes: '',
      selection: { decisions: { 'pl-2': false }, baseline: true, touched: true },
    })
    await renderReady()
    await waitFor(() => expect(isReloadBlocked()).toBe(true))
  })

  // sessionStorage is user-writable and the stash is JSON — a malformed decisions map must not take
  // the review list down on its first read.
  it('a malformed stashed selection is ignored rather than thrown on', async () => {
    seedStash({
      eventType: 'watering', eventDate: '', scope: { type: 'all' }, notes: '',
      selection: { decisions: 'not-a-map', baseline: 'yes', touched: 1 },
    })
    await renderReady()
    await openList()
    expect(pressed('Basil Row')).toBe('true')
  })
})

describe('S0 — dismiss and the post-commit paths', () => {
  // The dismiss acceptance event. useReportOverlayDirty is what a hosting Sheet reads to no-op a
  // backdrop tap; asserting the reported value is asserting the dismissal is blocked, without
  // reaching into Sheet's own internals (the same seam LogMany.reloadGateWire.test.jsx uses).
  it('a dismiss cannot silently discard a selection — the sheet is told the form is dirty', async () => {
    const onDirtyChange = vi.fn()
    await renderReady(<OverlayDirtyProvider onDirtyChange={onDirtyChange}><LogMany /></OverlayDirtyProvider>)
    await openList()
    skip('Basil Row')
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true))
    // …and it is in the stash, so even a dismissal that the user confirms is recoverable.
    expect(readStash()?.selection?.decisions).toEqual({ 'pl-2': false })
  })

  it('"Log more" starts a clean batch — the previous selection is NOT carried onto it', async () => {
    await renderReady()
    await openList()
    skip('Basil Row')
    fireEvent.click(await screen.findByText('Log watered on 2'))
    await waitFor(() => expect(batchPosts.length).toBe(1))
    fireEvent.click(await screen.findByText('Log more'))
    await openList()
    expect(pressed('Basil Row')).toBe('true')
  })

  it('"Undo" keeps the selection, so the batch can be redone', async () => {
    await renderReady()
    await openList()
    skip('Basil Row')
    fireEvent.click(await screen.findByText('Log watered on 2'))
    await waitFor(() => expect(batchPosts.length).toBe(1))
    fireEvent.click(await screen.findByText('Undo'))
    await openList()
    expect(pressed('Basil Row')).toBe('false')
  })
})
