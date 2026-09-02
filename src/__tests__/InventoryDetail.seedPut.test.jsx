// BUG-INVSEEDPUT400-001 — what InventoryDetail actually puts on the wire for a seed packet.
//
// The Lambda half is proved in lambda/inventory-items/put-seed-validate.test.js: the handler 400s
// on `category:'seeds'` with no `variety_id`, before any SQL runs. This file answers the question
// that decides how BAD that is, and it answers it by MEASUREMENT rather than by reading
// buildChanges(): useInventory.updateItem() does not send buildChanges() output directly. It merges
// `{...currentListRow, ...changes}` whenever the row is in its own `/api/inventory-items` list — so
// the wire payload depends on whether that list loaded, and the two cases differ.
//
// Deliberately drives the REAL useInventory. Mocking it — which every other InventoryDetail test in
// this directory does, correctly, for its own purposes — would replace the merge with a spy and make
// this file assert its own stub.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

const { fetchSpy, navigateSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn(), navigateSpy: vi.fn() }))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useParams: () => ({ id: 'inv-seed-1' }),
  useNavigate: () => navigateSpy,
}))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <span /> }))
vi.mock('../components/PhotoUpload.jsx', () => ({ default: () => <span data-testid="photo-upload" /> }))
vi.mock('../components/forms/PlantingSelect.jsx', () => ({ default: () => <span data-testid="planting-select" /> }))

import InventoryDetail from '../pages/InventoryDetail.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

// The Green Flesh Honeydew lot, as GET /api/inventory-items/:id returns it.
const SEED = {
  id: 'inv-seed-1', name: 'Green Flesh Honeydew', type: 'consumable', category: 'seeds',
  status: 'active', quantity_on_hand: 1, unit: 'packet', notes: 'Saved from 2026',
  source: 'Gardens at Mathews', variety_id: 'var-green-flesh', variety_name: 'Green Flesh',
  seed_stage: null, seed_process: null, source_plant_id: null,
}

// `listRows` is what GET /api/inventory-items answers with; `null` makes it REJECT, which is the
// degraded case (offline, an expired token, or simply a Save pressed before the list lands).
function wire({ listRows }) {
  fetchSpy.mockImplementation((path, opts) => {
    if (path === '/api/inventory-items/inv-seed-1' && !opts) return Promise.resolve(SEED)
    if (path === '/api/inventory-items') {
      return listRows ? Promise.resolve(listRows) : Promise.reject(new Error('offline'))
    }
    if (path === '/api/inventory-items/inv-seed-1' && opts?.method === 'PUT') {
      return Promise.resolve({ ...SEED, ...JSON.parse(opts.body) })
    }
    return Promise.resolve(null)
  })
}

const putBody = () => {
  const call = fetchSpy.mock.calls.find(([, o]) => o?.method === 'PUT')
  expect(call, 'no PUT was issued').toBeTruthy()
  return JSON.parse(call[1].body)
}

async function renderAndSave() {
  await act(async () => { render(<ToastProvider><InventoryDetail /></ToastProvider>) })
  await waitFor(() => expect(screen.getByLabelText('Name')).toBeTruthy())
  await act(async () => { fireEvent.click(screen.getByText('Save changes')) })
}

beforeEach(() => { fetchSpy.mockReset(); navigateSpy.mockReset() })

describe('BUG-INVSEEDPUT400-001 — the seed-packet PUT payload', () => {
  it('OMITS variety_id when the inventory list is unavailable — the payload the handler rejected', async () => {
    wire({ listRows: null })
    await renderAndSave()
    const body = putBody()
    expect(body.category).toBe('seeds')
    // The two halves of the rejection, together. This is buildChanges() reaching the wire raw,
    // which is what happens whenever updateItem has no list row to merge against.
    expect(body).not.toHaveProperty('variety_id')
    // PIN INVERTED 2026-09-02 (WAVE 2 S2), deliberately — this assertion used to read
    // `expect(body).not.toHaveProperty('type')`. It was a tripwire, not a spec: it pinned the
    // SECOND half of the degraded payload so that repairing variety_id alone could not be called a
    // heal. buildChanges() now sends `type`, so that half is fixed and the tripwire has fired as
    // designed. It is re-pointed rather than deleted, because the reason it existed has not gone
    // away: `type` is the discriminator the wide PUT reads into isConsumable/isDurable, which gate
    // six further SET-list expressions, so a future refactor that drops it again silently nulls
    // unit / quantity_on_hand / reorder_threshold / reorder_quantity / quantity / condition. This
    // is now the guard on the OTHER side of the same defect, on the same degraded-list path where
    // no merge can supply it.
    expect(body.type).toBe('consumable')
    // variety_id remains unfixed here, and that is the point: this case is still broken, just no
    // longer broken in two ways at once.
  })

  it('DOES carry variety_id when the list loaded — which is why prod has not been screaming', async () => {
    wire({ listRows: [SEED] })
    await renderAndSave()
    const body = putBody()
    expect(body.category).toBe('seeds')
    // updateItem's `{...current, ...changes}` merge supplies variety_id, which buildChanges still
    // omits. That masking is the whole reason a handler guard that rejects every seed packet
    // survived to ship: the ONE caller happens to repair the payload before it is sent.
    expect(body.variety_id).toBe('var-green-flesh')
    // `type` is no longer merge-dependent (WAVE 2 S2) — buildChanges sends it, so both cases now
    // carry it and this assertion holds for the same reason in both.
    expect(body.type).toBe('consumable')
  })
})
