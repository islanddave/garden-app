// V4-SEEDHISTORY-001 — the seed_stage control on /inventory/:id, and what it puts on the wire.
//
// WHY THIS CONTROL EXISTS. The wide PUT has accepted `seed_stage` under a hasOwnProperty presence
// guard since v4-seedsaveflow-001, `null` included as the deliberate clear — and no UI had ever put
// that key in a body, so the documented capability was reachable only by hand-crafting an HTTP
// request. It is not a convenience: seed_lot_stage_log has no DELETE route, so a mis-tapped stage
// on /seeds/saved is permanent and moving this pointer is the ONLY way to say where a lot really is.
//
// WHY THE PAYLOAD IS THE SUBJECT AND NOT THE CLICK. The wide PUT is "replace all editable fields" —
// every column in its SET list is assigned unconditionally, so a body that omits a field NULLS it.
// A stage-only write is therefore not a partial update, it is a wipe of the name, type, category
// and every quantity. So each test here asserts the BODY, not that a request happened: "it saved"
// is true of the destructive implementation too.
//
// THE buildChanges() SEPARATION IS PROVED TWO WAYS, deliberately, because each alone is weak.
// Structurally: handleSave is the only caller of buildChanges() and it writes through
// useInventory.updateItem, so an untouched updateItem spy proves this write did not take that path.
// Behaviourally: an UNSAVED edit typed into the form must not reach the server on a stage change —
// which is the observable consequence, and the one that would still catch a re-plumbed
// implementation that reached buildChanges() by another route.
// No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'

const { fetchSpy, updateItemSpy, deleteItemSpy, itemRef } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  updateItemSpy: vi.fn(),
  deleteItemSpy: vi.fn(),
  itemRef: { current: null },
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...r }) => <a href={typeof to === 'string' ? to : '#'} {...r}>{children}</a>,
  useParams: () => ({ id: 'inv-1' }),
  useNavigate: () => vi.fn(),
}))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <span /> }))
vi.mock('../components/PhotoUpload.jsx', () => ({ default: () => <span data-testid="photo-upload" /> }))
vi.mock('../components/forms/PlantingSelect.jsx', () => ({ default: () => <span data-testid="planting-select" /> }))
vi.mock('../hooks/useInventory.js', () => ({
  useInventory: () => ({ updateItem: updateItemSpy, deleteItem: deleteItemSpy }),
}))

import InventoryDetail from '../pages/InventoryDetail.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

// As GET /api/inventory-items/:id returns it: the raw columns, plus the three keys that route adds
// and that are NOT columns on the row. `metadata` is on this fixture on purpose — the wide PUT's
// SET list deliberately never names it (BUG-INVMETADROP-001's asymmetry), which makes it a clean
// marker for "the whole server row was round-tripped" rather than a form projection.
const LOT = {
  id: 'inv-1', name: 'Green Flesh Honeydew', category: 'seeds', type: 'consumable',
  status: 'active', quantity_on_hand: 1, unit: 'packet', reorder_threshold: null,
  reorder_quantity: null, notes: 'Saved from the 2026 melon', source: 'Self-saved',
  source_url: null, purchase_date: null, unit_cost: null, quantity_purchased: null,
  location_text: 'Seed tin', brand: null, model: null, tags: ['melon'],
  variety_id: 'v-melon', variety_name: 'Green Flesh', source_plant_id: 'pl-melon',
  seed_stage: 'drying', seed_process: 'wet', metadata: { sku: 'GF-2026' },
  featured_photo_id: 'ph-derived', featured_photo_view_url: 'https://example.invalid/x.jpg',
  featured_is_explicit: false, germination: { rate: null, seeds_sown: 0, seeds_germinated: 0, sowings: [] },
}

const putCalls = () => fetchSpy.mock.calls.filter(([p, o]) =>
  String(p) === '/api/inventory-items/inv-1' && o?.method === 'PUT')
const putBody = () => {
  const calls = putCalls()
  expect(calls, 'no PUT was issued').toHaveLength(1)
  return JSON.parse(calls[0][1].body)
}

let putFails = false

beforeEach(() => {
  fetchSpy.mockReset(); updateItemSpy.mockReset(); deleteItemSpy.mockReset()
  itemRef.current = { ...LOT }
  putFails = false
  updateItemSpy.mockResolvedValue({ item: { ...LOT } })
  fetchSpy.mockImplementation((path, opts) => {
    const p = String(path)
    if (p === '/api/inventory-items/inv-1' && opts?.method === 'PUT') {
      return putFails
        ? Promise.reject(new Error('Network unreachable'))
        : Promise.resolve({ ...itemRef.current, ...JSON.parse(opts.body) })
    }
    if (p === '/api/inventory-items/inv-1/seed-stage') return Promise.resolve([])
    if (p === '/api/inventory-items/inv-1' && !opts) return Promise.resolve(itemRef.current)
    return Promise.resolve([])
  })
})

const renderPage = async () => {
  await act(async () => { render(<ToastProvider><InventoryDetail /></ToastProvider>) })
  await waitFor(() => expect(screen.getByTestId('seed-stage-select')).toBeTruthy())
}

const stageSelect = () => screen.getByTestId('seed-stage-select')
const chooseStage = async (value) => {
  await act(async () => { fireEvent.change(stageSelect(), { target: { value } }) })
}

describe('InventoryDetail — the seed_stage control (V4-SEEDHISTORY-001)', () => {
  it('offers exactly the CHECK vocabulary plus a clear, in process order', async () => {
    await renderPage()
    // The DB CHECK is the authority (inventory_items_seed_stage_check); inventing a fourth value
    // here would 400 at the handler and 23514 at the constraint. The leading '' is the clear.
    expect([...stageSelect().options].map(o => o.value))
      .toEqual(['', 'fermenting', 'drying', 'stored'])
    expect(stageSelect().value).toBe('drying')
  })

  it('does NOT render for a non-seed item', async () => {
    itemRef.current = {
      ...LOT, name: 'Hori hori knife', category: 'tools', type: 'durable',
      variety_id: null, seed_stage: null, seed_process: null, quantity: 1,
    }
    await act(async () => { render(<ToastProvider><InventoryDetail /></ToastProvider>) })
    await waitFor(() => expect(screen.getByText('Hori hori knife')).toBeTruthy())
    expect(screen.queryByTestId('seed-stage-select')).toBeNull()
  })

  it('writes the stage WITHOUT going through buildChanges()', async () => {
    await renderPage()
    // An unsaved edit sitting in the form. If this write were buildChanges() output, `name` would
    // arrive as the typed value — a stage change would silently commit an edit the user has not
    // pressed Save on.
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'TYPED BUT NOT SAVED' } })
    await chooseStage('stored')

    const body = putBody()
    expect(body.name).toBe('Green Flesh Honeydew')
    expect(body.seed_stage).toBe('stored')
    // Structural half: handleSave is the only caller of buildChanges(), and it writes through
    // updateItem. An untouched spy means this write did not take that path.
    expect(updateItemSpy).not.toHaveBeenCalled()
    // …and the payload is the whole server row, not a form projection: `metadata` is a column the
    // edit form neither renders nor emits.
    expect(body.metadata).toEqual({ sku: 'GF-2026' })
  })

  it('sends a COMPLETE body — the wide PUT nulls every field it does not name', async () => {
    await renderPage()
    await chooseStage('stored')
    const body = putBody()
    // Every bare-assigned column in the handler's SET list. Omitting any one of these is not a
    // partial update, it is data loss with a 200 on it.
    expect(body.name).toBe('Green Flesh Honeydew')
    expect(body.type).toBe('consumable')
    expect(body.category).toBe('seeds')
    expect(body.status).toBe('active')
    expect(body.quantity_on_hand).toBe(1)
    expect(body.unit).toBe('packet')
    expect(body.notes).toBe('Saved from the 2026 melon')
    expect(body.source).toBe('Self-saved')
    expect(body.location_text).toBe('Seed tin')
    expect(body.tags).toEqual(['melon'])
  })

  it('OMITS the presence-guarded keys, so the handler preserves them', async () => {
    await renderPage()
    await chooseStage('stored')
    const body = putBody()
    // These three are written through `CASE WHEN hasOwnProperty(...)`. Omitting is the guaranteed
    // no-op; MENTIONING them is an assignment, which is a different thing:
    //   variety_id        — validateUpdate 400s on category:'seeds' with an explicit null
    //   featured_photo_id — the GET returns the DERIVED hero, not the stored pointer
    //   seed_process      — decided when the lot entered the pipeline, not by a stage correction
    expect(body).not.toHaveProperty('variety_id')
    expect(body).not.toHaveProperty('featured_photo_id')
    expect(body).not.toHaveProperty('seed_process')
    // Derived, not columns — noise in a write body.
    expect(body).not.toHaveProperty('germination')
    expect(body).not.toHaveProperty('variety_name')
    expect(body).not.toHaveProperty('featured_photo_view_url')
  })

  it('CLEARS by sending an explicit null, never an omitted key', async () => {
    // The handler reads this by PRESENCE: an omitted key means "leave the stage alone" and null
    // means "clear it". Sending the wrong one fails silently from the user's side — the select
    // shows "not tracked" and the lot is still stored — which is why the body shape is asserted
    // rather than just the request happening.
    await renderPage()
    await chooseStage('')
    const body = putBody()
    expect(Object.prototype.hasOwnProperty.call(body, 'seed_stage')).toBe(true)
    expect(body.seed_stage).toBeNull()
    expect(stageSelect().value).toBe('')
  })

  it('does not write when the value did not change', async () => {
    // '' and null both mean "no stage". Comparing them raw would fire a full-row PUT every time
    // the placeholder was re-selected on an untracked lot.
    itemRef.current = { ...LOT, seed_stage: null }
    await renderPage()
    await chooseStage('')
    expect(putCalls()).toHaveLength(0)
  })

  it('reverts and says so when the write fails', async () => {
    // Optimistic, so a failure that left the select showing the new stage would read as saved for
    // the rest of the session and be wrong after a reload — with the lot's real stage unrecoverable
    // from the screen.
    putFails = true
    await renderPage()
    await chooseStage('stored')
    await waitFor(() =>
      expect(screen.getByTestId('seed-stage-help').textContent).toContain('Network unreachable'))
    expect(stageSelect().value).toBe('drying')
  })

  it('round-trips the SAVED row after a page save, not the pre-save one', async () => {
    // `item` is the load-time snapshot and handleSave deliberately does not refresh it, so a stage
    // change made after a save would otherwise re-send stale values through a PUT that assigns them
    // unconditionally — reverting the edit that had just landed.
    updateItemSpy.mockResolvedValue({ item: { ...LOT, name: 'Green Flesh Honeydew (2026)' } })
    await renderPage()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Green Flesh Honeydew (2026)' } })
    await act(async () => { fireEvent.click(screen.getByText('Save changes')) })
    await waitFor(() => expect(updateItemSpy).toHaveBeenCalled())

    await chooseStage('stored')
    expect(putBody().name).toBe('Green Flesh Honeydew (2026)')
  })

  it('refuses a response that is not this row, rather than mirroring it', async () => {
    // A truthy-but-wrong PUT body ([], {}, an envelope) taken as the server mirror would be
    // round-tripped by the NEXT stage write — which is exactly the short payload that wipes the
    // row. Falling back to the previous mirror costs at most a stale field.
    fetchSpy.mockImplementation((path, opts) => {
      const p = String(path)
      if (p === '/api/inventory-items/inv-1' && opts?.method === 'PUT') return Promise.resolve([])
      if (p === '/api/inventory-items/inv-1/seed-stage') return Promise.resolve([])
      if (p === '/api/inventory-items/inv-1' && !opts) return Promise.resolve(itemRef.current)
      return Promise.resolve([])
    })
    await renderPage()
    await chooseStage('stored')
    await chooseStage('fermenting')
    const bodies = putCalls().map(c => JSON.parse(c[1].body))
    expect(bodies).toHaveLength(2)
    // The second write still carries the whole row, not the empty array that came back.
    expect(bodies[1].name).toBe('Green Flesh Honeydew')
    expect(bodies[1].type).toBe('consumable')
    expect(bodies[1].seed_stage).toBe('fermenting')
  })

  it('does not append a history entry — corrections move the pointer, they do not rewrite it', async () => {
    // POST /seed-stage is what records a stage. This control deliberately does not: a correction
    // that logged itself would make stage_entered_at the time of the correction rather than the
    // time the lot entered the stage, which is the number /seeds/saved orders its whole queue by
    // (BUG-SEEDELAPSEDUPDATED-001).
    await renderPage()
    await chooseStage('stored')
    expect(fetchSpy.mock.calls.some(([p, o]) =>
      String(p) === '/api/inventory-items/inv-1/seed-stage' && o?.method === 'POST')).toBe(false)
  })
})
