// Put-Up R2a, lane F (D3, ruling h; QA-I14) — Put it up: a name typed into an adder and not added is HIDDEN
// when its disclosure closes, never dropped. The ruled build: the name is held in the sheet's state and the
// adder is UNMOUNTED — not kept mounted and hidden — so a closed disclosure adds no required input and no
// testid, and the same name is in the field when the adder is on screen again.
// The reversed pin is PutUpUxE.test.jsx ("Less over a typed name: the commit stops at the guard; reopened,
// the name is there"); this file holds what that one test does not say.
// MUTATIONS (each run, each red here):
//   F-M2  forget the name when the adder goes away with its disclosure (= the base)
//                                                   -> "Less, then More again…", "the sitting's Less…", and four more
//   F-M2b keep the row's details mounted and hidden  -> "the required list is unchanged with a held name"
//   the guard does not open the disclosure           -> "a name held in a closed row, with another row open…"
//   a removed row's held name stays behind           -> "removing a row takes its held name with it…"
// CI LANE: `npm test` plus the TZ re-run. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  apiFetch: (...args) => fetchMock(...args),
}))
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => ({ user: { id: 'user_dave' } }) }))

import PutItUpSheet from '../components/putup/PutItUpSheet.jsx'
import { addFirstWords } from '../components/putup/LineAdder.jsx'
import { clearReloadBlocks } from '../lib/reloadGate.js'

const NOW = new Date('2026-09-29T15:00:00').getTime()
const BATCH = { id: 'kb-mash', user_id: 'user_dave', label: 'Megatron mash', kind: 'ferment',
  started_at: new Date('2026-09-20T09:00:00').toISOString(), start_precision: 'day', closed_at: null, suspended_at: null, outputs: [] }
const PLACES = [{ id: 'loc-fridge', user_id: 'user_dave', label: 'Fridge', kind: 'fridge' }]
const JAR = { id: 'pl-1', label: 'Megatron mash', preserved_at: '2026-09-29', preserved_at_precision: 'day', use_by_target: '2027-03-29', use_by_basis: 'table' }

const putUps = () => fetchMock.mock.calls.filter(([p, o]) => /\/put-up$/.test(p) && o?.method === 'POST')
const bodyOf = (call) => JSON.parse(call[1].body)
const searches = () => fetchMock.mock.calls.filter(([p]) => String(p).includes('line-search'))
const sheet = () => screen.getByTestId('putup-sheet')
const tap = (id) => act(async () => { fireEvent.click(screen.getByTestId(id)) })
const type = (id, value) => act(async () => { fireEvent.change(screen.getByTestId(id), { target: { value } }) })
const nameId = (i) => `putup-row-${i}-added-add-name`
const lineId = (i) => `putup-row-${i}-added-add-first`
const SIT_NAME = 'putup-sitting-added-add-name'
const SIT_LINE = 'putup-sitting-added-add-first'
// The census, as PutUpPutItUp.test.jsx reads it: every required control on the sheet, by its name.
const required = () => [...sheet().querySelectorAll('[aria-required="true"]')].map(e => e.getAttribute('aria-label'))
// Every testid on the page that names more than one node.
const twice = () => {
  const ids = [...document.querySelectorAll('[data-testid]')].map(e => e.getAttribute('data-testid'))
  return [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))]
}

async function openSheet() {
  render(<PutItUpSheet open batch={BATCH} lines={[]} now={NOW} onClose={() => {}} onDone={() => {}} />)
  await waitFor(() => expect(screen.getByTestId('putup-row-0-place-id:loc-fridge')).toBeTruthy())
  await tap('putup-method-hot_sauce')
  await tap('putup-row-0-place-id:loc-fridge')
}
// Row i's details open, its adder open, a name typed and not added.
async function typeInRow(i, text) {
  await tap(`putup-row-${i}-more`)
  await tap(`putup-row-${i}-added-open`)
  await type(nameId(i), text)
}

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation((path) => {
    if (path === '/api/storage-locations') return Promise.resolve(PLACES)
    if (/\/put-up$/.test(path)) return Promise.resolve({ stage: { id: 'ksl-1' }, jars: [JAR], inputs: [], batch: {} })
    if (String(path).startsWith('/api/kitchen-batches/line-search')) return Promise.resolve({ plantings: [], put_ups: [] })
    return Promise.resolve(null)
  })
  localStorage.clear(); clearReloadBlocks()
  window.history.replaceState({ __floor: 1 }, '')
})
afterEach(() => { cleanup(); clearReloadBlocks() })

describe('Put it up — a typed, unadded name is hidden with its disclosure, never dropped (ruling h)', () => {
  it('the required list is unchanged with a held name', async () => {
    await openSheet()
    const atOpen = required()
    expect(atOpen).toEqual(['What is it now?', 'Where is row 1 going?'])
    await typeInRow(0, 'garlic')
    await tap('putup-row-0-more')                                       // "− Less about this row"
    // Unmounted, not hidden: nothing of the adder is in the page, so nothing of it is required or counted.
    expect(required()).toEqual(atOpen)
    expect(screen.queryByTestId('putup-row-0-details')).toBeNull()
    expect(document.querySelector('[data-testid^="putup-row-0-added"]')).toBeNull()
    expect(twice()).toEqual([])
    // On screen again there is one adder, holding the name; the list gains its one field, as an open adder's
    // always did.
    await tap('putup-row-0-more')
    expect(screen.getAllByTestId(nameId(0))).toHaveLength(1)
    expect(required()).toEqual([...atOpen, null])
    expect(twice()).toEqual([])
  })

  it('Less, then More again: the name is back in its field — the adder open, no line, and the cursor not moved', async () => {
    await openSheet()
    await typeInRow(0, 'garlic scapes')
    await tap('putup-row-0-more')
    expect(screen.queryByTestId(nameId(0))).toBeNull()
    await tap('putup-row-0-more')
    expect(screen.getByTestId(nameId(0)).value).toBe('garlic scapes')
    expect(screen.queryByTestId('putup-row-0-added-open')).toBeNull()   // not back behind "+ Add something"
    // The line is the answer to a commit, never a nag: reopening says nothing and takes no focus.
    expect(screen.queryByTestId(lineId(0))).toBeNull()
    expect(document.activeElement).not.toBe(screen.getByTestId(nameId(0)))
    // Added from there, it is the line.
    await tap('putup-row-0-added-add-submit')
    expect(screen.getByTestId('putup-row-0-added-line').textContent).toBe('garlic scapes')
    await tap('putup-finish')
    await waitFor(() => expect(putUps()).toHaveLength(1))
    expect(bodyOf(putUps()[0]).rows[0].added_lines.map(l => l.label)).toEqual(['garlic scapes'])
  })

  it('"More to put up later" stops for a held name too', async () => {
    await openSheet()
    await typeInRow(0, 'garlic')
    await tap('putup-row-0-more')
    await tap('putup-later')
    expect(putUps()).toHaveLength(0)
    expect(screen.getByTestId(lineId(0)).textContent).toBe(addFirstWords('garlic'))
    expect(document.activeElement).toBe(screen.getByTestId(nameId(0)))
  })

  it('the sitting\'s Less holds its name the same way: the commit opens it again, the cursor in the field', async () => {
    await openSheet()
    await tap('putup-sitting-more')
    await tap('putup-sitting-added-open')
    await type(SIT_NAME, 'vinegar')
    await tap('putup-sitting-more')                                     // "− Less"
    expect(screen.queryByTestId('putup-sitting')).toBeNull()
    expect(required()).toEqual(['What is it now?', 'Where is row 1 going?'])
    await tap('putup-finish')
    expect(putUps()).toHaveLength(0)
    expect(screen.getByTestId(SIT_NAME).value).toBe('vinegar')
    expect(screen.getByTestId(SIT_LINE).textContent).toBe(addFirstWords('vinegar'))
    expect(document.activeElement).toBe(screen.getByTestId(SIT_NAME))
    expect(twice()).toEqual([])
  })

  // One row's details are open at a time: opening another row closes this one, and that is a Less too.
  it('a name held in a closed row, with another row open: the commit opens the row that holds it', async () => {
    await openSheet()
    await tap('putup-row-add')
    await typeInRow(0, 'garlic')
    await tap('putup-row-1-more')
    expect(screen.queryByTestId(nameId(0))).toBeNull()
    expect(screen.getByTestId('putup-row-1-details')).toBeTruthy()
    await tap('putup-finish')
    expect(putUps()).toHaveLength(0)
    expect(screen.queryByTestId('putup-row-1-details')).toBeNull()
    expect(screen.getByTestId(nameId(0)).value).toBe('garlic')
    expect(screen.getByTestId(lineId(0)).textContent).toBe(addFirstWords('garlic'))
    expect(document.activeElement).toBe(screen.getByTestId(nameId(0)))
  })

  it('a held name cleared after reopening is gone: the commit saves without it', async () => {
    await openSheet()
    await typeInRow(0, 'garlic')
    await tap('putup-row-0-more')
    await tap('putup-row-0-more')
    await type(nameId(0), '')
    await tap('putup-row-0-more')
    await tap('putup-finish')
    await waitFor(() => expect(putUps()).toHaveLength(1))
    expect(bodyOf(putUps()[0]).rows[0].added_lines).toBeUndefined()
  })

  // A stop is the answer to ONE commit. Closing the disclosure over it ends the stop and keeps the name.
  it('a stop does not outlive Less: reopened by hand there is no line until a commit stops again', async () => {
    await openSheet()
    await typeInRow(0, 'garlic')
    await tap('putup-finish')
    expect(screen.getByTestId(lineId(0))).toBeTruthy()
    await tap('putup-row-0-more')
    await tap('putup-row-0-more')
    expect(screen.getByTestId(nameId(0)).value).toBe('garlic')
    expect(screen.queryByTestId(lineId(0))).toBeNull()
    await tap('putup-finish')
    expect(putUps()).toHaveLength(0)
    expect(screen.getByTestId(lineId(0)).textContent).toBe(addFirstWords('garlic'))
  })

  it('removing a row takes its held name with it, and a later row\'s held name moves up with its row', async () => {
    await openSheet()
    await tap('putup-row-add')
    await tap('putup-row-add')
    await typeInRow(2, 'onion')                                         // row 3 holds "onion"…
    await typeInRow(1, 'shallot')                                       // …row 2 holds "shallot", and is the open one
    await tap('putup-row-1-remove')
    expect(screen.queryByTestId('putup-row-2')).toBeNull()
    // What was row 3 is row 2 now, and "onion" is still its; "shallot" went with the row that held it.
    await tap('putup-finish')
    expect(putUps()).toHaveLength(0)
    expect(screen.getByTestId(nameId(1)).value).toBe('onion')
    expect(screen.getByTestId(lineId(1)).textContent).toBe(addFirstWords('onion'))
    await type(nameId(1), '')
    await tap('putup-finish')
    await waitFor(() => expect(putUps()).toHaveLength(1))
    expect(bodyOf(putUps()[0]).rows).toHaveLength(2)
  })

  // The one LineAdder prop is handed a name only when one is held: with none, Put it up's adder is the
  // adder it always was.
  it('with nothing held, a row\'s adder opens empty behind its door and asks the search nothing', async () => {
    await openSheet()
    await tap('putup-row-0-more')
    expect(screen.getByTestId('putup-row-0-added-open').textContent).toBe('+ Add something')
    expect(screen.queryByTestId(nameId(0))).toBeNull()
    await tap('putup-row-0-added-open')
    expect(screen.getByTestId(nameId(0)).value).toBe('')
    await act(async () => { await new Promise(r => setTimeout(r, 350)) })   // past the search's debounce
    expect(searches()).toHaveLength(0)
  })

  it('the held name is the sheet\'s for the visit only: it is not written into the draft', async () => {
    await openSheet()
    await typeInRow(0, 'garlic')
    await tap('putup-row-0-more')
    const stored = localStorage.getItem('garden:putup-draft:v1:user_dave:putup:kb-mash')
    expect(stored).toBeTruthy()
    expect(stored).not.toContain('garlic')
  })
})
