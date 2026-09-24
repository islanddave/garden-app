// BUG-INVDELETEERROROFFSCREEN-001 + BUG-INVREFSTRAND-001 — a refused delete says why WHERE THE TAP WAS.
//
// handleDelete used to close the "Remove item?" dialog and write the reason to the form banner, which
// sits above the whole form: on a phone the dialog vanished and nothing changed near the finger. Since
// the server now answers 409 with a sentence for Dave ("This packet can't be removed: 1 planting was
// sown from it. …") that tells him what to do instead, a reason nobody sees is the whole feature lost.
// Pinned here:
//   • the dialog STAYS OPEN on any delete error, and the reason is INSIDE it, directly above its
//     buttons, as role="alert" — not in the form banner, and shown once;
//   • nothing navigates; "Keep it" closes and forgets the reason; reopening starts clean; a retry that
//     succeeds still leaves the page;
//   • the "Remove item" control sits on the 44px tap floor (the layout gate measures the real box;
//     jsdom can only read the declared style).
// Harness shape follows InventoryDetail.seedExits.test.jsx. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'

const { fetchSpy, navigateSpy, updateItemSpy, deleteItemSpy } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  updateItemSpy: vi.fn(),
  deleteItemSpy: vi.fn(),
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
import { T } from '../components/forms/formStyles.js'

const PACKET = {
  id: 'inv-1', name: 'Black Hungarian (Pepper)', category: 'seeds', type: 'consumable',
  status: 'active', quantity_on_hand: 1, unit: 'packet', reorder_threshold: null,
  reorder_quantity: null, notes: null, source: null, source_url: null, purchase_date: null,
  unit_cost: null, quantity_purchased: null, location_text: null, brand: null, model: null, tags: [],
  variety_id: 'v-bh', variety_name: 'Black Hungarian', source_plant_id: null,
  seed_stage: null, seed_process: null, metadata: null,
  germination: { rate: null, seeds_sown: 0, seeds_germinated: 0, sowings: [] }, sown_from: [],
}

// The server's sentence, verbatim — the page renders whatever deleteItem hands back.
const REFUSAL = 'This packet can\'t be removed: 1 archived planting was sown from it. To mark it used up, set its Status to "depleted" instead.'

beforeEach(() => {
  fetchSpy.mockReset(); navigateSpy.mockReset(); updateItemSpy.mockReset(); deleteItemSpy.mockReset()
  updateItemSpy.mockResolvedValue({ item: { ...PACKET } })
  deleteItemSpy.mockResolvedValue({ error: REFUSAL })
  fetchSpy.mockImplementation((path, opts) => {
    if (String(path) === '/api/inventory-items/inv-1' && !opts) return Promise.resolve({ ...PACKET })
    return Promise.resolve([])
  })
  window.history.replaceState(null, '')
})
afterEach(() => { window.history.replaceState(null, '') })

const renderPage = async () => {
  await act(async () => { render(<ToastProvider><InventoryDetail /></ToastProvider>) })
  await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(PACKET.name))
}
const dialog = () => screen.queryByTestId('inventory-remove-dialog')
const openDialog = () => fireEvent.click(screen.getByRole('button', { name: 'Remove item' }))
const confirmRemove = async () => {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove' })) })
}

describe('a refused delete keeps the dialog open and says why beside its buttons', () => {
  it('the 409 sentence renders INSIDE the dialog, as an alert, directly above the Remove / Keep it row', async () => {
    await renderPage()
    openDialog()
    await confirmRemove()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(REFUSAL)
    // The dialog is still up — the finger is still on it.
    expect(dialog()).not.toBeNull()
    expect(screen.getByRole('heading', { name: 'Remove item?' })).toBeTruthy()
    // Inside it, and immediately before the button row (the element holding Remove and Keep it).
    expect(dialog().contains(alert)).toBe(true)
    const row = alert.nextElementSibling
    expect(row && row.contains(screen.getByRole('button', { name: 'Remove' }))).toBe(true)
    expect(row.contains(screen.getByRole('button', { name: 'Keep it' }))).toBe(true)
    expect(deleteItemSpy.mock.calls).toEqual([['inv-1']])
    expect(navigateSpy).not.toHaveBeenCalled()
  })

  it('says it ONCE — the form banner above the fields no longer carries delete errors', async () => {
    await renderPage()
    openDialog()
    await confirmRemove()
    await screen.findByRole('alert')
    const hits = [...document.body.querySelectorAll('*')]
      .filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.includes('can\'t be removed')))
    expect(hits).toHaveLength(1)
    expect(dialog().contains(hits[0])).toBe(true)
  })

  it('ANY delete error lands there, not only the 409 (a timeout, say)', async () => {
    deleteItemSpy.mockResolvedValue({ error: 'Request timed out' })
    await renderPage()
    openDialog()
    await confirmRemove()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('Request timed out')
    expect(dialog().contains(alert)).toBe(true)
  })

  it('"Keep it" closes the dialog and forgets the reason; reopening starts clean', async () => {
    await renderPage()
    openDialog()
    await confirmRemove()
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }))
    expect(dialog()).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    openDialog()
    expect(dialog()).not.toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a retry that succeeds still leaves the page (the refusal did not wedge the flow)', async () => {
    await renderPage()
    openDialog()
    await confirmRemove()
    await screen.findByRole('alert')
    deleteItemSpy.mockResolvedValue({ ok: true })
    await confirmRemove()
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledTimes(1))
    expect(deleteItemSpy).toHaveBeenCalledTimes(2)
  })

  it('no refusal, no alert: a clean delete shows nothing and navigates', async () => {
    deleteItemSpy.mockResolvedValue({ ok: true })
    await renderPage()
    openDialog()
    await confirmRemove()
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('the "Remove item" control is a real tap target', () => {
  it('declares the house 44px floor (T.tapMinHeight) and stays a non-submitting button', async () => {
    await renderPage()
    const btn = screen.getByTestId('inventory-remove')
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.getAttribute('type')).toBe('button')
    expect(btn.textContent).toBe('Remove item')
    expect(T.tapMinHeight).toBe(44)
    expect(btn.style.minHeight).toBe(`${T.tapMinHeight}px`)
  })
})
