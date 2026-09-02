// V4-SEEDORIGIN-001 — the control that records where seed came from when it came from no planting
// of ours. Dave's founding case is a Carolina Reaper bought to eat and scraped for its seed.
//
// WHY THIS FILE EXISTS AT ALL: the pre-promote QA pass caught that the route, the column, the four
// CHECK constraints and the migration had all shipped while NOTHING in src/ called the route — so
// the 4.94.0 release note promised a feature with no surface. This is that surface, and this is the
// test that stops it regressing to a dead API again.
//
// The two behaviours pinned hardest are the ones the DATABASE forces:
//   1. the picker is HIDDEN while a parent plant is set — chk_inventory_seed_source_plant is
//      `source_kind IS NULL OR source_kind = 'own_garden' OR source_plant_id IS NULL`, so offering
//      the choice there offers one the database will refuse;
//   2. clearing sends an EXPLICIT null, because the route reads the key by PRESENCE — an omitted
//      key is a 400, so a client sending `{}` for "not recorded" would fail forever with nothing on
//      screen to say so. Same asymmetry the sibling "Saved from" control documents.
// Harness mirrors InventoryDetail.sourcePlant.test.jsx. No jest-dom (L-182).
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
  id: 'inv-1', name: 'Carolina Reaper', category: 'seeds', type: 'consumable',
  quantity_on_hand: 0, unit: 'packet', variety_id: 'v-reaper',
  source_plant_id: null, source_kind: null,
}

const patchCalls = () => fetchSpy.mock.calls.filter(([, o]) => o?.method === 'PATCH')
const kindPatches = () =>
  patchCalls().filter(([p]) => String(p).includes('/source-kind'))

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
}

describe('InventoryDetail — where non-garden seed came from', () => {
  it('offers the eight shipped origins, with "Not recorded" first and unsorted', async () => {
    // Order is load-bearing: dropdownRegistry orders by frequency, not alphabetically, which is why
    // this is a plain Select and not EnumSelect (that primitive sorts and would bury "My garden").
    await renderPage()
    const select = await screen.findByTestId('source-kind-select')
    const values = [...select.querySelectorAll('option')].map((o) => o.value)
    expect(values).toEqual([
      '', 'own_garden', 'u_pick', 'farm_stand', 'csa', 'store', 'gift', 'foraged', 'other',
    ])
  })

  it('PATCHes the dedicated sub-route, never the wide PUT', async () => {
    await renderPage()
    const select = await screen.findByTestId('source-kind-select')
    await act(async () => { fireEvent.change(select, { target: { value: 'store' } }) })
    await waitFor(() => expect(kindPatches()).toHaveLength(1))
    const [path, opts] = kindPatches()[0]
    expect(path).toBe('/api/inventory-items/inv-1/source-kind')
    expect(JSON.parse(opts.body)).toEqual({ source_kind: 'store' })
    // The wide PUT assigns its whole SET list unconditionally — this must never ride it.
    expect(fetchSpy.mock.calls.some(([, o]) => o?.method === 'PUT')).toBe(false)
  })

  it('clearing sends an EXPLICIT null, not an omitted key', async () => {
    itemRef.current = { ...LOT, source_kind: 'gift' }
    await renderPage()
    const select = await screen.findByTestId('source-kind-select')
    await waitFor(() => expect(select.value).toBe('gift'))
    await act(async () => { fireEvent.change(select, { target: { value: '' } }) })
    await waitFor(() => expect(kindPatches()).toHaveLength(1))
    const body = JSON.parse(kindPatches()[0][1].body)
    expect(Object.prototype.hasOwnProperty.call(body, 'source_kind')).toBe(true)
    expect(body.source_kind).toBeNull()
  })

  it('is HIDDEN when a parent plant is set — the constraint, not a layout choice', async () => {
    // Asserted in the SAME render as a positive control: the "Saved from" card IS present, so this
    // cannot pass merely because the seeds block failed to render.
    itemRef.current = { ...LOT, source_plant_id: 'pl-1' }
    await renderPage()
    expect(await screen.findByTestId('seed-source-plant')).toBeTruthy()
    expect(screen.queryByTestId('seed-source-kind')).toBeNull()
  })

  it('shows when there is NO parent plant — the other half of the same render', async () => {
    await renderPage()
    expect(await screen.findByTestId('seed-source-plant')).toBeTruthy()
    expect(screen.queryByTestId('seed-source-kind')).toBeTruthy()
  })

  it('reverts and explains when the write fails', async () => {
    itemRef.current = { ...LOT, source_kind: 'store' }
    await renderPage()
    const select = await screen.findByTestId('source-kind-select')
    await waitFor(() => expect(select.value).toBe('store'))
    fetchSpy.mockImplementationOnce(() => Promise.reject(new Error('nope')))
    await act(async () => { fireEvent.change(select, { target: { value: 'foraged' } }) })
    await waitFor(() => expect(screen.getByTestId('source-kind-select').value).toBe('store'))
    expect(screen.getByTestId('source-kind-help').textContent).toMatch(/nope|could not save/i)
  })

  it('does not appear on a non-seed item', async () => {
    itemRef.current = { id: 'inv-1', name: 'Trowel', category: 'tools', type: 'durable', quantity: 1 }
    await renderPage()
    await waitFor(() => expect(screen.queryByTestId('seed-source-plant')).toBeNull())
    expect(screen.queryByTestId('seed-source-kind')).toBeNull()
  })
})
