// V4-ASSIGNLENS-002 — caretaker lens semantics + active-filter cue.
// A person lens ("Mine"/"Jen") shows plantings assigned to that person AND unassigned (unclaimed)
// plantings; assigned-to-someone-else plantings are hidden. When a lens is active, a cue strip
// reports how many rows are hidden and offers a one-tap "Show all" escape. Regression guard for the
// bug where "Mine" silently swallowed unassigned plantings (all nasturtiums) from the Garden.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

// V4-PROJHIDE-001: the flag flipped TRUE in source on 2026-08-10. This suite predates the flip and
// its assertions describe the projects-VISIBLE UI (project chooser, project tree, "By project" scope),
// which remains a live configuration — rollback is a one-line revert. Pinned FALSE so every assertion
// below keeps covering what it was written to cover, rather than being rewritten to the flag-ON world
// and silently weakened. Flag-ON is covered by the *.projhide.test.jsx suites.
// importActual spread so every other flag keeps its real value.
vi.mock('../lib/featureFlags.js', async (importActual) => ({
  ...(await importActual()),
  PROJECTS_HIDDEN: false,
}))

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
// Two household members so the caretaker lens control renders (needs >2 options incl. Everyone).
vi.mock('../hooks/useMembers.js', () => ({ useMembers: () => ({ members: [
  { id: 'me', display_name: 'Dave' }, { id: 'jen', display_name: 'Jen' },
] }) }))
vi.mock('../context/AuthContext.jsx', () => ({ useAuthOptional: () => ({ profile: { id: 'me' } }) }))

import Garden from '../pages/Garden.jsx'

const PROJECTS = [{ id: 'a', name: 'Herbs', status: 'active', parent_project_id: null }]
const PLANTS = [
  { id: 'p_me',  name: 'Peppermint',        project_id: 'a', status: 'growing', assignee_user_id: 'me' },
  { id: 'p_jen', name: 'Chocolate Mint',    project_id: 'a', status: 'growing', assignee_user_id: 'jen' },
  { id: 'p_un',  name: 'Alaska Nasturtium', project_id: 'a', status: 'growing', assignee_user_id: null },
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

describe('Garden caretaker lens (V4-ASSIGNLENS-002)', () => {
  it('lens=Mine shows my plantings AND unassigned, hides others', async () => {
    localStorage.setItem('garden.careLens', 'me')
    await renderGarden()
    fireEvent.click(screen.getByLabelText(/Expand Herbs/))
    expect(screen.getByText('Peppermint')).toBeDefined()          // mine
    expect(screen.getByText('Alaska Nasturtium')).toBeDefined()   // unassigned — now surfaced
    expect(screen.queryByText('Chocolate Mint')).toBeNull()       // Jen's — hidden
  })

  it('shows an active-filter cue with hidden count + Show all escape', async () => {
    localStorage.setItem('garden.careLens', 'me')
    await renderGarden()
    const cue = screen.getByTestId('lens-cue')
    expect(cue.textContent).toMatch(/Showing/)
    expect(cue.textContent).toMatch(/Mine/)
    expect(cue.textContent).toMatch(/1 planting hidden/)          // only Chocolate Mint hidden
  })

  it('Show all clears the lens back to Everyone (cue disappears, hidden rows return)', async () => {
    localStorage.setItem('garden.careLens', 'me')
    await renderGarden()
    await act(async () => { fireEvent.click(screen.getByText('Show all')) })
    expect(screen.queryByTestId('lens-cue')).toBeNull()
    fireEvent.click(screen.getByLabelText(/Expand Herbs/))
    expect(screen.getByText('Chocolate Mint')).toBeDefined()      // Jen's row back under Everyone
  })

  it('no cue when lens is Everyone (default)', async () => {
    await renderGarden()
    expect(screen.queryByTestId('lens-cue')).toBeNull()
  })
})
