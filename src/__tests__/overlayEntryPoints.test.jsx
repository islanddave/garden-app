// V4-OVERLAY-001 Slice 2 — entry points open /log as an overlay (carry `background`), and the
// in-overlay cross-links (OverlaySwapLink) preserve the ORIGINAL background rather than re-pointing it
// at the overlay's own url. Real react-router + real OverlayProvider (flag on in prod).
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'
import { OverlayProvider, OverlaySwapLink } from '../context/OverlayContext.jsx'

// HarvestReadyTile pulls in useApiFetch transitively via its row nav only; stub api to be safe.
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: vi.fn(() => Promise.resolve([])), getToken: vi.fn() }) }))

import HarvestReadyTile from '../components/HarvestReadyTile.jsx'

function BgSink() {
  const loc = useLocation()
  return <div data-testid="bg">{loc.state?.background?.pathname ?? 'none'}</div>
}

describe('overlay entry points — background wiring', () => {
  it('HarvestReadyTile row tap opens /log as an overlay carrying the origin as background', () => {
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <Routes>
          <Route path="/dashboard" element={<HarvestReadyTile harvestReady={[{ project_id: 'p1', name: 'Cherry Tomatoes', days_since_obs: 1 }]} />} />
          <Route path="/log" element={<BgSink />} />
        </Routes>
      </MemoryRouter>
    )
    fireEvent.click(screen.getByText('Cherry Tomatoes'))
    // navigated to /log with background === the page it was launched from
    expect(screen.getByTestId('bg').textContent).toBe('/dashboard')
  })
})

describe('OverlaySwapLink — preserves the existing background (in-overlay cross-link)', () => {
  it('carries the ORIGINAL background forward (not the overlay url) when an overlay is open', () => {
    render(
      <MemoryRouter initialEntries={[{ pathname: '/log', state: { background: { pathname: '/today', search: '' } } }]}>
        <OverlayProvider>
          <Routes>
            <Route path="/log" element={<OverlaySwapLink to="/log/many">Log many</OverlaySwapLink>} />
            <Route path="/log/many" element={<BgSink />} />
          </Routes>
        </OverlayProvider>
      </MemoryRouter>
    )
    fireEvent.click(screen.getByText('Log many'))
    // background stayed /today — NOT rewritten to /log (the overlay's own url)
    expect(screen.getByTestId('bg').textContent).toBe('/today')
  })

  it('full-page (no overlay open) is a plain link — no background is set', () => {
    render(
      <MemoryRouter initialEntries={['/log']}>
        <OverlayProvider>
          <Routes>
            <Route path="/log" element={<OverlaySwapLink to="/log/many">Log many</OverlaySwapLink>} />
            <Route path="/log/many" element={<BgSink />} />
          </Routes>
        </OverlayProvider>
      </MemoryRouter>
    )
    fireEvent.click(screen.getByText('Log many'))
    expect(screen.getByTestId('bg').textContent).toBe('none')
  })
})
