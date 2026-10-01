// Put-Up UX pass R1, lane A — the Start sheet's new words and its "Start from" row (PLAN-V3 D10), the name a
// door hands it (`initialLabel`), and the additive draft.
//
// WHAT THIS FILE HOLDS, each with the mutation that proves it:
//   · the field is "Name it", placeholder "e.g. Megatron mash"; the dialog is still "Start a batch";
//   · "Start from" sits directly under the name: two 48px buttons that each OPEN a list — a group, never a
//     radiogroup, nothing required, nothing preselected, and nothing read until one is opened;
//   · "a recipe" lists the household's recipes as rows grouped by what they make; "a past batch" is the
//     shipped Like-a-past-batch picker with this row as its door;
//   · a pick fills an EMPTY name and an unpicked kind — never a typed name, never a chosen kind — shows
//     what was picked, and can be undone (which takes back what THAT pick filled, if it still stands);
//   · `initialLabel`: a non-blank value wins over the stored start/new draft, read once at mount;
//   · the draft is additive: a release-4 draft (recipeId alone) still restores and is named from the list;
//   · the ruled row "Following a recipe? · tested recipes →" is unchanged at open, and a pick leaves it
//     as it was; nothing new at open matches Snap's sweeps; no banned word; clean under axe.
// MUTATIONS (run for this file):
//   · fillFrom sets the label whatever it holds          -> "never replaces a typed name" reds
//   · unfill does nothing                                -> "takes back the name and the kind it filled" reds
//   · `restored` is read even when a name was handed in  -> "a non-blank initialLabel wins …" reds
//   · the Start-from row is a role=radiogroup            -> "is a group of two buttons …" reds
// CI lane: `npm test` plus the TZ re-run. No jest-dom (L-182).
import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, act, cleanup } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: vi.fn(), isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))
const auth = { user: { id: 'user_dave' } }
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => auth }))

import StartBatchSheet, {
  START_LABEL_TEXT, START_LABEL_PLACEHOLDER, START_FROM_LABEL, START_FROM_RECIPE, START_FROM_BATCH, isStartDraft,
} from '../components/kitchen/StartBatchSheet.jsx'
import LikeBatchPicker from '../components/putup/LikeBatchPicker.jsx'
import { pickRecipe, clearRecipe, followingBody } from '../components/recipes/FollowingRecipe.jsx'
import { clearReloadBlocks } from '../lib/reloadGate.js'
import { expectNoA11yViolations, A11Y_RULES } from './helpers/axe.js'

const NOW = new Date(2026, 8, 29, 21, 30, 0, 0)          // 2026-09-29 21:30 local
const DRAFT_KEY = 'garden:putup-draft:v1:user_dave:start:new'
const CREATED = { id: 'kb-new', label: 'x', kind: null }
// The list read, as the Lambda sends it (recipeRoutes.js listRecipes): kind and type on every row, no lines.
const RECIPES = [
  { id: 'r2', name: 'Basil pesto', kind: null, recipe_type_id: 't-pesto', type_label: 'Pesto', type_sort: 70, batch_count: 0 },
  { id: 'r1', name: 'Roll for Initiative', kind: 'ferment', recipe_type_id: 't-hot', type_label: 'Hot sauce', type_sort: 10, batch_count: 2 },
  { id: 'r4', name: 'Aged in the cellar', kind: 'age', recipe_type_id: 't-hot', type_label: 'Hot sauce', type_sort: 10, batch_count: 0 },
  { id: 'r3', name: 'Mystery', kind: null, recipe_type_id: null, type_label: null, batch_count: 0 },
]
const PAST = [
  { id: 'kb-past', label: 'Megatron mash 2025', kind: 'ferment', closed_at: '2025-10-01T12:00:00.000Z' },
  { id: 'kb-aged', label: 'Cellar crock', kind: 'age', closed_at: null },
]
const PAST_DETAIL = {
  'kb-past': { id: 'kb-past', label: 'Megatron mash 2025', kind: 'ferment', inputs: [
    { id: 'l1', input_kind: 'other', label: 'Megatron jalapeño', qty: '170', qty_unit: 'g', ordinal: 1, put_up_stage_id: null },
    { id: 'l2', input_kind: 'other', label: 'Salt', qty: '12', qty_unit: 'g', role: 'salt', ordinal: 2, put_up_stage_id: null },
  ] },
  'kb-aged': { id: 'kb-aged', label: 'Cellar crock', kind: 'age', inputs: [] },
}
let recipesAnswer
function wire() {
  recipesAnswer = () => Promise.resolve({ recipes: RECIPES })
  fetchSpy.mockImplementation((path, o = {}) => {
    const m = (o.method ?? 'GET').toUpperCase()
    if (m === 'POST' && path === '/api/kitchen-batches') return Promise.resolve(CREATED)
    if (m === 'POST') return Promise.resolve({ inputs: [] })
    if (m === 'PUT') return Promise.resolve({})
    if (path === '/api/recipes') return recipesAnswer()
    if (path === '/api/kitchen-batches?state=all') return Promise.resolve({ state: 'all', batches: PAST })
    const one = path.match(/^\/api\/kitchen-batches\/([^/?]+)$/)
    if (one) return Promise.resolve(PAST_DETAIL[one[1]] ?? null)
    return Promise.resolve(null)
  })
}
const calls = (method, path) => fetchSpy.mock.calls.filter(([p, o]) => p === path && (o?.method ?? 'GET').toUpperCase() === method)
const body = (method, path, i = 0) => JSON.parse(calls(method, path)[i][1].body)
const unkeyed = (b) => { const { idempotency_key: _k, ...rest } = b; return rest }

function Host({ onStarted = () => {}, ...rest }) {
  const [open, setOpen] = useState(true)
  return (
    <>
      <StartBatchSheet open={open} onClose={() => setOpen(false)} onStarted={onStarted} now={NOW.getTime()} {...rest} />
      {!open && <button type="button" onClick={() => setOpen(true)}>reopen</button>}
    </>
  )
}
const tap = (id) => fireEvent.click(screen.getByTestId(id))
const type = (id, value) => fireEvent.change(screen.getByTestId(id), { target: { value } })
const startIt = async () => { await act(async () => { tap('start-submit') }) }
const label = () => screen.getByTestId('start-label').value
const rows = () => screen.queryAllByTestId('start-from-recipe-row')
const row = (id) => rows().find(r => r.dataset.recipeId === id)
const openRecipes = async () => { tap('start-from-recipe'); await waitFor(() => expect(rows()).toHaveLength(RECIPES.length)) }
const openBatches = async () => { tap('start-from-batch'); await screen.findByTestId('start-like-batch-kb-past') }
const pressed = (id) => screen.getByTestId(id).getAttribute('aria-pressed')
const draft = () => JSON.parse(localStorage.getItem(DRAFT_KEY))
const storeDraft = (data) => localStorage.setItem(DRAFT_KEY, JSON.stringify({ v: 1, sheet: 'start', savedAt: Date.now(), data }))
const R4_DRAFT = { label: 'Half-typed yesterday', chip: 'yesterday', earlier: null, pickedDate: '', kind: 'candy', kindOther: '', key: 'k-old' }

beforeEach(() => {
  fetchSpy.mockReset(); wire(); localStorage.clear(); clearReloadBlocks(); auth.user = { id: 'user_dave' }
  window.history.replaceState({ __floor: 1 }, '')
})
afterEach(() => { cleanup(); clearReloadBlocks() })

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('the Start sheet\'s words (PLAN-V3 D10)', () => {
  it('the field is "Name it", with one of his own batch names as its placeholder; the dialog is unchanged', () => {
    render(<Host />)
    expect([START_LABEL_TEXT, START_LABEL_PLACEHOLDER]).toEqual(['Name it', 'e.g. Megatron mash'])
    const field = screen.getByTestId('start-label')
    expect(field.getAttribute('placeholder')).toBe('e.g. Megatron mash')
    expect(document.querySelector(`label[for="${field.id}"]`).textContent.replace('*', '').replace('(required)', '')).toBe('Name it')
    expect(screen.getByRole('dialog', { name: 'Start a batch' })).toBeTruthy()
    expect(screen.getByRole('dialog').textContent).not.toContain('What is it?')
  })

  it('the Start-from words are exactly these', () => {
    expect([START_FROM_LABEL, START_FROM_RECIPE, START_FROM_BATCH]).toEqual(['Start from', 'a recipe', 'a past batch'])
  })
})

describe('"Start from" — two doors under the name, never a required choice', () => {
  it('is a group of two buttons that open lists: not a radiogroup, nothing pressed, nothing required, 48px', () => {
    render(<Host />)
    const group = screen.getByRole('group', { name: 'Start from' })
    const buttons = within(group).getAllByRole('button')
    expect(buttons.map(b => [b.getAttribute('data-testid'), b.textContent, b.getAttribute('aria-expanded'), b.style.minHeight])).toEqual([
      ['start-from-recipe', 'a recipe', 'false', '48px'], ['start-from-batch', 'a past batch', 'false', '48px'],
    ])
    expect(group.textContent).toBe('Start from' + 'a recipe' + 'a past batch')
    for (const b of buttons) {
      expect([b.getAttribute('aria-pressed'), b.getAttribute('aria-checked'), b.getAttribute('aria-required')]).toEqual([null, null, null])
    }
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(screen.queryAllByRole('radio')).toHaveLength(0)
    // The sheet still asks exactly one required thing, and it is the name.
    const required = [...screen.getByTestId('start-sheet').querySelectorAll('[aria-required="true"]')]
    expect(required.map(e => e.getAttribute('data-testid'))).toEqual(['start-label'])
    // Not filled: the sheet's one filled button is Start it.
    expect(buttons.map(b => b.style.background)).toEqual(['none', 'none'])
  })

  it('sits directly under the name, above "When did it start?"', () => {
    render(<Host />)
    const order = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    const from = screen.getByTestId('start-from')
    expect(order(screen.getByTestId('start-label'), from)).toBe(true)
    expect(order(from, screen.getByRole('group', { name: 'When did it start?' }))).toBe(true)
    // Directly: the row is the very next thing after the name's field (its label and its input).
    expect(screen.getByTestId('start-label').parentElement.nextElementSibling).toBe(from)
  })

  it('reads nothing until a door is opened, and each list ONCE', async () => {
    render(<Host />)
    await act(async () => { await Promise.resolve() })
    expect(fetchSpy).not.toHaveBeenCalled()
    await openRecipes()
    tap('start-from-recipe'); tap('start-from-recipe')            // closed, then opened again
    await waitFor(() => expect(rows()).toHaveLength(RECIPES.length))
    expect(calls('GET', '/api/recipes')).toHaveLength(1)
    await openBatches()
    tap('start-from-batch'); tap('start-from-batch')
    await screen.findByTestId('start-like-batch-kb-past')
    expect(calls('GET', '/api/kitchen-batches?state=all')).toHaveLength(1)
  })

  it('opens ONE list at a time', async () => {
    render(<Host />)
    await openRecipes()
    expect(screen.getByTestId('start-from-recipe').getAttribute('aria-expanded')).toBe('true')
    await openBatches()
    expect(rows()).toHaveLength(0)
    expect([screen.getByTestId('start-from-recipe').getAttribute('aria-expanded'), screen.getByTestId('start-from-batch').getAttribute('aria-expanded')])
      .toEqual(['false', 'true'])
  })
})

describe('"a recipe" — the household\'s recipes as rows, grouped by what they make', () => {
  it('groups in the Recipes segment\'s order — built-in types, then "No type" — and names each row', async () => {
    render(<Host />)
    await openRecipes()
    const groups = screen.getAllByTestId('start-from-recipe-group')
    expect(groups.map(g => [g.getAttribute('aria-label'), within(g).getAllByTestId('start-from-recipe-row').map(r => r.textContent)])).toEqual([
      ['Hot sauce', ['Aged in the cellar', 'Roll for Initiative']],
      ['Pesto', ['Basil pesto']],
      ['No type', ['Mystery']],
    ])
    expect(rows().every(r => r.tagName === 'BUTTON' && r.style.minHeight === '48px' && r.style.width === '100%')).toBe(true)
    expect(document.querySelectorAll('select')).toHaveLength(0)
  })

  it('a pick fills an EMPTY name and an unpicked kind, says what was picked, and closes the list', async () => {
    render(<Host />)
    await openRecipes()
    fireEvent.click(row('r1'))
    expect(label()).toBe('Roll for Initiative')
    expect(pressed('start-kind-ferment')).toBe('true')
    expect(screen.getByTestId('start-from-recipe-picked').textContent).toBe('From the recipe: Roll for Initiative' + 'Not this recipe')
    expect(rows()).toHaveLength(0)
    await startIt()
    await waitFor(() => expect(calls('POST', '/api/kitchen-batches')).toHaveLength(1))
    expect(unkeyed(body('POST', '/api/kitchen-batches'))).toEqual({
      label: 'Roll for Initiative', started_at: NOW.toISOString(), start_precision: 'exact', start_anchor_kind: 'memory',
      start_anchor_id: null, kind: 'ferment', recipe_id: 'r1',
    })
    // A recipe picked here sets no jar and copies no line: the list read has neither (PLAN-V3 section 1 point 2).
    expect(calls('PUT', '/api/kitchen-batches/kb-new')).toHaveLength(0)
    expect(calls('POST', '/api/kitchen-batches/kb-new/inputs')).toHaveLength(0)
  })

  // MUTATION: fillFrom sets the label whatever it holds -> red.
  it('never replaces a typed name, and never overrides a kind that was chosen', async () => {
    render(<Host />)
    type('start-label', 'My own name')
    tap('start-kind-toggle'); tap('start-kind-candy')
    await openRecipes()
    fireEvent.click(row('r1'))
    expect(label()).toBe('My own name')
    expect([pressed('start-kind-candy'), pressed('start-kind-ferment')]).toEqual(['true', 'false'])
    expect(screen.getByTestId('start-from-recipe-picked').textContent).toContain('Roll for Initiative')
    await startIt()
    await waitFor(() => expect(calls('POST', '/api/kitchen-batches')).toHaveLength(1))
    expect(body('POST', '/api/kitchen-batches')).toMatchObject({ label: 'My own name', kind: 'candy', recipe_id: 'r1' })
  })

  it('a name that is only spaces counts as empty', async () => {
    render(<Host />)
    type('start-label', '   ')
    await openRecipes()
    fireEvent.click(row('r2'))
    expect(label()).toBe('Basil pesto')
  })

  // MUTATION: unfill does nothing -> red.
  it('"Not this recipe" takes back the pick, and the name and the kind it filled', async () => {
    render(<Host />)
    await openRecipes()
    fireEvent.click(row('r1'))
    tap('start-from-recipe-clear')
    expect(screen.queryByTestId('start-from-recipe-picked')).toBeNull()
    expect(label()).toBe('')
    expect(pressed('start-kind-ferment')).toBe('false')
    type('start-label', 'Plain mash')
    await startIt()
    await waitFor(() => expect(calls('POST', '/api/kitchen-batches')).toHaveLength(1))
    const b = body('POST', '/api/kitchen-batches')
    expect(b).not.toHaveProperty('recipe_id')
    expect(b).not.toHaveProperty('kind')
  })

  it('…but keeps a name typed, and a kind chosen, since the pick', async () => {
    render(<Host />)
    await openRecipes()
    fireEvent.click(row('r1'))
    type('start-label', 'Roll for Initiative, batch 2')
    tap('start-kind-candy')
    tap('start-from-recipe-clear')
    expect(label()).toBe('Roll for Initiative, batch 2')
    expect(pressed('start-kind-candy')).toBe('true')
  })

  it('picking another recipe replaces the pick; the name filled by the first stays (it is no longer empty)', async () => {
    render(<Host />)
    await openRecipes()
    fireEvent.click(row('r1'))
    await openRecipes()
    fireEvent.click(row('r2'))
    expect(screen.getByTestId('start-from-recipe-picked').textContent).toContain('Basil pesto')
    expect(label()).toBe('Roll for Initiative')
    await startIt()
    await waitFor(() => expect(calls('POST', '/api/kitchen-batches')).toHaveLength(1))
    expect(body('POST', '/api/kitchen-batches').recipe_id).toBe('r2')
  })

  // `age` is a stored kind no chip offers. Put in the kind it could not be sent, and Start it would refuse
  // with a line about "the kind" the cook never touched.
  it('a recipe whose kind no chip offers fills the name and leaves the kind unpicked', async () => {
    render(<Host />)
    await openRecipes()
    fireEvent.click(row('r4'))
    expect(label()).toBe('Aged in the cellar')
    expect(screen.getByTestId('start-kind-toggle').getAttribute('aria-expanded')).toBe('false')
    await startIt()
    await waitFor(() => expect(calls('POST', '/api/kitchen-batches')).toHaveLength(1))
    expect(body('POST', '/api/kitchen-batches')).not.toHaveProperty('kind')
    expect(screen.queryByTestId('start-error')).toBeNull()
  })

  it('a failed read says so, and opening the list again asks again', async () => {
    recipesAnswer = () => Promise.reject(new Error('502'))
    render(<Host />)
    tap('start-from-recipe')
    expect((await screen.findByTestId('start-from-recipe-error')).textContent).toBe('Couldn’t load your recipes just now.')
    recipesAnswer = () => Promise.resolve({ recipes: RECIPES })
    tap('start-from-recipe'); tap('start-from-recipe')
    await waitFor(() => expect(rows()).toHaveLength(RECIPES.length))
    expect(calls('GET', '/api/recipes')).toHaveLength(2)
  })

  it('a household with no recipes is told so', async () => {
    recipesAnswer = () => Promise.resolve({ recipes: [] })
    render(<Host />)
    tap('start-from-recipe')
    expect((await screen.findByTestId('start-from-recipe-none')).textContent).toBe('No recipes yet.')
  })
})

describe('"a past batch" — the shipped Like-a-past-batch picker, with this row as its door', () => {
  it('draws no door of its own: the list is under the row\'s button', async () => {
    render(<Host />)
    expect(screen.queryByTestId('start-like-open')).toBeNull()
    expect(screen.queryByTestId('start-like')).toBeNull()         // nothing at all until it is opened
    await openBatches()
    expect(screen.queryByTestId('start-like-open')).toBeNull()
    expect(within(screen.getByRole('group', { name: 'Like which batch?' })).getAllByRole('button').map(b => b.textContent))
      .toEqual(['Megatron mash 2025', 'Cellar crock'])
  })

  it('a pick fills an empty name and the kind, copies the lines, and says so; the lines are posted after the create', async () => {
    render(<Host />)
    await openBatches()
    await act(async () => { tap('start-like-batch-kb-past') })
    await screen.findByTestId('start-like-picked')
    expect(label()).toBe('Megatron mash 2025')
    expect(pressed('start-kind-ferment')).toBe('true')
    expect(screen.getByTestId('start-like-picked').textContent).toBe('Like Megatron mash 2025, except… · 2 things copied in' + 'Don’t copy')
    expect(screen.getByTestId('start-from-batch').getAttribute('aria-expanded')).toBe('false')
    await startIt()
    await waitFor(() => expect(calls('POST', '/api/kitchen-batches/kb-new/inputs')).toHaveLength(1))
    expect(body('POST', '/api/kitchen-batches')).toMatchObject({ label: 'Megatron mash 2025', kind: 'ferment' })
    expect(body('POST', '/api/kitchen-batches/kb-new/inputs').inputs.map(l => l.label)).toEqual(['Megatron jalapeño', 'Salt'])
  })

  it('never replaces a typed name; "Don\'t copy" takes back the lines and what the pick filled', async () => {
    render(<Host />)
    type('start-label', 'This year\'s mash')
    await openBatches()
    await act(async () => { tap('start-like-batch-kb-past') })
    await screen.findByTestId('start-like-picked')
    expect(label()).toBe('This year\'s mash')
    tap('start-like-clear')
    expect(screen.queryByTestId('start-like-picked')).toBeNull()
    expect(label()).toBe('This year\'s mash')
    expect(pressed('start-kind-ferment')).toBe('false')
    await startIt()
    await waitFor(() => expect(calls('POST', '/api/kitchen-batches')).toHaveLength(1))
    expect(calls('POST', '/api/kitchen-batches/kb-new/inputs')).toHaveLength(0)
    expect(body('POST', '/api/kitchen-batches')).not.toHaveProperty('kind')
  })

  // "Empty" is judged when the pick LANDS. The past batch is read from the server before it is handed
  // over; on a slow connection that is long enough to type a name, and that name is a typed one.
  // MUTATION: fillFrom reads the name its handler closed over -> red.
  it('a name typed while the past batch is still being read is not replaced when the pick lands', async () => {
    let release
    const base = fetchSpy.getMockImplementation()
    fetchSpy.mockImplementation((path, o) => (path === '/api/kitchen-batches/kb-past'
      ? new Promise(r => { release = () => r(PAST_DETAIL['kb-past']) }) : base(path, o)))
    render(<Host />)
    await openBatches()
    tap('start-like-batch-kb-past')                              // the read is in flight…
    type('start-label', 'Typed while it loaded')                 // …and he types
    tap('start-kind-toggle'); tap('start-kind-candy')
    await act(async () => { release() })
    await screen.findByTestId('start-like-picked')
    expect(label()).toBe('Typed while it loaded')
    expect([pressed('start-kind-candy'), pressed('start-kind-ferment')]).toEqual(['true', 'false'])
    // …and undoing the pick leaves both alone: it filled neither.
    tap('start-like-clear')
    expect(label()).toBe('Typed while it loaded')
    expect(pressed('start-kind-candy')).toBe('true')
  })

  it('a past batch whose kind no chip offers copies in, and Start it still starts', async () => {
    render(<Host />)
    await openBatches()
    await act(async () => { tap('start-like-batch-kb-aged') })
    await screen.findByTestId('start-like-picked')
    expect(label()).toBe('Cellar crock')
    await startIt()
    await waitFor(() => expect(calls('POST', '/api/kitchen-batches')).toHaveLength(1))
    expect(body('POST', '/api/kitchen-batches')).not.toHaveProperty('kind')
    expect(screen.queryByTestId('start-error')).toBeNull()
  })

  it('a recipe AND a past batch: the first pick names it, both are shown, both ride the start', async () => {
    render(<Host />)
    await openRecipes()
    fireEvent.click(row('r2'))                                   // Basil pesto, no kind
    await openBatches()
    await act(async () => { tap('start-like-batch-kb-past') })    // ferment
    await screen.findByTestId('start-like-picked')
    expect(label()).toBe('Basil pesto')
    expect(pressed('start-kind-ferment')).toBe('true')
    expect(screen.getByTestId('start-from-recipe-picked')).toBeTruthy()
    await startIt()
    await waitFor(() => expect(calls('POST', '/api/kitchen-batches/kb-new/inputs')).toHaveLength(1))
    expect(body('POST', '/api/kitchen-batches')).toMatchObject({ label: 'Basil pesto', kind: 'ferment', recipe_id: 'r2' })
  })
})

describe('LikeBatchPicker — its default render is the one How it was made → has always had', () => {
  it('with no `open` prop it draws its own door, and a pick leaves only the picked line', async () => {
    const onPick = vi.fn()
    const view = render(<LikeBatchPicker idPrefix="how-like" picked={null} onPick={onPick} onClear={() => {}} />)
    const door = screen.getByTestId('how-like-open')
    expect([door.textContent, door.getAttribute('aria-expanded'), door.style.minHeight]).toEqual(['Like a past batch, except…optional', 'false', '48px'])
    expect(view.container.firstElementChild.getAttribute('data-testid')).toBe('how-like')
    fireEvent.click(door)
    await screen.findByTestId('how-like-batch-kb-past')
    expect(screen.getByTestId('how-like-open').getAttribute('aria-expanded')).toBe('true')
    await act(async () => { fireEvent.click(screen.getByTestId('how-like-batch-kb-past')) })
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick.mock.calls[0][0]).toMatchObject({ kind: 'ferment', from: { id: 'kb-past', label: 'Megatron mash 2025' } })
    view.rerender(<LikeBatchPicker idPrefix="how-like" picked={onPick.mock.calls[0][0]} onPick={onPick} onClear={() => {}} />)
    expect(view.container.firstElementChild.getAttribute('data-testid')).toBe('how-like-picked')
    expect(screen.queryByTestId('how-like-open')).toBeNull()
  })

  it('controlled, it tells the host to close after a pick and renders nothing while closed and unpicked', async () => {
    const onPick = vi.fn(); const onOpenChange = vi.fn()
    const view = render(<LikeBatchPicker idPrefix="x" open={false} onOpenChange={onOpenChange} onPick={onPick} />)
    expect(view.container.innerHTML).toBe('')
    expect(fetchSpy).not.toHaveBeenCalled()
    view.rerender(<LikeBatchPicker idPrefix="x" open onOpenChange={onOpenChange} onPick={onPick} />)
    const chip = await screen.findByTestId('x-batch-kb-past')
    expect(screen.queryByTestId('x-open')).toBeNull()             // no door of its own
    await act(async () => { fireEvent.click(chip) })
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onOpenChange.mock.calls).toEqual([[false]])
  })
})

describe('Make this (the sheet opened FROM a recipe) is as it was', () => {
  const RECIPE = { id: 'r1', name: 'Roll for Initiative', kind: 'ferment', vessel_label: 'quart jar' }

  it('the recipe is shown as chosen, with no door to another and no way to un-pick it; a past batch is still offered', async () => {
    render(<Host recipe={RECIPE} />)
    expect(screen.getByTestId('following-recipe-locked').textContent).toBe('From the recipe: Roll for Initiative')
    expect(screen.getByTestId('start-from').contains(screen.getByTestId('following-recipe-locked'))).toBe(true)
    expect(screen.queryByTestId('start-from-recipe')).toBeNull()
    expect(screen.queryByTestId('start-from-recipe-clear')).toBeNull()
    expect(screen.getByTestId('start-from-batch')).toBeTruthy()
    expect([label(), pressed('start-kind-ferment')]).toEqual(['Roll for Initiative', 'true'])
    // The ruled row opens by itself, as it always has from a recipe: the caution is on screen.
    expect(screen.getByTestId('following-recipe-toggle').getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('following-recipe-note')).toBeTruthy()
    await act(async () => { await Promise.resolve() })
    expect(calls('GET', '/api/recipes')).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('`initialLabel` — the name a door hands over (PLAN-V3 D10, contract 3)', () => {
  // MUTATION: read `restored` even when a name was handed in -> red.
  it('a non-blank initialLabel wins over the stored start/new draft — the whole draft, not just its name', () => {
    storeDraft(R4_DRAFT)
    render(<Host initialLabel="Megatron mash" />)
    expect(label()).toBe('Megatron mash')
    expect(pressed('start-when-today')).toBe('true')             // not the draft's Yesterday
    expect(screen.getByTestId('start-kind-toggle').getAttribute('aria-expanded')).toBe('false')   // not the draft's Candy
    // …and the first write replaces the old draft, so yesterday's cannot come back later.
    expect(draft().data.label).toBe('Megatron mash')
    expect(draft().data.chip).toBe('today')
  })

  it.each([['an empty string', ''], ['only spaces', '   '], ['absent', undefined], ['not text', { nativeEvent: true }]])(
    '%s is no name: the stored draft restores', (_name, value) => {
      storeDraft(R4_DRAFT)
      render(<Host initialLabel={value} />)
      expect(label()).toBe('Half-typed yesterday')
      expect(pressed('start-when-yesterday')).toBe('true')
      expect(pressed('start-kind-candy')).toBe('true')
    })

  it('is read ONCE, at mount: a host that re-renders with another name does not retype the field', () => {
    const view = render(<StartBatchSheet open onClose={() => {}} onStarted={() => {}} initialLabel="Megatron mash" />)
    type('start-label', 'Megatron mash, crock 2')
    view.rerender(<StartBatchSheet open onClose={() => {}} onStarted={() => {}} initialLabel="Something else" />)
    expect(label()).toBe('Megatron mash, crock 2')
  })

  it('a name longer than the field takes is cut to what the field takes', () => {
    render(<Host initialLabel={'x'.repeat(200)} />)
    expect(label()).toHaveLength(120)
    expect(screen.getByTestId('start-label').getAttribute('maxlength')).toBe('120')
  })

  it('a start with a handed-in name sends it', async () => {
    render(<Host initialLabel="Megatron mash" />)
    await startIt()
    await waitFor(() => expect(calls('POST', '/api/kitchen-batches')).toHaveLength(1))
    expect(body('POST', '/api/kitchen-batches').label).toBe('Megatron mash')
  })
})

describe('the draft is additive: what today\'s client stored still restores', () => {
  it('a release-4 draft carrying recipeId alone restores, is named from the list, and still sends recipe_id', async () => {
    storeDraft({ ...R4_DRAFT, recipeId: 'r2', recipeRef: '' })
    render(<Host />)
    expect(label()).toBe('Half-typed yesterday')
    expect(screen.getByTestId('start-from-recipe-picked').textContent).toContain('From one of your recipes')
    await waitFor(() => expect(screen.getByTestId('start-from-recipe-picked').textContent).toBe('From the recipe: Basil pesto' + 'Not this recipe'))
    expect(label()).toBe('Half-typed yesterday')                  // naming it is not a pick: nothing is filled
    expect(rows()).toHaveLength(0)                               // …and the list did not open
    await startIt()
    await waitFor(() => expect(calls('POST', '/api/kitchen-batches')).toHaveLength(1))
    expect(body('POST', '/api/kitchen-batches')).toMatchObject({ label: 'Half-typed yesterday', kind: 'candy', recipe_id: 'r2' })
  })

  it('…and a stored recipe that is no longer in the list is un-picked, never sent on', async () => {
    storeDraft({ ...R4_DRAFT, recipeId: 'r-gone', recipeRef: '' })
    render(<Host />)
    await waitFor(() => expect(screen.queryByTestId('start-from-recipe-picked')).toBeNull())
    await startIt()
    await waitFor(() => expect(calls('POST', '/api/kitchen-batches')).toHaveLength(1))
    expect(body('POST', '/api/kitchen-batches')).not.toHaveProperty('recipe_id')
  })

  it('a release-4 draft with a typed reference restores it, and the ruled row opens on it as it always did', () => {
    storeDraft({ ...R4_DRAFT, recipeId: null, recipeRef: 'the card in the drawer' })
    render(<Host />)
    expect(screen.getByTestId('following-recipe-ref').value).toBe('the card in the drawer')
    expect(screen.queryByTestId('start-from-recipe-picked')).toBeNull()
  })

  it('a pick is stored with its name beside its id, and restores with no list read', async () => {
    render(<Host />)
    await openRecipes()
    fireEvent.click(row('r1'))
    const { key: _key, ...data } = draft().data
    expect(data).toEqual({ label: 'Roll for Initiative', chip: 'today', earlier: null, pickedDate: '', kind: 'ferment', kindOther: '',
      recipeId: 'r1', recipeRef: '', recipe: { id: 'r1', name: 'Roll for Initiative', kind: 'ferment' } })
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    fetchSpy.mockClear()
    fireEvent.click(screen.getByText('reopen'))
    expect(screen.getByTestId('start-from-recipe-picked').textContent).toBe('From the recipe: Roll for Initiative' + 'Not this recipe')
    await act(async () => { await Promise.resolve() })
    expect(calls('GET', '/api/recipes')).toHaveLength(0)
  })

  it('a plain start\'s draft keeps its shape exactly: no recipe keys ride along unasked', () => {
    render(<Host />)
    type('start-label', 'Mash')
    const { key: _key, ...data } = draft().data
    expect(data).toEqual({ label: 'Mash', chip: 'today', earlier: null, pickedDate: '', kind: null, kindOther: '' })
  })

  it('isStartDraft: `recipe` is optional, must be { id, name } for the picked id, and anything else drops the draft', () => {
    const base = { label: 'x', chip: 'today', earlier: null, pickedDate: '', kind: null, kindOther: '' }
    expect(isStartDraft(base)).toBe(true)
    expect(isStartDraft({ ...base, recipeId: 'r1' })).toBe(true)
    expect(isStartDraft({ ...base, recipeId: 'r1', recipe: null })).toBe(true)
    expect(isStartDraft({ ...base, recipeId: 'r1', recipe: { id: 'r1', name: 'Roll', kind: 'ferment' } })).toBe(true)
    expect(isStartDraft({ ...base, recipeId: 'r1', recipe: { id: 'r1', name: 'Roll', kind: null } })).toBe(true)
    for (const recipe of ['Roll', ['r1'], { id: 'r1' }, { name: 'Roll' }, { id: 'r2', name: 'Other' }, { id: 7, name: 'Roll' }]) {
      expect({ recipe: JSON.stringify(recipe), ok: isStartDraft({ ...base, recipeId: 'r1', recipe }) })
        .toEqual({ recipe: JSON.stringify(recipe), ok: false })
    }
  })

  it('the value helpers: a pick sets id and { id, name, kind }; undoing clears both; the reference rides through', () => {
    const v = { recipeId: null, recipeRef: 'a card', recipe: null }
    const picked = pickRecipe(v, { id: 'r1', name: 'Roll', kind: 'ferment', batch_count: 9 })
    expect(picked).toEqual({ recipeId: 'r1', recipeRef: 'a card', recipe: { id: 'r1', name: 'Roll', kind: 'ferment' } })
    expect(clearRecipe(picked)).toEqual({ recipeId: null, recipeRef: 'a card', recipe: null })
    expect(followingBody(picked)).toEqual({ recipe_id: 'r1', recipe_ref: 'a card' })
    expect(followingBody(clearRecipe(picked))).toEqual({ recipe_ref: 'a card' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('the ruled row "Following a recipe? · tested recipes →" (FOODSAFETY-RULING-V101) is as it was', () => {
  it('at open it is collapsed, with the tested-recipes link on screen', () => {
    render(<Host />)
    const rowEl = screen.getByTestId('following-recipe')
    expect(rowEl.textContent).toBe('Following a recipe?' + 'optional' + '· tested recipes →')
    expect(screen.getByTestId('following-recipe-toggle').getAttribute('aria-expanded')).toBe('false')
    const tested = screen.getByTestId('following-recipe-tested-link')
    expect([tested.tagName, tested.getAttribute('target'), tested.getAttribute('rel')]).toEqual(['A', '_blank', 'noopener noreferrer'])
    expect(tested.getAttribute('href')).toMatch(/^https:\/\//)
  })

  it('behind its toggle: the free-text reference and the caution — and no list of recipes', () => {
    render(<Host />)
    tap('following-recipe-toggle')
    const opened = screen.getByTestId('following-recipe-body')
    expect(within(opened).getByTestId('following-recipe-ref')).toBeTruthy()
    expect(within(opened).getByTestId('following-recipe-note')).toBeTruthy()
    expect(opened.querySelectorAll('select, [role="listbox"], [role="combobox"]')).toHaveLength(0)
    expect(screen.queryByTestId('following-recipe-tested-link')).toBeNull()
    expect(calls('GET', '/api/recipes')).toHaveLength(0)
  })

  it('a pick under Start from leaves the row as it was: still collapsed, the link still on screen', async () => {
    render(<Host />)
    await openRecipes()
    fireEvent.click(row('r1'))
    expect(screen.getByTestId('following-recipe-toggle').getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByTestId('following-recipe-tested-link')).toBeTruthy()
  })

  it('every quiet action on the sheet is 48px tall (F16)', async () => {
    render(<Host />)
    for (const id of ['start-photo-add', 'start-kind-toggle', 'following-recipe-toggle', 'following-recipe-tested-link',
      'start-from-recipe', 'start-from-batch']) {
      expect({ id, minHeight: screen.getByTestId(id).style.minHeight }).toEqual({ id, minHeight: '48px' })
    }
    await openRecipes()
    fireEvent.click(row('r1'))
    expect(screen.getByTestId('start-from-recipe-clear').style.minHeight).toBe('48px')
  })
})

describe('nothing new on the sheet matches Snap\'s sweeps, or a banned word', () => {
  // The same two patterns CaptureFlow.kitchenBatch.test.jsx holds Snap's Start sheet to, with the kind row
  // and Earlier… open as that test opens them.
  const FOOD_SAFETY = /\bpH\b|acidif|acidity|botulis|shelf.stable|shelf life|\bsafe(ty)?\b|spoil/i
  const PRECISION = /precision|how sure|accuracy|approximate\?/i
  const BANNED = /\b(safe|shelf life|shelf-stable|keeps|good|ready|done|expired|table|default|basis)\b/i
  const dialogText = () => screen.getByRole('dialog', { name: 'Start a batch' }).textContent

  it('INSTRUMENT: each pattern fires', () => {
    expect('Check the pH').toMatch(FOOD_SAFETY)
    expect('How sure are you?').toMatch(PRECISION)
    expect('How long it keeps').toMatch(BANNED)
  })

  it('at open, with the kind row and Earlier… open', () => {
    render(<Host />)
    tap('start-kind-toggle')
    tap('start-when-earlier')
    expect(screen.getByTestId('start-kind-ferment')).toBeTruthy()
    expect(dialogText()).toContain('Start from')                 // green control: the new row is in what is read
    expect(dialogText()).not.toMatch(FOOD_SAFETY)
    expect(dialogText()).not.toMatch(PRECISION)
    expect(dialogText()).not.toMatch(BANNED)
    expect([...document.querySelectorAll('[data-testid^="start-when-"]')].map(b => b.textContent).slice(0, 4))
      .toEqual(['Today', 'Yesterday', 'Earlier…', 'Not sure'])
    expect(document.querySelectorAll('select')).toHaveLength(0)
  })

  it('with each Start-from list open, and with both picked', async () => {
    render(<Host />)
    await openRecipes()
    expect(dialogText()).toContain('Roll for Initiative')
    expect(dialogText()).not.toMatch(FOOD_SAFETY)
    expect(dialogText()).not.toMatch(BANNED)
    fireEvent.click(row('r1'))
    await openBatches()
    expect(dialogText()).not.toMatch(BANNED)
    await act(async () => { tap('start-like-batch-kb-past') })
    await screen.findByTestId('start-like-picked')
    expect(dialogText()).toContain('From the recipe: Roll for Initiative')
    expect(dialogText()).toContain('copied in')
    expect(dialogText()).not.toMatch(FOOD_SAFETY)
    expect(dialogText()).not.toMatch(PRECISION)
    expect(dialogText()).not.toMatch(BANNED)
  })

  it('with a failed read and an empty household', async () => {
    recipesAnswer = () => Promise.reject(new Error('502'))
    render(<Host />)
    tap('start-from-recipe')
    await screen.findByTestId('start-from-recipe-error')
    expect(dialogText()).not.toMatch(BANNED)
    cleanup()
    recipesAnswer = () => Promise.resolve({ recipes: [] })
    render(<Host />)
    tap('start-from-recipe')
    await screen.findByTestId('start-from-recipe-none')
    expect(dialogText()).not.toMatch(BANNED)
  })
})

describe('a11y — the Start-from row, open, is clean (with nested-interactive)', () => {
  const RULES = [...A11Y_RULES, 'nested-interactive']

  it('the recipe list open', async () => {
    const { container } = render(<Host />)
    await openRecipes()
    await expectNoA11yViolations(container, { label: 'StartBatchSheet, Start from · a recipe', rules: RULES })
  })

  it('a recipe picked and the past batches open, then both picked', async () => {
    const { container } = render(<Host />)
    await openRecipes()
    fireEvent.click(row('r1'))
    await openBatches()
    await expectNoA11yViolations(container, { label: 'StartBatchSheet, Start from · a past batch', rules: RULES })
    await act(async () => { tap('start-like-batch-kb-past') })
    await screen.findByTestId('start-like-picked')
    await expectNoA11yViolations(container, { label: 'StartBatchSheet, both picked', rules: RULES })
  })
})
