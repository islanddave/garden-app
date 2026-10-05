// Put-Up R2a, lane G (UX I-2) — the planting page's put-up row says what the Pantry row says about the same bag.
//
// The planting page lists a planting's put-ups from its own read (whats-put-up's record, jarRules.js
// projectRow) and says what is left of each in its own function (plantingKitchen.leftWords). It built its own
// grams sentence, so ONE bag typed as 1 lb would have read "about 1 lb left" on the Pantry and "about 454 g
// left" here. Both now say it through pantryRows.weighedLeftWords.
//
// WHAT THIS FILE HOLDS:
//   • plantingKitchen.leftWords for a weighed record: lb, oz and kg in the unit that was typed; g, and a row
//     whose grams cannot be said, as they were;
//   • ONE stored put-up read both ways (the Pantry's jarRow, the planting's projectRow): the two surfaces say
//     the same words — fresh, seeded, part used and nearly gone, in every weight;
//   • on the planting page: the row of ONE 1 lb bag.
// MUTATIONS (each run, each red here):
//   plantingKitchen's own grams sentence (the base)     -> "one stored put-up, read both ways: the planting page and the Pantry say the same words"
//   the count said before the grams                     -> "a weighed record says what is left in the unit that was typed"
// CI LANE: `npm test` plus the blocking TZ re-run. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { jarRow as serverJarRow } from '../../lambda/preservation/pantryItems.js'
import { projectRow } from '../../lambda/preservation/jarRules.js'
import { MASS_G } from '../../lambda/preservation/kitchenBatch.js'

vi.mock('../components/PutUpPhotoThumb.jsx', () => ({
  default: ({ photoId, alt }) => (photoId ? <img alt={alt} data-testid="putup-thumb" /> : null),
}))
// The section's buttons open the Pantry's door on this page; nothing here opens it.
vi.mock('../components/pantry/PutSomethingUpSheet.jsx', () => ({ default: () => null }))

import PutUpFromPlanting from '../components/planting/PutUpFromPlanting.jsx'
import { leftWords as plantingLeft } from '../components/planting/plantingKitchen.js'
import { leftWords as pantryLeft } from '../components/pantry/pantryRows.js'

const NOW = new Date(2026, 9, 1, 14, 0, 0)
const PLANTING = { id: 'pl-1', name: 'Provider beans', variety_id: null }

// A put-up as preservation_log holds it: ONE container of 1 lb from a planting, its grams as the create seeded them.
const stored = (o = {}) => ({
  id: 'jar-beans', user_id: 'user_dave', plant_id: 'pl-1', label: 'Green beans, frozen', container_label: null, method: 'blanch_freeze',
  method_other_text: null, crop_type_slug: 'bean', package_count: 1, remaining_count: 1, quantity_value: '1.00', quantity_unit: 'lb',
  remaining_amount: '453.59200', storage_location_id: 'loc-2', place_label: 'Chest Freezer 2', place_kind: 'deep_freezer',
  storage_kind: 'deep_freezer', preserved_at: '2026-09-20', preserved_at_precision: 'day', preserved_at_approx: null,
  use_by_target: null, use_by_basis: null, notes: null, photo_id: null, updated_at: '2026-09-20T16:00:00Z', ...o,
})
// The same stored row as each surface reads it.
const onPlanting = (o) => plantingLeft(projectRow(stored(o)))
const onPantry = (o) => pantryLeft(serverJarRow(stored(o), 'place', NOW))

afterEach(cleanup)

describe('plantingKitchen.leftWords — a weighed record', () => {
  it('a weighed record says what is left in the unit that was typed', () => {
    expect(onPlanting()).toBe('about 1 lb left')
    // Not yet seeded (a row from before the create seeded grams): what it held.
    expect(onPlanting({ remaining_amount: null })).toBe('about 1 lb left')
    expect(onPlanting({ remaining_amount: '340.1940' })).toBe('about 0.75 lb left')
    expect(onPlanting({ quantity_value: '12.00', quantity_unit: 'oz', remaining_amount: null })).toBe('about 12 oz left')
    expect(onPlanting({ quantity_value: '12.00', quantity_unit: 'oz', remaining_amount: '212.62125' })).toBe('about 7.5 oz left')
    expect(onPlanting({ quantity_value: '1.50', quantity_unit: 'kg', remaining_amount: null })).toBe('about 1.5 kg left')
  })

  it('grams stay grams; under 0.01 of the unit is said in grams; no grams at all falls back to the count', () => {
    expect(onPlanting({ quantity_value: '412.00', quantity_unit: 'g', remaining_amount: null })).toBe('about 412 g left')
    expect(onPlanting({ quantity_value: '412.00', quantity_unit: 'g', remaining_amount: '92.40' })).toBe('about 92 g left')
    expect(onPlanting({ remaining_amount: '3' })).toBe('about 3 g left')
    expect(plantingLeft({ ...projectRow(stored()), remaining_amount: null, quantity_value: null })).toBe('1 left')
    // One container in a unit that is not a weight is counted, as it was.
    expect(onPlanting({ quantity_unit: 'pint', remaining_amount: null })).toBe('1 left')
  })

  it('one stored put-up, read both ways: the planting page and the Pantry say the same words', () => {
    const differ = []
    for (const unit of Object.keys(MASS_G)) {
      for (const typed of ['0.01', '0.25', '0.50', '1.00', '1.50', '2.50', '12.00', '16.00', '99.99']) {
        const whole = Number(typed) * MASS_G[unit]
        for (const left of [null, String(whole), String(whole / 2), String(whole / 3), '0.2', '3']) {
          const o = { quantity_value: typed, quantity_unit: unit, remaining_amount: left }
          const [here, there] = [onPlanting(o), onPantry(o)]
          if (here !== there || typeof here !== 'string') differ.push({ ...o, planting: here, pantry: there })
        }
      }
    }
    expect(differ).toEqual([])
    // INSTRUMENT: the sweep is of weighed rows on both reads, and it reaches the typed units.
    expect(projectRow(stored()).stock_mode).toBe('weighed')
    expect(serverJarRow(stored(), 'place', NOW).stock_mode).toBe('weighed')
    expect([onPlanting(), onPantry()]).toEqual(['about 1 lb left', 'about 1 lb left'])
  })
})

describe('the put-up row on the planting page', () => {
  const whatsPutUp = (records) => vi.fn((path) => {
    const url = new URL(path, 'http://x')
    if (url.pathname !== '/api/preservation/whats-put-up') return Promise.resolve(null)
    return Promise.resolve({ group_by: 'storage', groups: [{ group_key: 'loc-2', label: 'Chest Freezer 2', records }] })
  })
  const mount = (records) => render(
    <MemoryRouter initialEntries={['/planting']}>
      <Routes>
        <Route path="/planting" element={<PutUpFromPlanting planting={PLANTING} fetch={whatsPutUp(records)} now={NOW} />} />
      </Routes>
    </MemoryRouter>,
  )

  it('ONE bag of 1 lb reads "about 1 lb left", and no grams', async () => {
    mount([projectRow(stored())])
    const detail = await screen.findByTestId('putup-from-planting-detail')
    expect(detail.textContent).toBe('Chest Freezer 2 · about 1 lb left · put up Sep 20, 2026')
    expect(document.body.textContent).not.toMatch(/\d g left/)
  })

  it('a part-used bag says what is left of it', async () => {
    mount([projectRow(stored({ remaining_amount: '340.1940' }))])
    expect((await screen.findByTestId('putup-from-planting-detail')).textContent).toBe('Chest Freezer 2 · about 0.75 lb left · put up Sep 20, 2026')
  })
})
