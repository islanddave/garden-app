// V5-SEEDLOTADDITION-001 (seed release 3) — the lot page, after a plant is taken off a lot that has a
// seed count (contract T27, the flag-on half). The count is one number for the whole lot and is not
// lowered when a plant comes off it, so while that row is struck the card says what the lot still says
// and leaves the number to the person who knows. Both flags are held on by ONE static mock; the
// flag-off half is InventoryDetail.parents.flagOff.test.jsx. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'

const { fetchSpy, itemRef } = vi.hoisted(() => ({ fetchSpy: vi.fn(), itemRef: { current: null } }))

vi.mock('../lib/featureFlags.js', async (importOriginal) => ({
  ...(await importOriginal()), SEED_MULTI_PARENT: true, SEED_ADD_TO_LOT: true,
}))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy, getToken: vi.fn() }) }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...r }) => <a href={typeof to === 'string' ? to : '#'} {...r}>{children}</a>,
  useNavigate: () => vi.fn(),
  useParams: () => ({ id: '00000000-0000-4000-8000-000000000009' }),
}))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <span /> }))
vi.mock('../components/PhotoUpload.jsx', () => ({ default: () => <span data-testid="photo-upload" /> }))
vi.mock('../hooks/useInventory.js', () => ({
  useInventory: () => ({
    updateItem: vi.fn().mockResolvedValue({ item: {} }),
    deleteItem: vi.fn().mockResolvedValue({ ok: true }),
  }),
}))

import InventoryDetail from '../pages/InventoryDetail.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import { UNDO_ARM_MS } from '../components/seed/SavedFromCard.jsx'
import { lotReply, sourcePlantsPutReply, refusal } from './fixtures/seedMix.fixture.js'

// The contract's lot: P1 and P1B are two plantings of one cultivar, so no write here moves the filing.
const CONTRACT_LOT = lotReply()
const [P1, P1B] = CONTRACT_LOT.source_plants
const BY_ID = Object.fromEntries([P1, P1B].map((p) => [p.id, p]))
const ID = CONTRACT_LOT.id
const lot = (over = {}) => lotReply({
  category: 'seeds', type: 'consumable', quantity_on_hand: 1, unit: 'packet', status: 'active',
  name: 'Saved A1 lot', variety_id: P1.variety_id, variety_name: P1.variety_name, variety_rank: 'cultivar',
  breeding_system: P1.breeding_system, source_plant_id: P1.id, source_plants: [P1, P1B],
  seed_parent_plant_count: null, seed_stage: null, source_kind: null,
  seed_count: 150, seed_count_estimated: true, seed_weight_g: null,
  ...over,
})
const SET_PATH = `/api/inventory-items/${ID}/source-plants`
const LOT_PATH = `/api/inventory-items/${ID}`
const setWrites = () => fetchSpy.mock.calls.filter(([p, o]) => String(p) === SET_PATH && o?.method === 'PUT')

let putAnswer
function storeSet(body) {
  const plants = body.source_plant_ids.map((id) => ({ ...BY_ID[id] }))
  const cache = body.source_plant_id ?? plants[0]?.id ?? null
  itemRef.current = { ...itemRef.current, source_plant_id: cache, source_plants: plants }
  return sourcePlantsPutReply({ id: ID, source_plant_id: cache, source_plants: plants })
}
let clock
beforeEach(() => {
  clock = 1_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
  putAnswer = (body) => Promise.resolve(storeSet(body))
  fetchSpy.mockReset()
  fetchSpy.mockImplementation((path, opts) => {
    const p = String(path)
    const method = opts?.method ?? 'GET'
    if (p === SET_PATH && method === 'PUT') return putAnswer(JSON.parse(opts.body))
    if (p === LOT_PATH && method === 'GET') return Promise.resolve(itemRef.current)
    if (p.startsWith('/api/plants?view=picker')) return Promise.resolve([])
    return Promise.resolve([])
  })
})
afterEach(() => { vi.restoreAllMocks() })

async function mount(item) {
  itemRef.current = item
  await act(async () => { render(<ToastProvider><InventoryDetail /></ToastProvider>) })
  await waitFor(() => expect(screen.getAllByTestId('saved-from-row').length).toBe(item.source_plants.length))
}
const removeFirst = () => act(async () => { fireEvent.click(screen.getAllByTestId('saved-from-remove')[0]) })
const undo = async () => {
  clock += UNDO_ARM_MS + 1
  await act(async () => { fireEvent.click(screen.getByTestId('saved-from-undo')) })
}
const struckRows = () => screen.getAllByTestId('saved-from-row').filter((r) => r.getAttribute('data-struck') === 'true')
const stillSays = () => screen.queryAllByTestId('saved-from-still-says')

const line = (label) => `The lot still says ${label}. Change the count if that is no longer right.`

describe('Saved from — "The lot still says …" after a plant is removed (V5-SEEDLOTADDITION-001)', () => {
  it('is not there until a plant is taken off', async () => {
    await mount(lot())
    expect(stillSays()).toEqual([])
  })

  it('reads exactly, with the lot\'s own count words, while the row is struck; and is gone after Undo', async () => {
    await mount(lot())
    await removeFirst()
    await waitFor(() => expect(setWrites().length).toBe(1))
    expect(struckRows().length).toBe(1)
    expect(stillSays().length).toBe(1)
    expect(stillSays()[0].textContent).toBe(line('approx. 150 seeds'))
    await undo()
    await waitFor(() => expect(setWrites().length).toBe(2))
    await waitFor(() => expect(struckRows().length).toBe(0))
    expect(stillSays()).toEqual([])
  })

  it.each([
    ['a hand count', { seed_count: 175, seed_count_estimated: false }, '175 seeds'],
    ['one seed', { seed_count: 1, seed_count_estimated: false }, '1 seed'],
    ['a counted zero', { seed_count: 0, seed_count_estimated: false }, '0 seeds'],
  ])('%s is said in the same words the page uses everywhere', async (_n, over, label) => {
    await mount(lot(over))
    await removeFirst()
    await waitFor(() => expect(stillSays().length).toBe(1))
    expect(stillSays()[0].textContent).toBe(line(label))
  })

  it('is absent when the lot has no count', async () => {
    await mount(lot({ seed_count: null, seed_count_estimated: null }))
    await removeFirst()
    await waitFor(() => expect(struckRows().length).toBe(1))
    expect(stillSays()).toEqual([])
  })

  it('is one line however many rows are struck', async () => {
    await mount(lot())
    await removeFirst()
    await waitFor(() => expect(setWrites().length).toBe(1))
    await removeFirst()
    await waitFor(() => expect(struckRows().length).toBe(2))
    expect(stillSays().length).toBe(1)
  })

  it('a removal the server refuses leaves no strike and no line', async () => {
    const r = refusal('variety_unusable')
    putAnswer = () => Promise.reject(Object.assign(new Error(r.body.error), { status: r.status, body: r.body }))
    await mount(lot())
    await removeFirst()
    await waitFor(() => expect(setWrites().length).toBe(1))
    await waitFor(() => expect(struckRows().length).toBe(0))
    expect(stillSays()).toEqual([])
  })

  it('removing a plant asks nothing of the additions route: the pickings stay with the plant\'s link', async () => {
    await mount(lot())
    await removeFirst()
    await waitFor(() => expect(setWrites().length).toBe(1))
    expect(fetchSpy.mock.calls.filter(([p]) => /seed-additions|seed-lots-open/.test(String(p)))).toEqual([])
    expect(document.body.textContent).not.toMatch(/\bjars?\b/i)
  })
})
