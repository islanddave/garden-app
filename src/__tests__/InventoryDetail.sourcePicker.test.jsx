// V4-SOURCEREG-001 — the source registry on the inventory EDIT path (wiring surface 3 of 3).
//
// WHY THIS FILE EXISTS AT ALL. Wiring /inventory/add without wiring this page would leave every
// item that already exists — which is all of them — stranded on the free text that produced the 73
// spellings, with no way to move one onto the registry. The add form alone is half a migration.
//
// The PUT is a wide full-row overwrite whose two new columns ride the `hasOwnProperty` -> CASE
// escape hatch (inventory-items/index.js:943-952), so PRESENCE of the key is what says "use this
// value". These tests therefore assert the KEYS ARE PRESENT in the changes object, not merely that
// the values look right: an omission would leave the stored column untouched and read, from the UI,
// exactly like a save that worked.
//
// EVERY NEEDLE IS UNIQUE — 'Fedco', 'Greenfield' and 'Botanical' are absent from the item fixture,
// whose own strings ('Neem oil', 'shed shelf', 'order no. 350019') collide with none of them.
// No jest-dom (L-182): plain DOM reads.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

const { fetchSpy, navigateSpy, updateItemSpy, deleteItemSpy } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  updateItemSpy: vi.fn(),
  deleteItemSpy: vi.fn(),
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useParams: () => ({ id: 'inv-1' }),
  useNavigate: () => navigateSpy,
}))
vi.mock('../hooks/useInventory.js', () => ({
  useInventory: () => ({ updateItem: updateItemSpy, deleteItem: deleteItemSpy }),
}))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <span /> }))
vi.mock('../components/PhotoUpload.jsx', () => ({ default: () => <span data-testid="photo-upload" /> }))

import InventoryDetail from '../pages/InventoryDetail.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import { clearReloadBlocks } from '../lib/reloadGate.js'

const SOURCES = [
  { id: 'src-botanical', name: 'Botanical Interests', kind: 'seed_company', locality: 'Broomfield, CO', address: null, website_url: null, notes: null },
  { id: 'src-fedco', name: 'Fedco Seeds', kind: 'seed_company', locality: 'Clinton, ME', address: null, website_url: null, notes: null },
  { id: 'src-coop', name: 'Greenfield Farmers Co-op', kind: 'garden_center', locality: 'Greenfield, MA', address: null, website_url: null, notes: null },
]

// A row as GET /:id returns it — `SELECT i.*`, so both FK columns are on it. `source` carries the
// free text that has no other column anywhere in this design; it is the thing that must SURVIVE.
const ITEM = {
  id: 'inv-1', name: 'Neem oil', type: 'consumable', category: 'amendment',
  status: 'active', quantity_on_hand: 2, unit: 'oz', notes: 'shed shelf',
  source: 'order no. 350019', source_url: null, brand: null, model: null,
  purchase_date: '2026-03-04', source_id: null, acquired_from_source_id: null,
}

const withRow = (extra) => ({ ...ITEM, ...extra })

let row
beforeEach(() => {
  fetchSpy.mockReset(); navigateSpy.mockReset()
  updateItemSpy.mockReset(); deleteItemSpy.mockReset()
  updateItemSpy.mockResolvedValue({ item: ITEM })
  row = ITEM
  fetchSpy.mockImplementation(path => {
    if (path === '/api/inventory-items/inv-1') return Promise.resolve(row)
    if (path === '/api/varieties/sources') return Promise.resolve(SOURCES)
    if (path === '/api/varieties/source-kinds') return Promise.resolve([])
    return Promise.resolve(null)
  })
  clearReloadBlocks()
})

async function renderPage(item) {
  if (item) row = item
  let out
  await act(async () => { out = render(<ToastProvider><InventoryDetail /></ToastProvider>) })
  await waitFor(() => expect(screen.getByLabelText('Name')).toBeTruthy())
  return out
}

async function openPicker(testid) {
  const input = screen.getByTestId(testid)
  const root = input.parentElement
  fireEvent.focus(input)
  await waitFor(() => expect(root.querySelector('[data-testid="sp-panel"]')).not.toBe(null))
  return { input, root, opt: (id) => root.querySelector(`[data-testid="${testid}-opt-${id}"]`) }
}

const save = async () => { await act(async () => { fireEvent.click(screen.getByText('Save changes')) }) }
const changes = () => updateItemSpy.mock.calls[0][1]

describe('InventoryDetail — the edit path got the same three fields', () => {
  it('renders the picker inline and KEEPS the free text, relabelled', async () => {
    await renderPage()
    const origin = screen.getByTestId('inv-detail-origin')
    expect(origin.getAttribute('role')).toBe('combobox')
    expect(origin.getAttribute('aria-label')).toBe('Origin')

    // The old bare "Source" label is gone; its input is not.
    const labels = Array.from(document.querySelectorAll('label')).map(l => l.textContent.trim())
    expect(labels.filter(t => t === 'Source').length).toBe(0)
    expect(labels.filter(t => t.includes('Order / lot reference')).length).toBe(1)
    const ref = screen.getByLabelText('Order / lot reference')
    expect(ref.value).toBe('order no. 350019')
  })

  it('an item that ALREADY has an origin mounts BOTH pickers and still issues one GET', async () => {
    // The reported case, at the page level: the venue picker is gated on source_id, so a row that
    // has one mounts both pickers in the SAME commit and the second request lands inside
    // useSources' dedupe window. /inventory/add cannot exhibit this — there the venue picker
    // appears only after you pick an origin, by which time the window has closed and a second GET
    // is correct. Hook-level arms (join, window-closes, shared rejection) are in useSources.test.js.
    await renderPage(withRow({ source_id: 'src-fedco' }))
    // A picker WITH a value renders its chip, not the combobox — so the two instances are asserted
    // through different handles. Both are still SourcePicker mounts, which is what costs a GET.
    expect(await screen.findByTestId('inv-detail-origin-chip')).toBeTruthy()
    expect(screen.getByTestId('inv-detail-acquired-from')).toBeTruthy()

    const gets = fetchSpy.mock.calls.filter(c => !c[1] && c[0] === '/api/varieties/sources')
    expect(gets.length).toBe(1)
  })

  it('choosing an origin puts source_id in the SUBMITTED changes, and the free text still submits its own value', async () => {
    await renderPage()
    const origin = await openPicker('inv-detail-origin')
    fireEvent.click(origin.opt('src-fedco'))
    await screen.findByTestId('inv-detail-origin-chip')

    await save()
    expect(updateItemSpy).toHaveBeenCalledTimes(1)
    expect(changes().source_id).toBe('src-fedco')
    // Untouched, and still carrying the fact no column models.
    expect(changes().source).toBe('order no. 350019')
  })

  it('sends BOTH keys on every save — presence is what the CASE arms read', async () => {
    await renderPage()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Neem oil concentrate' } })
    await save()
    const c = changes()
    expect(Object.prototype.hasOwnProperty.call(c, 'source_id')).toBe(true)
    expect(Object.prototype.hasOwnProperty.call(c, 'acquired_from_source_id')).toBe(true)
    expect(c.source_id).toBe(null)
    expect(c.acquired_from_source_id).toBe(null)
  })

  it('a stored origin comes back BY NAME and its venue picker is on screen at first paint', async () => {
    await renderPage(withRow({ source_id: 'src-coop', acquired_from_source_id: 'src-botanical' }))
    const originChip = await screen.findByTestId('inv-detail-origin-chip')
    expect(originChip.textContent).toContain('Greenfield Farmers Co-op')
    const venueChip = screen.getByTestId('inv-detail-acquired-from-chip')
    expect(venueChip.textContent).toContain('Botanical Interests')

    await save()
    expect(changes().source_id).toBe('src-coop')
    expect(changes().acquired_from_source_id).toBe('src-botanical')
  })

  it('clearing a stored origin sends an explicit null for BOTH — a real clear, not a no-op', async () => {
    await renderPage(withRow({ source_id: 'src-coop', acquired_from_source_id: 'src-botanical' }))
    await screen.findByTestId('inv-detail-origin-chip')

    fireEvent.click(screen.getByRole('button', { name: 'Clear origin' }))
    await waitFor(() => expect(screen.queryByTestId('inv-detail-acquired-from')).toBe(null))
    expect(screen.queryByTestId('inv-detail-acquired-from-chip')).toBe(null)

    await save()
    expect(changes().source_id).toBe(null)
    expect(changes().acquired_from_source_id).toBe(null)
  })
})

describe('InventoryDetail — conditionality and the distinct guard', () => {
  it('the venue picker is ABSENT with no origin and PRESENT once one is chosen', async () => {
    await renderPage()
    expect(screen.queryByTestId('inv-detail-acquired-from')).toBe(null)

    const origin = await openPicker('inv-detail-origin')
    fireEvent.click(origin.opt('src-botanical'))

    const acq = await screen.findByTestId('inv-detail-acquired-from')
    expect(acq.getAttribute('aria-label')).toBe('Acquired from')
  })

  it('blocks the save when both name the SAME source (chk_inventory_source_distinct)', async () => {
    await renderPage(withRow({ source_id: 'src-fedco', acquired_from_source_id: 'src-fedco' }))
    await screen.findByTestId('inv-detail-acquired-from-chip')

    await save()
    expect(updateItemSpy).not.toHaveBeenCalled()
    const alerts = Array.from(document.querySelectorAll('[role="alert"]'))
      .filter(n => n.textContent.includes('Same as the origin'))
    expect(alerts.length).toBe(1)
    const venueField = Array.from(document.querySelectorAll('label'))
      .find(l => l.textContent.includes('Acquired from')).parentElement
    expect(venueField.contains(alerts[0])).toBe(true)
  })

  it('changing the ORIGIN clears the pair error — it is resolvable from either end', async () => {
    await renderPage(withRow({ source_id: 'src-fedco', acquired_from_source_id: 'src-fedco' }))
    await screen.findByTestId('inv-detail-acquired-from-chip')
    await save()
    expect(updateItemSpy).not.toHaveBeenCalled()

    fireEvent.click(screen.getAllByRole('button', { name: 'Change' })[0])
    const origin = await openPicker('inv-detail-origin')
    fireEvent.click(origin.opt('src-coop'))
    await waitFor(() => expect(
      Array.from(document.querySelectorAll('[role="alert"]'))
        .filter(n => n.textContent.includes('Same as the origin')).length).toBe(0))

    await save()
    expect(changes().source_id).toBe('src-coop')
    expect(changes().acquired_from_source_id).toBe('src-fedco')
  })
})
