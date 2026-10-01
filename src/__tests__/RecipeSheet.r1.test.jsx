// Put-Up UX pass R1, lane D — the recipe sheet (D7), rendered: src/components/recipes/RecipeSheet.jsx and
// TypePicker.jsx. The sheet reads top to bottom, both pickers say what they are for, the type row opens short,
// a line keeps its exact number one tap away (and shows it by itself when it matters), and "How long, and
// where" is chips over the Lambda's six place kinds with the stored one always chosen on screen.
//
// WHAT MUST NOT MOVE: the body (an untouched "how long, and where" line goes back byte for byte, for every
// kind), the notes, and the draft's shape — a draft written by the sheet as it shipped before this pass restores.
// MUTATIONS (each run, each red here):
//   the stored place kind left off the chips                    -> "an edit that never touches the line sends it back…"
//   the digit rule removed / the number rule removed            -> "opens by itself…" / "a line that already holds a number…"
//   a line's asked-for state not removed with its line          -> "removing a line keeps the others' exact amounts as they were"
//   the kind picker left above the notes                        -> "reads top to bottom"
//   the type row showing every type                             -> "opens on the types in use"
//   a native checkbox brought back                              -> "every chip is 48 px and there is no native checkbox"
// CI lane: `npm test` plus the TZ re-run. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, cleanup, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
const auth = { user: { id: 'user_dave' } }
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => auth, useAuth: () => auth }))
vi.mock('../components/kitchen/StartBatchSheet.jsx', () => ({ default: () => null }))

import RecipesView from '../components/recipes/RecipesView.jsx'
import RecipeSheet from '../components/recipes/RecipeSheet.jsx'
import { clearReloadBlocks } from '../lib/reloadGate.js'
import { recipeBody, emptyDraft, RECIPE_STORAGE_KINDS, STORAGE_KIND_WORDS } from '../components/recipes/recipes.js'
import { SHEET_DRAFT_PREFIX, SHEET_DRAFT_VERSION } from '../components/kitchen/sheetDraft.js'
import { validateRecipeCreate, validateRecipePatch } from '../../lambda/preservation/recipeRules.js'

const NOW = new Date(2026, 9, 9, 12, 0, 0).getTime()
const TYPES = [
  { id: 't-shrub', label: 'Shrub', builtin: false, sort_order: 1000, user_id: 'user_dave' },
  { id: 't-jam', label: 'Jam & preserve', builtin: true, sort_order: 80, user_id: null },
  { id: 't-hot', label: 'Hot sauce', builtin: true, sort_order: 10, user_id: null },
  { id: 't-paste', label: 'Chili paste', builtin: true, sort_order: 20, user_id: null },
  { id: 't-pesto', label: 'Pesto', builtin: true, sort_order: 70, user_id: null },
]
const LIST = [
  { id: 'r1', name: 'Roll for Initiative', recipe_type_id: 't-hot', type_label: 'Hot sauce', type_sort: 10, batch_count: 2 },
  { id: 'r2', name: 'Basil pesto', recipe_type_id: 't-pesto', type_label: 'Pesto', type_sort: 70, batch_count: 0 },
  { id: 'r3', name: 'Mystery', recipe_type_id: null, type_label: null, batch_count: 0 },
]
const DETAIL = {
  id: 'r1', user_id: 'user_dave', name: 'Roll for Initiative', kind: 'ferment', recipe_type_id: 't-hot', type_label: 'Hot sauce',
  link_url: 'https://example.com/mojo', notes: '**Steps**\n1. Blend.', keeps_n: 7, keeps_unit: 'day', keeps_storage_kind: 'fridge',
  vessel_label: 'quart jar', vessel_size: '1', vessel_unit: 'qt', vessel_count: 1,
  bottle_label: '8 oz woozy', bottle_size: '8', bottle_unit: 'fl oz', bottle_cooked: true, made_text: '228 g',
  lines: [
    { id: 'l1', ordinal: 1, name: 'jalapeño', amount_text: 'fresh jalapeño', qty: '170', qty_unit: 'g', at_the_end: false, form: 'fresh' },
    { id: 'l2', ordinal: 2, name: 'cumin', amount_text: 'pinch', qty: null, qty_unit: null, at_the_end: false },
    { id: 'l3', ordinal: 3, name: 'onion', amount_text: '20 g onion', qty: null, qty_unit: null, at_the_end: true },
  ],
  batches: [],
}

function wire(extra = {}) {
  const routes = {
    'GET /api/recipes': () => ({ recipes: LIST }),
    'GET /api/recipes/types': () => ({ types: TYPES }),
    'GET /api/recipes/r1': () => ({ recipe: DETAIL }),
    'POST /api/recipes': (b) => ({ recipe: { id: 'r-new', name: b.name, lines: [] } }),
    'PATCH /api/recipes/r1': (b) => ({ recipe: { ...DETAIL, name: b.name } }),
    ...extra,
  }
  fetchSpy.mockImplementation((path, o = {}) => {
    const hit = routes[`${(o.method ?? 'GET').toUpperCase()} ${path}`]
    if (!hit) return Promise.resolve(null)
    try { return Promise.resolve(hit(o.body ? JSON.parse(o.body) : null)) } catch (e) { return Promise.reject(e) }
  })
}
const calls = (method, path) => fetchSpy.mock.calls.filter(([p, o]) => p === path && (o?.method ?? 'GET').toUpperCase() === method)
const bodyOf = (method, path, i = 0) => JSON.parse(calls(method, path)[i][1].body)
const tap = (id) => fireEvent.click(screen.getByTestId(id))
const type = (el, value) => fireEvent.change(el, { target: { value } })
const sheet = () => screen.getByTestId('recipe-sheet')
const texts = (id) => screen.queryAllByTestId(id).map(e => e.textContent)
const typeChips = () => texts('recipe-type-chip')
const pressed = (id) => screen.getAllByTestId(id).filter(e => e.getAttribute('aria-pressed') === 'true').map(e => e.textContent)
const lines = () => screen.getAllByTestId('recipe-line')
const inLine = (i, id) => within(lines()[i]).queryByTestId(id)
const placeChips = () => [...screen.getByTestId('recipe-keeps-kind').querySelectorAll('[aria-pressed]')].map(e => e.textContent)
const unitsChecked = () => [...screen.getByTestId('recipe-keeps-unit').querySelectorAll('[role="radio"]')].filter(e => e.getAttribute('aria-checked') === 'true').map(e => e.textContent)
const draftKey = (id) => `${SHEET_DRAFT_PREFIX}user_dave:recipe:${id}`

beforeEach(() => { fetchSpy.mockReset(); wire(); localStorage.clear(); clearReloadBlocks(); window.history.replaceState({ __floor: 1 }, '') })
afterEach(() => { cleanup(); clearReloadBlocks() })

// The sheet through the Recipes segment (so the type chips know which types are in use)…
const openNew = async () => {
  render(<MemoryRouter><RecipesView now={NOW} /></MemoryRouter>)
  await waitFor(() => expect(screen.getAllByTestId('recipes-row')).toHaveLength(3))
  tap('recipes-new')
}
const openEdit = async (recipe = DETAIL) => {
  wire({ 'GET /api/recipes/r1': () => ({ recipe }) })
  render(<MemoryRouter><RecipesView now={NOW} /></MemoryRouter>)
  await waitFor(() => expect(screen.getAllByTestId('recipes-row')).toHaveLength(3))
  fireEvent.click(screen.getAllByTestId('recipes-row')[0])
  await waitFor(() => expect(screen.getByTestId('recipe-edit')).toBeTruthy())
  tap('recipe-edit')
}
// …or alone, for what needs nothing but the sheet.
const mountSheet = (props = {}) => {
  const onSaved = vi.fn()
  render(<RecipeSheet open types={TYPES} fetch={fetchSpy} onClose={() => {}} onSaved={onSaved} {...props} />)
  return { onSaved }
}

describe('the sheet reads top to bottom, and each picker says what it is for (D7)', () => {
  it('reads top to bottom: name, what it makes, notes, link, lines, how long and where, how it\'s made, made in, put up in', async () => {
    await openNew()
    const order = [...sheet().querySelectorAll('[data-testid="recipe-name"], [data-testid="recipe-type"], [data-testid="recipe-notes"], [data-testid="recipe-link"], '
      + '[data-testid="recipe-lines"], [data-testid="recipe-keeps"], [data-testid="recipe-kind"], [data-testid="recipe-vessel"], [data-testid="recipe-bottle"]')]
      .map(e => e.getAttribute('data-testid'))
    expect(order).toEqual(['recipe-name', 'recipe-type', 'recipe-notes', 'recipe-link', 'recipe-lines', 'recipe-keeps', 'recipe-kind', 'recipe-vessel', 'recipe-bottle'])
    // "How it's made" sits directly above "Made in".
    expect(screen.getByTestId('recipe-kind').nextElementSibling).toBe(screen.getByTestId('recipe-vessel'))
  })

  it('the two helpers, under their own labels, and the pickers are told apart by name', async () => {
    await openNew()
    const [typeLabel, typeHelp] = screen.getByTestId('recipe-type').children
    expect([typeLabel.textContent, typeHelp.textContent]).toEqual(['What it makes optional', 'Groups it in your recipe list.'])
    const [kindLabel, kindHelp] = screen.getByTestId('recipe-kind').children
    expect([kindLabel.textContent, kindHelp.textContent]).toEqual(["How it's made optional", 'The kind of batch Make this starts.'])
    expect(screen.getByRole('group', { name: 'What it makes' })).toBeTruthy()
    expect(screen.getByRole('group', { name: "How it's made" })).toBeTruthy()
    expect(texts('recipe-kind-chip')).toEqual(['Ferment', 'Dry', 'Candy', 'Cure', 'Infuse', 'Other'])
  })

  it('only the name is required', async () => {
    await openNew()
    expect([...sheet().querySelectorAll('[aria-required="true"], [required]')].map(e => e.getAttribute('data-testid'))).toEqual(['recipe-name'])
  })
})

describe('the type chips — short at open, everything one tap behind "More types…" (D7)', () => {
  it('opens on the types in use, then More types…; New type… and the rest are behind it', async () => {
    await openNew()
    expect(typeChips()).toEqual(['Hot sauce', 'Pesto'])
    expect(screen.getByTestId('recipe-type-more').textContent).toBe('More types…')
    expect(screen.queryByTestId('recipe-type-new')).toBeNull()
    tap('recipe-type-more')
    expect(typeChips()).toEqual(['Hot sauce', 'Pesto', 'Chili paste', 'Jam & preserve', 'Shrub'])
    expect(screen.getByTestId('recipe-type-new').textContent).toBe('New type…')
    expect(screen.queryByTestId('recipe-type-more')).toBeNull()
    // The tap that removed "More types…" hands focus to the first chip it revealed.
    expect(document.activeElement.textContent).toBe('Chili paste')
  })

  it('"More types…" is a disclosure, not a choice: it carries no pressed state', async () => {
    await openNew()
    const more = screen.getByTestId('recipe-type-more')
    expect([more.getAttribute('aria-expanded'), more.hasAttribute('aria-pressed')]).toEqual(['false', false])
  })

  it('a chip never moves when another is tapped; the chosen one is pressed where it stands', async () => {
    await openNew()
    fireEvent.click(screen.getAllByTestId('recipe-type-chip')[1])
    expect(typeChips()).toEqual(['Hot sauce', 'Pesto'])
    expect(pressed('recipe-type-chip')).toEqual(['Pesto'])
    tap('recipe-type-more')
    fireEvent.click(screen.getAllByTestId('recipe-type-chip').find(c => c.textContent === 'Shrub'))
    expect(typeChips()).toEqual(['Hot sauce', 'Pesto', 'Chili paste', 'Jam & preserve', 'Shrub'])
    expect(pressed('recipe-type-chip')).toEqual(['Shrub'])
    // Tapping the chosen chip again clears it, as before.
    fireEvent.click(screen.getAllByTestId('recipe-type-chip').find(c => c.textContent === 'Shrub'))
    expect(pressed('recipe-type-chip')).toEqual([])
  })

  it('an edit opens with the recipe\'s own type first and chosen, used elsewhere or not', async () => {
    await openEdit({ ...DETAIL, recipe_type_id: 't-jam', type_label: 'Jam & preserve' })
    expect(typeChips()).toEqual(['Jam & preserve', 'Hot sauce', 'Pesto'])
    expect(pressed('recipe-type-chip')).toEqual(['Jam & preserve'])
    cleanup()
    await openEdit()
    expect(typeChips()).toEqual(['Hot sauce', 'Pesto'])
    expect(pressed('recipe-type-chip')).toEqual(['Hot sauce'])
  })

  it('a household with no recipes yet still reaches every type: More types… alone, then all of them', () => {
    mountSheet()
    expect(typeChips()).toEqual([])
    tap('recipe-type-more')
    expect(typeChips()).toEqual(['Hot sauce', 'Chili paste', 'Pesto', 'Jam & preserve', 'Shrub'])
    expect(screen.getByTestId('recipe-type-new')).toBeTruthy()
  })

  it('the chosen type goes on the wire as before', async () => {
    await openNew()
    type(screen.getByTestId('recipe-name'), 'Peach shrub')
    tap('recipe-type-more')
    fireEvent.click(screen.getAllByTestId('recipe-type-chip').find(c => c.textContent === 'Shrub'))
    await act(async () => { tap('recipe-save') })
    await waitFor(() => expect(calls('POST', '/api/recipes')).toHaveLength(1))
    expect(bodyOf('POST', '/api/recipes')).toMatchObject({ name: 'Peach shrub', recipe_type_id: 't-shrub' })
  })
})

describe('a line — its name, the amount as he would write it, and the exact amount one tap away (D7)', () => {
  it('a new line: Name, Amount as you\'d write it, an "at the end" chip, and ▸ exact amount in place of the number', async () => {
    await openNew()
    tap('recipe-line-add')
    expect(inLine(0, 'recipe-line-name').getAttribute('placeholder')).toBe('Name')
    expect(inLine(0, 'recipe-line-amount').getAttribute('placeholder')).toBe("Amount as you'd write it")
    const end = inLine(0, 'recipe-line-end')
    expect([end.tagName, end.textContent, end.getAttribute('aria-pressed'), end.style.minHeight]).toEqual(['BUTTON', 'at the end', 'false', '48px'])
    expect(end.getAttribute('aria-label')).toBe('Line 1: at the end')
    const exact = inLine(0, 'recipe-line-exact')
    expect([exact.textContent, exact.getAttribute('aria-expanded'), exact.style.minHeight]).toEqual(['▸ exact amount', 'false', '48px'])
    expect(inLine(0, 'recipe-line-qty')).toBeNull()
    expect(inLine(0, 'recipe-line-unit')).toBeNull()
  })

  it('opens by itself when the amount as written starts with a digit — and reads nothing out of it', async () => {
    await openNew()
    type(screen.getByTestId('recipe-name'), 'Mojo')
    tap('recipe-line-add')
    type(inLine(0, 'recipe-line-name'), 'jalapeño')
    type(inLine(0, 'recipe-line-amount'), 'a handful')
    expect(inLine(0, 'recipe-line-qty')).toBeNull()
    type(inLine(0, 'recipe-line-amount'), '412 g')
    expect(inLine(0, 'recipe-line-exact')).toBeNull()
    expect([inLine(0, 'recipe-line-qty').value, inLine(0, 'recipe-line-unit').value]).toEqual(['', ''])
    await act(async () => { tap('recipe-save') })
    await waitFor(() => expect(calls('POST', '/api/recipes')).toHaveLength(1))
    expect(bodyOf('POST', '/api/recipes').lines).toEqual([{ ordinal: 1, name: 'jalapeño', amount_text: '412 g' }])
  })

  it('a line that already holds a number opens with it showing; one that is only words stays shut', async () => {
    await openEdit()
    expect(lines()).toHaveLength(3)
    expect([inLine(0, 'recipe-line-qty').value, inLine(0, 'recipe-line-unit').value]).toEqual(['170', 'g'])   // a stored number, words for an amount
    expect(inLine(0, 'recipe-line-exact')).toBeNull()
    expect(inLine(1, 'recipe-line-qty')).toBeNull()                                                              // "pinch"
    expect(inLine(1, 'recipe-line-exact')).toBeTruthy()
    expect(inLine(2, 'recipe-line-qty')).toBeTruthy()                                                            // "20 g onion": a digit leads
    expect(inLine(2, 'recipe-line-end').getAttribute('aria-pressed')).toBe('true')
  })

  it('a number typed keeps it open whatever the amount says next; emptied, a wordy line shuts again', async () => {
    await openNew()
    tap('recipe-line-add')
    type(inLine(0, 'recipe-line-amount'), '8 g')
    type(inLine(0, 'recipe-line-qty'), '8')
    type(inLine(0, 'recipe-line-amount'), 'a pinch')
    expect(inLine(0, 'recipe-line-qty').value).toBe('8')
    type(inLine(0, 'recipe-line-qty'), '')
    expect(inLine(0, 'recipe-line-qty')).toBeNull()
    expect(inLine(0, 'recipe-line-exact')).toBeTruthy()
  })

  it('▸ exact amount opens the number and the unit, puts focus in the number, and they go on the wire together', async () => {
    await openNew()
    type(screen.getByTestId('recipe-name'), 'Mojo')
    tap('recipe-line-add')
    type(inLine(0, 'recipe-line-name'), 'garlic')
    type(inLine(0, 'recipe-line-amount'), 'four cloves')
    fireEvent.click(inLine(0, 'recipe-line-exact'))
    expect(inLine(0, 'recipe-line-exact')).toBeNull()
    expect(document.activeElement).toBe(inLine(0, 'recipe-line-qty'))
    expect(inLine(0, 'recipe-line-qty').getAttribute('placeholder')).not.toMatch(/\d/)       // nothing that reads as a value
    type(inLine(0, 'recipe-line-qty'), '4')
    fireEvent.change(inLine(0, 'recipe-line-unit'), { target: { value: 'clove' } })
    fireEvent.click(inLine(0, 'recipe-line-end'))
    await act(async () => { tap('recipe-save') })
    await waitFor(() => expect(calls('POST', '/api/recipes')).toHaveLength(1))
    const body = bodyOf('POST', '/api/recipes')
    expect(body.lines).toEqual([{ ordinal: 1, name: 'garlic', amount_text: 'four cloves', qty: '4', qty_unit: 'clove', at_the_end: true }])
    expect(validateRecipeCreate(body)).toBeNull()
  })

  it('removing a line keeps the others\' exact amounts as they were', async () => {
    await openNew()
    for (const [i, name] of ['salt', 'cumin', 'onion'].entries()) {
      tap('recipe-line-add')
      type(inLine(i, 'recipe-line-name'), name)
    }
    fireEvent.click(inLine(1, 'recipe-line-exact'))                       // asked for on the MIDDLE line only
    expect([0, 1, 2].map(i => !!inLine(i, 'recipe-line-qty'))).toEqual([false, true, false])
    fireEvent.click(inLine(0, 'recipe-line-remove'))                      // cumin is now line 1, still open
    expect(lines().map((_, i) => [inLine(i, 'recipe-line-name').value, !!inLine(i, 'recipe-line-qty')])).toEqual([['cumin', true], ['onion', false]])
    fireEvent.click(inLine(0, 'recipe-line-remove'))                      // onion is now line 1, and was never asked for
    expect(lines().map((_, i) => [inLine(i, 'recipe-line-name').value, !!inLine(i, 'recipe-line-qty')])).toEqual([['onion', false]])
  })

  it('opening a line\'s exact amount writes no draft: what is open is the sheet\'s, not the recipe\'s', async () => {
    await openNew()
    expect(localStorage.getItem(draftKey('new'))).toBeNull()
    tap('recipe-type-more')
    tap('recipe-keeps-kind-more')
    expect(localStorage.getItem(draftKey('new'))).toBeNull()
    tap('recipe-line-add')
    fireEvent.click(inLine(0, 'recipe-line-exact'))
    const stored = JSON.parse(localStorage.getItem(draftKey('new')))
    expect(stored.data.lines).toEqual([{ name: '', amount: '', qty: '', unit: '', atTheEnd: false }])
  })
})

describe('"How long, and where" — a number, three units, and the six kinds of place (D7)', () => {
  it('How many is a labelled, EMPTY field with nothing in it that reads as a value; no unit is lit on an empty line', async () => {
    await openNew()
    const n = screen.getByLabelText('How many')
    expect(n).toBe(screen.getByTestId('recipe-keeps-n'))
    expect([n.value, n.getAttribute('placeholder')]).toEqual(['', null])
    expect([...screen.getByTestId('recipe-keeps-unit').querySelectorAll('[role="radio"]')].map(e => e.textContent)).toEqual(['days', 'weeks', 'months'])
    expect(unitsChecked()).toEqual([])
    expect(pressed('recipe-kind-chip')).toEqual([])
    expect(placeChips()).toEqual(['Fridge', 'Deep freezer', 'Pantry shelf'])
    expect(screen.getByTestId('recipe-keeps-kind-more').textContent).toBe('More…')
    // In the order the legend says them: how long (the number, the unit), then where.
    const row = screen.getByTestId('recipe-keeps')
    const pos = (el) => [...row.querySelectorAll('*')].indexOf(el)
    expect(pos(n)).toBeLessThan(pos(screen.getByTestId('recipe-keeps-unit')))
    expect(pos(screen.getByTestId('recipe-keeps-unit'))).toBeLessThan(pos(screen.getByTestId('recipe-keeps-kind')))
    expect(row.querySelector('legend').textContent).toBe('How long, and where optional')
  })

  it('the unit lights with the first thing the line is given — days unless another is tapped — and is sent as shown', async () => {
    await openNew()
    type(screen.getByTestId('recipe-name'), 'Mojo')
    type(screen.getByTestId('recipe-keeps-n'), '3')
    expect(unitsChecked()).toEqual(['days'])
    tap('recipe-keeps-unit-week')
    expect(unitsChecked()).toEqual(['weeks'])
    tap('recipe-keeps-kind-pantry')
    expect(pressed('recipe-keeps-kind-pantry')).toEqual(['Pantry shelf'])
    await act(async () => { tap('recipe-save') })
    await waitFor(() => expect(calls('POST', '/api/recipes')).toHaveLength(1))
    expect(bodyOf('POST', '/api/recipes').keeps).toEqual({ n: 3, unit: 'week', storage_kind: 'pantry' })
  })

  it('a unit tapped first lights at once, days included', async () => {
    await openNew()
    tap('recipe-keeps-unit-day')
    expect(unitsChecked()).toEqual(['days'])
    tap('recipe-keeps-unit-month')
    expect(unitsChecked()).toEqual(['months'])
  })

  it('More… brings the other three kinds, each with its own words, and focus goes to the first of them', async () => {
    await openNew()
    tap('recipe-keeps-kind-more')
    expect(placeChips()).toEqual(['Fridge', 'Deep freezer', 'Pantry shelf', 'Fridge freezer', 'Cellar', 'Counter'])
    expect(placeChips()).toEqual(['fridge', 'deep_freezer', 'pantry', 'fridge_freezer', 'cold_storage', 'other'].map(k => STORAGE_KIND_WORDS[k]))
    expect(screen.queryByTestId('recipe-keeps-kind-more')).toBeNull()
    expect(document.activeElement.textContent).toBe('Fridge freezer')
    tap('recipe-keeps-kind-other')
    expect(pressed('recipe-keeps-kind-other')).toEqual(['Counter'])
    tap('recipe-keeps-kind-other')                                        // the chosen chip, tapped again, clears it
    expect(placeChips().length).toBe(6)
    expect([...screen.getByTestId('recipe-keeps-kind').querySelectorAll('[aria-pressed="true"]')]).toHaveLength(0)
  })

  // THE REGRESSION THIS GUARDS: three chips over six stored kinds. An edit that never touches the line must
  // show the stored kind as chosen without a tap, and send the line back exactly as it was stored.
  it.each(RECIPE_STORAGE_KINDS)('an edit that never touches the line sends it back byte for byte, and shows it chosen: %s', async (kind) => {
    const recipe = { ...DETAIL, keeps_n: 7, keeps_unit: 'week', keeps_storage_kind: kind }
    mountSheet({ recipe })
    expect([...screen.getByTestId('recipe-keeps-kind').querySelectorAll('[aria-pressed="true"]')].map(e => e.textContent)).toEqual([STORAGE_KIND_WORDS[kind]])
    expect(screen.getByTestId('recipe-keeps-n').value).toBe('7')
    expect(unitsChecked()).toEqual(['weeks'])
    type(screen.getByTestId('recipe-name'), 'Roll for Initiative II')
    await act(async () => { tap('recipe-save') })
    await waitFor(() => expect(calls('PATCH', '/api/recipes/r1')).toHaveLength(1))
    const sent = calls('PATCH', '/api/recipes/r1')[0][1].body
    expect(sent).toContain(`"keeps":{"n":7,"unit":"week","storage_kind":"${kind}"}`)
    const body = JSON.parse(sent)
    // The Lambda's own PATCH rules take it (the fixture's short type id stands in for a uuid, nothing else).
    expect(validateRecipePatch({ ...body, recipe_type_id: '7ec1be00-0000-4000-8000-000000000001' })).toBeNull()
    // …and nothing else about the recipe moved either.
    expect(body).toMatchObject({ kind: 'ferment', recipe_type_id: 't-hot', notes: '**Steps**\n1. Blend.', bottle_cooked: true })
  })

  it('the stored kind stays on screen after another is picked, so going back is one tap', () => {
    mountSheet({ recipe: { ...DETAIL, keeps_storage_kind: 'cold_storage' } })
    expect(placeChips()).toEqual(['Fridge', 'Deep freezer', 'Pantry shelf', 'Cellar'])
    tap('recipe-keeps-kind-fridge')
    expect(placeChips()).toEqual(['Fridge', 'Deep freezer', 'Pantry shelf', 'Cellar'])
    expect(pressed('recipe-keeps-kind-fridge')).toEqual(['Fridge'])
    tap('recipe-keeps-kind-cold_storage')
    expect(pressed('recipe-keeps-kind-cold_storage')).toEqual(['Cellar'])
  })

  it('a recipe with no such line opens with none chosen and sends none', async () => {
    mountSheet({ recipe: { ...DETAIL, keeps_n: null, keeps_unit: null, keeps_storage_kind: null } })
    expect(unitsChecked()).toEqual([])
    expect([...screen.getByTestId('recipe-keeps-kind').querySelectorAll('[aria-pressed="true"]')]).toHaveLength(0)
    type(screen.getByTestId('recipe-name'), 'Roll for Initiative II')
    await act(async () => { tap('recipe-save') })
    await waitFor(() => expect(calls('PATCH', '/api/recipes/r1')).toHaveLength(1))
    expect(bodyOf('PATCH', '/api/recipes/r1').keeps).toBeNull()
  })
})

describe('chips, not checkboxes; 48 px (F16)', () => {
  it('every chip is 48 px and there is no native checkbox', async () => {
    await openEdit()
    tap('recipe-type-more')
    tap('recipe-keeps-kind-more')
    expect(sheet().querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
    const chips = [...sheet().querySelectorAll('button[aria-pressed], button[role="radio"], [data-testid="recipe-type-new"]')]
    expect(chips.length).toBeGreaterThanOrEqual(5 + 1 + 3 + 3 + 6 + 6 + 1)       // types, New type…, a chip per line, units, places, kinds, cooked
    for (const c of chips) expect(`${c.textContent} ${c.style.minHeight}`).toBe(`${c.textContent} 48px`)
    // …and so is every quiet action on the sheet.
    for (const id of ['recipe-line-exact', 'recipe-line-remove', 'recipe-line-add']) {
      for (const el of screen.getAllByTestId(id)) expect(`${id} ${el.style.minHeight}`).toBe(`${id} 48px`)
    }
  })

  it('"Cooked after blending" is a chip that says its state, and it reaches the body', async () => {
    await openNew()
    type(screen.getByTestId('recipe-name'), 'Mojo')
    const cooked = screen.getByTestId('recipe-bottle-cooked')
    expect([cooked.tagName, cooked.textContent, cooked.getAttribute('aria-pressed')]).toEqual(['BUTTON', 'Cooked after blending', 'false'])
    fireEvent.click(cooked)
    expect(screen.getByTestId('recipe-bottle-cooked').getAttribute('aria-pressed')).toBe('true')
    await act(async () => { tap('recipe-save') })
    await waitFor(() => expect(calls('POST', '/api/recipes')).toHaveLength(1))
    expect(bodyOf('POST', '/api/recipes').bottle_cooked).toBe(true)
  })
})

// A draft exactly as the sheet stored it BEFORE this pass (v1 envelope; the data's keys are emptyDraft()'s).
describe('a draft written before this pass still restores', () => {
  const PRE_R1 = {
    key: '11111111-1111-4111-8111-111111111111', name: 'Cellar kraut', typeId: 't-jam', kind: 'ferment', link: 'https://example.com/kraut',
    notes: '**Steps**\n1. Shred.\n2 * 3 cups brine.', keepsN: '4', keepsUnit: 'month', keepsKind: 'cold_storage',
    vesselLabel: 'crock', vesselSize: '1', vesselUnit: 'gal', vesselCount: '2',
    bottleLabel: 'quart', bottleSize: '1', bottleUnit: 'qt', bottleCooked: true, madeText: 'about 3 quarts',
    lines: [{ name: 'cabbage', amount: '1 head', qty: '', unit: '', atTheEnd: false }, { name: 'salt', amount: 'salt', qty: '20', unit: 'g', atTheEnd: false },
      { name: 'caraway', amount: 'a pinch', qty: '', unit: '', atTheEnd: true }],
  }
  const store = (data, id = 'new') => localStorage.setItem(draftKey(id), JSON.stringify({ v: SHEET_DRAFT_VERSION, sheet: 'recipe', savedAt: Date.now(), data }))

  it('INSTRUMENT: the fixture is the old sheet\'s shape, key for key', () => {
    expect(Object.keys(PRE_R1)).toEqual(Object.keys(emptyDraft()))
    expect(SHEET_DRAFT_VERSION).toBe(1)
  })

  it('every field comes back, each control showing what was stored', async () => {
    store(PRE_R1)
    await openNew()
    expect(screen.getByTestId('recipe-name').value).toBe('Cellar kraut')
    expect(screen.getByTestId('recipe-notes').value).toBe(PRE_R1.notes)
    expect(screen.getByTestId('recipe-link').value).toBe('https://example.com/kraut')
    expect(typeChips()).toEqual(['Jam & preserve', 'Hot sauce', 'Pesto'])           // its type, though no saved recipe uses it
    expect(pressed('recipe-type-chip')).toEqual(['Jam & preserve'])
    expect(pressed('recipe-kind-chip')).toEqual(['Ferment'])
    expect(lines().map((_, i) => [inLine(i, 'recipe-line-name').value, inLine(i, 'recipe-line-amount').value, inLine(i, 'recipe-line-qty')?.value ?? null,
      inLine(i, 'recipe-line-end').getAttribute('aria-pressed')])).toEqual([['cabbage', '1 head', '', 'false'], ['salt', 'salt', '20', 'false'], ['caraway', 'a pinch', null, 'true']])
    expect(screen.getByTestId('recipe-keeps-n').value).toBe('4')
    expect(unitsChecked()).toEqual(['months'])
    expect([...screen.getByTestId('recipe-keeps-kind').querySelectorAll('[aria-pressed="true"]')].map(e => e.textContent)).toEqual(['Cellar'])
    expect([screen.getByTestId('recipe-vessel-label').value, screen.getByTestId('recipe-vessel-count').value, screen.getByTestId('recipe-bottle-label').value])
      .toEqual(['crock', '2', 'quart'])
    expect(screen.getByTestId('recipe-bottle-cooked').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('recipe-made-text').value).toBe('about 3 quarts')
  })

  it('saved untouched, it sends exactly what the old sheet would have sent — its key included', async () => {
    store(PRE_R1)
    await openNew()
    await act(async () => { tap('recipe-save') })
    await waitFor(() => expect(calls('POST', '/api/recipes')).toHaveLength(1))
    expect(calls('POST', '/api/recipes')[0][1].body).toBe(JSON.stringify(recipeBody(PRE_R1).body))
    expect(bodyOf('POST', '/api/recipes').idempotency_key).toBe(PRE_R1.key)
  })

  it('the draft this sheet writes has the same shape, so the sheet as it shipped can still read it', async () => {
    await openNew()
    type(screen.getByTestId('recipe-name'), 'Mojo')
    tap('recipe-line-add')
    type(inLine(0, 'recipe-line-amount'), '412 g')
    type(screen.getByTestId('recipe-keeps-n'), '7')
    tap('recipe-keeps-kind-fridge')
    fireEvent.click(screen.getByTestId('recipe-bottle-cooked'))
    await waitFor(() => expect(JSON.parse(localStorage.getItem(draftKey('new'))).data.key).toMatch(/^[0-9a-f-]{36}$/))
    const stored = JSON.parse(localStorage.getItem(draftKey('new')))
    expect([stored.v, stored.sheet]).toEqual([1, 'recipe'])
    expect(Object.keys(stored.data)).toEqual(Object.keys(emptyDraft()))
    expect(stored.data.lines).toEqual([{ name: '', amount: '412 g', qty: '', unit: '', atTheEnd: false }])
    expect(stored.data).toMatchObject({ name: 'Mojo', keepsN: '7', keepsUnit: 'day', keepsKind: 'fridge', bottleCooked: true })
  })
})

describe('words — nothing banned on the sheet with every part open', () => {
  const BANNED = /\b(safe|shelf life|shelf-stable|keeps|good|ready|done|expired|table|default|basis)\b/i
  it('INSTRUMENT: the pattern catches a banned word', () => { expect('How long it keeps').toMatch(BANNED) })

  it('the new sheet and the edit sheet, More types… and More… open, a line open and a line shut', async () => {
    await openEdit()
    tap('recipe-type-more')
    tap('recipe-keeps-kind-more')
    tap('recipe-type-new')
    const edit = sheet()
    expect(edit.textContent).toContain('How long, and where')
    expect(edit.textContent).toContain('▸ exact amount')
    expect(edit.textContent).not.toMatch(BANNED)
    for (const el of edit.querySelectorAll('[placeholder], [aria-label]')) {
      expect(`${el.getAttribute('placeholder') ?? ''} ${el.getAttribute('aria-label') ?? ''}`).not.toMatch(BANNED)
    }
    expect(screen.getByRole('dialog').getAttribute('aria-label')).not.toMatch(BANNED)
  })
})
