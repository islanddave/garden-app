// V4-GARDENCACHE-001 — Garden reads its list through the SWR cache, at the PAGE level.
//
// Dave, 2026-08-26: "sometimes the chooser can take a couple of seconds to load the list ... or for
// the list view in Garden." Garden's PAYLOAD was already dealt with (V4-PLANTSPAYLOAD-001's
// ?view=grid). What was left is that this page had no cache at all — every visit to the tab was a
// cold round trip for the grid body plus a freshly presigned URL per hero photo. Not "sometimes
// slow"; always cold.
//
// THE TRAP THIS FILE EXISTS TO AVOID, copied deliberately from PlantingDetail.cached.test.jsx:
// useCachedFetch picks its mode from `useAuthOptional().user?.id`. With no AuthProvider that is
// null and the hook degrades to PLAIN — a plain fetch-on-mount that writes NO cache entry. Every
// other Garden test mounts provider-less, so all of them exercise PLAIN while production
// (IMAGE_LIST_CACHE_ENABLED === true) runs CACHED. A page that silently stayed on PLAIN in prod
// would look identical in all of them. Hence the identity mock below supplies `user`, not
// `profile` — Garden.lens.test.jsx's `() => ({ profile: { id: 'me' } })` shape yields sub=null and
// PLAIN, and is the exact trap to not copy.
//
// The warm-cache assertion uses a request that HANGS FOREVER as its discriminator, for the reason
// the PlantingDetail file records: asserting the cache entry still holds what the test just seeded
// into it passes even when the page ignores the cache completely.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const { fetchSpy, getTokenSpy, searchParamsRef, setSearchParamsSpy, identity } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  getTokenSpy: vi.fn(async () => 'tok'),
  searchParamsRef: { current: new URLSearchParams() },
  setSearchParamsSpy: vi.fn(),
  identity: { current: { user: { id: 'sub-A' }, profile: null, loading: false } },
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useLocation: () => ({ pathname: '/garden', search: '', state: null }),
  useNavigate: () => () => {},
  useSearchParams: () => [searchParamsRef.current, setSearchParamsSpy],
}))
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: getTokenSpy }),
  apiFetch: (...a) => fetchSpy(...a),
}))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <span data-testid="fav" /> }))
vi.mock('../components/VarietyPicker.jsx', () => ({
  default: ({ value }) => <span data-testid="vp-value">{value ? value.name : 'EMPTY'}</span>,
}))
// Read through a ref so a test can flip identity between mounts without re-mocking the module.
vi.mock('../context/AuthContext.jsx', () => ({
  useAuthOptional: () => identity.current,
  useAuth: () => identity.current,
}))

import Garden from '../pages/Garden.jsx'
import * as cache from '../lib/dataCache.js'
import { IMAGE_LIST_CACHE_ENABLED } from '../lib/featureFlags.js'

const PLANTS_PATH = '/api/plants?view=grid'
const PROJECTS = [{ id: 'proj-1', name: 'Spring 2026', status: 'active', parent_project_id: null }]
const ROW_A = {
  id: 'plant-2', name: 'Krim Plant', quantity: 3, status: 'seedling',
  project_id: 'proj-1', location_id: null, assignee_user_id: null,
  featured_photo_id: null, featured_photo_view_url: null, featured_photo_thumb_url: null,
  variety_ref: { name: 'Black Krim', crop_type_slug: 'tomato' },
}
const ROW_B = { ...ROW_A, id: 'plant-9', name: 'Sungold Plant', variety_ref: { name: 'Sungold', crop_type_slug: 'tomato' } }

function prime(plants = [ROW_A], { hangPlants = false } = {}) {
  fetchSpy.mockReset()
  fetchSpy.mockImplementation((url, opts = {}) => {
    const u = String(url)
    if (u === '/api/projects') return Promise.resolve(PROJECTS)
    if (u === PLANTS_PATH) return hangPlants ? new Promise(() => {}) : Promise.resolve(plants)
    if (u === '/api/locations') return Promise.resolve([])
    if (opts.method) return Promise.resolve({})
    return Promise.resolve([])
  })
}

async function renderGarden({ awaitChrome = true } = {}) {
  const r = await act(async () => render(<Garden />))
  // A COLD key whose request hangs never leaves the loading state, so the page chrome never
  // arrives — that is correct behaviour and is itself the discriminator in the scoping test below.
  if (awaitChrome) await screen.findByText(/Log many/)
  return r
}
const expandAll = async () => {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Expand all sections/i })) })
}

beforeEach(() => {
  localStorage.clear()
  cache.__resetDataCache()
  identity.current = { user: { id: 'sub-A' }, profile: null, loading: false }
  window.scrollTo = vi.fn()
  setSearchParamsSpy.mockClear()
  searchParamsRef.current = new URLSearchParams()
})

describe('Garden — reaches CACHED mode (not PLAIN)', () => {
  it('the flag under test is actually on, or every assertion below is vacuous', () => {
    expect(IMAGE_LIST_CACHE_ENABLED).toBe(true)
  })

  it('writes a plants cache entry keyed by the CURRENT sub — impossible in PLAIN mode', async () => {
    prime()
    await renderGarden()
    await waitFor(() => {
      expect(cache.peek(cache.keyFor('sub-A', PLANTS_PATH))?.data).toEqual([ROW_A])
    })
  })

  it('a warm cache paints the grid WITHOUT waiting for the network', async () => {
    // Seed the key as a prior visit would, then mount against a plants request that NEVER resolves.
    // That hang is the whole discriminator:
    //   CACHED + warm -> data is already present, `loading` is false on first render, tiles paint.
    //   PLAIN         -> `loading` stays true forever and no tile ever appears.
    cache.warm(cache.keyFor('sub-A', PLANTS_PATH), () => Promise.resolve([ROW_A]))
    await waitFor(() => expect(cache.peek(cache.keyFor('sub-A', PLANTS_PATH))?.data).toEqual([ROW_A]))

    prime([ROW_A], { hangPlants: true })
    await renderGarden()
    await expandAll()
    expect(await screen.findByText('Krim Plant')).toBeDefined()
  })

  it('a DIFFERENT sub never reads the first sub\'s plantings — identity scoping', async () => {
    prime()
    const first = await renderGarden()
    await waitFor(() => expect(cache.peek(cache.keyFor('sub-A', PLANTS_PATH))?.data).toEqual([ROW_A]))
    first.unmount()

    identity.current = { user: { id: 'sub-B' }, profile: null, loading: false }
    prime([ROW_B], { hangPlants: true })
    await renderGarden({ awaitChrome: false })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // PAIRED with the warm-cache test above, and only meaningful as a pair: there, the SAME hanging
    // request still painted because the viewer's OWN key was warm. Here the identical setup paints
    // nothing, because sub-B's key is cold. If the key were not identity-scoped, sub-A's warm entry
    // would satisfy sub-B and "Krim Plant" would appear — a cross-user read of another household's
    // plantings.
    expect(screen.queryByText('Krim Plant')).toBeNull()
    expect(cache.peek(cache.keyFor('sub-A', PLANTS_PATH))?.data).toEqual([ROW_A])
  })
})

describe('V4-GARDENCACHE-001 — the obligations caching creates', () => {
  it('EVERY optimistic mutation closes the cache-sync window', () => {
    // STRUCTURAL, and the honesty note matters: the first version of this test was a runtime one
    // that warmed [A,B], held the revalidate, released it with [A,B] and asserted A was still
    // there. That passes whether or not the guard exists — both rows are present either way. It was
    // a vacuous guard of exactly the kind this repo keeps finding, and it is replaced rather than
    // patched. A truthful runtime version has to drive Garden's archive/delete UI to completion,
    // which is a different test's job; what THIS one owns is the invariant that no optimistic
    // mutation is ever added without the guard.
    //
    // The failure it stands in for: the mount revalidate is still in flight when the user archives
    // a planting. Its response predates the archive, lands on top of the edit, and the row the user
    // just removed reappears. Uncached this could not happen — there was no second writer.
    const SRC = readFileSync(resolve(__dirname, '..', 'pages', 'Garden.jsx'), 'utf8');
    const lines = SRC.split('\n');
    const optimistic = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => /^\s*setPlants\(prev =>/.test(l));
    // Non-vacuity: if the mutations are ever renamed or refactored away, an empty set would make
    // the forEach below pass trivially.
    expect(optimistic.length, 'no optimistic setPlants mutations found — this census has rotted')
      .toBeGreaterThanOrEqual(4);
    for (const { l, i } of optimistic) {
      expect(lines[i - 1], `unguarded optimistic mutation at Garden.jsx:${i + 1} -> ${l.trim()}`)
        .toMatch(/acceptCache\.current = false/);
    }
  });

  it('refetchPlants goes THROUGH the cache, so the next mount cannot paint a pre-mutation list', () => {
    // Source-level, and deliberately so: the failure is a NEXT-MOUNT one, which a single render
    // cannot observe. A bare `fetch(...)` here would refresh local state and leave the cache holding
    // the stale list — uncached that was impossible, so caching is what creates this obligation.
    const SRC = readFileSync(resolve(__dirname, '..', 'pages', 'Garden.jsx'), 'utf8')
    const body = SRC.slice(SRC.indexOf('const refetchPlants'), SRC.indexOf('const onPlantCreated'))
    expect(body).toMatch(/plantsCache\.refetch\(\)/)
    expect(body).toMatch(/acceptCache\.current = true/)
    expect(body).not.toMatch(/await fetch\(/)
  })
})
