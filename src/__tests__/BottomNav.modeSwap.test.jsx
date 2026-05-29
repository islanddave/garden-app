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

// Stub CatchUpBadge — orthogonal to mode-swap.
vi.mock('../components/CatchUpBadge.jsx', () => ({
  default: () => <div data-testid="catch-up-badge-stub" />,
}))

// Stub feature flag — keep CATCH_UP_EDITOR_SHIPPED stable for the test.
vi.mock('../lib/featureFlags.js', () => ({
  CATCH_UP_EDITOR_SHIPPED: false,
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

    it('tapping +LOG opens the create action sheet with all 4 actions', () => {
      renderAt(MODE.DESK)
      fireEvent.click(screen.getByLabelText('Create'))
      // Action sheet markers from CREATE_ACTIONS (FAB restoration L-082)
      expect(screen.getByText('Log an event')).toBeDefined()
      expect(screen.getByText('Add a planting')).toBeDefined()
      expect(screen.getByText('New project')).toBeDefined()
      expect(screen.getByText('Add inventory')).toBeDefined()
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
    it('Garden, Inventory, More tabs render in both modes (non-swap regression check)', () => {
      const { unmount } = renderAt(MODE.DESK)
      expect(screen.getByText('Garden')).toBeDefined()
      expect(screen.getByText('Inventory')).toBeDefined()
      expect(screen.getByText('More')).toBeDefined()
      unmount()

      renderAt(MODE.FIELD)
      expect(screen.getByText('Garden')).toBeDefined()
      expect(screen.getByText('Inventory')).toBeDefined()
      expect(screen.getByText('More')).toBeDefined()
    })
  })
})
