/**
 * src/__tests__/Favorites.test.jsx
 * V1.2a-3 Increment A — Favorites section-resolution regression tests.
 *
 * Focus: the I3-persistence fix. Starred plants persist to the favorites table
 * but were silently dropped on this page because the `plant` resolution branch
 * did not exist (only project / location / inventory_item were wired). A user
 * who starred only plants saw "No favorites yet."
 *
 * Mocks:
 *   - useApiFetch -> fetchSpy (5 mount fetches: favorites, projects, locations,
 *     inventory-items, plants)
 *   - react-router-dom Link -> plain anchor
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy }),
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))

import Favorites from '../pages/Favorites.jsx'

beforeEach(() => {
  fetchSpy.mockReset()
})

// load() fires exactly 5 parallel fetches, in this order:
// favorites, projects, locations, inventory-items, plants
function primeLoad({ favorites = [], projects = [], locations = [], inventory = [], plants = [] } = {}) {
  fetchSpy.mockResolvedValueOnce(favorites)
  fetchSpy.mockResolvedValueOnce(projects)
  fetchSpy.mockResolvedValueOnce(locations)
  fetchSpy.mockResolvedValueOnce(inventory)
  fetchSpy.mockResolvedValueOnce(plants)
}

describe('Favorites — section resolution', () => {
  it('renders the empty state when there are no favorites', async () => {
    primeLoad()
    render(<Favorites />)
    await waitFor(() => expect(screen.getByText(/No favorites yet/)).toBeDefined())
  })

  it('resolves a starred plant into a Plants section (I3-persistence fix)', async () => {
    primeLoad({
      favorites: [{ id: 'fav-1', entity_type: 'plant', entity_id: 'plant-1', created_at: '2026-05-15' }],
      plants:    [{ id: 'plant-1', name: 'Broccoli', variety: 'Boutique', status: 'vegetative' }],
    })
    render(<Favorites />)
    // The plant name rendering proves the `plant` branch ran and pushed a section.
    await waitFor(() => expect(screen.getByText('Broccoli')).toBeDefined())
    expect(screen.getByText(/Plantings/)).toBeDefined()  // section header "🌿 Plantings" (V3-FAV-001 rename)
    // /api/plants must have been one of the parallel mount fetches.
    expect(fetchSpy.mock.calls.some(c => c[0] === '/api/plants')).toBe(true)
  })

  it('resolves plant + project favorites side by side', async () => {
    primeLoad({
      favorites: [
        { id: 'fav-1', entity_type: 'plant',   entity_id: 'plant-1' },
        { id: 'fav-2', entity_type: 'project', entity_id: 'proj-1' },
      ],
      projects: [{ id: 'proj-1', name: 'Spring Beds' }],
      plants:   [{ id: 'plant-1', name: 'Broccoli' }],
    })
    render(<Favorites />)
    await waitFor(() => expect(screen.getByText('Broccoli')).toBeDefined())
    expect(screen.getByText('Spring Beds')).toBeDefined()
  })
})
