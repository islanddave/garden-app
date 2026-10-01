// Put-Up UX pass R1, lane C — "Went bad" may be a part (PLAN-V3 D1, contract 9).
//
// WHAT THIS FILE HOLDS, beyond the amended pins in PantryRowSheet.test.jsx:
//   • THE KEY is the intent's: a retry of one count carries the SAME key (so a lost answer is the server's
//     replay, not a second discard), and a changed count carries a NEW one (a replay under the old key
//     would answer the first count);
//   • a refused part keeps the panel and its count, says it in plain words, and NEVER falls back to
//     all_remaining (that would discard more than was asked);
//   • the filled button names what it will do, at every count;
//   • on the Pantry: a part leaves the row LIVE (its inline action stays) and reads "N left · n went bad"
//     with Undo; all of it reads "marked gone bad" with only its Undo.
// MUTATIONS (run, see the lane report): open the panel for every put-up -> the one-tap rows in
// PantryRowSheet.test.jsx red; send count_used at the top of the stepper -> "several … a use of what is
// left" reds there; mint a key per POST -> "the SAME key" reds here; treat every went_bad as finished ->
// "a part leaves the row live" reds here.
// CI LANE: `npm test` plus the blocking TZ re-run. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'
import { pantryFetch, jarRow, apiError, PLACES } from './helpers/pantryFake.js'

installStoragePolyfill()

let fake
const { stableFetch } = vi.hoisted(() => ({ stableFetch: { fn: null } }))
vi.mock('../lib/api.js', () => {
  const f = (...a) => stableFetch.fn(...a)
  return { useApiFetch: () => ({ fetch: f, getToken: () => Promise.resolve('t') }), apiFetch: f }
})
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: vi.fn(), isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))
vi.mock('../hooks/useCropTypes.js', () => ({ useCropTypes: () => ({ cropTypes: [], loading: false }) }))
vi.mock('../context/AuthContext.jsx', async (importActual) => ({
  ...(await importActual()),
  useAuthOptional: () => ({ user: { id: 'user_dave' }, profile: null, loading: false, identity: 'signed-in' }),
}))

import PutUp from '../pages/PutUp.jsx'
import PantryRowSheet, {
  wentBadCta, WENT_BAD_PART_REFUSED_TEXT, WENT_BAD_LABEL, WENT_BAD_ASKS_LABEL, WENT_BAD_QUESTION,
} from '../components/pantry/PantryRowSheet.jsx'

const FRIDGE = PLACES[2]
const JAR = jarRow({ stock_id: 'jar-1', name: 'Megatron reaper', place: FRIDGE, group_key: 'loc-3', group_label: 'Kitchen fridge',
  method: 'hot_sauce', count_left: 4, count_made: 6 })
const ONE = jarRow({ stock_id: 'jar-one', name: 'Pesto cubes', place: FRIDGE, group_key: 'loc-3', group_label: 'Kitchen fridge',
  method: 'pesto', count_left: 1, count_made: 4 })
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function wire(opts = {}) {
  fake = pantryFetch({ rows: [JAR, ONE], ...opts })
  stableFetch.fn = fake
}
function renderSheet(row, props = {}) {
  const handlers = { onClose: vi.fn(), onUsed: vi.fn(), onChanged: vi.fn(), ...props }
  const view = render(<PantryRowSheet row={row} fetch={stableFetch.fn} {...handlers} />)
  return { ...view, ...handlers }
}
const uses = () => fake.calls('POST').filter(c => c.path === '/api/pantry/uses').map(c => c.body)
// The first POST "landed" and its answer was lost; the second is answered.
const lostOnce = () => {
  let n = 0
  return ({ body }) => {
    n += 1
    if (n === 1) throw new Error('Failed to fetch')
    return { use: { id: 'use-9', count_used: body.count_used ?? 4, fate: body.fate }, jar: { id: body.preservation_log_id, remaining_count: 1 } }
  }
}

beforeEach(() => { wire(); localStorage.clear(); sessionStorage.clear() })

describe('the words', () => {
  it('the action says which it will do, and the filled button names its count', () => {
    expect([WENT_BAD_LABEL, WENT_BAD_ASKS_LABEL, WENT_BAD_QUESTION]).toEqual(['Went bad', 'Went bad…', 'How many went bad?'])
    expect(wentBadCta(4, 4)).toBe('All 4 went bad')
    expect(wentBadCta(2, 4)).toBe('2 went bad')
    expect(wentBadCta(1, 4)).toBe('1 went bad')
    expect(WENT_BAD_PART_REFUSED_TEXT).toBe("That didn't save. Try again in a few minutes.")
  })

  it('the button follows the stepper, and Cancel returns to the action list with nothing written', () => {
    renderSheet(JAR)
    fireEvent.click(screen.getByTestId('row-went-bad'))
    const save = () => screen.getByTestId('went-bad-save').textContent
    expect(save()).toBe('All 4 went bad')
    fireEvent.click(screen.getByTestId('went-bad-minus'))
    expect(save()).toBe('3 went bad')
    fireEvent.click(screen.getByTestId('went-bad-minus'))
    fireEvent.click(screen.getByTestId('went-bad-minus'))
    expect(save()).toBe('1 went bad')
    expect(screen.getByTestId('went-bad-minus').getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(screen.getByTestId('went-bad-plus'))
    fireEvent.click(screen.getByTestId('went-bad-plus'))
    fireEvent.click(screen.getByTestId('went-bad-plus'))
    fireEvent.click(screen.getByTestId('went-bad-plus'))                   // past what is left: capped
    expect(screen.getByTestId('went-bad-count').value).toBe('4')
    expect(save()).toBe('All 4 went bad')
    fireEvent.click(within(screen.getByTestId('went-bad-panel')).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByTestId('went-bad-panel')).toBeNull()
    expect(screen.getByTestId('row-went-bad')).toBeTruthy()
    expect(uses()).toEqual([])
  })

  it('a count typed past what is left is all that is left — the button says so and the body is all_remaining', async () => {
    const { onUsed } = renderSheet(JAR)
    fireEvent.click(screen.getByTestId('row-went-bad'))
    fireEvent.change(screen.getByTestId('went-bad-count'), { target: { value: '9' } })
    expect(screen.getByTestId('went-bad-save').textContent).toBe('All 4 went bad')
    fireEvent.click(screen.getByTestId('went-bad-save'))
    await waitFor(() => expect(onUsed).toHaveBeenCalledTimes(1))
    expect(uses().map(b => ({ ...b, idempotency_key: 'K' }))).toEqual([
      { idempotency_key: 'K', preservation_log_id: 'jar-1', all_remaining: true, fate: 'discarded' }])
  })
})

describe('the key belongs to the intent (contract 9)', () => {
  it('a retry of the same count carries the SAME key — the first POST landed and its answer was lost', async () => {
    wire({ overrides: { 'POST /api/pantry/uses': lostOnce() } })
    const { onUsed, onClose } = renderSheet(JAR)
    fireEvent.click(screen.getByTestId('row-went-bad'))
    fireEvent.click(screen.getByTestId('went-bad-minus'))
    fireEvent.click(screen.getByTestId('went-bad-minus'))
    fireEvent.click(screen.getByTestId('went-bad-save'))
    expect((await screen.findByTestId('row-sheet-error')).textContent).toBe("Couldn't update — try again.")
    expect(screen.getByTestId('went-bad-count').value).toBe('2')            // the panel and its count are kept
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('went-bad-save'))
    await waitFor(() => expect(onUsed).toHaveBeenCalledTimes(1))
    const sent = uses()
    expect(sent.map(b => ({ ...b, idempotency_key: 'K' }))).toEqual([
      { idempotency_key: 'K', preservation_log_id: 'jar-1', count_used: 2, fate: 'discarded' },
      { idempotency_key: 'K', preservation_log_id: 'jar-1', count_used: 2, fate: 'discarded' }])
    expect(sent[0].idempotency_key).toMatch(UUID)
    expect(sent[1].idempotency_key).toBe(sent[0].idempotency_key)
  })

  it('a changed count mints a NEW key, and is a count — never all_remaining beside it', async () => {
    wire({ overrides: { 'POST /api/pantry/uses': lostOnce() } })
    const { onUsed } = renderSheet(JAR)
    fireEvent.click(screen.getByTestId('row-went-bad'))
    fireEvent.click(screen.getByTestId('went-bad-save'))                    // all 4
    await screen.findByTestId('row-sheet-error')
    fireEvent.click(screen.getByTestId('went-bad-minus'))                   // now 3: another intent
    fireEvent.click(screen.getByTestId('went-bad-save'))
    await waitFor(() => expect(onUsed).toHaveBeenCalledTimes(1))
    const sent = uses()
    expect(sent.map(b => ({ ...b, idempotency_key: 'K' }))).toEqual([
      { idempotency_key: 'K', preservation_log_id: 'jar-1', all_remaining: true, fate: 'discarded' },
      { idempotency_key: 'K', preservation_log_id: 'jar-1', count_used: 3, fate: 'discarded' }])
    expect(sent[1].idempotency_key).toMatch(UUID)
    expect(sent[1].idempotency_key).not.toBe(sent[0].idempotency_key)
  })

  it('the one tap keeps its key too: a second tap after a lost answer is a replay, not a second use', async () => {
    wire({ overrides: { 'POST /api/pantry/uses': lostOnce() } })
    const { onUsed } = renderSheet(ONE)
    fireEvent.click(screen.getByTestId('row-went-bad'))
    await screen.findByTestId('row-sheet-error')
    fireEvent.click(screen.getByTestId('row-went-bad'))
    await waitFor(() => expect(onUsed).toHaveBeenCalledTimes(1))
    const sent = uses()
    expect(sent).toHaveLength(2)
    expect(sent[0].idempotency_key).toMatch(UUID)
    expect(sent[1].idempotency_key).toBe(sent[0].idempotency_key)
    expect(sent.every(b => b.all_remaining === true && b.fate === 'discarded' && !('count_used' in b))).toBe(true)
  })

  it('a panel opened again is a new intent: its key is not the last panel\'s', async () => {
    wire({ overrides: { 'POST /api/pantry/uses': () => { throw new Error('Failed to fetch') } } })
    renderSheet(JAR)
    fireEvent.click(screen.getByTestId('row-went-bad'))
    fireEvent.click(screen.getByTestId('went-bad-save'))
    await screen.findByTestId('row-sheet-error')
    fireEvent.click(within(screen.getByTestId('went-bad-panel')).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByTestId('row-sheet-error')).toBeNull()              // the refusal was that attempt's
    fireEvent.click(screen.getByTestId('row-went-bad'))
    fireEvent.click(screen.getByTestId('went-bad-save'))
    await waitFor(() => expect(uses()).toHaveLength(2))
    expect(uses()[1].idempotency_key).not.toBe(uses()[0].idempotency_key)
  })
})

describe('a refused part', () => {
  // A server older than this client refuses ANY count for Went bad, in a sentence written for a developer.
  const OLD_SERVER = 'Went bad is all that is left — send all_remaining: true'

  it('keeps the panel open with its count, says it plainly, and never falls back to all_remaining', async () => {
    wire({ overrides: { 'POST /api/pantry/uses': () => { throw apiError(400, { error: OLD_SERVER }) } } })
    const { onUsed, onClose } = renderSheet(JAR)
    fireEvent.click(screen.getByTestId('row-went-bad'))
    fireEvent.click(screen.getByTestId('went-bad-minus'))
    fireEvent.click(screen.getByTestId('went-bad-save'))
    const err = await screen.findByTestId('row-sheet-error')
    expect(err.textContent).toBe("That didn't save. Try again in a few minutes.")
    expect(err.textContent).not.toContain('all_remaining')
    expect(screen.getByTestId('went-bad-panel')).toBeTruthy()
    expect(screen.getByTestId('went-bad-count').value).toBe('3')
    expect(screen.getByTestId('went-bad-save').textContent).toBe('3 went bad')
    expect(onUsed).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    // ONE request, and it was the count: nothing was sent that discards more than was asked.
    expect(uses().map(b => ({ ...b, idempotency_key: 'K' }))).toEqual([
      { idempotency_key: 'K', preservation_log_id: 'jar-1', count_used: 3, fate: 'discarded' }])
  })

  it('a refusal the server CODED keeps the server\'s reason (the other phone used some)', async () => {
    wire({ overrides: { 'POST /api/pantry/uses': () => { throw apiError(409, { error: 'Only 1 left in that one.', code: 'only_n_left', n: 1 }) } } })
    renderSheet(JAR)
    fireEvent.click(screen.getByTestId('row-went-bad'))
    fireEvent.click(screen.getByTestId('went-bad-minus'))
    fireEvent.click(screen.getByTestId('went-bad-save'))
    expect((await screen.findByTestId('row-sheet-error')).textContent).toBe('Only 1 left — nothing was changed.')
    expect(screen.getByTestId('went-bad-count').value).toBe('3')
    expect(uses()).toHaveLength(1)
  })

  it('a failure that is not a refusal (the server fell over) keeps the usual line', async () => {
    wire({ overrides: { 'POST /api/pantry/uses': () => { throw apiError(500, { error: 'boom' }) } } })
    renderSheet(JAR)
    fireEvent.click(screen.getByTestId('row-went-bad'))
    fireEvent.click(screen.getByTestId('went-bad-minus'))
    fireEvent.click(screen.getByTestId('went-bad-save'))
    expect((await screen.findByTestId('row-sheet-error')).textContent).toBe("Couldn't update — try again.")
    expect(screen.getByTestId('went-bad-panel')).toBeTruthy()
  })

  it('all that is left, refused uncoded, still says the server\'s own sentence (the plain line is the part\'s alone)', async () => {
    wire({ overrides: { 'POST /api/pantry/uses': () => { throw apiError(400, { error: 'idempotency_key must be a uuid' }) } } })
    renderSheet(JAR)
    fireEvent.click(screen.getByTestId('row-went-bad'))
    fireEvent.click(screen.getByTestId('went-bad-save'))
    expect((await screen.findByTestId('row-sheet-error')).textContent).toBe('idempotency_key must be a uuid')
  })
})

describe('on the Pantry, in place, for the person who acted', () => {
  // The fake answers a use (judged by the Lambda's own validateUse) but keeps listing the row as it was. A
  // server REMEMBERS: once a use is answered, the list it is re-read from carries what is left, and a row
  // with nothing left is gone from it.
  function aServerThatRemembers() {
    const base = fake
    stableFetch.fn = async (path, options = {}) => {
      const r = await base(path, options)
      if (path === '/api/pantry/uses' && options.method === 'POST') {
        const left = r.jar.remaining_count
        base.state.rows = left > 0
          ? base.state.rows.map(x => (x.stock_id === r.jar.id ? { ...x, count_left: left } : x))
          : base.state.rows.filter(x => x.stock_id !== r.jar.id)
      }
      return r
    }
  }
  const renderPantry = () => {
    aServerThatRemembers()
    return render(<MemoryRouter initialEntries={['/put-up?view=pantry']}><PutUp /></MemoryRouter>)
  }
  const KEY = 'put_up:jar-1'

  it('a part leaves the row LIVE: "2 left · 2 went bad" with Undo, and Used one is still there', async () => {
    renderPantry()
    fireEvent.click(await screen.findByTestId(`pantry-row-open-${KEY}`))
    fireEvent.click(await screen.findByTestId('row-went-bad'))
    fireEvent.click(screen.getByTestId('went-bad-minus'))
    fireEvent.click(screen.getByTestId('went-bad-minus'))
    fireEvent.click(screen.getByTestId('went-bad-save'))
    const done = await screen.findByTestId(`pantry-row-done-${KEY}`)
    expect(done.textContent).toBe('2 left · 2 went bad' + 'Undo')
    expect(done.getAttribute('role')).toBe('status')
    await waitFor(() => expect(screen.queryByTestId('row-sheet')).toBeNull())
    expect(screen.getByRole('button', { name: 'Used one — Megatron reaper' })).toBeTruthy()
    expect(uses().map(b => ({ ...b, idempotency_key: 'K' }))).toEqual([
      { idempotency_key: 'K', preservation_log_id: 'jar-1', count_used: 2, fate: 'discarded' }])
    // Undo is that use's own.
    fireEvent.click(within(done).getByRole('button', { name: 'Undo — Megatron reaper' }))
    await waitFor(() => expect(fake.calls('POST').filter(c => /\/undo$/.test(c.path))).toHaveLength(1))
    expect(fake.calls('POST').find(c => /\/undo$/.test(c.path)).path).toMatch(/^\/api\/pantry\/uses\/use-\d+\/undo$/)
  })

  it('a part that leaves ONE turns the row\'s action into Used it up', async () => {
    renderPantry()
    fireEvent.click(await screen.findByTestId(`pantry-row-open-${KEY}`))
    fireEvent.click(await screen.findByTestId('row-went-bad'))
    fireEvent.click(screen.getByTestId('went-bad-minus'))
    fireEvent.click(screen.getByTestId('went-bad-save'))
    const done = await screen.findByTestId(`pantry-row-done-${KEY}`)
    expect(done.textContent).toBe('1 left · 3 went bad' + 'Undo')
    expect(await screen.findByRole('button', { name: 'Used it up — Megatron reaper' })).toBeTruthy()
  })

  it('all of it is today\'s rule: "marked gone bad", only its Undo, the row kept on screen for it', async () => {
    renderPantry()
    fireEvent.click(await screen.findByTestId(`pantry-row-open-${KEY}`))
    fireEvent.click(await screen.findByTestId('row-went-bad'))
    fireEvent.click(screen.getByTestId('went-bad-save'))
    const done = await screen.findByTestId(`pantry-row-done-${KEY}`)
    expect(done.textContent).toBe('marked gone bad' + 'Undo')
    await waitFor(() => expect(fake.state.rows.some(r => r.stock_id === 'jar-1')).toBe(false))   // the server stopped listing it
    await waitFor(() => expect(screen.queryByTestId(`pantry-row-action-${KEY}`)).toBeNull())
    expect(within(screen.getByTestId(`pantry-row-done-${KEY}`)).getByRole('button', { name: 'Undo — Megatron reaper' })).toBeTruthy()
  })

  it('one left: the one tap is all of it, and the row reads "marked gone bad"', async () => {
    renderPantry()
    fireEvent.click(await screen.findByTestId('pantry-row-open-put_up:jar-one'))
    fireEvent.click(await screen.findByTestId('row-went-bad'))
    const done = await screen.findByTestId('pantry-row-done-put_up:jar-one')
    expect(done.textContent).toBe('marked gone bad' + 'Undo')
    expect(screen.queryByTestId('pantry-row-action-put_up:jar-one')).toBeNull()
  })
})
