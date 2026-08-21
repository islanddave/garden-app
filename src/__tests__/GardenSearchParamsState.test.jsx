// V4-OVERLAY-001 Slice 2 (§4) — Garden's mount-time param-strip (?add=1) must PRESERVE the location
// state when it rewrites the URL. The bug class: setSearchParams defaults navigate state to null, so a
// carried `background` (or any state) is silently dropped on mount.
//
// OPS-GARDENROUTERMOCK-001 — this used to mock `react-router-dom` and assert on the ARGUMENTS of a
// `setSearchParams` spy: that the call carried `{ replace: true, state: {...} }`. That proves the
// page asked for the right thing, not that the router kept it — the two diverge precisely when the
// strip is wired wrong, which is the failure being guarded. It now runs on a real MemoryRouter and
// reads the location the router actually holds AFTER the rewrite.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { waitFor } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'
import { renderWithRouter, currentLocation, currentSearch, navigateTo, resetRouterHarness } from './helpers/routerHarness.jsx'

installStoragePolyfill()

const BACKGROUND = { pathname: '/today', search: '' }
const { fetchSpy, getTokenSpy } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  getTokenSpy: vi.fn(async () => 'tok'),
}))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy, getToken: getTokenSpy }),
  apiFetch: (...a) => fetchSpy(...a),
}))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <span data-testid="fav" /> }))
vi.mock('../components/VarietyPicker.jsx', () => ({ default: () => <div data-testid="variety-picker" /> }))

import Garden from '../pages/Garden.jsx'

beforeEach(() => {
  fetchSpy.mockReset()
  resetRouterHarness()
  fetchSpy.mockImplementation((url) => {
    if (url === '/api/projects') return Promise.resolve([{ id: 'proj-1', name: 'Spring', status: 'active', parent_project_id: null }])
    if (url === '/api/plants?view=grid') return Promise.resolve([])
    return Promise.resolve([])
  })
})

const renderGardenWithBackground = () =>
  renderWithRouter(<Garden />, { route: '/garden?add=1', state: { background: BACKGROUND } })

describe('Garden — ?add=1 strip preserves location.state (§4)', () => {
  it('carries the background through the strip onto the rewritten history entry', async () => {
    await renderGardenWithBackground()
    // The strip has to have actually happened, or "state survived" is trivially true of the entry
    // we arrived on and this asserts nothing.
    await waitFor(() => expect(currentSearch()).not.toContain('add'))
    expect(currentLocation().state).toEqual({ background: BACKGROUND })
  })

  it('replaces rather than pushes, so Back does not land on the pre-strip URL', async () => {
    // The other half of the same `setSearchParams(next, { replace: true, … })` call, asserted as
    // the gesture rather than as an options object. Dave is Android-only and hardware Back is his
    // primary gesture: a PUSHED strip leaves ?add=1 one entry down, so Back re-enters it and
    // silently reopens the editor he just left.
    await renderGardenWithBackground()
    await waitFor(() => expect(currentSearch()).not.toContain('add'))
    await navigateTo(-1)
    expect(currentSearch()).not.toContain('add')
  })
})
