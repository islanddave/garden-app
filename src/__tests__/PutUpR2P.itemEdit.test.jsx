// Put-Up R2a, lane P — a bought (as-is) item's amount and where it is from (B1): said on the Pantry row and
// in the row sheet, and corrected in the item's Edit panel.
//
// THE CONTRACT (lane M's item route): the list row carries quantity_value (a JSON number or null),
// quantity_unit, source_kind, source_label AS STORED; `where_from` stays the server's derived words. On
// PATCH each PAIR carries BOTH keys, always; `null, null` clears; quantity_value is a number, never a string.
// The fake judges every PATCH here with the Lambda's own validateItemPatch, so a body the server would
// refuse is a 400 in these tests too.
//
// WHAT THIS FILE HOLDS:
//   • the amount's words: a unit written as a word takes its plural (2 bags, 2 bunches), an abbreviation
//     never does (2 lb, 12 count); the amount is AS LOGGED and is never followed by "left";
//   • where it sits: `Pantry shelf · Costco · 2 lb · had it 3 days`, on the row and in the sheet;
//   • Item Edit: Name · How much · Where it's from · When you got it · Discard by (from the label) · Notes,
//     opened SEEDED from the list row (there is no read of one item); ONE PATCH of what changed; each pair
//     whole; clearing a pair sends null, null; the two half-filled refusals;
//   • where it's from is ABSENT on an item that came from a planting (the server refuses another source for
//     it, in the database, where the fake cannot follow: its absence is what keeps that refusal off screen).
// MUTATIONS (run, see the lane report): the panel opened blank -> "Item Edit opens seeded" reds; one of a
// pair sent alone -> "clearing sends null, null" reds; where-from shown on a planting item -> its absence
// test reds; "2 bag" printed -> the plural test reds.
// CI LANE: `npm test` plus the blocking TZ re-run (one line here counts days from a date). No jest-dom (L-182).
import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'
import { pantryFetch, jarRow, itemRow, apiError } from './helpers/pantryFake.js'

installStoragePolyfill()

const { wired } = vi.hoisted(() => ({ wired: { fake: null } }))
const f = (...a) => wired.fake(...a)
vi.mock('../lib/api.js', () => {
  const g = (...a) => wired.fake(...a)
  return { useApiFetch: () => ({ fetch: g, getToken: () => Promise.resolve('t') }), apiFetch: g }
})
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => ({ user: { id: 'user_dave' } }) }))

import PantryView from '../components/pantry/PantryView.jsx'
import PantryRowSheet, { ITEM_WHERE_FROM_HEADING } from '../components/pantry/PantryRowSheet.jsx'
import { amountWords, unitWords, detailWords, leftWords, UNIT_PLURALS } from '../components/pantry/pantryRows.js'
import { AMOUNT_WORDS, ITEM_AMOUNT_UNITS, MORE_ITEM_AMOUNT_UNITS } from '../components/pantry/AmountField.jsx'
import { WHERE_EXACTLY_ERROR } from '../components/pantry/WhereFromField.jsx'
import { KITCHEN_UNITS } from '../../lambda/preservation/kitchenBatch.js'
import { validateItemPatch } from '../../lambda/preservation/pantryItems.js'

const NOW = new Date(2026, 9, 2)
const SHELF = { id: 'loc-4', label: 'Pantry shelf', kind: 'pantry' }
const item = (o = {}) => itemRow({ stock_id: 'item-1', name: 'Rolled oats', place: SHELF, group_key: 'oat', group_label: 'Oats',
  acquired_at: '2026-09-29', acquired_precision: 'day', quantity_value: null, quantity_unit: null, source_kind: null, source_label: null, ...o })
// 2 lb from Costco: the server derives the words `where_from` from the stored source.
const OATS = item({ quantity_value: 2, quantity_unit: 'lb', source_kind: 'store', source_label: 'Costco', where_from: 'Costco' })
const PLAIN = item({ stock_id: 'item-2', name: 'Salt' })
// Fresh, as picked: its origin is its planting. It stores no source.
const PICKED = item({ stock_id: 'item-3', name: 'Sungold cherry', plant_id: 'p-7', from_garden: true, where_from: 'Sungold cherry',
  quantity_value: 1.5, quantity_unit: 'qt' })

function wire(opts = {}) {
  wired.fake = pantryFetch({ rows: [OATS, PLAIN, PICKED], ...opts })
  return wired.fake
}
const patches = () => wired.fake.calls('PATCH').map(c => c.body)

function openEdit(row, props = {}) {
  const handlers = { onClose: vi.fn(), onUsed: vi.fn(), onChanged: vi.fn(), ...props }
  render(<PantryRowSheet row={row} fetch={f} now={NOW.getTime()} {...handlers} />)
  fireEvent.click(screen.getByTestId('row-edit'))
  return handlers
}
const panel = () => screen.getByTestId('item-edit-panel')
const amountField = () => screen.getByTestId('item-edit-amount-value')
const typeAmount = (text) => fireEvent.change(amountField(), { target: { value: text } })
const unitChips = () => [...screen.getByTestId('item-edit-amount-units').querySelectorAll('[role="radio"]')]
const chosenUnit = () => unitChips().filter(c => c.getAttribute('aria-checked') === 'true').map(c => c.textContent)
const sourceChips = () => [...screen.getByTestId('item-edit-source').querySelectorAll('[role="radio"]')]
const chosenSource = () => sourceChips().filter(c => c.getAttribute('aria-checked') === 'true').map(c => c.getAttribute('data-testid'))
const save = () => fireEvent.click(screen.getByTestId('item-edit-save'))

beforeEach(() => { wire(); localStorage.clear() })

describe('the amount\'s words (pantryRows.amountWords)', () => {
  it('a unit written as a word takes its plural; an abbreviation and "count" never do', () => {
    const said = (quantity_value, quantity_unit) => amountWords(item({ quantity_value, quantity_unit }))
    expect(said(2, 'bag')).toBe('2 bags')
    expect(said(2, 'bunch')).toBe('2 bunches')
    expect(said(2, 'jar')).toBe('2 jars')
    expect(said(3, 'head')).toBe('3 heads')
    expect(said(2, 'lb')).toBe('2 lb')
    expect(said(12, 'count')).toBe('12 count')
    expect(said(4, 'fl oz')).toBe('4 fl oz')
    expect(said(1.5, 'qt')).toBe('1.5 qt')
  })

  it('one of a thing is singular: 1 bag, 1 bunch, 1 jar', () => {
    for (const unit of Object.keys(UNIT_PLURALS)) expect(amountWords(item({ quantity_value: 1, quantity_unit: unit }))).toBe(`1 ${unit}`)
    expect(amountWords(item({ quantity_value: 0.5, quantity_unit: 'bag' }))).toBe('0.5 bags')
    expect(amountWords(item({ quantity_value: 1.5, quantity_unit: 'cup' }))).toBe('1.5 cups')
  })

  it('every unit the server stores is said, and each either has a plural here or is one that never takes one', () => {
    const NEVER = ['g', 'kg', 'oz', 'lb', 'ml', 'l', 'tsp', 'tbsp', 'fl oz', 'qt', 'gal', 'count', 'other']
    expect([...Object.keys(UNIT_PLURALS), ...NEVER].sort()).toEqual([...KITCHEN_UNITS].sort())
    for (const unit of NEVER) expect(unitWords(unit, 2)).toBe(unit)
    for (const [unit, plural] of Object.entries(UNIT_PLURALS)) {
      expect(unitWords(unit, 2)).toBe(plural)
      expect(unitWords(unit, 1)).toBe(unit)
      expect(amountWords(item({ quantity_value: 2, quantity_unit: unit }))).toBe(`2 ${plural}`)
    }
    // Every unit Edit offers is one the server stores.
    for (const o of [...ITEM_AMOUNT_UNITS, ...MORE_ITEM_AMOUNT_UNITS]) expect(KITCHEN_UNITS).toContain(o.value)
  })

  it('the number is said as it is: 2, 2.5, 2.35 — a numeric text from the driver too', () => {
    expect(amountWords(item({ quantity_value: 2.5, quantity_unit: 'lb' }))).toBe('2.5 lb')
    expect(amountWords(item({ quantity_value: 2.35, quantity_unit: 'lb' }))).toBe('2.35 lb')
    expect(amountWords(item({ quantity_value: '2.50', quantity_unit: 'lb' }))).toBe('2.5 lb')
    expect(amountWords(item({ quantity_value: '2.00', quantity_unit: 'bag' }))).toBe('2 bags')
    expect(amountWords(item({ quantity_value: '1.00', quantity_unit: 'bag' }))).toBe('1 bag')
  })

  it('no amount, no words — never "null lb", never a bare unit', () => {
    for (const o of [{}, { quantity_value: null, quantity_unit: null }, { quantity_value: 2, quantity_unit: null }, { quantity_value: null, quantity_unit: 'lb' },
      { quantity_value: 0, quantity_unit: 'lb' }, { quantity_value: 'abc', quantity_unit: 'lb' }, { quantity_value: 2, quantity_unit: '  ' }]) {
      expect(amountWords(item(o))).toBeNull()
    }
    expect(amountWords(null)).toBeNull()
  })

  it('it is a bought item\'s: a put-up row that carries the same keys says its count left, and no amount', () => {
    const jar = jarRow({ quantity_value: 3, quantity_unit: 'qt', count_left: 3 })
    expect(amountWords(jar)).toBeNull()
    expect(leftWords(jar)).toBe('3 left')
    expect(detailWords({ ...jar, group_key: 'x' }, { now: NOW })).toBe('Chest Freezer 1 · 3 left')
  })
})

describe('where the amount sits', () => {
  it('the detail line: place · where from · the amount · how long it has been had', () => {
    expect(detailWords(OATS, { now: NOW })).toBe('Pantry shelf · Costco · 2 lb · had it 3 days')
    expect(detailWords(item({ quantity_value: 2, quantity_unit: 'bag' }), { now: NOW })).toBe('Pantry shelf · 2 bags · had it 3 days')
    expect(detailWords(PLAIN, { now: NOW })).toBe('Pantry shelf · had it 3 days')
  })

  it('the amount is as logged: it is never followed by "left", and a used-up item still says it', () => {
    for (const o of [{ quantity_value: 2, quantity_unit: 'lb' }, { quantity_value: 12, quantity_unit: 'count' }, { quantity_value: 2, quantity_unit: 'bag' }]) {
      expect(detailWords(item(o), { now: NOW })).not.toMatch(/left/)
      expect(detailWords(item(o), { now: NOW, finished: true })).toBe(detailWords(item(o), { now: NOW }))
    }
    expect(leftWords(OATS)).toBeNull()
  })

  it('on the Pantry row, and in the row sheet', async () => {
    function Host() {
      const [recent, setRecent] = useState({})
      return (
        <PantryView fetch={f} group="kind" onGroupChange={() => {}} rows={[OATS]} loading={false} error={false} onReload={() => {}}
          recent={recent} onRecent={setRecent} now={NOW.getTime()} />
      )
    }
    render(<Host />)
    const open = screen.getByTestId('pantry-row-open-pantry_item:item-1')
    expect(open.textContent).toBe('Rolled oats' + 'Pantry shelf · Costco · 2 lb · had it 3 days')
    fireEvent.click(open)
    const sheet = await screen.findByTestId('row-sheet')
    expect(sheet.querySelector('p').textContent).toBe('Pantry shelf · Costco · 2 lb · had it 3 days')
  })
})

describe('Item Edit — the fields', () => {
  it('in this order: Name · How much · Where it\'s from · When you got it · Discard by (from the label) · Notes', () => {
    openEdit(OATS)
    const labels = [...panel().querySelectorAll('label, [role="radiogroup"]')].map(el => el.getAttribute('aria-label') ?? el.textContent)
    expect(labels.filter(l => l !== 'Unit' && !l.startsWith('Which one?'))).toEqual([
      'Name', 'How much', "Where it's from", 'When you got it', 'Discard by (from the label)', 'Notes'])
    expect(AMOUNT_WORDS.label).toBe('How much')
    expect(ITEM_WHERE_FROM_HEADING).toBe("Where it's from")
  })

  it('How much is the door\'s control with the as-is units: six chips, the rest behind More units…', () => {
    openEdit(PLAIN)
    expect(unitChips().map(c => c.textContent)).toEqual(['lb', 'oz (weight)', 'count', 'bag', 'jar', 'qt'])
    expect(amountField().getAttribute('placeholder')).toBe('e.g. 2')
    expect(amountField().getAttribute('inputmode')).toBe('decimal')
    fireEvent.click(screen.getByTestId('item-edit-amount-unit-more'))
    expect(unitChips().map(c => c.textContent)).toEqual(['lb', 'oz (weight)', 'count', 'bag', 'jar', 'qt',
      'pint', 'cup', 'fl oz', 'gal', 'g', 'kg', 'ml', 'l', 'bunch', 'head', 'peck', 'bushel', 'half-bushel', 'flat'])
  })

  it('Item Edit opens seeded: the amount, its unit, where it is from and its name, from the list row', () => {
    openEdit(OATS)
    expect(amountField().value).toBe('2')
    expect(chosenUnit()).toEqual(['lb'])
    expect(chosenSource()).toEqual(['item-edit-source-store'])
    expect(screen.getByTestId('item-edit-source-label').value).toBe('Costco')
    expect(screen.getByTestId('item-edit-name').value).toBe('Rolled oats')
    expect(screen.getByTestId('item-edit-acquired').value).toBe('2026-09-29')
    expect(wired.fake.calls('GET')).toEqual([])                   // there is no read of one item
  })

  it('an item with no amount and no source opens with both empty, nothing chosen', () => {
    openEdit(PLAIN)
    expect(amountField().value).toBe('')
    expect(chosenUnit()).toEqual([])
    expect(chosenSource()).toEqual([])
    expect(screen.queryByTestId('item-edit-source-label')).toBeNull()
    expect(screen.queryByTestId('item-edit-amount-clear')).toBeNull()
  })

  it('a stored unit from behind More units… is on the row as its own chip; one outside both lists is too, and is not lost', async () => {
    const first = render(<PantryRowSheet row={item({ quantity_value: 2, quantity_unit: 'bunch' })} fetch={f} onClose={() => {}} />)
    fireEvent.click(screen.getByTestId('row-edit'))
    expect(unitChips().map(c => c.textContent)).toEqual(['lb', 'oz (weight)', 'count', 'bag', 'jar', 'qt', 'bunch'])
    expect(chosenUnit()).toEqual(['bunch'])
    first.unmount()

    const { onChanged } = openEdit(item({ quantity_value: 3, quantity_unit: 'clove' }))
    expect(chosenUnit()).toEqual(['clove'])
    typeAmount('4')
    save()
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('edited'))
    expect(patches()).toEqual([{ quantity_value: 4, quantity_unit: 'clove' }])
  })
})

describe('Item Edit — one PATCH of what changed, each pair whole', () => {
  it('nothing changed: Save sends nothing and goes back to the list', async () => {
    const { onChanged } = openEdit(OATS)
    save()
    await screen.findByTestId('row-edit')
    expect(patches()).toEqual([])
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('the number changed: the pair travels together, the value a JSON number', async () => {
    const { onChanged, onClose } = openEdit(OATS)
    typeAmount('3.5')
    save()
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('edited'))
    expect(patches()).toEqual([{ quantity_value: 3.5, quantity_unit: 'lb' }])
    expect(typeof patches()[0].quantity_value).toBe('number')
    expect(wired.fake.calls('PATCH')[0].path).toBe('/api/pantry/items/item-1')
    expect(onClose).toHaveBeenCalled()
  })

  it('the unit changed: the pair travels together', async () => {
    const { onChanged } = openEdit(OATS)
    fireEvent.click(screen.getByTestId('item-edit-amount-unit-bag'))
    save()
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(patches()).toEqual([{ quantity_value: 2, quantity_unit: 'bag' }])
  })

  it('a comma is read as a decimal mark, and more than two places are rounded as the server rounds', async () => {
    const { onChanged } = openEdit(PLAIN)
    typeAmount('0,5')
    fireEvent.click(screen.getByTestId('item-edit-amount-unit-lb'))
    save()
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(patches()).toEqual([{ quantity_value: 0.5, quantity_unit: 'lb' }])
  })

  it('the same amount typed another way is not a change: 2.0 for 2 sends nothing', async () => {
    openEdit(OATS)
    typeAmount('2.0')
    save()
    await screen.findByTestId('row-edit')
    expect(patches()).toEqual([])
  })

  it('clearing sends null, null', async () => {
    const { onChanged } = openEdit(OATS)
    expect(screen.getByTestId('item-edit-amount-clear').textContent).toBe('Clear the amount')
    fireEvent.click(screen.getByTestId('item-edit-amount-clear'))
    expect(amountField().value).toBe('')
    expect(chosenUnit()).toEqual([])
    save()
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(patches()).toEqual([{ quantity_value: null, quantity_unit: null }])
    expect(Object.keys(patches()[0]).sort()).toEqual(['quantity_unit', 'quantity_value'])
  })

  it('a number with no unit is refused in place, in the amount\'s words, and nothing is sent', async () => {
    openEdit(PLAIN)
    typeAmount('2')
    save()
    expect(screen.getByTestId('item-edit-error').textContent).toBe('Pick a unit for the amount — or clear the amount.')
    expect(amountField().getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(amountField())
    await new Promise(r => setTimeout(r, 0))
    expect(patches()).toEqual([])
    expect(panel()).toBeTruthy()
  })

  it('a unit with no number above 0 is refused in place, and nothing is sent', async () => {
    openEdit(PLAIN)
    fireEvent.click(screen.getByTestId('item-edit-amount-unit-lb'))
    save()
    expect(screen.getByTestId('item-edit-error').textContent).toBe('Type the amount as a number above 0 — or clear the amount.')
    for (const bad of ['0', 'two', '-1', '1e3']) {
      typeAmount(bad)
      save()
      expect(screen.getByTestId('item-edit-error').textContent).toBe('Type the amount as a number above 0 — or clear the amount.')
    }
    await new Promise(r => setTimeout(r, 0))
    expect(patches()).toEqual([])
  })

  it('a refusal is cleared by a save that goes through', async () => {
    const { onChanged } = openEdit(PLAIN)
    typeAmount('2')
    save()
    expect(screen.getByTestId('item-edit-error')).toBeTruthy()
    fireEvent.click(screen.getByTestId('item-edit-amount-unit-jar'))
    save()
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(patches()).toEqual([{ quantity_value: 2, quantity_unit: 'jar' }])
  })

  it('where it is from, changed: kind and name travel together, the name trimmed', async () => {
    const { onChanged } = openEdit(OATS)
    fireEvent.click(screen.getByTestId('item-edit-source-farm_stand'))
    fireEvent.change(screen.getByTestId('item-edit-source-label'), { target: { value: '  Warner Farms  ' } })
    save()
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(patches()).toEqual([{ source_kind: 'farm_stand', source_label: 'Warner Farms' }])
  })

  it('only the name of the place changed: both keys still travel', async () => {
    const { onChanged } = openEdit(OATS)
    fireEvent.change(screen.getByTestId('item-edit-source-label'), { target: { value: 'Costco, Burlington' } })
    save()
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(patches()).toEqual([{ source_kind: 'store', source_label: 'Costco, Burlington' }])
  })

  it('a kind with no name sends the name as null; the garden always does', async () => {
    const a = openEdit(PLAIN)
    fireEvent.click(screen.getByTestId('item-edit-source-gift'))
    save()
    await waitFor(() => expect(a.onChanged).toHaveBeenCalled())
    expect(patches()).toEqual([{ source_kind: 'gift', source_label: null }])
  })

  it('the garden chosen over a named store: the name goes with it', async () => {
    const { onChanged } = openEdit(OATS)
    fireEvent.click(screen.getByTestId('item-edit-source-own_garden'))
    expect(screen.queryByTestId('item-edit-source-label')).toBeNull()
    save()
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(patches()).toEqual([{ source_kind: 'own_garden', source_label: null }])
  })

  it('a second tap un-chooses it, and that clears the pair: null, null', async () => {
    const { onChanged } = openEdit(OATS)
    fireEvent.click(screen.getByTestId('item-edit-source-store'))
    expect(chosenSource()).toEqual([])
    save()
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(patches()).toEqual([{ source_kind: null, source_label: null }])
  })

  it('Other with no name is refused in place, in the control\'s own words, and nothing is sent', async () => {
    openEdit(OATS)
    fireEvent.click(screen.getByTestId('item-edit-source-more'))
    fireEvent.click(screen.getByTestId('item-edit-source-other'))
    fireEvent.change(screen.getByTestId('item-edit-source-label'), { target: { value: '   ' } })
    save()
    expect(screen.getByTestId('item-edit-error').textContent).toBe('Where exactly is it from? Type it — or pick another.')
    expect(WHERE_EXACTLY_ERROR).toBe('Where exactly is it from? Type it — or pick another.')
    expect(document.activeElement).toBe(screen.getByTestId('item-edit-source-label'))
    await new Promise(r => setTimeout(r, 0))
    expect(patches()).toEqual([])
  })

  it('everything changed at once is still ONE PATCH, and the Lambda\'s own validator takes it', async () => {
    const { onChanged } = openEdit(OATS)
    fireEvent.change(screen.getByTestId('item-edit-name'), { target: { value: 'Rolled oats, thick' } })
    typeAmount('5')
    fireEvent.click(screen.getByTestId('item-edit-source-gift'))
    fireEvent.change(screen.getByTestId('item-edit-source-label'), { target: { value: 'Aunt May' } })
    fireEvent.change(screen.getByTestId('item-edit-notes'), { target: { value: 'the good ones' } })
    save()
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(patches()).toEqual([{ name: 'Rolled oats, thick', quantity_value: 5, quantity_unit: 'lb', source_kind: 'gift', source_label: 'Aunt May',
      notes: 'the good ones' }])
    expect(validateItemPatch(patches()[0])).toBeNull()
  })

  it('a save the server refuses keeps the panel and what was typed, and says the server\'s sentence', async () => {
    const SAYS = 'This came from one of your plantings, so it is from the garden. It cannot have another source.'
    wire({ overrides: { 'PATCH /api/pantry/items/*': () => { throw apiError(400, { error: SAYS }) } } })
    const { onChanged } = openEdit(OATS)
    typeAmount('9')
    save()
    expect((await screen.findByTestId('item-edit-error')).textContent).toBe(SAYS)
    expect(amountField().value).toBe('9')
    expect(onChanged).not.toHaveBeenCalled()
  })
})

describe('an item that came from a planting', () => {
  it('where it\'s from is absent: its origin is its planting', () => {
    openEdit(PICKED)
    expect(screen.queryByTestId('item-edit-source')).toBeNull()
    expect(within(panel()).queryByRole('radiogroup', { name: "Where it's from" })).toBeNull()
    expect(panel().textContent).not.toContain("Where it's from")
    // How much is still there, seeded.
    expect(amountField().value).toBe('1.5')
    expect(chosenUnit()).toEqual(['qt'])
  })

  it('its save never carries a source key, whatever else changed', async () => {
    const { onChanged } = openEdit(PICKED)
    typeAmount('2')
    fireEvent.change(screen.getByTestId('item-edit-notes'), { target: { value: 'washed' } })
    save()
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(patches()).toEqual([{ quantity_value: 2, quantity_unit: 'qt', notes: 'washed' }])
    expect(Object.keys(patches()[0]).some(k => k.startsWith('source_'))).toBe(false)
  })

  it('an item with no planting has it, whatever it stores', () => {
    openEdit(PLAIN)
    expect(screen.getByRole('radiogroup', { name: "Where it's from" })).toBe(screen.getByTestId('item-edit-source'))
  })
})
