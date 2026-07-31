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
import { __resetDataCache } from '../lib/dataCache.js'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

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
  useAuthOptional: () => ({ user: { id: 'u1' }, profile: null, loading: false }),   // D-1: LocationDetail's cache hook reads this
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
import Lightbox from '../components/Lightbox.jsx'

beforeEach(() => {
  fetchSpy.mockReset()
  uploadSpy.mockReset()
  capturedPhotoProps.current = []
  mockParams.current = {}
  __resetDataCache()   // D-1: the SWR store is a module singleton — clear it between cases
})

describe('LocationDetail — photo upload section', () => {
  // V4-PHOTOLOCFIND-001: the page now ALSO fetches its gallery (/api/photos?location_id=), so the
  // mock routes by URL instead of queuing a single resolved value.
  function mockLocationFetches({ photos = [] } = {}) {
    fetchSpy.mockImplementation((url) => {
      if (String(url).startsWith('/api/locations/')) return Promise.resolve({ id: 'loc-1', name: 'Bed A', is_active: true })
      if (String(url).startsWith('/api/photos')) return Promise.resolve(photos)
      return Promise.resolve(null)
    })
  }

  it('mounts PhotoUpload with locations keyPrefix and location_id linkage', async () => {
    mockParams.current = { id: 'loc-1' }
    mockLocationFetches()
    render(<LocationDetail />)
    await waitFor(() => screen.getByTestId('photo-upload-locations-loc-1'))
    const node = screen.getByTestId('photo-upload-locations-loc-1')
    expect(node.dataset.keyPrefix).toBe('locations')
    expect(node.dataset.errorMode).toBe('surface')
    const linkage = JSON.parse(node.dataset.linkage)
    expect(linkage.location_id).toBe('loc-1')
  })

  it('fetches and renders the space gallery via ?location_id= (V4-PHOTOLOCFIND-001)', async () => {
    mockParams.current = { id: 'loc-1' }
    mockLocationFetches({ photos: [
      { id: 'ph-1', thumb_url: 'https://x/t1.jpg', view_url: 'https://x/v1.jpg', caption: 'Bed A wide shot' },
      { id: 'ph-2', view_url: 'https://x/v2.jpg', caption: null },
    ] })
    render(<LocationDetail />)
    await waitFor(() => screen.getByTestId('location-photo-grid'))
    expect(fetchSpy).toHaveBeenCalledWith('/api/photos?location_id=loc-1')
    const grid = screen.getByTestId('location-photo-grid')
    expect(grid.querySelectorAll('img').length).toBe(2)
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

// One-tap "Set as featured" star INSIDE the Lightbox — saves the close→scroll→grid-tap
// round-trip (2 taps → 1). Reuses PlantingDetail's existing setFeatured handler; the star is
// hidden when no handler is wired (prop optional) so the Lightbox stays usable elsewhere.
describe('Lightbox — set-as-featured star', () => {
  const IMAGES = [
    { src: 'a.jpg', view_url: 'a.jpg', id: 'ph-1', alt: 'Alpha', caption: 'First' },
    { src: 'b.jpg', view_url: 'b.jpg', id: 'ph-2', alt: 'Bravo', caption: 'Second' },
  ]

  it('hides the star when no onSetFeatured handler is provided (prop optional)', () => {
    render(<Lightbox open images={IMAGES} index={0} onClose={() => {}} />)
    expect(screen.queryByTestId('lightbox-set-featured')).toBe(null)
  })

  it('renders the star and one click calls onSetFeatured with the current photo', () => {
    const onSetFeatured = vi.fn()
    render(
      <Lightbox open images={IMAGES} index={1} onSetFeatured={onSetFeatured} featuredId="ph-1" onClose={() => {}} />
    )
    const star = screen.getByTestId('lightbox-set-featured')
    // Viewing photo #2, which is NOT the featured one → inactive affordance.
    expect(star.getAttribute('aria-pressed')).toBe('false')
    expect(star.getAttribute('aria-label')).toBe('Set as featured')
    fireEvent.click(star)
    expect(onSetFeatured).toHaveBeenCalledTimes(1)
    expect(onSetFeatured.mock.calls[0][0].id).toBe('ph-2')
  })

  it('shows the star as active (pressed) when the current photo is already featured', () => {
    render(
      <Lightbox open images={IMAGES} index={0} onSetFeatured={vi.fn()} featuredId="ph-1" onClose={() => {}} />
    )
    const star = screen.getByTestId('lightbox-set-featured')
    expect(star.getAttribute('aria-pressed')).toBe('true')
    expect(star.getAttribute('aria-label')).toBe('Featured photo')
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
