import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import roster from '../data/critters-roster.json'
import Collection from '../pages/Collection.jsx'

describe('Collection — Pokédex preview dex (Phase 1, full roster)', () => {
  it('renders the heading + discovered count over the full roster', () => {
    render(<Collection />)
    expect(screen.getByText('Critter Collection')).toBeDefined()
    expect(screen.getByText(new RegExp(`0 of ${roster.length} discovered`, 'i'))).toBeDefined()
  })

  it('renders one undiscovered silhouette per roster entry (??? + generic alt, no name leak)', () => {
    render(<Collection />)
    expect(screen.getAllByText('???').length).toBe(roster.length)
    expect(screen.getAllByAltText(/undiscovered critter/i).length).toBe(roster.length)
  })

  it('groups into wild / legacy / cryptid only (Special excluded; no tier jargon)', () => {
    render(<Collection />)
    expect(screen.getByText('Around the garden')).toBeDefined()
    expect(screen.getByText('Legacy')).toBeDefined()
    expect(screen.getByText('Curiosities')).toBeDefined()
  })
})
