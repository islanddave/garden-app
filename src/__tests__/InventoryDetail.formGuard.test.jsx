// V4-DIRTYGUARDSWEEP-001 — InventoryDetail's half of the dirty-guard contract.
//
// Drives the real reloadGate, never a spy. V4-RELOADGATEWIRE-001 shipped reloadGate.js fully built
// and mutation-proved while nothing in the app ever CALLED setReloadBlocked, and reloadGate.test.js
// stayed green throughout — a primitive's own unit tests cannot see that it has no callers. Spying
// on setReloadBlocked here would rebuild exactly that blind spot.
//
// This page is the one in the sweep whose whole body IS an edit form seeded from the server row, so
// the assertions that matter are the ones a truthiness predicate would fail: a merely-VIEWED item
// must not hold a service-worker update (every box arrives populated), and typing a value back to
// what it was must RELEASE the hold rather than latch.
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
import { isReloadBlocked, clearReloadBlocks } from '../lib/reloadGate.js'

const ITEM = {
  id: 'inv-1', name: 'Neem oil', type: 'consumable', category: 'amendments',
  status: 'active', quantity_on_hand: 2, unit: 'oz', notes: 'shed shelf',
  source: 'Local co-op', brand: null, model: null, purchase_date: '2026-03-04',
}

beforeEach(() => {
  fetchSpy.mockReset(); navigateSpy.mockReset()
  updateItemSpy.mockReset(); deleteItemSpy.mockReset()
  updateItemSpy.mockResolvedValue({ item: ITEM })
  fetchSpy.mockImplementation(path =>
    path === '/api/inventory-items/inv-1' ? Promise.resolve(ITEM) : Promise.resolve(null))
  clearReloadBlocks()
})

async function renderPage() {
  let out
  await act(async () => { out = render(<ToastProvider><InventoryDetail /></ToastProvider>) })
  await waitFor(() => expect(screen.getByLabelText('Name')).toBeTruthy())
  return out
}

const nameBox = () => screen.getByLabelText('Name')
const save = async () => { await act(async () => { fireEvent.click(screen.getByText('Save changes')) }) }

describe('InventoryDetail ↔ dirty guard', () => {
  it('a merely-VIEWED item does not hold the gate', async () => {
    await renderPage()
    // Every box on this page arrives populated from the row — a truthiness predicate would be
    // holding a deploy from the instant the fetch resolved, for a user who only came to look.
    expect(nameBox().value).toBe('Neem oil')
    expect(isReloadBlocked()).toBe(false)
  })

  it('one keystroke holds it, and clearing back to the ORIGINAL releases it', async () => {
    await renderPage()
    fireEvent.change(nameBox(), { target: { value: 'Neem oil concentrate' } })
    await waitFor(() => expect(isReloadBlocked()).toBe(true))
    fireEvent.change(nameBox(), { target: { value: 'Neem oil' } })
    await waitFor(() => expect(isReloadBlocked()).toBe(false))
  })

  it('a field OTHER than name counts too', async () => {
    await renderPage()
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'moved to the barn' } })
    await waitFor(() => expect(isReloadBlocked()).toBe(true))
  })

  it('a SUCCESSFUL save releases the hold', async () => {
    await renderPage()
    fireEvent.change(nameBox(), { target: { value: 'Neem oil concentrate' } })
    await waitFor(() => expect(isReloadBlocked()).toBe(true))
    await save()
    await waitFor(() => expect(updateItemSpy).toHaveBeenCalled())
    await waitFor(() => expect(isReloadBlocked()).toBe(false))
    // …and the typed value is still on screen: this released because the row is now saved, not
    // because the form was reset out from under the user.
    expect(nameBox().value).toBe('Neem oil concentrate')
  })

  it('a FAILED save keeps the hold — the edit is still only in the browser', async () => {
    updateItemSpy.mockResolvedValue({ error: 'Server said no' })
    await renderPage()
    fireEvent.change(nameBox(), { target: { value: 'Neem oil concentrate' } })
    await waitFor(() => expect(isReloadBlocked()).toBe(true))
    await save()
    await waitFor(() => expect(screen.getByText(/Server said no/)).toBeTruthy())
    expect(isReloadBlocked()).toBe(true)
  })

  it('typing DURING an in-flight save is still held once the save lands', async () => {
    let resolveSave
    updateItemSpy.mockImplementation(() => new Promise(r => { resolveSave = r }))
    await renderPage()
    fireEvent.change(nameBox(), { target: { value: 'Neem oil concentrate' } })
    await save()
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'typed while saving' } })
    await act(async () => { resolveSave({ item: ITEM }) })
    // The baseline is the snapshot that was SENT, so the later keystroke is correctly still unsaved.
    await waitFor(() => expect(isReloadBlocked()).toBe(true))
  })

  it('unmounting a dirty page releases the hold', async () => {
    const { unmount } = await renderPage()
    fireEvent.change(nameBox(), { target: { value: 'Neem oil concentrate' } })
    await waitFor(() => expect(isReloadBlocked()).toBe(true))
    act(() => { unmount() })
    expect(isReloadBlocked()).toBe(false)
  })
})
