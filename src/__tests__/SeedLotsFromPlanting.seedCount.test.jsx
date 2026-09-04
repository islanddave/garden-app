// V5-SEEDQTY-001 — the seed count and weight on the planting's own seed-lot list.
//
// WHY THIS SURFACE NEEDED THE CHANGE. The meta line rendered `${formatQty(quantity_on_hand)} on
// hand`, and quantity_on_hand now means CONTAINERS: every lot saved through the new flow says
// "1 on hand" and always will. Before the change that number WAS the seed count (which is the
// "185.000 packet" defect this ticket exists to fix), so leaving the line alone would not have kept
// the display honest — it would have quietly replaced a real number with a constant.
//
// THE ABSENT CASE IS THE LIVE ONE. lambda/plants/index.js's seed-lots SELECT names its columns
// explicitly, so until it is widened these keys do not arrive at all. Every fixture below that omits
// them is that state, not a contrived one.
//
// Renders the component directly rather than through PlantingDetail: the sibling
// PlantingDetail.seedLots.test.jsx owns the section's mounting, heading and failure branch, and
// re-testing those here would make this file fail for reasons that are not about the count.
// No jest-dom (L-182).
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import SeedLotsFromPlanting from '../components/planting/SeedLotsFromPlanting.jsx'

const LOT = {
  id: 'lot-a', name: 'Jar on the shelf', seed_stage: 'stored', variety_name: null,
  quantity_on_hand: 1, created_at: '2026-09-01',
}
const show = (...lots) => render(
  <MemoryRouter><SeedLotsFromPlanting lots={lots} failed={false} /></MemoryRouter>,
)

describe('SeedLotsFromPlanting — the seed count (V5-SEEDQTY-001)', () => {
  it('renders the count beside the container count, not instead of it', () => {
    show({ ...LOT, seed_count: 185 })
    expect(screen.getByText('Stored · 185 seeds · 1 on hand')).toBeTruthy()
  })

  it('says nothing at all when the column has not arrived — the pre-widening shape', () => {
    // The green control for every assertion above and below: the line is byte-identical to what
    // shipped when the SELECT does not carry the columns, so a lot with no measure cannot start
    // rendering an invented one.
    show(LOT)
    expect(screen.getByText('Stored · 1 on hand')).toBeTruthy()
    expect(screen.queryByText(/seeds/)).toBeNull()
  })

  it('distinguishes a counted-empty jar from one nobody has counted', () => {
    // Same reading the quantity line already takes of its own NULL, and the reason seed_count is
    // nullable: 0 is "I counted, there are none", NULL is "nobody has looked".
    show({ ...LOT, id: 'lot-zero', seed_count: 0 }, { ...LOT, id: 'lot-null', seed_count: null })
    expect(screen.getByText('Stored · 0 seeds · 1 on hand')).toBeTruthy()
    expect(screen.getByText('Stored · 1 on hand')).toBeTruthy()
  })

  it('counts one seed as a seed', () => {
    show({ ...LOT, seed_count: 1 })
    expect(screen.getByText('Stored · 1 seed · 1 on hand')).toBeTruthy()
  })

  it('renders a weight through formatSeedWeight, never through formatQty', () => {
    // formatQty is String(Math.round(n)): half a gram would render as a bare "1". The mg case is the
    // one that proves the weight took the right helper — no rounding of any kind produces "50 mg".
    show({ ...LOT, id: 'lot-g', seed_weight_g: '28.350' }, { ...LOT, id: 'lot-mg', seed_weight_g: 0.05 })
    expect(screen.getByText('Stored · 28.35 g · 1 on hand')).toBeTruthy()
    expect(screen.getByText('Stored · 50 mg · 1 on hand')).toBeTruthy()
  })

  it('carries count and weight together, count first', () => {
    show({ ...LOT, variety_name: 'Cinderella', seed_count: 185, seed_weight_g: '28.350' })
    expect(screen.getByText('Cinderella · Stored · 185 seeds · 28.35 g · 1 on hand')).toBeTruthy()
  })

  it('keeps a measured zero weight and drops an unrecorded one', () => {
    show({ ...LOT, id: 'lot-0g', seed_weight_g: 0 }, { ...LOT, id: 'lot-nog', seed_weight_g: null })
    expect(screen.getByText('Stored · 0 g · 1 on hand')).toBeTruthy()
    expect(screen.getByText('Stored · 1 on hand')).toBeTruthy()
  })
})
