// BUG-SEEDLOTOPENSATFORM-001 follow-up (v4.148.0 regression-impact review, I3) — the lot page's "a key seen
// before is a Back" rule, against the one flow that mints a key while the page stays MOUNTED: an overlay
// over it (header Search is on every page) closed by its Close, backdrop or Escape. useOverlayDismiss
// REPLACES the entry with a fresh key (OverlayContext.jsx), and the page, rendered as the overlay's
// background, is not remounted. If the page files keys only when it opens, that key is unknown to it, so a
// later Back onto it reads as a fresh door and snaps the page to the top, overriding the position the
// browser restored.
//
// And the other side of filing keys on every commit: BrowserRouter commits a route inside a transition,
// after the push has already written the next entry. An urgent commit of this page in between must not file
// that next entry's key, or the next lot's arrival reads as a return and it opens where the last one was.
//
// Real BrowserRouter + OverlayProvider in App.jsx's two-tree shape (page tree at pageLocation, overlay tree
// at the real location), because every half of this lives in the router: the replace, the transition and
// the Back. Leaf mocks as in InventoryDetail.opensAtTop.test.jsx. No jest-dom (L-182).
import React, { useState, useEffect } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent, cleanup } from '@testing-library/react'
import { BrowserRouter, Routes, Route, Link, useNavigate } from 'react-router-dom'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <span /> }))
vi.mock('../components/PhotoUpload.jsx', () => ({ default: () => <span /> }))
vi.mock('../components/forms/PlantingSelect.jsx', () => ({ default: () => <span /> }))
vi.mock('../hooks/useInventory.js', () => ({ useInventory: () => ({ updateItem: vi.fn(), deleteItem: vi.fn() }) }))

import InventoryDetail from '../pages/InventoryDetail.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import { OverlayProvider, useOverlay, OverlayLink, useOverlayDismiss } from '../context/OverlayContext.jsx'

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
  'lot-x': lot('lot-x', 'Ristra Cayenne II Saved seed 2026'),
  'lot-y': lot('lot-y', 'Hot Paper Lantern Saved seed 2026'),
}

// Header Search's stand-in: its X, backdrop and Escape all call the same dismiss (App.jsx OverlayHost).
function SearchStub() {
  const dismiss = useOverlayDismiss()
  return <button type="button" data-testid="close" onClick={dismiss}>close</button>
}
function Shell() {
  const { pageLocation, overlayLocation, background } = useOverlay()
  const navigate = useNavigate()
  // An urgent re-render of the page tree in the same event as a push to another lot: the state update
  // commits first, with the router still on the old lot, and only then does the route's transition land.
  const [renders, setRenders] = useState(0)
  // What the first commit after that click saw: the URL already moved on, the page tree not yet.
  useEffect(() => {
    if (renders === 1 && !inBetween) inBetween = { url: window.location.pathname, page: pageLocation.pathname }
  })
  return (
    <>
      <OverlayLink to="/search" data-testid="open-search">search</OverlayLink>
      <Link to="/elsewhere" data-testid="to-elsewhere">elsewhere</Link>
      <button type="button" data-testid="to-lot-y-urgent"
        onClick={() => { setRenders(renders + 1); navigate('/inventory/lot-y') }}>lot y</button>
      <Routes location={pageLocation}>
        <Route path="/today" element={<Link to="/inventory/lot-x" data-testid="to-lot">lot</Link>} />
        <Route path="/inventory/:id" element={<InventoryDetail />} />
        <Route path="/elsewhere" element={<div data-testid="elsewhere" />} />
      </Routes>
      {background && (
        <Routes location={overlayLocation}>
          <Route path="/search" element={<SearchStub />} />
        </Routes>
      )}
    </>
  )
}

let tops = 0
let inBetween = null
const key = () => window.history.state?.key
const heading = () => screen.queryByRole('heading', { level: 1 })
const lotFetches = (id) => fetchSpy.mock.calls.filter(([p, o]) => String(p) === `/api/inventory-items/${id}` && !o).length
const tap = (id) => act(async () => { fireEvent.click(screen.getByTestId(id)) })

beforeEach(() => {
  fetchSpy.mockReset()
  fetchSpy.mockImplementation((path, opts) => {
    const m = String(path).match(/^\/api\/inventory-items\/(lot-[xy])$/)
    return Promise.resolve(m && !opts ? { ...LOTS[m[1]] } : [])
  })
  tops = 0
  inBetween = null
  window.scrollTo = vi.fn((x, y) => { if (x === 0 && y === 0) tops += 1 })
  window.history.replaceState(null, '', '/today')
})
afterEach(() => { cleanup() })

// /today → the lot page, by a push: a fresh door.
const arrive = async () => {
  render(<ToastProvider><BrowserRouter><OverlayProvider><Shell /></OverlayProvider></BrowserRouter></ToastProvider>)
  await tap('to-lot')
  await waitFor(() => expect(heading()?.textContent).toBe(LOTS['lot-x'].name))
}
const leaveAndComeBack = async () => {
  await tap('to-elsewhere')
  await waitFor(() => expect(screen.getByTestId('elsewhere')).toBeTruthy())
  await act(async () => { window.history.back() })
  await waitFor(() => expect(heading()?.textContent).toBe(LOTS['lot-x'].name))
}

describe('a Back onto the lot page after an overlay over it closed by its Close', () => {
  it('control: arriving is a fresh door (top), and lot → elsewhere → Back leaves the restored position alone', async () => {
    await arrive()
    expect(tops).toBe(1)
    const k1 = key()
    await leaveAndComeBack()
    expect(key()).toBe(k1)
    expect(tops).toBe(1)
  })

  it('lot → header Search → Close (a replace, new key, page not remounted) → elsewhere → Back: no snap to the top', async () => {
    await arrive()
    expect(tops).toBe(1)
    const k1 = key()
    await tap('open-search')
    await waitFor(() => expect(screen.getByTestId('close')).toBeTruthy())
    await tap('close')
    await waitFor(() => expect(screen.queryByTestId('close')).toBeNull())
    const k3 = key()
    // The instrument: the Close really replaced the entry (a key the page never opened on) and really left
    // the page mounted (one fetch of the lot), which is the only shape in which the page can miss the key.
    expect(k3).not.toBe(k1)
    expect(window.location.pathname).toBe('/inventory/lot-x')
    expect(lotFetches('lot-x')).toBe(1)
    await leaveAndComeBack()
    expect(key()).toBe(k3)
    expect(lotFetches('lot-x')).toBe(2)              // the Back remounted the page, so it made its decision
    expect(tops).toBe(1)                             // ... and that decision was "a return", not a fresh door
  })
})

describe('filing keys on every commit never files the NEXT entry\'s key', () => {
  it('lot → another lot, with an urgent commit of the page between the push and the route: still a fresh door', async () => {
    await arrive()
    expect(tops).toBe(1)
    await tap('to-lot-y-urgent')
    await waitFor(() => expect(heading()?.textContent).toBe(LOTS['lot-y'].name))
    // The instrument: a commit really landed in the window, with history already on lot-y's entry while the
    // page tree still rendered lot-x. Without that window this test could not fail.
    expect(inBetween).toEqual({ url: '/inventory/lot-y', page: '/inventory/lot-x' })
    expect(lotFetches('lot-y')).toBe(1)
    expect(tops).toBe(2)
  })
})
