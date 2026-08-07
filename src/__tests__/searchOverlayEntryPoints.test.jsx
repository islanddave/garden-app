// V4-OVERLAY-001 Slice 1 — /search opens as a FLYOVER from BOTH entry points, and the tab
// underneath is never navigated away from.
//
// WHY THIS FILE EXISTS. Slice 1's whole deliverable is "/search has exactly two entry points
// (TopChrome's root launcher and its detail magnifier); convert both, so search is UNIFORMLY an
// overlay and no inconsistency can exist" (design V102 §8.4). Nothing tested that. Reverting BOTH
// call sites from <OverlayLink> to a plain <Link> — the exact regression that silently returns
// /search to full-page navigation — left the whole targeted suite (32 tests across
// TopChrome/Search/App.routes/OverlayContext/overlayEntryPoints) GREEN. TopChrome.test.jsx pins only
// `href === '/search'`, which is byte-identical for both link types, and overlayEntryPoints.test.jsx
// covers Slice 2's /log tiles, never /search. Mutant recorded surviving 32/32 before this file.
//
// The flag is deliberately NOT mocked here. OVERLAY_ROUTES_ENABLED's shipped value is what makes
// search a flyover in prod; pinning the real wiring is the point. If the flag is ever intentionally
// flipped off, this file SHOULD go red — search would have stopped being a flyover.
//
// No jest-dom (L-182): attributes + toBe/toBeTruthy only.
import React, { useEffect } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'
import { OverlayProvider, useOverlay, useOverlayNavigate } from '../context/OverlayContext.jsx'

let mockUser
vi.mock('../context/AuthContext.jsx', () => ({ useAuth: () => ({ user: mockUser }) }))

import TopChrome from '../components/TopChrome.jsx'

beforeEach(() => { mockUser = { id: 'u1' } })

// Reports the background the app navigated WITH — the single bit that decides flyover vs full page.
function BgSink() {
  const loc = useLocation()
  return <div data-testid="bg">{loc.state?.background?.pathname ?? 'none'}</div>
}

// Explicit cleanup: RTL auto-cleans BETWEEN tests, not between calls within one. The uniformity
// test below drives four paths in a single test, and without this the headers accumulate and
// getByLabelText throws "found multiple elements" — a failure mode unrelated to what is asserted.
function openSearchFrom(path) {
  cleanup()
  render(
    <MemoryRouter initialEntries={[path]}>
      <TopChrome />
      <Routes><Route path="*" element={<BgSink />} /></Routes>
    </MemoryRouter>
  )
  fireEvent.click(screen.getByLabelText('Search your garden'))
  return screen.getByTestId('bg').textContent
}

describe('/search entry points — BOTH carry a background (V102 §8.4)', () => {
  // TopChrome.jsx root variant (cls === 'root'): the full "Search your garden" launcher.
  it('root launcher (/today) opens search carrying /today as the background', () => {
    expect(openSearchFrom('/today')).toBe('/today')
  })

  // TopChrome.jsx detail variant (cls === 'detail'): the compact magnifier.
  it('detail magnifier (/plantings/p1) opens search carrying /plantings/p1 as the background', () => {
    expect(openSearchFrom('/plantings/p1')).toBe('/plantings/p1')
  })

  // Uniformity is the property §8.4 leans on to ship search alone: two entry points, SAME behaviour,
  // so "which one did I tap" can never decide whether search flies over or navigates away.
  it('both entry points behave identically — neither is a plain link', () => {
    expect(openSearchFrom('/today')).not.toBe('none')
    expect(openSearchFrom('/garden')).not.toBe('none')
    expect(openSearchFrom('/plantings/p1')).not.toBe('none')
    expect(openSearchFrom('/inventory/i1')).not.toBe('none')
  })

  // Architecture A's deep-link property (V102 §1): the overlay is route-backed, so the control is a
  // real anchor to a real route. A middle-click / "open in new tab" / shared URL still renders
  // /search full-page. A non-anchor (button + navigate) would silently lose that.
  it('the launcher stays a real anchor to /search (deep-link/full-page path preserved)', () => {
    render(<MemoryRouter initialEntries={['/today']}><TopChrome /></MemoryRouter>)
    expect(screen.getByLabelText('Search your garden').getAttribute('href')).toBe('/search')
  })
})

// ── The actual goal statement: "flyovers over the current tab, never navigate away" ───────────────
//
// STATED PLAINLY: jsdom has no layout engine, no stacking contexts and no scrollports, so "the
// flyover visually covers the tab" is UNOBSERVABLE here and is NOT asserted. What IS observable —
// and is what the visual claim reduces to structurally — is that the background tab is never
// unmounted or remounted when the overlay opens. A tab that survives keeps its scroll offset, its
// fetched data and its component state; that is the difference between a flyover and a navigation.
let mounts = 0
let unmounts = 0
function TodayTab() {
  useEffect(() => { mounts += 1; return () => { unmounts += 1 } }, [])
  return <div data-testid="today">TODAY TAB</div>
}

// A miniature of App.jsx's AppShell: page tree at pageLocation, overlay tree at overlayLocation,
// mounted only when a background exists. Same two-tree shape, without importing all ~50 pages.
function MiniShell() {
  const { pageLocation, overlayLocation, background } = useOverlay()
  return (
    <>
      <Routes location={pageLocation}>
        <Route path="/today" element={<TodayTab />} />
      </Routes>
      {background && (
        <Routes location={overlayLocation}>
          <Route path="/search" element={<div data-testid="overlay">SEARCH OVERLAY</div>} />
        </Routes>
      )}
    </>
  )
}

function Opener() {
  const nav = useOverlayNavigate()
  return <button onClick={() => nav('/search')}>open search</button>
}

describe('opening /search does not navigate away from the tab underneath', () => {
  beforeEach(() => { mounts = 0; unmounts = 0 })

  it('the background tab stays MOUNTED (never remounted) while the overlay renders over it', () => {
    render(
      <MemoryRouter initialEntries={['/today']}>
        <OverlayProvider>
          <Opener />
          <MiniShell />
        </OverlayProvider>
      </MemoryRouter>
    )
    expect(mounts).toBe(1)
    expect(screen.queryByTestId('overlay')).toBe(null)

    fireEvent.click(screen.getByText('open search'))

    // The overlay tree is up...
    expect(screen.getByTestId('overlay')).toBeTruthy()
    // ...and the tab underneath is STILL THERE, same instance: not unmounted, not remounted.
    // This is the assertion that fails if the page tree ever stops rendering at pageLocation.
    expect(screen.getByTestId('today')).toBeTruthy()
    expect(unmounts).toBe(0)
    expect(mounts).toBe(1)
  })
})
