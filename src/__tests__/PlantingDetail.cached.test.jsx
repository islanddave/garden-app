// V4-IMGCACHE-001 D-1 — PlantingDetail through the SWR cache, at the PAGE level.
//
// Why this file exists. `useCachedFetch` picks its mode from `useAuthOptional().user?.id`, and with
// no AuthProvider that is null, so the hook degrades to PLAIN: a plain fetch-on-mount that writes no
// cache entry. Every other PlantingDetail/PhotosWall test mounts provider-less, so all of them
// exercise PLAIN while production — IMAGE_LIST_CACHE_ENABLED is true — runs CACHED. The hook's own
// suite covers CACHED thoroughly in isolation; what was untested is whether THIS PAGE actually
// reaches it, i.e. whether the sub is threaded all the way to the key. A page that silently stayed
// on PLAIN in production would look identical in every existing test.
//
// The identity mock is the whole point: it must supply `user`, not `profile`. Garden.lens.test.jsx
// mocks useAuthOptional as `() => ({ profile: { id: 'me' } })` — no `user` key — which yields
// sub=null and PLAIN. That shape is a trap for anyone copying it into a cache-consuming test.
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
vi.mock('../lib/uxEvents.js', () => ({
  FLOWS: { OPEN_PLANTING: 'open_planting' },
  useUxFlow: () => ({ step: vi.fn(), tap: vi.fn(), complete: vi.fn(), reset: vi.fn() }),
}))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => null }))
// Read through a ref so a test can flip identity between mounts without re-mocking the module.
vi.mock('../context/AuthContext.jsx', () => ({
  useAuthOptional: () => identity.current,
  useAuth: () => identity.current,
}))

import PlantingDetail from '../pages/PlantingDetail.jsx'
import * as cache from '../lib/dataCache.js'
import { IMAGE_LIST_CACHE_ENABLED } from '../lib/featureFlags.js'

const PLANTING = {
  id: 'pl1', name: 'Megatron Jalapeno', project_id: 'proj1', project_name: 'Peppers 2026',
  status: 'fruiting', quantity: 3, variety_ref: { name: 'Megatron F4' },
  featured_photo_view_url: null,
}
const PHOTOS_A = [{ id: 'ph-A', created_at: '2026-06-01T00:00:00Z', view_url: 'a.jpg' }]
const PHOTOS_B = [{ id: 'ph-B', created_at: '2026-06-02T00:00:00Z', view_url: 'b.jpg' }]

const ATTACHED_PATH = `/api/photos?attachedTo=${PLANTING.id}`

function route(url) {
  if (url.startsWith('/api/photos?attachedTo=')) return 'photos'
  if (url.includes('/plants/')) return 'planting'
  return 'other'
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/projects/proj1/plantings/pl1']}>
      <Routes>
        <Route path="/projects/:id/plantings/:plantingId" element={<PlantingDetail />} />
        <Route path="/projects/:id" element={<div>PROJECT PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

// The name renders in both the H1 and the breadcrumb, so findByText matches ambiguously —
// the heading is the unambiguous anchor (same choice PlantingDetail.test.jsx makes).
const findLoaded = () => screen.findByRole('heading', { name: PLANTING.name })

beforeEach(() => {
  cache.__resetDataCache()
  identity.current = { user: { id: 'sub-A' }, profile: null, loading: false }
  window.scrollTo = vi.fn()
  apiFetchSpy.mockReset()
  apiFetchSpy.mockImplementation(url => {
    const kind = route(String(url))
    if (kind === 'planting') return Promise.resolve(PLANTING)
    if (kind === 'photos') return Promise.resolve(PHOTOS_A)
    return Promise.resolve([])
  })
})

describe('PlantingDetail — reaches CACHED mode (not PLAIN) when an identity is present', () => {
  it('the flag under test is actually on, or every assertion below is vacuous', () => {
    expect(IMAGE_LIST_CACHE_ENABLED).toBe(true)
  })

  it('writes a cache entry keyed by the CURRENT sub — impossible in PLAIN mode', async () => {
    renderPage()
    await findLoaded()
    await waitFor(() => {
      expect(cache.peek(cache.keyFor('sub-A', ATTACHED_PATH))?.data).toEqual(PHOTOS_A)
    })
  })

  it('a warm cache paints photos WITHOUT waiting for the network', async () => {
    // Seed the key exactly as boot-warm would, then mount cold against a photos request that
    // NEVER resolves. That hang is the discriminator, and it is why this test asserts on rendered
    // output rather than on the cache entry: asserting the entry still holds what we just seeded
    // into it passes even when the page ignores the cache entirely (it did — caught by mutation).
    //   CACHED + warm → `loading` is false while revalidating (data already present), photos render.
    //   PLAIN        → `loading` is true until the fetch settles, so it hangs on "Loading photos…".
    cache.warm(cache.keyFor('sub-A', ATTACHED_PATH), () => Promise.resolve(PHOTOS_A))
    await waitFor(() => expect(cache.peek(cache.keyFor('sub-A', ATTACHED_PATH))?.data).toEqual(PHOTOS_A))

    apiFetchSpy.mockReset()
    apiFetchSpy.mockImplementation(url => {
      const kind = route(String(url))
      if (kind === 'planting') return Promise.resolve(PLANTING)
      if (kind === 'photos') return new Promise(() => {})   // hangs forever
      return Promise.resolve([])
    })

    renderPage()
    await findLoaded()
    await waitFor(() => expect(screen.getByText(`(${PHOTOS_A.length})`)).toBeTruthy())
    expect(screen.queryByText('Loading photos…')).toBeNull()
  })

  it('a DIFFERENT sub never reads the first sub\'s photos — page-level identity scoping', async () => {
    const first = renderPage()
    await findLoaded()
    await waitFor(() => {
      expect(cache.peek(cache.keyFor('sub-A', ATTACHED_PATH))?.data).toEqual(PHOTOS_A)
    })

    // UNMOUNT before switching identity. Leaving the first tree mounted made this test flaky:
    // its SWR revalidate was still in flight, so it resolved AFTER the fetch spy was swapped and
    // committed sub-B's photos under sub-A's key — a race in the TEST, not in the app. It passed
    // on a fast local run and failed in CI, where the suite takes ~8x longer.
    first.unmount()
    await act(async () => { await Promise.resolve() })

    identity.current = { user: { id: 'sub-B' }, profile: null, loading: false }
    apiFetchSpy.mockImplementation(url => {
      const kind = route(String(url))
      if (kind === 'planting') return Promise.resolve(PLANTING)
      if (kind === 'photos') return Promise.resolve(PHOTOS_B)
      return Promise.resolve([])
    })
    renderPage()
    await waitFor(() => {
      expect(cache.peek(cache.keyFor('sub-B', ATTACHED_PATH))?.data).toEqual(PHOTOS_B)
    })
    // A's entry is untouched, and B's key is a different string — the two can never alias.
    expect(cache.peek(cache.keyFor('sub-A', ATTACHED_PATH))?.data).toEqual(PHOTOS_A)
    expect(cache.keyFor('sub-A', ATTACHED_PATH)).not.toBe(cache.keyFor('sub-B', ATTACHED_PATH))
  })

  it('with NO identity the page falls back to PLAIN and writes nothing to the cache', async () => {
    identity.current = { user: null, profile: null, loading: false }
    renderPage()
    await findLoaded()
    expect(cache.peek(cache.keyFor('null', ATTACHED_PATH))).toBeNull()
    expect(cache.peek(cache.keyFor(null, ATTACHED_PATH))).toBeNull()
  })
})
