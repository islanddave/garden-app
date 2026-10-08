// BUG-BATCHREMOVEDEADEND-001 — a put-up PICKED for a batch (the close sheet's "Which put-ups came out of
// it?") gets a door on batch detail: "Take it off this batch", answered by "Taken off · Undo". Before
// this a batch closed that way could not be removed: Remove this batch was refused with "Undo its put-ups
// first" and there was no put-up to undo. Each assertion names the mutation that reds it.
// CI LANE: `npm test` plus the blocking TZ re-run. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  apiFetch: (...args) => fetchMock(...args),
}))
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => ({ user: { id: 'user_dave' } }) }))

import BatchDetailView, {
  TAKE_OFF_CTA, TAKEN_OFF_TEXT, NOT_ON_BATCH_TEXT, CANT_PUT_BACK_TEXT, reconcileTakenOff,
} from '../components/putup/BatchDetailView.jsx'
import { HAS_JARS_TEXT, HAS_PICKED_TEXT, HAS_JARS_AND_PICKED_TEXT, hasJarsText } from '../lib/putUpErrors.js'

const NOW = new Date('2026-10-20T09:00:00').getTime()
const local = (s) => new Date(s).toISOString()
// Closed through the jar picker: outcome put_up, a finished row, and NO put_up row.
const BATCH = {
  id: 'kb-1', user_id: 'user_dave', label: 'Megatron mash', kind: 'ferment', kind_other: null,
  started_at: local('2026-10-01T09:00:00'), start_precision: 'day', first_recorded_at: local('2026-10-01T09:00:00'),
  suspended_at: null, closed_at: local('2026-10-12T10:00:00'), outcome: 'put_up', outcome_note: null,
  current_stage_kind: 'finished', current_stage_entered_at: local('2026-10-12T10:00:00'), input_count: '0', output_count: '1',
}
const ST = (o) => ({ batch_id: 'kb-1', label: null, amount: null, amount_unit: null, cue_observed: null, note: null,
  ph_reading: null, ph_read_at: null, voids_id: null, entered_precision: 'day', ...o })
const STAGES = [
  ST({ id: 'ksl-fin', stage_kind: 'finished', entered_at: local('2026-10-12T10:00:00') }),
  ST({ id: 'ksl-start', stage_kind: 'started', entered_at: local('2026-10-01T09:00:00') }),
]
const PICKED = { id: 'pl-old', batch_id: 'kb-1', put_up_stage_id: null, preserved_at: '2026-09-02', package_count: 1,
  quantity_value: '2.5', quantity_unit: 'qt' }
const PICKED_TEXT = '2.5 qt · Sep 2'
const SITTING = ST({ id: 'ksl-put', stage_kind: 'put_up', entered_at: local('2026-10-11T09:00:00'), has_own_jars: true })
const OWN = { id: 'pl-own', batch_id: 'kb-1', put_up_stage_id: 'ksl-put', label: 'Megatron plain', container_label: '8 oz woozy',
  preserved_at: '2026-10-11', preserved_at_precision: 'day', package_count: 2, quantity_value: null, quantity_unit: null }

const view = (o = {}) => (
  <BatchDetailView batch={{ ...BATCH, ...o.batch }} inputs={[]} stages={o.stages ?? STAGES} outputs={o.outputs ?? [PICKED]}
    loading={false} error={false} nowMs={NOW} onChanged={o.onChanged ?? vi.fn()} onRemoved={o.onRemoved} />
)
const calls = (re, method) => fetchMock.mock.calls.filter(([p, opt]) => re.test(p) && (opt?.method ?? 'GET') === method)
const refuse = (status, body) => () => Promise.reject(Object.assign(new Error(String(status)), { status, body }))
const tap = async (testId) => { await act(async () => { fireEvent.click(screen.getByTestId(testId)) }) }

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation(() => Promise.resolve({ ok: true }))
  localStorage.clear()
})

describe('a picked put-up has a door; a sitting\'s jar keeps its own', () => {
  // `pl-stray` carries a sitting's id that is not in the live log, so it is listed apart like a picked one.
  // MUTATION: drop the !put_up_stage_id guard -> the count reds (a sitting's jar would be offered a
  // route the server refuses with put_up_jar).
  it('offers Take it off this batch on the picked row only', () => {
    render(view({ stages: [SITTING, ...STAGES], outputs: [OWN, { ...OWN, id: 'pl-stray', put_up_stage_id: 'ksl-gone' }, PICKED] }))
    expect(screen.getAllByTestId('batch-detail-output').map(e => e.getAttribute('data-jar-id'))).toEqual(['pl-own', 'pl-stray', 'pl-old'])
    const buttons = screen.getAllByTestId('batch-detail-output-take-off')
    expect(buttons.map(b => b.textContent)).toEqual([TAKE_OFF_CTA])
    expect(buttons[0].closest('[data-testid="batch-detail-output"]').getAttribute('data-jar-id')).toBe('pl-old')
    expect(TAKE_OFF_CTA).toBe('Take it off this batch')
  })

  // MUTATION: call the remove-jar route, or DELETE the batch -> the one literal reds.
  it('one tap unlinks through the batch\'s outputs route — no confirm, nothing else written', async () => {
    const onChanged = vi.fn()
    render(view({ onChanged }))
    await tap('batch-detail-output-take-off')
    expect(fetchMock.mock.calls.map(([p, opt]) => [opt?.method, p])).toEqual([['DELETE', '/api/kitchen-batches/kb-1/outputs/pl-old']])
    expect(onChanged).toHaveBeenCalledTimes(1)
  })
})

describe('Taken off · Undo, held until navigation', () => {
  // MUTATION: keep the row in component-local state only -> the re-read without the jar unmounts it and
  // the empty line shows instead (both literals red).
  it('the re-read no longer carries the put-up; its row stays, struck, with the words and one Undo', async () => {
    const { rerender } = render(view())
    await tap('batch-detail-output-take-off')
    rerender(view({ outputs: [] }))
    const row = screen.getByTestId('batch-detail-output-taken-off')
    expect(row.querySelector('s').textContent).toBe(PICKED_TEXT)
    expect(row.querySelector('[role="status"]').textContent).toBe(`${TAKEN_OFF_TEXT}Undo`)
    expect(TAKEN_OFF_TEXT).toBe('Taken off — it’s still in the Pantry.')
    expect(screen.queryByTestId('batch-detail-outputs-empty')).toBeNull()
    expect(screen.queryByTestId('batch-detail-output-take-off')).toBeNull()
  })

  // MUTATION: list the taken-off rows after the picked ones -> the order reds (the row tapped drops to the
  // end of the list and the next one slides up under the thumb).
  it('answers where it was tapped: the taken-off row keeps its place in the list', async () => {
    const newer = { ...PICKED, id: 'pl-newer', preserved_at: '2026-09-20' }
    const { rerender } = render(view({ outputs: [newer, PICKED] }))
    const order = () => [...screen.getByTestId('batch-detail-outputs-list').children].map(li => `${li.getAttribute('data-testid')}:${li.getAttribute('data-jar-id')}`)
    expect(order()).toEqual(['batch-detail-output:pl-newer', 'batch-detail-output:pl-old'])
    await act(async () => { fireEvent.click(screen.getAllByTestId('batch-detail-output-take-off')[0]) })
    rerender(view({ outputs: [PICKED] }))
    expect(order()).toEqual(['batch-detail-output-taken-off:pl-newer', 'batch-detail-output:pl-old'])
  })

  // The re-read may fail or lag: the put-up is still in the outputs handed down. It must not show twice.
  it('before the re-read lands the put-up shows once, as taken off', async () => {
    render(view())
    await tap('batch-detail-output-take-off')
    expect(screen.queryAllByTestId('batch-detail-output')).toHaveLength(0)
    expect(screen.getAllByTestId('batch-detail-output-taken-off')).toHaveLength(1)
  })

  // MUTATION: post the close route's key (output_preservation_log_ids) -> the body literal reds (the link
  // route answers 400 to it).
  it('Undo links it again through POST /outputs, and the row is the put-up again once the re-read has it', async () => {
    const onChanged = vi.fn()
    fetchMock.mockImplementation((p, opt) => Promise.resolve(opt?.method === 'POST' ? { linked: 1, requested: 1 } : { ok: true }))
    const { rerender } = render(view({ onChanged }))
    await tap('batch-detail-output-take-off')
    rerender(view({ outputs: [], onChanged }))
    await tap('batch-detail-output-put-back')
    expect(calls(/\/outputs$/, 'POST').map(c => [c[0], JSON.parse(c[1].body)])).toEqual([
      ['/api/kitchen-batches/kb-1/outputs', { preservation_log_ids: ['pl-old'] }],
    ])
    expect(onChanged).toHaveBeenCalledTimes(2)
    // Its re-read not here yet: the put-up's words, nothing to tap, no "Taken off".
    expect(screen.queryByTestId('batch-detail-output-taken-off')).toBeNull()
    expect(screen.getAllByTestId('batch-detail-output-text').map(e => e.textContent)).toEqual([PICKED_TEXT])
    expect(screen.queryByTestId('batch-detail-output-take-off')).toBeNull()
    rerender(view({ outputs: [PICKED], onChanged }))
    expect(screen.getAllByTestId('batch-detail-output-take-off')).toHaveLength(1)
    // And it can be taken off again.
    await tap('batch-detail-output-take-off')
    expect(screen.getAllByTestId('batch-detail-output-taken-off')).toHaveLength(1)
  })

  // The link route SKIPS a put-up it cannot link and answers 200 with the count.
  // MUTATION: ignore `linked` -> the row vanishes and the literal reds.
  it('an Undo the server could not make says so, re-reads, and keeps the row while the read still lacks it', async () => {
    const onChanged = vi.fn()
    fetchMock.mockImplementation((p, opt) => Promise.resolve(opt?.method === 'POST' ? { linked: 0, requested: 1 } : { ok: true }))
    const { rerender } = render(view({ onChanged }))
    await tap('batch-detail-output-take-off')
    rerender(view({ outputs: [], onChanged }))
    await tap('batch-detail-output-put-back')
    expect(screen.getByTestId('batch-detail-output-error').textContent).toBe(CANT_PUT_BACK_TEXT)
    expect(onChanged).toHaveBeenCalledTimes(2)
    rerender(view({ outputs: [], onChanged }))
    expect(screen.getAllByTestId('batch-detail-output-taken-off')).toHaveLength(1)
  })

  // MUTATION: hold the rows without their batch -> the taken-off row follows the person to the next batch.
  it('belongs to its batch: another batch on the same surface shows none of it', async () => {
    const { rerender } = render(view())
    await tap('batch-detail-output-take-off')
    rerender(view({ batch: { id: 'kb-2', label: 'Another' }, outputs: [] }))
    expect(screen.queryByTestId('batch-detail-output-taken-off')).toBeNull()
    expect(screen.getByTestId('batch-detail-outputs-empty')).toBeTruthy()
  })
})

// A held row is this surface's memory of a tap, and the read is the truth. Once a read has confirmed the
// take-off, a later read that carries the put-up again wins (review I-1, M-1, M-2).
describe('a held row gives way to the read', () => {
  // THE LOST ANSWER: Undo's POST lands, its answer does not; the retry is told linked: 0 because the put-up
  // is already on the batch. MUTATION: keep a confirmed row over a read that carries the put-up -> the row
  // stays "Taken off", its door is gone, and Remove says "Undo its put-ups first" (all four literals red).
  it('an Undo that landed without its answer: the next read puts the put-up back with its door, and Remove names it', async () => {
    const onChanged = vi.fn()
    let posts = 0
    fetchMock.mockImplementation((p, opt) => {
      if (opt?.method === 'POST') { posts += 1; return posts === 1 ? refuse(0, undefined)() : Promise.resolve({ linked: 0, requested: 1 }) }
      if (opt?.method === 'DELETE' && !/\/outputs\//.test(p)) return refuse(409, { code: 'has_jars', error: 'x' })()
      return Promise.resolve({ ok: true })
    })
    const { rerender } = render(view({ onChanged }))
    await tap('batch-detail-output-take-off')
    rerender(view({ outputs: [], onChanged }))                    // the read confirms the take-off
    await tap('batch-detail-output-put-back')                     // lands on the server; the answer is lost
    expect(screen.getByTestId('batch-detail-output-error').textContent).toBe("Couldn't put it back — try again.")
    await tap('batch-detail-output-put-back')                     // linked: 0 — it is already on the batch
    expect(onChanged).toHaveBeenCalledTimes(2)
    rerender(view({ outputs: [PICKED], onChanged }))              // the re-read carries it
    expect(screen.queryByTestId('batch-detail-output-taken-off')).toBeNull()
    expect(screen.queryByTestId('batch-detail-output-error')).toBeNull()
    expect(screen.getAllByTestId('batch-detail-output-take-off')).toHaveLength(1)
    fireEvent.click(screen.getByTestId('batch-remove'))
    await tap('batch-remove-yes')
    await waitFor(() => expect(screen.getByTestId('batch-remove-error').textContent).toBe(HAS_PICKED_TEXT))
  })

  // MUTATION: count only the read's rows -> "Undo its put-ups first" for a batch whose one jar was picked.
  it('a put-up put back still holds Remove before its re-read lands', async () => {
    fetchMock.mockImplementation((p, opt) => {
      if (opt?.method === 'POST') return Promise.resolve({ linked: 1, requested: 1 })
      if (opt?.method === 'DELETE' && !/\/outputs\//.test(p)) return refuse(409, { code: 'has_jars', error: 'x' })()
      return Promise.resolve({ ok: true })
    })
    const { rerender } = render(view())
    await tap('batch-detail-output-take-off')
    rerender(view({ outputs: [] }))
    await tap('batch-detail-output-put-back')
    fireEvent.click(screen.getByTestId('batch-remove'))
    await tap('batch-remove-yes')
    await waitFor(() => expect(screen.getByTestId('batch-remove-error').textContent).toBe(HAS_PICKED_TEXT))
  })

  // MUTATION: never drop a `back` row -> a put-up the other person then takes off comes back as a row with
  // nothing to tap, on a batch it is no longer on.
  it('a put-up put back, then taken off by someone else: no row of ours is left behind', async () => {
    fetchMock.mockImplementation((p, opt) => Promise.resolve(opt?.method === 'POST' ? { linked: 1, requested: 1 } : { ok: true }))
    const { rerender } = render(view())
    await tap('batch-detail-output-take-off')
    rerender(view({ outputs: [] }))
    await tap('batch-detail-output-put-back')
    rerender(view({ outputs: [PICKED] }))
    rerender(view({ outputs: [] }))
    expect(screen.queryAllByTestId('batch-detail-output')).toHaveLength(0)
    expect(screen.getByTestId('batch-detail-outputs-empty')).toBeTruthy()
  })

  it('reconcileTakenOff: marks, drops, leaves other batches alone, and hands back the same list when nothing moved', () => {
    const e = (o) => ({ batchId: 'kb-1', jar: { id: 'pl-old' }, back: false, ...o })
    const has = new Set(['pl-old']); const lacks = new Set()
    const fresh = [e()]
    expect(reconcileTakenOff(fresh, 'kb-1', has)).toBe(fresh)                       // re-read in flight: masks
    expect(reconcileTakenOff(fresh, 'kb-1', lacks)).toEqual([e({ gone: true })])    // the read confirms it
    expect(reconcileTakenOff([e({ gone: true })], 'kb-1', has)).toEqual([])         // linked again: the read wins
    const back = [e({ back: true })]
    expect(reconcileTakenOff(back, 'kb-1', lacks)).toBe(back)                       // its re-read not here yet
    expect(reconcileTakenOff(back, 'kb-1', has)).toEqual([])
    const other = [e({ batchId: 'kb-2', gone: true })]
    expect(reconcileTakenOff(other, 'kb-1', has)).toBe(other)
  })
})

describe('a take-off the server refuses', () => {
  it('404 (already off, or the put-up was removed): says so and re-reads; the row is not marked taken off', async () => {
    const onChanged = vi.fn()
    fetchMock.mockImplementation(refuse(404, { error: 'Not found' }))
    render(view({ onChanged }))
    await tap('batch-detail-output-take-off')
    await waitFor(() => expect(screen.getByTestId('batch-detail-output-error').textContent).toBe(NOT_ON_BATCH_TEXT))
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('batch-detail-output-taken-off')).toBeNull()
  })

  it('a coded refusal reads in the server\'s words, and the control is live again', async () => {
    fetchMock.mockImplementation(refuse(409, { code: 'put_up_jar', error: 'This jar came from a put-up. Undo that put-up instead.' }))
    render(view())
    await tap('batch-detail-output-take-off')
    await waitFor(() => expect(screen.getByTestId('batch-detail-output-error').textContent).toBe('This jar came from a put-up. Undo that put-up instead.'))
    expect(screen.getByTestId('batch-detail-output-take-off').disabled).toBe(false)
  })
})

describe('Remove this batch names the door for the jars the batch has', () => {
  const refusedRemove = async (o) => {
    fetchMock.mockImplementation(refuse(409, { code: 'has_jars', error: 'This batch still has jars. Undo its put-ups (or unlink the jars) first.' }))
    render(view(o))
    fireEvent.click(screen.getByTestId('batch-remove'))
    await tap('batch-remove-yes')
    await waitFor(() => expect(screen.getByTestId('batch-remove-error')).toBeTruthy())
    return screen.getByTestId('batch-remove-error').textContent
  }

  // THE DEAD END. MUTATION: answer has_jars with the fixed sentence -> this reds on "Undo its put-ups
  // first", said to a batch with no put-up to undo.
  it('picked put-ups only: take them off under What came out', async () => {
    expect(await refusedRemove()).toBe(HAS_PICKED_TEXT)
    expect(HAS_PICKED_TEXT).toBe('This batch still has put-ups picked for it. Take them off under What came out first — nothing was changed.')
  })

  it('a sitting\'s jars and a picked one: both doors', async () => {
    expect(await refusedRemove({ stages: [SITTING, ...STAGES], outputs: [OWN, PICKED] })).toBe(HAS_JARS_AND_PICKED_TEXT)
  })

  // A pieced batch (How it was made →) lets go of its picked put-ups on Remove; only a later sitting's jars
  // hold it. MUTATION: count picked put-ups on a pieced batch -> this reds with the both-doors sentence.
  it('a pieced batch held by a later sitting: Undo its put-ups, and nothing about the picked ones', async () => {
    const pieced = ST({ id: 'ksl-hw', stage_kind: 'put_up', entered_at: local('2026-09-02T00:00:00'), has_own_jars: false })
    expect(await refusedRemove({ stages: [SITTING, pieced, ...STAGES], outputs: [OWN, PICKED] })).toBe(HAS_JARS_TEXT)
  })

  it('a taken-off put-up no longer counts, even before the re-read', async () => {
    fetchMock.mockImplementation((p, opt) => (/\/outputs\//.test(p) ? Promise.resolve({ ok: true })
      : refuse(409, { code: 'has_jars', error: 'x' })()))
    render(view({ stages: [SITTING, ...STAGES], outputs: [OWN, PICKED] }))
    await tap('batch-detail-output-take-off')
    fireEvent.click(screen.getByTestId('batch-remove'))
    await tap('batch-remove-yes')
    await waitFor(() => expect(screen.getByTestId('batch-remove-error').textContent).toBe(HAS_JARS_TEXT))
  })

  it('hasJarsText: told nothing, the shipped sentence', () => {
    expect(hasJarsText()).toBe(HAS_JARS_TEXT)
    expect(hasJarsText({ sitting: 2, picked: 0 })).toBe(HAS_JARS_TEXT)
    expect(hasJarsText({ sitting: 0, picked: 1 })).toBe(HAS_PICKED_TEXT)
    expect(hasJarsText({ sitting: 1, picked: 1 })).toBe(HAS_JARS_AND_PICKED_TEXT)
  })
})
