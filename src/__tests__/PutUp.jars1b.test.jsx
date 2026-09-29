// Put-Up release 1b on the put-up list (V4 §7 1b: "jars show their name, no-size form and date words
// everywhere"; §5.4 "From 1b": the editor stops echoing place/date/method/notes through the legacy
// PUT; §2.5 Move it). Each assertion names the mutation that reds it. CI LANE: `npm test` + TZ re-run.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  apiFetch: (...args) => fetchMock(...args),
}))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: vi.fn(), isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))
vi.mock('../hooks/useCropTypes.js', () => ({ useCropTypes: () => ({ cropTypes: [], loading: false }) }))

import PutUp from '../pages/PutUp.jsx'

// A 1b-shaped jar: a name, a container and no size, an estimated put-up date, a stored basis.
const JAR_1B = {
  id: 'rec-1b', crop_type_slug: null, variety_id: null, plant_id: null, harvest_log_id: null,
  preserved_at: '2026-08-01', preserved_at_precision: 'month', preserved_at_approx: true, method: 'hot_sauce',
  method_other_text: null, quantity_value: null, quantity_unit: null, container_label: '8 oz woozy', package_count: 2,
  storage_location_id: 'loc-fridge', use_by_target: '2027-02-01', use_by_basis: 'table', storage_kind: 'fridge',
  remaining_count: 2, consumed_at: null, notes: null, photo_id: null, use_by_status: 'ok', label: 'Megatron reaper',
  source_kind: null, source_label: null,
}
const PLACES = [{ id: 'loc-fridge', label: 'Fridge', kind: 'fridge' }, { id: 'loc-cf1', label: 'Chest Freezer 1', kind: 'deep_freezer' }]

function wire(rec = JAR_1B) {
  fetchMock.mockImplementation((path, options = {}) => {
    const method = options.method || 'GET'
    if (path === '/api/storage-locations' && method === 'GET') return Promise.resolve(PLACES)
    if (path.startsWith('/api/plants')) return Promise.resolve([])
    if (path.startsWith('/api/kitchen-batches')) return Promise.resolve({ batches: [] })
    if (path.startsWith('/api/preservation/whats-put-up')) {
      return Promise.resolve({ group_by: 'storage', groups: [{ group_key: 'loc-fridge', label: 'Fridge', total_packages: 2,
        units: [], use_soon_count: 0, records: [rec] }] })
    }
    if (path.startsWith('/api/preservation/')) return Promise.resolve({ id: rec.id })
    return Promise.resolve(null)
  })
}
const writes = () => fetchMock.mock.calls.filter(([p, o]) => p.startsWith('/api/preservation/') && o?.method && o.method !== 'GET')
  .map(([p, o]) => [o.method, p, JSON.parse(o.body)])
async function renderList() {
  render(<MemoryRouter initialEntries={['/put-up?view=pantry']}><PutUp /></MemoryRouter>)
  await screen.findByTestId('putup-row-headline')
}

beforeEach(() => {
  fetchMock.mockReset()
  wire()
  sessionStorage.clear(); localStorage.clear()
})

describe('the jar row says its name, its no-size form and its date words', () => {
  it('leads with the name, then the container, never "null"', async () => {
    await renderList()
    expect(screen.getByTestId('putup-row-headline').textContent).toBe('Megatron reaper · 8 oz woozy · Hot sauce')
    expect(document.body.textContent).not.toMatch(/\bnull\b|undefined|NaN/)
  })

  // MUTATION: render preserved_at through the shipped prettyDate for a 1b row -> "Aug 1, 2026" appears.
  it('says the put-up date at its precision and the discard-by in the §3.2 words', async () => {
    await renderList()
    const text = document.body.textContent
    expect(text).toContain('put up sometime in August')
    expect(text).toContain('discard by around Feb 1, 2027 · general figure: hot sauce, fridge')
    expect(text).not.toContain('use by')
  })

  it('a pre-1b row keeps its shipped words', async () => {
    wire({ ...JAR_1B, label: undefined, container_label: undefined, preserved_at_precision: undefined, use_by_basis: undefined,
      quantity_value: '2.5', quantity_unit: 'qt', preserved_at_approx: null })
    await renderList()
    // Its date and use-by words are the shipped ones; its size says "in all" (A3 — two containers).
    expect(screen.getByTestId('putup-row-headline').textContent).toBe('2.5 qt in all · Hot sauce')
    expect(document.body.textContent).toContain('use by Feb 1, 2027')
  })
})

// Contract-F A3 — the zucchini, pinned: 2afee2e3 is 2.5 qt IN TOTAL across 3 containers (Dave), and
// the stored 2.5 is already right; only the words change. MUTATION: drop the "in all" arm of
// jarWords.sizeWords -> the headline reads "2.5 qt · …" beside "3 containers" and this reds.
describe('A3: the zucchini reads as a total', () => {
  const ZUCCHINI = { ...JAR_1B, id: 'rec-zuke', label: null, container_label: null, quantity_value: 2.5, quantity_unit: 'qt',
    package_count: 3, remaining_count: 3, method: 'whole_freeze', preserved_at_precision: null, use_by_basis: null,
    preserved_at: '2026-08-10', preserved_at_approx: null, use_by_target: null }
  it('says "2.5 qt in all" beside "3 containers", never "3 × 2.5 qt"', async () => {
    wire(ZUCCHINI)
    await renderList()
    expect(screen.getByTestId('putup-row-headline').textContent).toBe('2.5 qt in all · Freeze (raw / whole)')
    expect(document.body.textContent).toContain('3 containers')
    expect(document.body.textContent).not.toMatch(/3\s*×\s*2\.5/)
  })
  it('the editor asks for the total', async () => {
    wire(ZUCCHINI)
    await renderList()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(await screen.findByText('How much in all')).toBeTruthy()
  })
})

describe('the row editor writes each field to its one writer (V4 §5.4 "From 1b")', () => {
  const openEditor = async () => {
    await renderList()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    await screen.findByRole('button', { name: 'Save' })
  }

  it('a no-size jar opens on a blank unit, not "lbs"', async () => {
    await openEditor()
    expect(screen.getByRole('combobox', { name: 'Unit' }).value).toBe('')
  })

  // MUTATION: send the method through the PUT -> the PUT arm appears and this literal reds.
  it('a method, name or notes change is a PATCH carrying only what changed', async () => {
    await openEditor()
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Reaper, hot' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Method' }), { target: { value: 'ferment' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Notes' }), { target: { value: 'the good one' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()).toEqual([['PATCH', '/api/preservation/rec-1b', { label: 'Reaper, hot', method: 'ferment', notes: 'the good one' }]])
  })

  // The size is the PATCH's, as a pair (train §6; jarRoutes.js JAR_PATCH_KEYS). MUTATION: send it
  // through the PUT again -> a PUT appears and this literal reds.
  it('a size change is a PATCH carrying the quantity pair, and nothing rides the PUT', async () => {
    await openEditor()
    fireEvent.change(screen.getByRole('textbox', { name: 'Quantity' }), { target: { value: '16' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Unit' }), { target: { value: 'oz' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()).toEqual([['PATCH', '/api/preservation/rec-1b', { quantity_value: '16', quantity_unit: 'oz' }]])
  })

  // The PATCH refuses method_other_text without method (validateJarPatch). MUTATION: send it alone ->
  // the literal loses `method` and reds.
  it('editing only the "other" description re-sends the method it describes', async () => {
    wire({ ...JAR_1B, method: 'other', method_other_text: 'Salt-cured' })
    await openEditor()
    fireEvent.change(screen.getByRole('textbox', { name: 'Method description' }), { target: { value: 'Salt-cured, dried' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0][2]).toEqual({ method: 'other', method_other_text: 'Salt-cured, dried' })
  })

  // MUTATION: PATCH before PUT -> the order literal reds (and live, the PUT's echo of the old method 409s).
  it('a count change and a method change: the PUT goes first, then the PATCH', async () => {
    await openEditor()
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Number of containers' }), { target: { value: '3' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Method' }), { target: { value: 'ferment' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    await waitFor(() => expect(writes()).toHaveLength(2))
    expect(writes().map(w => w[0])).toEqual(['PUT', 'PATCH'])
    expect(writes()[0][2].package_count).toBe(3)
    expect(writes()[0][2].method).toBe('hot_sauce')          // the stored value, an equal echo
    expect(writes()[1][2]).toEqual({ method: 'ferment' })
  })
})

describe('Move it (V4 §2.5, §3.4)', () => {
  // MUTATION: send the move through the legacy PUT's storage_location_id -> the literal reds.
  it('requires a place, defaults When to Today, and posts the move route', async () => {
    await renderList()
    fireEvent.click(screen.getByRole('button', { name: 'Move' }))
    await screen.findByTestId('move-place-id:loc-cf1')
    expect(screen.queryByTestId('move-place-id:loc-fridge')).toBeNull()        // where it already is
    const req = [...screen.getByTestId('move-sheet').querySelectorAll('[aria-required="true"]')]
    expect(req.map(e => e.getAttribute('aria-label'))).toEqual(['Where is Megatron reaper going?'])
    await act(async () => { fireEvent.click(screen.getByTestId('move-save')) })
    expect(screen.getByTestId('move-error').textContent).toBe('Where is it going? Pick a place.')
    fireEvent.click(screen.getByTestId('move-place-id:loc-cf1'))
    await act(async () => { fireEvent.click(screen.getByTestId('move-save')) })
    await waitFor(() => expect(writes()).toHaveLength(1))
    const [method, path, body] = writes()[0]
    expect([method, path]).toEqual(['POST', '/api/preservation/rec-1b/move'])
    expect(body.place).toEqual({ id: 'loc-cf1' })
    expect(body.when.precision).toBe('day')
    await waitFor(() => expect(screen.queryByTestId('move-sheet')).toBeNull())
  })
})

// Release F (06 §1.3, §1.4; contract-F §2.6) — the jar row's uses and its grams.
describe('Mark used / Used up are uses on their own route', () => {
  const uses = () => fetchMock.mock.calls.filter(([p, o]) => p === '/api/pantry/uses' && o?.method === 'POST')
    .map(([, o]) => JSON.parse(o.body))

  // MUTATION: drop the synchronous ref -> two uses post.
  it('a double tap on Used up posts one use of everything that is left', async () => {
    let settle
    fetchMock.mockImplementation((path, options = {}) => {
      if (path === '/api/pantry/uses') return new Promise(r => { settle = r })
      if (path.startsWith('/api/preservation/whats-put-up')) {
        return Promise.resolve({ group_by: 'storage', groups: [{ group_key: 'loc-fridge', label: 'Fridge', total_packages: 2,
          units: [], use_soon_count: 0, records: [JAR_1B] }] })
      }
      if (path.startsWith('/api/kitchen-batches')) return Promise.resolve({ batches: [] })
      return Promise.resolve([])
    })
    await renderList()
    const btn = screen.getByRole('button', { name: 'Used up' })
    act(() => { fireEvent.click(btn); fireEvent.click(btn) })
    expect(uses()).toHaveLength(1)
    expect({ ...uses()[0], idempotency_key: 'K' }).toEqual({ idempotency_key: 'K', preservation_log_id: 'rec-1b', all_remaining: true })
    await act(async () => { settle({ use: {}, jar: {} }) })
  })

  it('each tap mints its own key', async () => {
    await renderList()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Mark used' })) })
    await waitFor(() => expect(uses()).toHaveLength(1))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Mark used' })) })
    await waitFor(() => expect(uses()).toHaveLength(2))
    expect(uses()[0].idempotency_key).not.toBe(uses()[1].idempotency_key)
  })

  it('a refused use says how many are left, in the server\'s words, and writes nothing else', async () => {
    fetchMock.mockImplementation((path, options = {}) => {
      if (path === '/api/pantry/uses') return Promise.reject(Object.assign(new Error('409'), { status: 409, body: { code: 'only_n_left', n: 0, error: 'None are left in that one.' } }))
      if (path.startsWith('/api/preservation/whats-put-up')) {
        return Promise.resolve({ group_by: 'storage', groups: [{ group_key: 'loc-fridge', label: 'Fridge', total_packages: 2,
          units: [], use_soon_count: 0, records: [JAR_1B] }] })
      }
      if (path.startsWith('/api/kitchen-batches')) return Promise.resolve({ batches: [] })
      return Promise.resolve([])
    })
    await renderList()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Mark used' })) })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('None are left — nothing was changed.'))
  })
})

describe('weighed stock says its grams (06 §1.4, boss F2)', () => {
  const BAG = { ...JAR_1B, id: 'rec-reaper', label: 'Reaper, frozen', container_label: 'bag', quantity_value: '100', quantity_unit: 'g',
    package_count: 1, remaining_count: 1, stock_mode: 'weighed', remaining_amount: '92.000', method: 'whole_freeze' }
  // MUTATION: drop the weighed gate -> a counted jar with remaining_amount shows grams and reds.
  it('shows "about 92 g left" on a weighed bag, and not on a counted jar or a used-up bag', async () => {
    wire(BAG)
    await renderList()
    expect(document.body.textContent).toContain('about 92 g left')
    cleanup()
    wire({ ...BAG, stock_mode: 'counted' })
    await renderList()
    expect(document.body.textContent).not.toContain('g left')
    cleanup()
    wire({ ...BAG, remaining_count: 0, remaining_amount: '0' })
    await renderList()
    expect(document.body.textContent).not.toContain('g left')
  })
})
