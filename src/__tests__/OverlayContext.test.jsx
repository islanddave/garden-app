// V4-OVERLAY-001 Slice 1 — OverlayContext outside and around the provider: no throw outside a
// provider, OverlayLink keeps its target, and the overlay-surface marker. The mechanism itself is
// in OverlayContext.flagOn.test.jsx. No jest-dom (L-182): roles + attrs + text.
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'

import { OverlayProvider, OverlaySurfaceProvider, useInOverlaySurface, useOverlayLocation, useOverlayNavigate, OverlayLink } from '../context/OverlayContext.jsx'

function ShowLoc() {
  const loc = useOverlayLocation()
  return <div data-testid="loc">{loc.pathname}</div>
}

describe('OverlayContext — outside the mechanism', () => {
  it('useOverlayLocation falls back to the real location OUTSIDE a provider (never throws)', () => {
    render(<MemoryRouter initialEntries={['/today']}><ShowLoc /></MemoryRouter>)
    expect(screen.getByTestId('loc').textContent).toBe('/today')
  })

  it('OverlayLink renders a link to the target', () => {
    render(<MemoryRouter initialEntries={['/today']}><OverlayLink to="/search" aria-label="Search">x</OverlayLink></MemoryRouter>)
    expect(screen.getByRole('link', { name: 'Search' }).getAttribute('href')).toBe('/search')
  })

  it('useInOverlaySurface defaults false, and is true inside OverlaySurfaceProvider', () => {
    function Probe() { return <div data-testid="in">{String(useInOverlaySurface())}</div> }
    const { rerender } = render(<Probe />)
    expect(screen.getByTestId('in').textContent).toBe('false')
    rerender(<OverlaySurfaceProvider><Probe /></OverlaySurfaceProvider>)
    expect(screen.getByTestId('in').textContent).toBe('true')
  })
})
