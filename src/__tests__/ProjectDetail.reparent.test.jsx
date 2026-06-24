// V3-REPARENT-001 — first-class Move (atomic reparent) + inline Undo in ProjectDetail.
// Mirrors the ProjectDetail.plantForm harness. Frontend vitest is CI-authoritative.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

const { apiFetchSpy, navigateSpy, paramsRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  paramsRef: { id: 'proj-1' },
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => (<a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>),
  useParams: () => paramsRef,
  useNavigate: () => navigateSpy,
}))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: vi.fn(), isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))
vi.mock('../components/PhotoUpload.jsx', () => ({ default: () => <div data-testid="photo-upload-stub" /> }))
vi.mock('../components/Breadcrumb.jsx', () => ({ default: () => <div data-testid="breadcrumb-stub" /> }))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <div data-testid="favorite-toggle-stub" /> }))
vi.mock('../components/AssigneePicker.jsx', () => ({ default: () => <div data-testid="assignee-stub" /> }))
vi.mock('../lib/status.js', () => ({ getStatusColors: () => ({ bg: '#fff', text: '#000', border: '#ccc' }) }))

import ProjectDetail from '../pages/ProjectDetail.jsx'

const PROJECT = {
  id: 'proj-1', name: 'Charentais', slug: 'charentais', status: 'growing',
  is_public: false, start_date: '2026-03-15', parent_project_id: null,
  version: 4, variety: null, species: null, description: null, location_id: null,
}
const ALL = [
  { id: 'proj-1', name: 'Charentais', parent_project_id: null },
  { id: 'cantaloupe', name: 'Cantaloupe', parent_project_id: null },
]

function wire({ reparentResult, reparentError = null, restoreResult } = {}) {
  const calls = []
  apiFetchSpy.mockImplementation((path, options = {}) => {
    const method = options.method ?? 'GET'
    if (method === 'POST' && path === '/api/projects/proj-1/reparent') {
      calls.push({ kind: 'reparent', body: JSON.parse(options.body) })
      if (reparentError) return Promise.reject(reparentError)
      return Promise.resolve(reparentResult ?? { id: 'proj-1', parent_project_id: 'cantaloupe', version: 5 })
    }
    if (method === 'POST' && path === '/api/projects/proj-1/reparent/restore') {
      calls.push({ kind: 'restore', body: JSON.parse(options.body) })
      return Promise.resolve(restoreResult ?? { id: 'proj-1', parent_project_id: null, version: 6 })
    }
    if (path === '/api/projects/proj-1') return Promise.resolve(PROJECT)
    if (path.startsWith('/api/events')) return Promise.resolve([])
    if (path === '/api/locations/with-path') return Promise.resolve([])
    if (path === '/api/projects') return Promise.resolve(ALL)
    if (path.startsWith('/api/plants')) return Promise.resolve([])
    return Promise.resolve(null)
  })
  return calls
}

beforeEach(() => { apiFetchSpy.mockReset(); navigateSpy.mockReset() })

async function openMoveAndSubmit() {
  const moveBtn = await screen.findByText('Move')              // action-row button opens the modal
  await act(async () => { fireEvent.click(moveBtn) })
  const submit = await screen.findByTestId('reparent-submit')  // modal submit — unambiguous
  const select = submit.closest('div').parentElement.querySelector('select')
  await act(async () => { fireEvent.change(select, { target: { value: 'cantaloupe' } }) })
  await act(async () => { fireEvent.click(screen.getByTestId('reparent-submit')) })
}

describe('ProjectDetail — V3-REPARENT-001 Move + Undo', () => {
  it('POSTs reparent with new_parent_id, an op_id, and the optimistic expected_version', async () => {
    const calls = wire()
    await act(async () => { render(<ProjectDetail />) })
    await openMoveAndSubmit()
    await waitFor(() => expect(calls.some(c => c.kind === 'reparent')).toBe(true))
    const body = calls.find(c => c.kind === 'reparent').body
    expect(body.new_parent_id).toBe('cantaloupe')
    expect(body.expected_version).toBe(4)
    expect(typeof body.op_id).toBe('string')
    expect(body.op_id.length).toBeGreaterThan(0)
  })

  it('shows inline Undo after a move and restore POSTs the move op_id as source_op_id', async () => {
    const calls = wire()
    await act(async () => { render(<ProjectDetail />) })
    await openMoveAndSubmit()
    await waitFor(() => expect(screen.getByTestId('reparent-undo')).toBeDefined())
    const moveOpId = calls.find(c => c.kind === 'reparent').body.op_id
    await act(async () => { fireEvent.click(screen.getByTestId('reparent-undo')) })
    await waitFor(() => expect(calls.some(c => c.kind === 'restore')).toBe(true))
    const restore = calls.find(c => c.kind === 'restore').body
    expect(restore.source_op_id).toBe(moveOpId)
    expect(typeof restore.op_id).toBe('string')
    expect(restore.expected_version).toBe(5) // version advanced by the move response
  })

  it('surfaces a friendly cycle message on a 422 from the server', async () => {
    wire({ reparentError: Object.assign(new Error('Move would create a cycle (target is a descendant of itself)'), { status: 422 }) })
    await act(async () => { render(<ProjectDetail />) })
    await openMoveAndSubmit()
    await waitFor(() => expect(screen.getByText(/can't move a project into one of its own sub-projects/i)).toBeDefined())
  })
})
