// V4-PHOTOCAPTION-001 — caption editing in the photo modal. PUT /api/photos/:id already accepted
// `caption` and the client already round-tripped it unchanged; only the input was missing. Pins:
// prefill from the row, trimmed PUT value, cleared -> null, local grid state updated, and the
// event-attached branch (no form -> static caption only). Harness mirrors PhotoLibrary.test.jsx.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))

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

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: vi.fn().mockResolvedValue({ photo: { id: 'p1' } }), isUploading: false, error: null, photo: null, preview: null, stage: null, progress: null, reset: vi.fn() }),
}))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))

import PhotoLibrary from '../pages/PhotoLibrary.jsx'

const SAMPLE_PROJECT  = { id: 'proj-1', name: 'Spring 2026' }
const SAMPLE_LOCATION = { id: 'loc-1', full_path: 'Garden › Bed A', is_active: true }

// location-parented photos: passes the one-of gate without firing the modal plants-for-project fetch
const photoRow = (over = {}) => ({
  id: 'photo-1', caption: 'old caption', view_url: 'https://example/p.jpg',
  project_id: null, location_id: 'loc-1', plant_id: null, event_id: null,
  ...over,
})

beforeEach(() => {
  fetchSpy.mockReset()
  if (typeof URL.createObjectURL !== 'function') URL.createObjectURL = vi.fn(() => 'blob:stub')
  if (typeof URL.revokeObjectURL !== 'function') URL.revokeObjectURL = vi.fn()
})

async function mountWith(photo) {
  fetchSpy.mockResolvedValueOnce([SAMPLE_PROJECT])   // /api/projects
  fetchSpy.mockResolvedValueOnce([SAMPLE_LOCATION])  // /api/locations/with-path
  fetchSpy.mockResolvedValueOnce([photo])            // /api/photos
  render(<PhotoLibrary />)
  await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/projects'))
  await act(async () => {
    fireEvent.click(screen.getByAltText(photo.caption ?? 'Garden photo').closest('button'))
  })
}

const captionInput = () => screen.getByPlaceholderText('What are you seeing?')

function findPut(id) {
  return fetchSpy.mock.calls.find(c => c[0] === `/api/photos/${id}` && c[1]?.method === 'PUT')
}

describe('PhotoLibrary — V4-PHOTOCAPTION-001 caption editing', () => {
  it('the modal pre-fills the caption input from the photo row', async () => {
    await mountWith(photoRow())
    expect(captionInput().value).toBe('old caption')
  })

  it('an edited caption is PUT trimmed and the grid updates locally', async () => {
    await mountWith(photoRow())
    fireEvent.change(captionInput(), { target: { value: '  first true leaves  ' } })
    fetchSpy.mockResolvedValueOnce({ id: 'photo-1' })
    await act(async () => { fireEvent.click(screen.getByText('Save tags')) })
    const put = findPut('photo-1')
    expect(put).toBeDefined()
    expect(JSON.parse(put[1].body).caption).toBe('first true leaves')
    // local grid state carries the new caption (alt text derives from it)
    expect(screen.getByAltText('first true leaves')).toBeTruthy()
  })

  it('clearing the caption PUTs null', async () => {
    await mountWith(photoRow())
    fireEvent.change(captionInput(), { target: { value: '   ' } })
    fetchSpy.mockResolvedValueOnce({ id: 'photo-1' })
    await act(async () => { fireEvent.click(screen.getByText('Save tags')) })
    expect(JSON.parse(findPut('photo-1')[1].body).caption).toBeNull()
  })

  it('an event-attached photo has no caption input — static caption text only', async () => {
    await mountWith(photoRow({ id: 'photo-evt', caption: 'evt cap', event_id: 'evt-1' }))
    expect(screen.queryByPlaceholderText('What are you seeing?')).toBeNull()
    expect(screen.getByText('evt cap')).toBeTruthy()
    expect(screen.getByText(/tags are managed via the event log/i)).toBeTruthy()
  })
})
