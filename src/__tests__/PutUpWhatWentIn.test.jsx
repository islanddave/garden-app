// Put-Up release F (06 §4 item 3, §3.11; contract-F §2.2) — What went in, reworked: the line search, the
// four ways a line comes in, [Water] and [Salt], the line sheet, "Saved · Undo", "Taken out · Undo", and
// "from the garden" as ambient words. Each assertion names the mutation that reds it.
// CI LANE: `npm test` plus the blocking TZ re-run. No jest-dom (L-182).
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

import BatchDetailView from '../components/putup/BatchDetailView.jsx'
import { LINE_ERRORS, unitNeeded } from '../components/putup/lines.js'
import { clearReloadBlocks } from '../lib/reloadGate.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const NOW = new Date('2026-10-02T09:00:00').getTime()
const local = (s) => new Date(s).toISOString()
const BATCH = {
  id: 'kb-1', user_id: 'user_dave', label: 'Megatron mash', kind: 'ferment', kind_other: null,
  started_at: local('2026-10-01T09:00:00'), start_precision: 'day', first_recorded_at: local('2026-10-01T09:00:00'),
  suspended_at: null, closed_at: null, outcome: null, outcome_note: null, current_stage_kind: 'started',
  current_stage_entered_at: local('2026-10-01T09:00:00'), input_count: '0', output_count: '0', garden_names: [],
}
const LINE = (o) => ({ batch_id: 'kb-1', harvest_log_id: null, label: null, qty: null, qty_unit: null, is_byproduct: false,
  added_at: local('2026-10-01T10:00:00'), note: null, plant_id: null, preservation_log_id: null, crop_type_slug: null,
  source_label: null, role: null, salt_pct: null, salt_base: null, base_g: null, put_up_stage_id: null, output_id: null,
  ordinal: 1, deleted_at: null, brand: null, form: null, shu_rating_low: null, shu_rating_high: null, salt_method: null,
  base_from: null, edited_at: null, from_garden: false, count_drawn: null, ...o })
const MEGATRON_LINE = LINE({ id: 'kbi-mega', input_kind: 'garden', plant_id: 'p-mega', label: 'Megatron jalapeño', qty: '412.000', qty_unit: 'g', form: 'fresh', from_garden: true, ordinal: 1 })
const PICK_LINE = LINE({ id: 'kbi-pick', input_kind: 'harvest', harvest_log_id: 'h-9', plant_id: 'p-ser', label: 'Serranos', qty: '230', qty_unit: 'g', from_garden: true, ordinal: 2 })
const HITS = {
  plantings: [{ plant_id: 'p-mega', label: 'Megatron jalapeño', crop_type_slug: 'pepper', variety_id: 'v-mega',
    recent_picks: [{ harvest_log_id: 'h-1', picked_on: '2026-09-27', qty: '412', qty_unit: 'g' }] }],
  put_ups: [
    { preservation_log_id: 'j-reaper', label: 'Reaper, frozen', method: 'whole_freeze', stock_mode: 'weighed', quantity_value: '100', quantity_unit: 'g', package_count: 1, remaining_count: 1, remaining_amount: '100', suggested_form: 'frozen' },
    { preservation_log_id: 'j-carrot', label: 'Carrots', method: 'blanch_freeze', stock_mode: 'counted', quantity_value: '3', quantity_unit: 'lb', package_count: 4, remaining_count: 4, remaining_amount: null, suggested_form: 'frozen' },
  ],
}

const posts = (re) => fetchMock.mock.calls.filter(([p, o]) => re.test(p) && o?.method === 'POST').map(([p, o]) => [p, JSON.parse(o.body)])
const patches = () => fetchMock.mock.calls.filter(([, o]) => o?.method === 'PATCH').map(([p, o]) => [p, JSON.parse(o.body)])
function wire({ post = () => Promise.resolve({ inserted: 1, requested: 1, inputs: [{ id: 'kbi-new' }] }), extra = () => null } = {}) {
  fetchMock.mockImplementation((path, o = {}) => {
    const x = extra(path, o)
    if (x) return x
    if (String(path).startsWith('/api/kitchen-batches/line-search')) return Promise.resolve(HITS)
    if (o.method === 'POST') return post(path, o)
    if (o.method === 'PATCH') return Promise.resolve({ input: {} })
    if (o.method === 'DELETE') return Promise.resolve({ ok: true, input: null })
    return Promise.resolve(null)
  })
}
// The view as an element, so a test can re-render the SAME mounted view the way the page does after a write
// (`refreshing` while the re-read is out, then the new rows).
const detailEl = (o = {}, onChanged = vi.fn()) => (
  <BatchDetailView batch={{ ...BATCH, ...o.batch }} inputs={o.inputs ?? []} stages={o.stages ?? []}
    outputs={[]} loading={false} error={false} nowMs={NOW} onChanged={onChanged} refreshing={o.refreshing ?? false} />
)
function renderDetail(o = {}) {
  const onChanged = o.onChanged ?? vi.fn()
  const utils = render(detailEl(o, onChanged))
  return { ...utils, onChanged }
}
const name = () => screen.getByTestId('line-add-name')
async function search(q) {
  fireEvent.change(name(), { target: { value: q } })
  await waitFor(() => expect(screen.getByTestId('line-add-hits')).toBeTruthy())
}
const add = () => act(async () => { fireEvent.click(screen.getByTestId('line-add-submit')) })

beforeEach(() => { fetchMock.mockReset(); wire(); localStorage.clear(); clearReloadBlocks() })
afterEach(() => clearReloadBlocks())

describe('the line search — plantings (with their picks) and put-ups, or a typed name', () => {
  it('searches after two letters, and lists plantings and put-ups', async () => {
    renderDetail()
    fireEvent.change(name(), { target: { value: 'm' } })
    await act(async () => { await new Promise(r => setTimeout(r, 300)) })
    expect(fetchMock.mock.calls.some(([p]) => String(p).includes('line-search'))).toBe(false)
    await search('me')
    expect(fetchMock).toHaveBeenCalledWith('/api/kitchen-batches/line-search?q=me')
    const hits = within(screen.getByTestId('line-add-hits')).getAllByRole('button').map(b => b.textContent)
    expect(hits).toEqual([
      'Megatron jalapeño · 1 recent pick · from the garden',
      'Reaper, frozen · about 100 g left · put up',
      'Carrots · 4 left · put up',
      'Use “me” as it is',
    ])
  })

  // MUTATION: write a garden line when a pick is chosen (or a pick when none is) -> the kinds swap.
  it('a planting needs no pick ("No particular pick" preselected) — and a chosen pick makes it a pick line', async () => {
    renderDetail()
    await search('meg')
    fireEvent.click(screen.getByTestId('line-add-hit-planting:p-mega'))
    expect(screen.getByTestId('line-add-pick-none').getAttribute('aria-checked')).toBe('true')
    fireEvent.change(screen.getByTestId('line-add-qty'), { target: { value: '412' } })
    await add()
    await waitFor(() => expect(posts(/\/inputs$/)).toHaveLength(1))
    const [path, body] = posts(/\/inputs$/)[0]
    expect(path).toBe('/api/kitchen-batches/kb-1/inputs')
    expect(body.inputs[0].idempotency_key).toMatch(UUID)
    expect({ ...body.inputs[0], idempotency_key: 'K' }).toEqual({ idempotency_key: 'K', input_kind: 'garden', plant_id: 'p-mega',
      label: 'Megatron jalapeño', crop_type_slug: 'pepper', qty: '412', qty_unit: 'g', ordinal: 1 })
    expect(screen.getByTestId('what-went-in-status').textContent).toBe('Added · Megatron jalapeño 412 g')
    fetchMock.mockClear(); wire()
    await search('meg')
    fireEvent.click(screen.getByTestId('line-add-hit-planting:p-mega'))
    fireEvent.click(screen.getByTestId('line-add-pick-h-1'))
    await add()
    await waitFor(() => expect(posts(/\/inputs$/)).toHaveLength(1))
    expect(posts(/\/inputs$/)[0][1].inputs[0]).toMatchObject({ input_kind: 'harvest', harvest_log_id: 'h-1' })
  })

  it('a weighed bag asks "How many g?" (mass units only) and says what is left after; no count', async () => {
    renderDetail()
    await search('rea')
    fireEvent.click(screen.getByTestId('line-add-hit-jar:j-reaper'))
    expect(screen.queryByTestId('line-add-count')).toBeNull()
    expect(within(screen.getByRole('radiogroup', { name: 'Unit' })).getAllByRole('radio').map(r => r.textContent)).toEqual(['g', 'oz', 'lb', 'kg'])
    await add()
    expect(screen.getByTestId('line-add-error').textContent).toBe(LINE_ERRORS.weighed)
    fireEvent.change(screen.getByTestId('line-add-qty'), { target: { value: '8' } })
    expect(screen.getByTestId('line-add-left-after').textContent).toBe('about 92 g left after')
    await add()
    await waitFor(() => expect(posts(/\/inputs$/)).toHaveLength(1))
    const line = posts(/\/inputs$/)[0][1].inputs[0]
    expect(line).toMatchObject({ input_kind: 'put_up', preservation_log_id: 'j-reaper', qty: '8', qty_unit: 'g', form: 'frozen' })
    expect('count_drawn' in line).toBe(false)
  })

  it('a counted jar asks "How many?" on a stepper starting at 1', async () => {
    renderDetail()
    await search('car')
    fireEvent.click(screen.getByTestId('line-add-hit-jar:j-carrot'))
    expect(screen.getByTestId('line-add-count').value).toBe('1')
    expect(screen.getByTestId('line-add-count-minus').getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(screen.getByTestId('line-add-count-plus'))
    fireEvent.change(screen.getByTestId('line-add-qty'), { target: { value: '150' } })
    await add()
    await waitFor(() => expect(posts(/\/inputs$/)).toHaveLength(1))
    expect(posts(/\/inputs$/)[0][1].inputs[0]).toMatchObject({ input_kind: 'put_up', preservation_log_id: 'j-carrot', count_drawn: 2, qty: '150', qty_unit: 'g' })
  })

  // MUTATION: drop the unit check -> the route would 400; here the inline refusal disappears.
  it('an amount with no unit is refused inline, naming the number, and nothing is written', async () => {
    renderDetail()
    fireEvent.change(name(), { target: { value: 'garlic' } })
    fireEvent.change(screen.getByTestId('line-add-qty'), { target: { value: '412' } })
    fireEvent.click(screen.getByTestId('line-add-unit-g'))           // un-picks the preselected g
    await add()
    expect(screen.getByTestId('line-add-error').textContent).toBe(unitNeeded('412'))
    expect(posts(/\/inputs$/)).toHaveLength(0)
  })

  it('a typed name is kept as typed', async () => {
    renderDetail()
    fireEvent.change(name(), { target: { value: 'onion' } })
    await add()
    await waitFor(() => expect(posts(/\/inputs$/)).toHaveLength(1))
    expect(posts(/\/inputs$/)[0][1].inputs[0]).toMatchObject({ input_kind: 'other', label: 'onion' })
  })

  // MUTATION: mint a new key per Add -> the retry's key differs.
  it('a retry after a failed Add is the SAME line (same key)', async () => {
    let n = 0
    wire({ post: () => (++n === 1 ? Promise.reject(new Error('502')) : Promise.resolve({ inputs: [{ id: 'x' }] })) })
    renderDetail()
    fireEvent.change(name(), { target: { value: 'onion' } })
    await add()
    await waitFor(() => expect(screen.getByTestId('what-went-in-error')).toBeTruthy())
    await add()
    await waitFor(() => expect(posts(/\/inputs$/)).toHaveLength(2))
    expect(posts(/\/inputs$/)[1][1].inputs[0].idempotency_key).toBe(posts(/\/inputs$/)[0][1].inputs[0].idempotency_key)
  })

  it('a refused draw says why in the server\'s words (only_g_left)', async () => {
    wire({ post: () => Promise.reject(Object.assign(new Error('409'), { status: 409, body: { code: 'only_g_left', g: 5, error: 'x' } })) })
    renderDetail()
    await search('rea')
    fireEvent.click(screen.getByTestId('line-add-hit-jar:j-reaper'))
    fireEvent.change(screen.getByTestId('line-add-qty'), { target: { value: '8' } })
    await add()
    await waitFor(() => expect(screen.getByTestId('what-went-in-error').textContent).toMatch(/5 g/))
  })

  it('the Add button is pinned only while the name or amount has focus', () => {
    renderDetail()
    expect(screen.getByTestId('line-add-bar').getAttribute('data-pinned')).toBe('false')
    fireEvent.focus(name())
    expect(screen.getByTestId('line-add-bar').getAttribute('data-pinned')).toBe('true')
    expect(screen.getByTestId('line-add-bar').style.position).toBe('sticky')
    fireEvent.blur(name())
    expect(screen.getByTestId('line-add-bar').getAttribute('data-pinned')).toBe('false')
  })
})

describe('[Water] and [Salt]', () => {
  it('[Water] opens the add row prefilled: Water, the water role, ml', async () => {
    renderDetail()
    await act(async () => { fireEvent.click(screen.getByTestId('what-went-in-water')) })
    expect(name().value).toBe('Water')
    expect(screen.getByTestId('line-add-unit-ml').getAttribute('aria-checked')).toBe('true')
    fireEvent.change(screen.getByTestId('line-add-qty'), { target: { value: '800' } })
    await add()
    await waitFor(() => expect(posts(/\/inputs$/)).toHaveLength(1))
    expect(posts(/\/inputs$/)[0][1].inputs[0]).toMatchObject({ input_kind: 'other', label: 'Water', role: 'water', qty: '800', qty_unit: 'ml' })
    expect(screen.getByTestId('what-went-in-status').textContent).toBe('Added · Water 800 ml')
  })

  // UX-I4. MUTATION: make [Salt] post a salt line -> a POST appears.
  it('[Salt] hands focus to the Salt block\'s % field and writes nothing', async () => {
    renderDetail()
    await act(async () => { fireEvent.click(screen.getByTestId('what-went-in-salt')) })
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('salt-step-0-pct')))
    expect(fetchMock.mock.calls.filter(([, o]) => o?.method && o.method !== 'GET')).toHaveLength(0)
  })
})

describe('a line, edited or taken out', () => {
  // MUTATION: send every field on Save -> the PATCH carries unchanged keys and this literal reds.
  it('Save sends only what changed; "Saved · Undo" sends back what was there', async () => {
    const { onChanged } = renderDetail({ inputs: [MEGATRON_LINE] })
    fireEvent.click(screen.getByTestId('line-row-kbi-mega'))
    fireEvent.change(screen.getByTestId('line-sheet-qty'), { target: { value: '400' } })
    fireEvent.change(screen.getByTestId('line-sheet-note'), { target: { value: 'two were soft' } })
    await act(async () => { fireEvent.click(screen.getByTestId('line-sheet-save')) })
    await waitFor(() => expect(patches()).toHaveLength(1))
    expect(patches()[0]).toEqual(['/api/kitchen-batches/kb-1/inputs/kbi-mega', { qty: '400', qty_unit: 'g', note: 'two were soft' }])
    expect(onChanged).toHaveBeenCalled()
    await act(async () => { fireEvent.click(screen.getByTestId('line-saved-undo')) })
    await waitFor(() => expect(patches()).toHaveLength(2))
    expect(patches()[1]).toEqual(['/api/kitchen-batches/kb-1/inputs/kbi-mega', { qty: '412.000', qty_unit: 'g', note: null }])
  })

  it('Take it out: the row stays struck through with Undo, which restores it', async () => {
    renderDetail({ inputs: [MEGATRON_LINE] })
    fireEvent.click(screen.getByTestId('line-row-kbi-mega'))
    await act(async () => { fireEvent.click(screen.getByTestId('line-sheet-take-out')) })
    expect(fetchMock.mock.calls.some(([p, o]) => p === '/api/kitchen-batches/kb-1/inputs/kbi-mega' && o?.method === 'DELETE')).toBe(true)
    const out = screen.getByTestId('line-taken-out')
    expect(out.textContent).toBe('Megatron jalapeño · Taken outUndo')
    await act(async () => { fireEvent.click(screen.getByTestId('line-taken-out-undo-kbi-mega')) })
    expect(posts(/\/restore$/).map(p => p[0])).toEqual(['/api/kitchen-batches/kb-1/inputs/kbi-mega/restore'])
  })

  // 06 §3.11: a pick line is hard-deleted, so its Undo re-adds it with every stored field, fresh key.
  it('a pick line\'s Undo re-adds it with its fields under a fresh key', async () => {
    renderDetail({ inputs: [PICK_LINE] })
    fireEvent.click(screen.getByTestId('line-row-kbi-pick'))
    await act(async () => { fireEvent.click(screen.getByTestId('line-sheet-take-out')) })
    await act(async () => { fireEvent.click(screen.getByTestId('line-taken-out-undo-kbi-pick')) })
    const [, body] = posts(/\/inputs$/)[0]
    expect(body.inputs[0].idempotency_key).toMatch(UUID)
    expect({ ...body.inputs[0], idempotency_key: 'K' }).toEqual({ input_kind: 'harvest', idempotency_key: 'K', harvest_log_id: 'h-9',
      label: 'Serranos', qty: '230', qty_unit: 'g', ordinal: 2, plant_id: 'p-ser' })
    expect(posts(/\/restore$/)).toHaveLength(0)
  })
})

// gardening.md Reward UX: ambient recognition only — words, an aria-hidden leaf, no badge, count, sum,
// %, animation or celebratory copy. MUTATION: add a count ("2 from the garden") -> the digit arm reds.
describe('"from the garden" is ambient', () => {
  it('says it in words on the line and in one header line, with the leaf hidden from screen readers', () => {
    renderDetail({ batch: { garden_names: ['Megatron jalapeño', 'Serranos'] }, inputs: [MEGATRON_LINE, PICK_LINE] })
    const header = screen.getByTestId('what-went-in-garden')
    expect(header.textContent).toBe('🌿 From the garden: Megatron jalapeño, Serranos')
    expect(header.querySelector('[aria-hidden="true"]').textContent).toBe('🌿 ')
    const marks = screen.getAllByTestId('line-row-garden')
    expect(marks.map(m => m.textContent)).toEqual([' · 🌿 from the garden', ' · 🌿 from the garden'])
    for (const m of marks) expect(m.querySelector('[aria-hidden="true"]')).toBeTruthy()
    const garden = [header, ...marks].map(e => e.textContent).join(' ')
    expect(garden).not.toMatch(/\d|%|!|great|nice|well done/i)
    expect(header.style.fontWeight || '').not.toBe('700')
  })
  it('is absent when nothing came from the garden', () => {
    renderDetail({ inputs: [LINE({ id: 'kbi-o', input_kind: 'other', label: 'onion' })] })
    expect(screen.queryByTestId('what-went-in-garden')).toBeNull()
    expect(screen.queryByTestId('line-row-garden')).toBeNull()
  })
})

// ⚠ AMENDED FOR THE PUT-UP UX PASS R1 (D2) in the same commit as the change. This census pinned ONE required
// input at open on a batch that already had a line; the add row now sits behind "+ Add what went in" on such
// a batch, so the pin is the four cases below (and a fifth for the path the ferment walks take). Each is
// the full list of required inputs, never its length.
// MUTATION M4: derive the add row's visibility from `lines.length === 0` on every render (no remembered
// "opened") -> "opened, it … stays open" reds at its first arm (the door does nothing), and "a batch that
// opened with nothing written down" reds after its first Add — the same stop `gate:putup-ferment` makes at
// the second line of four of its five walks.
describe('the census (06 §4, V4 §6.3 — fails on any increase)', () => {
  const required = () => [...screen.getByTestId('batch-detail-view').querySelectorAll('[aria-required="true"]')].map(e => e.getAttribute('data-testid'))
  it('a batch with NO lines opens with the adder shown: one required input', () => {
    renderDetail({ inputs: [] })
    expect(required()).toEqual(['line-add-name'])
    expect(screen.queryByTestId('line-add-open')).toBeNull()
  })
  it('a batch WITH lines opens collapsed: nothing required, one door, the chips still there', () => {
    renderDetail({ inputs: [MEGATRON_LINE] })
    expect(required()).toEqual([])
    expect(screen.queryByTestId('line-add-name')).toBeNull()
    expect(screen.getByTestId('line-add-open').textContent).toBe('+ Add what went in')
    expect(screen.getByTestId('line-add-open').style.minHeight).toBe('48px')
    expect(screen.getByTestId('what-went-in-water')).toBeTruthy()
    expect(screen.getByTestId('what-went-in-salt')).toBeTruthy()
  })
  it('opened, it asks exactly one thing, and stays open across an Add and the re-read that follows', async () => {
    const view = renderDetail({ inputs: [MEGATRON_LINE] })
    fireEvent.click(screen.getByTestId('line-add-open'))
    expect(required()).toEqual(['line-add-name'])
    expect(document.activeElement).toBe(name())                       // the door lands in the name field
    await search('ser')
    fireEvent.click(screen.getByTestId('line-add-hit-planting:p-mega'))
    await add()
    await waitFor(() => expect(posts(/\/inputs$/)).toHaveLength(1))
    // The page's re-read, on the same mounted view: mid-read, then with the new line in hand.
    view.rerender(detailEl({ inputs: [MEGATRON_LINE], refreshing: true }, view.onChanged))
    expect(required()).toEqual(['line-add-name'])
    view.rerender(detailEl({ inputs: [MEGATRON_LINE, PICK_LINE] }, view.onChanged))
    expect(required()).toEqual(['line-add-name'])
    expect(screen.queryByTestId('line-add-open')).toBeNull()
    // …and the next line goes in with no door to tap again.
    fireEvent.change(name(), { target: { value: 'garlic' } })
    await add()
    await waitFor(() => expect(posts(/\/inputs$/)).toHaveLength(2))
  })
  it('a batch that opened with nothing written down keeps its adder across the first Add and its re-read', async () => {
    const view = renderDetail({ inputs: [] })
    fireEvent.change(name(), { target: { value: 'onion' } })
    await add()
    await waitFor(() => expect(posts(/\/inputs$/)).toHaveLength(1))
    view.rerender(detailEl({ inputs: [LINE({ id: 'kbi-new', input_kind: 'other', label: 'onion' })] }, view.onChanged))
    // INSTRUMENT: the re-read really carried a line — this is no longer a batch with nothing written down.
    expect(screen.getAllByTestId('line-row-text').map(n => n.textContent)).toEqual(['onion'])
    expect(required()).toEqual(['line-add-name'])
    expect(screen.queryByTestId('line-add-open')).toBeNull()
  })
  it('Water on a collapsed adder opens it with the Water preset', async () => {
    renderDetail({ inputs: [MEGATRON_LINE] })
    await act(async () => { fireEvent.click(screen.getByTestId('what-went-in-water')) })
    expect(screen.getByTestId('line-add-qty')).toBeTruthy()
    expect(name().value).toBe('Water')
    expect(screen.getByTestId('line-add-unit-ml').getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByTestId('line-add-open')).toBeNull()
  })
  it('the line sheet requires nothing', () => {
    renderDetail({ inputs: [MEGATRON_LINE] })
    fireEvent.click(screen.getByTestId('line-row-kbi-mega'))
    expect(screen.getByTestId('line-sheet').querySelectorAll('[aria-required="true"]')).toHaveLength(0)
  })
})
