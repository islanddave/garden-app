// V4-APPBAR-001 — TopChrome gate. No jest-dom (L-182): roles/attrs + toBeTruthy/toBe(null).
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ModeProvider } from '../context/ModeContext.jsx'
import { MODE } from '../lib/mode.js'
import { APP_NAME } from '../lib/constants.js'

vi.mock('../context/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }))
vi.mock('../components/TopBar.jsx', () => ({ default: () => <div data-testid="topbar-fallback">bar</div> }))

import TopChrome from '../components/TopChrome.jsx'

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ModeProvider initialMode={MODE.DESK}>
        <TopChrome />
      </ModeProvider>
    </MemoryRouter>
  )
}

describe('TopChrome (V4-APPBAR-001)', () => {
  it('root tab (/today): real header — brand wordmark + mode toggle + Favorites, NO green app-name TopBar', () => {
    renderAt('/today')
    const fav = screen.getByLabelText('Favorites')
    expect(fav.getAttribute('href')).toBe('/favorites')
    expect(screen.getByTestId('mode-chip')).toBeTruthy()
    expect(screen.getByText(APP_NAME)).toBeTruthy()
    expect(screen.queryByTestId('topbar-fallback')).toBe(null)
  })
  it('root tab brand wordmark links home (/dashboard)', () => {
    renderAt('/garden')
    expect(screen.getByText(APP_NAME).getAttribute('href')).toBe('/dashboard')
  })
  it('detail route (/projects/abc): falls back to the full TopBar', () => {
    renderAt('/projects/abc')
    expect(screen.getByTestId('topbar-fallback')).toBeTruthy()
    expect(screen.queryByLabelText('Favorites')).toBe(null)
  })
})
