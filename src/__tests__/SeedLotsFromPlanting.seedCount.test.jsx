// V5-SEEDQTY-001 — the seed count and weight on the planting's own seed-lot list.
//
// WHY THIS SURFACE NEEDED THE CHANGE. The meta line rendered `${formatQty(quantity_on_hand)} on
// hand`, and quantity_on_hand now means CONTAINERS: every lot saved through the new flow says
// "1 on hand" and always will. Before the change that number WAS the seed count (which is the
// "185.000 packet" defect this ticket exists to fix), so leaving the line alone would not have kept
// the display honest — it would have quietly replaced a real number with a constant.
//
// 2026-09-25 — AND THE CONSTANT IS GONE. The first pass rendered the count BESIDE "1 on hand" ("a
// widening, not a swap"); Dave, of the same "1 packet" on the lot's own page: "not correct ever".
// Every row on this list is a saved lot, and every saved lot is one jar, so the line now leaves the
// one jar out, says "used up" for 0, and keeps "N on hand" only for another amount (prod holds one
// saved lot at 272 'each'). The count reads through seedLots.seedCountLabel, so an estimate says
// "approx." — the route projects seed_count_estimated since the same day. The assertions below that
// read "… · 1 on hand" before that change were rewritten to the new line; that is the intended change.
//
// THE ABSENT CASE: a row without the measure keys (an older Lambda, a stubbed read) must render no
// invented number. Every fixture below that omits them is that state.
//
// Renders the component directly rather than through PlantingDetail: the sibling
// PlantingDetail.seedLots.test.jsx owns the section's mounting, heading and failure branch, and
// re-testing those here would make this file fail for reasons that are not about the count.
// No jest-dom (L-182).
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import SeedLotsFromPlanting, { lotContainerLabel } from '../components/planting/SeedLotsFromPlanting.jsx'

// A saved lot as the route returns it: one jar, as a numeric STRING ('1.000'), like every numeric.
const LOT = {
  id: 'lot-a', name: 'Jar on the shelf', seed_stage: 'stored', variety_name: null,
  quantity_on_hand: '1.000', created_at: '2026-09-01',
}
const show = (...lots) => render(
  <MemoryRouter><SeedLotsFromPlanting lots={lots} failed={false} /></MemoryRouter>,
)
// Every meta line on the list, in order — the one assertion shape that also proves nothing EXTRA is
// printed (a stray "1 on hand" would add to a line, not replace it).
const metaLines = () => Array.from(document.querySelectorAll('li'))
  .map((li) => li.querySelector('div')?.textContent ?? null)

describe('SeedLotsFromPlanting — the seed count (V5-SEEDQTY-001)', () => {
  it('renders the count, and the one jar every saved lot is says nothing', () => {
    show({ ...LOT, seed_count: 185, seed_count_estimated: false })
    expect(metaLines()).toEqual(['Stored · 185 seeds'])
  })

  it('says nothing at all when the measure keys have not arrived — and still no "1 on hand"', () => {
    // The green control for every assertion below: a lot with no measure cannot start rendering an
    // invented one, and the container convention is not printed in its place.
    show(LOT)
    expect(metaLines()).toEqual(['Stored'])
    expect(document.body.textContent).not.toMatch(/seeds?\b|on hand/)
  })

  it('distinguishes a counted-empty jar from one nobody has counted', () => {
    // 0 is "I counted, there are none", NULL is "nobody has looked" — the reason seed_count is nullable.
    show({ ...LOT, id: 'lot-zero', seed_count: 0, seed_count_estimated: false },
      { ...LOT, id: 'lot-null', seed_count: null, seed_count_estimated: null })
    expect(metaLines()).toEqual(['Stored · 0 seeds', 'Stored'])
  })

  it('counts one seed as a seed', () => {
    show({ ...LOT, seed_count: 1, seed_count_estimated: false })
    expect(metaLines()).toEqual(['Stored · 1 seed'])
  })

  it('an ESTIMATED count says "approx." — a packet\'s number is not a counted one', () => {
    show({ ...LOT, id: 'lot-est', seed_count: 200, seed_count_estimated: true },
      { ...LOT, id: 'lot-counted', seed_count: 185, seed_count_estimated: false })
    expect(metaLines()).toEqual(['Stored · approx. 200 seeds', 'Stored · 185 seeds'])
  })

  it('a count whose basis did not arrive reads as counted, the historical default — never "approx."', () => {
    show({ ...LOT, seed_count: 185 })
    expect(metaLines()).toEqual(['Stored · 185 seeds'])
  })

  it('renders a weight through formatSeedWeight, never through formatQty', () => {
    // formatQty is String(Math.round(n)): half a gram would render as a bare "1". The mg case is the
    // one that proves the weight took the right helper — no rounding of any kind produces "50 mg".
    show({ ...LOT, id: 'lot-g', seed_weight_g: '28.350' }, { ...LOT, id: 'lot-mg', seed_weight_g: 0.05 })
    expect(metaLines()).toEqual(['Stored · 28.35 g', 'Stored · 50 mg'])
  })

  it('carries count and weight together, count first', () => {
    show({ ...LOT, variety_name: 'Cinderella', seed_count: 185, seed_count_estimated: true, seed_weight_g: '28.350' })
    expect(metaLines()).toEqual(['Cinderella · Stored · approx. 185 seeds · 28.35 g'])
  })

  it('keeps a measured zero weight and drops an unrecorded one', () => {
    show({ ...LOT, id: 'lot-0g', seed_weight_g: 0 }, { ...LOT, id: 'lot-nog', seed_weight_g: null })
    expect(metaLines()).toEqual(['Stored · 0 g', 'Stored'])
  })
})

describe('SeedLotsFromPlanting — the container (2026-09-25)', () => {
  it('a used-up lot (0) says "used up", never "0 on hand"', () => {
    show({ ...LOT, quantity_on_hand: '0.000', seed_count: 185, seed_count_estimated: false })
    expect(metaLines()).toEqual(['Stored · 185 seeds · used up'])
    expect(document.body.textContent).not.toMatch(/on hand/)
  })

  it('the 272-each lot keeps its number — any amount but the one jar is a real one', () => {
    // Prod's "Green Flesh Honeydew seed seed 2026": 272 'each' beside a count of 247.
    show({ ...LOT, name: 'Green Flesh Honeydew seed seed 2026', quantity_on_hand: '272.000', seed_count: 247, seed_count_estimated: false })
    expect(metaLines()).toEqual(['Stored · 247 seeds · 272 on hand'])
  })

  it('never recorded (null) says nothing — not "used up", not "0"', () => {
    show({ ...LOT, quantity_on_hand: null })
    expect(metaLines()).toEqual(['Stored'])
  })
})

describe('lotContainerLabel', () => {
  it.each([
    [1, null], ['1.000', null], ['1', null],
    [0, 'used up'], ['0.000', 'used up'],
    [272, '272 on hand'], ['272.000', '272 on hand'], [2, '2 on hand'],
    // EXACT, not rounded (review MINOR-5): the branch is decided on the exact value, so it prints it.
    // formatQty would have read 0.5 as "1 on hand" and 0.4 as "0 on hand", beside "used up" for 0.
    [0.5, '0.5 on hand'], ['0.400', '0.4 on hand'], ['2.500', '2.5 on hand'],
    [null, null], [undefined, null], ['', null],
  ])('%j -> %j', (q, want) => {
    expect(lotContainerLabel(q)).toBe(want)
  })
})
