// Put-Up UX pass R1, lane E (D12, D2, F16) — what only the rendered Put it up sheet and its stub can prove:
//   · the UNADDED-LINE GUARD: with a name still sitting in an embedded adder (a row's "Added at the end",
//     or the sitting's "Added at the end to every jar"), neither commit saves — the cursor goes back into
//     that adder and one line above it says "Add “garlic” first — or clear it.";
//   · two identical rows read as one in the stub that takes the card's place;
//   · the stub's quiet actions are 48 px (F16);
//   · and a banned-word sweep of the sheet with the guard's line showing.
// The pins this lane amended live where they were: PutUpPutItUp.test.jsx (the census, the draft, the
// footer) and putItUp.test.js (preselectWhen, the stub literal). Each test names the mutation that reds it.
// CI LANE: `npm test` plus the TZ re-run. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  apiFetch: (...args) => fetchMock(...args),
}))
vi.mock('react-router-dom', async (orig) => {
  const actual = await orig()
  return { ...actual, useNavigate: () => vi.fn() }
})
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => ({ user: { id: 'user_dave' } }) }))

import GoingNowView from '../components/putup/GoingNowView.jsx'
import { addFirstWords } from '../components/putup/LineAdder.jsx'
import { clearReloadBlocks } from '../lib/reloadGate.js'

const NOW = new Date('2026-09-29T15:00:00').getTime()
const local = (s) => new Date(s).toISOString()
const MASH = {
  id: 'kb-mash', label: 'Megatron mash', kind: 'ferment', user_id: 'user_dave', kind_other: null,
  started_at: local('2026-09-20T09:00:00'), start_precision: 'day', first_recorded_at: local('2026-09-20T09:00:00'),
  expected_days_min: null, expected_days_max: null, suspended_at: null, closed_at: null, current_stage_kind: 'tended',
  current_stage_label: null, current_stage_entered_at: local('2026-09-27T09:00:00'), input_count: '0', output_count: '0',
  last_ph_reading: null, last_ph_read_at: null,
}
const PLACES = [
  { id: 'loc-fridge', user_id: 'user_dave', label: 'Fridge', kind: 'fridge' },
  { id: 'loc-cf1', user_id: 'user_dave', label: 'Chest Freezer 1', kind: 'deep_freezer' },
]
const JAR = { id: 'pl-1', label: 'Megatron mash', preserved_at: '2026-09-29', preserved_at_precision: 'day', use_by_target: '2027-03-29', use_by_basis: 'table' }

const putUps = () => fetchMock.mock.calls.filter(([p, o]) => /\/put-up$/.test(p) && o?.method === 'POST')
const bodyOf = (call) => JSON.parse(call[1].body)
const sheet = () => screen.queryByTestId('putup-sheet')
const tap = (id) => act(async () => { fireEvent.click(screen.getByTestId(id)) })
const type = (id, value) => act(async () => { fireEvent.change(screen.getByTestId(id), { target: { value } }) })

async function openPutUp() {
  render(
    <MemoryRouter initialEntries={['/put-up']}>
      <GoingNowView batches={[MASH]} loading={false} error={false} onReload={vi.fn()} now={NOW} />
    </MemoryRouter>,
  )
  await tap('going-put-up')
  await waitFor(() => expect(screen.getByTestId('putup-row-0-place-id:loc-fridge')).toBeTruthy())
}
// When is Today at open (D12), so the minimum is two taps.
async function fillMinimum() {
  await tap('putup-method-hot_sauce')
  await tap('putup-row-0-place-id:loc-fridge')
}
async function openRowAdder() {
  await tap('putup-row-0-more')
  await tap('putup-row-0-added-open')
}
async function openSittingAdder() {
  await tap('putup-sitting-more')
  await tap('putup-sitting-added-open')
}
const DRAFT_KEY = 'garden:putup-draft:v1:user_dave:putup:kb-mash'
const BANNED = /\bsafe\b|shelf.life|shelf.stable|\bkeeps\b|\bgood\b|\bready\b|\bdone\b|\bexpired\b|\btable\b|\bdefault\b|\bbasis\b/i
const ROW_NAME = 'putup-row-0-added-add-name'
const ROW_LINE = 'putup-row-0-added-add-first'
const SIT_NAME = 'putup-sitting-added-add-name'
const SIT_LINE = 'putup-sitting-added-add-first'

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation((path, o = {}) => {
    if (path === '/api/storage-locations') return Promise.resolve(PLACES)
    if (/\/put-up$/.test(path)) return Promise.resolve({ stage: { id: 'ksl-1' }, jars: [JAR], inputs: [], batch: {} })
    if (String(path).startsWith('/api/kitchen-batches/line-search')) return Promise.resolve({ plantings: [], put_ups: [] })
    if (o.method === 'POST') return Promise.resolve({ ok: true })
    return Promise.resolve(null)
  })
  localStorage.clear()
  clearReloadBlocks()
  window.history.replaceState({ __floor: 1 }, '')
})
afterEach(() => { clearReloadBlocks() })

describe('Put it up — When starts on Today (D12)', () => {
  // An untouched When is an answer now, and it is stored: the put-up day is today, and every discard date
  // counts from it. MUTATION (M8a): preselect nothing on this batch -> the save is refused for a When.
  it('two taps and the commit: the body carries today as a day', async () => {
    await openPutUp()
    expect(screen.getByTestId('putup-when-words').textContent).toBe('Put up today')
    await fillMinimum()
    await tap('putup-finish')
    await waitFor(() => expect(putUps()).toHaveLength(1))
    expect(bodyOf(putUps()[0]).when).toEqual({ date: '2026-09-29', precision: 'day' })
  })

  // The group stays on screen with all four answers, and any other one is a single tap.
  it('When stays visible and changeable in one tap: Yesterday is sent', async () => {
    await openPutUp()
    const chips = [...screen.getByRole('radiogroup', { name: 'When was it put up?' }).querySelectorAll('[role="radio"]')]
    expect(chips.map(c => [c.textContent, c.getAttribute('aria-checked')])).toEqual(
      [['Today', 'true'], ['Yesterday', 'false'], ['Earlier…', 'false'], ['Not sure', 'false']])
    await tap('putup-when-yesterday')
    expect(screen.getByTestId('putup-when-today').getAttribute('aria-checked')).toBe('false')
    await fillMinimum()
    await tap('putup-finish')
    await waitFor(() => expect(putUps()).toHaveLength(1))
    expect(bodyOf(putUps()[0]).when).toEqual({ date: '2026-09-28', precision: 'day' })
  })

  // A chosen When other than Today is an edit: it is kept as a draft, with a key.
  it('changing When makes the sheet dirty and the draft keeps the chosen chip', async () => {
    await openPutUp()
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull()
    await tap('putup-when-unsure')
    expect(JSON.parse(localStorage.getItem(DRAFT_KEY)).data.chip).toBe('unsure')
    await tap('putup-when-today')
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull()
  })
})

describe('Put it up — the unadded-line guard (D2)', () => {
  // MUTATION (the guard): let "Put it up and finish" proceed with pending adder text -> a body is posted
  // with no such line, and the first arm reds.
  it('"Put it up and finish" with a name still in a row\'s adder does not save: the cursor goes back and one line says why', async () => {
    await openPutUp()
    await fillMinimum()
    await openRowAdder()
    await type(ROW_NAME, 'garlic')
    // Typing alone says nothing: the line is the answer to a commit, not a nag.
    expect(screen.queryByTestId(ROW_LINE)).toBeNull()
    screen.getByTestId('putup-finish').focus()
    await tap('putup-finish')
    expect(putUps()).toHaveLength(0)
    expect(sheet()).toBeTruthy()
    const line = screen.getByTestId(ROW_LINE)
    expect(line.textContent).toBe('Add “garlic” first — or clear it.')
    expect(line.textContent).toBe(addFirstWords('garlic'))
    expect(line.getAttribute('role')).toBe('alert')
    expect(document.activeElement).toBe(screen.getByTestId(ROW_NAME))
    // Above the adder, not under it (under it is off screen with the keyboard up).
    expect(line.compareDocumentPosition(screen.getByTestId('putup-row-0-added-add')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The sheet's own error line stays out of it.
    expect(screen.queryByTestId('putup-error')).toBeNull()
  })

  // MUTATION (the guard): let "More to put up later" proceed with pending adder text -> it posts
  // finish: false without the line.
  it('"More to put up later" stops the same way, and a second tap puts the cursor back again', async () => {
    await openPutUp()
    await fillMinimum()
    await openRowAdder()
    await type(ROW_NAME, 'garlic scapes ')
    await tap('putup-later')
    expect(putUps()).toHaveLength(0)
    expect(screen.getByTestId(ROW_LINE).textContent).toBe('Add “garlic scapes” first — or clear it.')
    expect(document.activeElement).toBe(screen.getByTestId(ROW_NAME))
    screen.getByTestId('putup-later').focus()
    expect(document.activeElement).not.toBe(screen.getByTestId(ROW_NAME))
    await tap('putup-later')
    expect(putUps()).toHaveLength(0)
    expect(document.activeElement).toBe(screen.getByTestId(ROW_NAME))
  })

  // MUTATION: keep the stop after the name is cleared -> the line is still there, or the save is still
  // refused.
  it('clearing the name ends the stop: the line goes and the commit saves', async () => {
    await openPutUp()
    await fillMinimum()
    await openRowAdder()
    await type(ROW_NAME, 'garlic')
    await tap('putup-finish')
    expect(screen.getByTestId(ROW_LINE)).toBeTruthy()
    await type(ROW_NAME, '')
    expect(screen.queryByTestId(ROW_LINE)).toBeNull()
    // A new name after that is just typing again — no line until a commit stops for it.
    await type(ROW_NAME, 'onion')
    expect(screen.queryByTestId(ROW_LINE)).toBeNull()
    await type(ROW_NAME, '')
    await tap('putup-finish')
    await waitFor(() => expect(putUps()).toHaveLength(1))
    expect(bodyOf(putUps()[0]).rows[0].added_lines).toBeUndefined()
  })

  // Put it up's adder goes away after each Add (LineAdder reports null as it unmounts). MUTATION: ignore
  // that report -> the added name is still "pending" and the save below never posts.
  it('adding the line ends the stop too: the commit then saves WITH the line', async () => {
    await openPutUp()
    await fillMinimum()
    await openRowAdder()
    await type(ROW_NAME, 'garlic')
    await tap('putup-finish')
    expect(putUps()).toHaveLength(0)
    await tap('putup-row-0-added-add-submit')
    expect(screen.queryByTestId(ROW_LINE)).toBeNull()
    expect(screen.getByTestId('putup-row-0-added-line').textContent).toBe('garlic')
    await tap('putup-finish')
    await waitFor(() => expect(putUps()).toHaveLength(1))
    expect(bodyOf(putUps()[0]).rows[0].added_lines.map(l => l.label)).toEqual(['garlic'])
  })

  // MUTATION: guard the rows' adders only -> the sitting's typed name is dropped by the save.
  it('the sitting\'s adder is guarded the same way, under its own line', async () => {
    await openPutUp()
    await fillMinimum()
    await openSittingAdder()
    await type(SIT_NAME, 'vinegar')
    await tap('putup-finish')
    expect(putUps()).toHaveLength(0)
    expect(screen.getByTestId(SIT_LINE).textContent).toBe('Add “vinegar” first — or clear it.')
    expect(document.activeElement).toBe(screen.getByTestId(SIT_NAME))
    await tap('putup-later')
    expect(putUps()).toHaveLength(0)
  })

  // Two adders open at once (a row's and the sitting's): one line at a time, top to bottom.
  it('with a name in a row\'s adder AND the sitting\'s, the row\'s is asked first, then the sitting\'s', async () => {
    await openPutUp()
    await fillMinimum()
    await openRowAdder()
    await openSittingAdder()
    await type(SIT_NAME, 'vinegar')
    await type(ROW_NAME, 'garlic')
    await tap('putup-finish')
    expect(screen.getByTestId(ROW_LINE).textContent).toBe(addFirstWords('garlic'))
    expect(screen.queryByTestId(SIT_LINE)).toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId(ROW_NAME))
    await tap('putup-row-0-added-add-submit')
    await tap('putup-finish')
    expect(putUps()).toHaveLength(0)
    expect(screen.getByTestId(SIT_LINE).textContent).toBe(addFirstWords('vinegar'))
    expect(document.activeElement).toBe(screen.getByTestId(SIT_NAME))
  })

  // Closing the row's disclosure takes its adder (and the typed name) away, as it did before this pass:
  // the guard then has nothing to stop for.
  it('an adder that has gone away holds nothing: the commit saves', async () => {
    await openPutUp()
    await fillMinimum()
    await openRowAdder()
    await type(ROW_NAME, 'garlic')
    await tap('putup-row-0-more')
    expect(screen.queryByTestId(ROW_NAME)).toBeNull()
    await tap('putup-finish')
    await waitFor(() => expect(putUps()).toHaveLength(1))
  })

  it('with nothing typed in an open adder, both commits save as before', async () => {
    await openPutUp()
    await fillMinimum()
    await openRowAdder()
    await tap('putup-later')
    await waitFor(() => expect(putUps()).toHaveLength(1))
    expect(bodyOf(putUps()[0]).finish).toBe(false)
  })
})

describe('Put it up — the stub in place', () => {
  // MUTATION: one part per row in completionStub -> "4 × 5 oz woozy · Fridge · 1 × 5 oz woozy · Fridge".
  it('two identical rows read as one in the stub that takes the card\'s slot', async () => {
    await openPutUp()
    await fillMinimum()
    await tap('putup-row-0-container-5 oz woozy')
    for (let i = 0; i < 3; i++) await tap('putup-row-0-plus')
    await tap('putup-row-add')
    await tap('putup-finish')
    await waitFor(() => expect(sheet()).toBeNull())
    expect(bodyOf(putUps()[0]).rows.map(r => r.count)).toEqual([4, 1])
    expect(screen.getByTestId('going-putup-stub').querySelector('[role="status"]').textContent)
      .toBe("Megatron mash — put up · 5 × 5 oz woozy · Fridge · Write 'Megatron mash · Sep 29' on the label")
  })

  // F16: height only. MUTATION: put the stub's links back on T.tapMinHeight -> '44px'.
  it('the stub\'s quiet actions, Undo and Open →, are 48 px tall and still quiet', async () => {
    await openPutUp()
    await fillMinimum()
    await tap('putup-later')
    await waitFor(() => expect(screen.getByTestId('going-putup-undo')).toBeTruthy())
    const actions = [screen.getByTestId('going-putup-undo'), screen.getByTestId('going-putup-open')]
    expect(actions.map(b => [b.textContent, b.style.minHeight, b.style.background, b.style.fontSize])).toEqual([
      ['Undo', '48px', 'none', '0.78rem'],
      ['Open →', '48px', 'none', '0.78rem'],
    ])
    expect(actions.map(b => b.style.minWidth)).toEqual(['44px', '44px'])     // "Undo" alone was 37 px wide
  })

  // F16 on the sheet itself (landed at the train, from the 426 px render: five quiet actions measured 44 px).
  // MUTATION: put the sheet's quietLink back on T.tapMinHeight -> every entry reads '44px'.
  it('the sheet\'s own quiet actions are 48 px tall', async () => {
    await openPutUp()
    const ids = ['putup-method-more', 'putup-row-0-place-new', 'putup-row-0-more', 'putup-row-add', 'putup-sitting-more', 'putup-later']
    expect(ids.map(id => [id, screen.getByTestId(id).style.minHeight])).toEqual(ids.map(id => [id, '48px']))
  })
})

describe('Put it up — words', () => {
  it('no banned word on the open sheet with the guard\'s line showing, every disclosure open', async () => {
    await openPutUp()
    await fillMinimum()
    await openRowAdder()
    await openSittingAdder()
    await type(ROW_NAME, 'garlic')
    await tap('putup-finish')
    const text = sheet().textContent + screen.getByTestId('putup-footer').textContent
    expect(text).toContain('Add “garlic” first — or clear it.')
    expect(text).toContain('More to put up later')
    expect(text).not.toMatch(BANNED)
  })

  // The stub had no sweep of its own: what it says after a put-up, and after its Undo.
  it('no banned word on the stub, before and after Undo', async () => {
    await openPutUp()
    await fillMinimum()
    await tap('putup-later')
    await waitFor(() => expect(screen.getByTestId('going-putup-undo')).toBeTruthy())
    const stub = screen.getByTestId('going-putup-stub')
    expect(stub.textContent).toContain('Megatron mash — put up · 1 container · Fridge')
    expect(stub.textContent).not.toMatch(BANNED)
    await tap('going-putup-undo')
    await waitFor(() => expect(stub.textContent).toContain('Put-up undone'))
    expect(stub.textContent).not.toMatch(BANNED)
  })
})
