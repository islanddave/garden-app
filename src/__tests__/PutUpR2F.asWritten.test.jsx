// Put-Up R2a, lane F (D5 M2) — "Made it as written" is said ONCE. On batch detail a recipe batch with no
// lines of its own showed it twice: the recipe row's quiet link (`Made it as written →`) and, a block
// below, the button in the empty What went in block. The link is dropped while the button shows, which is
// whenever the row is HOSTED (its host hands it the shared hook and draws the button itself). A row mounted
// alone has no button below it and keeps its link: Recipes.test.jsx pins that, unedited.
// MUTATIONS (each run, each red here):
//   the link kept beside the button on a hosted row   -> "on batch detail … the button, and no link beside it"
//                                                         and "a hosted row draws no link…"
//   the link dropped from the row alone too            -> "the row alone keeps its link…" (and Recipes.test.jsx)
// CI LANE: `npm test` plus the TZ re-run. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  apiFetch: (...args) => fetchMock(...args),
}))
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => ({ user: { id: 'user_dave' } }) }))

import BatchDetailView from '../components/putup/BatchDetailView.jsx'
import BatchRecipeRow, { useMadeAsWritten, MadeAsWrittenButton } from '../components/recipes/BatchRecipeRow.jsx'
import { clearReloadBlocks } from '../lib/reloadGate.js'

const NOW = new Date('2026-10-02T09:00:00').getTime()
const local = (s) => new Date(s).toISOString()
const RECIPE = { id: 'r1', name: 'Roll for Initiative', lines: [
  { id: 'l1', ordinal: 1, name: 'jalapeño', amount_text: '170 g fresh jalapeño', qty: '170', qty_unit: 'g', at_the_end: false },
  { id: 'l2', ordinal: 2, name: 'cumin', amount_text: 'pinch', qty: null, qty_unit: null, at_the_end: false },
  { id: 'l3', ordinal: 3, name: 'onion', amount_text: '20 g onion', qty: '20', qty_unit: 'g', at_the_end: true },
] }
const BATCH = {
  id: 'kb-rec', user_id: 'user_dave', label: 'Megatron mash', kind: 'ferment', kind_other: null,
  started_at: local('2026-09-23T09:00:00'), start_precision: 'day', first_recorded_at: local('2026-09-23T09:00:00'),
  suspended_at: null, closed_at: null, outcome: null, outcome_note: null, current_stage_kind: 'tended',
  current_stage_label: null, current_stage_entered_at: local('2026-09-30T09:00:00'), input_count: '0', output_count: '0',
  garden_names: [], recipe_ref: null, vessel_label: null, vessel_size: null, vessel_unit: null, vessel_count: null, no_salt: null,
  shu_est_low: null, shu_est_high: null, shu_est_basis: null, recipe_id: 'r1', recipe: RECIPE,
}
const STARTED = { id: 'ksl-start', batch_id: 'kb-rec', stage_kind: 'started', label: null, amount: null, amount_unit: null,
  entered_at: local('2026-09-23T09:00:00'), entered_precision: 'day', cue_observed: null, note: null, ph_reading: null, ph_read_at: null }
const OWN_LINE = { id: 'kbi-1', batch_id: 'kb-rec', input_kind: 'other', label: 'Megatron jalapeño', qty: '412', qty_unit: 'g', role: null,
  put_up_stage_id: null, output_id: null, ordinal: 1, from_garden: false, count_drawn: null }

const lineWrites = () => fetchMock.mock.calls.filter(([p, o]) => p === '/api/kitchen-batches/kb-rec/inputs' && o?.method === 'POST')
  .map(([, o]) => JSON.parse(o.body).inputs)
const detail = (inputs = []) => render(<BatchDetailView batch={BATCH} inputs={inputs} stages={[STARTED]} outputs={[]} loading={false}
  error={false} nowMs={NOW} onChanged={() => {}} onOpenRecipe={() => {}} />)
// How many times the page says the words, in any control.
const saidTimes = (root) => root.textContent.split('Made it as written').length - 1

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation((path, o = {}) => (o.method ? Promise.resolve({ inputs: [] }) : Promise.resolve(null)))
  localStorage.clear(); clearReloadBlocks()
})
afterEach(() => { cleanup(); clearReloadBlocks() })

describe('"Made it as written" — one door on batch detail (M2)', () => {
  it('on batch detail a recipe batch with no lines shows the button, and no link beside it', () => {
    detail([])
    expect(screen.getByTestId('what-went-in-as-written-add').textContent).toBe('Made it as written')
    expect(screen.queryByTestId('batch-recipe-as-written')).toBeNull()
    expect(saidTimes(screen.getByTestId('batch-detail-view'))).toBe(1)
    // The rest of the recipe row is as it was.
    expect(screen.getByTestId('batch-recipe-open').textContent).toBe('From Roll for Initiative →')
    expect(screen.getByTestId('batch-recipe-lines-toggle').textContent).toBe('Its lines')
  })

  it('the button still writes every pot line, keyed, and its refusal is said at the button', async () => {
    let n = 0
    fetchMock.mockImplementation((path, o = {}) => (o.method === 'POST' && ++n === 1 ? Promise.reject(new Error('502')) : Promise.resolve({ inputs: [] })))
    detail([])
    await act(async () => { fireEvent.click(screen.getByTestId('what-went-in-as-written-add')) })
    expect(screen.getByTestId('what-went-in-as-written-error').textContent).toBe("Couldn't add the lines — try again (nothing is added twice).")
    expect(screen.queryByTestId('batch-recipe-error')).toBeNull()
    expect(screen.queryByTestId('batch-recipe-as-written')).toBeNull()
    await act(async () => { fireEvent.click(screen.getByTestId('what-went-in-as-written-add')) })
    expect(lineWrites()).toHaveLength(2)
    expect(lineWrites()[1].map(l => [l.label, l.idempotency_key])).toEqual(lineWrites()[0].map(l => [l.label, l.idempotency_key]))
    expect(lineWrites()[0].map(l => l.label)).toEqual(['jalapeño', 'cumin'])
  })

  it('with a line of its own the batch shows neither', () => {
    detail([OWN_LINE])
    expect(screen.queryByTestId('what-went-in-as-written')).toBeNull()
    expect(screen.queryByTestId('batch-recipe-as-written')).toBeNull()
    expect(saidTimes(screen.getByTestId('batch-detail-view'))).toBe(0)
  })

  // The row by itself: a host hands it the hook (`asWritten`) exactly when it draws the button.
  it('a hosted row draws no link, whatever its host\'s hook says', () => {
    const hook = { can: true, busy: false, failed: null, run: vi.fn(), count: 2 }
    const { rerender } = render(<BatchRecipeRow batch={BATCH} inputs={[]} saveAsRecipe={false} asWritten={hook} />)
    expect(screen.queryByTestId('batch-recipe-as-written')).toBeNull()
    expect(screen.getByTestId('batch-recipe-from').textContent).toBe('From the recipe: Roll for InitiativeIts lines')
    rerender(<BatchRecipeRow batch={BATCH} inputs={[]} saveAsRecipe={false} asWritten={{ ...hook, busy: true }} />)
    expect(screen.queryByTestId('batch-recipe-as-written')).toBeNull()
    expect(hook.run).not.toHaveBeenCalled()
  })

  it('the row alone keeps its link, 48 px tall, and one tap writes the pot lines', async () => {
    render(<BatchRecipeRow batch={BATCH} inputs={[]} onChanged={() => {}} />)
    const link = screen.getByTestId('batch-recipe-as-written')
    expect(link.textContent).toBe('Made it as written →')
    expect(link.style.minHeight).toBe('48px')
    expect(screen.queryByTestId('what-went-in-as-written')).toBeNull()
    await act(async () => { fireEvent.click(link) })
    expect(lineWrites()).toHaveLength(1)
    expect(lineWrites()[0].map(l => l.label)).toEqual(['jalapeño', 'cumin'])
  })
})

// The hook is still one key set whichever door calls it: a host that draws two doors over one hook (none
// does today) cannot add every line twice. This was pinned through batch detail's two doors before M2.
describe('useMadeAsWritten — one key set per recipe, from either door', () => {
  function TwoDoors() {
    const asWritten = useMadeAsWritten({ batch: BATCH, inputs: [], onChanged: () => {} })
    return (
      <div>
        <MadeAsWrittenButton asWritten={asWritten} />
        <button type="button" data-testid="other-door" onClick={() => asWritten.run('row')}>other</button>
        <span data-testid="failed-door">{asWritten.failed?.door ?? 'none'}</span>
      </div>
    )
  }

  it('a retry from the other door sends the SAME keys, and the refusal names the door that was tapped', async () => {
    let n = 0
    fetchMock.mockImplementation((path, o = {}) => (o.method === 'POST' && ++n <= 2 ? Promise.reject(new Error('502')) : Promise.resolve({ inputs: [] })))
    render(<TwoDoors />)
    await act(async () => { fireEvent.click(screen.getByTestId('what-went-in-as-written-add')) })
    expect(screen.getByTestId('failed-door').textContent).toBe('block')
    await act(async () => { fireEvent.click(screen.getByTestId('other-door')) })
    expect(screen.getByTestId('failed-door').textContent).toBe('row')
    await act(async () => { fireEvent.click(screen.getByTestId('other-door')) })
    expect(screen.getByTestId('failed-door').textContent).toBe('none')
    const keys = lineWrites().map(w => w.map(l => l.idempotency_key))
    expect(keys).toHaveLength(3)
    expect(keys[1]).toEqual(keys[0])
    expect(keys[2]).toEqual(keys[0])
    expect(new Set(keys[0]).size).toBe(2)
  })
})
