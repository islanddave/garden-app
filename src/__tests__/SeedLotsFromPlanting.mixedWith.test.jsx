// V5-SEEDMULTIPARENT-001 release 2b — the planting page's seed list knows the jar's OTHER plantings.
//
// GET /api/plants/:id/seed-lots serves `other_parents` ([{ id, name, variety_name }], this planting left
// out); the list printed none of it. One other is named, more are counted. And the variety leaves the
// dot line when the lot name is the automatic one, by My seeds' test (rowTitle): it used to stay, since
// "<variety> — saved <year>" never equals the variety. The contract file carries no example for this
// route (seedMix.fixture.js says so), so the rows below are this test's own, in the Lambda's projection.
// Flag-off twin: SavedSeeds.multiParent.flagOff.test.jsx. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// SEED_MULTI_PARENT is held ON here whichever way the literal ships. These are the flag-on cases, and the
// release's forward undo is a build with the literal false (scripts/forward-undo.py), which must not
// redden them: `npm run test:flag-off:seed` is that rehearsal. featureFlags.test.js pins the literal.
vi.mock('../lib/featureFlags.js', async (importOriginal) => ({
  ...(await importOriginal()),
  get SEED_MULTI_PARENT() { return true },
}))

import SeedLotsFromPlanting, { mixedWithLine } from '../components/planting/SeedLotsFromPlanting.jsx'

const LOT = {
  id: 'lot-a', name: 'Alaska Mix + Jewel Mix Nasturtium — saved 2026', seed_stage: 'stored',
  variety_name: 'Alaska Mix + Jewel Mix Nasturtium', quantity_on_hand: '1.000', created_at: '2026-09-01',
  other_parents: [],
}
const ALASKA = { id: 'pl-alaska', name: 'Alaska Mix Nasturtium 1', variety_name: 'Alaska Mix Nasturtium' }
const JEWEL = { id: 'pl-jewel', name: 'Jewel pot', variety_name: 'Jewel Mix Nasturtium' }
const show = (...lots) => render(
  <MemoryRouter><SeedLotsFromPlanting lots={lots} failed={false} /></MemoryRouter>,
)
const lines = () => Array.from(document.querySelector('li').children).map((el) => el.textContent)

describe('SeedLotsFromPlanting — "Mixed with seed from"', () => {
  it('one other planting is named, under the lot name and above the dot line', () => {
    show({ ...LOT, other_parents: [ALASKA] })
    expect(screen.getByTestId('lot-mixed-with').textContent).toBe('Mixed with seed from Alaska Mix Nasturtium 1')
    expect(lines()).toEqual([LOT.name, 'Mixed with seed from Alaska Mix Nasturtium 1', 'Stored'])
  })

  it('two others are counted, with the real number', () => {
    show({ ...LOT, other_parents: [ALASKA, JEWEL] })
    expect(screen.getByTestId('lot-mixed-with').textContent).toBe('Mixed with seed from 2 other plantings')
  })

  it('three others say three', () => {
    expect(mixedWithLine([ALASKA, JEWEL, { id: 'pl-3', name: 'Third', variety_name: null }]))
      .toBe('Mixed with seed from 3 other plantings')
  })

  it('no others, or a row from before the key: no line', () => {
    show(LOT, { ...LOT, id: 'lot-b', other_parents: undefined })
    expect(screen.queryByTestId('lot-mixed-with')).toBeNull()
    expect(mixedWithLine(null)).toBeNull()
  })

  it('an other planting whose name did not come back is counted, never printed blank', () => {
    expect(mixedWithLine([{ id: 'pl-x', name: null, variety_name: null }])).toBe('Mixed with seed from 1 other planting')
  })
})

describe('SeedLotsFromPlanting — the variety on the dot line (UX W-4)', () => {
  it('leaves when the lot name is the automatic one', () => {
    show({ ...LOT, name: 'Sungold — saved 2026', variety_name: 'Sungold' })
    expect(lines()).toEqual(['Sungold — saved 2026', 'Stored'])
  })

  it('leaves when the lot is named exactly its variety (unchanged)', () => {
    show({ ...LOT, name: 'Sungold', variety_name: 'Sungold' })
    expect(lines()).toEqual(['Sungold', 'Stored'])
  })

  it('stays beside a name the gardener typed', () => {
    show({ ...LOT, name: 'Jar on the shelf', variety_name: 'Sungold' })
    expect(lines()).toEqual(['Jar on the shelf', 'Sungold · Stored'])
  })

  it('stays beside "Saved seed <year>", which is automatic but does not say the variety', () => {
    show({ ...LOT, name: 'Saved seed 2026', variety_name: 'Sungold' })
    expect(lines()).toEqual(['Saved seed 2026', 'Sungold · Stored'])
  })
})
