// V4-SEEDLINK-001 — the "Saved from" control on /inventory/:id.
//
// WHY THIS PAGE IS THE PLACEMENT UNDER TEST. /seeds/saved lists only lots that carry a seed_stage,
// and its "Track a lot" picker hard-codes `fermenting` — so attaching a parent there would mean
// writing a false stage into seed_lot_stage_log for a dry-processed lot. Every lot is reachable
// here, tracked or not, which is why this is the acceptance surface for the feature.
//
// The two behaviours pinned hardest are the ones that go wrong SILENTLY: the seeds-only gate (a
// provenance field on a shovel is nonsense, and the column is meaningless there), and CLEARING —
// the route reads source_plant_id by key PRESENCE, so `null` is the clear and an omitted key is a
// 400. A client that sent `{}` for "no parent" would 400 forever with nothing on screen to say so.
// No jest-dom (L-182).
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

// The Green Flesh Honeydew case from the design, shrunk to its load-bearing parts: one seed lot,
// one planting of that cultivar, and the planting is `harvested` — which is the normal state of a
// seed parent and must not disqualify it.
const LOT = {
  id: 'inv-1', name: 'Green Flesh Honeydew', category: 'seeds', type: 'consumable',
  quantity_on_hand: 1, unit: 'packet', variety_id: 'v-melon', source_plant_id: null,
}
const PARENT = {
  id: 'pl-melon', name: 'Green Flesh', quantity: 1, variety_id: 'v-melon', project_name: null,
  variety_ref: { id: 'v-melon', name: 'Green Flesh', crop_type_slug: 'melon' },
  sown_at: null, succession_order: null, status: 'harvested',
}
const OTHER = {
  id: 'pl-basil', name: 'Basil', quantity: 6, variety_id: 'v-basil', project_name: null,
  variety_ref: { id: 'v-basil', name: 'Genovese', crop_type_slug: 'basil' },
  sown_at: null, succession_order: null,
}

const patchCalls = () => fetchSpy.mock.calls.filter(([p, o]) => o?.method === 'PATCH')

beforeEach(() => {
  fetchSpy.mockReset()
  itemRef.current = { ...LOT }
  fetchSpy.mockImplementation((path, opts) => {
    const p = String(path)
    if (opts?.method === 'PATCH') return Promise.resolve({ id: 'inv-1', source_plant_id: null })
    if (p.startsWith('/api/plants?view=picker')) return Promise.resolve([PARENT, OTHER])
    if (p.startsWith('/api/inventory-items/inv-1')) return Promise.resolve(itemRef.current)
    return Promise.resolve([])
  })
})

const renderPage = async () => {
  await act(async () => { render(<ToastProvider><InventoryDetail /></ToastProvider>) })
  await waitFor(() => expect(screen.getByText(itemRef.current.name)).toBeTruthy())
}

describe('InventoryDetail — Saved from (V4-SEEDLINK-001)', () => {
  it('renders the control for a seed packet', async () => {
    await renderPage()
    expect(screen.getByTestId('seed-source-plant')).toBeTruthy()
    expect(screen.getByTestId('source-plant-select')).toBeTruthy()
  })

  it('does NOT render it for a non-seed item', async () => {
    // Gated exactly like the Plant-from-packet CTA. A provenance field on a shovel is not merely
    // clutter: the route asserts category='seeds', so anything set there could never be saved.
    itemRef.current = { ...LOT, name: 'Hori hori knife', category: 'tools', type: 'durable', variety_id: null }
    await renderPage()
    expect(screen.queryByTestId('seed-source-plant')).toBeNull()
  })

  it('scopes the picker to the lot’s own cultivar', async () => {
    // varietyId is what turns ~239 plantings into the one that could plausibly have made this seed.
    await renderPage()
    fireEvent.focus(screen.getByTestId('source-plant-select'))
    await waitFor(() => expect(screen.getByTestId(`ps-opt-${PARENT.id}`)).toBeTruthy())
    expect(screen.queryByTestId(`ps-opt-${OTHER.id}`)).toBeNull()
  })

  it('PATCHes the chosen planting to /source-plant and confirms', async () => {
    await renderPage()
    fireEvent.focus(screen.getByTestId('source-plant-select'))
    await waitFor(() => expect(screen.getByTestId(`ps-opt-${PARENT.id}`)).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByTestId(`ps-opt-${PARENT.id}`)) })

    const calls = patchCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe('/api/inventory-items/inv-1/source-plant')
    expect(JSON.parse(calls[0][1].body)).toEqual({ source_plant_id: 'pl-melon' })
    // It saves on selection, not behind the page's Save button — so a confirmation is owed.
    await waitFor(() => expect(screen.getByText('✓ Saved')).toBeTruthy())
    // …and the wide PUT is not involved. Routing this through it would null the provenance on
    // every later unrelated edit.
    expect(fetchSpy.mock.calls.some(([, o]) => o?.method === 'PUT')).toBe(false)
  })

  it('CLEARS by sending an explicit null, never an omitted key', async () => {
    // The route reads this by presence: `{}` is a 400 and `{source_plant_id: null}` is the clear.
    // Sending the wrong one fails silently from the user's side — the chip disappears and nothing
    // is saved — which is why the body shape is asserted rather than just the request happening.
    itemRef.current = { ...LOT, source_plant_id: 'pl-melon' }
    await renderPage()
    await waitFor(() => expect(screen.getByTestId('source-plant-select-chip')).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByLabelText('Clear planting selection')) })

    const calls = patchCalls()
    expect(calls).toHaveLength(1)
    const body = JSON.parse(calls[0][1].body)
    expect(Object.prototype.hasOwnProperty.call(body, 'source_plant_id')).toBe(true)
    expect(body.source_plant_id).toBeNull()
  })

  it('reverts and says so when the write fails', async () => {
    // Leaving the picker showing a parent the server never accepted is the silent-failure shape:
    // the page would read as "saved" for the rest of the session and be wrong after a reload.
    fetchSpy.mockImplementation((path, opts) => {
      const p = String(path)
      if (opts?.method === 'PATCH') return Promise.reject(new Error('Network unreachable'))
      if (p.startsWith('/api/plants?view=picker')) return Promise.resolve([PARENT, OTHER])
      if (p.startsWith('/api/inventory-items/inv-1')) return Promise.resolve(itemRef.current)
      return Promise.resolve([])
    })
    await renderPage()
    fireEvent.focus(screen.getByTestId('source-plant-select'))
    await waitFor(() => expect(screen.getByTestId(`ps-opt-${PARENT.id}`)).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByTestId(`ps-opt-${PARENT.id}`)) })

    await waitFor(() =>
      expect(screen.getByTestId('source-plant-help').textContent).toContain('Network unreachable'))
    expect(screen.queryByTestId('source-plant-select-chip')).toBeNull()
  })

  it('says the plantings failed to load rather than reading as "you have none"', async () => {
    // BUG-PLANTFETCHSILENT-001: an unfillable field that looks like a legitimately empty garden.
    fetchSpy.mockImplementation((path) => {
      const p = String(path)
      if (p.startsWith('/api/plants?view=picker')) return Promise.reject(new Error('boom'))
      if (p.startsWith('/api/inventory-items/inv-1')) return Promise.resolve(itemRef.current)
      return Promise.resolve([])
    })
    await renderPage()
    await waitFor(() =>
      expect(screen.getByTestId('source-plant-help').textContent).toContain('load your plantings'))
  })
})
