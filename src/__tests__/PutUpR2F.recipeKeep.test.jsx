// Put-Up R2a, lane F (D2, BUG-RECIPELINEKEEPDROP-001) — the recipe sheet, rendered: a stored line's facts
// (form, brand, role, note, listed heat, the salt facts) are not edited on the sheet, so they ride through a
// Save untouched — unless the edit changed what the line IS (its name, its number or its unit).
//
// THE DEFECT: every line edit went through `setLine`, which cleared the line's stored copy (`_keep`), so
// tapping "at the end" or retyping only the amount as written re-inserted the line with none of its facts.
// The PATCH replaces the whole line set, so the loss was silent and permanent.
// MUTATIONS (each run, each red here):
//   F-M1  put `_keep: undefined` back in setLine (= the base)    -> "toggling at the end keeps the line's form, …"
//                                                                    and "retyping only the amount as written …"
//   F-M1b copy the facts even when the name changed              -> "renaming a line drops its facts"
// CI lane: `npm test` plus the TZ re-run. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, cleanup, within } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
const auth = { user: { id: 'user_dave' } }
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => auth, useAuth: () => auth }))

import RecipeSheet from '../components/recipes/RecipeSheet.jsx'
import { clearReloadBlocks } from '../lib/reloadGate.js'
import { validateRecipePatch } from '../../lambda/preservation/recipeRules.js'

// The detail read as the Lambda answers it: a pepper line with a form, a brand, a note and a listed heat,
// and a salt line with its role and salt facts.
const PEPPER_FACTS = { form: 'dried', brand: 'Taekyung', note: 'coarse', shu_rating_low: 1500, shu_rating_high: 10000 }
const SALT_FACTS = { brand: 'Diamond Crystal', role: 'salt', salt_pct: '3', salt_base: 'produce', base_g: '400', salt_method: 'dry', base_from: 'lines' }
const RECIPE = {
  id: 'r1', user_id: 'user_dave', name: 'Roll for Initiative', kind: 'ferment', recipe_type_id: null, type_label: null,
  link_url: null, notes: null, keeps_n: null, keeps_unit: null, keeps_storage_kind: null,
  lines: [
    { id: 'l1', ordinal: 1, name: 'gochugaru', amount_text: '10 g', qty: '10', qty_unit: 'g', at_the_end: false, role: null, ...PEPPER_FACTS },
    { id: 'l2', ordinal: 2, name: 'salt', amount_text: '3% of the peppers', qty: '12', qty_unit: 'g', at_the_end: false, form: null, ...SALT_FACTS },
  ],
  batches: [],
}

const tap = (el) => fireEvent.click(el)
const type = (el, value) => fireEvent.change(el, { target: { value } })
const line = (i) => screen.getAllByTestId('recipe-line')[i]
const inLine = (i, id) => within(line(i)).getByTestId(id)
const patches = () => fetchSpy.mock.calls.filter(([p, o]) => p === '/api/recipes/r1' && o?.method === 'PATCH')
async function saved() {
  await act(async () => { tap(screen.getByTestId('recipe-save')) })
  await waitFor(() => expect(patches()).toHaveLength(1))
  const body = JSON.parse(patches()[0][1].body)
  // What the sheet sends is a body the Lambda's own rule takes.
  expect(validateRecipePatch(body)).toBeNull()
  return body.lines
}

beforeEach(() => {
  fetchSpy.mockReset()
  fetchSpy.mockImplementation(() => Promise.resolve({ recipe: RECIPE }))
  localStorage.clear(); clearReloadBlocks()
  window.history.replaceState({ __floor: 1 }, '')
  render(<RecipeSheet open recipe={RECIPE} types={[]} fetch={fetchSpy} onClose={() => {}} onSaved={() => {}} />)
})
afterEach(() => { cleanup(); clearReloadBlocks() })

describe('the recipe sheet — a line\'s facts ride through an edit that leaves the line what it was (D2)', () => {
  it('toggling at the end keeps the line\'s form, brand, role, heat and salt facts on the PATCH', async () => {
    tap(inLine(0, 'recipe-line-end'))
    tap(inLine(1, 'recipe-line-end'))
    expect(await saved()).toEqual([
      { ordinal: 1, name: 'gochugaru', amount_text: '10 g', qty: '10', qty_unit: 'g', at_the_end: true, ...PEPPER_FACTS },
      { ordinal: 2, name: 'salt', amount_text: '3% of the peppers', qty: '12', qty_unit: 'g', at_the_end: true, ...SALT_FACTS },
    ])
  })

  it('retyping only the amount as written keeps them too, and the other line goes back untouched', async () => {
    type(inLine(0, 'recipe-line-amount'), '2 heaped tsp')
    expect(await saved()).toEqual([
      { ordinal: 1, name: 'gochugaru', amount_text: '2 heaped tsp', qty: '10', qty_unit: 'g', ...PEPPER_FACTS },
      { ordinal: 2, name: 'salt', amount_text: '3% of the peppers', qty: '12', qty_unit: 'g', ...SALT_FACTS },
    ])
  })

  // A toggle there and back is two edits: the stored copy is still the line's.
  it('at the end, tapped on and off again, sends the line back as it was stored', async () => {
    tap(inLine(0, 'recipe-line-end'))
    tap(inLine(0, 'recipe-line-end'))
    type(screen.getByTestId('recipe-name'), 'Roll for Initiative II')
    expect((await saved())[0]).toEqual({ ordinal: 1, name: 'gochugaru', amount_text: '10 g', qty: '10', qty_unit: 'g', ...PEPPER_FACTS })
  })

  // The other half of the rule, which was already true and must stay true: a line that became something else
  // is what was typed, with no facts from the line it replaced.
  it('renaming a line drops its facts', async () => {
    type(inLine(0, 'recipe-line-name'), 'paprika')
    expect((await saved())[0]).toEqual({ ordinal: 1, name: 'paprika', amount_text: '10 g', qty: '10', qty_unit: 'g' })
  })

  it('changing its number, or its unit, drops them too', async () => {
    type(inLine(0, 'recipe-line-qty'), '25')
    type(inLine(1, 'recipe-line-unit'), 'oz')
    expect(await saved()).toEqual([
      { ordinal: 1, name: 'gochugaru', amount_text: '10 g', qty: '25', qty_unit: 'g' },
      { ordinal: 2, name: 'salt', amount_text: '3% of the peppers', qty: '12', qty_unit: 'oz' },
    ])
  })

  // A rename undone before Save: the stored copy was never thrown away, so the line is whole again.
  it('a name changed and typed back is the stored line again, facts and all', async () => {
    type(inLine(0, 'recipe-line-name'), 'paprika')
    type(inLine(0, 'recipe-line-name'), 'gochugaru')
    type(screen.getByTestId('recipe-name'), 'Roll for Initiative II')
    expect((await saved())[0]).toEqual({ ordinal: 1, name: 'gochugaru', amount_text: '10 g', qty: '10', qty_unit: 'g', ...PEPPER_FACTS })
  })
})
