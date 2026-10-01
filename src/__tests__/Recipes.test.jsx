// Put-Up release 4 (V4 §2.6 and its "pH" section) — the recipe surfaces, rendered: the Recipes segment on the Put-Up page,
// the list (grouped and filtered by type), recipe detail (notes verbatim, lines, link, the dated batches with
// their endings — and never a reading), the create sheet with its type picker ("New type…" find-or-create),
// Make this (the Start sheet prefilled, recipe_id + the jar), Following a recipe? (pick → recipe_id, free text
// → recipe_ref, the tested-recipe caution), I made this, and Save as recipe / Made it as written on batch
// detail. CI lane: `npm test` plus the TZ re-run. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, within, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: vi.fn(), isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))
const auth = { user: { id: 'user_dave' } }
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => auth, useAuth: () => auth }))

import RecipesView from '../components/recipes/RecipesView.jsx'
import StartBatchSheet from '../components/kitchen/StartBatchSheet.jsx'
import BatchRecipeRow from '../components/recipes/BatchRecipeRow.jsx'
import { clearReloadBlocks } from '../lib/reloadGate.js'
import { TESTED_RECIPE_NOTE } from '../components/putup/RecipeRefRow.jsx'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const NOW = new Date(2026, 9, 9, 12, 0, 0).getTime()
const TYPES = [
  { id: 't-hot', label: 'Hot sauce', builtin: true, sort_order: 10, user_id: null },
  { id: 't-pesto', label: 'Pesto', builtin: true, sort_order: 70, user_id: null },
]
const LIST = [
  { id: 'r1', name: 'Roll for Initiative', recipe_type_id: 't-hot', type_label: 'Hot sauce', type_sort: 10, keeps_n: 7, keeps_unit: 'day', keeps_storage_kind: 'fridge', batch_count: 2 },
  { id: 'r2', name: 'Basil pesto', recipe_type_id: 't-pesto', type_label: 'Pesto', type_sort: 70, batch_count: 0 },
  { id: 'r3', name: 'Mystery', recipe_type_id: null, type_label: null, batch_count: 0 },
]
const NOTES = 'Mojo Verde\n\n**Steps**\n1. Blend.\n   Keep the spacing.\n\n**Finish**\n- Fridge 7 days'
const DETAIL = {
  id: 'r1', user_id: 'user_jen', name: 'Roll for Initiative', kind: 'ferment', recipe_type_id: 't-hot', type_label: 'Hot sauce',
  link_url: 'https://example.com/mojo', notes: NOTES, keeps_n: 7, keeps_unit: 'day', keeps_storage_kind: 'fridge',
  vessel_label: 'quart jar', vessel_size: '1', vessel_unit: 'qt', vessel_count: 1,
  bottle_label: '8 oz woozy', bottle_size: '8', bottle_unit: 'fl oz', bottle_cooked: true, made_text: '228 g',
  lines: [
    { id: 'l1', ordinal: 1, name: 'jalapeño', amount_text: '170 g fresh jalapeño', qty: '170', qty_unit: 'g', at_the_end: false },
    { id: 'l2', ordinal: 2, name: 'cumin', amount_text: 'pinch', qty: null, qty_unit: null, at_the_end: false },
    { id: 'l3', ordinal: 3, name: 'onion', amount_text: '20 g onion', qty: '20', qty_unit: 'g', at_the_end: true },
  ],
  batches: [
    { id: 'b1', user_id: 'user_jen', label: 'Mojo Oct', started_at: '2026-10-01T16:00:00Z', closed_at: '2026-10-03T16:00:00Z', outcome: 'put_up', current_stage_kind: 'finished', output_count: 1 },
    { id: 'b2', user_id: 'user_dave', label: 'Mojo again', started_at: '2026-10-08T16:00:00Z', closed_at: null, outcome: null },
  ],
}

let routes
function wire(extra = {}) {
  routes = {
    'GET /api/recipes': () => ({ recipes: LIST }),
    'GET /api/recipes/types': () => ({ types: TYPES }),
    'GET /api/recipes/r1': () => ({ recipe: DETAIL }),
    'POST /api/recipes': (b) => ({ recipe: { id: 'r-new', name: b.name, lines: [] } }),
    'POST /api/recipes/types': (b) => ({ type: { id: 't-new', label: b.label, builtin: false, sort_order: 1000 }, created: true }),
    'POST /api/kitchen-batches': (b) => ({ id: 'kb-new', label: b.label }),
    ...extra,
  }
  fetchSpy.mockImplementation((path, o = {}) => {
    const m = (o.method ?? 'GET').toUpperCase()
    const key = `${m} ${path}`
    const hit = routes[key] ?? Object.entries(routes).find(([k]) => k.endsWith('*') && key.startsWith(k.slice(0, -1)))?.[1]
    if (!hit) return Promise.resolve(null)
    try { return Promise.resolve(hit(o.body ? JSON.parse(o.body) : null)) } catch (e) { return Promise.reject(e) }
  })
}
const calls = (method, path) => fetchSpy.mock.calls.filter(([p, o]) => p === path && (o?.method ?? 'GET').toUpperCase() === method)
const bodyOf = (method, path, i = 0) => JSON.parse(calls(method, path)[i][1].body)
const tap = (id) => fireEvent.click(screen.getByTestId(id))
const type = (el, value) => fireEvent.change(el, { target: { value } })

beforeEach(() => {
  fetchSpy.mockReset(); wire(); localStorage.clear(); clearReloadBlocks(); auth.user = { id: 'user_dave' }
  window.history.replaceState({ __floor: 1 }, '')
})
afterEach(() => { cleanup(); clearReloadBlocks() })

const renderView = (props = {}) => render(<MemoryRouter><RecipesView now={NOW} {...props} /></MemoryRouter>)

describe('the Recipes segment — the list', () => {
  it('groups the household\'s recipes by what they make, built-in order, No type last', async () => {
    renderView()
    await waitFor(() => expect(screen.getAllByTestId('recipes-row')).toHaveLength(3))
    const groups = screen.getAllByTestId('recipes-group').map(g => within(g).getByRole('heading').textContent)
    expect(groups).toEqual(['Hot sauce', 'Pesto', 'No type'])
    const row = screen.getAllByTestId('recipes-row')[0]
    expect(row.textContent).toContain('Roll for Initiative')
    expect(row.textContent).toContain('Fridge · 7 days')
    expect(row.textContent).toContain('made 2 times')
  })

  it('filters by type (chips only for types in use), and All brings them back', async () => {
    renderView()
    await waitFor(() => expect(screen.getAllByTestId('recipes-filter-chip')).toHaveLength(2))
    fireEvent.click(screen.getAllByTestId('recipes-filter-chip').find(c => c.textContent === 'Pesto'))
    expect(screen.getAllByTestId('recipes-row').map(r => r.dataset.recipeId)).toEqual(['r2'])
    tap('recipes-filter-all')
    expect(screen.getAllByTestId('recipes-row')).toHaveLength(3)
  })

  it('an empty household says so plainly', async () => {
    wire({ 'GET /api/recipes': () => ({ recipes: [] }) })
    renderView()
    await waitFor(() => expect(screen.getByTestId('recipes-empty')).toBeTruthy())
  })
})

describe('recipe detail — notes verbatim, lines, link, and the batches made from it (never a reading)', () => {
  const open = async () => {
    renderView()
    await waitFor(() => expect(screen.getAllByTestId('recipes-row')).toHaveLength(3))
    fireEvent.click(screen.getAllByTestId('recipes-row')[0])
    await waitFor(() => expect(screen.getByTestId('recipe-detail-name').textContent).toBe('Roll for Initiative'))
  }

  it('renders the notes exactly as written, whitespace kept', async () => {
    await open()
    const notes = screen.getByTestId('recipe-detail-notes')
    expect(notes.textContent).toBe(NOTES)
    expect(notes.style.whiteSpace).toBe('pre-wrap')
  })

  it('lines as written (at-the-end apart), the link (new tab, no opener), keeps, the jar and the bottle', async () => {
    await open()
    expect(screen.getAllByTestId('recipe-detail-line').map(l => l.textContent)).toEqual(['170 g fresh jalapeño', 'cumin — pinch'])
    expect(screen.getAllByTestId('recipe-detail-line-end').map(l => l.textContent)).toEqual(['20 g onion'])
    const a = screen.getByTestId('recipe-detail-link')
    expect([a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel')]).toEqual(['https://example.com/mojo', '_blank', 'noopener noreferrer'])
    expect(screen.getByTestId('recipe-detail-facts').textContent).toBe('Hot sauce · Ferment · Fridge · 7 days')
    const c = screen.getByTestId('recipe-detail-containers').textContent
    expect(c).toContain('Made in: quart jar (1 qt)')
    expect(c).toContain('Put up in: 8 oz woozy · cooked after blending')
    expect(c).toContain('Makes: 228 g')
  })

  it('the batches made from it: dated, the ending in words, at equal weight — and no pH even if one arrives', async () => {
    wire({ 'GET /api/recipes/r1': () => ({ recipe: { ...DETAIL, batches: DETAIL.batches.map(b => ({ ...b, last_ph_reading: '3.10', last_ph_read_at: '2026-10-02T00:00:00Z' })) } }) })
    await open()
    const rows = screen.getAllByTestId('recipe-detail-batch').map(r => r.textContent)
    expect(rows[0]).toMatch(/^Mojo Oct · .+ · Put it up$/)
    expect(rows[1]).toMatch(/^Mojo again · .+ · still going$/)
    const section = screen.getByTestId('recipe-detail-batches').textContent
    expect(section).not.toMatch(/pH|3\.10/)
  })

  it('a javascript: link from the server is never rendered as a link', async () => {
    wire({ 'GET /api/recipes/r1': () => ({ recipe: { ...DETAIL, link_url: 'javascript:alert(1)' } }) })
    await open()
    expect(screen.queryByTestId('recipe-detail-link')).toBeNull()
  })

  it('Remove asks once, then soft-deletes and returns to the list', async () => {
    wire({ 'DELETE /api/recipes/r1': () => ({ ok: true }) })
    await open()
    tap('recipe-remove')
    await act(async () => { tap('recipe-remove-yes') })
    expect(calls('DELETE', '/api/recipes/r1')).toHaveLength(1)
    await waitFor(() => expect(screen.getByTestId('recipes-view')).toBeTruthy())
  })

  it('Make this: the Start sheet opens prefilled; Start it posts recipe_id and then sets the jar', async () => {
    const started = vi.fn()
    wire({ 'PUT /api/kitchen-batches/kb-new': () => ({ id: 'kb-new' }) })
    renderView({ onBatchStarted: started })
    await waitFor(() => expect(screen.getAllByTestId('recipes-row')).toHaveLength(3))
    fireEvent.click(screen.getAllByTestId('recipes-row')[0])
    await waitFor(() => expect(screen.getByTestId('recipe-make-this')).toBeTruthy())
    tap('recipe-make-this')
    expect(screen.getByTestId('start-label').value).toBe('Roll for Initiative')
    expect(screen.getByTestId('start-kind-ferment').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('following-recipe-locked').textContent).toContain('Roll for Initiative')
    await act(async () => { tap('start-submit') })
    await waitFor(() => expect(calls('POST', '/api/kitchen-batches')).toHaveLength(1))
    const b = bodyOf('POST', '/api/kitchen-batches')
    expect(b).toMatchObject({ label: 'Roll for Initiative', kind: 'ferment', recipe_id: 'r1' })
    expect(b.idempotency_key).toMatch(UUID)
    await waitFor(() => expect(calls('PUT', '/api/kitchen-batches/kb-new')).toHaveLength(1))
    expect(bodyOf('PUT', '/api/kitchen-batches/kb-new')).toEqual({ vessel_label: 'quart jar', vessel_size: '1', vessel_unit: 'qt', vessel_count: 1 })
    await waitFor(() => expect(started).toHaveBeenCalledWith(expect.objectContaining({ id: 'kb-new' })))
  })

  it('I made this: a batch from the recipe, every line as written, closed as eaten — keyed, and a retry repeats nothing', async () => {
    const started = vi.fn()
    let failClose = true
    wire({
      'PUT /api/kitchen-batches/kb-new': () => ({}),
      'POST /api/kitchen-batches/kb-new/inputs': () => ({ inputs: [] }),
      'POST /api/kitchen-batches/kb-new/close': () => { if (failClose) { failClose = false; throw new Error('offline') } return {} },
    })
    renderView({ onBatchStarted: started })
    await waitFor(() => expect(screen.getAllByTestId('recipes-row')).toHaveLength(3))
    fireEvent.click(screen.getAllByTestId('recipes-row')[0])
    await waitFor(() => expect(screen.getByTestId('recipe-i-made-this')).toBeTruthy())
    tap('recipe-i-made-this')
    await act(async () => { tap('recipe-made-confirm-save') })
    await waitFor(() => expect(screen.getByTestId('recipe-detail-error')).toBeTruthy())
    await act(async () => { tap('recipe-made-confirm-save') })
    await waitFor(() => expect(started).toHaveBeenCalled())
    expect(calls('POST', '/api/kitchen-batches')).toHaveLength(1)
    expect(bodyOf('POST', '/api/kitchen-batches')).toMatchObject({ recipe_id: 'r1', label: 'Roll for Initiative', start_precision: 'exact' })
    expect(calls('POST', '/api/kitchen-batches/kb-new/inputs')).toHaveLength(1)
    expect(bodyOf('POST', '/api/kitchen-batches/kb-new/inputs').inputs.map(l => l.label)).toEqual(['jalapeño', 'cumin', 'onion'])
    expect(calls('POST', '/api/kitchen-batches/kb-new/close')).toHaveLength(2)
    expect(bodyOf('POST', '/api/kitchen-batches/kb-new/close', 1)).toEqual({ outcome: 'consumed' })
  })
})

describe('the create sheet and its type picker', () => {
  it('a new recipe: name, a built-in type, notes verbatim, a line — one keyed POST', async () => {
    renderView()
    await waitFor(() => expect(screen.getAllByTestId('recipes-row')).toHaveLength(3))
    tap('recipes-new')
    type(screen.getByTestId('recipe-name'), 'Basil pesto II')
    fireEvent.click(screen.getAllByTestId('recipe-type-chip').find(c => c.textContent === 'Pesto'))
    type(screen.getByTestId('recipe-notes'), '  Blanch 10 s.\n  Oil last.')
    tap('recipe-line-add')
    type(screen.getByTestId('recipe-line-name'), 'basil')
    type(screen.getByTestId('recipe-line-amount'), '60 g basil leaves')
    await act(async () => { tap('recipe-save') })
    await waitFor(() => expect(calls('POST', '/api/recipes')).toHaveLength(1))
    const b = bodyOf('POST', '/api/recipes')
    expect(b).toMatchObject({ name: 'Basil pesto II', recipe_type_id: 't-pesto', notes: '  Blanch 10 s.\n  Oil last.',
      lines: [{ ordinal: 1, name: 'basil', amount_text: '60 g basil leaves' }] })
    expect(b.idempotency_key).toMatch(UUID)
  })

  it('a link that is not http/https is refused in the sheet, nothing is sent', async () => {
    renderView()
    await waitFor(() => expect(screen.getAllByTestId('recipes-row')).toHaveLength(3))
    tap('recipes-new')
    type(screen.getByTestId('recipe-name'), 'x')
    type(screen.getByTestId('recipe-link'), 'javascript:alert(1)')
    await act(async () => { tap('recipe-save') })
    expect(screen.getByTestId('recipe-sheet-error').textContent).toMatch(/http/)
    expect(calls('POST', '/api/recipes')).toHaveLength(0)
  })

  it('"New type…" find-or-creates a type and picks it', async () => {
    renderView()
    await waitFor(() => expect(screen.getAllByTestId('recipes-row')).toHaveLength(3))
    tap('recipes-new')
    tap('recipe-type-new')
    type(screen.getByTestId('recipe-type-new-input'), 'Shrub')
    await act(async () => { tap('recipe-type-new-save') })
    await waitFor(() => expect(calls('POST', '/api/recipes/types')).toHaveLength(1))
    expect(bodyOf('POST', '/api/recipes/types')).toEqual({ label: 'Shrub' })
    const chip = await waitFor(() => screen.getAllByTestId('recipe-type-chip').find(c => c.textContent === 'Shrub'))
    expect(chip.getAttribute('aria-pressed')).toBe('true')
  })
})

describe('Following a recipe? on the Start sheet', () => {
  it('collapsed it reads "Following a recipe? · tested recipes →"; open: pick one → recipe_id, type one → recipe_ref, the caution in full', async () => {
    render(<StartBatchSheet open onClose={() => {}} onStarted={() => {}} now={NOW} />)
    expect(screen.getByTestId('following-recipe').textContent).toContain('Following a recipe?')
    expect(screen.getByTestId('following-recipe-tested-link').textContent).toContain('tested recipes →')
    tap('following-recipe-toggle')
    await waitFor(() => expect(screen.getByTestId('following-recipe-select').disabled).toBe(false))
    expect(screen.getByTestId('following-recipe-note').textContent).toContain(TESTED_RECIPE_NOTE)
    type(screen.getByTestId('start-label'), 'Mash')
    fireEvent.change(screen.getByTestId('following-recipe-select'), { target: { value: 'r2' } })
    type(screen.getByTestId('following-recipe-ref'), 'the card in the drawer')
    await act(async () => { tap('start-submit') })
    await waitFor(() => expect(calls('POST', '/api/kitchen-batches')).toHaveLength(1))
    expect(bodyOf('POST', '/api/kitchen-batches')).toMatchObject({ label: 'Mash', recipe_id: 'r2', recipe_ref: 'the card in the drawer' })
    expect(calls('PUT', '/api/kitchen-batches/kb-new')).toHaveLength(0)
  })

  it('left alone, the create body carries neither', async () => {
    render(<StartBatchSheet open onClose={() => {}} onStarted={() => {}} now={NOW} />)
    type(screen.getByTestId('start-label'), 'Mash')
    await act(async () => { tap('start-submit') })
    await waitFor(() => expect(calls('POST', '/api/kitchen-batches')).toHaveLength(1))
    const b = bodyOf('POST', '/api/kitchen-batches')
    expect(b).not.toHaveProperty('recipe_id')
    expect(b).not.toHaveProperty('recipe_ref')
    expect(calls('GET', '/api/recipes')).toHaveLength(0)
  })
})

describe('batch detail — Save as recipe and Made it as written', () => {
  const BATCH = { id: 'kb1', label: 'Settlers of Cayenne', recipe_id: null }

  it('Save as recipe: the name prefilled with the batch label; one keyed POST to from-batch', async () => {
    const changed = vi.fn()
    wire({ 'POST /api/recipes/from-batch/kb1': (b) => ({ recipe: { id: 'r9', name: b.name }, batch_linked: true }) })
    render(<BatchRecipeRow batch={BATCH} inputs={[]} onChanged={changed} />)
    tap('batch-save-as-recipe')
    expect(screen.getByTestId('batch-save-as-recipe-name').value).toBe('Settlers of Cayenne')
    await act(async () => { tap('batch-save-as-recipe-save') })
    await waitFor(() => expect(calls('POST', '/api/recipes/from-batch/kb1')).toHaveLength(1))
    const b = bodyOf('POST', '/api/recipes/from-batch/kb1')
    expect(b.name).toBe('Settlers of Cayenne')
    expect(b.idempotency_key).toMatch(UUID)
    await waitFor(() => expect(screen.getByTestId('batch-save-as-recipe-saved').textContent).toBe('Saved as a recipe: Settlers of Cayenne'))
    expect(changed).toHaveBeenCalled()
  })

  it('a batch from a recipe: "From the recipe", its lines as reference, and Made it as written while it has no lines', async () => {
    const changed = vi.fn()
    wire({ 'POST /api/kitchen-batches/kb1/inputs': () => ({ inputs: [] }) })
    const batch = { ...BATCH, recipe_id: 'r1', recipe: { id: 'r1', name: 'Roll for Initiative', lines: DETAIL.lines } }
    const { rerender } = render(<BatchRecipeRow batch={batch} inputs={[]} onChanged={changed} />)
    expect(screen.getByTestId('batch-recipe-from').textContent).toContain('From the recipe: Roll for Initiative')
    tap('batch-recipe-lines-toggle')
    expect(screen.getAllByTestId('batch-recipe-line').map(l => l.textContent)).toEqual(['170 g fresh jalapeño', 'cumin — pinch'])
    await act(async () => { tap('batch-recipe-as-written') })
    await waitFor(() => expect(calls('POST', '/api/kitchen-batches/kb1/inputs')).toHaveLength(1))
    const lines = bodyOf('POST', '/api/kitchen-batches/kb1/inputs').inputs
    expect(lines.map(l => [l.label, l.qty ?? null, l.note ?? null])).toEqual([['jalapeño', '170', null], ['cumin', null, 'pinch']])
    expect(changed).toHaveBeenCalled()
    // Once the batch has its own pot lines, the door is gone.
    rerender(<BatchRecipeRow batch={batch} inputs={[{ id: 'x', label: 'jalapeño', put_up_stage_id: null }]} onChanged={changed} />)
    expect(screen.queryByTestId('batch-recipe-as-written')).toBeNull()
  })

  it('the batch surface never renders the recipe\'s notes (his target pH lives there)', () => {
    const batch = { ...BATCH, recipe_id: 'r1', recipe: { id: 'r1', name: 'R', notes: 'Target pH as he wrote it', lines: [] } }
    render(<BatchRecipeRow batch={batch} inputs={[]} onChanged={() => {}} />)
    expect(screen.getByTestId('batch-recipe').textContent).not.toMatch(/Target|pH/)
  })
})

describe('words — no banned word on the recipe surfaces (V4 §3.2), his notes aside', () => {
  const BANNED = /\b(safe|shelf life|shelf-stable|keeps|good|ready|done|expired|table|default|basis)\b/i
  const textWithoutNotes = (root) => {
    const clone = root.cloneNode(true)
    clone.querySelectorAll('[data-testid="recipe-detail-notes"]').forEach(n => n.remove())
    return clone.textContent
  }

  it('INSTRUMENT: the pattern catches a banned word', () => {
    expect('How long it keeps').toMatch(BANNED)
  })

  it('the list, the detail, the sheet, Following a recipe? and the batch row', async () => {
    renderView()
    await waitFor(() => expect(screen.getAllByTestId('recipes-row')).toHaveLength(3))
    expect(screen.getByTestId('recipes-view').textContent).not.toMatch(BANNED)
    tap('recipes-new')
    tap('recipe-line-add')
    expect(screen.getByTestId('recipe-sheet').textContent).not.toMatch(BANNED)
    cleanup()
    renderView()
    await waitFor(() => expect(screen.getAllByTestId('recipes-row')).toHaveLength(3))
    fireEvent.click(screen.getAllByTestId('recipes-row')[0])
    await waitFor(() => expect(screen.getByTestId('recipe-detail-name')).toBeTruthy())
    tap('recipe-i-made-this')
    tap('recipe-remove')
    expect(textWithoutNotes(screen.getByTestId('recipe-detail'))).not.toMatch(BANNED)
    cleanup()
    render(<StartBatchSheet open onClose={() => {}} onStarted={() => {}} now={NOW} />)
    tap('following-recipe-toggle')
    expect(screen.getByTestId('following-recipe').textContent).not.toMatch(BANNED)
    cleanup()
    render(<BatchRecipeRow batch={{ id: 'kb1', label: 'x', recipe: { id: 'r1', name: 'R', lines: DETAIL.lines } }} inputs={[]} onChanged={() => {}} />)
    tap('batch-recipe-lines-toggle')
    tap('batch-save-as-recipe')
    expect(screen.getByTestId('batch-recipe').textContent).not.toMatch(BANNED)
  })
})
