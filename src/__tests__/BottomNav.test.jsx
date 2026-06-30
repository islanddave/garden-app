/**
 * src/__tests__/BottomNav.test.jsx
 * NAV-IA-1 (V1.2a-3 Increment C / PR-C1, 2026-05-18) tests.
 *
 * Verifies the V3-IA 5-slot bottom-nav layout (Garden · Critters · +LOG · Photos · More;
 * Inventory demoted to the More menu) plus the Sign Out confirmation flow.
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

// MVP-Critter Session 2: BottomNavDot child fetches /api/critters/active — stubbed here
// to keep BottomNav tests focused. BottomNavDot has its own test suite.
vi.mock('../components/BottomNavDot.jsx', () => ({
  default: () => null,
}))

// useApiFetch wraps Clerk; stub returns a no-op getToken so BottomNav can mount in tests.
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({
    fetch: () => Promise.resolve(null),
    getToken: () => Promise.resolve(null),
  }),
}))

// useMode requires a ModeProvider ancestor; this suite renders <BottomNav /> bare.
// Desk mode (isField:false) is the default surface these tests exercise (Create
// sheet + More menu). Field-mode behavior has dedicated coverage in BottomNav.modeSwap.test.jsx.
vi.mock('../lib/mode.js', () => ({
  useMode: () => ({ mode: 'desk', isField: false, isDesk: true, setMode: vi.fn(), toggleMode: vi.fn() }),
  MODE: { FIELD: 'field', DESK: 'desk' },
}))

import BottomNav from '../components/BottomNav.jsx'

beforeEach(() => {
  signOutSpy.mockClear()
  navigateSpy.mockClear()
  locationRef.pathname = '/dashboard'
})

describe('BottomNav — V3-IA layout', () => {
  it('renders Today + Garden + Create + DrG + More (V200 nav; Critters + Photos folded into More)', () => {
    render(<BottomNav />)
    expect(screen.getByText('Today')).toBeDefined()
    expect(screen.getByText('Garden')).toBeDefined()
    expect(screen.getByLabelText('Create')).toBeDefined()
    expect(screen.getByText('DrG')).toBeDefined()
    expect(screen.getByText('More')).toBeDefined()
    expect(screen.queryByText('Projects')).toBeNull()
    expect(screen.queryByText('Plants')).toBeNull()
    expect(screen.queryByText('Inventory')).toBeNull()
    // Critters + Photos are no longer first-class tabs (folded into More — V200/V4-THEME-001).
    expect(screen.queryByText('Critters')).toBeNull()
    expect(screen.queryByText('Photos')).toBeNull()
  })

  it('FAB keeps the center slot: tab order is Today · Garden · ＋ · DrG · More', () => {
    render(<BottomNav />)
    const nav = screen.getByLabelText('Main navigation')
    expect(nav.children.length).toBe(5)
    expect(nav.children[0].textContent).toContain('Today')
    expect(nav.children[1].textContent).toContain('Garden')
    expect(nav.children[2].getAttribute('aria-label')).toBe('Create')
    expect(nav.children[3].textContent).toContain('DrG')
    expect(nav.children[4].textContent).toContain('More')
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
    expect(screen.getByText('Today').closest('a').getAttribute('href')).toBe('/today')
    expect(screen.getByText('Garden').closest('a').getAttribute('href')).toBe('/garden')
    expect(screen.getByText('DrG').closest('a').getAttribute('href')).toBe('/findings')
    // Create is not a direct link — it's a button that opens the create action sheet.
    const logBtn = screen.getByLabelText('Create')
    expect(logBtn.tagName).toBe('BUTTON')
    expect(logBtn.getAttribute('aria-haspopup')).toBe('true')
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

  it('More menu shows the Inventory link pointing to /inventory (V3-IA demotion)', () => {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('More navigation options'))
    const link = screen.getByText('Inventory').closest('a')
    expect(link).not.toBeNull()
    expect(link.getAttribute('href')).toBe('/inventory')
  })

  it('More menu shows the Dashboard link pointing to /dashboard (DRG-TODAY-003 demotion)', () => {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('More navigation options'))
    const link = screen.getByText('Dashboard').closest('a')
    expect(link).not.toBeNull()
    expect(link.getAttribute('href')).toBe('/dashboard')
  })

  it('More menu houses Critters (/collection) and Photos (/photos), folded in from the nav (V200)', () => {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('More navigation options'))
    expect(screen.queryByText('Plants')).toBeNull()
    const photos = screen.getAllByText('Photos')
    expect(photos.length).toBe(1)
    expect(photos[0].closest('a').getAttribute('href')).toBe('/photos')
    const critters = screen.getAllByText('Critters')
    expect(critters.length).toBe(1)
    expect(critters[0].closest('a').getAttribute('href')).toBe('/collection')
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

describe('BottomNav — +LOG create action sheet (Increment 1 FAB)', () => {
  it('create sheet is closed by default', () => {
    render(<BottomNav />)
    expect(screen.queryByText('Add a planting')).toBeNull()
    expect(screen.getByLabelText('Create').getAttribute('aria-expanded')).toBe('false')
  })

  it('clicking +LOG opens the sheet with all four create options', () => {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('Create'))
    expect(screen.getByText('Log an event')).toBeDefined()
    expect(screen.getByText('Add a planting')).toBeDefined()
    expect(screen.getByText('New project')).toBeDefined()
    expect(screen.getByText('Add inventory')).toBeDefined()
    expect(screen.getByLabelText('Create').getAttribute('aria-expanded')).toBe('true')
  })

  it('each create option points to the correct route', () => {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('Create'))
    expect(screen.getByText('Log an event').closest('a').getAttribute('href')).toBe('/log')
    expect(screen.getByText('Add a planting').closest('a').getAttribute('href')).toBe('/garden?add=1')
    expect(screen.getByText('New project').closest('a').getAttribute('href')).toBe('/projects/new')
    expect(screen.getByText('Add inventory').closest('a').getAttribute('href')).toBe('/inventory/add')
  })

  it('selecting an option closes the sheet', () => {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('Create'))
    fireEvent.click(screen.getByText('New project'))
    expect(screen.queryByText('Add a planting')).toBeNull()
  })

  it('opening More closes the create sheet (mutually exclusive)', () => {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('Create'))
    expect(screen.getByText('Add a planting')).toBeDefined()
    fireEvent.click(screen.getByLabelText('More navigation options'))
    expect(screen.queryByText('Add a planting')).toBeNull()
    expect(screen.getByText('Sign out')).toBeDefined()
  })

  it('opening create closes the More menu (mutually exclusive)', () => {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('More navigation options'))
    expect(screen.getByText('Sign out')).toBeDefined()
    fireEvent.click(screen.getByLabelText('Create'))
    expect(screen.queryByText('Sign out')).toBeNull()
    expect(screen.getByText('Add a planting')).toBeDefined()
  })
})

// MVP-Critter Session 4 Phase A — Settings entry placement.
describe('Settings entry in More menu', () => {
  it('renders Settings link between Garden Helper and Sign out', () => {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('More navigation options'))
    const settings = screen.getByText('Settings')
    expect(settings).toBeDefined()
    expect(settings.closest('a').getAttribute('href')).toBe('/settings')

    // Order check: in DOM order Garden Helper precedes Settings precedes Sign out.
    const helperEl = screen.getByText('Garden Helper')
    const signoutEl = screen.getByText('Sign out')
    const all = Array.from(document.querySelectorAll('a, button'))
    const helperIdx = all.findIndex(el => el.contains(helperEl))
    const settingsIdx = all.findIndex(el => el.contains(settings))
    const signoutIdx = all.findIndex(el => el.contains(signoutEl))
    expect(helperIdx).toBeGreaterThan(-1)
    expect(settingsIdx).toBeGreaterThan(helperIdx)
    expect(signoutIdx).toBeGreaterThan(settingsIdx)
  })

  it('clicking Settings closes the More menu', () => {
    render(<BottomNav />)
    fireEvent.click(screen.getByLabelText('More navigation options'))
    expect(screen.getByText('Settings')).toBeDefined()
    fireEvent.click(screen.getByText('Settings'))
    // Sign out vanishes when menu closes (deterministic signal the menu collapsed).
    expect(screen.queryByText('Sign out')).toBeNull()
  })
})
