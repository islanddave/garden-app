/**
 * src/__tests__/InventoryDetailCTA.test.jsx
 * VARIETY-REF S4b — Plant-from-packet CTA tests on InventoryDetail.
 *
 * Focused scope: CTA visibility rules + navigation contract.
 * - Visible only when category === 'seeds' AND quantity_on_hand > 0
 * - On click, calls navigate(/garden?source_inventory_item_id=<id>[&variety_id=<vid>]) — V3-IA: Garden hosts the editor now
 *
 * Mocks: useApiFetch, useParams/useNavigate, FavoriteToggle.
 * Strategy mirrors Plants.test.jsx structure.
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

const { fetchSpy, navigateSpy } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
}))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy }),
}))

// Capture params per test via mutable holder
const { paramsRef } = vi.hoisted(() => ({ paramsRef: { current: { id: 'item-seed-1' } } }))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useParams: () => paramsRef.current,
  useNavigate: () => navigateSpy,
}))

vi.mock('../components/FavoriteToggle.jsx', () => ({
  default: () => <span data-testid="favorite-toggle" />,
}))

// V2-PHOTO-F1 S2: stub PhotoUpload — InventoryDetail now mounts one for the
// per-item photo section beneath the S4b CTA.
vi.mock('../components/PhotoUpload.jsx', () => ({
  default: ({ keyPrefix, parentId, linkage }) => (
    <span
      data-testid={`inventory-photo-upload-${parentId ?? 'none'}`}
      data-key-prefix={keyPrefix}
      data-linkage={JSON.stringify(linkage ?? {})}
    />
  ),
}))

// useInventory hook used internally for update/delete — stub the methods to no-op
vi.mock('../hooks/useInventory.js', () => ({
  useInventory: () => ({
    updateItem: vi.fn().mockResolvedValue({ item: {} }),
    deleteItem: vi.fn().mockResolvedValue({ ok: true }),
  }),
}))

import InventoryDetail from '../pages/InventoryDetail.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

const SEED_WITH_STOCK = {
  id: 'item-seed-1',
  name: 'Black Krim seeds',
  type: 'consumable',
  category: 'seeds',
  variety_id: 'var-1',
  quantity_on_hand: 5,
  unit: 'packet',
  status: 'active',
}

const SEED_NO_STOCK = { ...SEED_WITH_STOCK, quantity_on_hand: 0 }
const SEED_NO_VARIETY = { ...SEED_WITH_STOCK, variety_id: null }
const NON_SEED = { ...SEED_WITH_STOCK, category: 'growing_media' }
const DURABLE = { id: 'item-2', name: 'Trowel', type: 'durable', category: 'tools', quantity: 1, status: 'active' }

beforeEach(() => {
  fetchSpy.mockReset()
  // A DEFAULT under the per-test mockResolvedValueOnce chain. V4-SEEDLINK-001 mounts a
  // PlantingSelect on seed packets, which self-fetches /api/plants?view=picker — a SECOND call this
  // spy never saw before, and an unqueued `Once` returns undefined, so the component's `.then` blew
  // up in a commit-phase error that failed four unrelated tests. The tests below are about the CTA,
  // not the picker, so an empty list is the right answer; each still queues its own item first.
  fetchSpy.mockResolvedValue([])
  navigateSpy.mockReset()
  paramsRef.current = { id: 'item-seed-1' }
})

describe('InventoryDetail — Plant-from-packet CTA visibility', () => {
  it('shows CTA when category=seeds and quantity_on_hand > 0', async () => {
    fetchSpy.mockResolvedValueOnce(SEED_WITH_STOCK)
    render(<ToastProvider><InventoryDetail /></ToastProvider>)
    await waitFor(() => expect(screen.getByText(/Plant from this packet/)).toBeDefined())
  })

  it('hides CTA when quantity_on_hand === 0', async () => {
    fetchSpy.mockResolvedValueOnce(SEED_NO_STOCK)
    render(<ToastProvider><InventoryDetail /></ToastProvider>)
    await waitFor(() => screen.getByText('Black Krim seeds'))
    expect(screen.queryByText(/Plant from this packet/)).toBeNull()
  })

  it('hides CTA when category != seeds', async () => {
    fetchSpy.mockResolvedValueOnce(NON_SEED)
    render(<ToastProvider><InventoryDetail /></ToastProvider>)
    await waitFor(() => screen.getByText('Black Krim seeds'))
    expect(screen.queryByText(/Plant from this packet/)).toBeNull()
  })

  it('hides CTA for durable items', async () => {
    paramsRef.current = { id: 'item-2' }
    fetchSpy.mockResolvedValueOnce(DURABLE)
    render(<ToastProvider><InventoryDetail /></ToastProvider>)
    await waitFor(() => screen.getByText('Trowel'))
    expect(screen.queryByText(/Plant from this packet/)).toBeNull()
  })

  it('hides CTA when quantity_on_hand is null', async () => {
    fetchSpy.mockResolvedValueOnce({ ...SEED_WITH_STOCK, quantity_on_hand: null })
    render(<ToastProvider><InventoryDetail /></ToastProvider>)
    await waitFor(() => screen.getByText('Black Krim seeds'))
    expect(screen.queryByText(/Plant from this packet/)).toBeNull()
  })
})

describe('InventoryDetail — Plant-from-packet CTA navigation', () => {
  it('navigates with source_inventory_item_id and variety_id query params on click', async () => {
    fetchSpy.mockResolvedValueOnce(SEED_WITH_STOCK)
    render(<ToastProvider><InventoryDetail /></ToastProvider>)
    await waitFor(() => screen.getByText(/Plant from this packet/))

    fireEvent.click(screen.getByLabelText(/Plant from Black Krim seeds/i))

    expect(navigateSpy).toHaveBeenCalledTimes(1)
    const dest = navigateSpy.mock.calls[0][0]
    expect(dest).toMatch(/^\/garden\?/)
    const params = new URLSearchParams(dest.split('?')[1])
    expect(params.get('source_inventory_item_id')).toBe('item-seed-1')
    expect(params.get('variety_id')).toBe('var-1')
  })

  it('omits variety_id when packet has no variety_id', async () => {
    fetchSpy.mockResolvedValueOnce(SEED_NO_VARIETY)
    render(<ToastProvider><InventoryDetail /></ToastProvider>)
    await waitFor(() => screen.getByText(/Plant from this packet/))

    fireEvent.click(screen.getByLabelText(/Plant from Black Krim seeds/i))

    const dest = navigateSpy.mock.calls[0][0]
    const params = new URLSearchParams(dest.split('?')[1])
    expect(params.get('source_inventory_item_id')).toBe('item-seed-1')
    expect(params.get('variety_id')).toBeNull()
  })

  it('CTA button is a 44px+ tap target (mobile-first)', async () => {
    fetchSpy.mockResolvedValueOnce(SEED_WITH_STOCK)
    render(<ToastProvider><InventoryDetail /></ToastProvider>)
    await waitFor(() => screen.getByText(/Plant from this packet/))

    const cta = screen.getByLabelText(/Plant from Black Krim seeds/i)
    // Inline style minHeight set to 56
    expect(cta.style.minHeight).toBe('56px')
  })
})

describe('InventoryDetail — V2-PHOTO-F1 S2 inventory photo upload', () => {
  it('mounts PhotoUpload with inventory keyPrefix and inventory_item_id linkage', async () => {
    fetchSpy.mockResolvedValueOnce(SEED_WITH_STOCK)
    render(<ToastProvider><InventoryDetail /></ToastProvider>)
    await waitFor(() => screen.getByTestId('inventory-photo-upload-item-seed-1'))
    const node = screen.getByTestId('inventory-photo-upload-item-seed-1')
    expect(node.dataset.keyPrefix).toBe('inventory')
    const linkage = JSON.parse(node.dataset.linkage)
    expect(linkage.inventory_item_id).toBe('item-seed-1')
  })

  it('photo section renders for durable items too', async () => {
    paramsRef.current = { id: 'item-2' }
    fetchSpy.mockResolvedValueOnce(DURABLE)
    render(<ToastProvider><InventoryDetail /></ToastProvider>)
    await waitFor(() => screen.getByTestId('inventory-photo-upload-item-2'))
  })
})
