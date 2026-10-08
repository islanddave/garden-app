// BUG-PUTUPREPLAYREST-001 — Put it up, POST /api/kitchen-batches/:id/put-up. The rule is kitchen/idempotencyKey.js.
//
// Before this, a put-up whose answer was lost, a change (a count, a row, the other footer button), and a
// second tap came back `replayed: true` with the sitting the FIRST tap made — and the sheet closed and told
// the host the EDITED rows, built from the form, with the `finish` of the button tapped last.
//   • a sitting has no update route: once another body has gone out under the key, a replay writes nothing
//     and is REFUSED in words — the sheet stays open, the host is not told a put-up, the batch behind re-reads;
//   • both footer buttons share the key, and `finish` is part of what went out: a replay answered for one is
//     never reported as the other;
//   • that refusal ends the STORED draft (the first tap landed): the sheet opened next is a clean one, with a
//     new key, so "put up the rest later" still works on that batch;
//   • an untouched retry is the same body: it completes, and the completion says what the SERVER answered;
//   • NEVER a second sitting from one sheet's retries: one key across every POST.
// CI lane: `npm test` plus the TZ re-run. No jest-dom (L-182).
import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  apiFetch: (...args) => fetchMock(...args),
}))
const auth = { user: { id: 'user_dave' } }
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => auth }))

import PutItUpSheet, { isPutItUpDraft, PUT_UP_REPLAY_NOT_ON_IT, PUT_UP_REPLAY_GONE } from '../components/putup/PutItUpSheet.jsx'
import { completionStub, sittingRows, newRow } from '../components/putup/putItUp.js'
import { clearReloadBlocks } from '../lib/reloadGate.js'

const NOW = new Date('2026-09-29T15:00:00').getTime()
const local = (s) => new Date(s).toISOString()
const BANNED = /\b(safe|shelf life|shelf-stable|keeps|good|ready|done|expired|table|default|basis)\b/i
const MASH = {
  id: 'kb-mash', label: 'Megatron mash', kind: 'ferment', user_id: 'user_dave', kind_other: null,
  started_at: local('2026-09-20T09:00:00'), start_precision: 'day', first_recorded_at: local('2026-09-20T09:00:00'),
  closed_at: null, current_stage_kind: 'tended', current_stage_entered_at: local('2026-09-27T09:00:00'),
}
const PLACES = [
  { id: 'loc-fridge', user_id: 'user_dave', label: 'Fridge', kind: 'fridge' },
  { id: 'loc-cf1', user_id: 'user_dave', label: 'Chest Freezer 1', kind: 'deep_freezer' },
]
const DRAFT_KEY = 'garden:putup-draft:v1:user_dave:putup:kb-mash'
const GENERIC = "Couldn't put it up — try again. Everything you entered is still here."
const lost = () => Promise.reject(new TypeError('Failed to fetch'))   // it may have landed; its answer did not come back

// The sitting a put-up makes, as the route answers it (kitchenRoutes.js readSitting): one jar per row — its
// label the row's name or the batch's, its container, how many, where it went.
function sittingOf(body) {
  return {
    stage: { id: 'ksl-1', batch_id: MASH.id, stage_kind: 'put_up' },
    jars: body.rows.map((r, i) => {
      const place = PLACES.find(p => p.id === r.place?.id) ?? { label: r.place?.label ?? null, kind: r.place?.kind ?? null }
      return {
        id: `pl-${i + 1}`, label: r.name ?? MASH.label, container_label: r.container_label ?? null, package_count: r.count,
        storage_label: place.label, storage_kind: place.kind, preserved_at: body.when.date, preserved_at_precision: body.when.precision,
        use_by_target: '2027-03-29', use_by_basis: 'table',
      }
    }),
    inputs: [],
    batch: { ...MASH, closed_at: body.finish ? local('2026-09-29T15:00:00') : null },
  }
}
// A batch with at most one sitting under the sheet's key. The first POST that lands does so with its answer
// lost (`lands` — the ones before it never reached the server); every POST after is answered with that
// sitting, replayed. `onPost(n, body)` may answer for the route instead.
function sittingTable({ lands = 1, onPost = null } = {}) {
  const state = { sitting: null, finish: null, posts: 0 }
  fetchMock.mockImplementation((path, o = {}) => {
    if (path === '/api/storage-locations') return Promise.resolve(PLACES)
    if (/\/put-up$/.test(path) && o.method === 'POST') {
      state.posts += 1
      const body = JSON.parse(o.body)
      const forced = onPost?.(state.posts, body)
      if (forced !== undefined) return forced
      if (!state.sitting) {
        if (state.posts < lands) return lost()
        state.sitting = sittingOf(body); state.finish = body.finish
        return lost()
      }
      return Promise.resolve({ replayed: true, ...state.sitting })
    }
    return Promise.resolve(null)
  })
  return state
}

const putUps = () => fetchMock.mock.calls.filter(([p, o]) => /\/put-up$/.test(p) && o?.method === 'POST')
const bodies = () => putUps().map(([, o]) => JSON.parse(o.body))
const keys = () => bodies().map(b => b.idempotency_key)
// Every write that is not the put-up itself.
const otherWrites = () => fetchMock.mock.calls.filter(([p, o]) => (o?.method ?? 'GET') !== 'GET' && !/\/put-up$/.test(p)).map(([p, o]) => [o.method, p])

function Host({ onDone, onChanged }) {
  const [open, setOpen] = useState(true)
  return (
    <>
      <PutItUpSheet open={open} batch={MASH} now={NOW} onClose={() => setOpen(false)} onDone={onDone} onChanged={onChanged} />
      {!open && <button type="button" onClick={() => setOpen(true)}>reopen</button>}
    </>
  )
}
async function open() {
  const handlers = { onDone: vi.fn(), onChanged: vi.fn() }
  const view = render(<Host {...handlers} />)
  await waitFor(() => expect(screen.getByTestId('putup-row-0-place-id:loc-fridge')).toBeTruthy())
  return { ...view, ...handlers }
}
const sheet = () => screen.queryByTestId('putup-sheet')
const tap = (id) => act(async () => { fireEvent.click(screen.getByTestId(id)) })
const type = (id, value) => fireEvent.change(screen.getByTestId(id), { target: { value } })
async function fillMinimum() {
  await tap('putup-method-hot_sauce')
  await tap('putup-row-0-place-id:loc-fridge')
}
const errorText = () => screen.queryByTestId('putup-error')?.textContent ?? null
const said = (text) => waitFor(() => expect(errorText()).toBe(text))
const stored = () => { const raw = localStorage.getItem(DRAFT_KEY); return raw ? JSON.parse(raw) : null }
function watchScrolls() {
  const on = []
  Element.prototype.scrollIntoView = function scrollIntoView() { on.push(this) }
  return on
}
// The nth put-up has been answered and the sheet is still.
const answered = async (nth) => {
  await waitFor(() => expect(putUps()).toHaveLength(nth))
  await waitFor(() => expect(screen.queryByTestId('putup-later')?.disabled ?? false).toBe(false))
}

beforeEach(() => {
  fetchMock.mockReset()
  localStorage.clear()
  clearReloadBlocks()
  auth.user = { id: 'user_dave' }
  window.history.replaceState({ __floor: 1 }, '')
})
afterEach(() => { clearReloadBlocks(); delete Element.prototype.scrollIntoView })

describe('the words, and the stub from what the server answered', () => {
  it('the refusal says what is certain — already put up, this tap changed nothing — and no banned word', () => {
    expect(PUT_UP_REPLAY_NOT_ON_IT).toBe('This is already put up — an earlier tap went through. This one changed nothing on it. Close this and open the batch to see what was put up.')
    expect(PUT_UP_REPLAY_NOT_ON_IT).not.toMatch(BANNED)
    // It does not know which tap landed, so it never says the change is missing.
    expect(PUT_UP_REPLAY_NOT_ON_IT).not.toMatch(/your change is not|is not on it|was lost/i)
  })
  it('sittingRows: the jars as the rows they were — so the stub says the server\'s names, containers, counts and places', () => {
    const jars = [
      { label: 'Megatron mash', container_label: '5 oz woozy', package_count: 4, storage_label: 'Fridge' },
      { label: 'Megatron reaper', container_label: '8 oz woozy', package_count: 2, storage_label: 'Chest Freezer 1' },
      { label: 'Megatron mash', container_label: '5 oz woozy', package_count: 1, storage_label: 'Fridge' },
      { label: 'Megatron mash', container_label: null, package_count: 3, storage_label: null },
    ]
    expect(completionStub({ batch: { label: 'Megatron mash' }, rows: sittingRows(jars), jars: [], now: new Date(NOW) }))
      .toBe('Megatron mash — put up · 5 × 5 oz woozy · Fridge · Megatron reaper: 2 × 8 oz woozy · Chest Freezer 1 · 3 containers')
    expect(sittingRows([])).toEqual([])
    expect(sittingRows(null)).toEqual([])
    // A replay with NO jars is not a sitting to make a stub of (QA I-4): the sheet refuses it — the cases below.
  })
  it('QA I-4 — a put-up that is gone says so: not in the Pantry any more, this tap changed nothing, how to enter it again — and never "already put up"', () => {
    expect(PUT_UP_REPLAY_GONE).toBe('That put-up is not in the Pantry any more — it was undone or removed since. This tap changed nothing. To enter it again, close this and open Put it up from the batch.')
    expect(PUT_UP_REPLAY_GONE).not.toMatch(BANNED)
    expect(PUT_UP_REPLAY_GONE).not.toMatch(/already put up|open the batch to see/i)
  })
  it('a draft carries what went out under its key — optional, so a draft stored before this still restores', () => {
    const base = { key: 'k', chip: 'today', estimate: null, pickedDate: '', method: 'hot_sauce', rows: [newRow()], sitting: { lines: [], madeG: '', nextTime: '' } }
    expect(isPutItUpDraft(base)).toBe(true)
    expect(isPutItUpDraft({ ...base, sent: ['a'] })).toBe(true)
    expect(isPutItUpDraft({ ...base, sent: 'a' })).toBe(false)
  })
})

describe('Put it up — a replayed sitting', () => {
  it('a lost answer, the count changed, Put it up and finish: NOTHING is written and the host is NOT told a put-up — the sheet stays open and says so, brings the line into view, the batch behind re-reads, the STORED draft ends; tapped again, refused again: one sitting, one key', async () => {
    const on = watchScrolls()
    const table = sittingTable()
    const s = await open()
    await fillMinimum()
    await tap('putup-finish'); await said(GENERIC)
    await waitFor(() => expect(stored()?.data?.sent).toHaveLength(1))
    const before = JSON.stringify(table.sitting)
    await tap('putup-row-0-plus'); await tap('putup-row-0-plus')
    on.length = 0
    await tap('putup-finish')
    await answered(2)
    await said(PUT_UP_REPLAY_NOT_ON_IT)
    expect(screen.getByTestId('putup-error').getAttribute('role')).toBe('alert')
    await waitFor(() => expect(on).toContain(screen.getByTestId('putup-error')))
    expect(sheet()).toBeTruthy()
    expect(s.onDone).not.toHaveBeenCalled()
    expect(s.onChanged).toHaveBeenCalledTimes(1)
    expect(otherWrites()).toEqual([])
    expect(JSON.stringify(table.sitting)).toBe(before)                         // one sitting, as the first tap made it: 1 container
    expect(bodies().map(b => b.rows[0].count)).toEqual([1, 3])
    expect(screen.getByTestId('putup-row-0-count').value).toBe('3')            // the form is as he left it
    await waitFor(() => expect(stored()).toBeNull())                           // the spent-key rule
    on.length = 0
    await tap('putup-finish')
    await answered(3)
    expect(errorText()).toBe(PUT_UP_REPLAY_NOT_ON_IT)
    await waitFor(() => expect(on).toContain(screen.getByTestId('putup-error')))
    await tap('putup-later')
    await answered(4)
    expect(errorText()).toBe(PUT_UP_REPLAY_NOT_ON_IT)
    expect(new Set(keys()).size).toBe(1)                                       // never a put-up under a new key
    expect(s.onDone).not.toHaveBeenCalled()
    expect(stored()).toBeNull()
  })

  it('a lost answer, tapped again untouched: ONE sitting, completed — and the stub is what the server answered', async () => {
    const table = sittingTable()
    const s = await open()
    await fillMinimum()
    await tap('putup-finish'); await said(GENERIC)
    await tap('putup-finish')
    await waitFor(() => expect(s.onDone).toHaveBeenCalledTimes(1))
    expect(new Set(keys()).size).toBe(1)
    expect(keys()).toHaveLength(2)
    expect(s.onDone.mock.calls[0][0]).toMatchObject({ finish: true, batchId: 'kb-mash', answer: { replayed: true, stage: { id: 'ksl-1' } } })
    expect(s.onDone.mock.calls[0][0].stub).toBe("Megatron mash — put up · 1 container · Fridge · Write 'Megatron mash · Sep 29' on the label")
    expect(table.finish).toBe(true)
    expect(sheet()).toBeNull()
    expect(stored()).toBeNull()
  })

  // QA I-4. The route finds a sitting by its key and answers `replayed` with its LIVE jars — it does not look for
  // an Undo. A sitting always has at least one jar, so a replay with none is certain: it was undone, or its jars
  // were removed. The sheet used to complete on it ("Megatron mash — put up", and `finish: true` to the host).
  it('QA I-4 (P1) — put up with its answer lost, that put-up UNDONE, tapped again untouched: NOT a put-up — the sheet stays open and says it is gone, the host is not told, the batch behind re-reads, the stored draft ends; the sheet opened next is a clean one', async () => {
    const on = watchScrolls()
    const table = sittingTable()
    const s = await open()
    await fillMinimum()
    await tap('putup-finish'); await said(GENERIC)
    await waitFor(() => expect(stored()?.data?.sent).toHaveLength(1))
    table.sitting = { ...table.sitting, jars: [], batch: { ...MASH, closed_at: null } }   // Undo that put-up
    on.length = 0
    await tap('putup-finish')
    await answered(2)
    await said(PUT_UP_REPLAY_GONE)
    expect(screen.getByTestId('putup-error').getAttribute('role')).toBe('alert')
    await waitFor(() => expect(on).toContain(screen.getByTestId('putup-error')))
    expect(sheet()).toBeTruthy()
    expect(s.onDone).not.toHaveBeenCalled()
    expect(s.onChanged).toHaveBeenCalledTimes(1)
    expect(otherWrites()).toEqual([])
    await waitFor(() => expect(stored()).toBeNull())
    await tap('putup-finish')
    await answered(3)
    expect(errorText()).toBe(PUT_UP_REPLAY_GONE)                               // refused again under the one key
    expect(new Set(keys()).size).toBe(1)
    expect(s.onDone).not.toHaveBeenCalled()
    await tap('putup-row-0-plus')                                              // … and nothing typed after writes the draft back
    expect(stored()).toBeNull()
  })

  it('QA I-4 (P2) — … and with the count changed first: it is said as GONE, never as "already put up"', async () => {
    const table = sittingTable()
    const s = await open()
    await fillMinimum()
    await tap('putup-finish'); await said(GENERIC)
    table.sitting = { ...table.sitting, jars: [] }
    await tap('putup-row-0-plus')
    await tap('putup-finish')
    await answered(2)
    await said(PUT_UP_REPLAY_GONE)
    expect(s.onDone).not.toHaveBeenCalled()
    expect(s.onChanged).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(stored()).toBeNull())
  })

  it('QA I-4 — an answer that is NOT a replay is a put-up whatever it lists (the sitting was made from this very body)', async () => {
    fetchMock.mockImplementation((path, o = {}) => {
      if (path === '/api/storage-locations') return Promise.resolve(PLACES)
      if (/\/put-up$/.test(path) && o.method === 'POST') return Promise.resolve({ stage: { id: 'ksl-1' }, jars: [], inputs: [], batch: MASH })
      return Promise.resolve(null)
    })
    const s = await open()
    await fillMinimum()
    await tap('putup-finish')
    await waitFor(() => expect(s.onDone).toHaveBeenCalledTimes(1))
    expect(s.onDone.mock.calls[0][0].stub).toMatch(/^Megatron mash — put up · 1 container · Fridge/)
  })

  it('the stub on a replay is built from the SERVER\'s jars, never from the form: a sitting that reads otherwise is said as it reads', async () => {
    fetchMock.mockImplementation((path, o = {}) => {
      if (path === '/api/storage-locations') return Promise.resolve(PLACES)
      if (/\/put-up$/.test(path) && o.method === 'POST') {
        return Promise.resolve({ replayed: true, stage: { id: 'ksl-1' }, inputs: [], batch: MASH, jars: [
          { id: 'pl-1', label: 'Megatron mash', container_label: '5 oz woozy', package_count: 2, storage_label: 'Chest Freezer 1', storage_kind: 'deep_freezer',
            preserved_at: '2026-09-28', preserved_at_precision: 'day', use_by_target: '2027-03-28', use_by_basis: 'table' },
        ] })
      }
      return Promise.resolve(null)
    })
    const s = await open()
    await fillMinimum()
    await tap('putup-row-0-plus'); await tap('putup-row-0-plus'); await tap('putup-row-0-plus'); await tap('putup-row-0-plus')
    await tap('putup-finish')
    await waitFor(() => expect(s.onDone).toHaveBeenCalledTimes(1))
    expect(bodies()[0].rows[0]).toMatchObject({ count: 5, place: { id: 'loc-fridge' } })   // the form said 5, Fridge
    expect(s.onDone.mock.calls[0][0].stub).toBe("Megatron mash — put up · 2 × 5 oz woozy · Chest Freezer 1 · Write 'Megatron mash · Sep 28' on the label")
  })

  it('"More to put up later" lost, then "Put it up and finish": the sitting an earlier tap made did NOT finish the batch — the host is never told `finish: true`; refused', async () => {
    const table = sittingTable()
    const s = await open()
    await fillMinimum()
    await tap('putup-later'); await said(GENERIC)
    expect(table.finish).toBe(false)
    await tap('putup-finish')
    await answered(2)
    await said(PUT_UP_REPLAY_NOT_ON_IT)
    expect(bodies().map(b => b.finish)).toEqual([false, true])
    expect(new Set(keys()).size).toBe(1)
    expect(s.onDone).not.toHaveBeenCalled()
    expect(table.sitting.batch.closed_at).toBeNull()
    expect(s.onChanged).toHaveBeenCalledTimes(1)
  })

  it('"Put it up and finish" lost, then "More to put up later": the batch IS finished — the host is never told it is still going; refused', async () => {
    const table = sittingTable()
    const s = await open()
    await fillMinimum()
    await tap('putup-finish'); await said(GENERIC)
    await tap('putup-later')
    await answered(2)
    await said(PUT_UP_REPLAY_NOT_ON_IT)
    expect(bodies().map(b => b.finish)).toEqual([true, false])
    expect(table.finish).toBe(true)
    expect(s.onDone).not.toHaveBeenCalled()
  })

  it.each([
    ['a row added', async () => { await tap('putup-row-add') }],
    ['what it is now changed', async () => { await tap('putup-method-ferment_mash') }],
    ['When changed', async () => { await tap('putup-when-yesterday') }],
    ['where row 1 goes changed', async () => { await tap('putup-row-0-place-id:loc-cf1') }],
    ['Next time… typed', async () => { await tap('putup-sitting-more'); type('putup-nexttime', 'less salt') }],
    ['Made ___ g typed', async () => { await tap('putup-sitting-more'); type('putup-made', '900') }],
  ])('%s after a lost answer: refused, nothing written, the host not told', async (_name, change) => {
    const table = sittingTable()
    const s = await open()
    await fillMinimum()
    await tap('putup-finish'); await said(GENERIC)
    const before = JSON.stringify(table.sitting)
    await change()
    await tap('putup-finish')
    await answered(2)
    await said(PUT_UP_REPLAY_NOT_ON_IT)
    expect(JSON.stringify(table.sitting)).toBe(before)
    expect(otherWrites()).toEqual([])
    expect(s.onDone).not.toHaveBeenCalled()
    expect(new Set(keys()).size).toBe(1)
  })

  // An ANSWERED 4xx wrote nothing, so that body is not one that may have landed.
  it('a change the server refuses with a 4xx after a lost answer keeps the key; put back to what went out first, the tap after is the retry of THAT body — completed, one sitting', async () => {
    const apiError = Object.assign(new Error('bad'), { status: 400, body: { error: 'Row 1: that count is too many.' } })
    const table = sittingTable({ onPost: (n) => (n === 2 ? Promise.reject(apiError) : undefined) })
    const s = await open()
    await fillMinimum()
    await tap('putup-finish'); await said(GENERIC)
    await tap('putup-row-0-plus')
    await tap('putup-finish')
    await answered(2)
    await said(GENERIC)                                                         // an uncoded 4xx reads as any failed put-up
    await waitFor(() => expect(stored()?.data?.sent).toHaveLength(1))          // the refused body is not kept as one that went out
    await tap('putup-row-0-minus')
    await tap('putup-finish')
    await waitFor(() => expect(s.onDone).toHaveBeenCalledTimes(1))
    expect(new Set(keys()).size).toBe(1)
    expect(keys()).toHaveLength(3)
    expect(table.sitting.jars[0].package_count).toBe(1)
    expect(s.onDone.mock.calls[0][0].stub).toBe("Megatron mash — put up · 1 container · Fridge · Write 'Megatron mash · Sep 29' on the label")
  })

  it('… and when the changed body is kept and goes out again after that 4xx: it is another body under the key — refused, never a second sitting', async () => {
    const apiError = Object.assign(new Error('bad'), { status: 400, body: { error: 'Row 1: that count is too many.' } })
    sittingTable({ onPost: (n) => (n === 2 ? Promise.reject(apiError) : undefined) })
    const s = await open()
    await fillMinimum()
    await tap('putup-finish'); await said(GENERIC)
    await tap('putup-row-0-plus')
    await tap('putup-finish')
    await answered(2)
    await said(GENERIC)                                                         // an uncoded 4xx reads as any failed put-up
    await tap('putup-finish')
    await answered(3)
    await said(PUT_UP_REPLAY_NOT_ON_IT)
    expect(new Set(keys()).size).toBe(1)
    expect(s.onDone).not.toHaveBeenCalled()
  })

  it('a FIRST tap the server refuses with a 4xx (nothing written), put right, then a lost answer and the retry: completed — the refused body does not make the retry look changed', async () => {
    const apiError = Object.assign(new Error('bad'), { status: 400, body: { error: 'Row 1: that count is too many.' } })
    let n = 0
    let sitting = null
    fetchMock.mockImplementation((path, o = {}) => {
      if (path === '/api/storage-locations') return Promise.resolve(PLACES)
      if (/\/put-up$/.test(path) && o.method === 'POST') {
        n += 1
        if (n === 1) return Promise.reject(apiError)
        if (!sitting) { sitting = sittingOf(JSON.parse(o.body)); return lost() }
        return Promise.resolve({ replayed: true, ...sitting })
      }
      return Promise.resolve(null)
    })
    const s = await open()
    await fillMinimum()
    await tap('putup-row-0-plus')
    await tap('putup-finish'); await answered(1); await said(GENERIC)
    await tap('putup-row-0-minus')
    await tap('putup-finish'); await answered(2); await said(GENERIC)
    await waitFor(() => expect(stored()?.data?.sent).toHaveLength(1))
    await tap('putup-finish')
    await waitFor(() => expect(s.onDone).toHaveBeenCalledTimes(1))
    expect(new Set(keys()).size).toBe(1)
    expect(keys()).toHaveLength(3)
  })

  it('dismissed and opened again, a count changed over the restored draft: refused the same way, and the stored draft ends', async () => {
    const table = sittingTable()
    const first = await open()
    await fillMinimum()
    await tap('putup-finish'); await said(GENERIC)
    await waitFor(() => expect(stored()?.data?.sent).toHaveLength(1))
    const before = JSON.stringify(table.sitting)
    first.unmount()
    const second = await open()
    expect(screen.getByTestId('putup-method-hot_sauce').getAttribute('aria-checked')).toBe('true')
    await tap('putup-row-0-plus')
    await tap('putup-finish')
    await answered(2)
    await said(PUT_UP_REPLAY_NOT_ON_IT)
    expect(JSON.stringify(table.sitting)).toBe(before)
    expect(second.onDone).not.toHaveBeenCalled()
    expect(new Set(keys()).size).toBe(1)
    await waitFor(() => expect(stored()).toBeNull())
  })

  it('… and the same restored draft tapped untouched is the retry it always was: completed, one sitting', async () => {
    sittingTable()
    const first = await open()
    await fillMinimum()
    await tap('putup-finish'); await said(GENERIC)
    await waitFor(() => expect(stored()?.data?.sent).toHaveLength(1))
    first.unmount()
    const second = await open()
    await tap('putup-finish')
    await waitFor(() => expect(second.onDone).toHaveBeenCalledTimes(1))
    expect(new Set(keys()).size).toBe(1)
    expect(stored()).toBeNull()
  })

  it('after the refusal, the sheet closed and opened again is a clean one — and what is put up there is a NEW sitting under a NEW key (the rest, later)', async () => {
    const s = await (async () => { sittingTable(); return open() })()
    await fillMinimum()
    await tap('putup-later'); await said(GENERIC)
    await tap('putup-row-0-plus')
    await tap('putup-later')
    await answered(2)
    await said(PUT_UP_REPLAY_NOT_ON_IT)
    await waitFor(() => expect(stored()).toBeNull())
    const spentKey = keys()[0]
    s.unmount()
    fetchMock.mockImplementation((path, o = {}) => {
      if (path === '/api/storage-locations') return Promise.resolve(PLACES)
      if (/\/put-up$/.test(path) && o.method === 'POST') return Promise.resolve(sittingOf(JSON.parse(o.body)))
      return Promise.resolve(null)
    })
    const again = await open()
    expect(screen.getByTestId('putup-method-hot_sauce').getAttribute('aria-checked')).toBe('false')
    expect(screen.getByTestId('putup-row-0-count').value).toBe('1')
    await fillMinimum()
    await tap('putup-finish')
    await waitFor(() => expect(again.onDone).toHaveBeenCalledTimes(1))
    expect(keys()).toHaveLength(3)
    expect(keys()[2]).not.toBe(spentKey)
  })

  // The accepted cost of refusing without a route to compare by (the answer carries neither the mash weight
  // nor Next time…): the first body never arrived, the changed one landed with its answer lost, and the retry
  // of THAT one is refused although it is what was put up. A false refusal, never a wrong write — which is why
  // the sentence says only that this tap changed nothing.
  it('the first body never arrived, the changed one landed with its answer lost, tapped again: refused (the sheet cannot tell) — nothing written, no second sitting', async () => {
    const table = sittingTable({ lands: 2 })
    const s = await open()
    await fillMinimum()
    await tap('putup-finish'); await said(GENERIC)
    await tap('putup-row-0-plus')
    await tap('putup-finish')
    await answered(2)
    expect(errorText()).toBe(GENERIC)
    expect(table.sitting.jars[0].package_count).toBe(2)
    await tap('putup-finish')
    await answered(3)
    await said(PUT_UP_REPLAY_NOT_ON_IT)
    expect(new Set(keys()).size).toBe(1)
    expect(s.onDone).not.toHaveBeenCalled()
    expect(s.onChanged).toHaveBeenCalledTimes(1)
  })

  it('a double tap, and a tap on each button at once, send one request', async () => {
    sittingTable()
    await open()
    await fillMinimum()
    await act(async () => { fireEvent.click(screen.getByTestId('putup-finish')); fireEvent.click(screen.getByTestId('putup-later')); fireEvent.click(screen.getByTestId('putup-finish')) })
    await said(GENERIC)
    expect(putUps()).toHaveLength(1)
    expect(bodies()[0].finish).toBe(true)
  })
})
