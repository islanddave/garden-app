// V4-OVERLAY-001 Slice 1 — OverlayContext, flag OFF (the shipped default). Proves the overlay
// system is inert: no throw outside a provider, a stale background in history state is ignored,
// and the nav helpers degrade to plain navigate/Link. No jest-dom (L-182): roles + attrs + text.
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'
import { OverlayProvider, useOverlayLocation, useOverlayNavigate, OverlayLink } from '../context/OverlayContext.jsx'

function ShowLoc() {
  const loc = useOverlayLocation()
  return <div data-testid="loc">{loc.pathname}</div>
}

describe('OverlayContext — flag OFF (inert, shipped default)', () => {
  it('useOverlayLocation falls back to the real location OUTSIDE a provider (never throws)', () => {
    render(<MemoryRouter initialEntries={['/today']}><ShowLoc /></MemoryRouter>)
    expect(screen.getByTestId('loc').textContent).toBe('/today')
  })

  it('inside the provider, a background in history state is IGNORED when the flag is off', () => {
    render(
      <MemoryRouter initialEntries={[{ pathname: '/search', state: { background: { pathname: '/today', search: '' } } }]}>
        <OverlayProvider><ShowLoc /></OverlayProvider>
      </MemoryRouter>
    )
    // flag off -> pageLocation is the REAL url, not the background
    expect(screen.getByTestId('loc').textContent).toBe('/search')
  })

  it('useOverlayNavigate does a plain navigate (no background in state) when the flag is off', () => {
    let seenState = 'UNSET'
    function Sink() { seenState = useLocation().state; return null }
    function Opener() { const nav = useOverlayNavigate(); return <button onClick={() => nav('/search')}>go</button> }
    render(
      <MemoryRouter initialEntries={['/today']}>
        <Opener />
        <Routes><Route path="*" element={<Sink />} /></Routes>
      </MemoryRouter>
    )
    fireEvent.click(screen.getByText('go'))
    expect(seenState == null || seenState.background == null).toBe(true)
  })

  it('OverlayLink renders a plain link to the target when the flag is off', () => {
    render(<MemoryRouter initialEntries={['/today']}><OverlayLink to="/search" aria-label="Search">x</OverlayLink></MemoryRouter>)
    expect(screen.getByRole('link', { name: 'Search' }).getAttribute('href')).toBe('/search')
  })
})
