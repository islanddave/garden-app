// Put-Up release 1b (V4 §2.4 "Put it up", §2.3 "Undo that put-up", §6.3–§6.6) — the sheet, the card's
// door to it, the completion stub and its Undo. The pure half is pinned in putItUp.test.js; this file
// holds what only the rendered sheet can prove: what is asked, what is required at open, the ONE
// keyed write and its retry, the draft across Back, and the refusals in the server's words.
// Real reloadGate, real DismissRegistryProvider and real history where those are the subject.
// CI LANE: `npm test` plus the blocking TZ re-run. No jest-dom (L-182).
import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react'
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
const auth = { user: { id: 'user_dave' } }
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => auth }))

import GoingNowView from '../components/putup/GoingNowView.jsx'
import PutItUpSheet from '../components/putup/PutItUpSheet.jsx'
import { FINISH_CTA, LATER_CTA } from '../components/putup/putItUp.js'
import { isReloadBlocked, clearReloadBlocks } from '../lib/reloadGate.js'
import { DismissRegistryProvider } from '../context/DismissRegistry.jsx'
import { readMarker } from '../lib/backNav.js'

const NOW = new Date('2026-09-29T15:00:00').getTime()
const local = (s) => new Date(s).toISOString()
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const BASE = {
  user_id: 'user_dave', kind_other: null, started_at: local('2026-09-20T09:00:00'), start_precision: 'day',
  first_recorded_at: local('2026-09-20T09:00:00'), expected_days_min: null, expected_days_max: null,
  suspended_at: null, closed_at: null, current_stage_kind: 'tended', current_stage_label: null,
  current_stage_entered_at: local('2026-09-27T09:00:00'), input_count: '0', output_count: '0',
  last_ph_reading: null, last_ph_read_at: null,
}
const MASH = { ...BASE, id: 'kb-mash', label: 'Megatron mash', kind: 'ferment' }
const TODAYS = { ...BASE, id: 'kb-today', label: 'Kraut', kind: 'ferment', current_stage_entered_at: local('2026-09-29T08:00:00') }
const APPLES = { ...BASE, id: 'kb-apples', label: 'Apple rings', kind: 'dehydrate' }
const PLACES = [
  { id: 'loc-fridge', user_id: 'user_dave', label: 'Fridge', kind: 'fridge' },
  { id: 'loc-cf1', user_id: 'user_dave', label: 'Chest Freezer 1', kind: 'deep_freezer' },
]
const DRAFT_KEY = 'garden:putup-draft:v1:user_dave:putup:kb-mash'
const JAR = { id: 'pl-1', label: 'Megatron mash', preserved_at: '2026-09-29', preserved_at_precision: 'day', use_by_target: '2027-03-29', use_by_basis: 'table' }

const putUps = () => fetchMock.mock.calls.filter(([p, o]) => /\/put-up$/.test(p) && o?.method === 'POST')
const bodyOf = (call) => JSON.parse(call[1].body)
function wire({ places = PLACES, putUp = () => Promise.resolve({ stage: { id: 'ksl-1' }, jars: [JAR], inputs: [], batch: {} }),
  other = () => Promise.resolve({ ok: true }) } = {}) {
  fetchMock.mockImplementation((path, o = {}) => {
    if (path === '/api/storage-locations') return Promise.resolve(places)
    if (/\/put-up$/.test(path)) return putUp()
    if (o.method === 'POST') return other(path)
    return Promise.resolve(null)
  })
}
function renderView(batches, onReload = vi.fn()) {
  return render(
    <MemoryRouter initialEntries={['/put-up']}>
      <GoingNowView batches={batches} loading={false} error={false} onReload={onReload} now={NOW} />
    </MemoryRouter>,
  )
}
async function openPutUp(batch = MASH, onReload) {
  const utils = renderView([batch], onReload)
  await act(async () => { fireEvent.click(screen.getByTestId('going-put-up')) })
  await waitFor(() => expect(screen.getByTestId('putup-row-0-place-id:loc-fridge')).toBeTruthy())
  return utils
}
const sheet = () => screen.queryByTestId('putup-sheet')
const tap = (id) => act(async () => { fireEvent.click(screen.getByTestId(id)) })
async function fillMinimum() {
  await tap('putup-when-today')
  await tap('putup-method-hot_sauce')
  await tap('putup-row-0-place-id:loc-fridge')
}

beforeEach(() => {
  fetchMock.mockReset()
  wire()
  localStorage.clear()
  clearReloadBlocks()
  auth.user = { id: 'user_dave' }
  window.history.replaceState({ __floor: 1 }, '')
})
afterEach(() => { clearReloadBlocks() })

describe('Put it up — what it asks', () => {
  it('the card\'s door opens the sheet on that batch', async () => {
    await openPutUp()
    expect(sheet().getAttribute('data-batch-id')).toBe('kb-mash')
    expect(screen.getByTestId('putup-batch').textContent).toBe('Megatron mash')
  })

  // Census (V4 §6.3): fails on ANY increase. MUTATION: mark the container group aria-required -> 4.
  it('requires three answers at open — when, what it is now, row 1\'s place', async () => {
    await openPutUp()
    const req = [...sheet().querySelectorAll('[aria-required="true"]')].map(e => e.getAttribute('aria-label'))
    expect(req).toEqual(['When was it put up?', 'What is it now?', 'Where is row 1 going?'])
  })

  // MUTATION: drop the preselect -> the When group is required again and this counts 3.
  it('a batch checked today opens with Today chosen and When no longer required', async () => {
    await openPutUp(TODAYS)
    expect(screen.getByTestId('putup-when-today').getAttribute('aria-checked')).toBe('true')
    expect(sheet().querySelectorAll('[aria-required="true"]').length).toBe(2)
  })

  it('offers the kind\'s methods as required radios, More… for the rest, nothing chosen', async () => {
    await openPutUp()
    const group = screen.getByRole('radiogroup', { name: 'What is it now?' })
    const radios = within(group).getAllByRole('radio')
    expect(radios.map(r => r.textContent)).toEqual(['Hot sauce', 'Fermenting mash (unfinished)', 'Ferment', 'Other'])
    expect(radios.every(r => r.getAttribute('aria-checked') === 'false' && r.style.minHeight === '48px')).toBe(true)
    await tap('putup-method-more')
    expect(within(group).getAllByRole('radio').length).toBeGreaterThan(10)
  })

  it('asks Raw only where the method allows it, pH only for acid methods, How dry? only when dried', async () => {
    await openPutUp()
    await tap('putup-method-hot_sauce')
    await tap('putup-row-0-more')
    expect(!!screen.queryByTestId('putup-row-0-raw')).toBe(true)
    expect(!!screen.queryByTestId('putup-row-0-inoil')).toBe(true)
    expect(!!screen.queryByTestId('putup-row-0-ph-input')).toBe(true)
    expect(!!screen.queryByTestId('putup-row-0-texture-bends')).toBe(false)
    await tap('putup-method-more')
    await tap('putup-method-whole_freeze')
    expect(!!screen.queryByTestId('putup-row-0-raw')).toBe(false)
    expect(!!screen.queryByTestId('putup-row-0-ph-input')).toBe(false)
    await tap('putup-method-dehydrate')
    expect(!!screen.queryByTestId('putup-row-0-texture-bends')).toBe(true)
  })

  it('"More to put up later" is quieter and sits below the primary', async () => {
    await openPutUp()
    const footer = screen.getByTestId('putup-footer')
    const buttons = [...footer.querySelectorAll('button')].map(b => b.textContent)
    expect(buttons).toEqual([FINISH_CTA, LATER_CTA])
    expect(screen.getByTestId('putup-later').style.marginTop).toBe('12px')
  })

  it('shows the resolved date and each row\'s discard-by before Save', async () => {
    await openPutUp()
    await fillMinimum()
    expect(screen.getByTestId('putup-when-words').textContent).toBe('Put up today')
    expect(screen.getByTestId('putup-preview').textContent).toBe('discard by Mar 29, 2027 · general figure: hot sauce, fridge')
    expect(screen.getByTestId('putup-preview').getAttribute('role')).toBe('status')
  })

  // The ferment walks: the "From the label" chip and the date field it opens shared one testid, so the
  // field could not be addressed. MUTATION: give the field `-discard-date` back -> the count arm reds.
  it('a typed discard-by: the chip and its date field are two things, and the day typed is the day sent', async () => {
    await openPutUp()
    await fillMinimum()
    await tap('putup-row-0-more')
    await tap('putup-row-0-discard-date')
    expect(screen.getAllByTestId('putup-row-0-discard-date')).toHaveLength(1)
    fireEvent.change(screen.getByTestId('putup-row-0-discard-day'), { target: { value: '2026-12-08' } })
    await tap('putup-finish')
    expect(bodyOf(putUps()[0]).rows[0].discard_by).toBe('2026-12-08')
  })

  // The ferment walks at 426×492: opening a row's "+ Name, added at the end…" jumped the sheet ~676 px —
  // Chrome's scroll anchoring — so the row's first fields went above the top edge and pH sat under the
  // row's sticky header. MUTATION: drop overflowAnchor from the body or the footer -> an arm reds.
  it('opts out of scroll anchoring, body and footer', async () => {
    await openPutUp()
    expect(sheet().style.overflowAnchor).toBe('none')
    expect(screen.getByTestId('putup-footer').style.overflowAnchor).toBe('none')
  })
})

describe('Put it up — the one keyed write', () => {
  // MUTATION: send the body without `finish` -> the literal reds.
  it('writes ONE POST with a v4 key, and the stub takes the card\'s slot with the label hint', async () => {
    const onReload = vi.fn()
    await openPutUp(MASH, onReload)
    await fillMinimum()
    await tap('putup-row-0-container-8 oz woozy')
    await tap('putup-row-0-plus')
    await tap('putup-finish')
    await waitFor(() => expect(sheet()).toBeNull())
    expect(putUps()).toHaveLength(1)
    const body = bodyOf(putUps()[0])
    expect(body.idempotency_key).toMatch(UUID)
    expect({ ...body, idempotency_key: 'K' }).toEqual({
      idempotency_key: 'K', when: { date: '2026-09-29', precision: 'day' }, method: 'hot_sauce', finish: true,
      rows: [{ count: 2, place: { id: 'loc-fridge' }, container_label: '8 oz woozy', size_value: 8, size_unit: 'fl oz' }],
    })
    expect(putUps()[0][0]).toBe('/api/kitchen-batches/kb-mash/put-up')
    expect(screen.getByTestId('going-putup-stub').textContent).toContain(
      "Megatron mash — put up · 2 × 8 oz woozy · Fridge · Write 'Megatron mash · Sep 29' on the label")
    expect(onReload).toHaveBeenCalled()
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull()
  })

  it('"More to put up later" writes finish: false', async () => {
    await openPutUp()
    await fillMinimum()
    await tap('putup-later')
    await waitFor(() => expect(putUps()).toHaveLength(1))
    expect(bodyOf(putUps()[0]).finish).toBe(false)
  })

  // MUTATION: mint a fresh key per Save -> the two keys differ and this reds.
  it('a failed write keeps everything and the retry carries the SAME key', async () => {
    let n = 0
    wire({ putUp: () => (++n === 1 ? Promise.reject(new Error('network')) : Promise.resolve({ stage: { id: 's' }, jars: [] })) })
    await openPutUp()
    await fillMinimum()
    await tap('putup-finish')
    await waitFor(() => expect(screen.getByTestId('putup-error').textContent).toBe(
      "Couldn't put it up — try again. Everything you entered is still here."))
    expect(screen.getByTestId('putup-method-hot_sauce').getAttribute('aria-checked')).toBe('true')
    await tap('putup-finish')
    await waitFor(() => expect(putUps()).toHaveLength(2))
    expect(bodyOf(putUps()[1]).idempotency_key).toBe(bodyOf(putUps()[0]).idempotency_key)
  })

  it('refuses a Save with no place, in words, and writes nothing', async () => {
    await openPutUp()
    await tap('putup-when-today')
    await tap('putup-method-ferment')
    await tap('putup-finish')
    expect(screen.getByTestId('putup-error').textContent).toBe('Where is it going? Pick a place.')
    expect(putUps()).toHaveLength(0)
  })

  it('a finished batch answers with the server\'s words and a Reopen door, never a bare refusal', async () => {
    const err = Object.assign(new Error('409'), { status: 409, body: {
      code: 'batch_closed', reopen: true, error: 'This batch is finished. Reopen it to bottle more →' } })
    wire({ putUp: () => Promise.reject(err) })
    await openPutUp()
    await fillMinimum()
    await tap('putup-finish')
    await waitFor(() => expect(screen.getByTestId('putup-error').textContent).toBe('This batch is finished. Reopen it to bottle more →'))
    await tap('putup-reopen')
    expect(fetchMock.mock.calls.some(([p, o]) => p === '/api/kitchen-batches/kb-mash/reopen' && o?.method === 'POST')).toBe(true)
    await waitFor(() => expect(screen.queryByTestId('putup-reopen')).toBeNull())
  })

  it('rows 2..N inherit container and place, in words, and send them', async () => {
    await openPutUp()
    await fillMinimum()
    await tap('putup-row-0-container-8 oz woozy')
    await tap('putup-row-add')
    expect(screen.getByTestId('putup-row-1-same').textContent).toBe('8 oz woozy · Fridge — same as the row above')
    // Row 1 moves → row 2 follows.
    await tap('putup-row-0-place-id:loc-cf1')
    expect(screen.getByTestId('putup-row-1-same').textContent).toBe('8 oz woozy · Chest Freezer 1 — same as the row above')
    await tap('putup-finish')
    await waitFor(() => expect(putUps()).toHaveLength(1))
    expect(bodyOf(putUps()[0]).rows.map(r => r.place)).toEqual([{ id: 'loc-cf1' }, { id: 'loc-cf1' }])
  })

  // Release F (amended in the same commit): added-at-the-end goes through the line search (LineAdder),
  // so a typed addition is built by lines.js — the same keyed body, now with the ferment fields when
  // they are answered.
  it('an added-at-the-end line carries its own key and the typed amount', async () => {
    await openPutUp()
    await fillMinimum()
    await tap('putup-row-0-more')
    await tap('putup-row-0-added-open')
    fireEvent.change(screen.getByTestId('putup-row-0-added-add-name'), { target: { value: 'vinegar' } })
    fireEvent.change(screen.getByTestId('putup-row-0-added-add-qty'), { target: { value: '72' } })
    await tap('putup-row-0-added-add-submit')
    expect(screen.getByTestId('putup-row-0-added-line').textContent).toBe('vinegar · 72 g')
    await tap('putup-finish')
    await waitFor(() => expect(putUps()).toHaveLength(1))
    const [line] = bodyOf(putUps()[0]).rows[0].added_lines
    expect(line.idempotency_key).toMatch(UUID)
    expect({ ...line, idempotency_key: 'K' }).toEqual({ input_kind: 'other', idempotency_key: 'K', label: 'vinegar', qty: '72', qty_unit: 'g' })
  })
})

describe('Put it up — Undo that put-up from the stub', () => {
  // MUTATION: drop the synchronous ref -> a double tap posts twice.
  it('posts the undo route once, however fast the taps', async () => {
    let settle
    wire({ other: (p) => (/\/undo$/.test(p) ? new Promise(r => { settle = r }) : Promise.resolve({})) })
    await openPutUp()
    await fillMinimum()
    await tap('putup-later')
    await waitFor(() => expect(screen.getByTestId('going-putup-undo')).toBeTruthy())
    const btn = screen.getByTestId('going-putup-undo')
    act(() => { fireEvent.click(btn); fireEvent.click(btn) })
    const undos = () => fetchMock.mock.calls.filter(([p]) => /\/put-up\/ksl-1\/undo$/.test(p))
    expect(undos()).toHaveLength(1)
    expect(undos()[0][0]).toBe('/api/kitchen-batches/kb-mash/put-up/ksl-1/undo')
    await act(async () => { settle({ ok: true, reopened: false }) })
    await waitFor(() => expect(screen.getByTestId('going-putup-stub').textContent).toContain('Put-up undone'))
  })

  it('a refused undo says why, in the server\'s words, and the stub stays', async () => {
    const err = Object.assign(new Error('409'), { status: 409, body: { code: 'put_up_in_use', jar_ids: ['pl-1'],
      error: 'One of those jars was already used.' } })
    wire({ other: (p) => (/\/undo$/.test(p) ? Promise.reject(err) : Promise.resolve({})) })
    await openPutUp()
    await fillMinimum()
    await tap('putup-later')
    await waitFor(() => expect(screen.getByTestId('going-putup-undo')).toBeTruthy())
    await tap('going-putup-undo')
    await waitFor(() => expect(screen.getByTestId('going-putup-stub-error').textContent).toBe('One of those jars was already used.'))
    expect(screen.getByTestId('going-putup-undo')).toBeTruthy()
  })
})

describe('Put it up — Back, the draft and the reload gate', () => {
  const settle = () => act(async () => { await new Promise(r => setTimeout(r, 60)) })
  function Host() {
    const [open, setOpen] = useState(true)
    return (
      <DismissRegistryProvider>
        <PutItUpSheet open={open} batch={MASH} now={NOW} onClose={() => setOpen(false)} onDone={() => setOpen(false)} />
        {!open && <button type="button" onClick={() => setOpen(true)}>reopen</button>}
      </DismissRegistryProvider>
    )
  }

  it('Back closes the sheet, the draft survives with its key, and it all comes back', async () => {
    await act(async () => { render(<Host />) })
    await waitFor(() => expect(!!readMarker(window.history.state)).toBe(true))
    await waitFor(() => expect(screen.getByTestId('putup-row-0-place-id:loc-fridge')).toBeTruthy())
    await fillMinimum()
    expect(isReloadBlocked()).toBe(true)
    const key = JSON.parse(localStorage.getItem(DRAFT_KEY)).data.key
    expect(key).toMatch(UUID)
    act(() => { window.history.back() }); await settle()
    await waitFor(() => expect(sheet()).toBeNull())
    expect(isReloadBlocked()).toBe(false)
    await act(async () => { fireEvent.click(screen.getByText('reopen')) })
    expect(screen.getByTestId('putup-method-hot_sauce').getAttribute('aria-checked')).toBe('true')
    expect(JSON.parse(localStorage.getItem(DRAFT_KEY)).data.key).toBe(key)
  })

  it('a draft of the wrong shape is dropped, never half-restored', async () => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ v: 1, sheet: 'putup', savedAt: NOW, data: { key: 'x', rows: 'nope' } }))
    await act(async () => { render(<Host />) })
    expect(screen.getByTestId('putup-method-hot_sauce').getAttribute('aria-checked')).toBe('false')
  })
})

describe('Put it up — words', () => {
  it('no banned word anywhere on the open sheet, every disclosure open', async () => {
    await openPutUp(APPLES)
    await tap('putup-when-earlier')
    await tap('putup-method-dehydrate')
    await tap('putup-row-0-more')
    await tap('putup-sitting-more')
    const text = sheet().textContent
    expect(text).toContain('How dry?')
    expect(text).not.toMatch(/\bsafe\b|shelf.life|shelf.stable|\bkeeps\b|\bgood\b|\bready\b|\bdone\b|\bexpired\b|\btable\b|\bdefault\b|\bbasis\b/i)
  })
})

describe('Check on it — Saved · Undo in place (V4 §2.3, from 1b)', () => {
  // MUTATION: drop voids_id from the void body (or the ref) -> the literal / the count reds.
  it('after a check-in the card says Saved with an Undo that voids exactly that row, once', async () => {
    const stagePosts = () => fetchMock.mock.calls.filter(([p, o]) => /\/stages$/.test(p) && o?.method === 'POST')
    wire({ other: (p) => (/\/stages$/.test(p) ? Promise.resolve({ stage: { id: 'ksl-new' }, batch: {} }) : Promise.resolve({})) })
    renderView([MASH])
    await act(async () => { fireEvent.click(screen.getByTestId('going-check')) })
    fireEvent.change(screen.getByTestId('checkin-note'), { target: { value: 'skimmed' } })
    await act(async () => { fireEvent.click(screen.getByTestId('checkin-save')) })
    await waitFor(() => expect(screen.getByTestId('going-checkin-saved').textContent).toBe('SavedUndo'))
    const btn = screen.getByTestId('going-checkin-undo')
    await act(async () => { fireEvent.click(btn); fireEvent.click(btn) })
    const voids = stagePosts().map(c => JSON.parse(c[1].body)).filter(b => b.stage_kind === 'void')
    expect(voids).toEqual([{ stage_kind: 'void', voids_id: 'ksl-new' }])
    await waitFor(() => expect(screen.getByTestId('going-checkin-saved').textContent).toBe('Taken back — that check-in is off the log.'))
  })
})

describe('Put it up — Still soft on a Dry batch (V4 engine rule e)', () => {
  // MUTATION: drop the kind gate -> the Ferment arm shows the door and reds.
  it('offers "Not yet — keep drying", which closes the sheet, writes nothing and keeps the draft', async () => {
    await openPutUp(APPLES)
    await tap('putup-method-dehydrate')
    await tap('putup-row-0-more')
    await tap('putup-row-0-texture-still_soft')
    await tap('putup-row-0-keep-drying')
    await waitFor(() => expect(sheet()).toBeNull())
    expect(putUps()).toHaveLength(0)
    expect(JSON.parse(localStorage.getItem('garden:putup-draft:v1:user_dave:putup:kb-apples')).data.method).toBe('dehydrate')
  })
  it('is not offered on another kind', async () => {
    await openPutUp({ ...APPLES, id: 'kb-x', kind: 'ferment' })
    await tap('putup-method-more')
    await tap('putup-method-dehydrate')
    await tap('putup-row-0-more')
    await tap('putup-row-0-texture-still_soft')
    expect(screen.queryByTestId('putup-row-0-keep-drying')).toBeNull()
  })
})

describe('Put it up — Not sure on the wire (contract-F §2.4, the 1b Lambda putUp.js)', () => {
  // MUTATION: send the anchor ('after' + a date) as `when` -> the 1b Lambda 400s it, and this literal reds.
  it('sends precision unknown with no date, and previews from the last dated event', async () => {
    await openPutUp()
    await tap('putup-when-unsure')
    expect(screen.getByTestId('putup-when-words').textContent).toBe('Put up sometime after Sep 27 — the last date we have')
    await tap('putup-method-hot_sauce')
    await tap('putup-row-0-place-id:loc-fridge')
    expect(screen.getByTestId('putup-preview').textContent).toBe('discard by around Mar 27, 2027 · general figure: hot sauce, fridge')
    await tap('putup-finish')
    await waitFor(() => expect(putUps()).toHaveLength(1))
    expect(bodyOf(putUps()[0]).when).toEqual({ date: null, precision: 'unknown' })
  })
})

// Release F (06 §3.6, §4 item 7; HS-I3; Dave: "fresh ingredients added at the final step, may or may not
// be cooked") — the additions go through the same line search; the rows gain Cooked and a typed heat;
// the sitting gains Mash in. A sitting may name a jar ONCE (the ferment Lambda refuses a second draw
// from one jar in one put-up), so the sheet never offers a jar it has already named.
describe('Put it up — release F additions', () => {
  const REAPER = { preservation_log_id: 'j-reaper', label: 'Reaper, frozen', method: 'whole_freeze', stock_mode: 'weighed',
    quantity_value: '100', quantity_unit: 'g', package_count: 1, remaining_count: 1, remaining_amount: '100', suggested_form: 'frozen' }
  const withSearch = () => wire({ other: () => Promise.resolve({}), putUp: () => Promise.resolve({ stage: { id: 'ksl-1' }, jars: [JAR] }) })
  beforeEach(() => {
    withSearch()
    const base = fetchMock.getMockImplementation()
    fetchMock.mockImplementation((path, o = {}) => (String(path).startsWith('/api/kitchen-batches/line-search')
      ? Promise.resolve({ plantings: [], put_ups: [REAPER] }) : base(path, o)))
  })

  it('a draw added at the end (8 g from the frozen reaper bag) is a keyed put_up line; fresh or cooked only', async () => {
    await openPutUp()
    await fillMinimum()
    await tap('putup-row-0-more')
    await tap('putup-row-0-added-open')
    fireEvent.change(screen.getByTestId('putup-row-0-added-add-name'), { target: { value: 'rea' } })
    await waitFor(() => expect(screen.getByTestId('putup-row-0-added-add-hit-jar:j-reaper')).toBeTruthy())
    await tap('putup-row-0-added-add-hit-jar:j-reaper')
    fireEvent.change(screen.getByTestId('putup-row-0-added-add-qty'), { target: { value: '8' } })
    await tap('putup-row-0-added-add-more')
    expect(within(screen.getByRole('group', { name: 'Form' })).getAllByRole('button').map(b => b.textContent)).toEqual(['Fresh', 'Cooked'])
    await tap('putup-row-0-added-add-submit')
    await tap('putup-finish')
    await waitFor(() => expect(putUps()).toHaveLength(1))
    const [line] = bodyOf(putUps()[0]).rows[0].added_lines
    expect({ ...line, idempotency_key: 'K' }).toEqual({ idempotency_key: 'K', input_kind: 'put_up', preservation_log_id: 'j-reaper',
      label: 'Reaper, frozen', qty: '8', qty_unit: 'g' })
  })

  // MUTATION: drop excludeJarIds -> the named jar is offered again and this reds.
  it('a jar named once in the sheet is not offered again', async () => {
    await openPutUp()
    await fillMinimum()
    await tap('putup-row-0-more')
    await tap('putup-row-0-added-open')
    fireEvent.change(screen.getByTestId('putup-row-0-added-add-name'), { target: { value: 'rea' } })
    await waitFor(() => expect(screen.getByTestId('putup-row-0-added-add-hit-jar:j-reaper')).toBeTruthy())
    await tap('putup-row-0-added-add-hit-jar:j-reaper')
    fireEvent.change(screen.getByTestId('putup-row-0-added-add-qty'), { target: { value: '8' } })
    await tap('putup-row-0-added-add-submit')
    await tap('putup-sitting-more')
    await tap('putup-sitting-added-open')
    fireEvent.change(screen.getByTestId('putup-sitting-added-add-name'), { target: { value: 'rea' } })
    await waitFor(() => expect(screen.getByTestId('putup-sitting-added-add-hits')).toBeTruthy())
    expect(screen.queryByTestId('putup-sitting-added-add-hit-jar:j-reaper')).toBeNull()
  })

  it('the body refuses a jar named twice, in words', async () => {
    const { putUpBody, newRow } = await import('../components/putup/putItUp.js')
    const draw = { idempotency_key: 'k1', input_kind: 'put_up', preservation_log_id: 'j-reaper', qty: '8', qty_unit: 'g', label: 'Reaper' }
    const r = putUpBody({ key: 'k', when: { date: '2026-09-29', precision: 'day' }, method: 'hot_sauce',
      rows: [{ ...newRow(), place: { key: 'id:p', id: 'p', label: 'Fridge', kind: 'fridge' }, lines: [draw] }],
      sittingLines: [{ ...draw, idempotency_key: 'k2' }], batch: {} })
    expect(r).toEqual({ error: 'That jar is named twice in this put-up — take one out.', field: 'lines' })
  })

  it('Cooked after blending and a typed heat ride on the row; Mash in on the sitting (Ferment)', async () => {
    await openPutUp()
    await fillMinimum()
    await tap('putup-row-0-more')
    await tap('putup-row-0-cooked')
    fireEvent.change(screen.getByTestId('putup-row-0-heat'), { target: { value: '1700–5300' } })
    await tap('putup-sitting-more')
    fireEvent.change(screen.getByTestId('putup-made'), { target: { value: '256' } })
    fireEvent.change(screen.getByTestId('putup-mash'), { target: { value: '198' } })
    await tap('putup-finish')
    await waitFor(() => expect(putUps()).toHaveLength(1))
    const body = bodyOf(putUps()[0])
    expect(body.rows[0]).toMatchObject({ cooked: true, shu_est_low: 1700, shu_est_high: 5300 })
    expect(body.made_g).toBe('256')
    expect(body.mash_in_g).toBe('198')
  })

  it('Mash in is a Ferment field', async () => {
    await openPutUp(APPLES)
    await tap('putup-sitting-more')
    expect(screen.queryByTestId('putup-mash')).toBeNull()
    expect(screen.getByTestId('putup-made')).toBeTruthy()
  })
})
