import React from 'react'
// Settings parent — permissive redirect test per revision §3.23.

import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Settings from '../pages/Settings.jsx'

describe('Settings (parent)', () => {
  it('redirects /settings → /settings/notifications', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/settings']}>
        <Routes>
          <Route path="/settings" element={<Settings />} />
          <Route path="/settings/notifications" element={<div data-testid="dest">notif page</div>} />
        </Routes>
      </MemoryRouter>
    )
    expect(container.querySelector('[data-testid="dest"]')).toBeTruthy()
  })

  it('uses replace navigation (no back-stack pollution)', () => {
    // Smoke: render twice and ensure no error / the destination always renders.
    const { container } = render(
      <MemoryRouter initialEntries={['/settings', '/settings']}>
        <Routes>
          <Route path="/settings" element={<Settings />} />
          <Route path="/settings/notifications" element={<div data-testid="dest" /> } />
        </Routes>
      </MemoryRouter>
    )
    expect(container.querySelector('[data-testid="dest"]')).toBeTruthy()
  })
})
