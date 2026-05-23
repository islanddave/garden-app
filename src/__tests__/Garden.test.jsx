import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))
const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchMock }) }))
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
    Promise.resolve(url === '/api/projects' ? PROJECTS : url === '/api/plants' ? PLANTS : []))
})

async function renderGarden() {
  await act(async () => { render(<Garden />) })
  await screen.findByText('Garden')
}

describe('Garden — unified accordion tree', () => {
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
})
