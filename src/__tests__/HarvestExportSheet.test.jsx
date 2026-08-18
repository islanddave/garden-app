// V4-HARVEXPORT-001 — the export sheet's BEHAVIOR pins (design §6-S5).
//
// The pins that matter here are not "does it render text". They are the two Chrome Android landmines
// and the drain-integrity contract:
//   * Copy must call navigator.clipboard.writeText SYNCHRONOUSLY inside the click handler. Every
//     assertion below that proves this deliberately runs with NO await between fireEvent.click and
//     the expect — a called-with assertion after an await passes against the broken implementation
//     (transient user activation is already gone by then) and is therefore vacuous.
//   * A failed OR cache-served page mid-drain must abort with a visible error and write NOTHING. A
//     partial export that looks complete is worse than no export.
//   * Share is NOT Copy: shareEntity returning 'shared' must never render "Copied".
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const { fetchSpy, shareSpy, writeSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn(), shareSpy: vi.fn(), writeSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('../lib/shareEntity.js', () => ({ shareEntity: shareSpy }))

import HarvestExportSheet from '../components/HarvestExportSheet.jsx'
import { buildTotalsExport, buildLogExport, narratedHeader } from '../lib/harvestExport.js'
import { sortAggregates, DEFAULT_SORT_MODE, DEFAULT_SORT_DIR } from '../lib/harvestSort.js'
import { etDay } from '../lib/harvestSummary.js'
import { HARVEST_TZ } from '../lib/growYear.js'

const TODAY = etDay(new Date(), HARVEST_TZ)
const YEAR = Number(TODAY.slice(0, 4))

const CROPS = [
  { crop_type_slug: 'tomato', crop_name: 'Tomato', units: [{ unit: 'count', total: 4 }], unquantified: 0, varieties: [] },
  { crop_type_slug: 'basil', crop_name: 'Basil', units: [{ unit: 'bunch', total: 2 }], unquantified: 0, varieties: [] },
]
const AGG = { crops: CROPS, other: [], first_pick: [], weight: null }
const CROP_OPTIONS = [{ crop_type_slug: 'tomato', display_name: 'Tomato' }, { crop_type_slug: 'basil', display_name: 'Basil' }]

const entry = (n, slug) => ({
  event_id: `e${n}`, day_key: '2026-08-11', crop_type_slug: slug, crop_name: slug === 'tomato' ? 'Tomato' : 'Basil',
  variety_name: `V${n}`, quantity: 1, unit: slug === 'tomato' ? 'count' : 'bunch', harvest_log_id: `h${n}`,
})
const PAGE1 = [entry(1, 'tomato'), entry(2, 'basil')]
const PAGE2 = [entry(3, 'tomato')]

beforeEach(() => {
  fetchSpy.mockReset(); shareSpy.mockReset(); writeSpy.mockReset()
  writeSpy.mockResolvedValue(undefined)
  shareSpy.mockResolvedValue('shared')
  Object.defineProperty(globalThis.navigator, 'clipboard', { value: { writeText: writeSpy }, configurable: true, writable: true })
})

const open = (props = {}) => render(
  <HarvestExportSheet open onClose={() => {}} cropOptions={CROP_OPTIONS} seasonYears={[YEAR]} {...props} />
)
const preview = () => screen.getByTestId('export-preview')
const copyBtn = () => screen.getByRole('button', { name: 'Copy' })
const shareBtn = () => screen.getByRole('button', { name: 'Share' })

describe('HarvestExportSheet — Totals mode', () => {
  it('opens READY: one aggregates request, preview populated, Copy enabled — zero decisions', async () => {
    fetchSpy.mockResolvedValue({ aggregates: AGG })
    open({ defaultFormat: 'totals', initialTimeframe: `season:${YEAR}` })
    await waitFor(() => expect(preview().value).toContain('Tomato'))
    expect(copyBtn().disabled).toBe(false)
    // Seeded from the page's timeframe, and exactly ONE request — the aggregates path is cursor-free.
    const urls = fetchSpy.mock.calls.map((c) => decodeURIComponent(String(c[0])))
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain(`timeframe=season:${YEAR}`)
    // V4-HARVSORTCTRL-001: the sheet applies the PAGE's ordering to its own rowset before building,
    // so the expectation builds from the sorted shape too. That is the point of the assertion, not
    // an accommodation of it: this is the "the export reconciles with the page" guarantee, and if
    // the sheet ever stopped sorting, this comparison against the sorted expectation would fail.
    expect(preview().value).toBe(buildTotalsExport({
      aggregates: sortAggregates(AGG, DEFAULT_SORT_MODE, DEFAULT_SORT_DIR),
      timeframe: `season:${YEAR}`, cropNames: [], generatedOn: TODAY, currentYear: YEAR,
    }))
  })

  it('a crop chip narrows the export and re-materializes it — the copy line states the Unassigned rule', async () => {
    fetchSpy.mockResolvedValue({ aggregates: { ...AGG, other: [{ project_id: 'p9', project_name: 'Back Bed', units: [{ unit: 'count', total: 4 }], unquantified: 0 }] } })
    open({ defaultFormat: 'totals' })
    await waitFor(() => expect(preview().value).toContain('Unassigned'))
    expect(screen.getByText(/All crops, including harvests logged without a planting/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Basil' }))
    await waitFor(() => expect(preview().value).toContain('All time · Basil'))
    expect(preview().value).not.toContain('Tomato')
    expect(preview().value).not.toContain('Unassigned') // slug-less events belong to no selected crop
    expect(screen.getByText(/left out while a crop filter is on/)).toBeTruthy()
  })

  it('an empty universe disables Copy AND Share and says so — never a silently empty paste', async () => {
    fetchSpy.mockResolvedValue({ aggregates: { crops: [], other: [] } })
    open({ defaultFormat: 'totals' })
    await waitFor(() => expect(screen.getByText(/No harvests match — nothing to export/)).toBeTruthy())
    expect(copyBtn().disabled).toBe(true)
    expect(shareBtn().disabled).toBe(true)
  })
})

describe('HarvestExportSheet — Log mode drain', () => {
  const drainOk = () => fetchSpy
    .mockResolvedValueOnce({ entries: PAGE1, aggregates: AGG, cursor: 'c1' })
    .mockResolvedValueOnce({ entries: PAGE2, aggregates: AGG, cursor: null })

  it('drains EVERY page before materializing — stopping after page 1 loses a harvest', async () => {
    drainOk()
    open({ defaultFormat: 'log' })
    await waitFor(() => expect(copyBtn().disabled).toBe(false))
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(fetchSpy.mock.calls[1][0]).toContain('cursor=c1')
    // Byte-exact against the FULL fixture: a short drain changes this string.
    expect(preview().value).toBe(buildLogExport({ entries: [...PAGE1, ...PAGE2], timeframe: '', cropNames: [], generatedOn: TODAY, currentYear: YEAR }))
    expect(preview().value).toContain('V3') // the page-2 row
  })

  // Pre-promote regression pass I-4. Log mode reads entries/cursor and never touches aggregates, but
  // the Lambda computes them over the FULL range with no cursor and no limit (plus a GROUPING SETS
  // weight roll-up) for EVERY page it is asked for — and `load` re-drains on each chip toggle, so
  // asking wastes ~11 full-range computations per drain against the shared prod Neon. Pinned because
  // the wasteful form is invisible at the UI: both produce byte-identical exports.
  it('asks for entries ONLY — never the unused full-range aggregates leg', async () => {
    drainOk()
    open({ defaultFormat: 'log' })
    await waitFor(() => expect(copyBtn().disabled).toBe(false))
    const urls = fetchSpy.mock.calls.map((c) => decodeURIComponent(String(c[0])))
    expect(urls).toHaveLength(2)
    urls.forEach((u) => {
      expect(u).toContain('include=entries')
      expect(u).not.toContain('aggregates')
    })
  })

  it('drains UNFILTERED once and client-filters — never one request per selected crop', async () => {
    drainOk()
    open({ defaultFormat: 'log', initialCrops: ['tomato'] })
    await waitFor(() => expect(copyBtn().disabled).toBe(false))
    for (const c of fetchSpy.mock.calls) expect(String(c[0])).not.toMatch(/[?&]crop=/)
    expect(preview().value).toContain('V1')
    expect(preview().value).not.toContain('V2') // basil, filtered out client-side
  })

  it('a mid-drain REJECTION aborts: visible error, retry affordance, NOTHING copyable', async () => {
    fetchSpy
      .mockResolvedValueOnce({ entries: PAGE1, aggregates: AGG, cursor: 'c1' })
      .mockRejectedValueOnce(new Error('offline'))
    open({ defaultFormat: 'log' })
    await waitFor(() => expect(screen.getByTestId('export-error')).toBeTruthy())
    expect(preview().value).toBe('')            // no partial text survives the abort
    expect(copyBtn().disabled).toBe(true)
    expect(writeSpy).not.toHaveBeenCalled()     // and nothing reached the clipboard
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })

  it('a CACHE-SERVED page mid-drain takes the same abort path — the cache holds page 1, not the drain', async () => {
    const cached = { entries: PAGE2, aggregates: AGG, cursor: null }
    Object.defineProperty(cached, Symbol.for('garden-app.fromCache'), { value: true, enumerable: false })
    fetchSpy
      .mockResolvedValueOnce({ entries: PAGE1, aggregates: AGG, cursor: 'c1' })
      .mockResolvedValueOnce(cached)
    open({ defaultFormat: 'log' })
    await waitFor(() => expect(screen.getByTestId('export-error')).toBeTruthy())
    expect(copyBtn().disabled).toBe(true)
    expect(preview().value).toBe('')
  })

  // BUG-EXPORTDRAINBOUND-001. Unreachable at 549 lifetime events, latent at 10,000: a server that keeps
  // handing back a cursor exhausts MAX_PAGES and the loop simply FALLS THROUGH. Before the fix that built
  // the export from the 200-page prefix and rendered it READY — a truncated export presenting itself as
  // complete, which is the one outcome the drain-integrity invariant exists to forbid. It has to abort
  // like any other broken page, not quietly succeed.
  it('exhausting the page bound with a cursor still open ABORTS — never a complete-looking prefix', async () => {
    fetchSpy.mockResolvedValue({ entries: PAGE1, aggregates: AGG, cursor: 'never-ends' })
    open({ defaultFormat: 'log' })
    await waitFor(() => expect(screen.getByTestId('export-error')).toBeTruthy())
    // The bound is honoured on the way in, too: it stops requesting rather than looping forever.
    expect(fetchSpy).toHaveBeenCalledTimes(200)
    expect(preview().value).toBe('')          // no 200-page prefix left materialized
    expect(copyBtn().disabled).toBe(true)
    expect(writeSpy).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })

  it('Try again re-runs the drain and recovers', async () => {
    fetchSpy
      .mockResolvedValueOnce({ entries: PAGE1, aggregates: AGG, cursor: 'c1' })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ entries: PAGE1, aggregates: AGG, cursor: 'c1' })
      .mockResolvedValueOnce({ entries: PAGE2, aggregates: AGG, cursor: null })
    open({ defaultFormat: 'log' })
    await waitFor(() => expect(screen.getByTestId('export-error')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(copyBtn().disabled).toBe(false))
    expect(preview().value).toContain('V3')
  })
})

describe('HarvestExportSheet — Copy vs Share (the activation landmine)', () => {
  it('Copy calls navigator.clipboard.writeText SYNCHRONOUSLY in the click handler', async () => {
    fetchSpy.mockResolvedValue({ aggregates: AGG })
    open({ defaultFormat: 'totals' })
    await waitFor(() => expect(copyBtn().disabled).toBe(false))
    const expected = preview().value

    fireEvent.click(copyBtn())
    // NO await above this line, deliberately: an implementation that builds or fetches the string
    // across an await calls writeText in a later microtask and fails right here — which is the whole
    // point. Chrome Android drops transient activation the same way.
    expect(writeSpy).toHaveBeenCalledTimes(1)
    expect(writeSpy).toHaveBeenCalledWith(expected)
  })

  it('Copy is byte-PLAIN — the narrated share header never leaks into a spreadsheet paste', async () => {
    fetchSpy.mockResolvedValue({ aggregates: AGG })
    open({ defaultFormat: 'totals' })
    await waitFor(() => expect(copyBtn().disabled).toBe(false))
    fireEvent.click(copyBtn())
    expect(writeSpy.mock.calls[0][0].startsWith('Garden harvests — Totals')).toBe(true)
    expect(writeSpy.mock.calls[0][0]).not.toContain('My garden,')
    await waitFor(() => expect(screen.getByText('Copied')).toBeTruthy())
  })

  it('Copy does NOT go through shareEntity — on Chrome Android that opens the OS sheet and never copies', async () => {
    fetchSpy.mockResolvedValue({ aggregates: AGG })
    open({ defaultFormat: 'totals' })
    await waitFor(() => expect(copyBtn().disabled).toBe(false))
    fireEvent.click(copyBtn())
    expect(shareSpy).not.toHaveBeenCalled()
  })

  it('Share sends the narrated header + body and shows "Shared" — never a "Copied" lie', async () => {
    fetchSpy.mockResolvedValue({ aggregates: AGG })
    open({ defaultFormat: 'totals', initialTimeframe: `season:${YEAR}` })
    await waitFor(() => expect(shareBtn().disabled).toBe(false))

    fireEvent.click(shareBtn())
    expect(shareSpy).toHaveBeenCalledTimes(1) // synchronous, same reasoning as Copy
    const sent = shareSpy.mock.calls[0][0].text
    // narratedHeader reads the ordered shape too — the sheet sorts BEFORE building, so both the
    // header and the body describe the same list the page shows.
    const ordered = sortAggregates(AGG, DEFAULT_SORT_MODE, DEFAULT_SORT_DIR)
    expect(sent.startsWith(narratedHeader({ mode: 'totals', aggregates: ordered, timeframe: `season:${YEAR}` }))).toBe(true)
    expect(sent).toContain('Garden harvests — Totals')
    await waitFor(() => expect(screen.getByText('Shared')).toBeTruthy())
    expect(screen.queryByText('Copied')).toBeNull()
    expect(writeSpy).not.toHaveBeenCalled()
  })

  it("Share returning 'noop' shows the visible fallback, not success", async () => {
    shareSpy.mockResolvedValue('noop')
    fetchSpy.mockResolvedValue({ aggregates: AGG })
    open({ defaultFormat: 'totals' })
    await waitFor(() => expect(shareBtn().disabled).toBe(false))
    fireEvent.click(shareBtn())
    await waitFor(() => expect(screen.getByText(/select the text above/)).toBeTruthy())
    expect(screen.queryByText('Copied')).toBeNull()
  })

  it('a REJECTED clipboard write shows the fallback and leaves the preview selectable', async () => {
    writeSpy.mockRejectedValue(new Error('denied'))
    fetchSpy.mockResolvedValue({ aggregates: AGG })
    open({ defaultFormat: 'totals' })
    await waitFor(() => expect(copyBtn().disabled).toBe(false))
    fireEvent.click(copyBtn())
    await waitFor(() => expect(screen.getByText(/Couldn’t copy — select the text above/)).toBeTruthy())
    expect(screen.queryByText('Copied')).toBeNull()
    expect(preview().readOnly).toBe(true)       // selectable + focusable, not disabled
    expect(preview().disabled).toBe(false)
  })
})
