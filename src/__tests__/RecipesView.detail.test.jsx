// Put-Up UX pass R1, lane D — recipe detail as it reads now (src/components/recipes/RecipesView.jsx):
//   D8  the notes show paired marks as bold / italic, built as elements; the sheet and the wire stay verbatim;
//   D9  "Made it, ate it all": its words, ONE filled button in every state, "Kept some?" is Make this, Edit quiet;
//   D3  "Made from this" endings with their counts;
//   F16 48 px chips, quiet actions and rows.
// The Start sheet is lane A's and is being rewritten beside this lane, so it is a stand-in here: these tests
// hold what RecipesView hands it and what it does with the answer, not the sheet's own fields (Recipes.test.jsx
// keeps the real sheet under Make this).
// MUTATIONS (each run, each red here):
//   M10a  the marks helper applied to the save body                 -> "an edit sends the notes back verbatim"
//         the marks helper applied to the textarea's value           -> "the edit sheet holds the notes verbatim"
//   Make this stays filled while the confirm is open                 -> "ONE filled button"
//   the notes set as markup instead of built as elements             -> "markup in the notes is text"
// CI lane: `npm test` plus the TZ re-run. No jest-dom (L-182).
import React from 'react'
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
    <div data-testid="start-standin" data-recipe-id={recipe?.id ?? ''} data-recipe-name={recipe?.name ?? ''}>
      <button type="button" data-testid="start-standin-start" onClick={() => onStarted?.({ id: 'kb-new', label: recipe?.name })}>start</button>
      <button type="button" data-testid="start-standin-close" onClick={() => onClose?.()}>close</button>
    </div>
  ) : null),
}))

import RecipesView from '../components/recipes/RecipesView.jsx'
import { clearReloadBlocks } from '../lib/reloadGate.js'
import { buttonChrome } from '../components/forms/formStyles.js'

const NOW = new Date(2026, 9, 9, 12, 0, 0).getTime()
const TYPES = [
  { id: 't-hot', label: 'Hot sauce', builtin: true, sort_order: 10, user_id: null },
  { id: 't-pesto', label: 'Pesto', builtin: true, sort_order: 70, user_id: null },
]
const LIST = [
  { id: 'r1', name: 'Petri Dish', recipe_type_id: 't-hot', type_label: 'Hot sauce', type_sort: 10, keeps_n: 6, keeps_unit: 'month', keeps_storage_kind: 'fridge', batch_count: 7 },
  { id: 'r2', name: 'Basil pesto', recipe_type_id: 't-pesto', type_label: 'Pesto', type_sort: 70, batch_count: 0 },
]
// Bold, italic, arithmetic, a bullet, a pair split by a line break, and markup that must stay text.
const NOTES = 'Petri\n\n**Steps**\nMash at *2.5% salt*; 2 * 3 cups to 1.\n* strain\n**split\nacross**\n<img src=x onerror="alert(1)"> **<b>hot</b>**'
const SHOWN = 'Petri\n\nSteps\nMash at 2.5% salt; 2 * 3 cups to 1.\n* strain\n**split\nacross**\n<img src=x onerror="alert(1)"> <b>hot</b>'
const at = (day) => `2026-${day}T16:00:00Z`
const DETAIL = {
  id: 'r1', user_id: 'user_jen', name: 'Petri Dish', kind: 'ferment', recipe_type_id: 't-hot', type_label: 'Hot sauce',
  link_url: 'https://example.com/petri', notes: NOTES, keeps_n: 6, keeps_unit: 'month', keeps_storage_kind: 'fridge',
  lines: [{ id: 'l1', ordinal: 1, name: 'cayenne', amount_text: '500 g cayenne', qty: '500', qty_unit: 'g', at_the_end: false }],
  batches: [
    { id: 'b1', label: 'Mojo Oct', started_at: at('10-02'), closed_at: at('10-03'), outcome: 'put_up', output_count: '6' },
    { id: 'b2', label: 'Mojo plain', started_at: at('09-20'), closed_at: at('09-28'), outcome: 'put_up', output_count: '0' },
    { id: 'b3', label: 'Mojo gift', started_at: at('09-10'), closed_at: at('09-12'), outcome: 'given_away', output_count: '1' },
    { id: 'b4', label: 'Mojo odd', started_at: at('08-20'), closed_at: at('08-28'), outcome: 'put_up_different', output_count: '12' },
    { id: 'b5', label: 'Mojo eaten', started_at: at('08-10'), closed_at: at('08-10'), outcome: 'consumed', output_count: '0' },
    { id: 'b6', label: 'Mojo again', started_at: at('10-08'), closed_at: null, outcome: null, output_count: '0' },
    { id: 'b7', label: 'Mojo resting', started_at: at('10-05'), closed_at: null, outcome: null, suspended_at: at('10-06'), output_count: '2' },
  ],
}

function wire(extra = {}) {
  const routes = {
    'GET /api/recipes': () => ({ recipes: LIST }),
    'GET /api/recipes/types': () => ({ types: TYPES }),
    'GET /api/recipes/r1': () => ({ recipe: DETAIL }),
    'PATCH /api/recipes/r1': (b) => ({ recipe: { ...DETAIL, ...b } }),
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

// A filled button is one painted with the primary fill (forms/Button.jsx's buttonChrome) that is not a chosen
// chip. The colour is normalised through an element, the way the browser hands it back.
const colour = (c) => { const s = document.createElement('span'); s.style.color = c; return s.style.color }
const FILL = colour(buttonChrome('primary', false).backgroundColor)
const filled = (root) => [...root.querySelectorAll('button, a[href]')]
  .filter(el => !el.hasAttribute('aria-pressed') && !el.hasAttribute('aria-checked') && colour(el.style.backgroundColor) === FILL)
  .map(el => el.getAttribute('data-testid'))

beforeEach(() => { fetchSpy.mockReset(); wire(); localStorage.clear(); clearReloadBlocks(); window.history.replaceState({ __floor: 1 }, '') })
afterEach(() => { cleanup(); clearReloadBlocks() })

const open = async (props = {}) => {
  const view = render(<MemoryRouter><RecipesView now={NOW} {...props} /></MemoryRouter>)
  await waitFor(() => expect(screen.getAllByTestId('recipes-row')).toHaveLength(2))
  fireEvent.click(screen.getAllByTestId('recipes-row').find(r => r.dataset.recipeId === 'r1'))
  await waitFor(() => expect(screen.getByTestId('recipe-detail-name').textContent).toBe('Petri Dish'))
  return view
}

describe('recipe notes (D8) — paired marks are shown, never typed back', () => {
  it('bold and italic runs are elements; arithmetic, a bullet and a pair split by a line break print as typed', async () => {
    await open()
    const notes = screen.getByTestId('recipe-detail-notes')
    expect(notes.textContent).toBe(SHOWN)
    expect([...notes.querySelectorAll('strong')].map(e => e.textContent)).toEqual(['Steps', '<b>hot</b>'])
    expect([...notes.querySelectorAll('em')].map(e => e.textContent)).toEqual(['2.5% salt'])
    expect(notes.style.whiteSpace).toBe('pre-wrap')
  })

  it('markup in the notes is text: nothing he typed becomes an element', async () => {
    await open()
    const notes = screen.getByTestId('recipe-detail-notes')
    expect([...new Set([...notes.querySelectorAll('*')].map(e => e.tagName))].sort()).toEqual(['EM', 'STRONG'])
    expect(notes.querySelector('img')).toBeNull()
    expect(notes.querySelector('b')).toBeNull()
    expect(notes.innerHTML).toContain('&lt;img src=x onerror="alert(1)"&gt;')
  })

  it('the edit sheet holds the notes verbatim, marks and all', async () => {
    await open()
    tap('recipe-edit')
    expect(screen.getByTestId('recipe-notes').value).toBe(NOTES)
  })

  it('an edit sends the notes back verbatim: no mark is added, dropped or moved on the wire', async () => {
    await open()
    tap('recipe-edit')
    fireEvent.change(screen.getByTestId('recipe-name'), { target: { value: 'Petri Dish II' } })
    await act(async () => { tap('recipe-save') })
    await waitFor(() => expect(calls('PATCH', '/api/recipes/r1')).toHaveLength(1))
    expect(bodyOf('PATCH', '/api/recipes/r1').notes).toBe(NOTES)
  })

  it('a recipe with no notes shows no notes section', async () => {
    wire({ 'GET /api/recipes/r1': () => ({ recipe: { ...DETAIL, notes: null } }) })
    await open()
    expect(screen.queryByTestId('recipe-detail-notes-section')).toBeNull()
  })
})

describe('"Made it, ate it all" (D9) — it says what it will do, and one button is filled', () => {
  it('INSTRUMENT: the filled-button reading finds Make this, and only it, on a recipe just opened', async () => {
    await open()
    expect(FILL).toMatch(/^rgb\(/)
    expect(filled(screen.getByTestId('recipe-detail'))).toEqual(['recipe-make-this'])
  })

  it('the three actions: Make this (filled), Made it, ate it all, and a quiet 48 px Edit', async () => {
    await open()
    expect(screen.getByTestId('recipe-make-this').textContent).toBe('Make this')
    expect(screen.getByTestId('recipe-i-made-this').textContent).toBe('Made it, ate it all')
    const edit = screen.getByTestId('recipe-edit')
    expect([edit.tagName, edit.textContent, edit.style.minHeight]).toEqual(['BUTTON', 'Edit', '48px'])
    // Quiet: the text action's own ink on no fill, where Make this and its neighbour are boxed buttons.
    expect(colour(edit.style.backgroundColor)).not.toBe(FILL)
    expect(edit.style.color).toBe(screen.getByTestId('recipe-back').style.color)
    expect(edit.style.fontSize).toBe(screen.getByTestId('recipe-back').style.fontSize)
    tap('recipe-edit')
    expect(screen.getByTestId('recipe-sheet')).toBeTruthy()
  })

  it('the confirm: the sentence, Log this make, Cancel, and "Kept some?" — and ONE filled button while it is open', async () => {
    await open()
    expect(screen.queryByTestId('recipe-made-confirm')).toBeNull()
    expect(screen.getByTestId('recipe-i-made-this').getAttribute('aria-expanded')).toBe('false')
    tap('recipe-i-made-this')
    const confirm = screen.getByTestId('recipe-made-confirm')
    expect(confirm.querySelector('p').textContent).toBe('Logs a make of this for today, every line as written. Nothing goes into the Pantry.')
    expect(screen.getByTestId('recipe-made-confirm-save').textContent).toBe('Log this make')
    expect(screen.getByTestId('recipe-made-cancel').textContent).toBe('Cancel')
    expect(screen.getByTestId('recipe-made-kept-some').textContent).toBe('Kept some? Start a batch instead →')
    expect([...confirm.querySelectorAll('button')].map(b => b.getAttribute('data-testid')))
      .toEqual(['recipe-made-confirm-save', 'recipe-made-cancel', 'recipe-made-kept-some'])
    expect(screen.getByTestId('recipe-i-made-this').getAttribute('aria-expanded')).toBe('true')
    // Make this is still there and still works; it is no longer the filled one.
    expect(filled(screen.getByTestId('recipe-detail'))).toEqual(['recipe-made-confirm-save'])
    for (const id of ['recipe-made-cancel', 'recipe-made-kept-some']) {
      expect(screen.getByTestId(id).style.minHeight).toBe('48px')
      expect(colour(screen.getByTestId(id).style.backgroundColor)).not.toBe(FILL)
    }
  })

  it('Cancel closes it, writes nothing, and Make this is the filled button again', async () => {
    await open()
    tap('recipe-i-made-this')
    tap('recipe-made-cancel')
    expect(screen.queryByTestId('recipe-made-confirm')).toBeNull()
    expect(filled(screen.getByTestId('recipe-detail'))).toEqual(['recipe-make-this'])
    expect(calls('POST', '/api/kitchen-batches')).toHaveLength(0)
  })

  it('"Kept some? Start a batch instead →" does exactly what Make this does: the Start sheet, for this recipe', async () => {
    await open()
    tap('recipe-make-this')
    const viaMakeThis = screen.getByTestId('start-standin').outerHTML
    tap('start-standin-close')
    expect(screen.queryByTestId('start-standin')).toBeNull()
    tap('recipe-i-made-this')
    tap('recipe-made-kept-some')
    expect(screen.getByTestId('start-standin').outerHTML).toBe(viaMakeThis)
    expect(screen.getByTestId('start-standin').dataset.recipeId).toBe('r1')
    // He kept some, so "ate it all" is put away, and nothing was logged.
    expect(screen.queryByTestId('recipe-made-confirm')).toBeNull()
    expect(calls('POST', '/api/kitchen-batches')).toHaveLength(0)
  })

  it('a batch started from "Kept some?" is handed to the page as one started from Make this is', async () => {
    const started = vi.fn()
    await open({ onBatchStarted: started })
    tap('recipe-i-made-this')
    tap('recipe-made-kept-some')
    tap('start-standin-start')
    expect(started).toHaveBeenCalledTimes(1)
    expect(started.mock.calls[0][0]).toEqual({ id: 'kb-new', label: 'Petri Dish' })
    expect(screen.queryByTestId('start-standin')).toBeNull()
  })

  it('Log this make still records the make and lands on it (the flow itself is pinned in Recipes.test.jsx)', async () => {
    const started = vi.fn()
    wire({
      'POST /api/kitchen-batches': (b) => ({ id: 'kb-made', label: b.label }),
      'POST /api/kitchen-batches/kb-made/inputs': () => ({ inputs: [] }),
      'POST /api/kitchen-batches/kb-made/close': () => ({}),
    })
    await open({ onBatchStarted: started })
    tap('recipe-i-made-this')
    await act(async () => { tap('recipe-made-confirm-save') })
    await waitFor(() => expect(started).toHaveBeenCalledTimes(1))
    expect(started.mock.calls[0][0]).toEqual({ id: 'kb-made', label: 'Petri Dish' })
    expect(bodyOf('POST', '/api/kitchen-batches/kb-made/close')).toEqual({ outcome: 'consumed' })
    expect(screen.queryByTestId('recipe-made-confirm')).toBeNull()
  })
})

describe('"Made from this" (D3) — the ending in words, with its count', () => {
  it('each row: name · day · ending; "Put it up" is left out only where its count says it', async () => {
    await open()
    expect(screen.getAllByTestId('recipe-detail-batch').map(r => r.textContent)).toEqual([
      'Mojo Oct · Oct 2 · 6 put-ups',
      'Mojo plain · Sep 20 · Put it up',
      'Mojo gift · Sep 10 · Gave it away · 1 put-up',
      'Mojo odd · Aug 20 · Put it up — but not what I set out to make · 12 put-ups',
      'Mojo eaten · Aug 10 · Ate it',
      'Mojo again · Oct 8 · still going',
      'Mojo resting · Oct 5 · paused',
    ])
  })

  it('a row opens its batch, and is a 48 px target', async () => {
    const started = vi.fn()
    await open({ onBatchStarted: started })
    const rows = screen.getAllByTestId('recipe-detail-batch-open')
    for (const r of rows) expect(r.style.minHeight).toBe('48px')
    fireEvent.click(rows[2])
    expect(started).toHaveBeenCalledTimes(1)
    expect(started.mock.calls[0][0]).toMatchObject({ id: 'b3', label: 'Mojo gift' })
  })
})

describe('48 px targets on the recipe list and detail (F16)', () => {
  it('the list: New recipe, the filter chips and the rows', async () => {
    render(<MemoryRouter><RecipesView now={NOW} /></MemoryRouter>)
    await waitFor(() => expect(screen.getAllByTestId('recipes-row')).toHaveLength(2))
    const list = [...screen.getByTestId('recipes-view').querySelectorAll('button, a[href]')]
    expect(list.map(el => el.getAttribute('data-testid'))).toEqual(['recipes-new', 'recipes-filter-all', 'recipes-filter-chip', 'recipes-filter-chip', 'recipes-row', 'recipes-row'])
    for (const el of list) expect(`${el.getAttribute('data-testid')} ${el.style.minHeight}`).toBe(`${el.getAttribute('data-testid')} 48px`)
    // The chips keep their size of type: only the height moved.
    expect(screen.getByTestId('recipes-filter-all').style.fontSize).toBe('0.82rem')
  })

  it('the detail: every control, with the confirm and the remove question open', async () => {
    await open()
    tap('recipe-i-made-this')
    tap('recipe-remove')
    const detail = screen.getByTestId('recipe-detail')
    const controls = [...detail.querySelectorAll('button, a[href]')]
    expect(controls.map(c => c.getAttribute('data-testid') ?? c.textContent)).toEqual([
      'recipe-back', 'recipe-detail-link', 'recipe-make-this', 'recipe-i-made-this', 'recipe-edit',
      'recipe-made-confirm-save', 'recipe-made-cancel', 'recipe-made-kept-some',
      ...DETAIL.batches.map(() => 'recipe-detail-batch-open'), 'recipe-remove-yes', 'Keep it',
    ])
    for (const el of controls) expect(`${el.getAttribute('data-testid') ?? el.textContent} ${el.style.minHeight}`).toBe(`${el.getAttribute('data-testid') ?? el.textContent} 48px`)
  })
})

describe('words — nothing banned on recipe detail with every panel open, his notes aside', () => {
  const BANNED = /\b(safe|shelf life|shelf-stable|keeps|good|ready|done|expired|table|default|basis)\b/i
  it('INSTRUMENT: the pattern catches a banned word', () => { expect('How long it keeps').toMatch(BANNED) })

  it('the detail, the confirm and the remove question', async () => {
    await open()
    tap('recipe-i-made-this')
    tap('recipe-remove')
    const clone = screen.getByTestId('recipe-detail').cloneNode(true)
    clone.querySelectorAll('[data-testid="recipe-detail-notes"]').forEach(n => n.remove())
    expect(clone.textContent).toContain('Kept some? Start a batch instead →')
    expect(clone.textContent).not.toMatch(BANNED)
  })
})
