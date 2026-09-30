// Put-Up release 1a is the STALE READER of release 1b–4 rows (brief addendum 7; design V4 §4.2, §11).
// Until promote B — and afterwards on any phone that has not refreshed — this bundle's put-up list
// renders jars written by writers it has never heard of: a jar with no size (1b makes the quantity
// pair nullable, both-or-neither), a jar named only by its label (no crop, no variety — 1b relaxes
// attribution to crop | variety | label), a jar whose date is deliberately absent beside one that has
// a date, and columns this bundle has no code for.
//
// The bar is the addendum's: no crash, no "null" / "undefined" / "NaN" anywhere a person can read or
// hear it (text AND the attributes a screen reader speaks), and every row still opens (Edit). The rows
// are shaped the way the Lambda projects them: every column of the row, plus the whats-put-up joins.
//
// AMENDED for B′ release 2: the list is the Pantry (GET /api/pantry, the contract's rows — here each
// record's row, plus a bought item with every optional field empty and no place), and a row opens its
// sheet, which reads the jar by id and says its record words before Edit opens the same editor. The
// photo case is retired with the old row (the Pantry row carries no photo).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  apiFetch: (...args) => fetchMock(...args),
}))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: vi.fn(), isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))
vi.mock('../hooks/useCropTypes.js', () => ({
  useCropTypes: () => ({ cropTypes: [{ slug: 'pepper', display_name: 'Peppers', category: 'vegetable' }], loading: false }),
}))

import PutUp from '../pages/PutUp.jsx'
import { rowFromRecord, itemRow } from './helpers/pantryFake.js'

// The columns 1a has no code for, on every B row (V4 §4.2 1b adds; remaining_amount is release 3).
const B_KEYS = {
  use_by_basis: 'table', label: null, container_label: null, is_raw: null, in_oil: null, texture: null,
  ph_reading: null, ph_read_at: null, put_up_stage_id: null, remaining_amount: null, storage_moved_at: null,
  preserved_at_precision: 'day', idempotency_key: null, batch_id: null,
}
const base = {
  crop_type_slug: 'pepper', variety_id: null, plant_id: null, harvest_log_id: null,
  preserved_at: '2026-10-08', preserved_at_approx: false, method: 'whole_freeze', method_other_text: null,
  quantity_value: 1, quantity_unit: 'bags', package_count: 1, storage_location_id: 'loc-1', use_by_target: null,
  remaining_count: null, consumed_at: null, notes: null, photo_id: null, use_by_status: null,
  source_kind: 'own_garden', source_label: null, deleted_at: null, user_id: 'user_dave',
  created_at: '2026-10-08T15:00:00.000Z', updated_at: '2026-10-08T15:00:00.000Z',
  storage_label: 'Chest Freezer 1', storage_kind: 'deep_freezer', crop_display_name: 'Peppers',
  planting_name: null, planting_sown_at: null, planting_succession_order: null, planting_variety_name: null,
  ...B_KEYS,
}
// 1. No size: the quantity pair is NULL (both-or-neither), counted in bags, a table date, a photo.
const NO_SIZE = { ...base, id: 'b-nosize', quantity_value: null, quantity_unit: null, package_count: 2,
  label: 'Frozen serranos', container_label: 'bag', use_by_target: '2027-07-01', use_by_basis: 'table',
  photo_id: 'ph-1', notes: 'thaw in the fridge' }
// 2. Label only: a Put it up jar from a batch — no crop, no variety, no planting — with its raw/oil
//    answers, a pH at bottling, the sitting it came from, a unit outside 1a's pick-list, and a date
//    deliberately withheld (basis none).
const LABEL_ONLY = { ...base, id: 'b-label', crop_type_slug: null, crop_display_name: null, method: 'hot_sauce',
  label: 'Megatron reaper sauce', container_label: '5 oz woozy', quantity_value: 5, quantity_unit: 'fl oz',
  package_count: 4, remaining_count: 3, is_raw: false, in_oil: false, ph_reading: '3.40',
  ph_read_at: '2026-10-08T15:00:00.000Z', put_up_stage_id: 'st-1', batch_id: 'kb-1',
  use_by_basis: 'none', use_by_target: null }
// 3. The date-bearing neighbour: typed by hand, inside the use-soon window.
const DATED = { ...base, id: 'b-dated', method: 'passata', quantity_value: 1, quantity_unit: 'quarts',
  package_count: 3, remaining_count: 3, use_by_target: '2026-11-01', use_by_basis: 'typed', use_by_status: 'use_soon' }
// 4. Weighed stock (release 3): a dried jar measured in grams left, with its texture.
const WEIGHED = { ...base, id: 'b-weighed', method: 'dehydrate', quantity_value: 250, quantity_unit: 'g',
  texture: 'snaps', remaining_amount: '230.5', use_by_target: '2027-02-01', use_by_basis: 'table' }

const GROUPS = [
  { group_key: 'loc-1', label: 'Chest Freezer 1', storage_location_id: 'loc-1', kind: 'deep_freezer',
    total_packages: 10, units: ['fl oz', 'quarts', 'g'], use_soon_count: 1, records: [NO_SIZE, LABEL_ONLY, DATED, WEIGHED] },
]

const RECORDS = GROUPS[0].records
const CF1 = { id: 'loc-1', label: 'Chest Freezer 1', kind: 'deep_freezer' }
const BARE_ITEM = itemRow({ stock_id: 'b-item', name: 'Sourdough', place: null, group_key: 'none', group_label: 'No place',
  acquired_at: null, discard: { date: null, basis: null, status: null }, created_by: null, updated_at: null })
const ROWS = [...RECORDS.map(r => rowFromRecord({ ...r, stock_mode: r === WEIGHED ? 'weighed' : 'counted' }, CF1)), BARE_ITEM]

function wire() {
  fetchMock.mockImplementation((path, options = {}) => {
    const method = options.method || 'GET'
    if (path.startsWith('/api/pantry?')) return Promise.resolve({ rows: ROWS })
    const rec = RECORDS.find(r => path === `/api/preservation/${r.id}`)
    if (rec && method === 'GET') return Promise.resolve(rec)
    if (path.startsWith('/api/kitchen-batches')) return Promise.resolve({ state: 'going', batches: [] })
    if (path === '/api/storage-locations' && method === 'GET') return Promise.resolve([])
    return Promise.resolve(null)
  })
}

const LEAK = /\b(null|undefined|NaN)\b/
// Everything a person can read or hear: the text, and the attributes a screen reader speaks or a
// control displays. A value attribute counts — an input showing "NaN" is text on screen.
function leaks(root) {
  const found = []
  if (LEAK.test(root.textContent)) found.push(`text: ${root.textContent.match(new RegExp(`.{0,40}${LEAK.source}.{0,40}`))?.[0]}`)
  for (const el of root.querySelectorAll('*')) {
    for (const attr of ['alt', 'aria-label', 'title', 'placeholder']) {
      const v = el.getAttribute(attr)
      if (v && LEAK.test(v)) found.push(`${el.tagName.toLowerCase()}[${attr}="${v}"]`)
    }
    if ('value' in el && typeof el.value === 'string' && LEAK.test(el.value)) found.push(`${el.tagName.toLowerCase()}.value="${el.value}"`)
  }
  return found
}
beforeEach(() => { fetchMock.mockReset(); wire(); sessionStorage.clear() })

describe('the put-up list reads release 1b–4 rows without breaking', () => {
  const opens = () => screen.getAllByTestId(/^pantry-row-open-/)
  it('renders every B-shaped row (and an empty bought item) with no null / undefined / NaN anywhere', async () => {
    const { container } = render(<MemoryRouter initialEntries={['/put-up?view=pantry']}><PutUp /></MemoryRouter>)
    await screen.findByRole('heading', { name: 'Chest Freezer 1' })
    expect(opens()).toHaveLength(5)
    await waitFor(() => expect(leaks(container)).toEqual([]))
  })

  // Rows render in the order the server lists them: no size, label only, dated, weighed.
  it.each([
    ['no size', 'b-nosize'], ['label only', 'b-label'], ['dated neighbour', 'b-dated'], ['weighed stock', 'b-weighed'],
  ])('the %s row still opens, and its sheet and editor show no null / undefined / NaN', async (_name, id) => {
    const { container } = render(<MemoryRouter initialEntries={['/put-up?view=pantry']}><PutUp /></MemoryRouter>)
    fireEvent.click(await screen.findByTestId(`pantry-row-open-put_up:${id}`))
    await screen.findByTestId('row-sheet-record')
    expect(leaks(container.ownerDocument.body)).toEqual([])
    fireEvent.click(screen.getByTestId('row-edit'))
    expect(await screen.findByRole('button', { name: 'Save' })).toBeTruthy()
    expect(leaks(container.ownerDocument.body)).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByTestId('row-edit')).toBeTruthy()
  })

  it('the bare bought item opens too, with nothing unreadable in its sheet or its editor', async () => {
    const { container } = render(<MemoryRouter initialEntries={['/put-up?view=pantry']}><PutUp /></MemoryRouter>)
    fireEvent.click(await screen.findByTestId('pantry-row-open-pantry_item:b-item'))
    fireEvent.click(await screen.findByTestId('row-edit'))
    await screen.findByTestId('item-edit-panel')
    expect(leaks(container.ownerDocument.body)).toEqual([])
  })

  it('INSTRUMENT: the leak check does catch each word, in text and in an attribute', () => {
    const div = document.createElement('div')
    div.innerHTML = '<span>3 null</span>'
    expect(leaks(div)).not.toEqual([])
    div.innerHTML = '<img alt="Photo of undefined put up">'
    expect(leaks(div)).not.toEqual([])
    div.innerHTML = '<input value="NaN">'
    expect(leaks(div)).not.toEqual([])
    div.innerHTML = '<span>Nullify nothing — annulled</span>'
    expect(leaks(div)).toEqual([])
  })
})
