// Put-Up R2a, lane G (UX I-2) — a weighed put-up says what is left in the unit it was typed in.
//
// ONE container sized in a weight is "weighed" stock (lambda/preservation/pantryItems.js jarRow: package_count
// 1 and a mass unit), and its row carries grams. A bag typed as 1 lb read "about 454 g left": a unit nobody
// typed. It reads "about 1 lb left".
//
// WHAT THIS FILE HOLDS:
//   • pantryRows.leftWords for a weighed row, unit by unit: lb, oz and kg say what is left in that unit; g
//     says whole grams, as it did; a row with no stored unit, or a unit that is not a weight, says grams, as
//     it did;
//   • the number: a fresh bag reads back as it was typed (every hundredth to 20 and up to the most the server
//     takes, both ways the server makes the grams); a part-used bag; at most two decimals, no trailing zeros;
//     less than 0.01 of the unit is said in grams, never as 0; grams that are not a number say nothing;
//   • the factors are the server's (kitchenBatch.js MASS_G), checked against literals;
//   • a counted row and a bought item say what they said;
//   • ON THE PAGE, ONE bag of 1 lb as the server's own jarRow answers it: the Pantry row, the row sheet and a
//     search hit;
//   • no banned word in anything said.
// MUTATIONS (each run, each red here):
//   always grams (the base)                          -> "lb, oz and kg: a fresh bag reads back as it was typed"
//   a factor that is not the server's (lb at 454)    -> "the factors are the server's own"
//   the number printed with toFixed(2) alone         -> "at most two decimals and no trailing zeros"
//   three decimals                                   -> "at most two decimals and no trailing zeros"
//   the fall back to grams removed                   -> "less than 0.01 of the unit left is said in grams, never as 0"
//   g treated as a typed unit like the others        -> "a bag typed in grams says whole grams, as it did"
//   kg left out                                      -> "lb, oz and kg: a fresh bag reads back as it was typed"
// CI LANE: `npm test` plus the blocking TZ re-run. No jest-dom (L-182).
import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'
import { pantryFetch, jarRow, itemRow, PLACES } from './helpers/pantryFake.js'
import { jarRow as serverJarRow } from '../../lambda/preservation/pantryItems.js'
import { projectRow } from '../../lambda/preservation/jarRules.js'
import { MASS_G } from '../../lambda/preservation/kitchenBatch.js'

installStoragePolyfill()

let fake
const { stableFetch } = vi.hoisted(() => ({ stableFetch: { fn: null } }))
vi.mock('../lib/api.js', () => {
  const f = (...a) => stableFetch.fn(...a)
  return { useApiFetch: () => ({ fetch: f, getToken: () => Promise.resolve('t') }), apiFetch: f }
})
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => ({ user: { id: 'user_dave' } }) }))

import PantryView from '../components/pantry/PantryView.jsx'
import PantrySearchResults from '../components/pantry/PantrySearch.jsx'
import { leftWords, detailWords, weighedLeftWords } from '../components/pantry/pantryRows.js'

const BANNED = /\b(safe|shelf life|shelf-stable|keeps|good|ready|done|expired|table|default|basis)\b/i
const CF2 = PLACES[1]
const NOW = new Date(2026, 9, 1, 14, 0, 0)
const TYPED_UNITS = ['lb', 'oz', 'kg']

// A put-up as preservation_log holds it (the columns GET /api/pantry reads): ONE container of 1 lb, its grams
// as the create seeded them.
const stored = (o = {}) => ({
  id: 'jar-beans', user_id: 'user_dave', label: 'Green beans, frozen', method: 'blanch_freeze', crop_type_slug: 'bean',
  crop_display_name: 'Beans', package_count: 1, remaining_count: 1, quantity_value: '1.00', quantity_unit: 'lb',
  remaining_amount: '453.59200', storage_location_id: CF2.id, place_label: CF2.label, place_kind: CF2.kind,
  preserved_at: '2026-09-20', preserved_at_precision: 'day', use_by_target: '2027-09-20', use_by_basis: 'table',
  plant_id: null, batch_id: null, source_kind: null, source_label: null, notes: null, updated_at: '2026-09-20T16:00:00Z', ...o,
})
// The Pantry row the SERVER answers for it.
const pantryRow = (o, group = 'place') => serverJarRow(stored(o), group, NOW)
// A weighed row by hand, for the grams no stored record makes.
const bag = (unit, grams) => jarRow({ stock_mode: 'weighed', count_left: null, count_made: null, grams_left: grams,
  ...(unit === undefined ? {} : { quantity_unit: unit }) })

// What the create seeds for a one-container weighed put-up: quantity_value::numeric × the factor, in SQL
// (lambda/preservation/index.js, "Seeding") — an exact decimal product, so it is made here the same way.
function seededGrams(typed, unit) {
  const scaleOf = (s) => (s.split('.')[1] ?? '').length
  const [a, b] = [Number(typed).toFixed(2), String(MASS_G[unit])]
  const scale = scaleOf(a) + scaleOf(b)
  const digits = (BigInt(a.replace('.', '')) * BigInt(b.replace('.', ''))).toString().padStart(scale + 1, '0')
  return scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits
}
// Every hundredth from 0.01 to 20, then amounts up to the most the server takes (jarRules: 99999999.99).
const TYPED = [
  ...Array.from({ length: 2000 }, (_, i) => ((i + 1) / 100).toFixed(2)),
  '25', '99.99', '100', '1234.56', '50000', '99999999.99',
]

describe('leftWords — a weighed bag, in the unit it was typed in', () => {
  it('says the ruling\'s own sentences', () => {
    expect(leftWords(bag('lb', 453.592))).toBe('about 1 lb left')
    expect(leftWords(bag('lb', 340.194))).toBe('about 0.75 lb left')
    expect(leftWords(bag('oz', 340.194))).toBe('about 12 oz left')
    expect(leftWords(bag('oz', 212.62125))).toBe('about 7.5 oz left')
    expect(leftWords(bag('kg', 1500))).toBe('about 1.5 kg left')
  })

  it('instrument: the seeded grams are the exact product the create stores', () => {
    expect([seededGrams('1', 'lb'), seededGrams('12', 'oz'), seededGrams('1.5', 'kg'), seededGrams('0.01', 'lb')])
      .toEqual(['453.59200', '340.194000', '1500.00', '4.53592'])
  })

  it('lb, oz and kg: a fresh bag reads back as it was typed', () => {
    const wrong = []
    for (const unit of TYPED_UNITS) {
      for (const typed of TYPED) {
        const said = `about ${String(Number(typed))} ${unit} left`
        // Before anything moved its grams the server's row multiplies (pantryItems.js jarRow)…
        const multiplied = leftWords(pantryRow({ quantity_value: typed, quantity_unit: unit, remaining_amount: null }))
        // …and a row the create seeded carries the exact product.
        const seeded = leftWords(pantryRow({ quantity_value: typed, quantity_unit: unit, remaining_amount: seededGrams(typed, unit) }))
        if (multiplied !== said || seeded !== said) wrong.push({ typed, unit, multiplied, seeded })
      }
    }
    expect(wrong).toEqual([])
  })

  it('a bag typed in grams says whole grams, as it did', () => {
    expect(leftWords(bag('g', 412.4))).toBe('about 412 g left')
    expect(leftWords(bag('g', 92))).toBe('about 92 g left')
    expect(leftWords(bag('g', 1500))).toBe('about 1500 g left')
    expect(leftWords(pantryRow({ quantity_value: '412.00', quantity_unit: 'g', remaining_amount: null }))).toBe('about 412 g left')
  })

  it('a row with no stored unit, or a unit that is not a weight, says grams, as it did', () => {
    const units = [undefined, null, '', 'pint', 'fl oz', 'bag', 'count', 'other', 'lbs', 'LB', ' lb', 'pounds',
      'toString', 'constructor', '__proto__', 'hasOwnProperty', 0, 1, {}]
    expect(units.map(u => leftWords(bag(u, 453.592)))).toEqual(units.map(() => 'about 454 g left'))
  })

  it('a part-used bag says what is left of it, not what it held', () => {
    expect(leftWords(pantryRow({ remaining_amount: '340.1940' }))).toBe('about 0.75 lb left')      // 4 oz drawn from 1 lb
    expect(leftWords(pantryRow({ remaining_amount: '226.796' }))).toBe('about 0.5 lb left')
    expect(leftWords(pantryRow({ quantity_value: '12.00', quantity_unit: 'oz', remaining_amount: '212.62125' }))).toBe('about 7.5 oz left')
    expect(leftWords(pantryRow({ quantity_value: '16.00', quantity_unit: 'oz', remaining_amount: '100' }))).toBe('about 3.53 oz left')
    expect(leftWords(pantryRow({ quantity_value: '2.00', quantity_unit: 'kg', remaining_amount: '1250' }))).toBe('about 1.25 kg left')
  })

  it('at most two decimals and no trailing zeros', () => {
    expect(leftWords(bag('lb', 151.2))).toBe('about 0.33 lb left')            // 0.3333…
    expect(leftWords(bag('lb', 302.4))).toBe('about 0.67 lb left')            // 0.6667: rounded, not cut
    expect(leftWords(bag('lb', 453.592))).toBe('about 1 lb left')             // never "1.00"
    expect(leftWords(bag('lb', 226.796))).toBe('about 0.5 lb left')           // never "0.50"
    expect(leftWords(bag('lb', 2270))).toBe('about 5 lb left')                // 5.0045
    expect(leftWords(bag('oz', 100))).toBe('about 3.53 oz left')
    expect(leftWords(bag('kg', 1234))).toBe('about 1.23 kg left')
    const said = TYPED_UNITS.flatMap(unit => [4.6, 5, 10, 28, 33.3, 100, 123.456, 250, 333.333, 453.59, 454, 500, 999.99,
      1000, 1001, 12345.678].map(g => leftWords(bag(unit, g))))
    for (const s of said) {
      expect(s).toMatch(/^about \d+(\.\d{1,2})? (lb|oz|kg|g) left$/)
      expect(s).not.toMatch(/\.\d*0 /)
    }
  })

  it('less than 0.01 of the unit left is said in grams, never as 0', () => {
    expect(leftWords(bag('lb', 4))).toBe('about 4 g left')                    // 0.0088 lb
    expect(leftWords(bag('lb', 2))).toBe('about 2 g left')                    // 0.0044 lb: two decimals would print 0
    expect(leftWords(bag('kg', 9.4))).toBe('about 9 g left')                  // 0.0094 kg
    expect(leftWords(bag('kg', 3))).toBe('about 3 g left')
    // 0.01 is the smallest amount the server takes, and it is said in its unit.
    expect(leftWords(bag('lb', 4.53592))).toBe('about 0.01 lb left')
    expect(leftWords(bag('oz', 0.283495))).toBe('about 0.01 oz left')
    expect(leftWords(bag('kg', 10))).toBe('about 0.01 kg left')
    // Whatever is under 0.01 of the unit reads exactly as a row with no unit reads.
    for (const unit of TYPED_UNITS) {
      for (const g of [0, 0.1, 0.2, 0.25, 0.28, 1, 2, 2.2, 4, 4.5, 9, 9.99]) {
        const said = leftWords(bag(unit, g))
        expect(said).not.toMatch(/^about 0(\.0+)? (lb|oz|kg) left$/)
        if (g / MASS_G[unit] < 0.01) expect(said).toBe(leftWords(bag(undefined, g)))
      }
    }
  })

  it('grams that are not a number say nothing; a numeric string is read as the number it is', () => {
    for (const g of [null, undefined, NaN, Infinity, -Infinity, 'abc', {}]) {
      for (const unit of [...TYPED_UNITS, 'g', undefined]) expect(leftWords(bag(unit, g))).toBeNull()
    }
    expect(leftWords(bag('lb', '340.1940'))).toBe('about 0.75 lb left')
    expect(leftWords(bag(undefined, '92.40'))).toBe('about 92 g left')
  })

  it('the factors are the server\'s own', () => {
    // Every weight the server knows but grams is said in its own unit. A unit added to that table would be
    // too, and this line is where it shows.
    expect(Object.keys(MASS_G).filter(u => u !== 'g').sort()).toEqual(['kg', 'lb', 'oz'])
    for (const unit of TYPED_UNITS) expect(weighedLeftWords(25 * MASS_G[unit], unit)).toBe(`about 25 ${unit} left`)
    // …and as literals, so the table itself is held: 25 × 453.592, 25 × 28.3495, 25 × 1000.
    expect(weighedLeftWords(11339.8, 'lb')).toBe('about 25 lb left')
    expect(weighedLeftWords(708.7375, 'oz')).toBe('about 25 oz left')
    expect(weighedLeftWords(25000, 'kg')).toBe('about 25 kg left')
    expect(weighedLeftWords(45359199995.46, 'lb')).toBe('about 99999999.99 lb left')
  })

  it('weighedLeftWords alone: the grams and the stored unit in, the words or nothing out', () => {
    expect(weighedLeftWords(453.592, 'lb')).toBe('about 1 lb left')
    expect(weighedLeftWords('453.59200', 'lb')).toBe('about 1 lb left')
    expect(weighedLeftWords(453.592, 'g')).toBe('about 454 g left')
    expect(weighedLeftWords(453.592)).toBe('about 454 g left')
    expect(weighedLeftWords(453.592, null)).toBe('about 454 g left')
    for (const g of [null, undefined, NaN, Infinity, 'abc']) expect(weighedLeftWords(g, 'lb')).toBeNull()
  })

  it('a counted row and a bought item say what they said, whatever their unit', () => {
    expect(leftWords(jarRow({ count_left: 3, quantity_value: 1, quantity_unit: 'lb' }))).toBe('3 left')
    expect(leftWords(pantryRow({ package_count: 3, remaining_count: 2, remaining_amount: null }))).toBe('2 left')
    expect(leftWords(pantryRow({ quantity_unit: 'pint', remaining_amount: null }))).toBe('1 left')
    expect(leftWords(itemRow({ quantity_value: 2, quantity_unit: 'lb' }))).toBeNull()
    expect(leftWords(null)).toBeNull()
  })

  it('"about" and "left" stay, and no banned word is said', () => {
    for (const unit of [...TYPED_UNITS, 'g', undefined]) {
      for (const g of [0.2, 4, 92, 340.194, 453.592, 1500, 11339.8]) {
        const said = leftWords(bag(unit, g))
        expect(said).toMatch(/^about .+ left$/)
        expect(said).not.toMatch(BANNED)
      }
    }
  })
})

describe('on the page: ONE bag of 1 lb, as the server answers it', () => {
  const BEANS = pantryRow()
  function PantryHost({ rows }) {
    const [recent, setRecent] = useState({})
    return (
      <PantryView fetch={stableFetch.fn} group="place" onGroupChange={() => {}} rows={rows} loading={false} error={false}
        onReload={() => {}} recent={recent} onRecent={setRecent} now={NOW.getTime()} />
    )
  }

  beforeEach(() => {
    // The row sheet reads the put-up's own record; it is answered as the Lambda projects the same stored row.
    fake = pantryFetch({ rows: [BEANS], overrides: { 'GET /api/preservation/*': () => projectRow(stored()) } })
    stableFetch.fn = fake
    localStorage.clear(); sessionStorage.clear()
  })

  it('instrument: the row is the server\'s weighed row, and it carries the unit as stored', () => {
    expect([BEANS.stock_mode, BEANS.count_left, BEANS.grams_left, BEANS.quantity_value, BEANS.quantity_unit])
      .toEqual(['weighed', null, 453.592, 1, 'lb'])
  })

  it('the Pantry row says "about 1 lb left", and no grams', async () => {
    render(<PantryHost rows={[BEANS]} />)
    const row = await screen.findByTestId('pantry-row-open-put_up:jar-beans')
    expect(row.textContent).toContain('about 1 lb left')
    expect(row.textContent).not.toMatch(/\d g left/)
    // Under its place's heading the line is what is left; grouped by what it is, the place comes first.
    expect(detailWords(BEANS, { now: NOW })).toBe('about 1 lb left')
    expect(detailWords(pantryRow({}, 'kind'), { now: NOW })).toBe('Chest Freezer 2 · about 1 lb left')
  })

  it('the row sheet says the same line, above the size as it was typed', async () => {
    render(<PantryHost rows={[BEANS]} />)
    fireEvent.click(await screen.findByTestId('pantry-row-open-put_up:jar-beans'))
    const sheet = await screen.findByTestId('row-sheet')
    expect(sheet.querySelector('p').textContent).toBe('Chest Freezer 2 · about 1 lb left')
    await waitFor(() => expect(screen.getByTestId('row-sheet-record').textContent).toMatch(/^1 lb · put up /))
    expect(sheet.textContent).not.toMatch(/\d g left/)
  })

  it('a search hit says it too', () => {
    render(<PantrySearchResults query="beans" rows={[BEANS]} loading={false} fetch={stableFetch.fn} onPutUp={() => {}}
      onUsed={() => {}} onChanged={() => {}} now={NOW.getTime()} />)
    expect(screen.getByTestId('pantry-search-hit-put_up:jar-beans').textContent).toBe('Green beans, frozen · Chest Freezer 2 · about 1 lb left')
  })

  it('a quarter of it drawn into a batch: the row says three quarters of a pound', async () => {
    render(<PantryHost rows={[pantryRow({ remaining_amount: '340.1940' })]} />)
    expect((await screen.findByTestId('pantry-row-open-put_up:jar-beans')).textContent).toContain('about 0.75 lb left')
  })
})
