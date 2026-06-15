// V1.2a-4 S1 (PROJ-RESCOPE / V102 §5.1 #2) tests for ProjectNew.jsx kind
// dropdown + target_end_date additions. Asserts cultivar option is hidden
// while VARIETY_REF_UI_SHIPPED === false, guidance text present, and the
// new fields land in the POST body.

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

const { apiFetchSpy, navigateSpy, postCalls } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  postCalls: [],
}))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: apiFetchSpy }),
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => (
    <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>
  ),
  useNavigate: () => navigateSpy,
}))

import ProjectNew from '../pages/ProjectNew.jsx'

function wireApiFetch({ projectTypes = [], locations = [], projects = [], postResult = { id: 'proj-new-1' }, postError = null } = {}) {
  apiFetchSpy.mockImplementation((path, options = {}) => {
    if (options.method === 'POST' && path === '/api/projects') {
      postCalls.push(JSON.parse(options.body))
      if (postError) return Promise.reject(postError)
      return Promise.resolve(postResult)
    }
    if (path === '/api/projects/types') return Promise.resolve(projectTypes)
    if (path === '/api/locations/with-path') return Promise.resolve(locations)
    if (path === '/api/projects') return Promise.resolve(projects)
    return Promise.resolve(null)
  })
}

beforeEach(() => {
  apiFetchSpy.mockReset()
  navigateSpy.mockReset()
  postCalls.length = 0
})

describe('ProjectNew — V1.2a-4 S1 kind dropdown', () => {
  it('renders the kind dropdown with campaign + category options', async () => {
    wireApiFetch()
    await act(async () => { render(<ProjectNew />) })
    expect(screen.getByText('What kind of project is this?')).toBeDefined()
    expect(screen.getByText('Growing this season')).toBeDefined()
    expect(screen.getByText('Folder for organizing')).toBeDefined()
  })

  it('hides the cultivar option while VARIETY_REF_UI_SHIPPED === false', async () => {
    wireApiFetch()
    await act(async () => { render(<ProjectNew />) })
    expect(screen.queryByText('Cultivar reference')).toBeNull()
  })

  it('shows the guidance text when cultivar option is hidden', async () => {
    wireApiFetch()
    await act(async () => { render(<ProjectNew />) })
    expect(screen.getByText(/Just a planting for now\./)).toBeDefined()
  })

  it('renders the target_end_date input', async () => {
    wireApiFetch()
    await act(async () => { render(<ProjectNew />) })
    expect(screen.getByText('Target end date (optional)')).toBeDefined()
  })

  it('POST body contains kind + target_end_date as null when blank', async () => {
    wireApiFetch()
    await act(async () => { render(<ProjectNew />) })

    const nameInput = screen.getByPlaceholderText(/Peppers 2026/)
    await act(async () => {
      fireEvent.change(nameInput, { target: { value: 'Test Project' } })
    })

    const form = nameInput.closest('form')
    await act(async () => { fireEvent.submit(form) })
    await waitFor(() => expect(postCalls.length).toBeGreaterThan(0))

    expect(postCalls[0]).toMatchObject({
      name: 'Test Project',
      kind: null,
      target_end_date: null,
    })
  })

  it('POST body contains selected kind + target_end_date when filled', async () => {
    wireApiFetch()
    await act(async () => { render(<ProjectNew />) })

    const nameInput = screen.getByPlaceholderText(/Peppers 2026/)
    await act(async () => {
      fireEvent.change(nameInput, { target: { value: 'Tomatoes 2026' } })
    })

    // Find the kind select (the one with the campaign option)
    const kindSelect = screen.getByText('Growing this season').closest('select')
    await act(async () => {
      fireEvent.change(kindSelect, { target: { value: 'campaign' } })
    })

    // Find the target_end_date input
    const endDateLabel = screen.getByText('Target end date (optional)')
    const endDateInput = endDateLabel.parentElement.querySelector('input[type="date"]')
    await act(async () => {
      fireEvent.change(endDateInput, { target: { value: '2026-10-15' } })
    })

    const form = nameInput.closest('form')
    await act(async () => { fireEvent.submit(form) })
    await waitFor(() => expect(postCalls.length).toBeGreaterThan(0))

    expect(postCalls[0]).toMatchObject({
      name: 'Tomatoes 2026',
      kind: 'campaign',
      target_end_date: '2026-10-15',
    })
  })
})
