// V5-SEEDLOTADDITION-001 (seed release 3) — FLAG OFF, the lot page (contract T27, the flag-off half).
// SEED_ADD_TO_LOT false is this release's forward undo: the Saved from card is release 2b's card, a
// plant is removed and put back exactly as before, and the "still says" line is never drawn.
// ONE static mock in T20's form: SEED_MULTI_PARENT on, SEED_ADD_TO_LOT off. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'

const { fetchSpy, itemRef } = vi.hoisted(() => ({ fetchSpy: vi.fn(), itemRef: { current: null } }))

vi.mock('../lib/featureFlags.js', async (o) => ({ ...(await o()), SEED_MULTI_PARENT: true, SEED_ADD_TO_LOT: false }))
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

import { addToLotAvailable } from '../components/seed/seedAdditions.js'

describe('SEED_ADD_TO_LOT off — Saved from is release 2b\'s card', () => {
  it('the one reader answers off', () => {
    expect(addToLotAvailable()).toBe(false)
  })

  it('removing a plant from a counted lot strikes its row and says nothing about the count; Undo puts it back', async () => {
    await mount(lot())
    await removeFirst()
    await waitFor(() => expect(setWrites().length).toBe(1))
    expect(struckRows().length).toBe(1)
    expect(stillSays()).toEqual([])
    expect(document.body.textContent).not.toMatch(/The lot still says/)
    // The write is the one release 2b sends: the set without the plant, and the set it was read as.
    expect(JSON.parse(setWrites()[0][1].body)).toEqual({ source_plant_ids: [P1B.id], expected_source_plant_ids: [P1.id, P1B.id] })
    await undo()
    await waitFor(() => expect(setWrites().length).toBe(2))
    await waitFor(() => expect(struckRows().length).toBe(0))
    expect(stillSays()).toEqual([])
  })

  it('the D5 wording is not behind the flag: the card still says "lot"', async () => {
    await mount(lot())
    expect(screen.getByTestId('saved-from-mixed').textContent)
      .toBe('Mixed together. A seed from this lot could be from either planting.')
    expect(document.body.textContent).not.toMatch(/\bjars?\b/i)
  })
})
