// V4-PROJHIDE-001 — HeadsUpTile with PROJECTS_HIDDEN mocked TRUE. Pins the two flag-ON behaviors:
// (1) the empty state uses project-free copy, and (2) a stale row routes to /garden, never the
// hidden /projects/:id page. Flag-OFF behavior ("no stale projects" copy + /projects/:id nav) is
// covered by HeadsUpTile.test.jsx. importActual spread so every other flag keeps its value. No
// jest-dom (L-182) — plain vitest matchers only.
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'

// Flag ON — spread the real module so every other flag keeps its value.
vi.mock('../lib/featureFlags.js', async (importActual) => ({
  ...(await importActual()),
  PROJECTS_HIDDEN: true,
}))

import HeadsUpTile from '../components/HeadsUpTile.jsx'

// Probe component reporting the current path so tests can assert navigation targets.
function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="location-probe">{loc.pathname + loc.search}</div>
}

function renderWithRouter(ui) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={ui} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  )
}

const staleRow = {
  project_id: 'p-stale-1',
  name: 'Basil',
  reason: 'stale',
  severity: null,
  event_at: '2026-04-01T12:00:00.000Z',
  days_stale: 43,
}

describe('HeadsUpTile — PROJHIDE', () => {
  it('empty state uses project-free copy', () => {
    renderWithRouter(<HeadsUpTile headsUp={[]} />)
    expect(screen.getByText('HEADS UP')).toBeTruthy()
    expect(screen.getByText(/nothing needs attention/i)).toBeTruthy()
    expect(screen.queryByText(/no stale projects/i)).toBeNull()
  })

  it('a stale row navigates to /garden, not the hidden project page', () => {
    renderWithRouter(<HeadsUpTile headsUp={[staleRow]} />)
    fireEvent.click(screen.getByText('Basil'))
    expect(screen.getByTestId('location-probe').textContent).toBe('/garden')
  })
})
