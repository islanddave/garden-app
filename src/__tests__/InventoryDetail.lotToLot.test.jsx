// BUG-LOTPAGEREUSEDACROSSLOTS-001 — one lot's page must never answer for another lot.
//
// The route /inventory/:id matches every lot, so react-router keeps ONE page instance across a lot → lot
// navigation and only the `id` param changes. The one door that goes lot → lot is header Search, whose
// seed results link straight to /inventory/<id> (Search.jsx). So: lot A opened from a Seeds view, Search
// over it, a seed result for lot B. Lot B then answered Cancel with what lot A read when IT arrived
// (seedsReturnReader, read once per visit): "a Seeds view pushed me, go Back" — and Back from lot B is
// Search over lot A, not Seeds. A lot opened from Search with nothing of the kind under it goes to My seeds.
//
// Real BrowserRouter + OverlayProvider in App.jsx's two-tree shape, as InventoryDetail.overlayDismiss.test.jsx
// has it, because the re-use lives in the router. Leaf mocks as there. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent, cleanup } from '@testing-library/react'
import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom'

const { fetchSpy, deleteSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn(), deleteSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <span /> }))
vi.mock('../components/PhotoUpload.jsx', () => ({ default: () => <span /> }))
vi.mock('../components/forms/PlantingSelect.jsx', () => ({ default: () => <span /> }))
vi.mock('../hooks/useInventory.js', () => ({ useInventory: () => ({ updateItem: vi.fn(), deleteItem: deleteSpy }) }))

import InventoryDetail from '../pages/InventoryDetail.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import { OverlayProvider, useOverlay, OverlayLink } from '../context/OverlayContext.jsx'
import { seedsHref, seedsReturnState } from '../lib/seedsRoutes.js'

const lot = (id, name) => ({
  id, name, category: 'seeds', type: 'consumable',
  status: 'active', quantity_on_hand: 1, unit: 'packet', reorder_threshold: null, reorder_quantity: null,
  notes: null, source: null, source_url: null, purchase_date: null, unit_cost: null, quantity_purchased: null,
  location_text: null, brand: null, model: null, variety_id: 'var-ristra', variety_name: null,
  source_plant_id: 'pl-ristra', source_kind: 'own_garden', seed_stage: 'stored', seed_process: 'wet',
  seed_count: 175, seed_count_estimated: false, breeding_system: 'f1', year_harvested: 2026, metadata: null,
  germination: { rate: null, seeds_sown: 0, seeds_germinated: 0, sowings: [] }, sown_from: [],
})
const LOTS = {
  'lot-a': lot('lot-a', 'Ristra Cayenne II Saved seed 2026'),
  'lot-b': lot('lot-b', 'Hot Paper Lantern Saved seed 2026'),
}
const SEEDS_MINE = seedsHref('mine')
const SEEDS_SAVED = seedsHref('saved')

// Header Search's stand-in: a seed result is a PLAIN <Link> to the lot (Search.jsx Row), no state.
const SearchStub = () => <Link to="/inventory/lot-b" data-testid="result-lot-b">lot b</Link>
// The Seeds page's stand-in: which view it shows, and a row's door as Saved seeds pushes it.
function SeedsStub() {
  const loc = useLocation()
  return (
    <div data-testid="seeds">
      {loc.pathname + loc.search}
      <Link to="/inventory/lot-a" state={seedsReturnState(SEEDS_SAVED)} data-testid="to-lot-a">lot a</Link>
    </div>
  )
}
function Shell() {
  const { pageLocation, overlayLocation, background } = useOverlay()
  return (
    <>
      <OverlayLink to="/search" data-testid="open-search">search</OverlayLink>
      <Routes location={pageLocation}>
        <Route path="/seeds" element={<SeedsStub />} />
        <Route path="/today" element={<div data-testid="today" />} />
        <Route path="/inventory/:id" element={<InventoryDetail />} />
      </Routes>
      {background && (
        <Routes location={overlayLocation}>
          <Route path="/search" element={<SearchStub />} />
        </Routes>
      )}
    </>
  )
}

const heading = () => screen.queryByRole('heading', { level: 1 })
const tap = (id) => act(async () => { fireEvent.click(screen.getByTestId(id)) })
const url = () => window.location.pathname + window.location.search
const idx = () => window.history.state?.idx
const lotFetches = (id) => fetchSpy.mock.calls.filter(([p, o]) => String(p) === `/api/inventory-items/${id}` && !o).length

beforeEach(() => {
  fetchSpy.mockReset()
  fetchSpy.mockImplementation((path, opts) => {
    const m = String(path).match(/^\/api\/inventory-items\/(lot-[ab])$/)
    return Promise.resolve(m && !opts ? { ...LOTS[m[1]] } : [])
  })
  deleteSpy.mockReset()
  deleteSpy.mockResolvedValue({ error: null })
  window.scrollTo = vi.fn()
  window.requestAnimationFrame = () => 1
  window.cancelAnimationFrame = () => {}
})
afterEach(() => { cleanup() })

const mount = (at) => {
  window.history.replaceState(null, '', at)
  render(<ToastProvider><BrowserRouter><OverlayProvider><Shell /></OverlayProvider></BrowserRouter></ToastProvider>)
}
const searchToLotB = async () => {
  await tap('open-search')
  await waitFor(() => expect(screen.getByTestId('result-lot-b')).toBeTruthy())
  await tap('result-lot-b')
  await waitFor(() => expect(heading()?.textContent).toBe(LOTS['lot-b'].name))
  expect(url()).toBe('/inventory/lot-b')
}
// Saved seeds → lot A (the Seeds door's push) → header Search → the seed result for lot B.
const seedsToLotAToLotB = async () => {
  mount(SEEDS_SAVED)
  await tap('to-lot-a')
  await waitFor(() => expect(heading()?.textContent).toBe(LOTS['lot-a'].name))
  await searchToLotB()
}

describe('a lot opened from Search over ANOTHER lot that a Seeds view had opened', () => {
  it('control: a lot opened from Search over a page that is not a lot: Cancel opens My seeds', async () => {
    mount('/today')
    await searchToLotB()
    const at = idx()
    await tap('inventory-detail-cancel')
    await waitFor(() => expect(screen.getByTestId('seeds')).toBeTruthy())
    expect(url()).toBe(SEEDS_MINE)
    expect(idx()).toBe(at + 1)
  })

  it('Cancel on lot B opens My seeds, as that control does; it does not go Back onto Search over lot A', async () => {
    await seedsToLotAToLotB()
    const at = idx()
    await tap('inventory-detail-cancel')
    await waitFor(() => expect(screen.getByTestId('seeds')).toBeTruthy())
    expect(url()).toBe(SEEDS_MINE)
    expect(idx()).toBe(at + 1)
  })

  it('Remove on lot B replaces its entry with My seeds; it does not go Back and leave the removed lot\'s entry standing', async () => {
    await seedsToLotAToLotB()
    const at = idx()
    await tap('inventory-remove')
    await tap('inventory-remove-confirm')
    await waitFor(() => expect(screen.getByTestId('seeds')).toBeTruthy())
    expect(deleteSpy).toHaveBeenCalledWith('lot-b')
    expect(url()).toBe(SEEDS_MINE)
    expect(idx()).toBe(at)
  })

  it('lot A is never drawn under lot B\'s address, and lot A itself still goes Back to the view that opened it', async () => {
    mount(SEEDS_SAVED)
    await tap('to-lot-a')
    await waitFor(() => expect(heading()?.textContent).toBe(LOTS['lot-a'].name))
    const seen = []
    const obs = new MutationObserver(() => { seen.push(`${url()} ${heading()?.textContent ?? ''}`) })
    obs.observe(document.body, { childList: true, subtree: true, characterData: true })
    await searchToLotB()
    obs.disconnect()
    expect(seen.filter((s) => s === `/inventory/lot-b ${LOTS['lot-a'].name}`)).toEqual([])
    expect(lotFetches('lot-a')).toBe(1)
    // Back to Search over lot A, Back again to lot A on its own entry: its Cancel is a Back to Saved seeds.
    await act(async () => { window.history.back() })
    await waitFor(() => expect(screen.getByTestId('result-lot-b')).toBeTruthy())
    await act(async () => { window.history.back() })
    await waitFor(() => expect(screen.queryByTestId('result-lot-b')).toBeNull())
    await waitFor(() => expect(heading()?.textContent).toBe(LOTS['lot-a'].name))
    const at = idx()
    await tap('inventory-detail-cancel')
    await waitFor(() => expect(screen.getByTestId('seeds')).toBeTruthy())
    expect(url()).toBe(SEEDS_SAVED)
    expect(idx()).toBe(at - 1)
  })
})
