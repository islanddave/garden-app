/**
 * src/__tests__/PhotoLibrary.test.jsx
 * V2-PHOTO-F1 Session 2 — PhotoLibrary refactor regression tests.
 *
 * Scope:
 *   - Page renders header and upload toggle.
 *   - Upload trigger toggles the form open.
 *   - PhotoUpload component receives the canonical props
 *     (keyPrefix='standalone', linkage shape, errorMode='surface').
 *   - The trigger is disabled until project_id is picked (regression-critical
 *     gate from the pre-refactor behavior).
 *   - On successful upload via PhotoUpload, the photo list re-fetches and
 *     the form resets (handleUploadComplete contract).
 *
 * Mocks:
 *   - useApiFetch -> fetchSpy
 *   - PhotoUpload -> capture-style stub that exposes its props + provides a
 *     "complete" button to trigger onUploadComplete and verify cleanup.
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

const { fetchSpy, photoUploadProps } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  photoUploadProps: { current: null },
}))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy }),
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))

vi.mock('../components/PhotoUpload.jsx', () => ({
  default: (props) => {
    photoUploadProps.current = props
    return (
      <div data-testid="photo-upload-stub" data-disabled={props.disabled ? 'true' : 'false'}>
        <button
          type="button"
          data-testid="trigger-complete"
          onClick={() => props.onUploadComplete?.({ id: 'photo-new' })}
        >fake-upload</button>
        <button
          type="button"
          data-testid="trigger-error"
          onClick={() => props.onUploadError?.('mock failure')}
        >fake-error</button>
      </div>
    )
  },
}))

import PhotoLibrary from '../pages/PhotoLibrary.jsx'

const SAMPLE_PROJECT  = { id: 'proj-1', name: 'Spring 2026' }
const SAMPLE_LOCATION = { id: 'loc-1', full_path: 'Garden › Bed A', is_active: true }

beforeEach(() => {
  fetchSpy.mockReset()
  photoUploadProps.current = null
})

function primeMount({ projects = [SAMPLE_PROJECT], locations = [SAMPLE_LOCATION], photos = [] } = {}) {
  fetchSpy.mockResolvedValueOnce(projects)   // /api/projects
  fetchSpy.mockResolvedValueOnce(locations)  // /api/locations/with-path
  fetchSpy.mockResolvedValueOnce(photos)     // /api/photos
}

describe('PhotoLibrary — V2-PHOTO-F1 S2 refactor', () => {
  it('renders header and toggles the upload form open', async () => {
    primeMount()
    render(<PhotoLibrary />)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/projects'))
    fireEvent.click(screen.getByText('+ Upload'))
    expect(screen.getByTestId('photo-library-upload-form')).toBeDefined()
    expect(screen.getByTestId('photo-upload-stub')).toBeDefined()
  })

  it('PhotoUpload receives standalone keyPrefix + linkage shape', async () => {
    primeMount()
    render(<PhotoLibrary />)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/projects'))
    fireEvent.click(screen.getByText('+ Upload'))
    expect(photoUploadProps.current).toBeTruthy()
    expect(photoUploadProps.current.keyPrefix).toBe('standalone')
    expect(photoUploadProps.current.errorMode).toBe('surface')
    // linkage starts null (no project selected) — the gate must hold the trigger disabled.
    expect(photoUploadProps.current.linkage).toEqual({ project_id: null, location_id: null, plant_id: null })
    expect(photoUploadProps.current.disabled).toBe(true)
  })

  it('enables PhotoUpload once project_id is selected', async () => {
    primeMount()
    render(<PhotoLibrary />)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/projects'))
    fireEvent.click(screen.getByText('+ Upload'))
    // The plants-for-upload effect fires on project change — prime it.
    fetchSpy.mockResolvedValueOnce([])
    const projectSelect = screen.getByDisplayValue(/Select project/i)
    await act(async () => {
      fireEvent.change(projectSelect, { target: { value: 'proj-1' } })
    })
    await waitFor(() => expect(photoUploadProps.current.disabled).toBe(false))
    expect(photoUploadProps.current.linkage.project_id).toBe('proj-1')
  })

  // V4-PHOTOLOCFIND-001: one-of target gate — a space alone is a valid home (the meta-photo case);
  // project is no longer singularly required.
  it('enables PhotoUpload with a space alone (one-of gate)', async () => {
    primeMount()
    render(<PhotoLibrary />)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/projects'))
    fireEvent.click(screen.getByText('+ Upload'))
    expect(photoUploadProps.current.disabled).toBe(true)
    const spaceSelect = screen.getByDisplayValue('— None —')
    await act(async () => {
      fireEvent.change(spaceSelect, { target: { value: 'loc-1' } })
    })
    await waitFor(() => expect(photoUploadProps.current.disabled).toBe(false))
    expect(photoUploadProps.current.linkage).toEqual({ project_id: null, location_id: 'loc-1', plant_id: null })
  })

  it('space filter chip queries the server with ?location_id= (V4-PHOTOLOCFIND-001)', async () => {
    primeMount()
    render(<PhotoLibrary />)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/photos'))
    fetchSpy.mockResolvedValueOnce([])  // the refetch the filter change triggers
    const spaceFilter = screen.getByDisplayValue('Filter by space…')
    await act(async () => {
      fireEvent.change(spaceFilter, { target: { value: 'loc-1' } })
    })
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/photos?location_id=loc-1'))
  })

  it('untagged filter treats a space-only photo as tagged (V002 E2: not unfinished work)', async () => {
    const spaceOnly = { id: 'p-loc',  event_id: null, project_id: null, location_id: 'loc-1', plant_id: null, view_url: 'https://x/a.jpg', caption: 'space photo' }
    const bare      = { id: 'p-bare', event_id: null, project_id: null, location_id: null,    plant_id: null, view_url: 'https://x/b.jpg', caption: 'bare photo' }
    primeMount({ photos: [spaceOnly, bare] })
    render(<PhotoLibrary />)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/photos'))
    fetchSpy.mockResolvedValueOnce([spaceOnly, bare])  // refetch on mode change
    await act(async () => {
      fireEvent.click(screen.getByText('Untagged'))
    })
    await waitFor(() => expect(screen.getByAltText('bare photo')).toBeDefined())
    expect(screen.queryByAltText('space photo')).toBeNull()
  })

  it('handles upload completion: reloads photos and resets form', async () => {
    primeMount()
    render(<PhotoLibrary />)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/projects'))
    fireEvent.click(screen.getByText('+ Upload'))
    fetchSpy.mockResolvedValueOnce([])  // plants-for-upload after project change
    const projectSelect = screen.getByDisplayValue(/Select project/i)
    await act(async () => {
      fireEvent.change(projectSelect, { target: { value: 'proj-1' } })
    })
    // Next photo refetch — return one photo
    fetchSpy.mockResolvedValueOnce([{ id: 'photo-new', view_url: 'https://example/photo-new.jpg', project_id: 'proj-1' }])
    await act(async () => {
      fireEvent.click(screen.getByTestId('trigger-complete'))
    })
    // After completion, /api/photos should have been called again (reload).
    await waitFor(() => {
      const photoCalls = fetchSpy.mock.calls.filter(c => c[0]?.startsWith('/api/photos'))
      expect(photoCalls.length).toBeGreaterThanOrEqual(2)
    })
  })

  it('surfaces upload errors via onUploadError', async () => {
    primeMount()
    render(<PhotoLibrary />)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/projects'))
    fireEvent.click(screen.getByText('+ Upload'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('trigger-error'))
    })
    await waitFor(() => expect(screen.getByText(/mock failure/)).toBeDefined())
  })

  // V1.2a-3 Increment A (I1): the tag modal's Save must PUT to /api/photos/:id.
  // Before the photos Lambda PUT route existed this 405'd and the raw
  // "Method not allowed" string surfaced in the modal.
  it('saving tags on a photo PUTs to /api/photos/:id', async () => {
    primeMount({
      photos: [{
        id: 'photo-9', caption: 'tag me',
        view_url: 'https://example/p.jpg',
        project_id: 'proj-1', location_id: null, plant_id: null,
      }],
    })
    render(<PhotoLibrary />)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/projects'))

    // Opening the modal (openModal) seeds tagForm.project_id from the photo,
    // which fires the modal's plants-for-project effect — prime that fetch.
    fetchSpy.mockResolvedValueOnce([])
    await act(async () => {
      fireEvent.click(screen.getByAltText('tag me').closest('button'))
    })
    expect(screen.getByText('Save tags')).toBeDefined()

    // PUT response
    fetchSpy.mockResolvedValueOnce({ id: 'photo-9', project_id: 'proj-1' })
    await act(async () => {
      fireEvent.click(screen.getByText('Save tags'))
    })

    const putCall = fetchSpy.mock.calls.find(
      c => c[0] === '/api/photos/photo-9' && c[1]?.method === 'PUT'
    )
    expect(putCall).toBeDefined()
    const body = JSON.parse(putCall[1].body)
    expect(body.project_id).toBe('proj-1')
  })
})

describe('PhotoLibrary — V3-PHOTODBG-001 visible load-failure state', () => {
  it('shows a visible error + Retry (not the empty state) when /api/photos fails with a 5xx', async () => {
    fetchSpy.mockResolvedValueOnce([SAMPLE_PROJECT])   // /api/projects
    fetchSpy.mockResolvedValueOnce([SAMPLE_LOCATION])  // /api/locations/with-path
    const e = new Error('HTTP 502'); e.status = 502
    fetchSpy.mockRejectedValueOnce(e)                  // /api/photos -> fail
    render(<PhotoLibrary />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/load your photos/i)
    // must NOT masquerade as the empty state
    expect(screen.queryByText(/No photos yet/i)).toBeNull()
    const retry = screen.getByText('Retry')
    expect(retry).toBeDefined()
    // retry calls loadPhotos ONLY (one fetch: /api/photos) — not the projects/locations effects
    fetchSpy.mockResolvedValueOnce([])
    fireEvent.click(retry)
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(screen.getByText(/No photos yet/i)).toBeDefined()
  })

  // V3-PHOTODBG-001 (4/4): a render-time fault in any PhotoCard must be contained by the
  // grid ErrorBoundary (contained retry card) and must NOT white-screen the whole page.
  it('contains a PhotoCard render fault in the grid ErrorBoundary (page header survives)', async () => {
    const poison = { id: 'p-bad', view_url: 'https://example/p.jpg', get project_name() { throw new Error('render boom') } }
    fetchSpy.mockResolvedValueOnce([SAMPLE_PROJECT])   // /api/projects
    fetchSpy.mockResolvedValueOnce([SAMPLE_LOCATION])  // /api/locations/with-path
    fetchSpy.mockResolvedValueOnce([poison])           // /api/photos -> poison row
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<PhotoLibrary />)
    // Fallback copy appears…
    await waitFor(() => expect(screen.getByText(/Couldn.t display your photos/i)).toBeDefined())
    // …with a Retry affordance…
    expect(screen.getByText('Retry')).toBeDefined()
    // …and the page chrome (header) is NOT taken down by the fault (boundary contained it).
    expect(screen.getByRole('heading', { name: 'Photos' })).toBeDefined()
    errSpy.mockRestore()
  })
})
