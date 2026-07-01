// V4-APPBAR-001 — TopChrome gate. No jest-dom (L-182): roles/attrs + toBeTruthy/toBe(null).
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../context/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }))
vi.mock('../components/TopBar.jsx', () => ({ default: () => <div data-testid="topbar-fallback">bar</div> }))

import TopChrome from '../components/TopChrome.jsx'

describe('TopChrome (V4-APPBAR-001)', () => {
  it('root tab (/today): minimal strip with the contained Favorites entry, NO app-name TopBar', () => {
    render(<MemoryRouter initialEntries={['/today']}><TopChrome /></MemoryRouter>)
    const fav = screen.getByLabelText('Favorites')
    expect(fav.getAttribute('href')).toBe('/favorites')
    expect(screen.queryByTestId('topbar-fallback')).toBe(null)
  })
  it('detail route (/projects/abc): falls back to the full TopBar', () => {
    render(<MemoryRouter initialEntries={['/projects/abc']}><TopChrome /></MemoryRouter>)
    expect(screen.getByTestId('topbar-fallback')).toBeTruthy()
    expect(screen.queryByLabelText('Favorites')).toBe(null)
  })
})
