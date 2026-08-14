// V4-HARVESTQTY-001 — the rendered "Harvested" section on planting detail.
// Assertions go through getByRole (the a11y tree), never getByLabelText: an aria-label on a
// role-less div satisfies getByLabelText while being an a11y blackout to a screen reader (L-275).
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import HarvestFromPlanting, { growYearSlice } from '../components/planting/HarvestFromPlanting.jsx'

const PLANTING = {
  id: 'pl-1',
  name: 'Megatron Jalapeno',
  variety_ref: { id: 'v-1', name: 'Megatron', crop_type_slug: 'pepper' },
}

const TODAY = '2026-07-21'
const day = (n) => {
  const d = new Date(Date.UTC(2026, 6, 21 + n))
  return d.toISOString().slice(0, 10)
}

function payload(rows, unattributed = []) {
  return { plant_id: 'pl-1', time_zone: 'America/New_York', et_today: TODAY, rows, unattributed }
}

function renderSection(data) {
  const fetchMock = vi.fn(() => Promise.resolve(data))
  const utils = render(<HarvestFromPlanting planting={PLANTING} fetch={fetchMock} />)
  return { ...utils, fetchMock }
}

const cell = (rowName) => screen.getByRole('row', { name: rowName })

describe('HarvestFromPlanting', () => {
  it('scopes the read to THIS planting', async () => {
    const { fetchMock } = renderSection(payload([]))
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/events/harvest-summary?plant_id=pl-1'))
  })

  it('renders a two-unit summary without summing across classes, and never shows "count"', async () => {
    renderSection(payload([
      { id: 'h1', quantity: '30.000', unit: 'count', event_date: day(-1) },
      { id: 'h2', quantity: '8.000', unit: 'cup', event_date: day(-2) },
    ]))
    const recent = await screen.findByRole('row', { name: /Last 14 days/ })
    expect(recent.textContent).toContain('30 peppers')
    expect(recent.textContent).toContain('8 cups')
    expect(recent.textContent).not.toContain('count')
    expect(screen.queryByText(/\bcount\b/)).toBeNull()
  })

  it('renders a four-unit summary in deterministic order', async () => {
    renderSection(payload([
      { id: 'h1', quantity: '1.000', unit: 'bunch', event_date: day(0) },
      { id: 'h2', quantity: '4.000', unit: 'head', event_date: day(0) },
      { id: 'h3', quantity: '2.000', unit: 'cup', event_date: day(0) },
      { id: 'h4', quantity: '3.000', unit: 'count', event_date: day(0) },
    ]))
    const all = await screen.findByRole('row', { name: /All time/ })
    // quantity desc, unit asc: 4 head, 3 count, 2 cup, 1 bunch
    expect(all.textContent).toMatch(/4 heads.*3 peppers.*2 cups.*1 bunch/)
  })

  it('converts within the mass class and reports the dominant unit', async () => {
    renderSection(payload([
      { id: 'h1', quantity: '2.000', unit: 'lb', event_date: day(0) },
      { id: 'h2', quantity: '500.000', unit: 'g', event_date: day(0) },
    ]))
    const all = await screen.findByRole('row', { name: /All time/ })
    expect(all.textContent).toContain('3.1 lb')
    expect(all.textContent).not.toContain(' g')
  })

  it('excludes a harvest outside the 14-day window from Recent but keeps it in All time', async () => {
    renderSection(payload([
      { id: 'h1', quantity: '1.000', unit: 'cup', event_date: day(-13) },  // boundary — IN
      { id: 'h2', quantity: '5.000', unit: 'cup', event_date: day(-14) },  // boundary-1 — OUT
    ]))
    const recent = await screen.findByRole('row', { name: /Last 14 days/ })
    expect(recent.textContent).toContain('1 cup')
    expect(cell(/All time/).textContent).toContain('6 cups')
  })

  it('a soft-deleted harvest never reaches the client, so the summary reflects only live rows', async () => {
    // The endpoint filters harvest_log/event_log/plants deleted_at; the contract this asserts is
    // that the component sums exactly the rows it is given and invents nothing.
    renderSection(payload([{ id: 'h1', quantity: '2.000', unit: 'cup', event_date: day(0) }]))
    const all = await screen.findByRole('row', { name: /All time/ })
    expect(all.textContent).toContain('2 cups')
    expect(all.textContent).toContain('1 pick')
  })

  it('shows the unattributed count instead of quietly reading low', async () => {
    renderSection(payload(
      [{ id: 'h1', quantity: '2.000', unit: 'cup', event_date: day(0) }],
      [{ id: 'u1', quantity: '1.000', unit: 'cup', event_date: day(0) },
       { id: 'u2', quantity: '1.000', unit: 'cup', event_date: day(-1) }],
    ))
    expect(await screen.findByText(/\+2 harvests in this project not linked to a plant/)).toBeTruthy()
  })

  it('zero-harvest empty state', async () => {
    renderSection(payload([]))
    expect(await screen.findByText('Nothing harvested from this planting yet.')).toBeTruthy()
    expect(screen.queryByRole('row')).toBeNull()
  })

  it('surfaces unlinked harvests even when this planting has none of its own', async () => {
    renderSection(payload([], [{ id: 'u1', quantity: '1.000', unit: 'cup', event_date: day(0) }]))
    expect(await screen.findByText(/\+1 harvest in this project not linked to a plant/)).toBeTruthy()
  })

  it('shows a friendly error rather than throwing when the fetch fails', async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error('boom')))
    render(<HarvestFromPlanting planting={PLANTING} fetch={fetchMock} />)
    expect(await screen.findByText(/Couldn’t load harvests/)).toBeTruthy()
  })

  // ── V4-HARVESTSURF-001 remainder — the OBSERVED harvest window ────────────────────────────
  // Descriptive, not predictive. A predicted first-pick window was killed by measurement.
  it('renders the observed picking window when the history spans multiple days', async () => {
    renderSection(payload([
      { id: 'h1', quantity: '2.000', unit: 'lb', event_date: '2026-06-28' },
      { id: 'h2', quantity: '3.000', unit: 'lb', event_date: TODAY },
    ]))
    const win = await screen.findByTestId('harvest-window')
    expect(win.textContent).toMatch(/Picking over 24 days/)
  })

  it('does NOT render a window for a single-day history (the "Last picked" line covers it)', async () => {
    renderSection(payload([
      { id: 'h1', quantity: '2.000', unit: 'lb', event_date: TODAY },
    ]))
    // Wait for the section to settle before asserting an absence, or this passes vacuously.
    await screen.findByRole('row', { name: /All time/ })
    expect(screen.queryByTestId('harvest-window')).toBeNull()
  })

  it('does NOT render a window when the planting has no harvests', async () => {
    renderSection(payload([]))
    await waitFor(() => expect(screen.queryByTestId('harvest-window')).toBeNull())
  })

})

// ── V4-SEASONCONV-001 — the season bucket is the GROW year (Nov 1 – Oct 31) ───────────────────
//
// EVERY fixture below is SYNTHETIC, and that is load-bearing, not incidental. Measured live at
// c509fff on four independent bases (live rows, soft-deleted-visible, NY-local, UTC): prod has
// ZERO Nov or Dec harvest events — zero events of ANY type in Nov or Dec, ever; the whole corpus
// is Jun–Aug 2026. So real-shaped data CANNOT distinguish a calendar-year bucket from a grow-year
// one: a test built on prod-shaped rows passes identically against both implementations and proves
// nothing at all. The Nov/Dec rows here ARE the test. Each case below names the number the OLD
// calendar-year code would have produced, so a revert is visible rather than silent.
//
// Boundary coverage, in both directions: 2025-10-31 (below the floor), 2025-11-01 (the floor
// itself), 2025-12-20 (inside the overwinter tail), 2026-01-05 (the calendar-year rollover),
// 2026-10-31 (the ceiling, inclusive) and 2026-11-01 (the ceiling, exclusive — it opens the NEXT
// season).
describe('HarvestFromPlanting — grow-year season bucket (V4-SEASONCONV-001)', () => {
  const seasonPayload = (etToday, rows, unattributed = []) => ({
    plant_id: 'pl-1', time_zone: 'America/New_York', et_today: etToday, rows, unattributed,
  })
  const cups = (id, q, date) => ({ id, quantity: `${q}.000`, unit: 'cup', event_date: date })

  it('labels the row "<grow year> season", never "This year (<calendar year>)"', async () => {
    renderSection(seasonPayload('2026-08-13', [cups('h1', 1, '2026-07-04')]))
    expect(await screen.findByRole('row', { name: /2026 season/ })).toBeTruthy()
    expect(screen.queryByRole('row', { name: /This year/ })).toBeNull()
  })

  it('counts the PRIOR calendar year\'s Nov/Dec picks into this season (calendar-year dropped them)', async () => {
    renderSection(seasonPayload('2026-08-13', [
      cups('h1', 4, '2025-10-31'), // grow-year 2025 — OUT of both buckets, the floor-1 boundary
      cups('h2', 1, '2025-11-01'), // the floor itself — IN under grow-year, OUT under calendar-year
      cups('h3', 2, '2025-12-20'), // overwinter tail — IN under grow-year, OUT under calendar-year
      cups('h4', 8, '2026-01-05'), // IN under both
    ]))
    const season = await screen.findByRole('row', { name: /2026 season/ })
    // Grow-year: 1 + 2 + 8 = 11 cups over 3 picks. Calendar-year 2026 would have said 8 cups / 1 pick.
    expect(season.textContent).toContain('11 cups')
    expect(season.textContent).toContain('3 picks')
    expect(season.textContent).not.toContain('8 cups')
    // All time is untouched by the convergence — the Oct 31 row is still counted there.
    expect(cell(/All time/).textContent).toContain('15 cups')
    expect(cell(/All time/).textContent).toContain('4 picks')
  })

  it('pushes a Nov 1 pick into the NEXT season and leaves Oct 31 in the outgoing one', async () => {
    renderSection(seasonPayload('2026-12-10', [
      cups('h1', 5, '2026-10-31'), // ceiling, inclusive — last day of the 2026 season
      cups('h2', 3, '2026-11-01'), // ceiling, exclusive — first day of the 2027 season
      cups('h3', 2, '2026-12-10'),
    ]))
    // Grow-year 2027 = 3 + 2 = 5 cups / 2 picks. Calendar-year 2026 would have said 10 cups / 3 picks.
    const season = await screen.findByRole('row', { name: /2027 season/ })
    expect(season.textContent).toContain('5 cups')
    expect(season.textContent).toContain('2 picks')
    expect(screen.queryByRole('row', { name: /2026 season/ })).toBeNull()
    expect(cell(/All time/).textContent).toContain('10 cups')
  })

  it('is a provable no-op for a Jun–Aug corpus — the only shape prod actually has today', async () => {
    // This is the case that proves nothing on its own. It is here to pin the claim that shipping
    // the convergence moves NO number Dave can currently see, not to demonstrate the change.
    renderSection(seasonPayload('2026-08-13', [
      cups('h1', 2, '2026-06-28'), cups('h2', 3, '2026-07-15'), cups('h3', 4, '2026-08-01'),
    ]))
    const season = await screen.findByRole('row', { name: /2026 season/ })
    expect(season.textContent).toContain('9 cups')
    expect(cell(/All time/).textContent).toContain('9 cups')
  })
})

describe('growYearSlice (V4-SEASONCONV-001)', () => {
  const row = (date) => ({ event_date: date, quantity: '1.000', unit: 'cup' })

  it('partitions on Nov 1: floor inclusive, ceiling exclusive', () => {
    const out = growYearSlice([
      row('2025-10-31'), row('2025-11-01'), row('2025-12-31'),
      row('2026-01-01'), row('2026-10-31'), row('2026-11-01'),
    ], '2026-08-13', 'America/New_York')
    expect(out.growYear).toBe(2026)
    expect(out.rows.map(r => r.event_date)).toEqual([
      '2025-11-01', '2025-12-31', '2026-01-01', '2026-10-31',
    ])
  })

  it('derives the grow year from the ET day of `today`, so a Dec today is the FOLLOWING season', () => {
    expect(growYearSlice([], '2026-12-01').growYear).toBe(2027)
    expect(growYearSlice([], '2026-11-01').growYear).toBe(2027)
    expect(growYearSlice([], '2026-10-31').growYear).toBe(2026)
  })

  it('projects a timestamptz row into ET before bucketing — the Oct 31 23:00 ET trap', () => {
    // 2025-11-01T03:00Z is Oct 31 23:00 EDT: the PREVIOUS grow year. Parsing it as UTC would put it
    // in the new season, which is exactly the hazard growYear.js's header documents.
    const out = growYearSlice([
      { event_date: '2025-11-01T03:00:00Z' },  // ET 2025-10-31 — OUT
      { event_date: '2025-11-01T04:30:00Z' },  // ET 2025-11-01 — IN
    ], '2026-08-13', 'America/New_York')
    expect(out.rows.map(r => r.event_date)).toEqual(['2025-11-01T04:30:00Z'])
  })

  it('yields an empty slice with a null grow year when there is no server today (no client clock)', () => {
    expect(growYearSlice([row('2026-07-01')], null)).toEqual({ growYear: null, rows: [] })
    expect(growYearSlice([row('2026-07-01')], '')).toEqual({ growYear: null, rows: [] })
    expect(growYearSlice([row('2026-07-01')], 'not-a-date')).toEqual({ growYear: null, rows: [] })
  })

  it('drops undated and unparseable rows rather than bucketing them', () => {
    const out = growYearSlice([row('2026-07-01'), row(null), row('junk'), {}], '2026-08-13')
    expect(out.rows).toHaveLength(1)
  })

  it('tolerates a non-array rows argument', () => {
    expect(growYearSlice(null, '2026-08-13').rows).toEqual([])
    expect(growYearSlice(undefined, '2026-08-13').rows).toEqual([])
  })
})
