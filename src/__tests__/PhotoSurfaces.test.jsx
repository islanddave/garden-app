/**
 * src/__tests__/PhotoSurfaces.test.jsx
 * V2-PHOTO-F1 Session 2 — surface integration smoke tests.
 *
 * Verifies that ProjectDetail, LocationDetail, and EventDetail each mount
 * the shared <PhotoUpload> with the correct keyPrefix + linkage shape.
 *
 * We stub PhotoUpload to capture props per surface so we can assert without
 * crawling the rendered DOM tree of three different pages.
 *
 * The useUploadPhoto hook is also stubbed (ProjectDetail uses it directly for
 * its mini-logger staged-photo flow) to keep the test from touching the
 * 3-step network engine — that engine is exhaustively covered in
 * useUploadPhoto.test.js.
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

const { fetchSpy, capturedPhotoProps, uploadSpy } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  capturedPhotoProps: { current: [] },
  uploadSpy: vi.fn(),
}))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy }),
}))

vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: uploadSpy,
    isUploading: false,
    error: null,
    photo: null,
    preview: null,
    reset: vi.fn(),
  }),
}))

vi.mock('../components/PhotoUpload.jsx', () => ({
  default: (props) => {
    capturedPhotoProps.current.push(props)
    return (
      <div
        data-testid={`photo-upload-${props.keyPrefix}-${props.parentId ?? 'none'}`}
        data-key-prefix={props.keyPrefix}
        data-error-mode={props.errorMode}
        data-linkage={JSON.stringify(props.linkage ?? {})}
      />
    )
  },
}))

// Lightweight Link stub for react-router (both detail pages use it).
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return {
    ...actual,
    Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
    useParams: () => mockParams.current,
    useNavigate: () => vi.fn(),
  }
})

const mockParams = { current: {} }

// Stub Breadcrumb / FavoriteToggle / VarietyPicker so child pages render cleanly.
vi.mock('../components/Breadcrumb.jsx', () => ({ default: () => <nav data-testid="breadcrumb" /> }))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <span data-testid="fav" /> }))
vi.mock('../components/VarietyPicker.jsx', () => ({
  default: ({ value }) => <div data-testid="vp-stub">{value ? value.name : 'empty'}</div>,
}))
vi.mock('../context/AuthContext.jsx', () => ({
  useAuth: () => ({ user: { id: 'u1' } }),
}))
vi.mock('../hooks/useInventory.js', () => ({
  useInventory: () => ({
    updateItem: vi.fn().mockResolvedValue({ item: {} }),
    deleteItem: vi.fn().mockResolvedValue({ ok: true }),
  }),
}))

import LocationDetail from '../pages/LocationDetail.jsx'
import EventDetail from '../pages/EventDetail.jsx'
import ProjectDetail from '../pages/ProjectDetail.jsx'

beforeEach(() => {
  fetchSpy.mockReset()
  uploadSpy.mockReset()
  capturedPhotoProps.current = []
  mockParams.current = {}
})

describe('LocationDetail — photo upload section', () => {
  it('mounts PhotoUpload with locations keyPrefix and location_id linkage', async () => {
    mockParams.current = { id: 'loc-1' }
    fetchSpy.mockResolvedValueOnce({ id: 'loc-1', name: 'Bed A', is_active: true })
    render(<LocationDetail />)
    await waitFor(() => screen.getByTestId('photo-upload-locations-loc-1'))
    const node = screen.getByTestId('photo-upload-locations-loc-1')
    expect(node.dataset.keyPrefix).toBe('locations')
    expect(node.dataset.errorMode).toBe('surface')
    const linkage = JSON.parse(node.dataset.linkage)
    expect(linkage.location_id).toBe('loc-1')
  })
})

describe('EventDetail — photo upload section', () => {
  it('mounts PhotoUpload with events keyPrefix, swallow errorMode, and event_id+project_id linkage', async () => {
    mockParams.current = { id: 'proj-1', eventId: 'ev-1' }
    fetchSpy.mockResolvedValueOnce({ id: 'ev-1', event_type: 'watering', event_date: '2026-05-13', is_public: true })
    fetchSpy.mockResolvedValueOnce({ id: 'proj-1', name: 'Spring 2026' })
    render(<EventDetail />)
    await waitFor(() => screen.getByTestId('photo-upload-events-ev-1'))
    const node = screen.getByTestId('photo-upload-events-ev-1')
    expect(node.dataset.keyPrefix).toBe('events')
    expect(node.dataset.errorMode).toBe('swallow')
    const linkage = JSON.parse(node.dataset.linkage)
    expect(linkage.event_id).toBe('ev-1')
    expect(linkage.project_id).toBe('proj-1')
  })
})

describe('ProjectDetail — Project photos section + per-plant upload', () => {
  it('mounts a project-level PhotoUpload and a per-plant PhotoUpload', async () => {
    mockParams.current = { id: 'proj-1' }
    // Initial parallel load: project, events, locations, projects
    fetchSpy.mockResolvedValueOnce({ id: 'proj-1', name: 'Spring 2026', status: 'active', is_public: true, slug: 'spring-2026' })
    fetchSpy.mockResolvedValueOnce([])
    fetchSpy.mockResolvedValueOnce([])
    fetchSpy.mockResolvedValueOnce([])
    // Plants load
    fetchSpy.mockResolvedValueOnce([{ id: 'pl-1', name: 'Tomato', project_id: 'proj-1', quantity: 1 }])

    render(<ProjectDetail />)
    await waitFor(() => screen.getByTestId('photo-upload-projects-proj-1'))
    // Project-level mount
    const projNode = screen.getByTestId('photo-upload-projects-proj-1')
    const projLinkage = JSON.parse(projNode.dataset.linkage)
    expect(projLinkage.project_id).toBe('proj-1')
    // Per-plant mount
    await waitFor(() => screen.getByTestId('photo-upload-plants-pl-1'))
    const plantNode = screen.getByTestId('photo-upload-plants-pl-1')
    expect(plantNode.dataset.keyPrefix).toBe('plants')
    const plantLinkage = JSON.parse(plantNode.dataset.linkage)
    expect(plantLinkage.plant_id).toBe('pl-1')
    expect(plantLinkage.project_id).toBe('proj-1')
  })
})
