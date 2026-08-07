// LocationDetail — FIRST tests. Slice 0 of the SW API-cache remediation (design V100).
//
// Why this file exists at all: LocationDetail is one of only three `useCachedFetch` consumers, and
// it had ZERO tests. It also lives under src/pages/**, which is NOT in coverage.include — so the
// 82%+ measured coverage and the ratchet floor say nothing whatsoever about this page, and a
// regression here is invisible to CI by construction. Any change to the SW's API caching alters
// what CACHED mode observes on exactly these pages, so this gap had to close before the mechanism
// lands, not after.
//
// The identity mock supplies `user`, NOT `profile` — useCachedFetch reads `useAuthOptional().user?.id`,
// so a `profile`-shaped mock silently yields sub=null and PLAIN mode, which is the vacuous-test trap
// that already bit this codebase twice.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const { apiFetchSpy, identity } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  identity: { current: { user: { id: 'sub-A' }, profile: null, loading: false } },
}))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn() }),
}))
vi.mock('../context/AuthContext.jsx', () => ({
  useAuthOptional: () => identity.current,
  useAuth: () => identity.current,
}))
// Upload widget pulls in Clerk + file APIs that are irrelevant to these paths.
vi.mock('../components/PhotoUpload.jsx', () => ({ default: () => null }))
vi.mock('../components/PhotoImg.jsx', () => ({ default: ({ alt }) => <img alt={alt ?? 'photo'} /> }))

import LocationDetail from '../pages/LocationDetail.jsx'
import * as cache from '../lib/dataCache.js'

const LOCATION = { id: 'loc1', name: 'Greenhouse', path: 'Greenhouse', kind: 'zone' }
const PHOTOS = [{ id: 'ph1', view_url: 'a.jpg', caption: 'Bed 2' }]
const PHOTOS_PATH = '/api/photos?location_id=loc1'

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/locations/loc1']}>
      <Routes>
        <Route path="/locations/:id" element={<LocationDetail />} />
        <Route path="/locations" element={<div>ALL LOCATIONS</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  cache.__resetDataCache()
  identity.current = { user: { id: 'sub-A' }, profile: null, loading: false }
  window.scrollTo = vi.fn()
  apiFetchSpy.mockReset()
  apiFetchSpy.mockImplementation(url => {
    const u = String(url)
    if (u.startsWith('/api/locations/')) return Promise.resolve(LOCATION)
    if (u.startsWith('/api/photos')) return Promise.resolve(PHOTOS)
    return Promise.resolve([])
  })
})

describe('LocationDetail — the four states', () => {
  it('renders the location once loaded', async () => {
    renderPage()
    expect(await screen.findByRole('heading', { name: 'Greenhouse' })).toBeTruthy()
  })

  it('a failed location fetch shows the error and an escape route, not a thrown page', async () => {
    apiFetchSpy.mockImplementation(url =>
      String(url).startsWith('/api/locations/')
        ? Promise.reject(new Error('Location not found'))
        : Promise.resolve([]))
    renderPage()
    expect(await screen.findByText('Location not found')).toBeTruthy()
    expect(screen.getByRole('button', { name: /All locations/ })).toBeTruthy()
  })

  it('a location fetch failure does NOT take the photo gallery down with it', async () => {
    // The two fetches are independent; a page that renders the error state must not also blow up
    // on the cached-photos hook. Mutation: make the error branch fall through to the gallery render.
    apiFetchSpy.mockImplementation(url =>
      String(url).startsWith('/api/locations/')
        ? Promise.reject(new Error('nope'))
        : Promise.resolve(PHOTOS))
    renderPage()
    await screen.findByText('nope')
    expect(screen.queryByText('Loading photos…')).toBeNull()
  })
})

describe('LocationDetail — reaches CACHED mode, and is identity-scoped', () => {
  it('writes the photo list under the CURRENT sub — impossible in PLAIN mode', async () => {
    // Mutation: remove the sub from useCachedFetch's key (or force PLAIN) → no entry is ever
    // written and this fails. This is what proves the page reaches the cached path at all.
    renderPage()
    await screen.findByRole('heading', { name: 'Greenhouse' })
    await waitFor(() => {
      expect(cache.peek(cache.keyFor('sub-A', PHOTOS_PATH))?.data).toEqual(PHOTOS)
    })
  })

  it('a DIFFERENT sub never reads the first sub\'s photos', async () => {
    const first = renderPage()
    await screen.findByRole('heading', { name: 'Greenhouse' })
    await waitFor(() => expect(cache.peek(cache.keyFor('sub-A', PHOTOS_PATH))?.data).toEqual(PHOTOS))

    // Unmount before switching identity — otherwise the first tree's in-flight SWR revalidate
    // resolves after the fetch spy is swapped and commits sub-B's photos under sub-A's key. That
    // is a race in the TEST, not in the app; it hides on a fast run and surfaces in CI.
    first.unmount()
    await act(async () => { await Promise.resolve() })

    const OTHER = [{ id: 'ph2', view_url: 'b.jpg', caption: 'Jen bed' }]
    identity.current = { user: { id: 'sub-B' }, profile: null, loading: false }
    apiFetchSpy.mockImplementation(url =>
      String(url).startsWith('/api/locations/') ? Promise.resolve(LOCATION) : Promise.resolve(OTHER))
    renderPage()
    await waitFor(() => expect(cache.peek(cache.keyFor('sub-B', PHOTOS_PATH))?.data).toEqual(OTHER))

    expect(cache.peek(cache.keyFor('sub-A', PHOTOS_PATH))?.data).toEqual(PHOTOS)
    expect(cache.keyFor('sub-A', PHOTOS_PATH)).not.toBe(cache.keyFor('sub-B', PHOTOS_PATH))
  })

  it('with NO identity it falls back to PLAIN and writes nothing to the cache', async () => {
    identity.current = { user: null, profile: null, loading: false }
    renderPage()
    await screen.findByRole('heading', { name: 'Greenhouse' })
    expect(cache.peek(cache.keyFor(null, PHOTOS_PATH))).toBeNull()
    expect(cache.peek(cache.keyFor('null', PHOTOS_PATH))).toBeNull()
  })
})
