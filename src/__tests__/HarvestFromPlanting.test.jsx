// V4-HARVESTQTY-001 — the rendered "Harvested" section on planting detail.
// Assertions go through getByRole (the a11y tree), never getByLabelText: an aria-label on a
// role-less div satisfies getByLabelText while being an a11y blackout to a screen reader (L-275).
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import HarvestFromPlanting from '../components/planting/HarvestFromPlanting.jsx'

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
})
