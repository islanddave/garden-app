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
