// V5-SEEDSTAB-001 — the exits from a seed row's detail page: breadcrumb, Cancel, and delete.
//
// Seed left the Inventory list for its own Seeds page, so every "back to Inventory" exit on a seed
// row became a dead end: the list it lands on no longer shows the lot. Seed rows now leave to
// Seeds › My seeds, and two of the exits have a wrong version that looks identical on screen:
//   • CANCEL goes BACK (navigate(-1)) when a Seeds view pushed this page — read once, at mount, off
//     window.history.state.usr.seedsReturn — so the view comes back with its filters and scroll. Any
//     other arrival (a bookmark, Search, a reload that dropped state) has nothing to go back TO, and
//     pushes My seeds instead.
//   • DELETE never leaves a way Back onto the lot just removed: pushed by a Seeds view it goes BACK
//     (a replace there left two identical Seeds entries, so the next Back did nothing); any other
//     arrival REPLACES onto My seeds.
// Every other category is unchanged, and pinned here as such: '/inventory' breadcrumb and Cancel
// link, delete -> navigate('/inventory').
// Harness shape follows InventoryDetail.seedStageControl.test.jsx. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'

const { fetchSpy, navigateSpy, updateItemSpy, deleteItemSpy, itemRef } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  updateItemSpy: vi.fn(),
  deleteItemSpy: vi.fn(),
  itemRef: { current: null },
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...r }) => <a href={typeof to === 'string' ? to : '#'} {...r}>{children}</a>,
  useParams: () => ({ id: 'inv-1' }),
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
import { seedsReturnState } from '../lib/seedsRoutes.js'

const MINE = '/seeds?view=mine'
const SAVED = '/seeds?view=saved'

const LOT = {
  id: 'inv-1', name: 'Green Flesh Honeydew', category: 'seeds', type: 'consumable',
  status: 'active', quantity_on_hand: 1, unit: 'packet', reorder_threshold: null,
  reorder_quantity: null, notes: 'Saved from the 2026 melon', source: 'Self-saved',
  source_url: null, purchase_date: null, unit_cost: null, quantity_purchased: null,
  location_text: 'Seed tin', brand: null, model: null, tags: ['melon'],
  variety_id: 'v-melon', variety_name: 'Green Flesh', source_plant_id: 'pl-melon',
  seed_stage: 'drying', seed_process: 'wet', metadata: null,
  germination: { rate: null, seeds_sown: 0, seeds_germinated: 0, sowings: [] },
}
const TOOL = {
  ...LOT, name: 'Hori hori knife', category: 'tools', type: 'durable', quantity: 1,
  variety_id: null, variety_name: null, source_plant_id: null, seed_stage: null, seed_process: null,
}

const ITEM_PATH = '/api/inventory-items/inv-1'

// The history entry as BrowserRouter leaves it after a Seeds view pushed this page with
// state={seedsReturnState(url)}: location.state lives under `usr`.
const arriveFrom = (seedsUrl) => window.history.replaceState({ usr: seedsReturnState(seedsUrl), key: 'k1', idx: 2 }, '')

beforeEach(() => {
  fetchSpy.mockReset(); navigateSpy.mockReset(); updateItemSpy.mockReset(); deleteItemSpy.mockReset()
  itemRef.current = { ...LOT }
  updateItemSpy.mockResolvedValue({ item: { ...LOT } })
  deleteItemSpy.mockResolvedValue({ ok: true })
  fetchSpy.mockImplementation((path, opts) => {
    if (String(path) === ITEM_PATH && !opts) return Promise.resolve(itemRef.current)
    return Promise.resolve([])
  })
  window.history.replaceState(null, '')
})

afterEach(() => { window.history.replaceState(null, '') })

const renderPage = async () => {
  await act(async () => { render(<ToastProvider><InventoryDetail /></ToastProvider>) })
  await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(itemRef.current.name))
}

const seedCancel = () => screen.getByTestId('inventory-detail-cancel')

async function removeItem() {
  fireEvent.click(screen.getByRole('button', { name: 'Remove item' }))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove' })) })
  await waitFor(() => expect(deleteItemSpy).toHaveBeenCalledTimes(1))
}

describe('a seed row leaves to Seeds, not to the Inventory list', () => {
  it('the breadcrumb is Seeds › <lot>, pointing at My seeds', async () => {
    await renderPage()
    const crumb = screen.getByRole('link', { name: 'Seeds' })
    expect(crumb.getAttribute('href')).toBe(MINE)
    expect(crumb.parentElement.textContent).toBe('Seeds › Green Flesh Honeydew')
    expect(screen.queryByRole('link', { name: 'Inventory' })).toBeNull()
  })

  it('Cancel is a real button that does not submit, and there is no /inventory Cancel link', async () => {
    await renderPage()
    const c = seedCancel()
    expect(c.tagName).toBe('BUTTON')
    expect(c.getAttribute('type')).toBe('button')
    expect(c.textContent).toBe('Cancel')
    expect(screen.queryByRole('link', { name: 'Cancel' })).toBeNull()
  })
})

describe('seed-row Cancel — Back to the Seeds view that opened the page, else My seeds', () => {
  it('pushed by a Seeds view: goes BACK, so the view returns as it was left', async () => {
    arriveFrom(SAVED)
    await renderPage()
    fireEvent.click(seedCancel())
    expect(navigateSpy.mock.calls).toEqual([[-1]])
  })

  it('arrived any other way: pushes My seeds — there is nothing to go back to', async () => {
    await renderPage()
    fireEvent.click(seedCancel())
    expect(navigateSpy.mock.calls).toEqual([[MINE]])
  })

  it('the arrival is read ONCE, at mount: a later rewrite of the entry does not move Cancel', async () => {
    // It describes the entry the page arrived on. Both directions, so neither "always Back" nor
    // "never Back" satisfies this case.
    arriveFrom(MINE)
    await renderPage()
    window.history.replaceState(null, '')
    fireEvent.click(seedCancel())
    expect(navigateSpy.mock.calls).toEqual([[-1]])
  })

  it('…and an entry that gains seedsReturn after mount does not turn Cancel into a Back', async () => {
    await renderPage()
    arriveFrom(MINE)
    fireEvent.click(seedCancel())
    expect(navigateSpy.mock.calls).toEqual([[MINE]])
  })

  it('on an EDITED form it saves nothing — Cancel abandons the edit', async () => {
    await renderPage()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Green Flesh Honeydew (2026)' } })
    await act(async () => { fireEvent.click(seedCancel()) })
    expect(navigateSpy.mock.calls).toEqual([[MINE]])
    expect(updateItemSpy).not.toHaveBeenCalled()
  })
})

describe('deleting a seed row never leaves Back pointing at the dead page', () => {
  it('arrived any other way: replaces to My seeds', async () => {
    await renderPage()
    await removeItem()
    expect(deleteItemSpy.mock.calls[0][0]).toBe('inv-1')
    expect(navigateSpy.mock.calls).toEqual([[MINE, { replace: true }]])
  })

  it('pushed by a Seeds view: goes BACK to it — a replace would stack two identical Seeds entries and make the next Back a dead press', async () => {
    arriveFrom(SAVED)
    await renderPage()
    await removeItem()
    expect(navigateSpy.mock.calls).toEqual([[-1]])
  })

  it('a FAILED delete goes nowhere and says why', async () => {
    deleteItemSpy.mockResolvedValue({ error: 'Server said no' })
    await renderPage()
    await removeItem()
    await waitFor(() => expect(screen.getByText(/Server said no/)).toBeTruthy())
    expect(navigateSpy).not.toHaveBeenCalled()
  })
})

describe('every other category is unchanged', () => {
  beforeEach(() => { itemRef.current = { ...TOOL } })

  it('the breadcrumb is Inventory › <item>, pointing at /inventory', async () => {
    await renderPage()
    const crumb = screen.getByRole('link', { name: 'Inventory' })
    expect(crumb.getAttribute('href')).toBe('/inventory')
    expect(crumb.parentElement.textContent).toBe('Inventory › Hori hori knife')
    expect(screen.queryByRole('link', { name: 'Seeds' })).toBeNull()
  })

  it('Cancel is the /inventory link, with no seed-row button — even when a Seeds view pushed the page', async () => {
    arriveFrom(MINE)
    await renderPage()
    expect(screen.getByRole('link', { name: 'Cancel' }).getAttribute('href')).toBe('/inventory')
    expect(screen.queryByTestId('inventory-detail-cancel')).toBeNull()
  })

  it('delete navigates to /inventory, as a plain push', async () => {
    await renderPage()
    await removeItem()
    expect(navigateSpy.mock.calls).toEqual([['/inventory']])
  })
})
