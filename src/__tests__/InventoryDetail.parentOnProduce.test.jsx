// BUG-SAVEDSEEDPARENTONPRODUCE-001 — /inventory/:id's "Saved from" picker was offered on EVERY seed lot,
// including lots saved out of produce, which the database refuses a parent for:
// chk_inventory_seed_source_plant is `source_kind IS NULL OR source_kind = 'own_garden' OR
// source_plant_id IS NULL`. Picking a planting there could only fail. The origin select already hid
// itself while a parent was set (the same CHECK from its other side, pinned in
// InventoryDetail.sourceKind.test.jsx); this is the mirror, asked of the LIVE select so a change of
// origin brings the picker back or takes it away in the same render.
// Every refusal is asserted beside a positive control in the same render (the card and the origin select
// ARE there), and own_garden is asserted to KEEP the picker, so removing the predicate reds this file and
// so does loosening it to "any source_kind".
// Harness mirrors InventoryDetail.sourceKind.test.jsx. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'

const { fetchSpy, itemRef } = vi.hoisted(() => ({ fetchSpy: vi.fn(), itemRef: { current: null } }))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: vi.fn() }),
  apiFetch: (...a) => fetchSpy(...a),
}))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...r }) => <a href={typeof to === 'string' ? to : '#'} {...r}>{children}</a>,
  useNavigate: () => vi.fn(),
  useParams: () => ({ id: 'inv-1' }),
}))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <span /> }))

import InventoryDetail from '../pages/InventoryDetail.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'

const LOT = {
  id: 'inv-1', name: 'Farm-stand Aji Amarillo', category: 'seeds', type: 'consumable',
  quantity_on_hand: 1, unit: 'packet', variety_id: 'v-aji',
  source_plant_id: null, source_kind: null,
}

const kindPatches = () => fetchSpy.mock.calls.filter(([p, o]) => o?.method === 'PATCH' && String(p).includes('/source-kind'))

beforeEach(() => {
  fetchSpy.mockReset()
  itemRef.current = { ...LOT }
  fetchSpy.mockImplementation((path, opts) => {
    const p = String(path)
    if (opts?.method === 'PATCH') return Promise.resolve({ id: 'inv-1' })
    if (p.startsWith('/api/plants?view=picker')) return Promise.resolve([])
    if (p.startsWith('/api/inventory-items/inv-1')) return Promise.resolve(itemRef.current)
    return Promise.resolve([])
  })
})

const renderPage = async () => {
  await act(async () => { render(<ToastProvider><InventoryDetail /></ToastProvider>) })
  await screen.findByTestId('seed-source-plant')
}

describe('InventoryDetail — no parent picker on a lot the database refuses one (BUG-SAVEDSEEDPARENTONPRODUCE-001)', () => {
  it.each(['farm_stand', 'gift', 'store'])('hides the picker on a %s lot; the origin select is still there, standing alone', async (kind) => {
    itemRef.current = { ...LOT, source_kind: kind }
    await renderPage()
    const select = await screen.findByTestId('source-kind-select')
    await waitFor(() => expect(select.value).toBe(kind))
    expect(screen.queryByTestId('source-plant-select')).toBeNull()
    expect(screen.queryByTestId('source-plant-help')).toBeNull()
    // Alone in the card, so no "Or", and the help names the way back to a plant.
    const block = screen.getByTestId('seed-source-kind').textContent
    expect(block).toContain('Where did it come from?')
    expect(block).not.toContain('Or where')
    expect(screen.getByTestId('source-kind-help').textContent).toContain('My garden')
  })

  it.each([
    ['own_garden', 'own_garden'],
    ['unrecorded', null],
  ])('keeps the picker on an %s lot — the CHECK admits a parent there', async (_, kind) => {
    itemRef.current = { ...LOT, source_kind: kind }
    await renderPage()
    expect(await screen.findByTestId('source-plant-select')).toBeTruthy()
    expect(screen.getByTestId('seed-source-kind').textContent).toContain('Or where did it come from?')
  })

  it('follows the LIVE select: My garden brings the picker back, a shop takes it away again', async () => {
    itemRef.current = { ...LOT, source_kind: 'farm_stand' }
    await renderPage()
    const select = await screen.findByTestId('source-kind-select')
    await waitFor(() => expect(select.value).toBe('farm_stand'))
    expect(screen.queryByTestId('source-plant-select')).toBeNull()
    await act(async () => { fireEvent.change(select, { target: { value: 'own_garden' } }) })
    await waitFor(() => expect(kindPatches()).toHaveLength(1))
    expect(screen.getByTestId('source-plant-select')).toBeTruthy()
    await act(async () => { fireEvent.change(screen.getByTestId('source-kind-select'), { target: { value: 'store' } }) })
    await waitFor(() => expect(kindPatches()).toHaveLength(2))
    expect(screen.queryByTestId('source-plant-select')).toBeNull()
  })

  it('a failed origin write puts the picker back the way the reverted value says', async () => {
    itemRef.current = { ...LOT, source_kind: 'gift' }
    await renderPage()
    const select = await screen.findByTestId('source-kind-select')
    await waitFor(() => expect(select.value).toBe('gift'))
    fetchSpy.mockImplementationOnce(() => Promise.reject(new Error('nope')))
    await act(async () => { fireEvent.change(select, { target: { value: '' } }) })
    await waitFor(() => expect(screen.getByTestId('source-kind-select').value).toBe('gift'))
    expect(screen.queryByTestId('source-plant-select')).toBeNull()
  })
})
