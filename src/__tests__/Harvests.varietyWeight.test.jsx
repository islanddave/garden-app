// V4-HARVGRAIN-001 — the variety/planting weight grain and the honesty machinery around it, on the
// Harvests Totals surface.
//
// The Lambda-side guard (lambda/harvests/harvest-weight-grain.test.js) proves the numbers merge onto
// the right rows. These prove the page renders them, and — the part that is easy to lose — that the
// new WEIGHT-DESCENDING order never arrives without a visible basis. Estimated grams are a flat
// per-variety constant (Cherry Falls resolves to 6.04 g/unit on every one of its 36 live rows,
// min = max), so an all-≈ ranking is the pick count rescaled; shipped bare it would read as a yield
// finding it cannot support.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const { fetchSpy, searchParamsRef } = vi.hoisted(() => ({
  fetchSpy: vi.fn(), searchParamsRef: { current: new URLSearchParams() },
}))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useSearchParams: () => [searchParamsRef.current, () => {}],
}))

import Harvests from '../pages/Harvests.jsx'

beforeEach(() => { fetchSpy.mockReset(); searchParamsRef.current = new URLSearchParams() })

const w = (o) => ({ grams: 0, measured_grams: 0, estimated_grams: 0, measured: 0, estimated: 0, unweighed: 0, ...o })

// The live tomato shape: the server has already ordered varieties by grams, so Moskvich (mostly
// weighed, 8.2 kg over 27 picks) leads Cherry Falls (all modelled, 763 g over 36 picks) even though
// Cherry Falls has more picks and sorts first alphabetically.
const MOSKVICH = w({ grams: 8233, measured_grams: 8200, estimated_grams: 33, measured: 26, estimated: 1 })
const CHERRY_FALLS = w({ grams: 763, estimated_grams: 763, estimated: 36 })

const TOMATO = {
  crop_type_slug: 'tomato', crop_name: 'Tomato', unquantified: 0,
  units: [{ unit: 'count', unit_key: 'count', total: 193, count: 63 }],
  weight: w({ grams: 27712, measured_grams: 13200, estimated_grams: 14512, measured: 142, estimated: 125 }),
  varieties: [
    { variety_id: 'v-moskvich', variety_name: 'Moskvich Heirloom', unquantified: 0, units: [{ unit: 'count', unit_key: 'count', total: 65, count: 27 }], weight: MOSKVICH },
    { variety_id: 'v-cherryfalls', variety_name: 'Cherry Falls', unquantified: 0, units: [{ unit: 'count', unit_key: 'count', total: 128, count: 36 }], weight: CHERRY_FALLS },
  ],
}

async function renderTotals(aggregatesOverride = {}) {
  const aggregates = {
    crops: [TOMATO], other: [], first_pick: [],
    weight: w({ grams: 93301, measured_grams: 44856, estimated_grams: 48445, measured: 313, estimated: 367 }),
    ...aggregatesOverride,
  }
  fetchSpy.mockImplementation((url) => Promise.resolve(
    String(url).includes('timeframe=7d')
      ? { aggregates: { crops: [], other: [] } }
      : { entries: [], aggregates, cursor: null },
  ))
  render(<Harvests />)
  await waitFor(() => expect(screen.getByText('Totals')).toBeTruthy())
  fireEvent.click(screen.getByText('Totals'))
  fireEvent.click(await screen.findByText('Tomato'))
  return aggregates
}

describe('variety sub-rows carry weight', () => {
  it('renders each variety’s grams with its provenance counts attached', async () => {
    await renderTotals()
    const lines = screen.getAllByTestId('variety-weight').map((n) => n.textContent)
    expect(lines).toEqual(['≈ 8.23 kg · 26 weighed · 1 estimated', '≈ 763 g · 36 estimated'])
  })

  it('an ALL-MODELLED variety is visibly distinguishable from a mostly-weighed one', async () => {
    // The whole point of the counts riding along: both rows are "a number of grams", and only one
    // of them is a measurement. Same ≈, very different standing.
    await renderTotals()
    const [top, second] = screen.getAllByTestId('variety-weight').map((n) => n.textContent)
    expect(top).toContain('26 weighed')
    expect(second).not.toContain('weighed')
    expect(second).toContain('36 estimated')
  })

  it('renders the rows in the order the server sent — heaviest first, not alphabetical', async () => {
    await renderTotals()
    const names = screen.getAllByTestId('variety-weight')
      .map((n) => n.parentElement.parentElement.firstChild.textContent)
    expect(names).toEqual(['Moskvich Heirloom', 'Cherry Falls'])
  })

  it('names the sort key, so a weight-ordered list is not read as a broken alphabetical one', async () => {
    await renderTotals()
    expect(screen.getByText('By weight · ≈ estimated')).toBeTruthy()
  })

  it('claims no ordering when nothing under the crop has a weight', async () => {
    // Then the order IS the name order (the tie-break), and captioning it "by weight" would be false.
    const varieties = TOMATO.varieties.map((v) => ({ ...v, weight: w({ unweighed: 3 }) }))
    await renderTotals({ crops: [{ ...TOMATO, varieties }] })
    expect(screen.queryByText('By weight · ≈ estimated')).toBeNull()
    expect(screen.queryByTestId('variety-weight')).toBeNull()
  })

  it('an older Lambda (no weight key on a variety row) renders the units line and nothing else', async () => {
    // The SPA and the harvests Lambda deploy on separate legs and a rollback must hold. "This API
    // does not compute variety weight" and "nothing under this variety was weighed" are different
    // facts and only the second is safe to render.
    const varieties = TOMATO.varieties.map(({ weight, ...v }) => v) // eslint-disable-line no-unused-vars
    await renderTotals({ crops: [{ ...TOMATO, varieties }] })
    expect(screen.queryByTestId('variety-weight')).toBeNull()
    expect(screen.getByText('Moskvich Heirloom')).toBeTruthy()
  })
})

describe('per-planting weight on the first-pick lines', () => {
  it('shows the planting’s own grams beside its first-pick date', async () => {
    await renderTotals({
      first_pick: [{ plant_id: 'gn-1', planting_name: 'Moskvich bed', crop_type_slug: 'tomato', first_pick_date: '2026-07-04', weight: MOSKVICH }],
    })
    expect(screen.getByTestId('planting-weight').textContent).toBe(' · ≈ 8.23 kg')
  })

  it('stays silent for a planting with no derivable weight', async () => {
    await renderTotals({
      first_pick: [{ plant_id: 'gn-3', planting_name: 'Volunteer', crop_type_slug: 'tomato', first_pick_date: '2026-07-04', weight: w({ unweighed: 2 }) }],
    })
    expect(screen.queryByTestId('planting-weight')).toBeNull()
    expect(screen.getByText(/First pick/)).toBeTruthy()
  })
})

describe('B4 — the measured share of the season total', () => {
  it('states the share of the POUNDAGE that is modelled, not just the row counts', async () => {
    // The counts line reads "313 weighed · 367 estimated", which scans as mostly-weighed. 52% of
    // the grams are not, because the weighed rows skew small. Both must be visible.
    await renderTotals()
    expect(screen.getByTestId('totals-weight-basis').textContent).toBe('313 weighed · 367 estimated')
    expect(screen.getByTestId('totals-weight-modelled').textContent).toBe('52% of this weight is estimated, not weighed')
  })

  it('an all-measured total carries no caveat', async () => {
    await renderTotals({ weight: w({ grams: 1420, measured_grams: 1420, measured: 4 }) })
    expect(screen.queryByTestId('totals-weight-modelled')).toBeNull()
  })

  it('an all-estimated total says 100%, not nothing', async () => {
    await renderTotals({ weight: w({ grams: 900, estimated_grams: 900, estimated: 5 }) })
    expect(screen.getByTestId('totals-weight-modelled').textContent).toBe('100% of this weight is estimated, not weighed')
  })
})
