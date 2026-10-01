// Put-Up UX pass R1, lane D — axe over the surfaces this lane reworked, with every part of them open:
// the Recipes list, recipe detail (the "Made it, ate it all" confirm and the remove question), the recipe sheet
// (More types…, New type…, a line with its exact amount open and one shut, More…), and the planting page's
// kitchen section (a soon row, a used row, the batch links). The rule set is the house gate's
// (helpers/axe.js A11Y_RULES) plus nested-interactive, as the Pantry's own a11y file runs it.
// What these surfaces gained are chips that carry a state (aria-pressed / role=radio + aria-checked) and
// controls that open a part (aria-expanded): each must be a role its attributes are allowed on.
// CI lane: `npm test` plus the TZ re-run. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
const auth = { user: { id: 'user_dave' } }
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => auth, useAuth: () => auth }))
vi.mock('../components/kitchen/StartBatchSheet.jsx', () => ({ default: () => null }))
vi.mock('../components/PutUpPhotoThumb.jsx', () => ({ default: () => null }))

import { expectNoA11yViolations, auditA11y, A11Y_RULES } from './helpers/axe.js'
import RecipesView from '../components/recipes/RecipesView.jsx'
import PlantingKitchen from '../components/planting/PlantingKitchen.jsx'
import { plantingBatchesPath } from '../components/planting/plantingKitchen.js'
import { clearReloadBlocks } from '../lib/reloadGate.js'

const RULES = [...A11Y_RULES, 'nested-interactive']
const NOW = new Date(2026, 9, 1, 12, 0, 0).getTime()
const TYPES = [
  { id: 't-hot', label: 'Hot sauce', builtin: true, sort_order: 10, user_id: null },
  { id: 't-pesto', label: 'Pesto', builtin: true, sort_order: 70, user_id: null },
  { id: 't-jam', label: 'Jam & preserve', builtin: true, sort_order: 80, user_id: null },
]
const LIST = [
  { id: 'r1', name: 'Petri Dish', recipe_type_id: 't-hot', type_label: 'Hot sauce', type_sort: 10, keeps_n: 4, keeps_unit: 'month', keeps_storage_kind: 'cold_storage', batch_count: 2 },
  { id: 'r2', name: 'Basil pesto', recipe_type_id: 't-pesto', type_label: 'Pesto', type_sort: 70, batch_count: 0, link_url: 'https://example.com/pesto' },
]
const DETAIL = {
  id: 'r1', user_id: 'user_dave', name: 'Petri Dish', kind: 'ferment', recipe_type_id: 't-hot', type_label: 'Hot sauce',
  link_url: 'https://example.com/petri', notes: '**Steps**\nMash at *2.5% salt*.\n* strain', keeps_n: 4, keeps_unit: 'month', keeps_storage_kind: 'cold_storage',
  vessel_label: 'quart jar', vessel_size: '1', vessel_unit: 'qt', vessel_count: 2, bottle_label: '5 oz woozy', bottle_size: '5', bottle_unit: 'fl oz', bottle_cooked: true,
  lines: [
    { id: 'l1', ordinal: 1, name: 'cayenne', amount_text: 'cayenne', qty: '500', qty_unit: 'g', at_the_end: false },
    { id: 'l2', ordinal: 2, name: 'cumin', amount_text: 'a pinch', qty: null, qty_unit: null, at_the_end: true },
  ],
  batches: [
    { id: 'b1', label: 'Petri Oct', started_at: '2026-09-02T16:00:00Z', closed_at: '2026-09-20T16:00:00Z', outcome: 'put_up', output_count: '6' },
    { id: 'b2', label: 'Petri again', started_at: '2026-09-28T16:00:00Z', closed_at: null, outcome: null, output_count: '0' },
  ],
}

beforeEach(() => {
  fetchSpy.mockReset(); localStorage.clear(); clearReloadBlocks(); window.history.replaceState({ __floor: 1 }, '')
  fetchSpy.mockImplementation((path) => Promise.resolve(
    path === '/api/recipes' ? { recipes: LIST } : path === '/api/recipes/types' ? { types: TYPES } : path === '/api/recipes/r1' ? { recipe: DETAIL } : null,
  ))
})
afterEach(() => { cleanup(); clearReloadBlocks() })

const tap = (id) => fireEvent.click(screen.getByTestId(id))
const mountRecipes = async () => {
  const view = render(<MemoryRouter><RecipesView now={NOW} /></MemoryRouter>)
  await waitFor(() => expect(screen.getAllByTestId('recipes-row')).toHaveLength(2))
  return view
}

describe('the recipe surfaces are clean (with nested-interactive)', () => {
  it('INSTRUMENT: the audit sees a state put on a role that cannot carry it', async () => {
    const { container } = render(<div><span aria-pressed="true">not a button</span></div>)
    const findings = await auditA11y(container, { rules: RULES })
    expect(findings.map(f => f.rule)).toContain('aria-allowed-attr')
  })

  it('the list, with its type filter', async () => {
    const { container } = await mountRecipes()
    await expectNoA11yViolations(container, { label: 'RecipesView list', rules: RULES })
  })

  it('recipe detail: the notes with their marks, the confirm and the remove question open', async () => {
    const { container } = await mountRecipes()
    fireEvent.click(screen.getAllByTestId('recipes-row')[0])
    await waitFor(() => expect(screen.getByTestId('recipe-detail-name')).toBeTruthy())
    tap('recipe-i-made-this')
    tap('recipe-remove')
    expect(screen.getByTestId('recipe-made-kept-some')).toBeTruthy()
    await expectNoA11yViolations(container, { label: 'RecipeDetail', rules: RULES })
  })

  it('the new-recipe sheet: More types… and New type… open, a line with its exact amount open and one shut, More… open', async () => {
    const { container } = await mountRecipes()
    tap('recipes-new')
    tap('recipe-type-more')
    tap('recipe-type-new')
    tap('recipe-line-add')
    tap('recipe-line-add')
    fireEvent.change(screen.getAllByTestId('recipe-line-amount')[0], { target: { value: '412 g' } })
    fireEvent.change(screen.getByTestId('recipe-keeps-n'), { target: { value: '3' } })
    tap('recipe-keeps-kind-more')
    tap('recipe-keeps-kind-other')
    expect(screen.getAllByTestId('recipe-line-qty')).toHaveLength(1)
    expect(screen.getAllByTestId('recipe-line-exact')).toHaveLength(1)
    await expectNoA11yViolations(container, { label: 'RecipeSheet (new)', rules: RULES })
  })

  it('the edit sheet: a stored Cellar chosen, a stored number showing, the cooked chip pressed', async () => {
    const { container } = await mountRecipes()
    fireEvent.click(screen.getAllByTestId('recipes-row')[0])
    await waitFor(() => expect(screen.getByTestId('recipe-edit')).toBeTruthy())
    tap('recipe-edit')
    expect(screen.getByTestId('recipe-keeps-kind-cold_storage').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('recipe-bottle-cooked').getAttribute('aria-pressed')).toBe('true')
    await expectNoA11yViolations(container, { label: 'RecipeSheet (edit)', rules: RULES })
  })
})

describe('the planting page\'s kitchen section is clean (with nested-interactive)', () => {
  const PLANTING = { id: 'pl-1', name: 'Ristra Cayenne', variety_ref: { crop_type_slug: 'pepper' } }
  const rec = (over) => ({ plant_id: 'pl-1', method: 'whole_freeze', package_count: 2, remaining_count: 2, preserved_at: '2026-09-06', stock_mode: 'counted', storage_kind: 'deep_freezer', ...over })
  const RECORDS = [
    rec({ id: 'j-1', label: 'Cayenne, frozen whole', use_by_target: '2027-09-06', use_by_basis: 'table', use_by_status: 'ok', notes: 'Next time (2026-09-02): pick riper' }),
    rec({ id: 'j-2', label: 'Roasted cayenne', method: 'roast_freeze', remaining_count: 1, use_by_target: '2026-10-09', use_by_basis: 'typed', use_by_status: 'use_soon' }),
    rec({ id: 'j-3', label: 'Cayenne powder', method: 'powder', remaining_count: 0, use_by_target: '2026-10-05', use_by_status: 'use_soon' }),
  ]

  it('rows (one to use soon, one all used), the links to a batch and to the Log form, kept fresh and batches', async () => {
    const fetch = vi.fn((path) => {
      if (String(path).startsWith('/api/preservation/whats-put-up')) return Promise.resolve({ groups: [{ label: 'Chest Freezer 2', records: RECORDS }] })
      if (path === plantingBatchesPath('pl-1')) {
        return Promise.resolve({ plant_id: 'pl-1', kept_fresh: [{ id: 'it-1', name: 'Cayenne (fresh)', place_label: 'Fridge', used_up_at: null, next_time: [] }],
          batches: [{ id: 'kb-1', label: 'Dried cayenne', single_planting: true, output_ids: ['j-1'], used_via: 'garden', next_time: [] },
            { id: 'kb-2', label: 'Party salsa', single_planting: false, output_ids: [], used_via: 'jar', next_time: [{ id: 'n', note: 'char the onions' }] }] })
      }
      return Promise.resolve(null)
    })
    const { container } = render(<MemoryRouter><PlantingKitchen planting={PLANTING} fetch={fetch} now={NOW} /></MemoryRouter>)
    await waitFor(() => expect(screen.getByTestId('planting-batch-kb-2')).toBeTruthy())
    expect(screen.getByTestId('planting-jar-batch-j-1')).toBeTruthy()
    expect(screen.getAllByTestId('putup-from-planting-row')).toHaveLength(3)
    await expectNoA11yViolations(container, { label: 'PlantingKitchen', rules: RULES })
  })
})
