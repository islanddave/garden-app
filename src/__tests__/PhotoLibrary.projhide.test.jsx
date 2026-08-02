// V4-PROJHIDE-001 — PhotoLibrary with PROJECTS_HIDDEN mocked TRUE. Proves the photo→planting pickers
// are fed from the UNSCOPED /api/plants source (not /api/plants?project_id=), so they populate with no
// project step — the functional gap when the project chooser is hidden. project_id derivation from the
// chosen plant mirrors EventNew (covered by EventNew.projhide.test.jsx). Flag-OFF behavior (project-
// scoped pickers) is covered by PhotoLibrary.test.jsx. importActual spread so other flags keep values.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))

// BUG-PHOTOFIRST-001: PhotoLibrary now drives useUploadPhoto directly (photo staged first, uploaded
// on an explicit press). Mock the HOOK, not api.js — the real hook imports `apiFetch` at module
// load, which this file's api.js mock does not provide, so collection fails before any test runs.
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: vi.fn(() => Promise.resolve({ photo: { id: 'new-photo' } })),
    isUploading: false, error: null, photo: null, preview: null, stage: null, progress: null, reset: vi.fn(),
  }),
}))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))
vi.mock('../components/PhotoUpload.jsx', () => ({ default: () => <div data-testid="photo-upload-stub" /> }))
vi.mock('../lib/featureFlags.js', async (importActual) => ({
  ...(await importActual()),
  PROJECTS_HIDDEN: true,
}))

import PhotoLibrary from '../pages/PhotoLibrary.jsx'

const PLANT = { id: 'plant-1', name: 'Sungold', project_id: 'proj-B' }

beforeEach(() => {
  fetchSpy.mockReset()
  fetchSpy.mockImplementation((url) => {
    if (url === '/api/plants') return Promise.resolve([PLANT])
    return Promise.resolve([]) // projects, locations/with-path, photos
  })
})

describe('PhotoLibrary — V4-PROJHIDE-001 (flag ON)', () => {
  it('loads plantings from the UNSCOPED /api/plants source, never project-scoped', async () => {
    await act(async () => { render(<PhotoLibrary />) })
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/plants'))
    const scoped = fetchSpy.mock.calls.filter(([u]) => typeof u === 'string' && u.startsWith('/api/plants?project_id='))
    expect(scoped.length).toBe(0)
  })
})
