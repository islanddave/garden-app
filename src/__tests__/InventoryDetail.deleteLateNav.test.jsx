// BUG-INVDETAILDELETELATENAV-001 — a delete that answers AFTER he has left the page takes him nowhere.
//
// handleDelete awaited the delete and then navigated, whatever had happened meanwhile. With the answer
// still out he could press Back, or open another lot from header Search (the page is keyed on the lot id,
// so that unmounts this one), and the late answer then navigated all the same: navigate(-1) from wherever
// he now stood, or a replace onto My seeds over the lot he had just opened. The same late-landing shape
// AddToLot and SaveSeedSheet closed with `aliveRef` (`closed`), and the same answer here.
// Pinned here:
//   • the page gone before the answer (unmounted, or re-keyed onto another lot): the delete still went
//     out, once, and nothing navigates;
//   • the page still there: it leaves as before, for a seed lot and for any other item.
// Harness shape follows InventoryDetail.deleteRefusal.test.jsx. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'

const { fetchSpy, navigateSpy, updateItemSpy, deleteItemSpy, route } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  updateItemSpy: vi.fn(),
  deleteItemSpy: vi.fn(),
  route: { id: 'inv-1' },
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...r }) => <a href={typeof to === 'string' ? to : '#'} {...r}>{children}</a>,
  useParams: () => ({ id: route.id }),
  useNavigate: () => navigateSpy,
}))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <span /> }))
vi.mock('../components/PhotoUpload.jsx', () => ({ default: () => <span data-testid="photo-upload" /> }))
vi.mock('../components/forms/PlantingSelect.jsx', () => ({ default: () => <span data-testid="planting-select" /> }))
vi.mock('../hooks/useInventory.js', () => ({
  useInventory: () => ({ updateItem: updateItemSpy, deleteItem: deleteItemSpy }),
}))

import InventoryDetail from '../pages/InventoryDetail.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

const PACKET = {
  id: 'inv-1', name: 'Black Hungarian (Pepper)', category: 'seeds', type: 'consumable',
  status: 'active', quantity_on_hand: 1, unit: 'packet', reorder_threshold: null,
  reorder_quantity: null, notes: null, source: null, source_url: null, purchase_date: null,
  unit_cost: null, quantity_purchased: null, location_text: null, brand: null, model: null, tags: [],
  variety_id: 'v-bh', variety_name: 'Black Hungarian', source_plant_id: null,
  seed_stage: null, seed_process: null, metadata: null,
  germination: { rate: null, seeds_sown: 0, seeds_germinated: 0, sowings: [] }, sown_from: [],
}
const OTHER = { ...PACKET, id: 'inv-2', name: 'Fish (Pepper)', variety_id: 'v-fish', variety_name: 'Fish' }
const ROWS = { 'inv-1': PACKET, 'inv-2': OTHER }

// The delete's answer, held until the test lets it land.
let land
beforeEach(() => {
  fetchSpy.mockReset(); navigateSpy.mockReset(); updateItemSpy.mockReset(); deleteItemSpy.mockReset()
  route.id = 'inv-1'
  deleteItemSpy.mockImplementation(() => new Promise((resolve) => { land = resolve }))
  fetchSpy.mockImplementation((path, opts) => {
    const m = /^\/api\/inventory-items\/(inv-\d)$/.exec(String(path))
    if (m && !opts) return Promise.resolve({ ...ROWS[m[1]] })
    return Promise.resolve([])
  })
  window.history.replaceState(null, '')
})
afterEach(() => { window.history.replaceState(null, '') })

const page = () => <ToastProvider><InventoryDetail /></ToastProvider>
const renderPage = async (row = PACKET) => {
  let view
  await act(async () => { view = render(page()) })
  await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(row.name))
  return view
}
const tapRemove = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Remove item' }))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove' })) })
  expect(deleteItemSpy.mock.calls).toEqual([['inv-1']])
}

describe('a delete that answers after the page is gone', () => {
  it('he left the page (Back): the delete went out once and the late answer navigates nowhere', async () => {
    const view = await renderPage()
    await tapRemove()
    view.unmount()
    await act(async () => { land({ ok: true }) })
    expect(deleteItemSpy).toHaveBeenCalledTimes(1)
    expect(navigateSpy).not.toHaveBeenCalled()
  })

  it('he opened another lot meanwhile: the late answer does not take him off that lot', async () => {
    const view = await renderPage()
    await tapRemove()
    route.id = 'inv-2'
    await act(async () => { view.rerender(page()) })
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(OTHER.name))
    await act(async () => { land({ ok: true }) })
    expect(navigateSpy).not.toHaveBeenCalled()
    // Still on the lot he opened, and it is not mid-delete: the answer belonged to the other page.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(OTHER.name)
    expect(screen.queryByTestId('inventory-remove-dialog')).toBeNull()
  })

  it('a late REFUSAL is the same: nothing navigates', async () => {
    const view = await renderPage()
    await tapRemove()
    view.unmount()
    await act(async () => { land({ error: 'Request timed out' }) })
    expect(navigateSpy).not.toHaveBeenCalled()
  })
})

describe('a delete that answers while the page is still there leaves it, as before', () => {
  it('a seed lot goes to My seeds', async () => {
    await renderPage()
    await tapRemove()
    expect(navigateSpy).not.toHaveBeenCalled()
    await act(async () => { land({ ok: true }) })
    expect(navigateSpy).toHaveBeenCalledTimes(1)
    expect(navigateSpy.mock.calls[0][1]).toEqual({ replace: true })
  })

  it('any other item goes to the inventory list', async () => {
    const tool = { ...PACKET, name: 'Hori hori', category: 'tools', type: 'durable', variety_id: null, variety_name: null }
    ROWS['inv-1'] = tool
    try {
      await renderPage(tool)
      await tapRemove()
      await act(async () => { land({ ok: true }) })
      expect(navigateSpy.mock.calls).toEqual([['/inventory']])
    } finally { ROWS['inv-1'] = PACKET }
  })
})
