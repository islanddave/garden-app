import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ModeProvider } from '../context/ModeContext.jsx'
import { MODE } from '../lib/mode.js'

// Mock useAuth — BottomNav requires { profile, signOut }; tests don't exercise auth.
vi.mock('../context/AuthContext.jsx', () => ({
  useAuth: () => ({
    user: { id: 'test-user' },
    profile: { display_name: 'Test User', email: 'test@example.com' },
    signOut: vi.fn(),
  }),
}))

// Mock useApiFetch — BottomNav passes getToken into <BottomNavDot> (added by
// Critter S3); test doesn't exercise the dot's fetch path.
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({
    fetch: vi.fn(),
    getToken: vi.fn(async () => 'test-token'),
  }),
}))

// Stub BottomNavDot — orthogonal to mode-swap; avoids Clerk/fetch dependencies.
vi.mock('../components/BottomNavDot.jsx', () => ({
  default: () => null,
}))

// Stub CatchUpBadge — orthogonal to mode-swap.
vi.mock('../components/CatchUpBadge.jsx', () => ({
  default: () => <div data-testid="catch-up-badge-stub" />,
}))

// Stub feature flag — keep CATCH_UP_EDITOR_SHIPPED stable for the test.
// V4-OVERLAY-001 Slice 2: BottomNav's create-menu Log/Log-many rows are now <OverlayLink>s, which
// read OVERLAY_ROUTES_ENABLED at render; the partial mock must export it (vitest throws on an
// undefined mocked export). Prod value is true.
// PARTIAL mock (importOriginal spread), not an enumerated one. The old form listed every flag this
// tree touches by hand, so each new export elsewhere in featureFlags.js broke this file with
// "No X export is defined on the mock" — it broke on PROJECTS_HIDDEN, again on SPACE_PHOTOS_ENABLED,
// and again on DISMISS_REGISTRY_ENABLED when Sheet joined the dismiss registry. Spreading the real
// module means only the flags this file actually pins are overridden and the rest track prod.
vi.mock('../lib/featureFlags.js', async (importOriginal) => ({
  ...(await importOriginal()),
  CATCH_UP_EDITOR_SHIPPED: false,
  OVERLAY_ROUTES_ENABLED: true,
  PROJECTS_HIDDEN: false,
  SPACE_PHOTOS_ENABLED: false,
}))

import BottomNav from '../components/BottomNav.jsx'

function renderAt(initialMode, initialPath = '/dashboard') {
  return render(
    <ModeProvider initialMode={initialMode}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/dashboard" element={<><BottomNav /><div data-testid="dashboard-stub" /></>} />
          <Route path="/field"     element={<div data-testid="field-stub" />} />
          <Route path="/log"       element={<div data-testid="log-stub" />} />
        </Routes>
      </MemoryRouter>
    </ModeProvider>
  )
}

describe('BottomNav Field/Desk mode swap (Inc 2 Bite 3)', () => {
  describe('Desk mode (default) — +LOG FAB regression coverage', () => {
    it('renders the +LOG FAB center button', () => {
      renderAt(MODE.DESK)
      const createBtn = screen.getByLabelText('Create')
      expect(createBtn).toBeDefined()
      expect(createBtn.tagName).toBe('BUTTON')
    })

    it('does NOT render the Field mic affordance', () => {
      renderAt(MODE.DESK)
      expect(screen.queryByTestId('bottomnav-field-mic')).toBeNull()
    })

    it('tapping +LOG opens the create action sheet with the 4 actions', () => {
      renderAt(MODE.DESK)
      fireEvent.click(screen.getByLabelText('Create'))
      // Action sheet markers from CREATE_ACTIONS (Slice 9: 3 first-class actions;
      // V4-SOWFAB-001 added Sow from seed as the 4th, filling the <=4 budget)
      expect(screen.getByText('Log an event')).toBeDefined()
      expect(screen.getByText('Log many')).toBeDefined()
      expect(screen.getByText('Add a planting')).toBeDefined()
      expect(screen.getByText('Sow from seed')).toBeDefined()
      expect(screen.queryByText('New project')).toBeNull()
      expect(screen.queryByText('Add inventory')).toBeNull()
    })
  })

  describe('Field mode — mic affordance', () => {
    it('renders the Field mic affordance in place of +LOG', () => {
      renderAt(MODE.FIELD)
      const mic = screen.getByTestId('bottomnav-field-mic')
      expect(mic).toBeDefined()
      expect(mic.getAttribute('aria-label')).toBe('Go to field capture')
      expect(mic.getAttribute('href')).toBe('/field')
    })

    it('does NOT render the +LOG FAB center button in Field mode', () => {
      renderAt(MODE.FIELD)
      expect(screen.queryByLabelText('Create')).toBeNull()
    })

    it('tapping the mic affordance navigates to /field (no action sheet)', () => {
      renderAt(MODE.FIELD)
      fireEvent.click(screen.getByTestId('bottomnav-field-mic'))
      expect(screen.getByTestId('field-stub')).toBeDefined()
      // Action sheet must NOT have opened
      expect(screen.queryByText('Add to your garden')).toBeNull()
    })
  })

  describe('Mode swap is reactive', () => {
    it('Today, Garden, DrG, More tabs render in both modes (non-swap regression check)', () => {
      const { unmount } = renderAt(MODE.DESK)
      expect(screen.getByText('Today')).toBeDefined()
      expect(screen.getByText('Garden')).toBeDefined()
      expect(screen.getByText('DrG')).toBeDefined()
      expect(screen.getByText('More')).toBeDefined()
      unmount()

      renderAt(MODE.FIELD)
      expect(screen.getByText('Today')).toBeDefined()
      expect(screen.getByText('Garden')).toBeDefined()
      expect(screen.getByText('DrG')).toBeDefined()
      expect(screen.getByText('More')).toBeDefined()
    })
  })
})
