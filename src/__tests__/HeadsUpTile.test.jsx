// Unit tests for src/components/HeadsUpTile.jsx — Wave 2 dashboard tile.
// FLAG-REMOVAL (2026-06-10): flagged rows are filtered upstream (Dashboard.jsx); the tile is
// stale-only now. Component uses useNavigate, so renders are wrapped in MemoryRouter.

import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'
import HeadsUpTile from '../components/HeadsUpTile.jsx'

// Probe component that reports the current path + search to the DOM so tests
// can assert on navigation targets.
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
    </MemoryRouter>
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

describe('HeadsUpTile — render branches', () => {
  it('renders skeleton/loading state when headsUp is undefined', () => {
    renderWithRouter(<HeadsUpTile headsUp={undefined} />)
    expect(screen.getByText('Tile loading...')).toBeTruthy()
  })

  it('renders friendly empty state when headsUp is an empty array', () => {
    renderWithRouter(<HeadsUpTile headsUp={[]} />)
    expect(screen.getByText('HEADS UP')).toBeTruthy()
    expect(screen.getByText(/All clear/i)).toBeTruthy()
  })

  it('renders stale rows with a SeverityBadge', () => {
    renderWithRouter(<HeadsUpTile headsUp={[staleRow]} />)
    expect(screen.getByText('Basil')).toBeTruthy()
    expect(screen.getByText('Last observed 43 days ago')).toBeTruthy()
    const badge = screen.getByTestId('severity-badge')
    expect(badge.getAttribute('data-variant')).toBe('stale')
  })

  it('handles stale row with null event_at gracefully', () => {
    const noObs = { ...staleRow, event_at: null, days_stale: null }
    renderWithRouter(<HeadsUpTile headsUp={[noObs]} />)
    expect(screen.getByText('No recent observations')).toBeTruthy()
  })

  it('uses today/yesterday phrasing for days_stale 0 and 1', () => {
    const rows = [
      { ...staleRow, project_id: 'a', name: 'Today Proj', days_stale: 0 },
      { ...staleRow, project_id: 'b', name: 'Yesterday Proj', days_stale: 1 },
    ]
    renderWithRouter(<HeadsUpTile headsUp={rows} />)
    expect(screen.getByText('Last observed today')).toBeTruthy()
    expect(screen.getByText('Last observed yesterday')).toBeTruthy()
  })
})

describe('HeadsUpTile — navigation targets', () => {
  it('navigates stale row to /projects/:id with no query param', () => {
    renderWithRouter(<HeadsUpTile headsUp={[staleRow]} />)
    fireEvent.click(screen.getByText('Basil'))
    expect(screen.getByTestId('location-probe').textContent)
      .toBe('/projects/p-stale-1')
  })
})

describe('HeadsUpTile — server order preserved', () => {
  it('renders rows in the exact server-returned order (no client sort/dedup)', () => {
    // Deliberate order that is NOT days_stale-sorted client-side.
    const rows = [
      { ...staleRow, project_id: 'first',  name: 'Alpha', days_stale: 2 },
      { ...staleRow, project_id: 'second', name: 'Bravo', days_stale: 43 },
      { ...staleRow, project_id: 'third',  name: 'Charlie', days_stale: 9 },
    ]
    renderWithRouter(<HeadsUpTile headsUp={rows} />)
    const names = screen.getAllByRole('button').map(btn => {
      // First text node inside the button's name container is the project name.
      return btn.querySelector('div > div')?.textContent
    })
    expect(names).toEqual(['Alpha', 'Bravo', 'Charlie'])
  })

  it('does not dedup repeated project_ids', () => {
    const rows = [
      { ...staleRow, project_id: 'dup', name: 'Dup A' },
      { ...staleRow, project_id: 'dup', name: 'Dup B' },
    ]
    renderWithRouter(<HeadsUpTile headsUp={rows} />)
    expect(screen.getAllByRole('button')).toHaveLength(2)
  })
})

describe('HeadsUpTile — optional props', () => {
  it('accepts an onDataRefresh prop without error', () => {
    const noop = () => {}
    renderWithRouter(<HeadsUpTile headsUp={[]} onDataRefresh={noop} />)
    expect(screen.getByText(/All clear/i)).toBeTruthy()
  })
})
