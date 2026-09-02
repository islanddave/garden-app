// POI-SEEDDOORMENU-001 — "Seed saved" from the event menu opens the real Save-seed flow.
//
// THE DEFECT WAS TWO DOORS WITH ONE NAME. Dave's instruction was "Planting pages should have a Save
// Seed option button to trigger this flow, as well as the menu item." v4.94.0 shipped the button,
// and QuickActions.jsx was its only renderer — so the create-a-lot flow existed on a planting page
// and nowhere else. Picking "Seed saved" out of the More-event-types disclosure, which is the route
// he originally went looking down and could not find, still did the OLD thing: wrote a bare row on
// the planting's timeline and created no seed lot at all. Same name, same apparent intent, and one
// of the two produced nothing you could ferment, dry, store or sow.
//
// Dave 2026-09-02, choosing "make the menu item open the sheet": "ensure that going from the menu
// rather than the planting also logs the event into the planting's event history. Same behavior in
// every surface." Both halves fall out of opening the REAL component rather than reimplementing it,
// and the second half is asserted here rather than assumed — SaveSeedSheet's own V4-SEEDEVENT-001
// POST is what writes the seed_saved row, so a refactor that dropped it would silently return the
// menu route to being a lot with no timeline entry, which is the mirror image of the original bug.
// No jest-dom (L-182).
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
vi.mock('../context/AuthContext.jsx', () => ({
  useAuthOptional: () => identity.current,
  useAuth: () => identity.current,
}))

import EventNew from '../pages/EventNew.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import * as cache from '../lib/dataCache.js'

// variety_ref is load-bearing rather than decorative: SaveSeedSheet defaults the lot name from it
// AND sends variety_id on the create, which chk_inventory_seed_requires_variety refuses to be null.
const TOMATO = {
  id: 'pl-1', name: 'Brandywine — bed 3', project_id: 'proj-1', project_name: 'Tomatoes',
  variety_ref: { id: 'var-brandy', name: 'Brandywine' },
}

function prime() {
  fetchSpy.mockReset()
  fetchSpy.mockImplementation((url, opts = {}) => {
    const u = String(url)
    if (opts.method === 'POST' && u === '/api/inventory-items') return Promise.resolve({ id: 'lot-1' })
    if (opts.method === 'POST') return Promise.resolve({ id: 'evt-1' })
    if (u === '/api/projects') return Promise.resolve([{ id: 'proj-1', name: 'Tomatoes', status: 'growing' }])
    if (u === '/api/locations/with-path') return Promise.resolve([])
    if (u.startsWith('/api/plants')) return Promise.resolve([TOMATO])
    return Promise.resolve(null)
  })
}

// Arrive the way a deep link from the menu does: the type already chosen, the planting already
// named. That is exactly the state the disclosure produces once a plant is picked, and it keeps the
// test on the behaviour under change rather than on the chooser's own interaction model.
async function renderLog(qs) {
  searchParamsRef.current = new URLSearchParams(qs)
  const out = await act(async () => render(<ToastProvider><EventNew /></ToastProvider>))
  await act(async () => { await Promise.resolve() })
  return out
}

const posts = (path) => fetchSpy.mock.calls
  .filter(([p, o]) => o?.method === 'POST' && String(p) === path)

beforeEach(() => {
  try { localStorage.clear() } catch { /* noop */ }
  cache.__resetDataCache()
  identity.current = { user: { id: 'sub-A' }, profile: null, loading: false }
  navigateSpy.mockReset()
  searchParamsRef.current = new URLSearchParams()
})

describe('POI-SEEDDOORMENU-001 — the menu route opens the create-a-lot sheet', () => {
  it('opens the Save seed sheet, not the plain event form', async () => {
    prime()
    await renderLog('event_type=seed_saved&plant=pl-1&project=proj-1')
    await waitFor(() => expect(screen.getByTestId('save-seed-submit')).toBeTruthy())
    // The sheet's own fields, proving it is the real component rather than a lookalike.
    expect(screen.getByTestId('save-seed-name')).toBeTruthy()
    expect(screen.getByTestId('save-seed-count')).toBeTruthy()
  })

  it('takes the parent plant as a PARAMETER — no second picker', async () => {
    // The structural advantage of the planting-page door, preserved through the menu one. If this
    // route had to ask which plant, it would be asking a question the URL already answered.
    prime()
    await renderLog('event_type=seed_saved&plant=pl-1&project=proj-1')
    await waitFor(() => expect(screen.getByTestId('save-seed-submit')).toBeTruthy())
    expect(screen.getByTestId('save-seed-name').value).toMatch(/Brandywine/)
    expect(screen.queryByTestId('save-seed-variety-picker'), 'asked for a variety it was handed').toBeNull()
  })

  it('SAME BEHAVIOUR IN EVERY SURFACE: it still writes the timeline event', async () => {
    // Dave's explicit constraint on this change. The old menu route's ONLY output was this row, so
    // a version of the fix that created a lot and dropped the event would be a regression dressed
    // as a feature.
    prime()
    await renderLog('event_type=seed_saved&plant=pl-1&project=proj-1')
    await waitFor(() => expect(screen.getByTestId('save-seed-submit')).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByTestId('save-seed-submit')) })

    await waitFor(() => expect(posts('/api/events')).toHaveLength(1))
    const ev = JSON.parse(posts('/api/events')[0][1].body)
    expect(ev.event_type).toBe('seed_saved')
    expect(ev.plant_id).toBe('pl-1')
    // And the lot itself — the half the old route never produced.
    expect(posts('/api/inventory-items')).toHaveLength(1)
    const lot = JSON.parse(posts('/api/inventory-items')[0][1].body)
    expect(lot.category).toBe('seeds')
    expect(lot.source_plant_id).toBe('pl-1')
    expect(lot.variety_id).toBe('var-brandy')
  })

  it('does NOT hijack any other event type', async () => {
    // The interception is keyed on one value. A watering must reach the ordinary form.
    prime()
    await renderLog('event_type=watering&plant=pl-1&project=proj-1')
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByTestId('save-seed-submit')).toBeNull()
  })

  it('falls through to the ordinary form until a planting is known', async () => {
    // seed_saved is in PLANTING_REQUIRED_TYPES, so the form asks for one anyway. Opening the sheet
    // without a parent would throw away the one thing that makes it good and ask twice instead.
    prime()
    await renderLog('event_type=seed_saved')
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByTestId('save-seed-submit')).toBeNull()
  })
})
