/**
 * src/__tests__/TopBar.test.jsx
 * NAV-IA-1 (V1.2a-3 Increment C / PR-C1, 2026-05-18) tests.
 *
 * Verifies the More dropdown was replaced by a persistent Favorites star icon,
 * and that Sign Out is no longer present in the TopBar (moved to BottomNav).
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const { locationRef } = vi.hoisted(() => ({
  locationRef: { pathname: '/dashboard' },
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useLocation: () => locationRef,
}))

const authMock = { user: { id: 'user-1' }, profile: { display_name: 'Dave' }, signOut: vi.fn() }
const zoneMock = { activeZone: null }

vi.mock('../context/AuthContext.jsx', () => ({
  useAuth: () => authMock,
}))

vi.mock('../context/ZoneContext.jsx', () => ({
  useZone: () => zoneMock,
}))

import TopBar from '../components/TopBar.jsx'

beforeEach(() => {
  locationRef.pathname = '/dashboard'
  authMock.user = { id: 'user-1' }
  zoneMock.activeZone = null
})

describe('TopBar — NAV-IA-1 layout', () => {
  it('renders a Favorites icon link to /favorites (replaces former More dropdown)', () => {
    render(<TopBar />)
    const fav = screen.getByLabelText('Favorites')
    expect(fav).toBeDefined()
    expect(fav.getAttribute('href')).toBe('/favorites')
  })

  it('does NOT render a More button anymore (Sign Out moved to BottomNav)', () => {
    render(<TopBar />)
    expect(screen.queryByLabelText('More options')).toBeNull()
    expect(screen.queryByRole('button', { name: /more/i })).toBeNull()
  })

  it('does NOT render Sign out in the TopBar', () => {
    render(<TopBar />)
    expect(screen.queryByText('Sign out')).toBeNull()
  })

  it('renders the zone pill', () => {
    render(<TopBar />)
    // Pin text appears as `📍 ` + `Everywhere` siblings inside the <a> — normalize via regex.
    expect(screen.getByText(/Everywhere/)).toBeDefined()
  })

  it('shows active zone name when set', () => {
    zoneMock.activeZone = { name: 'Bedroom Tray' }
    render(<TopBar />)
    expect(screen.getByText(/Bedroom Tray/)).toBeDefined()
  })

  it('renders Sign in link for unauthenticated users (and hides Favorites)', () => {
    authMock.user = null
    render(<TopBar />)
    expect(screen.getByText('Sign in')).toBeDefined()
    expect(screen.queryByLabelText('Favorites')).toBeNull()
  })
})
