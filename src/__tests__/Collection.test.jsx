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

// V007 contract: float-free candy-pastel per-critter theming on V006 mechanics.
// Heading = "Critter collection" (lowercase). Header line = "N spotted so far…".
// Undiscovered: empty name div (no "???" placeholder), art silhouetted via brightness(0),
//   aria-label on li encodes state. Collected: name in div + alt, caption shows "Seen" + date.
// All cards render sighting-caption testid (Not yet vs Seen+date).

describe('Collection — V007 candy-pastel float-free redesign', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('renders heading + "spotted so far" line when none collected', () => {
    setState({ collected: new Map() })
    render(<Collection />)
    expect(screen.getByText('Critter collection')).toBeDefined()
    expect(screen.getByText(/0 spotted so far/i)).toBeDefined()
  })

  it('renders one card per roster entry; undiscovered have no name text and "not yet" aria-label', () => {
    setState({ collected: new Map() })
    render(<Collection />)
    const items = screen.getAllByRole('listitem')
    expect(items.length).toBe(roster.length)
    // All uncollected lis have aria-label ending in "not yet visited"
    const notYet = items.filter(el => /not yet visited/i.test(el.getAttribute('aria-label') || ''))
    expect(notYet.length).toBe(roster.length)
    // No "???" placeholder — undiscovered name slot is empty
    expect(screen.queryAllByText('???').length).toBe(0)
  })

  it('groups into wild / legacy / cryptid sections (Special excluded; no tier jargon)', () => {
    setState({ collected: new Map() })
    render(<Collection />)
    // Check h2 section headings (not nav buttons which also contain same text)
    const headings = screen.getAllByRole('heading', { level: 2 })
    const texts = headings.map(h => h.textContent)
    expect(texts).toContain('Around the garden')
    expect(texts).toContain('Legacy')
    expect(texts).toContain('Curiosities')
  })

  it('reveals collected entry: name in alt + div, caption shows Seen + month/day date', () => {
    const collected = new Map([
      ['C050', { speciesId: 3, count: 4, firstSeenAt: '2026-05-10T00:00:00Z', lastSeenAt: '2026-05-20T00:00:00Z' }],
    ])
    setState({ collected })
    render(<Collection />)
    expect(screen.getByText(/1 spotted so far/i)).toBeDefined()
    // Blue Jay should appear as alt text and visible name
    expect(screen.getByAltText('Blue Jay')).toBeDefined()
    expect(screen.getByText('Blue Jay')).toBeDefined()
    // Caption strip shows "Seen" label + a date
    const caption = screen.getByTestId('sighting-caption-C050')
    expect(caption.textContent).toMatch(/Seen/i)
    expect(caption.textContent).toMatch(/May 10/i)
  })

  it('collected entry without current-year date includes year in caption', () => {
    const collected = new Map([
      ['C007', { speciesId: 8, count: 1, firstSeenAt: '2025-11-12T00:00:00Z', lastSeenAt: '2025-11-12T00:00:00Z' }],
    ])
    setState({ collected })
    render(<Collection />)
    const caption = screen.getByTestId('sighting-caption-C007')
    expect(caption.textContent).toMatch(/Seen/i)
    expect(caption.textContent).toMatch(/2025/i)
  })

  it('renders "Loading…" header while loading', () => {
    setState({ collected: new Map(), loading: true })
    render(<Collection />)
    expect(screen.getByText('Loading…')).toBeDefined()
  })

  it('surfaces error message under header when error is set and not loading', () => {
    setState({ collected: new Map(), loading: false, error: 'Could not load your collection' })
    render(<Collection />)
    expect(screen.getByText('Could not load your collection')).toBeDefined()
    expect(screen.getByText(/0 spotted so far/i)).toBeDefined()
  })

  it('all cards render sighting-caption testid; uncollected show "Not yet", not "Seen"', () => {
    setState({ collected: new Map() })
    render(<Collection />)
    const strips = screen.queryAllByTestId(/^sighting-caption-/)
    // Every card has the testid (not just collected ones)
    expect(strips.length).toBe(roster.length)
    // None show "Seen" when nothing is collected
    for (const strip of strips) {
      expect(strip.textContent).not.toMatch(/^Seen/)
    }
  })
})
