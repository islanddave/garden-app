/**
 * src/__tests__/InventoryDetailCTA.test.jsx
 * VARIETY-REF S4b — Plant-from-packet CTA tests on InventoryDetail.
 *
 * Focused scope: CTA visibility rules + navigation contract.
 * - Visible only when category === 'seeds' AND quantity_on_hand > 0
 * - On click, calls navigate(/plants?source_inventory_item_id=<id>[&variety_id=<vid>])
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

// useInventory hook used internally for update/delete — stub the methods to no-op
vi.mock('../hooks/useInventory.js', () => ({
  useInventory: () => ({
    updateItem: vi.fn().mockResolvedValue({ item: {} }),
    deleteItem: vi.fn().mockResolvedValue({ ok: true }),
  }),
}))

import InventoryDetail from '../pages/InventoryDetail.jsx'

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
  navigateSpy.mockReset()
  paramsRef.current = { id: 'item-seed-1' }
})

describe('InventoryDetail — Plant-from-packet CTA visibility', () => {
  it('shows CTA when category=seeds and quantity_on_hand > 0', async () => {
    fetchSpy.mockResolvedValueOnce(SEED_WITH_STOCK)
    render(<InventoryDetail />)
    await waitFor(() => expect(screen.getByText(/Plant from this packet/)).toBeDefined())
  })

  it('hides CTA when quantity_on_hand === 0', async () => {
    fetchSpy.mockResolvedValueOnce(SEED_NO_STOCK)
    render(<InventoryDetail />)
    await waitFor(() => screen.getByText('Black Krim seeds'))
    expect(screen.queryByText(/Plant from this packet/)).toBeNull()
  })

  it('hides CTA when category != seeds', async () => {
    fetchSpy.mockResolvedValueOnce(NON_SEED)
    render(<InventoryDetail />)
    await waitFor(() => screen.getByText('Black Krim seeds'))
    expect(screen.queryByText(/Plant from this packet/)).toBeNull()
  })

  it('hides CTA for durable items', async () => {
    paramsRef.current = { id: 'item-2' }
    fetchSpy.mockResolvedValueOnce(DURABLE)
    render(<InventoryDetail />)
    await waitFor(() => screen.getByText('Trowel'))
    expect(screen.queryByText(/Plant from this packet/)).toBeNull()
  })

  it('hides CTA when quantity_on_hand is null', async () => {
    fetchSpy.mockResolvedValueOnce({ ...SEED_WITH_STOCK, quantity_on_hand: null })
    render(<InventoryDetail />)
    await waitFor(() => screen.getByText('Black Krim seeds'))
    expect(screen.queryByText(/Plant from this packet/)).toBeNull()
  })
})

describe('InventoryDetail — Plant-from-packet CTA navigation', () => {
  it('navigates with source_inventory_item_id and variety_id query params on click', async () => {
    fetchSpy.mockResolvedValueOnce(SEED_WITH_STOCK)
    render(<InventoryDetail />)
    await waitFor(() => screen.getByText(/Plant from this packet/))

    fireEvent.click(screen.getByLabelText(/Plant from Black Krim seeds/i))

    expect(navigateSpy).toHaveBeenCalledTimes(1)
    const dest = navigateSpy.mock.calls[0][0]
    expect(dest).toMatch(/^\/plants\?/)
    const params = new URLSearchParams(dest.split('?')[1])
    expect(params.get('source_inventory_item_id')).toBe('item-seed-1')
    expect(params.get('variety_id')).toBe('var-1')
  })

  it('omits variety_id when packet has no variety_id', async () => {
    fetchSpy.mockResolvedValueOnce(SEED_NO_VARIETY)
    render(<InventoryDetail />)
    await waitFor(() => screen.getByText(/Plant from this packet/))

    fireEvent.click(screen.getByLabelText(/Plant from Black Krim seeds/i))

    const dest = navigateSpy.mock.calls[0][0]
    const params = new URLSearchParams(dest.split('?')[1])
    expect(params.get('source_inventory_item_id')).toBe('item-seed-1')
    expect(params.get('variety_id')).toBeNull()
  })

  it('CTA button is a 44px+ tap target (mobile-first)', async () => {
    fetchSpy.mockResolvedValueOnce(SEED_WITH_STOCK)
    render(<InventoryDetail />)
    await waitFor(() => screen.getByText(/Plant from this packet/))

    const cta = screen.getByLabelText(/Plant from Black Krim seeds/i)
    // Inline style minHeight set to 56
    expect(cta.style.minHeight).toBe('56px')
  })
})
