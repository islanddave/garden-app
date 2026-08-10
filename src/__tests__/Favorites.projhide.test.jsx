// V4-PROJHIDE-001 — Favorites with PROJECTS_HIDDEN mocked TRUE.
//
// GAP CLOSED 2026-08-10: Favorites was one of only three genuinely uncovered surfaces at flip time
// (the other "holes" were sub-suites of surfaces that already had a .projhide sibling). It matters
// more than its size suggests, for two reasons:
//   1. A user with favourited PROJECTS silently loses that section. The rows persist server-side and
//      come back on revert, but the user gets no explanation — so this pins that the loss is display-
//      only and that nothing else on the page shifts.
//   2. The planting row's link was rebuilt this same day (BUG-SEARCHDEADTAP-001) from a project-scoped
//      href with a /garden fallback onto the canonical un-scoped route. Under this flag that fallback
//      would have been reachable far more often, so the two changes interact and both need pinning.
//
// Flag-OFF behavior is covered by Favorites.test.jsx. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))

vi.mock('../lib/featureFlags.js', async (importActual) => ({
  ...(await importActual()),
  PROJECTS_HIDDEN: true,
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))

import Favorites from '../pages/Favorites.jsx'

beforeEach(() => { fetchSpy.mockReset() })

// load() fires exactly 5 parallel fetches, in this order:
// favorites, projects, locations, inventory-items, plants
function primeLoad({ favorites = [], projects = [], locations = [], inventory = [], plants = [] } = {}) {
  fetchSpy.mockResolvedValueOnce(favorites)
  fetchSpy.mockResolvedValueOnce(projects)
  fetchSpy.mockResolvedValueOnce(locations)
  fetchSpy.mockResolvedValueOnce(inventory)
  fetchSpy.mockResolvedValueOnce(plants)
}

// A favourited project AND two favourited plantings — one project-scoped, one Snap-created with no
// project_id at all (the shape BUG-SEARCHDEADTAP-001 was about).
const SCENARIO = {
  favorites: [
    { id: 'f1', entity_type: 'plant',   entity_id: 'pl1', created_at: '2026-05-15' },
    { id: 'f2', entity_type: 'plant',   entity_id: 'pl2', created_at: '2026-05-16' },
    { id: 'f3', entity_type: 'project', entity_id: 'pr1', created_at: '2026-05-17' },
  ],
  plants: [
    { id: 'pl1', name: 'Sungold',   project_id: 'pr1', status: 'vegetative' },
    { id: 'pl2', name: 'Snap Aloe', project_id: null,  status: 'seedling' },
  ],
  projects: [{ id: 'pr1', name: 'Bed Alpha', status: 'growing' }],
}

describe('Favorites — V4-PROJHIDE-001 (flag ON)', () => {
  it('does not render a Projects section', async () => {
    primeLoad(SCENARIO)
    render(<Favorites />)
    await waitFor(() => expect(screen.getByText('Sungold')).toBeTruthy())
    expect(screen.queryByText('Projects')).toBeNull()
    expect(screen.queryByText('Bed Alpha')).toBeNull()
  })

  it('still renders favourited plantings — the section is not collateral damage', async () => {
    // The failure mode worth guarding: hiding the projects section by over-filtering the whole list.
    primeLoad(SCENARIO)
    render(<Favorites />)
    await waitFor(() => expect(screen.getByText('Sungold')).toBeTruthy())
    expect(screen.getByText('Snap Aloe')).toBeTruthy()
  })

  it('links plantings to the canonical un-scoped route, with or without a project_id', async () => {
    // Interacts with BUG-SEARCHDEADTAP-001 (same day): the old project-scoped href fell back to
    // /garden when project_id was missing, which under this flag would be a much more common path.
    primeLoad(SCENARIO)
    render(<Favorites />)
    await waitFor(() => expect(screen.getByText('Sungold')).toBeTruthy())
    expect(screen.getByText('Sungold').closest('a').getAttribute('href')).toBe('/plantings/pl1')
    expect(screen.getByText('Snap Aloe').closest('a').getAttribute('href')).toBe('/plantings/pl2')
  })

  it('no link on the page points into the retired /projects tree', async () => {
    primeLoad(SCENARIO)
    render(<Favorites />)
    await waitFor(() => expect(screen.getByText('Sungold')).toBeTruthy())
    const stale = Array.from(document.querySelectorAll('a'))
      .filter(a => (a.getAttribute('href') || '').startsWith('/projects'))
    expect(stale.length).toBe(0)
  })
})
