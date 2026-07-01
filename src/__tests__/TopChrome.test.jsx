// V4-APPBAR-001 — TopChrome gate. No jest-dom (L-182): roles/attrs + toBeTruthy/toBe(null).
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { APP_NAME } from '../lib/constants.js'

vi.mock('../context/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }))
vi.mock('../components/TopBar.jsx', () => ({ default: () => <div data-testid="topbar-fallback">bar</div> }))

import TopChrome from '../components/TopChrome.jsx'

function renderAt(path) {
  return render(<MemoryRouter initialEntries={[path]}><TopChrome /></MemoryRouter>)
}

describe('TopChrome (V4-APPBAR-001) — search-first header', () => {
  it('root tab (/today): wordmark + Favorites + search launcher, NO green TopBar', () => {
    renderAt('/today')
    expect(screen.getByText(APP_NAME)).toBeTruthy()
    expect(screen.getByLabelText('Favorites').getAttribute('href')).toBe('/favorites')
    expect(screen.getByLabelText('Search your garden').getAttribute('href')).toBe('/search')
    expect(screen.queryByTestId('topbar-fallback')).toBe(null)
  })
  it('brand wordmark links home (/dashboard)', () => {
    renderAt('/garden')
    expect(screen.getByText(APP_NAME).getAttribute('href')).toBe('/dashboard')
  })
  it('header is 88px + safe-area inset tall', () => {
    const { container } = renderAt('/dashboard')
    expect(container.querySelector('header').style.height).toBe('calc(88px + env(safe-area-inset-top))')
  })
  it('detail route (/projects/abc): falls back to the full TopBar', () => {
    renderAt('/projects/abc')
    expect(screen.getByTestId('topbar-fallback')).toBeTruthy()
    expect(screen.queryByLabelText('Search your garden')).toBe(null)
  })
})
