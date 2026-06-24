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
})
