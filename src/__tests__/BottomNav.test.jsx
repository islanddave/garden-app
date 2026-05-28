/**
 * src/__tests__/BottomNav.test.jsx
 * NAV-IA-1 (V1.2a-3 Increment C / PR-C1, 2026-05-18) tests.
 *
 * Verifies the new 5-slot bottom-nav layout (Projects · Plants · LOG+ · Inventory · More)
 * plus the Sign Out confirmation flow that moved from TopBar into BottomNav's More menu.
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

const { signOutSpy, navigateSpy, locationRef } = vi.hoisted(() => ({
  signOutSpy: vi.fn(() => Promise.resolve()),
  navigateSpy: vi.fn(),
  locationRef: { pathname: '/dashboard' },
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useLocation: () => locationRef,
  useNavigate: () => navigateSpy,
}))

vi.mock('../context/AuthContext.jsx', () => ({
  useAuth: () => ({
    user:    { id: 'user-1' },
    profile: { display_name: 'Dave', email: 'islanddave@gmail.com' },
    signOut: signOutSpy,
  }),
}))

// V1.2a-4 S1: CatchUpBadge child uses useApiFetch (Clerk-dependent). Stub it here;
// CatchUpBadge has its own test suite.
vi.mock('../components/CatchUpBadge.jsx', () => ({
  default: () => null,
}))

import BottomNav from '../components/BottomNav.jsx'

beforeEach(() => {
  signOutSpy.mockClear()
  navigateSpy.mockClear()
  locationRef.pathname = '/dashboard'
})

describe('BottomNav — NAV-IA-1 layout', () => {
  it('renders Garden + LOG+ + Inventory + More (Projects+Plants unified into Garden)', () => {
    render(<BottomNav />)
    expect(screen.getByText('Garden')).toBeDefined()
    expect(screen.getByText('+Log')).toBeDefined()
    expect(screen.getByText('Inventory')).toBeDefined()
    expect(screen.getByText('More')).toBeDefined()
    expect(screen.queryByText('Projects')).toBeNull()
    expect(screen.queryByText('Plants')).toBeNull()
  })

  it('does NOT render Dashboard in the bottom nav (dropped per 2026-05-15 adjustment)', () => {
    render(<BottomNav />)
    expect(screen.queryByText('Dashboard')).toBeNull()
  })

  it('does NOT render Favorites in the bottom nav (moved to TopBar)', () => {
    render(<BottomNav />)
    expect(screen.queryByText('Favorites')).toBeNull()
  })

  it('tab links point to correct routes', () => {
    render(<BottomNav />)
    expect(screen.getByText('Garden').closest('a').getAttribute('href')).toBe('/garden')
    expect(screen.getByText('Inventory').closest('a').getAttribute('href')).toBe('/inventory')
    // LOG+ has aria-label "Log an event" — search by that since +Log label is also on the +Log span
    expect(screen.getByLabelText('Log an event').getAttribute('href')).toBe('/log')
  })
})

describe('BottomNav — More menu', () => {
  it('More menu is closed by default', () => {
    render(<BottomNav />)
    expect(screen.queryByText('Sign out')).toBeNull()
  })

  it('clicking More opens the menu and shows Sign out', () => {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('More navigation options'))
    expect(screen.getByText('Sign out')).toBeDefined()
  })

  it('shows signed-in identity in the More menu', () => {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('More navigation options'))
    expect(screen.getByText('Dave')).toBeDefined()
  })

  it('Achievements is not visible until More is opened (NAV-REGRESSION restore, 2026-05-22)', () => {
    render(<BottomNav />)
    expect(screen.queryByText('Achievements')).toBeNull()
  })

  it('More menu shows the Achievements link pointing to /achievements', () => {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('More navigation options'))
    const link = screen.getByText('Achievements').closest('a')
    expect(link).not.toBeNull()
    expect(link.getAttribute('href')).toBe('/achievements')
  })

  it('More menu shows the Photos link pointing to /photos (NAV-REGRESSION restore, 2026-05-23)', () => {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('More navigation options'))
    const link = screen.getByText('Photos').closest('a')
    expect(link).not.toBeNull()
    expect(link.getAttribute('href')).toBe('/photos')
  })

  it('More menu shows the Plants link pointing to /plants (NAV-REGRESSION restore / BUG-13, 2026-05-24)', () => {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('More navigation options'))
    const link = screen.getByText('Plants').closest('a')
    expect(link).not.toBeNull()
    expect(link.getAttribute('href')).toBe('/plants')
  })

  it('More menu shows the Garden Helper link pointing to /helper (Post-V2 UX overhaul Inc 2 Bite 1, 2026-05-28)', () => {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('More navigation options'))
    const link = screen.getByText('Garden Helper').closest('a')
    expect(link).not.toBeNull()
    expect(link.getAttribute('href')).toBe('/helper')
  })

  it('does NOT render the Catch-up badge container (hidden 2.0.1 until S1.1 editor ships)', () => {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('More navigation options'))
    expect(screen.queryByTestId('catch-up-nav-item')).toBeNull()
  })
})

describe('BottomNav — Sign Out confirmation flow', () => {
  it('first click on Sign out shows confirmation, does NOT sign out', () => {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('More navigation options'))
    fireEvent.click(screen.getByText('Sign out'))
    expect(screen.getByText('Sign out of your account?')).toBeDefined()
    expect(screen.getByText('Cancel')).toBeDefined()
    expect(screen.getByText('Yes, sign out')).toBeDefined()
    expect(signOutSpy).not.toHaveBeenCalled()
  })

  it('Cancel reverts confirmation, leaves user signed in', () => {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('More navigation options'))
    fireEvent.click(screen.getByText('Sign out'))
    fireEvent.click(screen.getByText('Cancel'))
    expect(screen.queryByText('Sign out of your account?')).toBeNull()
    expect(signOutSpy).not.toHaveBeenCalled()
    // After cancel, Sign out button should be back
    expect(screen.getByText('Sign out')).toBeDefined()
  })

  it('confirming Yes, sign out calls signOut and navigates to /', async () => {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('More navigation options'))
    fireEvent.click(screen.getByText('Sign out'))
    await act(async () => {
      fireEvent.click(screen.getByText('Yes, sign out'))
    })
    expect(signOutSpy).toHaveBeenCalledTimes(1)
    expect(navigateSpy).toHaveBeenCalledWith('/', { replace: true })
  })
})
