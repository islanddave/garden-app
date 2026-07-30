// V4-PROJHIDE-001 — Garden with PROJECTS_HIDDEN mocked TRUE. Proves the by-project tree is gone
// (no project names as nodes, no "Projects" grouping option) and the view defaults to a facet
// (Lifecycle) so plantings are reachable without a project step. Flag-OFF behavior (project tree,
// "Projects" group-by) is covered by Garden.test.jsx. importActual spread so every other flag keeps
// its value. No jest-dom (L-182). Harness mirrors Garden.test.jsx.
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

const PROJECTS = [
  { id: 'a', name: 'Tomatoes',  status: 'active',   parent_project_id: null, is_public: true },
  { id: 'b', name: 'Cherry',    status: 'growing',  parent_project_id: 'a',  is_public: true },
  { id: 'c', name: 'Empty Bed', status: 'planning', parent_project_id: null, is_public: true },
]
const PLANTS = [
  { id: 'p1', name: 'Sungold', project_id: 'a', status: 'growing', quantity: 2 },
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

describe('Garden — V4-PROJHIDE-001 (flag ON)', () => {
  it('does not render the by-project tree (project names are not nodes)', async () => {
    await renderGarden()
    expect(screen.queryByText('Tomatoes')).toBeNull()
    expect(screen.queryByText('Empty Bed')).toBeNull()
  })

  it('offers no "Projects" grouping option', async () => {
    await renderGarden()
    expect(screen.queryByText('Projects')).toBeNull()
  })

  it('defaults to a facet view; the planting is reachable without a project step', async () => {
    await renderGarden()
    // Faceted (Lifecycle) view, collapsed by default; expanding reveals the planting — no project node.
    const expandAll = screen.getByLabelText('Expand all sections')
    await act(async () => { fireEvent.click(expandAll) })
    expect(screen.getByText('Sungold')).toBeTruthy()
  })
})
