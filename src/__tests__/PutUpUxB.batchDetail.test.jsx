// Put-Up UX pass R1, lane B — batch detail (BatchDetailView.jsx and the rows it mounts), decision D15:
//   · the ACTION ROW under the title: Check on it (the page's one filled button on a batch that is going
//     or paused; the secondary, with nothing filled, on a finished one) and Put it up;
//   · the kind in the meta line, in its chip's word;
//   · the outcome line as the closed list's row says it (D3);
//   · Save as recipe down beside Pause and the ending;
//   · the recipe row: "From <name> →" through onOpenRecipe, and "Made it as written" as a second door in
//     the empty What went in block;
//   · the no-recipe row's two targets 12px apart, Jar & heat's words, 48px quiet actions (F16);
//   · and the banned-word sweep this surface did not have.
// Each assertion names the mutation that reds it. CI LANE: `npm test` plus the TZ re-run. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  apiFetch: (...args) => fetchMock(...args),
}))
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => ({ user: { id: 'user_dave' } }) }))

import { P } from '../lib/constants.js'
import BatchDetailView from '../components/putup/BatchDetailView.jsx'
import BatchRecipeRow, { SaveAsRecipe, asWrittenHint } from '../components/recipes/BatchRecipeRow.jsx'
import { KIND_CHIPS } from '../components/kitchen/KindChips.jsx'
import { CHECK_ON_IT_CTA } from '../components/putup/goingNow.js'
import { PUT_IT_UP_CTA } from '../components/putup/putItUp.js'
import { MADE_AS_WRITTEN_CTA, SAVE_AS_RECIPE_CTA } from '../components/recipes/recipes.js'
import { readFrom } from '../components/putup/origin.js'
import { clearReloadBlocks } from '../lib/reloadGate.js'

const toRgb = (hex) => {
  const n = parseInt(hex.replace('#', ''), 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}
const FILLED = toRgb(P.green)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const NOW = new Date('2026-10-02T09:00:00').getTime()
const local = (s) => new Date(s).toISOString()
// NOON UTC for a closed_at: far enough from both midnights that no CI zone moves the calendar day.
const CLOSED_AUG_28 = '2026-08-28T12:00:00.000Z'

const BATCH = {
  id: 'kb-1', user_id: 'user_dave', label: 'Megatron mash', kind: 'ferment', kind_other: null,
  started_at: local('2026-09-23T09:00:00'), start_precision: 'day', first_recorded_at: local('2026-09-23T09:00:00'),
  suspended_at: null, closed_at: null, outcome: null, outcome_note: null, current_stage_kind: 'tended',
  current_stage_label: null, current_stage_entered_at: local('2026-09-30T09:00:00'), input_count: '1', output_count: '0',
  garden_names: [], recipe_ref: null,
  vessel_label: null, vessel_size: null, vessel_unit: null, vessel_count: null, no_salt: null,
  shu_est_low: null, shu_est_high: null, shu_est_basis: null,
}
const PAUSED = { ...BATCH, id: 'kb-paused', suspended_at: local('2026-09-29T09:00:00') }
const CLOSED = { ...BATCH, id: 'kb-closed', closed_at: CLOSED_AUG_28, outcome: 'put_up', output_count: '2', current_stage_kind: 'finished' }
const LINE = { id: 'kbi-1', batch_id: 'kb-1', input_kind: 'other', label: 'Megatron jalapeño', qty: '412', qty_unit: 'g', role: null,
  put_up_stage_id: null, output_id: null, ordinal: 1, from_garden: false, count_drawn: null }
const STARTED = { id: 'ksl-start', batch_id: 'kb-1', stage_kind: 'started', label: null, amount: null, amount_unit: null,
  entered_at: local('2026-09-23T09:00:00'), entered_precision: 'day', cue_observed: null, note: null, ph_reading: null, ph_read_at: null }
const RECIPE = { id: 'r1', name: 'Roll for Initiative', lines: [
  { id: 'l1', ordinal: 1, name: 'jalapeño', amount_text: '170 g fresh jalapeño', qty: '170', qty_unit: 'g', at_the_end: false },
  { id: 'l2', ordinal: 2, name: 'cumin', amount_text: 'pinch', qty: null, qty_unit: null, at_the_end: false },
  { id: 'l3', ordinal: 3, name: 'onion', amount_text: '20 g onion', qty: '20', qty_unit: 'g', at_the_end: true },
] }
const FOLLOWING = { ...BATCH, id: 'kb-rec', recipe_id: 'r1', recipe: RECIPE }

const writes = () => fetchMock.mock.calls.filter(([, o]) => o?.method && o.method !== 'GET').map(([p, o]) => [o.method, p, JSON.parse(o.body ?? '{}')])
function renderDetail(o = {}) {
  const onChanged = o.onChanged ?? vi.fn()
  const utils = render(<BatchDetailView batch={o.batch === null ? null : { ...BATCH, ...o.batch }} inputs={o.inputs ?? [LINE]}
    stages={o.stages ?? [STARTED]} outputs={o.outputs ?? []} loading={false} error={false} nowMs={NOW} onChanged={onChanged}
    onOpenRecipe={o.onOpenRecipe} />)
  return { ...utils, onChanged }
}
const view = () => screen.getByTestId('batch-detail-view')
// The FILLED buttons: an action painted in the fill colour. A chip that is merely the one chosen (a
// pressed or checked chip — the salt base, a unit) wears the same green as its selected state and is a
// different thing, so it is left out by what it says it is.
const filled = (root = view()) => [...root.querySelectorAll('button')]
  .filter(b => b.style.backgroundColor === FILLED && !b.hasAttribute('aria-pressed') && !b.hasAttribute('aria-checked'))
// `a` comes before `b` in the document.
const before = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation((path, o = {}) => {
    if (path === '/api/storage-locations') return Promise.resolve([{ id: 'loc-fridge', label: 'Fridge', kind: 'fridge' }])
    if (o.method) return Promise.resolve({ ok: true, stage: { id: 'ksl-new' }, inputs: [{ id: 'kbi-new' }], recipe: { id: 'r9', name: 'Megatron mash' } })
    return Promise.resolve(null)
  })
  localStorage.clear(); clearReloadBlocks()
})
afterEach(() => clearReloadBlocks())

describe('the action row — Check on it and Put it up, under the title', () => {
  // MUTATION: leave the two doors where they were (the Log's head, under What came out) -> the order
  // arms and both "no longer in" arms red.
  it('sits under the title and the meta line, above everything else on the page', () => {
    renderDetail()
    const row = screen.getByTestId('batch-detail-actions')
    expect([...row.querySelectorAll('button')].map(b => b.getAttribute('data-testid'))).toEqual(['batch-detail-check', 'batch-detail-put-up'])
    expect([...row.querySelectorAll('button')].map(b => b.textContent)).toEqual([CHECK_ON_IT_CTA, PUT_IT_UP_CTA])
    expect([CHECK_ON_IT_CTA, PUT_IT_UP_CTA]).toEqual(['Check on it', 'Put it up'])
    expect(before(screen.getByTestId('batch-detail-title'), row)).toBe(true)
    expect(before(screen.getByTestId('batch-detail-meta'), row)).toBe(true)
    for (const below of ['recipe-ref', 'batch-detail-inputs', 'jar-heat', 'batch-detail-stages', 'batch-detail-outputs']) {
      expect(`${below} is below the action row: ${before(row, screen.getByTestId(below))}`).toBe(`${below} is below the action row: true`)
    }
    // …and each door is on the page exactly once: the Log and What came out no longer carry one.
    expect(within(screen.getByTestId('batch-detail-stages')).queryByTestId('batch-detail-check')).toBeNull()
    expect(within(screen.getByTestId('batch-detail-outputs')).queryByTestId('batch-detail-put-up')).toBeNull()
    expect(screen.getAllByTestId('batch-detail-check')).toHaveLength(1)
    expect(screen.getAllByTestId('batch-detail-put-up')).toHaveLength(1)
    expect(row.style.gap).toBe('12px')
  })

  // ONE filled button per screen state. MUTATION: make Put it up filled too -> both lists grow to two;
  // make Check on it secondary on a going batch -> they are empty.
  it.each([['going', BATCH], ['paused', PAUSED]])('on a batch that is %s, Check on it is the page\'s one filled button and Put it up is secondary', (_, batch) => {
    renderDetail({ batch })
    expect(filled().map(b => b.getAttribute('data-testid'))).toEqual(['batch-detail-check'])
    expect(screen.getByTestId('batch-detail-put-up').style.backgroundColor).toBe('transparent')
    for (const id of ['batch-detail-check', 'batch-detail-put-up']) expect(screen.getByTestId(id).style.minHeight).toBe('48px')
  })

  it('…and still the only one on a batch with nothing written down, where the add row is open (and empty)', () => {
    renderDetail({ inputs: [] })
    expect(screen.getByTestId('line-add-name')).toBeTruthy()                           // instrument: the adder IS on screen
    expect(filled().map(b => b.getAttribute('data-testid'))).toEqual(['batch-detail-check'])
  })

  // MUTATION: drop the closed arm (always 'primary') -> a finished batch has a filled button again.
  it('on a finished batch Check on it is the secondary, nothing is filled, and Put it up is absent', () => {
    renderDetail({ batch: CLOSED })
    expect(filled()).toEqual([])
    expect(screen.getByTestId('batch-detail-check').style.backgroundColor).toBe('transparent')
    expect(screen.getByTestId('batch-detail-check').textContent).toBe('Check on it')
    expect(screen.queryByTestId('batch-detail-put-up')).toBeNull()
    expect([...screen.getByTestId('batch-detail-actions').querySelectorAll('button')]).toHaveLength(1)
  })

  it('offers no pH shortcut: the row holds those two doors and nothing else', () => {
    renderDetail()
    expect(screen.getByTestId('batch-detail-actions').textContent).toBe('Check on itPut it up')
    expect(screen.getByTestId('batch-detail-actions').textContent).not.toMatch(/pH/i)
  })

  // Completion in place: what a check-in answers with shows under the row it was tapped in, not a
  // screen and a half down. MUTATION: leave "Saved · Undo" at the head of the Log -> both arms red.
  it('Check on it answers where it was tapped: "Saved · Undo" directly under the row', async () => {
    renderDetail()
    await act(async () => { fireEvent.click(screen.getByTestId('batch-detail-check')) })
    expect(screen.getByTestId('checkin-sheet').getAttribute('data-batch-id')).toBe('kb-1')
    fireEvent.click(screen.getByTestId('checkin-act-pushed_under'))
    await act(async () => { fireEvent.click(screen.getByTestId('checkin-save')) })
    const saved = await waitFor(() => screen.getByTestId('going-checkin-saved'))
    expect(saved.textContent).toBe('SavedUndo')
    expect(screen.getByTestId('batch-detail-actions').nextElementSibling).toBe(saved)
    expect(within(screen.getByTestId('batch-detail-stages')).queryByTestId('going-checkin-saved')).toBeNull()
  })

  it('Put it up opens its sheet from the row', async () => {
    renderDetail()
    await act(async () => { fireEvent.click(screen.getByTestId('batch-detail-put-up')) })
    expect(screen.getByTestId('putup-sheet').getAttribute('data-batch-id')).toBe('kb-1')
  })
})

describe('the meta line says the kind, in its chip\'s word', () => {
  // The age and the touch come from goingNow.js (lane A's, unchanged): started Sep 23 against Oct 2 is 9
  // days; the last entry was Sep 30, 2 days ago.
  it('leads with it: one joined line, every separator included', () => {
    renderDetail()
    expect(screen.getByTestId('batch-detail-meta').textContent).toBe('Ferment · 9 days · Tended · last touched 2 days ago')
  })

  // MUTATION: print the stored value instead of the chip's label -> 'dehydrate' reads "dehydrate", not "Dry".
  it.each(KIND_CHIPS.map(c => [c.value, c.label]))('%s reads as "%s"', (kind, label) => {
    renderDetail({ batch: { kind } })
    expect(screen.getByTestId('batch-detail-meta').textContent).toBe(`${label} · 9 days · Tended · last touched 2 days ago`)
  })

  // An unknown kind prints nothing — never the raw column value. `age` is a live stored kind no chip
  // offers. MUTATION: fall back to the raw kind -> all three arms red.
  it.each([['age'], ['a_kind_from_the_future'], [null]])('a kind with no chip (%s) prints nothing', (kind) => {
    renderDetail({ batch: { kind } })
    expect(screen.getByTestId('batch-detail-meta').textContent).toBe('9 days · Tended · last touched 2 days ago')
    expect(view().innerHTML).not.toContain('a_kind_from_the_future')
  })
})

describe('the outcome line is the string the closed list\'s row says (D3)', () => {
  // The four literals D3 pins, on THIS surface. The same four are pinned on the list in
  // PutUpUxB.closedList.test.jsx; one function writes both (closedEnding).
  // MUTATION: drop the label whenever a count follows -> the last two red; never drop it -> the first.
  it.each([
    ['put_up', '2', 'closed Aug 28 · 2 put-ups'],
    ['put_up', '0', 'closed Aug 28 · Put it up'],
    ['given_away', '1', 'closed Aug 28 · Gave it away · 1 put-up'],
    ['put_up_different', '12', 'closed Aug 28 · Put it up — but not what I set out to make · 12 put-ups'],
  ])('%s with %s counted reads "%s"', (outcome, output_count, literal) => {
    renderDetail({ batch: { ...CLOSED, outcome, output_count } })
    expect(screen.getByTestId('batch-detail-outcome').textContent).toBe(literal)
  })

  it('says nothing while the batch is still going', () => {
    renderDetail()
    expect(screen.queryByTestId('batch-detail-outcome')).toBeNull()
  })
})

describe('Save as recipe sits down beside Pause and the ending', () => {
  const bottom = () => ['batch-pause', 'batch-close-open', 'batch-save-as-recipe', 'batch-remove']
    .filter(id => screen.queryByTestId(id)).sort((a, b) => (before(screen.getByTestId(a), screen.getByTestId(b)) ? -1 : 1))

  // MUTATION: leave it in the recipe row, above What went in -> the "below" arm and the not-in-row arm red.
  it('after Pause and the ending, before Remove — and no longer between the title and the first line', () => {
    renderDetail()
    expect(bottom()).toEqual(['batch-pause', 'batch-close-open', 'batch-save-as-recipe', 'batch-remove'])
    expect(before(screen.getByTestId('batch-detail-outputs'), screen.getByTestId('batch-save-as-recipe'))).toBe(true)
    expect(screen.getAllByTestId('batch-save-as-recipe')).toHaveLength(1)
    expect(screen.getByTestId('batch-save-as-recipe').textContent).toBe(SAVE_AS_RECIPE_CTA)
    expect(screen.getByTestId('batch-save-as-recipe').style.minHeight).toBe('48px')
  })

  it('is still offered on a finished batch, where there is no Pause and no ending to choose', () => {
    renderDetail({ batch: CLOSED })
    expect(bottom()).toEqual(['batch-save-as-recipe', 'batch-remove'])
  })

  it('still saves through the one keyed route, the name prefilled with the batch\'s', async () => {
    const { onChanged } = renderDetail()
    fireEvent.click(screen.getByTestId('batch-save-as-recipe'))
    expect(screen.getByTestId('batch-save-as-recipe-name').value).toBe('Megatron mash')
    await act(async () => { fireEvent.click(screen.getByTestId('batch-save-as-recipe-save')) })
    const [method, path, body] = writes()[0]
    expect([method, path]).toEqual(['POST', '/api/recipes/from-batch/kb-1'])
    expect(body.idempotency_key).toMatch(UUID)
    expect({ ...body, idempotency_key: 'K' }).toEqual({ idempotency_key: 'K', name: 'Megatron mash' })
    await waitFor(() => expect(screen.getByTestId('batch-save-as-recipe-saved').textContent).toBe('Saved as a recipe: Megatron mash'))
    expect(onChanged).toHaveBeenCalled()
  })

  it('a refused save says so beside the form, and the name typed is still there', async () => {
    fetchMock.mockImplementation((path, o = {}) => (o.method === 'POST' ? Promise.reject(new Error('offline')) : Promise.resolve(null)))
    renderDetail()
    fireEvent.click(screen.getByTestId('batch-save-as-recipe'))
    fireEvent.change(screen.getByTestId('batch-save-as-recipe-name'), { target: { value: 'House mash' } })
    await act(async () => { fireEvent.click(screen.getByTestId('batch-save-as-recipe-save')) })
    expect(screen.getByTestId('batch-save-as-recipe-error').textContent).toBe("Couldn't save it as a recipe — try again.")
    expect(screen.getByTestId('batch-save-as-recipe-name').value).toBe('House mash')
  })

  // The component split. Mounted alone, the recipe row still carries Save as recipe inside it — the
  // markup every host that mounts it without the new props has always had.
  it('BatchRecipeRow alone still renders Save as recipe inside itself; with saveAsRecipe={false} it does not', () => {
    const { unmount } = render(<BatchRecipeRow batch={{ id: 'kb1', label: 'x' }} inputs={[]} onChanged={() => {}} />)
    expect(within(screen.getByTestId('batch-recipe')).getByTestId('batch-save-as-recipe').textContent).toBe('Save as recipe')
    unmount()
    const alone = render(<BatchRecipeRow batch={{ id: 'kb1', label: 'x' }} inputs={[]} onChanged={() => {}} saveAsRecipe={false} />)
    // No recipe and no Save as recipe: nothing to say, so no empty block either.
    expect(alone.container.innerHTML).toBe('')
    alone.unmount()
    render(<SaveAsRecipe batch={{ id: 'kb1', label: 'x' }} onChanged={() => {}} />)
    expect(screen.getByTestId('batch-save-as-recipe').textContent).toBe('Save as recipe')
  })
})

describe('the recipe row — "From <name> →" opens the recipe', () => {
  // MUTATION: call onOpenRecipe(id) with no origin -> the recipe's Back cannot name this batch.
  it('with onOpenRecipe, the name is the way in — and it says which batch it came from', () => {
    const onOpenRecipe = vi.fn()
    renderDetail({ batch: FOLLOWING, inputs: [], onOpenRecipe })
    const open = screen.getByTestId('batch-recipe-open')
    expect(open.textContent).toBe('From Roll for Initiative →')
    expect(open.querySelector('strong').textContent).toBe('Roll for Initiative')
    expect(open.style.minHeight).toBe('48px')
    fireEvent.click(open)
    expect(onOpenRecipe.mock.calls).toEqual([['r1', { label: 'Megatron mash', kind: 'batch', id: 'kb-rec' }]])
    // The origin is one prep's reader takes whole: the page's Back will read "← Megatron mash (batch)".
    expect(readFrom({ from: onOpenRecipe.mock.calls[0][1] })).toEqual({ label: 'Megatron mash', kind: 'batch', id: 'kb-rec' })
    // "Its lines" and "Made it as written →" follow it, as they did.
    expect(screen.getByTestId('batch-recipe-lines-toggle').textContent).toBe('Its lines')
    expect(screen.getByTestId('batch-recipe-as-written').textContent).toBe('Made it as written →')
  })

  // The prop absent: exactly the markup the row had. MUTATION: render the link without the prop -> a
  // dead tap, and the first literal reds.
  it('without onOpenRecipe it is the words it always was, and nothing to tap', () => {
    renderDetail({ batch: FOLLOWING })
    expect(screen.queryByTestId('batch-recipe-open')).toBeNull()
    // Node for node what the row rendered before the pass: a text node, the bold name, the lines toggle.
    const from = screen.getByTestId('batch-recipe-from')
    expect([...from.childNodes].map(n => (n.nodeType === Node.TEXT_NODE ? `#text:${n.textContent}` : `${n.tagName}:${n.textContent}`)))
      .toEqual(['#text:From the recipe: ', 'STRONG:Roll for Initiative', 'BUTTON:Its lines'])
    expect(from.querySelector('strong').style.color).toBe(toRgb(P.dark))
    expect(from.querySelector('button').getAttribute('data-testid')).toBe('batch-recipe-lines-toggle')
  })

  it('a batch with no recipe shows no recipe row at all (the ruled "Following a recipe?" row is the other one)', () => {
    renderDetail()
    expect(screen.queryByTestId('batch-recipe')).toBeNull()
    expect(screen.getByTestId('recipe-ref')).toBeTruthy()
  })
})

describe('"Made it as written" — a second door, in the empty What went in block', () => {
  it('is a 48px secondary button above the adder, saying what it will add', () => {
    renderDetail({ batch: FOLLOWING, inputs: [] })
    const block = within(screen.getByTestId('what-went-in')).getByTestId('what-went-in-as-written')
    const btn = screen.getByTestId('what-went-in-as-written-add')
    expect(btn.textContent).toBe(MADE_AS_WRITTEN_CTA)
    expect(MADE_AS_WRITTEN_CTA).toBe('Made it as written')
    expect(btn.style.minHeight).toBe('48px')
    expect(btn.style.backgroundColor).toBe('transparent')
    // Two pot lines; the third goes in at the end, at the bottling, and is not counted.
    expect(screen.getByTestId('what-went-in-as-written-hint').textContent).toBe("Adds the recipe's 2 lines.")
    expect(before(screen.getByTestId('what-went-in-empty'), block)).toBe(true)
    expect(before(block, screen.getByTestId('line-add-name'))).toBe(true)
    // Still one filled button on the page.
    expect(filled().map(b => b.getAttribute('data-testid'))).toEqual(['batch-detail-check'])
  })

  it('says "1 line" for one', () => {
    expect(asWrittenHint(6)).toBe("Adds the recipe's 6 lines.")
    expect(asWrittenHint(1)).toBe("Adds the recipe's 1 line.")
  })

  it('one tap writes every pot line, keyed, and re-reads', async () => {
    const { onChanged } = renderDetail({ batch: FOLLOWING, inputs: [] })
    await act(async () => { fireEvent.click(screen.getByTestId('what-went-in-as-written-add')) })
    const [method, path, body] = writes()[0]
    expect([method, path]).toEqual(['POST', '/api/kitchen-batches/kb-rec/inputs'])
    expect(body.inputs.map(l => [l.label, l.qty ?? null, l.note ?? null])).toEqual([['jalapeño', '170', null], ['cumin', null, 'pinch']])
    for (const l of body.inputs) expect(l.idempotency_key).toMatch(UUID)
    expect(onChanged).toHaveBeenCalled()
  })

  // TWO doors, ONE key set. A write whose answer was lost and is retried from the OTHER door must be a
  // replay, not a second copy of every line. MUTATION: give each door its own hook -> the keys differ.
  it('a retry from the other door sends the SAME keys, and each door says its own refusal', async () => {
    let n = 0
    fetchMock.mockImplementation((path, o = {}) => (o.method === 'POST' && ++n === 1 ? Promise.reject(new Error('502')) : Promise.resolve({ inputs: [] })))
    renderDetail({ batch: FOLLOWING, inputs: [] })
    await act(async () => { fireEvent.click(screen.getByTestId('what-went-in-as-written-add')) })
    expect(screen.getByTestId('what-went-in-as-written-error').textContent).toBe("Couldn't add the lines — try again (nothing is added twice).")
    expect(screen.queryByTestId('batch-recipe-error')).toBeNull()
    await act(async () => { fireEvent.click(screen.getByTestId('batch-recipe-as-written')) })
    expect(writes()).toHaveLength(2)
    const keys = (i) => writes()[i][2].inputs.map(l => l.idempotency_key)
    expect(keys(1)).toEqual(keys(0))
    expect(keys(0)).toHaveLength(2)
    expect(screen.queryByTestId('what-went-in-as-written-error')).toBeNull()
  })

  it('is gone once the batch has a line of its own, and absent on a batch that follows no recipe', () => {
    const { unmount } = renderDetail({ batch: FOLLOWING, inputs: [{ ...LINE, batch_id: 'kb-rec' }] })
    expect(screen.queryByTestId('what-went-in-as-written')).toBeNull()
    expect(screen.queryByTestId('batch-recipe-as-written')).toBeNull()
    unmount()
    renderDetail({ inputs: [] })
    expect(screen.queryByTestId('what-went-in-as-written')).toBeNull()
  })
})

describe('the no-recipe row, Jar & heat and the quiet actions', () => {
  // FOODSAFETY-RULING-V101: the collapsed row's words are ruled and do not change. What changed is the
  // air between its two targets — the second opens a website. MUTATION: put the gap back to 4 -> red.
  it('"Following a recipe? · tested recipes →": the ruled words, 12px between the two targets', () => {
    renderDetail()
    const open = screen.getByTestId('recipe-ref-open')
    const link = screen.getByTestId('recipe-ref-tested-link')
    expect([open.textContent, link.textContent]).toEqual(['Following a recipe?', '· tested recipes →'])
    expect(open.parentElement).toBe(link.parentElement)
    expect(open.parentElement.style.gap).toBe('12px')
    expect([open.style.minHeight, link.style.minHeight]).toEqual(['48px', '48px'])
  })

  it('Jar & heat asks "How much is in it (about)", with a 48px Save and unit chips 8px apart', () => {
    renderDetail()
    fireEvent.click(screen.getByTestId('jar-heat-summary'))
    const about = screen.getByTestId('jar-about')
    expect(screen.getByLabelText(/^How much is in it \(about\)/)).toBe(about)
    expect(document.querySelector(`label[for="${about.id}"]`).textContent).toBe('How much is in it (about)optional')
    expect(screen.getByTestId('jar-heat-panel').textContent).not.toContain('About ___ in it')
    expect(screen.getByTestId('jar-about-save').style.minHeight).toBe('48px')
    expect(screen.getByTestId('jar-about-save').parentElement).toBe(about.parentElement)      // one row: the walk wants both on screen
    expect(screen.getByRole('radiogroup', { name: 'About unit' }).style.gap).toBe('8px')
  })

  // F16: a quiet action is 48px tall on a Put-Up surface. Height only — the widths are what they were.
  // MUTATION: put any of these constants back to T.tapMinHeight -> its row reds.
  it('every quiet action on the page is 48px tall', () => {
    renderDetail({ batch: { ...FOLLOWING, kind: null, start_precision: null, started_at: null }, inputs: [] })
    const quiet = ['batch-kind-question', 'batch-set-start', 'recipe-ref-open', 'batch-recipe-lines-toggle', 'batch-recipe-as-written',
      'batch-pause', 'batch-close-open', 'batch-save-as-recipe', 'batch-remove', 'line-add-more']
    expect(quiet.map(id => `${id} ${screen.getByTestId(id).style.minHeight}`)).toEqual(quiet.map(id => `${id} 48px`))
    fireEvent.click(screen.getByTestId('batch-kind-question'))
    expect(screen.getByTestId('batch-kind-cancel').style.minHeight).toBe('48px')
    fireEvent.click(screen.getByTestId('batch-kind-other'))
    expect(screen.getByTestId('batch-kind-save').style.minHeight).toBe('48px')
  })
})

describe('words — no banned word on batch detail (V4 §3.2)', () => {
  const BANNED = /\b(safe|shelf life|shelf-stable|keeps|good|ready|done|expired|table|default|basis)\b/i

  it('INSTRUMENT: the pattern catches a banned word', () => {
    expect('How long it keeps').toMatch(BANNED)
    expect('the general table').toMatch(BANNED)
  })

  // Every block this lane touched, open: the action row, the recipe row with its lines, the empty What
  // went in block with both "Made it as written" doors and the open adder (More about it open), Jar &
  // heat, the bottom block with the Save as recipe form. The close SHEET is not in this sweep: its words
  // are batchClose.js's, frozen, and it carries its own sweeps (PutUpBatchClose.test.jsx).
  it('a going batch, every block open', () => {
    renderDetail({ batch: FOLLOWING, inputs: [], onOpenRecipe: () => {} })
    fireEvent.click(screen.getByTestId('batch-recipe-lines-toggle'))
    fireEvent.click(screen.getByTestId('line-add-more'))
    fireEvent.click(screen.getByTestId('jar-heat-summary'))
    fireEvent.click(screen.getByTestId('batch-save-as-recipe'))
    const text = view().textContent
    // GREEN CONTROLS: the sweep read the new copy, not an empty page.
    for (const said of ['Check on it', 'Put it up', 'From Roll for Initiative →', "Adds the recipe's 2 lines.", 'How much is in it (about)', 'Recipe name', 'Ferment · 9 days']) {
      expect(`sweep saw "${said}": ${text.includes(said)}`).toBe(`sweep saw "${said}": true`)
    }
    expect(text).not.toMatch(BANNED)
    for (const el of view().querySelectorAll('[placeholder], [aria-label]')) {
      expect(`${el.getAttribute('placeholder') ?? ''} ${el.getAttribute('aria-label') ?? ''}`).not.toMatch(BANNED)
    }
  })

  it('a batch with lines (the add row behind its door) and a finished one', () => {
    renderDetail()
    expect(screen.getByTestId('line-add-open').textContent).toBe('+ Add what went in')
    expect(view().textContent).not.toMatch(BANNED)
    renderDetail({ batch: CLOSED })
    const views = screen.getAllByTestId('batch-detail-view')
    expect(views[1].textContent).toContain('closed Aug 28 · 2 put-ups')
    expect(views[1].textContent).not.toMatch(BANNED)
  })
})
