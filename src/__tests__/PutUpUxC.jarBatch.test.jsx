// Put-Up UX pass R1, lane C — from a jar to the batch it came from (PLAN-V3 D14; finding F1).
//
// ON THE ROW: the batch's name as plain words in the detail line ("Kitchen fridge · from Petri Dish ·
// 4 left"), no new target. IN THE ROW SHEET: "What went in →", which closes the sheet FIRST and then asks
// the page to open the batch, naming the Pantry as where it came from.
//
// WHAT THIS FILE HOLDS:
//   • the names come from ONE GET /api/kitchen-batches?state=all — none when no row has a batch, never one
//     per row, and one more only when a batch id turns up that no earlier read was sent for;
//   • both envelopes read: the route's { state, batches } and a bare array;
//   • FAILURE IS ISOLATED: a rejected read, or a batch missing from it, leaves the row exactly as it reads
//     today — no words about a batch, no door to one, never "from undefined";
//   • the door is offered by BOTH hosts that are handed the page's opener (the Pantry list, the page
//     search's results) and never by Walk a place; with no opener handed in the sheet is today's;
//   • the opener is called with the batch id and { label: 'Pantry' } — exactly that.
// The landing under a REAL armed sheet (the sheet's Back entry consumed before the page is told) is in
// PutUpUxC.back.test.jsx.
// MUTATIONS (run, see the lane report): call onOpenBatch(id) with no origin -> "passes { label: 'Pantry' }"
// reds; read the names when no row has a batch, or once per row -> the request-count tests red.
// CI LANE: `npm test` plus the blocking TZ re-run. No jest-dom (L-182).
import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'
import { pantryFetch, jarRow, itemRow, PLACES } from './helpers/pantryFake.js'

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
import PantryView from '../components/pantry/PantryView.jsx'
import PantrySearchResults from '../components/pantry/PantrySearch.jsx'
import PantryRowSheet, { WHAT_WENT_IN_LABEL, PANTRY_ORIGIN_LABEL } from '../components/pantry/PantryRowSheet.jsx'
import { detailWords } from '../components/pantry/pantryRows.js'
import { batchNames, listBatchNames, BATCH_NAMES_PATH } from '../lib/pantryApi.js'
import { readFrom, backLabel } from '../components/putup/origin.js'

const [CF1, , FRIDGE] = PLACES
const NOW = new Date(2026, 9, 1)
const inPlace = (place, o) => jarRow({ place, group_key: place.id, group_label: place.label, ...o })
const REAPER = inPlace(FRIDGE, { stock_id: 'jar-reaper', name: 'Megatron reaper', method: 'hot_sauce', count_left: 4, batch_id: 'kb-1' })
const WOOZY = inPlace(FRIDGE, { stock_id: 'jar-woozy', name: 'Petri Dish woozy', method: 'hot_sauce', count_left: 2, batch_id: 'kb-1' })
const KRAUT = inPlace(FRIDGE, { stock_id: 'jar-kraut', name: 'Kraut', method: 'ferment', count_left: 1, batch_id: 'kb-2' })
const PLAIN = inPlace(CF1, { stock_id: 'jar-plain', name: 'Pesto cubes', method: 'pesto', count_left: 3, batch_id: null })
const MILK = itemRow({ stock_id: 'item-milk', name: 'Oat milk', place: FRIDGE, group_key: 'loc-3', group_label: 'Kitchen fridge' })
const BATCHES = [
  { id: 'kb-1', label: 'Petri Dish', kind: 'ferment', closed_at: '2026-09-11T12:00:00Z' },
  { id: 'kb-2', label: 'Winter kraut', kind: 'ferment', closed_at: null },
  { id: 'kb-9', label: 'Not in the pantry', kind: null, closed_at: null },
]
const ROWS = [PLAIN, REAPER, WOOZY, KRAUT, MILK]

function wire(opts = {}) {
  fake = pantryFetch({ rows: ROWS, batches: BATCHES, ...opts })
  stableFetch.fn = fake
}
const namesGets = () => fake.calls('GET').filter(c => c.path === BATCH_NAMES_PATH)
const rowText = (id) => screen.getByTestId(`pantry-row-open-put_up:${id}`).textContent
// Every microtask and the fake's answers.
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

const host = { setRows: null }
function PantryHost({ rows = ROWS, ...props }) {
  const [list, setList] = useState(rows)
  const [recent, setRecent] = useState({})
  host.setRows = setList
  return (
    <PantryView fetch={stableFetch.fn} group="place" onGroupChange={() => {}} rows={list} loading={false} error={false}
      onReload={() => {}} recent={recent} onRecent={setRecent} now={NOW.getTime()} {...props} />
  )
}

beforeEach(() => { wire(); localStorage.clear(); sessionStorage.clear() })

describe('the names read (src/lib/pantryApi.js)', () => {
  it('asks for every batch, going and closed, in one GET', async () => {
    expect(BATCH_NAMES_PATH).toBe('/api/kitchen-batches?state=all')
    const f = vi.fn(async () => ({ state: 'all', batches: BATCHES }))
    expect(await listBatchNames(f)).toEqual({ 'kb-1': 'Petri Dish', 'kb-2': 'Winter kraut', 'kb-9': 'Not in the pantry' })
    expect(f.mock.calls).toEqual([['/api/kitchen-batches?state=all']])
  })

  it('reads the route\'s { state, batches } AND a bare array — and anything else as no names', () => {
    const want = { 'kb-1': 'Petri Dish', 'kb-2': 'Winter kraut', 'kb-9': 'Not in the pantry' }
    expect(batchNames({ state: 'all', batches: BATCHES })).toEqual(want)
    expect(batchNames(BATCHES)).toEqual(want)
    for (const junk of [null, undefined, '', 0, {}, { rows: BATCHES }, { batches: 'nope' }]) expect(batchNames(junk)).toEqual({})
  })

  it('leaves out a batch it cannot name: no id, no label, a blank label', () => {
    expect(batchNames([{ id: 'a', label: '  Kimchi  ' }, { id: 'b', label: '   ' }, { id: 'c' }, { label: 'No id' }, null, { id: 7, label: 'Seven' }]))
      .toEqual({ a: 'Kimchi', 7: 'Seven' })
  })
})

describe('the row\'s words (pantryRows.detailWords)', () => {
  it('the batch\'s name sits in the detail line as plain words, after where it is from', () => {
    const byKind = { ...REAPER, group_key: 'pepper', group_label: 'Peppers' }
    expect(detailWords(byKind, { now: NOW, batchName: 'Petri Dish' })).toBe('Kitchen fridge · from Petri Dish · 4 left')
    expect(detailWords({ ...byKind, where_from: 'Megatron jalapeño' }, { now: NOW, batchName: 'Petri Dish' }))
      .toBe('Kitchen fridge · Megatron jalapeño · from Petri Dish · 4 left')
  })
  it('no name, no words: an absent, null or blank name leaves the line as it reads without one — never "from undefined"', () => {
    const byKind = { ...REAPER, group_key: 'pepper', group_label: 'Peppers' }
    const today = 'Kitchen fridge · 4 left'
    for (const batchName of [undefined, null, '', '   ']) expect(detailWords(byKind, { now: NOW, batchName })).toBe(today)
    expect(detailWords(byKind, { now: NOW })).toBe(today)
    expect(detailWords(byKind)).toBe(today)
  })
})

describe('on the Pantry list', () => {
  it('a jar from a batch says so; ONE GET names every batch; a jar with no batch and a bought item say nothing', async () => {
    render(<PantryHost />)
    await waitFor(() => expect(rowText('jar-reaper')).toContain('from Petri Dish · 4 left'))
    expect(rowText('jar-woozy')).toContain('from Petri Dish · 2 left')
    expect(rowText('jar-kraut')).toContain('from Winter kraut · 1 left')
    expect(rowText('jar-plain')).not.toMatch(/from /)
    expect(screen.getByTestId('pantry-row-open-pantry_item:item-milk').textContent).not.toMatch(/from /)
    // Three jars, two batches: one request, not one per row or per batch.
    expect(namesGets()).toHaveLength(1)
    // No new target on the row: the name is words inside the row's one open button.
    expect(screen.getByTestId('pantry-row-open-put_up:jar-reaper').querySelector('button, a')).toBeNull()
    expect(document.body.textContent).not.toMatch(/undefined|null\b/)
  })

  it('NO row has a batch: the names are never asked for', async () => {
    render(<PantryHost rows={[PLAIN, MILK]} />)
    await settle()
    expect(namesGets()).toHaveLength(0)
    expect(fake.calls('GET')).toEqual([])
  })

  it('a re-read of the same rows asks nothing more; a batch id that was never asked for asks ONCE more', async () => {
    render(<PantryHost />)
    await waitFor(() => expect(namesGets()).toHaveLength(1))
    // The list is re-read after a use: new row objects, the same batches.
    await act(async () => { host.setRows(ROWS.map(r => ({ ...r }))) })
    await act(async () => { host.setRows([REAPER, MILK]) })
    await settle()
    expect(namesGets()).toHaveLength(1)
    // "How it was made" gives a jar a batch in this same visit: a batch id no read was sent for.
    fake = pantryFetch({ rows: ROWS, batches: [...BATCHES, { id: 'kb-3', label: 'Pesto, August' }] })
    stableFetch.fn = fake
    await act(async () => { host.setRows([{ ...PLAIN, batch_id: 'kb-3' }, REAPER, MILK]) })
    await waitFor(() => expect(rowText('jar-plain')).toContain('from Pesto, August · 3 left'))
    expect(namesGets()).toHaveLength(1)                                    // one, on the new fake: the second in all
    await act(async () => { host.setRows([{ ...PLAIN, batch_id: 'kb-3' }, REAPER, MILK].map(r => ({ ...r }))) })
    await settle()
    expect(namesGets()).toHaveLength(1)
    expect(rowText('jar-reaper')).toContain('from Petri Dish')             // the names already read are kept
  })

  it('a batch the read does not list is asked for once, then never again: no words, no storm', async () => {
    render(<PantryHost rows={[{ ...REAPER, batch_id: 'kb-gone' }, MILK]} />)
    await waitFor(() => expect(namesGets()).toHaveLength(1))
    for (let i = 0; i < 3; i += 1) await act(async () => { host.setRows([{ ...REAPER, batch_id: 'kb-gone' }, MILK]) })
    await settle()
    expect(namesGets()).toHaveLength(1)
    expect(rowText('jar-reaper')).toBe('Megatron reaper' + '4 left' + 'discard by Jul 1, 2027 · general figure: hot sauce, fridge')
  })

  it.each([
    ['the route\'s envelope', () => ({ state: 'all', batches: BATCHES })],
    ['a bare array', () => BATCHES],
  ])('%s is read', async (_, answer) => {
    wire({ batches: null, overrides: { 'GET /api/kitchen-batches': answer } })
    render(<PantryHost />)
    await waitFor(() => expect(rowText('jar-reaper')).toContain('from Petri Dish · 4 left'))
  })

  it('a REJECTED read leaves every row exactly as it reads today, and offers no door', async () => {
    // What the rows say with no names at all (the read answers nothing it can name).
    wire({ batches: [] })
    const plain = render(<PantryHost onOpenBatch={vi.fn()} />)
    await settle()
    const today = ROWS.map(r => screen.getByTestId(`pantry-row-${r.stock_kind}:${r.stock_id}`).outerHTML)
    plain.unmount()

    wire({ overrides: { 'GET /api/kitchen-batches': () => { throw new Error('Failed to fetch') } } })
    render(<PantryHost onOpenBatch={vi.fn()} />)
    await waitFor(() => expect(namesGets()).toHaveLength(1))
    await settle()
    expect(ROWS.map(r => screen.getByTestId(`pantry-row-${r.stock_kind}:${r.stock_id}`).outerHTML)).toEqual(today)
    expect(screen.queryByRole('alert')).toBeNull()                         // it fails without a word
    fireEvent.click(screen.getByTestId('pantry-row-open-put_up:jar-reaper'))
    await screen.findByTestId('row-sheet')
    expect(screen.queryByTestId('row-what-went-in')).toBeNull()
  })

  it('through the page: a Pantry open is three reads, never more — and two when no jar has a batch', async () => {
    const view = render(<MemoryRouter initialEntries={['/put-up?view=pantry']}><PutUp /></MemoryRouter>)
    await waitFor(() => expect(rowText('jar-reaper')).toContain('from Petri Dish · 4 left'))
    await settle()
    expect(fake.calls('GET').map(c => c.path).sort()).toEqual([
      '/api/kitchen-batches?state=all', '/api/kitchen-batches?state=going', '/api/pantry?group=place'])
    view.unmount()

    wire({ rows: [PLAIN, MILK] })
    render(<MemoryRouter initialEntries={['/put-up?view=pantry']}><PutUp /></MemoryRouter>)
    await screen.findByTestId('pantry-row-open-put_up:jar-plain')
    await settle()
    expect(fake.calls('GET').map(c => c.path).sort()).toEqual(['/api/kitchen-batches?state=going', '/api/pantry?group=place'])
  })
})

describe('the row sheet — What went in →', () => {
  function renderSheet(row, props = {}) {
    const handlers = { onClose: vi.fn(), onUsed: vi.fn(), onChanged: vi.fn(), ...props }
    const view = render(<PantryRowSheet row={row} fetch={stableFetch.fn} {...handlers} />)
    return { ...view, ...handlers }
  }
  const actionIds = () => [...screen.getByTestId('row-sheet').querySelectorAll('button[data-testid^="row-"]')].map(b => b.getAttribute('data-testid'))

  it('with no opener handed in the sheet is today\'s: no such action on a batch jar', () => {
    renderSheet(REAPER)
    expect(screen.queryByTestId('row-what-went-in')).toBeNull()
    expect(actionIds()).toEqual(['row-move', 'row-next', 'row-give', 'row-went-bad', 'row-edit'])
  })

  it('handed the opener, a batch jar offers it LAST; a batchless jar and a bought item do not', () => {
    const batch = renderSheet(REAPER, { onOpenBatch: vi.fn() })
    expect(actionIds()).toEqual(['row-move', 'row-next', 'row-give', 'row-went-bad', 'row-edit', 'row-what-went-in'])
    expect(screen.getByTestId('row-what-went-in').textContent).toBe('What went in →')
    expect(WHAT_WENT_IN_LABEL).toBe('What went in →')
    batch.unmount()
    const plain = renderSheet(PLAIN, { onOpenBatch: vi.fn() })
    expect(screen.queryByTestId('row-what-went-in')).toBeNull()
    plain.unmount()
    renderSheet(MILK, { onOpenBatch: vi.fn() })
    expect(screen.queryByTestId('row-what-went-in')).toBeNull()
  })

  it('a batch the host cannot name gets no door', () => {
    renderSheet(REAPER, { onOpenBatch: vi.fn(), canOpenBatch: () => false })
    expect(screen.queryByTestId('row-what-went-in')).toBeNull()
  })

  it('What went in → passes { label: \'Pantry\' }: the sheet closes, then the opener gets the batch id and that origin', () => {
    const order = []
    const onClose = vi.fn(() => order.push('close'))
    const onOpenBatch = vi.fn(() => order.push('open'))
    renderSheet(REAPER, { onClose, onOpenBatch })
    fireEvent.click(screen.getByTestId('row-what-went-in'))
    expect(order).toEqual(['close', 'open'])
    expect(onOpenBatch.mock.calls).toEqual([['kb-1', { label: 'Pantry' }]])
    expect(PANTRY_ORIGIN_LABEL).toBe('Pantry')
    // What the page will read back from the entry it pushes with that origin (prep's origin.js).
    const origin = onOpenBatch.mock.calls[0][1]
    expect(readFrom({ from: origin })).toEqual({ label: 'Pantry' })
    expect(backLabel({ from: origin }, 'Going now')).toBe('Pantry')
  })
})

describe('What went in → from BOTH hosts — and never from Walk a place', () => {
  it('the Pantry list: the door is there once the batch is named, and opens it from the Pantry', async () => {
    const onOpenBatch = vi.fn()
    render(<PantryHost onOpenBatch={onOpenBatch} />)
    await waitFor(() => expect(rowText('jar-reaper')).toContain('from Petri Dish'))
    fireEvent.click(screen.getByTestId('pantry-row-open-put_up:jar-reaper'))
    fireEvent.click(await screen.findByTestId('row-what-went-in'))
    expect(onOpenBatch.mock.calls).toEqual([['kb-1', { label: 'Pantry' }]])
    await waitFor(() => expect(screen.queryByTestId('row-sheet')).toBeNull())    // the sheet closed
  })

  it('the Pantry list, no opener handed in: the name is still on the row as plain words, and the sheet is today\'s', async () => {
    render(<PantryHost />)
    await waitFor(() => expect(rowText('jar-reaper')).toContain('from Petri Dish'))
    fireEvent.click(screen.getByTestId('pantry-row-open-put_up:jar-reaper'))
    await screen.findByTestId('row-sheet')
    expect(screen.queryByTestId('row-what-went-in')).toBeNull()
  })

  it('the Pantry list: a batch missing from the read has no words and no door', async () => {
    render(<PantryHost rows={[{ ...REAPER, batch_id: 'kb-gone' }, KRAUT]} onOpenBatch={vi.fn()} />)
    await waitFor(() => expect(rowText('jar-kraut')).toContain('from Winter kraut'))
    expect(rowText('jar-reaper')).not.toMatch(/from /)
    fireEvent.click(screen.getByTestId('pantry-row-open-put_up:jar-reaper'))
    await screen.findByTestId('row-sheet')
    expect(screen.queryByTestId('row-what-went-in')).toBeNull()
  })

  function renderSearch(props = {}) {
    return render(<PantrySearchResults query="reaper" rows={ROWS} loading={false} fetch={stableFetch.fn} onPutUp={() => {}}
      onUsed={() => {}} onChanged={() => {}} now={NOW.getTime()} {...props} />)
  }

  it('the page search\'s results: the same door, the same origin, one names read', async () => {
    const onOpenBatch = vi.fn()
    renderSearch({ onOpenBatch })
    await waitFor(() => expect(namesGets()).toHaveLength(1))
    await settle()
    fireEvent.click(screen.getByTestId('pantry-search-hit-put_up:jar-reaper'))
    fireEvent.click(await screen.findByTestId('row-what-went-in'))
    expect(onOpenBatch.mock.calls).toEqual([['kb-1', { label: 'Pantry' }]])
    await waitFor(() => expect(screen.queryByTestId('row-sheet')).toBeNull())
    expect(namesGets()).toHaveLength(1)
  })

  it('the page search\'s results, no opener handed in: nothing is read and the sheet is today\'s', async () => {
    renderSearch()
    await settle()
    expect(fake.calls('GET')).toEqual([])
    fireEvent.click(screen.getByTestId('pantry-search-hit-put_up:jar-reaper'))
    await screen.findByTestId('row-sheet')
    expect(screen.queryByTestId('row-what-went-in')).toBeNull()
  })

  it('Walk a place never offers it and never reads the names, though its jar came from a batch', async () => {
    wire({ rows: [{ ...REAPER, place: CF1, group_key: 'loc-1', group_label: 'Chest Freezer 1' }] })
    render(<MemoryRouter initialEntries={['/put-up?session=putup']}><PutUp /></MemoryRouter>)
    fireEvent.click(await screen.findByRole('radio', { name: 'Chest Freezer 1' }))
    fireEvent.click(screen.getByRole('radio', { name: 'This month' }))
    fireEvent.click(screen.getByTestId('putup-walk-start'))
    fireEvent.click(await screen.findByTestId('putup-walk-here-toggle'))
    fireEvent.click(await screen.findByTestId('putup-walk-here-put_up:jar-reaper'))
    await screen.findByTestId('row-sheet')
    await settle()
    expect(screen.queryByTestId('row-what-went-in')).toBeNull()
    expect(namesGets()).toHaveLength(0)
  })
})
