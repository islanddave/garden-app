import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

const { fetchSpy, searchParamsRef } = vi.hoisted(() => ({ fetchSpy: vi.fn(), searchParamsRef: { current: new URLSearchParams() } }))
// V4-PROJHIDE-001: the flag flipped TRUE in source on 2026-08-10. This suite predates the flip and
// its assertions describe the projects-VISIBLE UI (project chooser, project tree, "By project" scope),
// which remains a live configuration — rollback is a one-line revert. Pinned FALSE so every assertion
// below keeps covering what it was written to cover, rather than being rewritten to the flag-ON world
// and silently weakened. Flag-ON is covered by the *.projhide.test.jsx suites.
// importActual spread so every other flag keeps its real value.
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
import { etDay, addDays } from '../lib/harvestSummary.js'
import { currentGrowYear } from '../lib/growYear.js'

beforeEach(() => { fetchSpy.mockReset(); searchParamsRef.current = new URLSearchParams() })

// Route the mocked apiFetch by URL: /api/projects → project rows; unfiltered `include=aggregates`
// (no entries) → the picker's crop universe + season-sheet first_pick range; everything else (main +
// snapshot) → harvest entries, honoring a crop=/project= query param so the tests can drive the
// filtered-empty path. (S4: the unfiltered-options branch carries first_pick because the season
// universe derives from it — design §2b.)
function mockRoutes({ entries = [], crops = [], other = [], firstPick = [], cropList = [], projects = [] }) {
  fetchSpy.mockImplementation((url) => {
    const u = String(url)
    if (u === '/api/projects') return Promise.resolve(projects)
    if (u.includes('include=aggregates') && !u.includes('entries')) {
      return Promise.resolve({ aggregates: { crop_list: cropList, crops: [], other: [], first_pick: firstPick } })
    }
    const cropM = /[?&]crop=([^&]+)/.exec(u)
    const projM = /[?&]project=([^&]+)/.exec(u)
    const tfM = /[?&]timeframe=([^&]+)/.exec(u)
    let rows = entries
    if (cropM) rows = rows.filter((e) => e.crop_type_slug === decodeURIComponent(cropM[1]))
    if (projM) rows = rows.filter((e) => e.project_id === decodeURIComponent(projM[1]))
    // The MAIN call's aggregates are timeframe-SCOPED server-side (lambda/harvests/index.js) — that
    // is precisely why the season universe may not derive from them (design §2b self-collapse). The
    // mock has to honor that scoping or the "universe stays complete" pin is vacuous: with an
    // unscoped mock, a filtered-source implementation passes it.
    const seasonM = /^season:(\d{4})$/.exec(tfM ? decodeURIComponent(tfM[1]) : '')
    const scopedFirstPick = seasonM
      ? firstPick.filter((f) => f.first_pick_date >= `${Number(seasonM[1]) - 1}-11-01` && f.first_pick_date < `${seasonM[1]}-11-01`)
      : firstPick
    return Promise.resolve({ entries: rows, aggregates: { crops, other, first_pick: scopedFirstPick }, cursor: null })
  })
}

// V4-HARVDEFAULT-001: a bare arrival lands on TOTALS; every Log-content assertion below first
// toggles to the Log tab (design §2a: insert a toggle step, never weaken an assertion).
const toLog = () => fireEvent.click(screen.getByRole('radio', { name: 'Log' }))
// All /api/harvests calls this test file makes, with the query decoded (useHarvests percent-encodes
// season: via URLSearchParams; the snapshot hook doesn't — compare decoded, not raw).
const harvestCalls = () => fetchSpy.mock.calls.map((c) => decodeURIComponent(String(c[0]))).filter((u) => u.includes('/api/harvests'))

// Fixture day keys are RELATIVE to the wall clock: the S4 off-season rule re-anchors a bare arrival
// when the newest harvest is >30 days old, so fixed dates would make these tests change behavior as
// they age. No assertion below reads these dates.
const TODAY = etDay(new Date())
const D1 = addDays(TODAY, -1)
const D2 = addDays(TODAY, -2)
const TWO_CROPS = [
  { event_id: 'e1', day_key: D1, event_date: `${D1}T12:00:00Z`, plant_id: 'p1', project_id: 'pr1', crop_type_slug: 'tomato', crop_name: 'Tomato', variety_name: 'Sungold', quantity: 4, unit: 'count', quality_rating: 4, harvest_log_id: 'h1', photos: [] },
  { event_id: 'e2', day_key: D2, event_date: `${D2}T12:00:00Z`, plant_id: 'p2', project_id: 'pr2', crop_type_slug: 'basil', crop_name: 'Basil', variety_name: 'Genovese', quantity: 2, unit: 'bunch', quality_rating: 5, harvest_log_id: 'h2', photos: [] },
]
const TOMATO_CROP = { crop_type_slug: 'tomato', crop_name: 'Tomato', units: [{ unit: 'count', unit_key: 'count', total: 4, count: 1 }], unquantified: 0, varieties: [] }

describe('Harvests page', () => {
  it('shows the first-run empty state when there are no harvests', async () => {
    fetchSpy.mockResolvedValue({ entries: [], aggregates: { crops: [], other: [] }, cursor: null })
    render(<Harvests />)
    toLog() // S4: bare arrival lands on Totals — toggle in; the untouched default is not "filters"
    await waitFor(() => expect(screen.getByText(/harvests will collect here/i)).toBeTruthy())
  })

  it('renders a day-grouped entry (Log) and per-crop totals (Totals)', async () => {
    fetchSpy.mockResolvedValue({
      entries: [{
        event_id: 'e1', day_key: D1, event_date: `${D1}T12:00:00Z`,
        plant_id: 'p1', project_id: 'pr1', crop_name: 'Tomato', variety_name: 'Sungold',
        quantity: 4, unit: 'count', quality_rating: 4, harvest_log_id: 'h1', photos: [],
      }],
      aggregates: {
        crops: [{ crop_type_slug: 'tomato', crop_name: 'Tomato', units: [{ unit: 'count', unit_key: 'count', total: 4, count: 1 }], unquantified: 0, varieties: [] }],
        other: [],
      },
      cursor: null,
    })
    render(<Harvests />)
    toLog() // S4 arrival default is Totals
    await waitFor(() => expect(screen.getByText('Sungold')).toBeTruthy())
    // the row deep-links to the planting
    expect(screen.getByText('Sungold').closest('a').getAttribute('href')).toBe('/projects/pr1/plantings/p1')
    // switch to Totals — the crop row appears
    fireEvent.click(screen.getByText('Totals'))
    expect(screen.getByText('Tomato')).toBeTruthy()
  })

  it('surfaces a retryable error state', async () => {
    fetchSpy.mockRejectedValueOnce(Object.assign(new Error('down'), { body: { message: 'The harvest service had a problem.' } }))
    render(<Harvests />)
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.getByText(/harvest service had a problem/i)).toBeTruthy()
    expect(screen.getByText('Retry')).toBeTruthy()
    // Card now comes from AsyncRegion: the ~34px tap target is gone, the aria-hidden glyph stays.
    const retry = screen.getByRole('button', { name: 'Retry' })
    expect(parseInt(retry.style.minHeight, 10)).toBeGreaterThanOrEqual(44)
    expect(screen.getByRole('alert').firstChild.getAttribute('aria-hidden')).toBe('true')
  })

  it('filters the log by crop via the picker and shows a dismissible pill', async () => {
    mockRoutes({ entries: TWO_CROPS, cropList: [{ crop_type_slug: 'basil', display_name: 'Basil' }, { crop_type_slug: 'tomato', display_name: 'Tomato' }] })
    render(<Harvests />)
    toLog() // S4 arrival default is Totals
    await waitFor(() => expect(screen.getByText('Sungold')).toBeTruthy())
    expect(screen.getByText('Genovese')).toBeTruthy() // both crops visible unfiltered

    fireEvent.click(screen.getByRole('button', { name: /filter by crop/i }))
    await waitFor(() => expect(screen.getByRole('option', { name: /^Tomato/ })).toBeTruthy())
    fireEvent.click(screen.getByRole('option', { name: /^Tomato/ }))

    // request now carries crop=tomato; basil entry drops out, tomato remains
    await waitFor(() => expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes('crop=tomato'))).toBe(true))
    await waitFor(() => expect(screen.queryByText('Genovese')).toBeNull())
    expect(screen.getByText('Sungold')).toBeTruthy()
    // the pill is present and dismissible
    expect(screen.getByRole('button', { name: /clear crop filter/i })).toBeTruthy()
  })

  it('dismisses the crop pill to clear the filter', async () => {
    mockRoutes({ entries: TWO_CROPS, cropList: [{ crop_type_slug: 'basil', display_name: 'Basil' }, { crop_type_slug: 'tomato', display_name: 'Tomato' }] })
    render(<Harvests />)
    toLog() // S4 arrival default is Totals
    await waitFor(() => expect(screen.getByText('Genovese')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /filter by crop/i }))
    fireEvent.click(await screen.findByRole('option', { name: /^Tomato/ }))
    await waitFor(() => expect(screen.queryByText('Genovese')).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: /clear crop filter/i }))
    // unfiltered again — basil returns and the pill is gone
    await waitFor(() => expect(screen.getByText('Genovese')).toBeTruthy())
    expect(screen.queryByRole('button', { name: /clear crop filter/i })).toBeNull()
  })

  it('filters the log by project via the picker', async () => {
    mockRoutes({ entries: TWO_CROPS, projects: [{ id: 'pr2', name: 'Back Bed' }, { id: 'pr1', name: 'Front Bed' }] })
    render(<Harvests />)
    toLog() // S4 arrival default is Totals
    await waitFor(() => expect(screen.getByText('Sungold')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /filter by project/i }))
    fireEvent.click(await screen.findByRole('option', { name: /Front Bed/ }))

    await waitFor(() => expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes('project=pr1'))).toBe(true))
    // only the pr1 (tomato) entry survives
    await waitFor(() => expect(screen.queryByText('Genovese')).toBeNull())
    expect(screen.getByText('Sungold')).toBeTruthy()
    expect(screen.getByRole('button', { name: /clear project filter/i })).toBeTruthy()
  })

  it('shows a clear-filters affordance when a filter yields no matches', async () => {
    // only tomato entries exist, but basil is a pickable crop → picking it empties the log
    mockRoutes({ entries: [TWO_CROPS[0]], cropList: [{ crop_type_slug: 'basil', display_name: 'Basil' }] })
    render(<Harvests />)
    toLog() // S4 arrival default is Totals
    await waitFor(() => expect(screen.getByText('Sungold')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /filter by crop/i }))
    fireEvent.click(await screen.findByRole('option', { name: /^Basil/ }))

    await waitFor(() => expect(screen.getByText(/No harvests match these filters/i)).toBeTruthy())
    fireEvent.click(screen.getByText('Clear filters'))
    await waitFor(() => expect(screen.getByText('Sungold')).toBeTruthy())
  })

  it('expands a Totals crop row in place to show varieties + first pick', async () => {
    const crops = [{
      crop_type_slug: 'tomato', crop_name: 'Tomato',
      units: [{ unit: 'count', unit_key: 'count', total: 6, count: 2 }], unquantified: 1,
      varieties: [
        { variety_id: 'v1', variety_name: 'Sungold', units: [{ unit: 'count', unit_key: 'count', total: 4, count: 1 }], unquantified: 0 },
        { variety_id: 'v2', variety_name: 'Brandywine', units: [{ unit: 'count', unit_key: 'count', total: 2, count: 1 }], unquantified: 0 },
      ],
    }]
    const firstPick = [{ plant_id: 'p1', planting_name: 'Bed A tomato', crop_type_slug: 'tomato', first_pick_date: '2026-06-14' }]
    mockRoutes({ entries: [TWO_CROPS[0]], crops, firstPick })
    render(<Harvests />)
    // S4: arrival IS Totals now — wait on the crop row directly (setup simplified, assertions intact)
    await waitFor(() => expect(screen.getByRole('button', { name: /Tomato/ })).toBeTruthy())
    expect(screen.queryByText('Brandywine')).toBeNull() // collapsed — no variety sub-rows yet

    fireEvent.click(screen.getByRole('button', { name: /Tomato/ }))
    expect(screen.getByText('Brandywine')).toBeTruthy() // expanded variety sub-row
    expect(screen.getByText(/First pick Jun 14/)).toBeTruthy()
    expect(screen.getByText(/See in log/)).toBeTruthy()
  })

  it('jumps from a Totals crop row to the crop-filtered Log via "See in log"', async () => {
    const crops = [{ crop_type_slug: 'tomato', crop_name: 'Tomato', units: [{ unit: 'count', unit_key: 'count', total: 4, count: 1 }], unquantified: 0, varieties: [] }]
    mockRoutes({ entries: TWO_CROPS, crops })
    render(<Harvests />)
    // S4: arrival IS Totals now — start from the crop row (setup simplified, assertions intact)
    fireEvent.click(await screen.findByRole('button', { name: /Tomato/ }))
    fireEvent.click(screen.getByText(/See in log/))

    // back in the Log, filtered to tomato: basil gone, crop pill present
    await waitFor(() => expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes('crop=tomato'))).toBe(true))
    await waitFor(() => expect(screen.getByText('Sungold')).toBeTruthy())
    expect(screen.queryByText('Genovese')).toBeNull()
    expect(screen.getByRole('button', { name: /clear crop filter/i })).toBeTruthy()
  })

  it('seeds the crop filter from ?crop= in the URL (S4 deep link from EventNew / a planting)', async () => {
    searchParamsRef.current = new URLSearchParams('crop=basil')
    mockRoutes({ entries: TWO_CROPS, cropList: [{ crop_type_slug: 'basil', display_name: 'Basil' }] })
    render(<Harvests />)
    // lands already filtered to basil: the query carries crop=basil, tomato entry absent
    await waitFor(() => expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes('crop=basil'))).toBe(true))
    await waitFor(() => expect(screen.getByText('Genovese')).toBeTruthy())
    expect(screen.queryByText('Sungold')).toBeNull()
    // the pill resolves its label from the option list and offers a clear
    expect(screen.getByRole('button', { name: /clear crop filter/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Crop: Basil\. Change filter/i })).toBeTruthy()
  })

  // ── V4-HARVDEFAULT-001 arrival pins (design §2a / §6-S4) ─────────────────────────────────────────
  // Both halves of the visible pin, or a blank page passes: a Totals-only element PRESENT and a
  // Log-only element ABSENT. Mutation targets: revert the view init to unconditional 'log' → this
  // fails; init 'totals' under ?crop= → the ?crop= pin above fails.
  it('a BARE arrival lands on Totals: crop row visible, Log entry absent, Totals segment checked', async () => {
    mockRoutes({ entries: TWO_CROPS, crops: [TOMATO_CROP] })
    render(<Harvests />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Tomato/ })).toBeTruthy()) // Totals-only crop row
    expect(screen.queryByText('Sungold')).toBeNull() // Log-only entry text absent
    expect(screen.getByRole('radio', { name: 'Totals' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('radio', { name: 'Log' }).getAttribute('aria-checked')).toBe('false')
  })

  it('a BARE arrival fetches the current season and carries NO crop/project param', async () => {
    mockRoutes({ entries: TWO_CROPS, crops: [TOMATO_CROP] })
    render(<Harvests />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Tomato/ })).toBeTruthy())
    const cur = currentGrowYear(new Date())
    const entryCalls = harvestCalls().filter((u) => u.includes('include=entries'))
    expect(entryCalls.length).toBeGreaterThan(0)
    for (const u of entryCalls) {
      expect(u).toContain(`timeframe=season:${cur}`)
      expect(u).not.toMatch(/[?&]crop=/)
      expect(u).not.toMatch(/[?&]project=/)
    }
  })

  it('a ?crop= arrival keeps timeframe ALL TIME (boss C1 — the "All harvests →" contract)', async () => {
    searchParamsRef.current = new URLSearchParams('crop=basil')
    mockRoutes({ entries: TWO_CROPS, cropList: [{ crop_type_slug: 'basil', display_name: 'Basil' }] })
    render(<Harvests />)
    await waitFor(() => expect(screen.getByText('Genovese')).toBeTruthy())
    const cropCalls = harvestCalls().filter((u) => /[?&]crop=basil/.test(u))
    expect(cropCalls.length).toBeGreaterThan(0)
    for (const u of cropCalls) expect(u).not.toContain('timeframe=')
    // and the season chip is NOT active — All time is
    const group = screen.getByRole('group', { name: /timeframe/i })
    expect(within(group).getByRole('button', { name: 'All time' }).getAttribute('aria-pressed')).toBe('true')
  })

  // ── V4-HARVESTVIEW-001 S4: season chip + grow-year sheet (design §2b / §6-S4) ───────────────────
  it('season chip opens the grow-year sheet, relabels with the chosen season, stays active in BOTH views', async () => {
    const cur = currentGrowYear(new Date())
    mockRoutes({
      entries: TWO_CROPS, crops: [TOMATO_CROP],
      firstPick: [{ plant_id: 'p9', planting_name: 'Old bed', crop_type_slug: 'tomato', first_pick_date: `${cur - 2}-06-14` }],
    })
    render(<Harvests />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Tomato/ })).toBeTruthy())
    const group = screen.getByRole('group', { name: /timeframe/i })
    const chip = within(group).getByRole('button', { name: 'This season' })
    expect(chip.getAttribute('aria-pressed')).toBe('true') // season default active on bare arrival

    fireEvent.click(chip) // the chip ALWAYS opens the sheet — even while active
    // universe = continuous range from the earliest first_pick grow-year (unfiltered source)
    const opts = await screen.findAllByRole('option')
    expect(opts.map((o) => o.textContent)).toEqual([
      expect.stringContaining('This season'),
      expect.stringContaining(`${cur - 1} season`),
      expect.stringContaining(`${cur - 2} season`),
    ])
    fireEvent.click(screen.getByRole('option', { name: new RegExp(`${cur - 1} season`) }))

    // chip relabels + stays visibly active; the fetch now carries the chosen season
    const relabeled = within(group).getByRole('button', { name: `${cur - 1} season` })
    expect(relabeled.getAttribute('aria-pressed')).toBe('true')
    await waitFor(() => expect(harvestCalls().some((u) => u.includes(`timeframe=season:${cur - 1}`))).toBe(true))

    // toggle to Log — the SAME chip row is above both views, still relabeled + active
    toLog()
    expect(within(screen.getByRole('group', { name: /timeframe/i })).getByRole('button', { name: `${cur - 1} season` }).getAttribute('aria-pressed')).toBe('true')

    // universe stays complete while a past season is active (the self-collapse regression)
    fireEvent.click(relabeled)
    const opts2 = await screen.findAllByRole('option')
    expect(opts2.length).toBe(3)
  })

  // ── V4-HARVESTVIEW-001 S4: per-crop sparkline (design §2b / §6-S4) ──────────────────────────────
  it('renders one sparkline mark per weekly bucket, and NOTHING when crops[].weekly is absent', async () => {
    const cur = currentGrowYear(new Date())
    const withWeekly = {
      ...TOMATO_CROP,
      weekly: [
        { week_start: `${cur - 1}-12-01`, count: 2 },
        { week_start: `${cur}-06-01`, count: 5 },
        { week_start: `${cur}-06-08`, count: 1 },
      ],
    }
    const withoutWeekly = { crop_type_slug: 'basil', crop_name: 'Basil', units: [{ unit: 'bunch', unit_key: 'bunch', total: 2, count: 1 }], unquantified: 0, varieties: [] }
    mockRoutes({ entries: TWO_CROPS, crops: [withoutWeekly, withWeekly] })
    render(<Harvests />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Tomato/ })).toBeTruthy())
    // N marks === fixture weekly length (mark count is the jsdom-falsifiable half; height is device)
    expect(screen.getAllByTestId('sparkline-mark').length).toBe(3)
    // absence branch: exactly ONE sparkline on the page — Basil (older-Lambda shape) renders none
    expect(screen.getAllByTestId('sparkline').length).toBe(1)
  })

  it('under All time the sparkline windows to the CURRENT season', async () => {
    const cur = currentGrowYear(new Date())
    const crop = {
      ...TOMATO_CROP,
      weekly: [
        { week_start: `${cur - 2}-06-01`, count: 5 }, // prior season — outside the window
        { week_start: `${cur - 1}-12-01`, count: 2 }, // current grow-year (Nov–Oct)
      ],
    }
    mockRoutes({ entries: TWO_CROPS, crops: [crop] })
    render(<Harvests />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Tomato/ })).toBeTruthy())
    fireEvent.click(within(screen.getByRole('group', { name: /timeframe/i })).getByRole('button', { name: 'All time' }))
    await waitFor(() => expect(screen.getAllByTestId('sparkline-mark').length).toBe(1))
  })

  // ── V4-HARVDEFAULT-001: canon harvest-view §5 off-season re-anchor ──────────────────────────────
  it('a bare arrival re-anchors to the LAST COMPLETED season when the garden reads off-season', async () => {
    const cur = currentGrowYear(new Date())
    const OLD = addDays(TODAY, -45) // newest harvest >30 days ago
    mockRoutes({
      entries: [{ ...TWO_CROPS[0], day_key: OLD, event_date: `${OLD}T12:00:00Z` }],
      crops: [TOMATO_CROP],
      firstPick: [{ plant_id: 'p9', planting_name: 'Old bed', crop_type_slug: 'tomato', first_pick_date: `${cur - 2}-06-14` }],
    })
    render(<Harvests />)
    await waitFor(() => expect(harvestCalls().some((u) => u.includes(`timeframe=season:${cur - 1}`))).toBe(true))
    const group = screen.getByRole('group', { name: /timeframe/i })
    await waitFor(() => expect(within(group).getByRole('button', { name: `${cur - 1} season` }).getAttribute('aria-pressed')).toBe('true'))
  })

  it('stays on the current season while harvests are recent (in season)', async () => {
    const cur = currentGrowYear(new Date())
    mockRoutes({
      entries: TWO_CROPS, // newest harvest yesterday
      crops: [TOMATO_CROP],
      firstPick: [{ plant_id: 'p9', planting_name: 'Old bed', crop_type_slug: 'tomato', first_pick_date: `${cur - 2}-06-14` }],
    })
    render(<Harvests />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Tomato/ })).toBeTruthy())
    // options + snapshot have landed by now; the re-anchor effect had its chance
    await waitFor(() => expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(3))
    expect(harvestCalls().some((u) => u.includes(`timeframe=season:${cur - 1}`))).toBe(false)
    expect(within(screen.getByRole('group', { name: /timeframe/i })).getByRole('button', { name: 'This season' }).getAttribute('aria-pressed')).toBe('true')
  })
})
