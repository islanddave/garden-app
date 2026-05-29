/**
 * src/__tests__/TopBar.test.jsx
 * Bite 2 of Post-V2 UX overhaul Increment 2: TopBar mode-chip surface.
 *
 * Covers:
 *  - Chip is hidden when not authenticated
 *  - Chip renders current mode (icon + label + aria-label) when authenticated
 *  - Tap toggles mode (Desk ↔ Field) and updates the chip label
 *  - aria-label reflects "tap to switch to {other}" for screen-reader users
 */

import React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import TopBar from '../components/TopBar.jsx'
import { ModeProvider } from '../context/ModeContext.jsx'
import { MODE } from '../lib/mode.js'

// Auth context mock — flip `mockUser` between tests to simulate sign-in.
let mockUser = null
vi.mock('../context/AuthContext.jsx', () => ({
  useAuth: () => ({ user: mockUser, loading: false }),
}))

function renderWithProviders(initialMode = MODE.DESK) {
  return render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <ModeProvider initialMode={initialMode}>
        <TopBar />
      </ModeProvider>
    </MemoryRouter>
  )
}

beforeEach(() => {
  mockUser = null
  try { window.sessionStorage.clear() } catch {}
})

describe('TopBar — mode chip visibility', () => {
  it('does NOT render the mode chip when unauthenticated', () => {
    mockUser = null
    renderWithProviders()
    expect(screen.queryByTestId('mode-chip')).toBeNull()
  })

  it('renders the mode chip when authenticated', () => {
    mockUser = { id: 'u_test' }
    renderWithProviders()
    const chip = screen.getByTestId('mode-chip')
    expect(chip).toBeDefined()
  })
})

describe('TopBar — mode chip content (color-independent state per V100 §7)', () => {
  it('shows the Desk label + icon when mode is Desk', () => {
    mockUser = { id: 'u_test' }
    renderWithProviders(MODE.DESK)
    const chip = screen.getByTestId('mode-chip')
    expect(chip.textContent).toContain('Desk')
    expect(chip.textContent).toContain('💻')
    expect(chip.getAttribute('data-mode')).toBe(MODE.DESK)
    expect(chip.getAttribute('aria-label')).toMatch(/Mode:\s*Desk/i)
    expect(chip.getAttribute('aria-label')).toMatch(/switch to Field/i)
  })

  it('shows the Field label + icon when mode is Field', () => {
    mockUser = { id: 'u_test' }
    renderWithProviders(MODE.FIELD)
    const chip = screen.getByTestId('mode-chip')
    expect(chip.textContent).toContain('Field')
    expect(chip.textContent).toContain('🌿')
    expect(chip.getAttribute('data-mode')).toBe(MODE.FIELD)
    expect(chip.getAttribute('aria-label')).toMatch(/Mode:\s*Field/i)
    expect(chip.getAttribute('aria-label')).toMatch(/switch to Desk/i)
  })
})

describe('TopBar — mode chip toggle', () => {
  it('tap flips Desk → Field and updates the visible label', () => {
    mockUser = { id: 'u_test' }
    renderWithProviders(MODE.DESK)
    const chip = screen.getByTestId('mode-chip')
    expect(chip.getAttribute('data-mode')).toBe(MODE.DESK)
    act(() => { fireEvent.click(chip) })
    const chipAfter = screen.getByTestId('mode-chip')
    expect(chipAfter.getAttribute('data-mode')).toBe(MODE.FIELD)
    expect(chipAfter.textContent).toContain('Field')
  })

  it('tap flips Field → Desk', () => {
    mockUser = { id: 'u_test' }
    renderWithProviders(MODE.FIELD)
    const chip = screen.getByTestId('mode-chip')
    act(() => { fireEvent.click(chip) })
    const chipAfter = screen.getByTestId('mode-chip')
    expect(chipAfter.getAttribute('data-mode')).toBe(MODE.DESK)
    expect(chipAfter.textContent).toContain('Desk')
  })
})
