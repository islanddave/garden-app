// V4-OVERLAY-001 Slice 1 — OverlayContext with OVERLAY_ROUTES_ENABLED mocked TRUE. Proves the
// mechanism actually works when enabled: a valid background is honored (pageLocation follows it),
// junk is rejected (stale-background guard), navigate carries the current location as background,
// and dismiss returns to the background URL. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'

vi.mock('../lib/featureFlags.js', () => ({ OVERLAY_ROUTES_ENABLED: true }))

import { OverlayProvider, useOverlayLocation, useOverlayNavigate, useOverlayDismiss } from '../context/OverlayContext.jsx'

function ShowLoc() {
  const loc = useOverlayLocation()
  return <div data-testid="loc">{loc.pathname}</div>
}

describe('OverlayContext — flag ON (mechanism)', () => {
  it('a valid background is honored: pageLocation follows the background while the real URL is the overlay', () => {
    render(
      <MemoryRouter initialEntries={[{ pathname: '/search', state: { background: { pathname: '/today', search: '' } } }]}>
        <OverlayProvider><ShowLoc /></OverlayProvider>
      </MemoryRouter>
    )
    expect(screen.getByTestId('loc').textContent).toBe('/today') // page follows the background
  })

  it('a junk background (not a location object) is REJECTED — degrades to full page (stale-background guard)', () => {
    render(
      <MemoryRouter initialEntries={[{ pathname: '/search', state: { background: 'not-a-location' } }]}>
        <OverlayProvider><ShowLoc /></OverlayProvider>
      </MemoryRouter>
    )
    expect(screen.getByTestId('loc').textContent).toBe('/search') // no valid bg -> real url
  })

  it('useOverlayNavigate carries the CURRENT location as background', () => {
    let seenBg = 'UNSET'
    function Sink() { seenBg = useLocation().state?.background?.pathname; return null }
    function Opener() { const nav = useOverlayNavigate(); return <button onClick={() => nav('/search')}>go</button> }
    render(
      <MemoryRouter initialEntries={['/today']}>
        <Opener />
        <Routes><Route path="*" element={<Sink />} /></Routes>
      </MemoryRouter>
    )
    fireEvent.click(screen.getByText('go'))
    expect(seenBg).toBe('/today')
  })

  it('useOverlayDismiss returns to the background URL', () => {
    let landed = 'UNSET'
    function Sink() { landed = useLocation().pathname; return null }
    function Dismisser() { const d = useOverlayDismiss(); return <button onClick={d}>close</button> }
    render(
      <MemoryRouter initialEntries={[{ pathname: '/search', state: { background: { pathname: '/today', search: '' } } }]}>
        <OverlayProvider>
          <Dismisser />
          <Routes><Route path="*" element={<Sink />} /></Routes>
        </OverlayProvider>
      </MemoryRouter>
    )
    fireEvent.click(screen.getByText('close'))
    expect(landed).toBe('/today')
  })

  it('useOverlayDismiss with NO background falls back to /today', () => {
    let landed = 'UNSET'
    function Sink() { landed = useLocation().pathname; return null }
    function Dismisser() { const d = useOverlayDismiss(); return <button onClick={d}>close</button> }
    render(
      <MemoryRouter initialEntries={['/log']}>
        <OverlayProvider>
          <Dismisser />
          <Routes><Route path="*" element={<Sink />} /></Routes>
        </OverlayProvider>
      </MemoryRouter>
    )
    fireEvent.click(screen.getByText('close'))
    expect(landed).toBe('/today')
  })
})
