// Put-Up release 4 — Put it up on a batch made from a recipe (V4 §3.1/§3.2; Dave 2026-09-30): the first row
// defaults its container and "Cooked after blending" from the recipe's final container (defaults the person
// can change), and the preview line takes the recipe rung — "from the recipe: <name>", with no duration — only
// at a place of the recipe's storage kind; typed still beats it. The PutUpPutItUp.test.jsx harness.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }), apiFetch: (...a) => fetchMock(...a) }))
const auth = { user: { id: 'user_dave' } }
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => auth }))

import PutItUpSheet from '../components/putup/PutItUpSheet.jsx'

const NOW = new Date('2026-10-09T15:00:00').getTime()
const RECIPE = { id: 'r1', name: 'Roll for Initiative', keeps_n: 7, keeps_unit: 'day', keeps_storage_kind: 'fridge',
  bottle_label: '8 oz woozy', bottle_size: '8', bottle_unit: 'fl oz', bottle_cooked: true, lines: [] }
const BATCH = { id: 'kb-mojo', user_id: 'user_dave', label: 'Mojo', kind: 'ferment', started_at: new Date('2026-10-01T09:00:00').toISOString(),
  start_precision: 'day', first_recorded_at: new Date('2026-10-01T09:00:00').toISOString(), closed_at: null, suspended_at: null,
  recipe_id: 'r1', recipe: RECIPE, outputs: [] }
const PLACES = [
  { id: 'loc-fridge', user_id: 'user_dave', label: 'Fridge', kind: 'fridge' },
  { id: 'loc-cf1', user_id: 'user_dave', label: 'Chest Freezer 1', kind: 'deep_freezer' },
]
const JAR = { id: 'pl-1', label: 'Mojo', preserved_at: '2026-10-09', preserved_at_precision: 'day', use_by_target: '2026-10-16', use_by_basis: 'recipe' }
const tap = (id) => act(async () => { fireEvent.click(screen.getByTestId(id)) })

beforeEach(() => {
  fetchMock.mockReset(); localStorage.clear()
  fetchMock.mockImplementation((path) => {
    if (path === '/api/storage-locations') return Promise.resolve(PLACES)
    if (/\/put-up$/.test(path)) return Promise.resolve({ stage: { id: 'ksl-1' }, jars: [JAR], inputs: [], batch: {} })
    return Promise.resolve(null)
  })
})

async function open(batch = BATCH) {
  render(<MemoryRouter><PutItUpSheet open batch={batch} lines={[]} now={NOW} onClose={() => {}} onDone={() => {}} onChanged={() => {}} /></MemoryRouter>)
  await waitFor(() => expect(screen.getByTestId('putup-row-0-place-id:loc-fridge')).toBeTruthy())
}

describe('Put it up from a recipe', () => {
  it('row 1 defaults to the recipe\'s bottle and "cooked after blending" — and the defaults alone are not a draft', async () => {
    await open()
    expect(screen.getByTestId('putup-row-0-summary').textContent).toContain('8 oz woozy')
    await tap('putup-row-0-more')
    expect(screen.getByTestId('putup-row-0-cooked').getAttribute('aria-pressed')).toBe('true')
    expect(localStorage.getItem('garden:putup-draft:v1:user_dave:putup:kb-mojo')).toBeNull()
  })

  it('the preview takes the recipe rung at a fridge, the table in the freezer; the body carries the defaults', async () => {
    await open()
    await tap('putup-when-today')
    await tap('putup-method-hot_sauce')
    await tap('putup-row-0-place-id:loc-fridge')
    const line = screen.getByTestId('putup-preview-line').textContent
    expect(line).toMatch(/discard by .+ · from the recipe: Roll for Initiative/)
    expect(line).not.toMatch(/7 day/)
    await tap('putup-row-0-place-id:loc-cf1')
    expect(screen.getByTestId('putup-preview-line').textContent).toMatch(/general figure/)
    await tap('putup-row-0-place-id:loc-fridge')
    await tap('putup-finish')
    await waitFor(() => expect(fetchMock.mock.calls.some(([p]) => /\/put-up$/.test(p))).toBe(true))
    const [, o] = fetchMock.mock.calls.find(([p]) => /\/put-up$/.test(p))
    expect(JSON.parse(o.body).rows[0]).toMatchObject({ container_label: '8 oz woozy', size_value: 8, size_unit: 'fl oz', cooked: true })
  })

  it('a batch with no recipe keeps the shipped empty first row', async () => {
    await open({ ...BATCH, recipe_id: null, recipe: undefined })
    expect(screen.getByTestId('putup-row-0-summary').textContent).not.toContain('woozy')
  })
})
