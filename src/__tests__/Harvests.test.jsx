import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

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

beforeEach(() => { fetchSpy.mockReset(); searchParamsRef.current = new URLSearchParams() })

// Route the mocked apiFetch by URL: /api/projects → project rows; unfiltered `include=aggregates`
// (no entries) → the picker's crop universe; everything else (main + snapshot) → harvest entries,
// honoring a crop=/project= query param so the tests can drive the filtered-empty path.
function mockRoutes({ entries = [], crops = [], other = [], firstPick = [], cropList = [], projects = [] }) {
  fetchSpy.mockImplementation((url) => {
    const u = String(url)
    if (u === '/api/projects') return Promise.resolve(projects)
    if (u.includes('include=aggregates') && !u.includes('entries')) {
      return Promise.resolve({ aggregates: { crop_list: cropList, crops: [], other: [] } })
    }
    const cropM = /[?&]crop=([^&]+)/.exec(u)
    const projM = /[?&]project=([^&]+)/.exec(u)
    let rows = entries
    if (cropM) rows = rows.filter((e) => e.crop_type_slug === decodeURIComponent(cropM[1]))
    if (projM) rows = rows.filter((e) => e.project_id === decodeURIComponent(projM[1]))
    return Promise.resolve({ entries: rows, aggregates: { crops, other, first_pick: firstPick }, cursor: null })
  })
}

const TWO_CROPS = [
  { event_id: 'e1', day_key: '2026-07-20', event_date: '2026-07-20T12:00:00Z', plant_id: 'p1', project_id: 'pr1', crop_type_slug: 'tomato', crop_name: 'Tomato', variety_name: 'Sungold', quantity: 4, unit: 'count', quality_rating: 4, harvest_log_id: 'h1', photos: [] },
  { event_id: 'e2', day_key: '2026-07-19', event_date: '2026-07-19T12:00:00Z', plant_id: 'p2', project_id: 'pr2', crop_type_slug: 'basil', crop_name: 'Basil', variety_name: 'Genovese', quantity: 2, unit: 'bunch', quality_rating: 5, harvest_log_id: 'h2', photos: [] },
]

describe('Harvests page', () => {
  it('shows the first-run empty state when there are no harvests', async () => {
    fetchSpy.mockResolvedValue({ entries: [], aggregates: { crops: [], other: [] }, cursor: null })
    render(<Harvests />)
    await waitFor(() => expect(screen.getByText(/harvests will collect here/i)).toBeTruthy())
  })

  it('renders a day-grouped entry (Log) and per-crop totals (Totals)', async () => {
    fetchSpy.mockResolvedValue({
      entries: [{
        event_id: 'e1', day_key: '2026-07-20', event_date: '2026-07-20T12:00:00Z',
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
    await waitFor(() => expect(screen.getByText('Sungold')).toBeTruthy()) // Log entry first

    fireEvent.click(screen.getByText('Totals'))
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
    await waitFor(() => expect(screen.getByText('Genovese')).toBeTruthy())

    fireEvent.click(screen.getByText('Totals'))
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
})
