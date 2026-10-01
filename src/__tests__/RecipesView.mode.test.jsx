// Put-Up UX pass R1, lane D — RECIPE MODE (plan section 3, "Props" and "Origins"): the page may own which recipe is
// open. RecipesView takes `openId` and `onOpen(id | null)` and is CONTROLLED IF AND ONLY IF onOpen is a function.
//
// WHAT THIS FILE HOLDS:
//   • uncontrolled (no onOpen): open, Back, Remove and the batch hand-over exactly as before — one argument;
//   • controlled: a row, a saved new recipe, and Remove all call onOpen and change nothing by themselves; the
//     detail has no Back of its own; the list is re-read when openId goes from set to null;
//   • the saved-recipe open is made from inside an armed sheet, so it LANDS first (kitchen/sheetLanding.js);
//   • every batch opened from a controlled detail carries its origin, { label, kind: 'recipe', id }, in the
//     shape putup/origin.js reads back;
//   • a ten-line host that holds openId in state: open, Back, save-then-open.
// The page that will pass these props (PutUp.jsx) is lane A's and is not on this branch: the host below is this
// lane's own. The Start sheet is lane A's too and is a stand-in here (see RecipesView.detail.test.jsx).
// MUTATIONS (each run, each red here):
//   the switch keyed on `openId != null` instead of on onOpen     -> "controlled with openId: null: tapping a row…"
//   the saved-recipe open made straight from the armed sheet      -> "…only after the sheet has closed AND its Back entry is consumed"
//   the re-read on set -> null removed                            -> "the list is re-read when openId goes from set to null"
//   an origin dropped from a sender                               -> "every batch opened from the detail carries where it came from"
//   the origin handed to an uncontrolled host                     -> "uncontrolled: the page is handed the batch and nothing else"
// CI lane: `npm test` plus the TZ re-run. No jest-dom (L-182).
import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
const auth = { user: { id: 'user_dave' } }
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => auth, useAuth: () => auth }))
vi.mock('../components/kitchen/StartBatchSheet.jsx', () => ({
  default: ({ open, recipe, onClose, onStarted }) => (open ? (
    <div data-testid="start-standin" data-recipe-id={recipe?.id ?? ''}>
      <button type="button" data-testid="start-standin-start" onClick={() => onStarted?.({ id: 'kb-new', label: recipe?.name })}>start</button>
      <button type="button" data-testid="start-standin-close" onClick={() => onClose?.()}>close</button>
    </div>
  ) : null),
}))

import RecipesView from '../components/recipes/RecipesView.jsx'
import { clearReloadBlocks } from '../lib/reloadGate.js'
import { DismissRegistryProvider } from '../context/DismissRegistry.jsx'
import { readMarker } from '../lib/backNav.js'
import { readFrom, withFrom, backLabel } from '../components/putup/origin.js'

const NOW = new Date(2026, 9, 9, 12, 0, 0).getTime()
const TYPES = [{ id: 't-hot', label: 'Hot sauce', builtin: true, sort_order: 10, user_id: null }]
const LIST = [
  { id: 'r1', name: 'Petri Dish', recipe_type_id: 't-hot', type_label: 'Hot sauce', type_sort: 10, batch_count: 1 },
  { id: 'r2', name: 'Settlers Ghost', recipe_type_id: 't-hot', type_label: 'Hot sauce', type_sort: 10, batch_count: 0 },
]
const detailOf = (id, name) => ({
  id, user_id: 'user_dave', name, kind: 'ferment', recipe_type_id: 't-hot', type_label: 'Hot sauce', notes: null,
  lines: [{ id: `${id}-l1`, ordinal: 1, name: 'cayenne', amount_text: '500 g cayenne', qty: '500', qty_unit: 'g', at_the_end: false }],
  batches: [{ id: 'b1', label: 'Petri Oct', started_at: '2026-10-02T16:00:00Z', closed_at: '2026-10-03T16:00:00Z', outcome: 'put_up', output_count: '6' }],
})
const ORIGIN = { label: 'Petri Dish', kind: 'recipe', id: 'r1' }

function wire(extra = {}) {
  const routes = {
    'GET /api/recipes': () => ({ recipes: LIST }),
    'GET /api/recipes/types': () => ({ types: TYPES }),
    'GET /api/recipes/r1': () => ({ recipe: detailOf('r1', 'Petri Dish') }),
    'GET /api/recipes/r2': () => ({ recipe: detailOf('r2', 'Settlers Ghost') }),
    'GET /api/recipes/r-new': () => ({ recipe: { ...detailOf('r-new', 'Garden marinara'), batches: [] } }),
    'POST /api/recipes': (b) => ({ recipe: { id: 'r-new', name: b.name, lines: [] } }),
    'PATCH /api/recipes/r1': (b) => ({ recipe: { ...detailOf('r1', b.name) } }),
    'DELETE /api/recipes/r1': () => ({ ok: true }),
    'POST /api/kitchen-batches': (b) => ({ id: 'kb-made', label: b.label }),
    'POST /api/kitchen-batches/kb-made/inputs': () => ({ inputs: [] }),
    'POST /api/kitchen-batches/kb-made/close': () => ({}),
    ...extra,
  }
  fetchSpy.mockImplementation((path, o = {}) => {
    const hit = routes[`${(o.method ?? 'GET').toUpperCase()} ${path}`]
    if (!hit) return Promise.resolve(null)
    try { return Promise.resolve(hit(o.body ? JSON.parse(o.body) : null)) } catch (e) { return Promise.reject(e) }
  })
}
const calls = (method, path) => fetchSpy.mock.calls.filter(([p, o]) => p === path && (o?.method ?? 'GET').toUpperCase() === method)
const tap = (id) => fireEvent.click(screen.getByTestId(id))
const row = (id) => screen.getAllByTestId('recipes-row').find(r => r.dataset.recipeId === id)
const listReady = () => waitFor(() => expect(screen.getAllByTestId('recipes-row')).toHaveLength(2))
const detailReady = (name) => waitFor(() => expect(screen.getByTestId('recipe-detail-name').textContent).toBe(name))
const armed = () => !!readMarker(window.history.state)
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 60)) })

beforeEach(() => { fetchSpy.mockReset(); wire(); localStorage.clear(); clearReloadBlocks(); window.history.replaceState({ __floor: 1 }, '') })
afterEach(() => { cleanup(); clearReloadBlocks() })

const view = (props = {}) => render(<MemoryRouter><RecipesView now={NOW} {...props} /></MemoryRouter>)

describe('uncontrolled (no onOpen) — everything as it was', () => {
  it('a row opens the detail by itself; its own "← Recipes" returns to the list and re-reads it', async () => {
    view()
    await listReady()
    expect(calls('GET', '/api/recipes')).toHaveLength(1)
    fireEvent.click(row('r1'))
    await detailReady('Petri Dish')
    expect(screen.getByTestId('recipe-back').textContent).toBe('← Recipes')
    tap('recipe-back')
    await listReady()
    expect(screen.queryByTestId('recipe-detail')).toBeNull()
    expect(calls('GET', '/api/recipes')).toHaveLength(2)
  })

  it('an openId handed in WITHOUT onOpen opens nothing: the prop alone does not switch the mode', async () => {
    view({ openId: 'r1' })
    await listReady()
    expect(screen.queryByTestId('recipe-detail')).toBeNull()
    expect(calls('GET', '/api/recipes/r1')).toHaveLength(0)
    // …and onOpen that is not a function is not a switch either.
    cleanup()
    view({ openId: 'r1', onOpen: 'yes' })
    await listReady()
    expect(screen.queryByTestId('recipe-detail')).toBeNull()
  })

  it('a saved new recipe opens by itself, as before', async () => {
    view()
    await listReady()
    tap('recipes-new')
    fireEvent.change(screen.getByTestId('recipe-name'), { target: { value: 'Garden marinara' } })
    await act(async () => { tap('recipe-save') })
    await detailReady('Garden marinara')
    expect(screen.queryByTestId('recipe-sheet')).toBeNull()
  })

  it('uncontrolled: the page is handed the batch and nothing else — from all four doors', async () => {
    const started = vi.fn()
    view({ onBatchStarted: started })
    await listReady()
    fireEvent.click(row('r1'))
    await detailReady('Petri Dish')
    tap('recipe-make-this'); tap('start-standin-start')
    tap('recipe-i-made-this'); tap('recipe-made-kept-some'); tap('start-standin-start')
    tap('recipe-detail-batch-open')
    tap('recipe-i-made-this')
    await act(async () => { tap('recipe-made-confirm-save') })
    await waitFor(() => expect(started).toHaveBeenCalledTimes(4))
    expect(started.mock.calls.map(c => c.length)).toEqual([1, 1, 1, 1])
    expect(started.mock.calls.map(c => c[0].id)).toEqual(['kb-new', 'kb-new', 'b1', 'kb-made'])
  })
})

describe('controlled (onOpen is a function) — the page owns which recipe is open', () => {
  it('controlled with openId: null: tapping a row calls onOpen(id) and renders no detail by itself', async () => {
    const onOpen = vi.fn()
    view({ openId: null, onOpen })
    await listReady()
    fireEvent.click(row('r2'))
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledWith('r2')
    // The page has not answered, so nothing moved: still the list, and no detail was asked for.
    await settle()
    expect(screen.getByTestId('recipes-view')).toBeTruthy()
    expect(screen.queryByTestId('recipe-detail')).toBeNull()
    expect(calls('GET', '/api/recipes/r2')).toHaveLength(0)
  })

  it('with openId omitted it is still controlled: onOpen alone decides', async () => {
    const onOpen = vi.fn()
    view({ onOpen })
    await listReady()
    fireEvent.click(row('r1'))
    expect(onOpen).toHaveBeenCalledWith('r1')
    expect(screen.queryByTestId('recipe-detail')).toBeNull()
  })

  it('openId names the recipe on screen, and the detail has no Back of its own — loading and failed included', async () => {
    const onOpen = vi.fn()
    let answer
    wire({ 'GET /api/recipes/r1': () => new Promise((resolve, reject) => { answer = { resolve, reject } }) })
    const { rerender } = view({ openId: 'r1', onOpen })
    await waitFor(() => expect(screen.getByTestId('recipe-detail').textContent).toBe('Opening that recipe…'))
    expect(screen.queryByTestId('recipe-back')).toBeNull()
    await act(async () => { answer.resolve({ recipe: detailOf('r1', 'Petri Dish') }) })
    await detailReady('Petri Dish')
    expect(screen.queryByTestId('recipe-back')).toBeNull()
    expect(screen.getByTestId('recipe-detail').textContent).not.toContain('← Recipes')
    // Another recipe named by the page replaces it; one that cannot be read says so, still with no Back here.
    wire({ 'GET /api/recipes/r2': () => Promise.reject(new Error('down')) })
    rerender(<MemoryRouter><RecipesView now={NOW} openId="r2" onOpen={onOpen} /></MemoryRouter>)
    await waitFor(() => expect(screen.getByTestId('recipe-detail').textContent).toBe('Couldn’t open that recipe.'))
    expect(screen.queryByTestId('recipe-back')).toBeNull()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('the list is re-read when openId goes from set to null — and only then', async () => {
    const onOpen = vi.fn()
    const at = (openId) => <MemoryRouter><RecipesView now={NOW} openId={openId} onOpen={onOpen} /></MemoryRouter>
    const { rerender } = render(at(null))
    await listReady()
    expect(calls('GET', '/api/recipes')).toHaveLength(1)
    rerender(at(null))
    rerender(at('r1'))
    await detailReady('Petri Dish')
    expect(calls('GET', '/api/recipes')).toHaveLength(1)
    rerender(at('r2'))
    await detailReady('Settlers Ghost')
    expect(calls('GET', '/api/recipes')).toHaveLength(1)
    // The page's Back: no callback of this view runs, only the prop changes.
    rerender(at(null))
    await listReady()
    expect(calls('GET', '/api/recipes')).toHaveLength(2)
    rerender(at(null))
    await settle()
    expect(calls('GET', '/api/recipes')).toHaveLength(2)
  })

  it('Remove calls onOpen(null): leaving a removed recipe and the page\'s Back are the same act', async () => {
    const onOpen = vi.fn()
    view({ openId: 'r1', onOpen })
    await detailReady('Petri Dish')
    tap('recipe-remove')
    await act(async () => { tap('recipe-remove-yes') })
    expect(calls('DELETE', '/api/recipes/r1')).toHaveLength(1)
    expect(onOpen.mock.calls).toEqual([[null]])
    // The page has not answered yet: the view did not close the recipe by itself.
    expect(screen.queryByTestId('recipes-view')).toBeNull()
  })

  it('an edit saves in place: the sheet closes, the detail is read again, and onOpen is not called', async () => {
    const onOpen = vi.fn()
    view({ openId: 'r1', onOpen })
    await detailReady('Petri Dish')
    tap('recipe-edit')
    fireEvent.change(screen.getByTestId('recipe-name'), { target: { value: 'Petri Dish II' } })
    const readsBefore = calls('GET', '/api/recipes/r1').length
    await act(async () => { tap('recipe-save') })
    await waitFor(() => expect(screen.queryByTestId('recipe-sheet')).toBeNull())
    expect(calls('PATCH', '/api/recipes/r1')).toHaveLength(1)
    expect(calls('GET', '/api/recipes/r1')).toHaveLength(readsBefore + 1)
    await detailReady('Petri Dish')
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('a saved new recipe: onOpen(its id), once, with the sheet closed — and no detail until the page answers', async () => {
    const onOpen = vi.fn()
    view({ openId: null, onOpen })
    await listReady()
    tap('recipes-new')
    fireEvent.change(screen.getByTestId('recipe-name'), { target: { value: 'Garden marinara' } })
    await act(async () => { tap('recipe-save') })
    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1))
    expect(onOpen).toHaveBeenCalledWith('r-new')
    expect(screen.queryByTestId('recipe-sheet')).toBeNull()
    expect(screen.queryByTestId('recipe-detail')).toBeNull()
    expect(calls('GET', '/api/recipes')).toHaveLength(2)          // the list holds the new recipe when Back returns to it
  })

  // THE LANDING, under the real <Sheet armsBack> and the real registry on jsdom's own history: the page's
  // push must not be made while the sheet's Back entry is still the current one.
  it('a saved new recipe is opened only after the sheet has closed AND its Back entry is consumed', async () => {
    const seen = []
    const onOpen = vi.fn(() => seen.push({ sheetOpen: !!screen.queryByTestId('recipe-sheet'), markerCurrent: armed() }))
    await act(async () => {
      render(<MemoryRouter><DismissRegistryProvider><RecipesView now={NOW} openId={null} onOpen={onOpen} /></DismissRegistryProvider></MemoryRouter>)
    })
    await listReady()
    expect(armed()).toBe(false)
    await act(async () => { tap('recipes-new') })
    await waitFor(() => expect(armed()).toBe(true))               // INSTRUMENT: the sheet really armed a Back entry
    fireEvent.change(screen.getByTestId('recipe-name'), { target: { value: 'Garden marinara' } })
    await act(async () => { tap('recipe-save') })
    await settle()
    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1))
    expect(onOpen).toHaveBeenCalledWith('r-new')
    expect(seen).toEqual([{ sheetOpen: false, markerCurrent: false }])
  })

  it('the landing calls the page\'s LATEST onOpen, not the one in hand when Save was tapped', async () => {
    const first = vi.fn()
    const latest = vi.fn()
    const tree = (onOpen) => <MemoryRouter><DismissRegistryProvider><RecipesView now={NOW} openId={null} onOpen={onOpen} /></DismissRegistryProvider></MemoryRouter>
    let rerender
    await act(async () => { ({ rerender } = render(tree(first))) })
    await listReady()
    await act(async () => { tap('recipes-new') })
    await waitFor(() => expect(armed()).toBe(true))
    fireEvent.change(screen.getByTestId('recipe-name'), { target: { value: 'Garden marinara' } })
    // The save is held open so the page can re-render (as it does when the entry under the sheet comes back).
    let answer
    wire({ 'POST /api/recipes': () => new Promise((resolve) => { answer = resolve }) })
    await act(async () => { tap('recipe-save') })
    await act(async () => { rerender(tree(latest)) })
    await act(async () => { answer({ recipe: { id: 'r-new', name: 'Garden marinara', lines: [] } }) })
    await settle()
    await waitFor(() => expect(latest).toHaveBeenCalledTimes(1))
    expect(latest).toHaveBeenCalledWith('r-new')
    expect(first).not.toHaveBeenCalled()
  })
})

describe('origins — every batch opened from a controlled detail says where it came from', () => {
  it('every batch opened from the detail carries where it came from: Make this, Kept some?, a Made-from-this row, Log this make', async () => {
    const started = vi.fn()
    view({ openId: 'r1', onOpen: vi.fn(), onBatchStarted: started })
    await detailReady('Petri Dish')
    tap('recipe-make-this'); tap('start-standin-start')
    expect(started.mock.calls[0]).toEqual([{ id: 'kb-new', label: 'Petri Dish' }, ORIGIN])
    tap('recipe-i-made-this'); tap('recipe-made-kept-some'); tap('start-standin-start')
    expect(started.mock.calls[1]).toEqual([{ id: 'kb-new', label: 'Petri Dish' }, ORIGIN])
    tap('recipe-detail-batch-open')
    expect(started.mock.calls[2][0]).toMatchObject({ id: 'b1', label: 'Petri Oct' })
    expect(started.mock.calls[2][1]).toEqual(ORIGIN)
    tap('recipe-i-made-this')
    await act(async () => { tap('recipe-made-confirm-save') })
    await waitFor(() => expect(started).toHaveBeenCalledTimes(4))
    expect(started.mock.calls[3]).toEqual([{ id: 'kb-made', label: 'Petri Dish' }, ORIGIN])
    expect(started.mock.calls.map(c => c.length)).toEqual([2, 2, 2, 2])
  })

  it('the origin is one the page can read back: putup/origin.js takes it whole, and its Back reads "Petri Dish (recipe)"', async () => {
    const started = vi.fn()
    view({ openId: 'r1', onOpen: vi.fn(), onBatchStarted: started })
    await detailReady('Petri Dish')
    tap('recipe-detail-batch-open')
    const origin = started.mock.calls[0][1]
    expect(readFrom({ from: origin })).toEqual(origin)
    const state = withFrom({ background: { pathname: '/today' } }, origin)
    expect(state).toEqual({ background: { pathname: '/today' }, from: ORIGIN })
    expect(backLabel(state, 'Recipes')).toBe('Petri Dish (recipe)')
  })

  it('the recipe named is the one on screen, by its own name and id', async () => {
    const started = vi.fn()
    view({ openId: 'r2', onOpen: vi.fn(), onBatchStarted: started })
    await detailReady('Settlers Ghost')
    tap('recipe-make-this'); tap('start-standin-start')
    expect(started.mock.calls[0][1]).toEqual({ label: 'Settlers Ghost', kind: 'recipe', id: 'r2' })
  })
})

// The page is lane A's. This is what it will do with the two props, in ten lines: hold openId in state, and
// offer the one Back. It proves the three moves the contract names.
describe('a host that holds openId in state: open, Back, save-then-open', () => {
  function Host({ onBatchStarted }) {
    const [openId, setOpenId] = useState(null)
    return (
      <MemoryRouter>
        {openId && <button type="button" data-testid="host-back" onClick={() => setOpenId(null)}>← Recipes</button>}
        <span data-testid="host-open-id">{openId ?? 'none'}</span>
        <RecipesView now={NOW} openId={openId} onOpen={setOpenId} onBatchStarted={onBatchStarted} />
      </MemoryRouter>
    )
  }

  it('open: a row puts its id in the host, and the detail follows', async () => {
    render(<Host />)
    await listReady()
    fireEvent.click(row('r1'))
    await detailReady('Petri Dish')
    expect(screen.getByTestId('host-open-id').textContent).toBe('r1')
    expect(screen.getAllByText('← Recipes')).toHaveLength(1)        // ONE Back, and it is the host's
  })

  it('Back: the host clears its id; the list is back, re-read, with nothing left open', async () => {
    render(<Host />)
    await listReady()
    fireEvent.click(row('r1'))
    await detailReady('Petri Dish')
    tap('host-back')
    await listReady()
    expect(screen.getByTestId('host-open-id').textContent).toBe('none')
    expect(screen.queryByTestId('recipe-detail')).toBeNull()
    expect(calls('GET', '/api/recipes')).toHaveLength(2)
    // …and the next open is the next recipe, not the last one.
    fireEvent.click(row('r2'))
    await detailReady('Settlers Ghost')
  })

  it('save-then-open: a new recipe saved from the list lands on its own detail', async () => {
    render(<Host />)
    await listReady()
    tap('recipes-new')
    fireEvent.change(screen.getByTestId('recipe-name'), { target: { value: 'Garden marinara' } })
    await act(async () => { tap('recipe-save') })
    await detailReady('Garden marinara')
    expect(screen.getByTestId('host-open-id').textContent).toBe('r-new')
    expect(screen.queryByTestId('recipe-sheet')).toBeNull()
    tap('host-back')
    await listReady()
  })

  it('Remove: the host is told to leave, and does', async () => {
    render(<Host />)
    await listReady()
    fireEvent.click(row('r1'))
    await detailReady('Petri Dish')
    tap('recipe-remove')
    await act(async () => { tap('recipe-remove-yes') })
    await listReady()
    expect(screen.getByTestId('host-open-id').textContent).toBe('none')
  })
})
