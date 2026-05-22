import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import Collection from '../pages/Collection.jsx'

describe('Collection — Pokédex preview dex (Phase 1)', () => {
  it('renders the collection heading + discovered count', () => {
    render(<Collection />)
    expect(screen.getByText('Critter Collection')).toBeDefined()
    expect(screen.getByText(/0 of 5 discovered/i)).toBeDefined()
  })

  it('shows every critter as an undiscovered silhouette (??? labels, no real names leaked)', () => {
    render(<Collection />)
    expect(screen.getAllByText('???').length).toBe(5)
    expect(screen.queryByText('Honeybee')).toBeNull()
    expect(screen.queryByText('Green Lacewing')).toBeNull()
  })

  it('uses a generic alt for undiscovered critters (no name leak to screen readers)', () => {
    render(<Collection />)
    expect(screen.getAllByRole('img', { name: /undiscovered critter/i }).length).toBe(5)
  })
})
