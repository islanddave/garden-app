/**
 * src/__tests__/InventoryDetailCTA.test.jsx
 * VARIETY-REF S4b — the packet CTA on InventoryDetail. Since V5-SEEDSTAB-001 slice 2a it is "Sow this",
 * which opens the shared Sow sheet in place instead of navigating to Garden's add form.
 *
 * Focused scope: CTA visibility rules + what a tap does.
 * - Visible only when category === 'seeds' AND quantity_on_hand > 0 (the S4b rule, unchanged)
 * - On click, opens the Sow sheet on this packet — no navigation — and the sow it makes carries the
 *   packet (source_inventory_item_id) and its cultivar (variety_id). The /garden deep link it used to
 *   build is kept on Garden's side for typed URLs; Garden.editor.test.jsx still pins that reader.
 *
 * Mocks: useApiFetch, useParams/useNavigate, FavoriteToggle.
 * Strategy mirrors Plants.test.jsx structure.
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react'

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

describe('InventoryDetail — Sow this CTA visibility (the S4b rule, unchanged)', () => {
  it('shows CTA when category=seeds and quantity_on_hand > 0', async () => {
    fetchSpy.mockResolvedValueOnce(SEED_WITH_STOCK)
    render(<ToastProvider><InventoryDetail /></ToastProvider>)
    await waitFor(() => expect(screen.getByText('Sow this')).toBeDefined())
    expect(screen.getByTestId('sow-this')).toBeDefined()
  })

  it('hides CTA when quantity_on_hand === 0', async () => {
    fetchSpy.mockResolvedValueOnce(SEED_NO_STOCK)
    render(<ToastProvider><InventoryDetail /></ToastProvider>)
    await waitFor(() => screen.getByText('Black Krim seeds'))
    expect(screen.queryByTestId('sow-this')).toBeNull()
    expect(screen.queryByText('Sow this')).toBeNull()
  })

  it('hides CTA when category != seeds', async () => {
    fetchSpy.mockResolvedValueOnce(NON_SEED)
    render(<ToastProvider><InventoryDetail /></ToastProvider>)
    await waitFor(() => screen.getByText('Black Krim seeds'))
    expect(screen.queryByTestId('sow-this')).toBeNull()
    expect(screen.queryByText('Sow this')).toBeNull()
  })

  it('hides CTA for durable items', async () => {
    paramsRef.current = { id: 'item-2' }
    fetchSpy.mockResolvedValueOnce(DURABLE)
    render(<ToastProvider><InventoryDetail /></ToastProvider>)
    await waitFor(() => screen.getByText('Trowel'))
    expect(screen.queryByTestId('sow-this')).toBeNull()
    expect(screen.queryByText('Sow this')).toBeNull()
  })

  it('hides CTA when quantity_on_hand is null', async () => {
    fetchSpy.mockResolvedValueOnce({ ...SEED_WITH_STOCK, quantity_on_hand: null })
    render(<ToastProvider><InventoryDetail /></ToastProvider>)
    await waitFor(() => screen.getByText('Black Krim seeds'))
    expect(screen.queryByTestId('sow-this')).toBeNull()
    expect(screen.queryByText('Sow this')).toBeNull()
  })
})

// V5-SEEDSTAB-001 slice 2a — REPLACES the two navigation pins ("navigates with source_inventory_item_id
// and variety_id query params", "omits variety_id when packet has no variety_id"). What they guarded —
// the tap carries THIS packet and ITS cultivar into the planting — is now asserted on the planting
// create itself, which is where it matters: drop the packet id or the variety from the sheet and these
// red exactly as the old ones did when the query string lost them.
describe('InventoryDetail — Sow this opens the Sow sheet on this packet', () => {
  function routeSowFetch(item) {
    fetchSpy.mockImplementation((path, opts = {}) => {
      const p = String(path)
      if (p === '/api/inventory-items/item-seed-1' && !opts.method) return Promise.resolve(item)
      if (p === '/api/projects') return Promise.resolve([{ id: 'proj-beds', name: 'Raised beds' }])
      if (p.startsWith('/api/varieties/var-')) return Promise.resolve({ id: p.split('/').pop(), name: 'Black Krim' })
      if (p === '/api/plants' && opts.method === 'POST') return Promise.resolve({ id: 'plant-krim' })
      return Promise.resolve([])
    })
  }

  async function openAndSow() {
    await act(async () => { render(<ToastProvider><InventoryDetail /></ToastProvider>) })
    await waitFor(() => screen.getByText('Sow this'))
    await act(async () => { fireEvent.click(screen.getByTestId('sow-this')) })
    const sheet = screen.getByRole('dialog', { name: 'Sow Black Krim seeds' })
    await waitFor(() => expect(within(sheet).getByLabelText(/Name/i).value).toBe('Black Krim seeds'))
    await act(async () => { fireEvent.click(within(sheet).getByRole('button', { name: /Add planting/i })) })
    const call = fetchSpy.mock.calls.find(([u, o]) => u === '/api/plants' && o?.method === 'POST')
    return JSON.parse(call[1].body)
  }

  it('a tap opens the sheet in place — no navigation', async () => {
    routeSowFetch(SEED_WITH_STOCK)
    await act(async () => { render(<ToastProvider><InventoryDetail /></ToastProvider>) })
    await waitFor(() => screen.getByText('Sow this'))
    expect(screen.queryByRole('dialog')).toBeNull()

    await act(async () => { fireEvent.click(screen.getByTestId('sow-this')) })

    expect(screen.getByRole('dialog', { name: 'Sow Black Krim seeds' })).toBeDefined()
    expect(navigateSpy).not.toHaveBeenCalled()
  })

  it('the sow carries this packet and its cultivar', async () => {
    routeSowFetch(SEED_WITH_STOCK)
    const body = await openAndSow()
    expect(body.source_inventory_item_id).toBe('item-seed-1')
    expect(body.variety_id).toBe('var-1')
    expect(body.status).toBe('seed')
    expect(body.source_type).toBe('seed_packet')
    expect(navigateSpy).not.toHaveBeenCalled()
  })

  it('a packet with no variety_id still sows from the packet, with no cultivar', async () => {
    routeSowFetch(SEED_NO_VARIETY)
    const body = await openAndSow()
    expect(body.source_inventory_item_id).toBe('item-seed-1')
    expect(body.variety_id).toBeNull()
  })

  it('CTA button is a 44px+ tap target (mobile-first)', async () => {
    fetchSpy.mockResolvedValueOnce(SEED_WITH_STOCK)
    render(<ToastProvider><InventoryDetail /></ToastProvider>)
    await waitFor(() => screen.getByText('Sow this'))

    const cta = screen.getByLabelText('Sow this: Black Krim seeds')
    // Inline style minHeight set to 56
    expect(cta.style.minHeight).toBe('56px')
  })

  it('carries the colour registry sprout, not the 🌱 emoji it used to', async () => {
    fetchSpy.mockResolvedValueOnce(SEED_WITH_STOCK)
    render(<ToastProvider><InventoryDetail /></ToastProvider>)
    await waitFor(() => screen.getByText('Sow this'))

    const cta = screen.getByTestId('sow-this')
    expect(cta.querySelector('svg')).toBeTruthy()
    expect(cta.textContent).not.toContain('🌱')
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
