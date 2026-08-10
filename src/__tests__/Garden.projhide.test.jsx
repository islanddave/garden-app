// V4-PROJHIDE-001 — Garden with PROJECTS_HIDDEN mocked TRUE. Proves the by-project tree is gone and
// the view defaults to CROP-TYPE grouping (Tomato / Pepper from variety_ref.crop_type_slug), NOT the
// empty tag facet and NOT a Lifecycle lump. Two plantings of different crop types → two distinct
// groups (a Lifecycle default would collapse both 'growing' plants into one "Growing" group, so two
// crop headers is the proof). Flag-OFF behavior (project tree, "Projects" group-by) is covered by
// Garden.test.jsx. importActual spread so every other flag keeps its value. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

vi.mock('react-router-dom', () => {
  const sp = new URLSearchParams()
  return {
    Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
    useLocation: () => ({ pathname: '/garden', search: '', state: null }),
    useNavigate: () => () => {},
    useSearchParams: () => [sp, () => {}],
  }
})
const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock }), apiFetch: (...a) => fetchMock(...a) }))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <span data-testid="fav" /> }))

// Flag ON — spread the real module so every other flag keeps its value.
vi.mock('../lib/featureFlags.js', async (importActual) => ({
  ...(await importActual()),
  PROJECTS_HIDDEN: true,
}))

import Garden from '../pages/Garden.jsx'

// Neutral project names so they can't collide with crop-type group labels in queryByText.
const PROJECTS = [
  { id: 'a', name: 'Bed Alpha', status: 'active',   parent_project_id: null, is_public: true },
  { id: 'c', name: 'Bed Gamma', status: 'planning', parent_project_id: null, is_public: true },
]
// Two live plantings, two crop types — crop-type grouping yields Tomato + Pepper (two groups);
// a Lifecycle default would yield one "Growing" group. Both 'growing' to make that contrast sharp.
const PLANTS = [
  { id: 'p1', name: 'Sungold',  project_id: 'a', status: 'growing', quantity: 2, variety_ref: { crop_type_slug: 'tomato' } },
  { id: 'p2', name: 'Jalapeño', project_id: 'a', status: 'growing', quantity: 3, variety_ref: { crop_type_slug: 'pepper' } },
]

beforeEach(() => {
  localStorage.clear()
  fetchMock.mockReset()
  fetchMock.mockImplementation((url) =>
    Promise.resolve(url === '/api/projects' ? PROJECTS : url === '/api/plants' ? PLANTS : []))
})

async function renderGarden() {
  await act(async () => { render(<Garden />) })
  await screen.findByText(/Log many/)
}

// GAP CLOSED 2026-08-10 — the flip's one untested migration path, and the case beforeEach() cannot
// reach. Every existing user carries `garden.groupBy.v1 = 'none'` (projectTree.js:375 defaults to it)
// or the equivalent server pref. Under the flag, 'none' is absent from facetOptions and Garden.jsx:563
// falls back to crop_type — but the suite's `localStorage.clear()` means every other case here starts
// from an EMPTY store, i.e. the one starting state that cannot exhibit the bug. Seeding the stale value
// first is the whole point: this asserts the flip is safe for people who already use the app, not just
// for a fresh install.
describe('Garden — V4-PROJHIDE-001 stale groupBy migration (flag ON)', () => {
  it('falls back to crop_type when localStorage still holds the retired "none" facet', async () => {
    localStorage.setItem('garden.groupBy.v1', 'none')
    await renderGarden()
    // Crop-type grouping is in effect: two distinct crop groups, not one project tree.
    expect(screen.getByText('Tomato')).toBeTruthy()
    expect(screen.getByText('Pepper')).toBeTruthy()
    // And the retired project tree is NOT rendered off the stale value.
    expect(screen.queryByText('Bed Alpha')).toBeNull()
    expect(screen.queryByText('Bed Gamma')).toBeNull()
  })

  it('does not offer "Projects" as a group-by option even with the stale value set', async () => {
    localStorage.setItem('garden.groupBy.v1', 'none')
    await renderGarden()
    expect(screen.queryByText('Projects')).toBeNull()
  })

  it('leaves the stale value in place rather than silently rewriting it', async () => {
    // Deliberate, and worth pinning: the fallback is render-time only. Nothing migrates the stored
    // value, so reverting the flag restores the user's original project-tree preference intact.
    // If a future change starts rewriting it, that is a one-way door and this test should force the
    // conversation rather than let it happen quietly.
    localStorage.setItem('garden.groupBy.v1', 'none')
    await renderGarden()
    expect(localStorage.getItem('garden.groupBy.v1')).toBe('none')
  })
})

describe('Garden — V4-PROJHIDE-001 (flag ON)', () => {
  it('does not render the by-project tree (project names are not nodes)', async () => {
    await renderGarden()
    expect(screen.queryByText('Bed Alpha')).toBeNull()
    expect(screen.queryByText('Bed Gamma')).toBeNull()
  })

  it('defaults to CROP-TYPE grouping — Tomato and Pepper as distinct groups', async () => {
    await renderGarden()
    // Two crop-type group headers (not one lumped Lifecycle group, not a project).
    expect(screen.getByText('Tomato')).toBeTruthy()
    expect(screen.getByText('Pepper')).toBeTruthy()
  })

  it('offers no "Projects" grouping option', async () => {
    await renderGarden()
    expect(screen.queryByText('Projects')).toBeNull()
  })

  it('plantings are reachable under their crop-type group (no project step)', async () => {
    await renderGarden()
    const expandAll = screen.getByLabelText('Expand all sections')
    await act(async () => { fireEvent.click(expandAll) })
    expect(screen.getByText('Sungold')).toBeTruthy()
    expect(screen.getByText('Jalapeño')).toBeTruthy()
  })
})
