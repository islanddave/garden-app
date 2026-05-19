// V1.2a-4 S6 (PROJ-RESCOPE) tests for ProjectsAdminClassify.jsx admin route.
// Asserts viewport guard, fetch shape, kind dropdown, cultivar inline-create
// flow, chain-terminates check, ready-to-migrate copy block.

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

const { apiFetchSpy, calls } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  calls: [],
}))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: apiFetchSpy }),
}))

import ProjectsAdminClassify from '../pages/ProjectsAdminClassify.jsx'

function makeProjects(overrides = {}) {
  // Three-level tree: campaign (Build Out, Fruiting Plants) -> category (Peppers) -> cultivar (Bell).
  // One unclassified row to assert kind=NULL handling.
  return [
    { id: 'p-build', name: 'Build Out', parent_project_id: null, kind: 'campaign' },
    { id: 'p-fruiting', name: 'Fruiting Plants', parent_project_id: null, kind: null },
    { id: 'p-peppers', name: 'Peppers', parent_project_id: 'p-fruiting', kind: null },
    { id: 'p-bell', name: 'Bell', parent_project_id: 'p-peppers', kind: null },
    ...(overrides.extra ?? []),
  ]
}

function wire({ projects = makeProjects(), patchResult = {}, postResult = {}, patchError = null, postError = null } = {}) {
  apiFetchSpy.mockImplementation((path, options = {}) => {
    calls.push({ path, method: options.method ?? 'GET', body: options.body })
    if (path === '/api/projects?admin=1') return Promise.resolve(projects)
    if (path === '/api/varieties' && options.method === 'POST') {
      if (postError) return Promise.reject(postError)
      return Promise.resolve({ id: 'v-new-1', ...postResult })
    }
    if (path.startsWith('/api/projects/') && options.method === 'PATCH') {
      if (patchError) return Promise.reject(patchError)
      const id = path.split('/')[3]
      const body = JSON.parse(options.body)
      return Promise.resolve({ id, ...body, ...patchResult })
    }
    return Promise.resolve(null)
  })
}

function setViewport(width) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true })
}

beforeEach(() => {
  apiFetchSpy.mockReset()
  calls.length = 0
  setViewport(1280)  // default desktop
})

afterEach(() => {
  setViewport(1280)
})

describe('ProjectsAdminClassify — viewport guard', () => {
  it('renders the desktop-only placard when innerWidth < 1024', async () => {
    setViewport(800)
    wire()
    await act(async () => { render(<ProjectsAdminClassify />) })
    expect(screen.getByText(/Desktop only/i)).toBeDefined()
    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  it('renders the full UI at innerWidth >= 1024', async () => {
    setViewport(1280)
    wire()
    await act(async () => { render(<ProjectsAdminClassify />) })
    await waitFor(() => expect(screen.getByText(/Admin Classify/i)).toBeDefined())
  })
})

describe('ProjectsAdminClassify — fetch + render', () => {
  it('fetches /api/projects?admin=1 on mount', async () => {
    wire()
    await act(async () => { render(<ProjectsAdminClassify />) })
    await waitFor(() => expect(calls.some((c) => c.path === '/api/projects?admin=1')).toBe(true))
  })

  it('renders one row per project with name visible', async () => {
    wire()
    await act(async () => { render(<ProjectsAdminClassify />) })
    // Names may appear multiple times (e.g., Fruiting Plants is a row AND a
    // breadcrumb segment for its children). Assert one or more matches.
    await waitFor(() => expect(screen.getAllByText('Build Out').length).toBeGreaterThan(0))
    expect(screen.getAllByText('Fruiting Plants').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Peppers').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Bell').length).toBeGreaterThan(0)
  })

  it('renders progress bar showing classified count', async () => {
    wire()
    await act(async () => { render(<ProjectsAdminClassify />) })
    await waitFor(() => expect(screen.getByText(/1 of 4 classified/i)).toBeDefined())
  })

  it('renders the kind dropdown for each row with all three options', async () => {
    wire()
    await act(async () => { render(<ProjectsAdminClassify />) })
    await waitFor(() => expect(screen.getByText('Build Out')).toBeDefined())
    const selects = screen.getAllByRole('combobox')
    expect(selects.length).toBe(4)
    expect(selects[0].innerHTML).toMatch(/campaign/i)
    expect(selects[0].innerHTML).toMatch(/category/i)
    expect(selects[0].innerHTML).toMatch(/cultivar/i)
  })
})

describe('ProjectsAdminClassify — cultivar inline-create flow', () => {
  it('shows variety name input only when kind === cultivar', async () => {
    wire()
    await act(async () => { render(<ProjectsAdminClassify />) })
    await waitFor(() => expect(screen.getByText('Bell')).toBeDefined())

    const select = screen.getByLabelText(/kind for Bell/i)
    await act(async () => { fireEvent.change(select, { target: { value: 'cultivar' } }) })
    expect(screen.getByLabelText(/variety name for Bell/i)).toBeDefined()

    await act(async () => { fireEvent.change(select, { target: { value: 'category' } }) })
    expect(screen.queryByLabelText(/variety name for Bell/i)).toBeNull()
  })

  it('saveRow on cultivar: POSTs /api/varieties THEN PATCHes /api/projects/:id', async () => {
    wire()
    await act(async () => { render(<ProjectsAdminClassify />) })
    await waitFor(() => expect(screen.getAllByText('Bell').length).toBeGreaterThan(0))

    const select = screen.getByLabelText(/kind for Bell/i)
    await act(async () => { fireEvent.change(select, { target: { value: 'cultivar' } }) })

    const nameInput = screen.getByLabelText(/variety name for Bell/i)
    await act(async () => { fireEvent.change(nameInput, { target: { value: 'Bell Pepper' } }) })

    // Locate the row by the kind select's parent (row container is the select's parent).
    const bellRow = select.parentElement
    const bellSave = within(bellRow).getByRole('button', { name: /Save/i })
    await act(async () => { fireEvent.click(bellSave) })

    await waitFor(() => {
      const variety = calls.find((c) => c.path === '/api/varieties' && c.method === 'POST')
      expect(variety).toBeDefined()
      const body = JSON.parse(variety.body)
      expect(body.name).toBe('Bell Pepper')
      expect(body.source_proj_rescope_project_id).toBe('p-bell')
    })

    const patch = calls.find((c) => c.path === '/api/projects/p-bell' && c.method === 'PATCH')
    expect(patch).toBeDefined()
    const patchBody = JSON.parse(patch.body)
    expect(patchBody.kind).toBe('cultivar')

    // Variety POST must happen BEFORE the PATCH
    const varietyIdx = calls.findIndex((c) => c.path === '/api/varieties' && c.method === 'POST')
    const patchIdx = calls.findIndex((c) => c.path === '/api/projects/p-bell' && c.method === 'PATCH')
    expect(varietyIdx).toBeLessThan(patchIdx)
  })

  it('saveRow on non-cultivar: only PATCH, no variety POST', async () => {
    wire()
    await act(async () => { render(<ProjectsAdminClassify />) })
    await waitFor(() => expect(screen.getAllByText('Peppers').length).toBeGreaterThan(0))

    const select = screen.getByLabelText(/kind for Peppers/i)
    await act(async () => { fireEvent.change(select, { target: { value: 'category' } }) })

    const peppersRow = select.parentElement
    const peppersSave = within(peppersRow).getByRole('button', { name: /Save/i })
    await act(async () => { fireEvent.click(peppersSave) })

    await waitFor(() => {
      const patch = calls.find((c) => c.path === '/api/projects/p-peppers' && c.method === 'PATCH')
      expect(patch).toBeDefined()
    })
    const varietyPost = calls.find((c) => c.path === '/api/varieties' && c.method === 'POST')
    expect(varietyPost).toBeUndefined()
  })
})

describe('ProjectsAdminClassify — chain-terminates check', () => {
  it('flags category rows whose chain does not terminate at a campaign', async () => {
    // Make Peppers a category whose parent (Fruiting Plants) is also a category — no campaign upstream.
    const projects = [
      { id: 'p-fruiting', name: 'Fruiting Plants', parent_project_id: null, kind: 'category' },
      { id: 'p-peppers', name: 'Peppers', parent_project_id: 'p-fruiting', kind: 'category' },
    ]
    wire({ projects })
    await act(async () => { render(<ProjectsAdminClassify />) })
    // Violation text appears in header summary AND pending-migration block.
    await waitFor(() => expect(screen.getAllByText(/chain-terminates violation/i).length).toBeGreaterThan(0))
  })

  it('does NOT flag category rows that terminate at a campaign ancestor', async () => {
    const projects = [
      { id: 'p-fruiting', name: 'Fruiting Plants', parent_project_id: null, kind: 'campaign' },
      { id: 'p-peppers', name: 'Peppers', parent_project_id: 'p-fruiting', kind: 'category' },
    ]
    wire({ projects })
    await act(async () => { render(<ProjectsAdminClassify />) })
    await waitFor(() => expect(screen.getByText('Peppers')).toBeDefined())
    expect(screen.queryByText(/chain-terminates violation/i)).toBeNull()
  })
})

describe('ProjectsAdminClassify — ready-to-migrate copy block', () => {
  it('shows the apply-prod-migrations command when all rows classified + chain-OK', async () => {
    const projects = [
      { id: 'p-build', name: 'Build Out', parent_project_id: null, kind: 'campaign' },
      { id: 'p-fruiting', name: 'Fruiting Plants', parent_project_id: null, kind: 'campaign' },
      { id: 'p-peppers', name: 'Peppers', parent_project_id: 'p-fruiting', kind: 'category' },
    ]
    wire({ projects })
    await act(async () => { render(<ProjectsAdminClassify />) })
    await waitFor(() => expect(screen.getByText(/Ready to migrate/i)).toBeDefined())
    expect(screen.getByText(/apply-prod-migrations\.py/)).toBeDefined()
    expect(screen.getByText(/--pattern s6-0a/)).toBeDefined()
  })

  it('hides the ready block when rows remain unclassified', async () => {
    wire()  // default has 3 unclassified rows
    await act(async () => { render(<ProjectsAdminClassify />) })
    await waitFor(() => expect(screen.getByText(/Migration not yet runnable/i)).toBeDefined())
    expect(screen.queryByText(/Ready to migrate/i)).toBeNull()
  })
})

// Helper — local re-import to keep within-tests scoped (vitest module hoist quirk).
import { within } from '@testing-library/react'
