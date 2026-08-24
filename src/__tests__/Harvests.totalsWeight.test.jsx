// V4-HARVWEIGHTREAD-001 — harvest weight on the Harvests TOTALS surface.
//
// The log chip (Harvests.weight.test.jsx) pins one row's weight. These pin the AGGREGATE, where the
// failure mode is different and worse: a season total is one confident number standing in for
// hundreds of rows, nearly all of them estimated today. What must hold:
//   * the counts travel with the number, always — a bare total claims a precision it doesn't have
//   * an estimate-bearing total keeps the ≈, and an all-measured one must not wear it
//   * "nothing weighable" reads as the ratchet ("not yet"), never as 0 g
//   * an OLDER harvests Lambda (no aggregates.weight) renders nothing at all — the frontend ships
//     first, and "this API can't compute weight" must never be shown as "no weight recorded"
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
import { formatGrams, NO_WEIGHT_COPY } from '../lib/harvestWeight.js'

beforeEach(() => { fetchSpy.mockReset(); searchParamsRef.current = new URLSearchParams() })

const CROP = {
  crop_type_slug: 'tomato', crop_name: 'Tomato',
  units: [{ unit: 'count', unit_key: 'count', total: 14, count: 3 }], unquantified: 0, varieties: [],
}

// Render and switch to the Totals tab. `weight` keys are omitted entirely when passed undefined,
// which is exactly the pre-slice-2 Lambda's response shape.
//
// The snapshot strip's rolling-7-day request (timeframe=7d, BUG-HARVSNAPSHOT7D-001) is answered
// EMPTY rather than with this fixture. Not a convenience: the two windows are different queries and
// returning the season's crop row for both would put the same "14 tomatoes" in the tile and in the
// crop row, which is not a shape the server can produce and would make every assertion here
// ambiguous about which surface it matched.
async function renderTotals({ weight, cropWeight } = {}) {
  const crop = { ...CROP }
  if (cropWeight !== undefined) crop.weight = cropWeight
  const aggregates = { crops: [crop], other: [], first_pick: [] }
  if (weight !== undefined) aggregates.weight = weight
  fetchSpy.mockImplementation((url) => Promise.resolve(
    String(url).includes('timeframe=7d')
      ? { aggregates: { crops: [], other: [] } }
      : { entries: [], aggregates, cursor: null },
  ))
  render(<Harvests />)
  await waitFor(() => expect(screen.getByText('Totals')).toBeTruthy())
  fireEvent.click(screen.getByText('Totals'))
  await screen.findByText('Tomato')
}

const w = (o) => ({ grams: 0, measured_grams: 0, estimated_grams: 0, measured: 0, estimated: 0, unweighed: 0, ...o })

describe('Harvests Totals — weight total', () => {
  it('marks a MIXED total with ≈ and prints the provenance counts alongside it', async () => {
    await renderTotals({ weight: w({ grams: 12400, measured_grams: 3000, estimated_grams: 9400, measured: 3, estimated: 9, unweighed: 2 }) })
    expect(screen.getByTestId('totals-weight').textContent).toBe('≈ 12 kg')
    // The counts are the honesty guarantee: the number is 12 kg, but only 3 rows of 14 were weighed.
    expect(screen.getByTestId('totals-weight-basis').textContent).toBe('3 weighed · 9 estimated · 2 with no weight yet')
    expect(screen.getByTestId('totals-weight').getAttribute('aria-label')).toBe('Estimated total harvest weight: 12 kg')
  })

  it('an ALL-MEASURED total drops the ≈ and is not called an estimate', async () => {
    await renderTotals({ weight: w({ grams: 1420, measured_grams: 1420, measured: 4 }) })
    const total = screen.getByTestId('totals-weight')
    expect(total.textContent).toBe('1.42 kg')
    expect(total.textContent).not.toContain('≈')
    expect(total.getAttribute('aria-label')).toBe('Total harvest weight: 1.42 kg')
    expect(screen.getByTestId('totals-weight-basis').textContent).toBe('4 weighed')
  })

  it('nothing weighable reads as the ratchet, never as 0 g', async () => {
    await renderTotals({ weight: w({ unweighed: 5 }) })
    expect(screen.getByTestId('totals-weight-none').textContent).toBe(NO_WEIGHT_COPY)
    expect(screen.queryByTestId('totals-weight')).toBeNull()
    expect(screen.queryByText(/0 g/)).toBeNull()
    expect(screen.getByTestId('totals-weight-basis').textContent).toBe('5 with no weight yet')
  })

  it('an all-zero weight object renders nothing rather than an empty qualifier', async () => {
    await renderTotals({ weight: w({}), cropWeight: w({}) })
    expect(screen.queryByTestId('totals-weight')).toBeNull()
    expect(screen.queryByTestId('totals-weight-none')).toBeNull()
    expect(screen.queryByTestId('totals-weight-basis')).toBeNull()
    expect(screen.queryByTestId('crop-weight-none')).toBeNull()
    expect(screen.queryByTestId('crop-weight-basis')).toBeNull()
  })

  it('formats the total through the shared formatter, not a local one', async () => {
    await renderTotals({ weight: w({ grams: 337, measured_grams: 337, measured: 1 }) })
    expect(screen.getByTestId('totals-weight').textContent).toBe(formatGrams(337))
  })
})

describe('Harvests Totals — per-crop weight', () => {
  // V4-HARVCROPTABLE-001 — the crop weight now rides the native-unit line instead of owning a row
  // beneath it, and the count line under it is gone. Two text rows per crop, not four.
  it('puts the crop weight ON the native-unit line, no count line, headline intact', async () => {
    await renderTotals({
      weight: w({ grams: 1400, estimated_grams: 1400, estimated: 3 }),
      cropWeight: w({ grams: 1400, estimated_grams: 1400, estimated: 3 }),
    })
    const weightEl = screen.getByTestId('crop-weight')
    expect(weightEl.textContent).toBe('≈ 1.4 kg')
    expect(screen.queryByTestId('crop-weight-basis')).toBeNull()
    // Native units stay the headline — grams are a second axis, not a replacement.
    expect(screen.getByText(/14 tomato/i)).toBeTruthy()
    // The structural half of the ask: the weight is INSIDE the units line, not a sibling row.
    // Asserting the testid alone would pass just as well with the old stacked layout.
    expect(weightEl.parentElement.textContent).toMatch(/14 tomato/i)
    expect(weightEl.style.display).not.toBe('block')
  })

  it('a crop with zero weighed entries says "no weight yet" once, not twice', async () => {
    await renderTotals({ weight: w({ unweighed: 3 }), cropWeight: w({ unweighed: 3 }) })
    const none = screen.getByTestId('crop-weight-none')
    expect(none.textContent).toBe('no weight yet')
    expect(none.getAttribute('title')).toBe(NO_WEIGHT_COPY)
    expect(screen.queryByTestId('crop-weight')).toBeNull()
    expect(screen.queryByTestId('crop-weight-basis')).toBeNull()
  })
})

describe('Harvests Totals — older Lambda (no weight on the response)', () => {
  it('renders NOTHING for weight when aggregates.weight is absent, and does not crash', async () => {
    await renderTotals({ weight: undefined, cropWeight: undefined })
    expect(screen.queryByTestId('totals-weight')).toBeNull()
    expect(screen.queryByTestId('totals-weight-none')).toBeNull()
    expect(screen.queryByTestId('totals-weight-basis')).toBeNull()
    expect(screen.queryByText(/Total weight/i)).toBeNull()
    expect(screen.queryByText(NO_WEIGHT_COPY)).toBeNull()
    // The rest of the Totals surface is untouched — the crop row and its units still render.
    expect(screen.getByText('Tomato')).toBeTruthy()
    expect(screen.getByText(/14 tomato/i)).toBeTruthy()
  })

  it('a crop row missing its weight key stays silent while the overall total still renders', async () => {
    await renderTotals({ weight: w({ grams: 500, measured_grams: 500, measured: 2 }), cropWeight: undefined })
    expect(screen.getByTestId('totals-weight').textContent).toBe('500 g')
    expect(screen.queryByTestId('crop-weight')).toBeNull()
    expect(screen.queryByTestId('crop-weight-none')).toBeNull()
  })
})
