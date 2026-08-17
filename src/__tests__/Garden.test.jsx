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
    Promise.resolve(url === '/api/projects' ? PROJECTS : url === '/api/plants?view=grid' ? PLANTS : []))
})

async function renderGarden() {
  await act(async () => { render(<Garden />) })
  await screen.findByText(/Log many/)
}

describe('Garden — unified accordion tree', () => {
  it('renders no page-title heading (V3-IA: tab is self-evident)', async () => {
    await renderGarden()
    expect(screen.queryByText('Garden')).toBeNull()
    expect(document.querySelector('h1')).toBeNull()
  })

  it('renders a tree of top-level projects, collapsed-first (descendants hidden)', async () => {
    await renderGarden()
    expect(screen.getByRole('tree')).toBeDefined()
    expect(screen.getByText('Tomatoes')).toBeDefined()
    expect(screen.getByText('Empty Bed')).toBeDefined()
    expect(screen.queryByText('Cherry')).toBeNull()   // sub-project hidden
    expect(screen.queryByText('Sungold')).toBeNull()  // planting hidden
  })

  it('expanding a folder reveals its plantings and sub-projects (peek)', async () => {
    await renderGarden()
    fireEvent.click(screen.getByLabelText(/Expand Tomatoes/))
    expect(screen.getByText('Cherry')).toBeDefined()
    expect(screen.getByText('Sungold')).toBeDefined()
  })

  it('the photo/thumbnail link opens project detail (Variant A: picture = go in)', async () => {
    await renderGarden()
    expect(screen.getByLabelText('Open Tomatoes').getAttribute('href')).toBe('/projects/a')
  })

  it('a leaf project (no children) is not expandable', async () => {
    await renderGarden()
    expect(screen.queryByLabelText(/Expand Empty Bed/)).toBeNull()
  })

  it('disclosure state persists to localStorage', async () => {
    await renderGarden()
    fireEvent.click(screen.getByLabelText(/Expand Tomatoes/))
    expect(localStorage.getItem('garden.expanded.v1')).toContain('a')
  })

  it('a planting row opens its own PlantingDetail page (V3-NAV-001)', async () => {
    await renderGarden()
    fireEvent.click(screen.getByLabelText(/Expand Tomatoes/))
    // Sungold (p1) under project a → /projects/a/plantings/p1, not /projects/a.
    expect(screen.getByLabelText('Open Sungold').getAttribute('href')).toBe('/projects/a/plantings/p1')
  })
})

describe('Garden — sort toggle removed (forced alpha) + Lifecycle grouping', () => {
  it('no longer renders the sort toggle', async () => {
    await renderGarden()
    expect(screen.queryByLabelText('Sort alphabetically')).toBeNull()
    expect(screen.queryByLabelText('Sort by most recent')).toBeNull()
  })
  it('offers a Lifecycle (status) grouping option', async () => {
    await renderGarden()
    // 'status' is always available -> the Group-by control shows even with no tags. V4-FACETSLUG-001
    // turned that control from a chip row into one native <select>, so the option is an <option>
    // now; assert it through the combobox rather than by loose text.
    const sel = screen.getByRole('combobox', { name: /Group by/i })
    expect([...sel.options].map(o => o.textContent)).toContain('Lifecycle')
  })
  it('grouped view is collapsed-by-default with an Expand all toggle that reveals rows', async () => {
    await renderGarden()
    // V4-FACETSLUG-001: choose the facet on the select (clicking an <option> is a no-op in jsdom
    // AND on a real native picker — the change event is what group-by listens to).
    await act(async () => {
      fireEvent.change(screen.getByRole('combobox', { name: /Group by/i }), { target: { value: 'status' } })
    })
    // collapsed by default -> the planting row is hidden
    expect(screen.queryByText('Sungold')).toBeNull()
    const expandAll = screen.getByLabelText('Expand all sections')
    await act(async () => { fireEvent.click(expandAll) })
    expect(screen.getByText('Sungold')).toBeTruthy()
    // now the toggle flips to Collapse all
    expect(screen.getByLabelText('Collapse all sections')).toBeTruthy()
  })
})
