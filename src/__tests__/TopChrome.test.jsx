// V4-APPBAR-003 — unified peach header on every surface. No jest-dom (L-182): roles/attrs + toBeTruthy/toBe(null).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { APP_NAME } from '../lib/constants.js'

let mockUser
vi.mock('../context/AuthContext.jsx', () => ({ useAuth: () => ({ user: mockUser }) }))

import TopChrome from '../components/TopChrome.jsx'

function renderAt(path) {
  return render(<MemoryRouter initialEntries={[path]}><TopChrome /></MemoryRouter>)
}

beforeEach(() => { mockUser = { id: 'u1' } })

describe('TopChrome (V4-APPBAR-003) — root: full search-first header', () => {
  it('root tab (/today): wordmark + full search launcher, NO Favorites heart in header', () => {
    renderAt('/today')
    expect(screen.getByText(APP_NAME)).toBeTruthy()
    expect(screen.getByLabelText('Search your garden').getAttribute('href')).toBe('/search')
    expect(screen.queryByLabelText('Favorites')).toBe(null)
  })
  it('brand wordmark links home (/dashboard)', () => {
    renderAt('/garden')
    expect(screen.getByText(APP_NAME).getAttribute('href')).toBe('/dashboard')
  })
  it('root header is 88px + safe-area tall', () => {
    const { container } = renderAt('/dashboard')
    expect(container.querySelector('header').style.height).toBe('calc(88px + env(safe-area-inset-top))')
  })
  it('root renders the daily banner photo + scrim', () => {
    renderAt('/today')
    const img = screen.getByTestId('header-banner')
    expect(img.getAttribute('aria-hidden')).toBe('true')
    expect(img.getAttribute('alt')).toBe('')
    expect(img.getAttribute('src')).toBeTruthy()
    expect(screen.getByTestId('header-banner-scrim')).toBeTruthy()
  })
  it('root keeps a solid peach base under the banner (image-failure fallback)', () => {
    const { container } = renderAt('/garden')
    expect(container.querySelector('header').style.backgroundColor).toBe('rgb(249, 227, 214)')
  })
})

describe('TopChrome (V4-APPBAR-003) — detail: condensed, same header family', () => {
  it('detail (/projects/abc): Back + condensed search icon + banner, 52px', () => {
    const { container } = renderAt('/projects/abc')
    expect(screen.getByTestId('topbar-back')).toBeTruthy()
    expect(screen.getByLabelText('Search your garden').getAttribute('href')).toBe('/search')
    expect(screen.getByTestId('header-banner')).toBeTruthy()
    expect(container.querySelector('header').style.height).toBe('calc(52px + env(safe-area-inset-top))')
  })
  it('detail has NO Favorites heart in the header (rehomed to Garden)', () => {
    renderAt('/projects/abc')
    expect(screen.queryByLabelText('Favorites')).toBe(null)
  })
})

describe('TopChrome (V4-APPBAR-003) — unauth: brand + Sign in, no search', () => {
  it('unauth (/login): brand + Sign in, NO search launcher', () => {
    mockUser = null
    renderAt('/login')
    expect(screen.getByText(APP_NAME)).toBeTruthy()
    expect(screen.getByText('Sign in').getAttribute('href')).toBe('/login')
    expect(screen.queryByLabelText('Search your garden')).toBe(null)
  })
})

describe('TopChrome — capture: immersive bar', () => {
  it('capture (/capture): CaptureBar Back, no search launcher', () => {
    renderAt('/capture')
    expect(screen.getByTestId('capture-back')).toBeTruthy()
    expect(screen.queryByLabelText('Search your garden')).toBe(null)
  })
})

// V4-TOPCHROMEACTIONS-001 (BD-027) — Snap + Harvest as header actions on every content surface.
describe('TopChrome (V4-TOPCHROMEACTIONS-001) — Snap + Harvest header actions', () => {
  for (const path of ['/today', '/garden', '/dashboard']) {
    it(`root ${path}: Snap -> /capture and Harvest -> the harvest form`, () => {
      renderAt(path)
      expect(screen.getByTestId('topchrome-snap').getAttribute('href')).toBe('/capture')
      expect(screen.getByTestId('topchrome-harvest').getAttribute('href')).toBe('/log?event_type=harvest')
    })
  }
  it('detail (/projects/abc): both actions present alongside the search icon', () => {
    renderAt('/projects/abc')
    expect(screen.getByTestId('topchrome-snap').getAttribute('href')).toBe('/capture')
    expect(screen.getByTestId('topchrome-harvest').getAttribute('href')).toBe('/log?event_type=harvest')
    expect(screen.getByTestId('topchrome-search').getAttribute('href')).toBe('/search')
  })
  // The exact-string match in BottomNav's OVERLAYABLE_CREATE is what made the FAB harvest row open
  // as an overlay; the header target must stay byte-identical or the same silent full-page fallback
  // V4-HARVFAB-001 nearly shipped comes back through this door instead.
  it('the Harvest href is byte-identical to the retired FAB row target', () => {
    renderAt('/today')
    expect(screen.getByTestId('topchrome-harvest').getAttribute('href')).toBe('/log?event_type=harvest')
  })
  it('both actions are icon-only with accessible names (no visible text label)', () => {
    renderAt('/today')
    const snap = screen.getByTestId('topchrome-snap')
    const harvest = screen.getByTestId('topchrome-harvest')
    expect(snap.getAttribute('aria-label')).toBe('Snap a photo')
    expect(harvest.getAttribute('aria-label')).toBe('Log a harvest')
    expect(snap.textContent).toBe('')
    expect(harvest.textContent).toBe('')
    expect(snap.querySelector('svg')).toBeTruthy()
    expect(harvest.querySelector('svg')).toBeTruthy()
  })
  // V4-ICON-001: the header must not regress to platform emoji. The registry has no harvest anchor
  // (event.harvest resolves to the emoji basket), which is exactly why these are inline SVG.
  it('neither action renders a platform emoji', () => {
    renderAt('/today')
    const EMOJI = /\p{Extended_Pictographic}/u
    expect(EMOJI.test(screen.getByTestId('topchrome-snap').textContent)).toBe(false)
    expect(EMOJI.test(screen.getByTestId('topchrome-harvest').textContent)).toBe(false)
  })
  it('root keeps the full-width search launcher — actions do NOT displace search-first', () => {
    renderAt('/today')
    expect(screen.getByLabelText('Search your garden').getAttribute('href')).toBe('/search')
    expect(screen.getByText('Search your garden')).toBeTruthy()
  })
  it('unauth (/login) shows NEITHER action — targets are Protected pre-auth', () => {
    mockUser = null
    renderAt('/login')
    expect(screen.queryByTestId('topchrome-snap')).toBe(null)
    expect(screen.queryByTestId('topchrome-harvest')).toBe(null)
  })
  it('capture (/capture) shows NEITHER action — the immersive bar stays immersive', () => {
    renderAt('/capture')
    expect(screen.queryByTestId('topchrome-snap')).toBe(null)
    expect(screen.queryByTestId('topchrome-harvest')).toBe(null)
  })
})
