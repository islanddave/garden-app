// V4-SEEDSTOREDQTY-001 — the count prompt behind the seed_stage control on /inventory/:id.
//
// WHY THIS PATH NEEDS ONE TOO. A seed lot is created on 0 (the seed is still wet when you save it),
// and the count is asked at the one moment it is knowable: the move into `stored`. The advance sheet
// on /seeds/saved is one way to make that move; this select is the OTHER, and it is wider — it can
// jump to `stored` from any stage, including from a lot that was never tracked at all. A path that
// reaches `stored` without ever asking leaves the lot on 0, where Sow now reads it as depleted. So
// this file is about that path specifically, not about the prompt's chrome.
//
// THE PAYLOAD IS THE SUBJECT, same as the stage tests beside it: there is no narrow quantity route,
// so the count rides the wide PUT, where every column in the SET list is assigned unconditionally. A
// body that omits a field NULLS it, so "it saved" is true of the destructive implementation too.
//
// AND THE FORM RE-SYNC IS LOAD-BEARING, not tidiness. The edit form below renders quantity_on_hand
// and buildChanges() sends it unconditionally, so a form left holding the pre-count value would
// overwrite the number on the next "Save changes" — a silent revert of what the user just entered.
// No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'

const { fetchSpy, updateItemSpy, deleteItemSpy, itemRef } = vi.hoisted(() => ({
  fetchSpy: vi.fn(), updateItemSpy: vi.fn(), deleteItemSpy: vi.fn(), itemRef: { current: null },
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

// As GET /api/inventory-items/:id returns it. quantity_on_hand 0 is the state a lot saved off a
// plant is actually in until it is counted, which is what this prompt exists to end.
const LOT = {
  id: 'inv-1', name: 'Green Flesh Honeydew', category: 'seeds', type: 'consumable',
  status: 'active', quantity_on_hand: 0, unit: 'packet', reorder_threshold: null,
  reorder_quantity: null, notes: 'From the 2026 melon', source: 'Self-saved', source_url: null,
  purchase_date: null, unit_cost: null, quantity_purchased: null, location_text: 'Seed tin',
  brand: null, model: null, tags: ['melon'], metadata: { sku: 'GF-2026' },
  variety_id: 'v-melon', variety_name: 'Green Flesh', source_plant_id: 'pl-melon',
  seed_stage: 'drying', seed_process: 'wet',
  featured_photo_id: 'ph-derived', featured_photo_view_url: 'https://example.invalid/x.jpg',
  featured_is_explicit: false, germination: { rate: null, seeds_sown: 0, seeds_germinated: 0, sowings: [] },
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
const chooseStage = async (value) => {
  await act(async () => { fireEvent.change(screen.getByTestId('seed-stage-select'), { target: { value } }) })
}
const typeCount = async (v) => {
  await act(async () => { fireEvent.change(screen.getByTestId('seed-count-input'), { target: { value: v } }) })
}
const puts = () => fetchSpy.mock.calls.filter(([p, o]) =>
  String(p) === '/api/inventory-items/inv-1' && o?.method === 'PUT')
const countPutBody = () => {
  const all = puts()
  expect(all.length, 'expected a stage PUT followed by a count PUT').toBe(2)
  return JSON.parse(all[1][1].body)
}

describe('V4-SEEDSTOREDQTY-001 — the stage control asks for a count on stored', () => {
  it('asks after a move to stored, and never on the other stages', async () => {
    await renderPage()
    expect(screen.queryByTestId('seed-count-ask')).toBeNull()
    await chooseStage('fermenting')
    expect(screen.queryByTestId('seed-count-ask')).toBeNull()
    await chooseStage('stored')
    expect(screen.getByTestId('seed-count-ask')).toBeTruthy()
  })

  it('closes the prompt again if the stage is corrected off stored', async () => {
    await renderPage()
    await chooseStage('stored')
    expect(screen.getByTestId('seed-count-ask')).toBeTruthy()
    await chooseStage('drying')
    expect(screen.queryByTestId('seed-count-ask')).toBeNull()
  })

  it('does not ask when the stage write FAILED — there is nothing stored to count', async () => {
    // The select is optimistic-with-revert, so asking on the click rather than on the landing would
    // collect a count against a stage that is not on the server.
    putFails = true
    await renderPage()
    await chooseStage('stored')
    await waitFor(() =>
      expect(screen.getByTestId('seed-stage-help').textContent).toContain('Network unreachable'))
    expect(screen.queryByTestId('seed-count-ask')).toBeNull()
  })

  it('writes the count as its OWN request, complete-bodied, with the stage omitted', async () => {
    await renderPage()
    await chooseStage('stored')
    await typeCount('14')
    await act(async () => { fireEvent.click(screen.getByTestId('seed-count-save')) })

    const body = countPutBody()
    expect(body.quantity_on_hand).toBe(14)
    // The wide PUT nulls what it is not given. `type` is the quiet one: the handler writes
    // `quantity_on_hand = ${isConsumable ? … : null}`, so a body without it nulls the very column
    // this request exists to set.
    expect(body.type).toBe('consumable')
    expect(body.name).toBe('Green Flesh Honeydew')
    expect(body.unit).toBe('packet')
    expect(body.tags).toEqual(['melon'])
    expect(body.metadata).toEqual({ sku: 'GF-2026' })
    // Presence-guarded: mentioning is an assignment, so omission is the guaranteed no-op.
    expect(body).not.toHaveProperty('seed_stage')
    expect(body).not.toHaveProperty('variety_id')
    expect(body).not.toHaveProperty('featured_photo_id')
    // Never through buildChanges()/updateItem — that is the form's projection and would commit
    // whatever is unsaved in it.
    expect(updateItemSpy).not.toHaveBeenCalled()
  })

  it('does not commit an unsaved form edit along with the count', async () => {
    // The behavioural half of the buildChanges() separation, which the structural spy check alone
    // would not catch if the write were ever re-plumbed through another route.
    await renderPage()
    await chooseStage('stored')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'TYPED BUT NOT SAVED' } })
    await typeCount('14')
    await act(async () => { fireEvent.click(screen.getByTestId('seed-count-save')) })
    expect(countPutBody().name).toBe('Green Flesh Honeydew')
  })

  it('re-syncs the edit form, so the next Save changes cannot revert the count', async () => {
    // THE SILENT-REVERT GUARD. buildChanges() reads form.quantity_on_hand and the wide PUT assigns
    // it unconditionally, so a form still holding "0" would overwrite the 14 on the next save.
    await renderPage()
    expect(screen.getByLabelText('Qty on hand').value).toBe('0')
    await chooseStage('stored')
    await typeCount('14')
    await act(async () => { fireEvent.click(screen.getByTestId('seed-count-save')) })
    expect(screen.getByLabelText('Qty on hand').value).toBe('14')

    await act(async () => { fireEvent.click(screen.getByText('Save changes')) })
    await waitFor(() => expect(updateItemSpy).toHaveBeenCalled())
    expect(updateItemSpy.mock.calls[0][1].quantity_on_hand).toBe(14)
  })

  it('re-baselines with it, so the re-sync does not read as unsaved typing', async () => {
    // form and baseline move together. Moving only `form` would leave the page reporting dirty
    // forever after a count — holding service-worker updates for a value already on the server.
    await renderPage()
    await chooseStage('stored')
    await typeCount('14')
    await act(async () => { fireEvent.click(screen.getByTestId('seed-count-save')) })
    // The count PUT landed and the page is clean: pressing Save changes still sends the same value
    // rather than a stale one, and nothing here is holding a dirty flag on an already-saved number.
    expect(countPutBody().quantity_on_hand).toBe(14)
    expect(screen.getByLabelText('Qty on hand').value).toBe('14')
  })

  it('can be declined — "haven\'t counted it yet" writes nothing', async () => {
    await renderPage()
    await chooseStage('stored')
    await typeCount('14')
    await act(async () => { fireEvent.click(screen.getByTestId('seed-count-skip')) })
    expect(screen.queryByTestId('seed-count-ask')).toBeNull()
    // Only the stage PUT. Declining must not write the typed-then-abandoned number.
    expect(puts()).toHaveLength(1)
    expect(JSON.parse(puts()[0][1].body).seed_stage).toBe('stored')
  })

  it('holds Save until there is a number, and takes a genuine zero', async () => {
    // Blank and 0 are different answers: blank is "I don't know", 0 is "I counted, and there is
    // none". `>= 0` rather than `> 0` is what makes the second one expressible.
    await renderPage()
    await chooseStage('stored')
    expect(screen.getByTestId('seed-count-save').disabled).toBe(true)
    await typeCount('0')
    expect(screen.getByTestId('seed-count-save').disabled).toBe(false)
    await act(async () => { fireEvent.click(screen.getByTestId('seed-count-save')) })
    expect(countPutBody().quantity_on_hand).toBe(0)
  })

  it('refuses a negative count in the client rather than round-tripping it', async () => {
    await renderPage()
    await chooseStage('stored')
    await typeCount('-3')
    await act(async () => { fireEvent.click(screen.getByTestId('seed-count-save')) })
    expect(puts()).toHaveLength(1)   // the stage PUT only
    expect(screen.getByTestId('seed-count-help').textContent).toMatch(/0 or more/)
  })

  it('keeps the prompt open and says why when the count write fails', async () => {
    await renderPage()
    await chooseStage('stored')
    putFails = true
    await typeCount('14')
    await act(async () => { fireEvent.click(screen.getByTestId('seed-count-save')) })
    await waitFor(() =>
      expect(screen.getByTestId('seed-count-help').textContent).toContain('Network unreachable'))
    // Still open on the typed value, so the save is re-tryable — and the stage is untouched, since
    // that write already landed.
    expect(screen.getByTestId('seed-count-input').value).toBe('14')
    expect(screen.getByTestId('seed-stage-select').value).toBe('stored')
  })

  it('does not append a history entry for a count', async () => {
    // POST /seed-stage is what records a stage. Counting is not a stage event.
    await renderPage()
    await chooseStage('stored')
    await typeCount('14')
    await act(async () => { fireEvent.click(screen.getByTestId('seed-count-save')) })
    expect(fetchSpy.mock.calls.some(([p, o]) =>
      String(p) === '/api/inventory-items/inv-1/seed-stage' && o?.method === 'POST')).toBe(false)
  })
})
