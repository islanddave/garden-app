// BUG-SEEDLOTOPENSATFORM-001 follow-up (v4.148.0 regression-impact review, I3) — the lot page's "a key seen
// before is a Back" rule, against the one flow that mints a key while the page stays MOUNTED: an overlay
// over it (header Search is on every page) closed by its Close, backdrop or Escape. Since
// BUG-OVERLAYDISMISSREKEY-001 a close walks back to the page's own entry when it can prove where that entry
// is, and REPLACES the entry with a fresh key only when it cannot (an overlay opened by the previous bundle,
// among others: OverlayContext.jsx planOverlayClose). In the replace case the page, rendered as the overlay's
// background, is not remounted. If the page files keys only when it opens, that key is unknown to it, so a
// later Back onto it reads as a fresh door and snaps the page to the top, overriding the position the
// browser restored. Both closes are pinned below.
//
// And the other side of filing keys on every commit: BrowserRouter commits a route inside a transition,
// after the push has already written the next entry. An urgent commit of this page in between must not file
// that next entry's key, or the next lot's arrival reads as a return and it opens where the last one was.
//
// Real BrowserRouter + OverlayProvider in App.jsx's two-tree shape (page tree at pageLocation, overlay tree
// at the real location), because every half of this lives in the router: the replace, the transition and
// the Back. Leaf mocks as in InventoryDetail.opensAtTop.test.jsx. No jest-dom (L-182).
//
// BUG-DETAILPAGESCARRYSCROLL-001 — the shell now carries App.jsx's page-scroll manager too, as AppShell
// does, so the "top" and the "restore" are the MANAGER's per-entry decisions (rimpact-scrollmanager
// IMPORTANT-9): the exact count of page resets this suite used to pin became, for each entry, which row the
// manager decided and what it scrolled to. The property under test is unchanged — a Back onto the lot, after
// either close, is a RETURN to the lot's own place, never a snap to the top — and it is now asserted as the
// offset filed for that entry coming back, which is what Dave sees.
import React, { useState, useEffect } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent, cleanup } from '@testing-library/react'
import { BrowserRouter, Routes, Route, Link, useNavigate, useLocation, useNavigationType } from 'react-router-dom'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <span /> }))
vi.mock('../components/PhotoUpload.jsx', () => ({ default: () => <span /> }))
vi.mock('../components/forms/PlantingSelect.jsx', () => ({ default: () => <span /> }))
vi.mock('../hooks/useInventory.js', () => ({ useInventory: () => ({ updateItem: vi.fn(), deleteItem: vi.fn() }) }))

import InventoryDetail from '../pages/InventoryDetail.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import { OverlayProvider, useOverlay, OverlayLink, useOverlayDismiss } from '../context/OverlayContext.jsx'
import { usePageScrollManager, PageScrollProvider } from '../hooks/usePageScrollManager.js'

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
// Header Search as the PREVIOUS bundle opened it: a background with no historyEntry, which a close can only
// replace to.
function LegacySearchLink() {
  const loc = useLocation()
  return <Link to="/search" state={{ background: loc }} data-testid="open-search-legacy">search (old bundle)</Link>
}
function Shell() {
  const { pageLocation, overlayLocation, background } = useOverlay()
  const navigationType = useNavigationType()
  // AppShell's manager, as App.jsx calls it; every decision is recorded with the entry it was made for.
  const pageScroll = usePageScrollManager({ pageLocation, location: overlayLocation, navigationType, onDecision: (d) => decisions.push(d) })
  const navigate = useNavigate()
  // An urgent re-render of the page tree in the same event as a push to another lot: the state update
  // commits first, with the router still on the old lot, and only then does the route's transition land.
  const [renders, setRenders] = useState(0)
  // What the first commit after that click saw: the URL already moved on, the page tree not yet.
  useEffect(() => {
    if (renders === 1 && !inBetween) inBetween = { url: window.location.pathname, page: pageLocation.pathname }
  })
  return (
    <PageScrollProvider value={pageScroll}>
      <OverlayLink to="/search" data-testid="open-search">search</OverlayLink>
      <LegacySearchLink />
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
    </PageScrollProvider>
  )
}

// The scroll surface: every scrollTo recorded as the offset it asked for (the manager passes an options
// object, the page's own reset (0, 0)); the page can be scrolled by hand, which files it.
let calls = []
let decisions = []
let inBetween = null
const setY = (y) => Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: y })
const scrollLotTo = (y) => act(() => { setY(y); window.dispatchEvent(new Event('scroll')) })
const key = () => window.history.state?.key
const heading = () => screen.queryByRole('heading', { level: 1 })
const lotFetches = (id) => fetchSpy.mock.calls.filter(([p, o]) => String(p) === `/api/inventory-items/${id}` && !o).length
const tap = (id) => act(async () => { fireEvent.click(screen.getByTestId(id)) })
// The manager's decisions for one page, in order: which row, and what it did.
const onPage = (path) => decisions.filter((d) => d.path === path).map((d) => (d.action === 'RESTORE' ? `${d.row}:RESTORE ${d.y}` : `${d.row}:${d.action}`))
// The resets the PAGE made itself (the pre-manager contract): scrollTo(0, 0) in the positional form.
let pageResets = 0

beforeEach(() => {
  fetchSpy.mockReset()
  fetchSpy.mockImplementation((path, opts) => {
    const m = String(path).match(/^\/api\/inventory-items\/(lot-[xy])$/)
    return Promise.resolve(m && !opts ? { ...LOTS[m[1]] } : [])
  })
  calls = []
  decisions = []
  pageResets = 0
  inBetween = null
  setY(0)
  window.scrollTo = vi.fn((a, b) => {
    if (a && typeof a === 'object') { calls.push(a.top); setY(a.top); return }
    if (a === 0 && b === 0) pageResets += 1
    calls.push(b); setY(b)
  })
  // The restore driver's frames never run here: its FIRST attempt, in the commit, is what is asserted.
  window.requestAnimationFrame = () => 1
  window.cancelAnimationFrame = () => {}
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
const LOT_X = '/inventory/lot-x'

describe('a Back onto the lot page after an overlay over it closed by its Close', () => {
  it('control: arriving is a fresh door (top), and lot → elsewhere → Back returns to the lot\'s own place', async () => {
    await arrive()
    expect(onPage(LOT_X)).toEqual(['2:TOP'])
    const k1 = key()
    scrollLotTo(700)
    await leaveAndComeBack()
    expect(key()).toBe(k1)
    expect(onPage(LOT_X)).toEqual(['2:TOP', '4:RESTORE 700'])
    expect(calls.at(-1)).toBe(700)
    expect(pageResets).toBe(0)                       // the page itself never resets with the manager on
  })

  it('lot → header Search → Close (walks back to the lot\'s own entry) → elsewhere → Back: its place, not the top', async () => {
    await arrive()
    const k1 = key()
    scrollLotTo(700)
    await tap('open-search')
    await waitFor(() => expect(screen.getByTestId('close')).toBeTruthy())
    await tap('close')
    await waitFor(() => expect(screen.queryByTestId('close')).toBeNull())
    // The instrument: the close landed on the lot's own entry, and the page was never remounted.
    expect(key()).toBe(k1)
    expect(window.location.pathname).toBe(LOT_X)
    expect(lotFetches('lot-x')).toBe(1)
    await leaveAndComeBack()
    expect(key()).toBe(k1)
    // The open and the close kept the page's entry (row 0): nothing moved it.
    expect(onPage(LOT_X)).toEqual(['2:TOP', '0:NONE', '0:NONE', '4:RESTORE 700'])
    expect(pageResets).toBe(0)
  })

  it('lot → header Search opened by the previous bundle → Close (the replace fallback: new key, page not remounted) → elsewhere → Back: its place, not the top', async () => {
    await arrive()
    const k1 = key()
    scrollLotTo(700)
    await tap('open-search-legacy')
    await waitFor(() => expect(screen.getByTestId('close')).toBeTruthy())
    await tap('close')
    await waitFor(() => expect(screen.queryByTestId('close')).toBeNull())
    const k3 = key()
    // The instrument: the Close really replaced the entry (a key the page never opened on) and really left
    // the page mounted (one fetch of the lot), which is the only shape in which the page can miss the key.
    expect(k3).not.toBe(k1)
    expect(window.location.pathname).toBe(LOT_X)
    expect(lotFetches('lot-x')).toBe(1)
    await leaveAndComeBack()
    expect(key()).toBe(k3)
    expect(lotFetches('lot-x')).toBe(2)              // the Back remounted the page, so it made its decision
    // ... and the replaced entry, stamped to continue k1, answers to the lot's page entry: the offset filed
    // before Search comes back. A snap to the top here would read '4:TOP'.
    expect(onPage(LOT_X)).toEqual(['2:TOP', '0:NONE', '0:NONE', '4:RESTORE 700'])
    expect(pageResets).toBe(0)
  })
})

describe('filing keys on every commit never files the NEXT entry\'s key', () => {
  it('lot → another lot, with an urgent commit of the page between the push and the route: still a fresh door', async () => {
    await arrive()
    await tap('to-lot-y-urgent')
    await waitFor(() => expect(heading()?.textContent).toBe(LOTS['lot-y'].name))
    // The instrument: a commit really landed in the window, with history already on lot-y's entry while the
    // page tree still rendered lot-x. Without that window this test could not fail.
    expect(inBetween).toEqual({ url: '/inventory/lot-y', page: '/inventory/lot-x' })
    expect(lotFetches('lot-y')).toBe(1)
    expect(onPage(LOT_X)).toEqual(['2:TOP'])
    expect(onPage('/inventory/lot-y')).toEqual(['2:TOP'])
    expect(pageResets).toBe(0)
  })
})
