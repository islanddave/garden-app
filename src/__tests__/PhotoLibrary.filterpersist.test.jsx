/**
 * src/__tests__/PhotoLibrary.filterpersist.test.jsx
 * V4-AMBIENTZONE-001 — the Photo Library zone filter remembers itself across mounts.
 *
 * WHY THIS SURFACE. The ambient app-wide zone was rejected: Log Many already persists its scope
 * (`quicklog.lastScope`) and Garden persists its group-by and care lens, so an ambient zone would
 * have been a third competing memory of "which zone". That left exactly ONE zone control in the app
 * with a genuine re-pick-every-time problem — PhotoLibrary's `filterLocation`, a bare useState('')
 * reset on every mount. This file guards the fix.
 *
 * Structured after LogMany.zoneScope.test.jsx, deliberately: same LIVE_ZONE / DEAD_ZONE shape,
 * because the persistence contract being copied is that file's. The load-bearing half is the DEAD
 * zone. Restoring an id blindly is worse than not restoring at all — the server answers
 * `?location_id=<dead>` with an empty set, so the user would land on an empty library holding a
 * filter chip they never chose and no obvious way to read what happened.
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))

// The real hook imports apiFetch at module load, which the api.js mock above does not provide.
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: vi.fn(), isUploading: false, error: null, photo: null,
    preview: null, stage: null, progress: null, reset: vi.fn(),
  }),
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))

vi.mock('../components/PhotoUpload.jsx', () => ({ default: () => <div data-testid="photo-upload-stub" /> }))

import PhotoLibrary from '../pages/PhotoLibrary.jsx'

const LIVE_ZONE = 'loc-pasture'
const DEAD_ZONE = 'loc-deleted-last-week'
const LOC_FILTER_KEY = 'photos.lastLocationFilter'

// DEAD_ZONE is deliberately absent from this list — this is what "the saved zone no longer
// resolves" looks like on the wire: /api/locations/with-path simply stops returning it.
const LIVE_LOCATIONS = [{ id: LIVE_ZONE, full_path: 'Pasture › Bed A', is_active: true }]

const photo = (id, caption) => ({
  id, caption, event_id: 'ev-1', project_id: null, location_id: null, plant_id: null,
  view_url: `https://x/${id}.jpg`,
})
const UNFILTERED = [photo('p-all', 'every photo')]
const IN_ZONE    = [photo('p-live', 'pasture photo')]

function wireApi() {
  fetchSpy.mockImplementation((path) => {
    if (path === '/api/projects') return Promise.resolve([])
    if (path === '/api/locations/with-path') return Promise.resolve(LIVE_LOCATIONS)
    if (path === '/api/plants') return Promise.resolve([])
    if (path === `/api/photos?location_id=${LIVE_ZONE}`) return Promise.resolve(IN_ZONE)
    // A dead id is a legal request the server answers with nothing — the exact "filtered to
    // nothing" outcome this feature must never produce on its own.
    if (path === `/api/photos?location_id=${DEAD_ZONE}`) return Promise.resolve([])
    if (path === '/api/photos') return Promise.resolve(UNFILTERED)
    return Promise.resolve(null)
  })
}

const zoneSelect = () => screen.getByDisplayValue(/Filter by zone|Pasture/)

describe('PhotoLibrary zone filter — persisted across mounts, validated against live zones', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    sessionStorage.clear()
    wireApi()
  })

  it('restores the saved zone filter on a later mount', async () => {
    const first = render(<PhotoLibrary />)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/photos'))
    await act(async () => { fireEvent.change(zoneSelect(), { target: { value: LIVE_ZONE } }) })
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(`/api/photos?location_id=${LIVE_ZONE}`))
    expect(localStorage.getItem(LOC_FILTER_KEY)).toBe(LIVE_ZONE)

    first.unmount()
    fetchSpy.mockClear()

    render(<PhotoLibrary />)
    // The restored filter reaches the WIRE, not merely the <select> — a filter that renders as
    // chosen but does not scope the query would satisfy a display-only assertion.
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(`/api/photos?location_id=${LIVE_ZONE}`))
    // Captions render as the tile <img>'s alt text, not as page text.
    await screen.findByAltText('pasture photo')
    expect(zoneSelect().value).toBe(LIVE_ZONE)
  })

  // THE LOAD-BEARING ONE. Named in the brief: a saved location that no longer exists must not
  // produce an empty library.
  it('does NOT filter the library to nothing when the saved zone no longer exists', async () => {
    localStorage.setItem(LOC_FILTER_KEY, DEAD_ZONE)

    render(<PhotoLibrary />)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/photos'))
    // Assert on the LIBRARY the user sees, not on the absence of a call: the unfiltered photo is
    // present, so the page is not empty.
    await screen.findByAltText('every photo')
    // ...and the dead id never reached the server at all, so there is no empty-flash either.
    expect(fetchSpy).not.toHaveBeenCalledWith(`/api/photos?location_id=${DEAD_ZONE}`)
    // The chip reads unfiltered, so nothing on screen claims a zone the user cannot see photos for.
    expect(zoneSelect().value).toBe('')
  })

  it('remembers a CLEARED filter too — a mode chip clears the memory, not just the state', async () => {
    localStorage.setItem(LOC_FILTER_KEY, LIVE_ZONE)

    const first = render(<PhotoLibrary />)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(`/api/photos?location_id=${LIVE_ZONE}`))
    await act(async () => { fireEvent.click(screen.getByText('Untagged')) })
    expect(localStorage.getItem(LOC_FILTER_KEY)).toBe('')

    first.unmount()
    fetchSpy.mockClear()

    render(<PhotoLibrary />)
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/photos'))
    expect(fetchSpy).not.toHaveBeenCalledWith(`/api/photos?location_id=${LIVE_ZONE}`)
  })
})
