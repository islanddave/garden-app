// V4-PICKERCACHE-001 — the planting chooser reads its list through the SWR cache.
//
// V4-PICKERPAYLOAD-001 made this response ~10x lighter (814,399 B + ~426 presigns -> 123,348 B and
// zero presigns, measured on prod Neon). It did not make it WARM. PROJECTS_HIDDEN is on, so every
// log event and every weigh-in still opened with a cold round trip for the whole planting list,
// and the chooser is the first control Dave touches on the surface he uses most.
//
// THE TRAP THIS FILE EXISTS TO AVOID, copied deliberately from Garden.cached.test.jsx and
// PlantingDetail.cached.test.jsx before it: useCachedFetch picks its mode from
// `useAuthOptional().user?.id`. With no AuthProvider that is null and the hook degrades to PLAIN —
// a plain fetch-on-mount that writes NO cache entry. Every OTHER EventNew test mounts
// provider-less, so all ~30 of them exercise PLAIN while production
// (IMAGE_LIST_CACHE_ENABLED === true) runs CACHED, and a chooser that silently stayed on PLAIN in
// prod would look identical in every one of them. Hence the identity mock supplies `user`, not
// `profile`; a `{ profile: { id: 'me' } }` shape yields sub=null and PLAIN, and is the exact trap
// not to copy.
//
// The warm-cache assertion uses a request that HANGS FOREVER as its discriminator. Asserting that
// the cache entry still holds what the test just seeded into it would pass even if the component
// ignored the cache completely; only a hang can tell "painted from cache" from "painted from a
// fast mock".
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'

const { fetchSpy, getTokenSpy, navigateSpy, searchParamsRef, identity } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  getTokenSpy: vi.fn(async () => 'tok'),
  navigateSpy: vi.fn(),
  searchParamsRef: { current: new URLSearchParams() },
  identity: { current: { user: { id: 'sub-A' }, profile: null, loading: false } },
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useNavigate: () => navigateSpy,
  useSearchParams: () => [searchParamsRef.current, vi.fn()],
}))
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: getTokenSpy }),
  apiFetch: (...a) => fetchSpy(...a),
}))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: vi.fn(() => Promise.resolve({ photo: { id: 'p1' } })),
    isUploading: false, error: null, photo: null, stage: null, progress: null, preview: null, reset: vi.fn(),
  }),
}))
// Read through a ref so a test can flip identity between mounts without re-mocking the module.
vi.mock('../context/AuthContext.jsx', () => ({
  useAuthOptional: () => identity.current,
  useAuth: () => identity.current,
}))

import EventNew from '../pages/EventNew.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import * as cache from '../lib/dataCache.js'
import { IMAGE_LIST_CACHE_ENABLED, PROJECTS_HIDDEN } from '../lib/featureFlags.js'

const PICKER_PATH = '/api/plants?view=picker'
const PLANT_A = { id: 'pl-1', name: 'Lemon Thyme', project_id: 'proj-1', project_name: 'Herbs', variety_ref: { name: 'Lemon Thyme' } }
const PLANT_B = { id: 'pl-9', name: 'Sweet Bay Laurel', project_id: 'proj-1', project_name: 'Herbs', variety_ref: { name: 'Sweet Bay' } }

function prime(plants = [PLANT_A], { hangPicker = false } = {}) {
  fetchSpy.mockReset()
  fetchSpy.mockImplementation((url, opts = {}) => {
    const u = String(url)
    if (opts.method === 'POST') return Promise.resolve({ id: 'evt-1' })
    if (u === '/api/projects') return Promise.resolve([{ id: 'proj-1', name: 'Herbs', status: 'growing' }])
    if (u === '/api/locations/with-path') return Promise.resolve([])
    // EVERY /api/plants request hangs in hang mode, not just the exact PICKER_PATH string. A
    // narrower branch with a resolving `startsWith` fallback beneath it is an escape hatch that
    // silently defeats the discriminator: a mutation run proved it: pointing the component at a
    // slightly different picker path made the warm-cache test pass, because the request fell
    // through to the fallback and painted from a fast network instead of from cache.
    if (u.startsWith('/api/plants')) return hangPicker ? new Promise(() => {}) : Promise.resolve(plants)
    return Promise.resolve(null)
  })
}

async function renderLog() {
  searchParamsRef.current = new URLSearchParams('event_type=watering')
  const out = await act(async () => render(<ToastProvider><EventNew /></ToastProvider>))
  await act(async () => { await Promise.resolve() })
  return out
}

// Opening the listbox is what renders the rows, and the rows are what prove the list arrived.
async function openChooser() {
  await act(async () => { fireEvent.focus(screen.getByLabelText('Plant or group')) })
}

beforeEach(() => {
  try { localStorage.clear() } catch { /* noop */ }
  cache.__resetDataCache()
  identity.current = { user: { id: 'sub-A' }, profile: null, loading: false }
  navigateSpy.mockReset()
  searchParamsRef.current = new URLSearchParams()
})

describe('EventNew picker — reaches CACHED mode (not PLAIN)', () => {
  it('the two flags under test are actually on, or every assertion below is vacuous', () => {
    expect(IMAGE_LIST_CACHE_ENABLED).toBe(true)
    // PROJECTS_HIDDEN off would route the chooser through the SCOPED loader instead, and this whole
    // file would be measuring a code path the app does not run.
    expect(PROJECTS_HIDDEN).toBe(true)
  })

  it('writes a picker cache entry keyed by the CURRENT sub — impossible in PLAIN mode', async () => {
    prime()
    await renderLog()
    await waitFor(() => {
      expect(cache.peek(cache.keyFor('sub-A', PICKER_PATH))?.data).toEqual([PLANT_A])
    })
  })

  it('a warm cache fills the chooser WITHOUT waiting for the network', async () => {
    // Seed the key as a prior visit would, then mount against a picker request that NEVER resolves.
    //   CACHED + warm -> the list is present on the first render and the row paints.
    //   PLAIN         -> the request hangs, the list stays empty, and no row ever appears.
    cache.warm(cache.keyFor('sub-A', PICKER_PATH), () => Promise.resolve([PLANT_A]))
    await waitFor(() => expect(cache.peek(cache.keyFor('sub-A', PICKER_PATH))?.data).toEqual([PLANT_A]))

    prime([PLANT_A], { hangPicker: true })
    await renderLog()
    await openChooser()
    expect(await screen.findByTestId('ps-opt-pl-1')).toBeTruthy()
  })

  it("a DIFFERENT sub never reads the first sub's plantings — identity scoping", async () => {
    prime()
    const first = await renderLog()
    await waitFor(() => expect(cache.peek(cache.keyFor('sub-A', PICKER_PATH))?.data).toEqual([PLANT_A]))
    first.unmount()

    identity.current = { user: { id: 'sub-B' }, profile: null, loading: false }
    prime([PLANT_B], { hangPicker: true })
    await renderLog()
    await openChooser()
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    // PAIRED with the warm-cache test above, and only meaningful as that pair: there, an identical
    // hanging request still painted because the viewer's OWN key was warm. Here the same setup
    // paints nothing, which is the only way to show the first sub's list was not readable.
    expect(screen.queryByTestId('ps-opt-pl-1')).toBeNull()
    expect(cache.peek(cache.keyFor('sub-B', PICKER_PATH))?.data).toBeUndefined()
  })

  it('mount issues exactly ONE picker request', async () => {
    prime()
    await renderLog()
    await waitFor(() => expect(cache.peek(cache.keyFor('sub-A', PICKER_PATH))?.data).toEqual([PLANT_A]))
    const pickerCalls = fetchSpy.mock.calls.filter(([u]) => String(u) === PICKER_PATH)
    expect(pickerCalls.length).toBe(1)
  })
})

// The write-through effect calls refetch() when plantsReloadKey changes, and is guarded against
// firing on mount because the hook already revalidates there. That guard has to be asserted in
// PLAIN mode, and this describe block exists because a mutation run proved the CACHED assertion
// above CANNOT see it: dataCache.revalidate() opens with `if (e.inFlight) return e.inFlight`, so a
// redundant mount-time revalidate is coalesced away and deleting the guard changes no observable
// number. PLAIN has no such coalescing — refetch() there bumps a tick that re-runs the fetch
// effect — so an unguarded mount costs a real second round trip on exactly the arm that has no
// cache to fall back on. Same guard, and the only place it is falsifiable.
describe('EventNew picker — PLAIN mode (no household identity) still fetches once', () => {
  it('does not double-fetch on mount when there is no sub to cache under', async () => {
    identity.current = { user: null, profile: null, loading: false }
    prime()
    await renderLog()
    await waitFor(() => expect(screen.getByLabelText('Plant or group')).toBeTruthy())
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    // Non-vacuity: PLAIN really is the mode under test — a cache entry would mean CACHED, and this
    // assertion would be describing a path the block is not about.
    expect(cache.peek(cache.keyFor('sub-A', PICKER_PATH))).toBeNull()
    const pickerCalls = fetchSpy.mock.calls.filter(([u]) => String(u) === PICKER_PATH)
    expect(pickerCalls.length).toBe(1)
  })
})
