import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import roster from '../data/critters-roster.json'

vi.mock('../hooks/useCritterCollection.js', () => ({
  useCritterCollection: vi.fn(),
}))

import { useCritterCollection } from '../hooks/useCritterCollection.js'
import Collection from '../pages/Collection.jsx'

function setState({ collected = new Map(), loading = false, error = null } = {}) {
  useCritterCollection.mockReturnValue({ collected, loading, error, reload: vi.fn() })
}

describe('Collection — Pokédex preview dex (Phase 2 wiring)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('renders the heading + discovered count over the full roster when none collected', () => {
    setState({ collected: new Map() })
    render(<Collection />)
    expect(screen.getByText('Critter Collection')).toBeDefined()
    expect(screen.getByText(new RegExp(`0 of ${roster.length} discovered`, 'i'))).toBeDefined()
  })

  it('renders one undiscovered silhouette per roster entry (??? + generic alt, no name leak)', () => {
    setState({ collected: new Map() })
    render(<Collection />)
    expect(screen.getAllByText('???').length).toBe(roster.length)
    expect(screen.getAllByAltText(/undiscovered critter/i).length).toBe(roster.length)
  })

  it('groups into wild / legacy / cryptid only (Special excluded; no tier jargon)', () => {
    setState({ collected: new Map() })
    render(<Collection />)
    expect(screen.getByText('Around the garden')).toBeDefined()
    expect(screen.getByText('Legacy')).toBeDefined()
    expect(screen.getByText('Curiosities')).toBeDefined()
  })

  it('reveals collected entries by roster id (name visible, alt = name, sighting caption present)', () => {
    const collected = new Map([
      ['C050', { speciesId: 3, count: 4, firstSeenAt: '2026-05-10T00:00:00Z', lastSeenAt: '2026-05-20T00:00:00Z' }],
    ])
    setState({ collected })
    render(<Collection />)
    expect(screen.getByText(new RegExp(`1 of ${roster.length} discovered`, 'i'))).toBeDefined()
    // C050 = Blue jay in roster
    expect(screen.getByAltText(/blue jay/i)).toBeDefined()
    expect(screen.getByTestId('sighting-caption-C050').textContent).toMatch(/4 sightings/)
    expect(screen.getByTestId('sighting-caption-C050').textContent).toMatch(/first /)
  })

  it('singular sighting caption when count = 1', () => {
    const collected = new Map([
      ['C007', { speciesId: 8, count: 1, firstSeenAt: '2026-05-30T00:00:00Z', lastSeenAt: '2026-05-30T00:00:00Z' }],
    ])
    setState({ collected })
    render(<Collection />)
    expect(screen.getByTestId('sighting-caption-C007').textContent).toMatch(/1 sighting/)
    expect(screen.getByTestId('sighting-caption-C007').textContent).not.toMatch(/sightings/)
  })

  it('renders "Loading…" header while loading; cards still render as silhouettes', () => {
    setState({ collected: new Map(), loading: true })
    render(<Collection />)
    expect(screen.getByText('Loading…')).toBeDefined()
    expect(screen.getAllByText('???').length).toBe(roster.length)
  })

  it('surfaces error message under header when error is set and not loading', () => {
    setState({ collected: new Map(), loading: false, error: 'Could not load your collection' })
    render(<Collection />)
    expect(screen.getByText('Could not load your collection')).toBeDefined()
    expect(screen.getByText(new RegExp(`0 of ${roster.length} discovered`, 'i'))).toBeDefined()
  })

  it('does not render sighting captions on uncollected entries', () => {
    setState({ collected: new Map() })
    render(<Collection />)
    expect(screen.queryAllByTestId(/^sighting-caption-/).length).toBe(0)
  })
})
