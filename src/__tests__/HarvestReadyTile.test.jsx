// Unit tests for src/components/HarvestReadyTile.jsx — W2 dashboard tile
// (V1.2a-2 Session 3). Covers the three render branches, the observed-line
// copy, the three severity-dot tiers, null days_since_obs handling, and the
// /log navigation target on row tap.

import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'
import HarvestReadyTile from '../components/HarvestReadyTile.jsx'
import { P } from '../lib/constants.js'

// Probe route — captures the URL after navigation so we can assert the target.
function LocationProbe() {
  const loc = useLocation()
  return (
    <div data-testid="location-probe">
      {loc.pathname}
      {loc.search}
    </div>
  )
}

function renderTile(props) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<HarvestReadyTile {...props} />} />
        <Route path="/log" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>
  )
}

const project = (overrides = {}) => ({
  project_id: 'p1',
  name: 'Cherry Tomatoes',
  status: 'harvesting',
  last_observed_at: '2026-05-10T12:00:00.000Z',
  days_since_obs: 1,
  ...overrides,
})

describe('HarvestReadyTile — render branches', () => {
  it('renders skeleton when harvestReady is undefined', () => {
    renderTile({ harvestReady: undefined })
    const skeleton = screen.getByTestId('harvest-ready-skeleton')
    expect(skeleton.textContent).toContain('Tile loading')
    expect(screen.queryByTestId('harvest-ready-tile')).toBeNull()
    expect(screen.queryByTestId('harvest-ready-empty')).toBeNull()
  })

  it('renders friendly empty state when harvestReady is []', () => {
    renderTile({ harvestReady: [] })
    const empty = screen.getByTestId('harvest-ready-empty')
    expect(empty.textContent).toContain('Nothing ready to harvest yet')
    expect(empty.textContent).toContain('HARVEST READY')
    expect(screen.queryByTestId('harvest-ready-tile')).toBeNull()
  })

  it('renders a row per project when populated', () => {
    renderTile({
      harvestReady: [
        project({ project_id: 'p1', name: 'Cherry Tomatoes' }),
        project({ project_id: 'p2', name: 'Sugar Snap Peas' }),
      ],
    })
    expect(screen.getByTestId('harvest-ready-tile')).toBeTruthy()
    expect(screen.getByText('Cherry Tomatoes')).toBeTruthy()
    expect(screen.getByText('Sugar Snap Peas')).toBeTruthy()
    expect(screen.getAllByText('+ Log harvest')).toHaveLength(2)
  })

  it('accepts an onDataRefresh prop without error', () => {
    expect(() =>
      renderTile({ harvestReady: [project()], onDataRefresh: () => {} })
    ).not.toThrow()
  })
})

describe('HarvestReadyTile — observed line copy', () => {
  it('shows "Observed today" for days_since_obs 0', () => {
    renderTile({ harvestReady: [project({ days_since_obs: 0 })] })
    expect(screen.getByText('Observed today')).toBeTruthy()
  })

  it('shows "Observed yesterday" for days_since_obs 1', () => {
    renderTile({ harvestReady: [project({ days_since_obs: 1 })] })
    expect(screen.getByText('Observed yesterday')).toBeTruthy()
  })

  it('shows "Observed N days ago" for days_since_obs > 1', () => {
    renderTile({ harvestReady: [project({ days_since_obs: 5 })] })
    expect(screen.getByText('Observed 5 days ago')).toBeTruthy()
  })

  it('shows "Not yet observed" when days_since_obs is null', () => {
    renderTile({
      harvestReady: [project({ days_since_obs: null, last_observed_at: null })],
    })
    expect(screen.getByText('Not yet observed')).toBeTruthy()
  })
})

describe('HarvestReadyTile — severity dot tiers', () => {
  it('renders no dot for days_since_obs <= 2 (neutral)', () => {
    renderTile({ harvestReady: [project({ days_since_obs: 2 })] })
    expect(screen.queryByTestId('harvest-severity-dot')).toBeNull()
  })

  it('renders a muted-gold dot for days_since_obs 3-6', () => {
    renderTile({ harvestReady: [project({ days_since_obs: 4 })] })
    const dot = screen.getByTestId('harvest-severity-dot')
    expect(dot.getAttribute('data-dot-color')).toBe(P.warnBorder)
  })

  it('renders a terra dot for days_since_obs >= 7', () => {
    renderTile({ harvestReady: [project({ days_since_obs: 9 })] })
    const dot = screen.getByTestId('harvest-severity-dot')
    expect(dot.getAttribute('data-dot-color')).toBe(P.terra)
  })

  it('renders no dot when days_since_obs is null', () => {
    renderTile({
      harvestReady: [project({ days_since_obs: null, last_observed_at: null })],
    })
    expect(screen.queryByTestId('harvest-severity-dot')).toBeNull()
  })
})

describe('HarvestReadyTile — navigation', () => {
  it('navigates to /log with project + harvest event_type on row tap', () => {
    renderTile({
      harvestReady: [project({ project_id: 'abc-123', name: 'Cherry Tomatoes' })],
    })
    fireEvent.click(screen.getByText('Cherry Tomatoes'))
    const probe = screen.getByTestId('location-probe')
    expect(probe.textContent).toBe('/log?project=abc-123&event_type=harvest')
  })

  it('navigates using the tapped row\'s project_id', () => {
    renderTile({
      harvestReady: [
        project({ project_id: 'p1', name: 'Cherry Tomatoes' }),
        project({ project_id: 'p2', name: 'Sugar Snap Peas' }),
      ],
    })
    fireEvent.click(screen.getByText('Sugar Snap Peas'))
    const probe = screen.getByTestId('location-probe')
    expect(probe.textContent).toBe('/log?project=p2&event_type=harvest')
  })
})
