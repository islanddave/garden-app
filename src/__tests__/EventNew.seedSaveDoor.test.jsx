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

// SEED_MULTI_PARENT is held ON here whichever way the literal ships. These are the flag-on cases, and the
// release's forward undo is a build with the literal false (scripts/forward-undo.py), which must not
// redden them: `npm run test:flag-off:seed` is that rehearsal. featureFlags.test.js pins the literal.
vi.mock('../lib/featureFlags.js', async (importOriginal) => ({
  ...(await importOriginal()),
  get SEED_MULTI_PARENT() { return true },
  // V5-SEEDLOTADDITION-001 — held on beside it, for the same reason: the last describe is its door.
  get SEED_ADD_TO_LOT() { return true },
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
import { blendReply, openLotsReply, openLotRow, additionReply } from './fixtures/seedMix.fixture.js'

// variety_ref is load-bearing rather than decorative: SaveSeedSheet defaults the lot name from it
// AND sends variety_id on the create, which chk_inventory_seed_requires_variety refuses to be null.
const TOMATO = {
  id: 'pl-1', name: 'Brandywine — bed 3', project_id: 'proj-1', project_name: 'Tomatoes',
  variety_ref: { id: 'var-brandy', name: 'Brandywine' },
}

// V5-SEEDMULTIPARENT-001 — a garden with more in it, in the picker's own row shape (the log menu
// hands the sheet one of these rows). Two more tomatoes, one of them another variety, and a pepper.
const TOMATO_VARIETY = { id: 'var-brandy', name: 'Brandywine', crop_type_slug: 'tomato', breeding_system: 'open_pollinated', variety_rank: 'cultivar' }
const BED_3 = { ...TOMATO, quantity: 1, variety_id: 'var-brandy', variety_ref: TOMATO_VARIETY }
const BED_5 = { id: 'pl-2', name: 'Brandywine — bed 5', project_id: 'proj-1', project_name: 'Tomatoes', quantity: 2, variety_id: 'var-brandy', variety_ref: TOMATO_VARIETY }
const BED_4 = {
  id: 'pl-3', name: 'Cherokee Purple — bed 4', project_id: 'proj-1', project_name: 'Tomatoes', quantity: 1, variety_id: 'var-cherokee',
  variety_ref: { id: 'var-cherokee', name: 'Cherokee Purple', crop_type_slug: 'tomato', breeding_system: 'open_pollinated', variety_rank: 'cultivar' },
}
const PEPPER = {
  id: 'pl-4', name: 'Carmen — bed 1', project_id: 'proj-1', project_name: 'Tomatoes', quantity: 3, variety_id: 'var-carmen',
  variety_ref: { id: 'var-carmen', name: 'Carmen', crop_type_slug: 'pepper', breeding_system: 'f1', variety_rank: 'cultivar' },
}

function prime(plants = [TOMATO]) {
  fetchSpy.mockReset()
  fetchSpy.mockImplementation((url, opts = {}) => {
    const u = String(url)
    if (opts.method === 'POST' && u === '/api/varieties/blend') {
      // The contract's reply with every key the route returns: this is the one test that drives the
      // real picker end to end, so its mix reply is not a hand-written three-key one.
      return Promise.resolve(blendReply({ id: 'var-mix', name: 'Brandywine + Cherokee Purple mix' }))
    }
    if (opts.method === 'POST' && u === '/api/inventory-items') return Promise.resolve({ id: 'lot-1' })
    if (opts.method === 'POST') return Promise.resolve({ id: 'evt-1' })
    if (u === '/api/projects') return Promise.resolve([{ id: 'proj-1', name: 'Tomatoes', status: 'growing' }])
    if (u === '/api/locations/with-path') return Promise.resolve([])
    if (u.startsWith('/api/plants')) return Promise.resolve(plants)
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
    expect(lot.source_plant_ids).toEqual(['pl-1'])
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

// ── V5-SEEDMULTIPARENT-001 — the menu door, with the REAL picker behind the adder ─────────────────
// The sheet's own suites stub PlantingSelect and read the props it is handed. This is the one place
// the real one is mounted under the real sheet, so "only this crop's other plantings are offered" is
// read off the list a user would actually see, fetched the way the app fetches it.
describe('V5-SEEDMULTIPARENT-001 — the menu door can add a second planting to the jar', () => {
  const open = async () => {
    prime([BED_3, BED_5, BED_4, PEPPER])
    await renderLog('event_type=seed_saved&plant=pl-1&project=proj-1')
    await waitFor(() => expect(screen.getByTestId('save-seed-submit')).toBeTruthy())
  }
  const fromRows = () => screen.getAllByTestId('save-seed-from-row').map((li) => li.querySelector('span').textContent)
  const offered = () => [...document.querySelectorAll('[data-testid^="ps-opt-"]')].map((o) => o.getAttribute('data-testid'))
  const openAdder = async () => {
    await act(async () => { fireEvent.click(screen.getByTestId('save-seed-add-plant')) })
    // The tap is the gesture: the list opens with it, and fills when the planting read answers.
    await waitFor(() => expect(offered().length).toBeGreaterThan(0))
  }

  it('the planting it was opened for is the first row, and that row cannot be removed', async () => {
    await open()
    expect(fromRows()).toEqual(['Brandywine — bed 3'])
    expect(screen.queryAllByTestId('save-seed-from-remove')).toHaveLength(0)
    expect(screen.queryByText('Which plant?'), 'asked which plant after being handed one').toBeNull()
  })

  it('the adder offers the same crop’s OTHER plantings: not the one chosen, not another crop', async () => {
    await open()
    await openAdder()
    // pl-1 is already on the jar; pl-4 is a pepper.
    expect(offered()).toEqual(['ps-opt-pl-2', 'ps-opt-pl-3'])
    expect(screen.getByTestId('ps-footer-note').textContent)
      .toBe('A plant with no variety recorded is not listed here. Give it a variety first.')
  })

  it('says so when the crop has no other planting to add', async () => {
    prime([BED_3, PEPPER])
    await renderLog('event_type=seed_saved&plant=pl-1&project=proj-1')
    await waitFor(() => expect(screen.getByTestId('save-seed-submit')).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByTestId('save-seed-add-plant')) })
    await waitFor(() => expect(screen.getByText('No other tomato plantings to add.')).toBeTruthy())
    expect(offered()).toEqual([])
  })

  it('a second variety from that list makes the jar a mix, saved with both plantings and an event on each', async () => {
    await open()
    await openAdder()
    await act(async () => { fireEvent.click(screen.getByTestId('ps-opt-pl-3')) })
    expect(fromRows()).toEqual(['Brandywine — bed 3', 'Cherokee Purple — bed 4'])
    expect(screen.getByRole('button', { name: 'Remove Cherokee Purple — bed 4' })).toBeTruthy()
    expect(screen.getAllByTestId('save-seed-from-remove')).toHaveLength(1)
    expect(screen.getByTestId('save-seed-variety-name').textContent).toBe('Brandywine + Cherokee Purple mix')
    expect(screen.getByTestId('save-seed-mix-reason')).toBeTruthy()
    // The next list leaves out both.
    await openAdder()
    expect(offered()).toEqual(['ps-opt-pl-2'])

    await act(async () => { fireEvent.click(screen.getByTestId('save-seed-submit')) })
    await waitFor(() => expect(posts('/api/events')).toHaveLength(2))
    expect(JSON.parse(posts('/api/varieties/blend')[0][1].body))
      .toEqual({ component_variety_ids: ['var-brandy', 'var-cherokee'], create: true })
    const lot = JSON.parse(posts('/api/inventory-items')[0][1].body)
    expect(lot.variety_id).toBe('var-mix')
    expect(lot.source_plant_id).toBe('pl-1')
    expect(lot.source_plant_ids).toEqual(['pl-1', 'pl-3'])
    expect(posts('/api/events').map(([, o]) => JSON.parse(o.body).plant_id)).toEqual(['pl-1', 'pl-3'])
  })
})

// V5-SEEDLOTADDITION-001 (seed release 3) — "Put it in a seed lot I already started", from the log menu.
// This door has no list of the plant's lots to hand the sheet, so the link is the general one and the
// lots are read on the tap. And it ends differently from a new lot: there is no new lot to route to, so
// it goes to the PLANTING's page, where the lot's row and the new timeline entry both are.
describe('V5-SEEDLOTADDITION-001 — adding to a lot already started, from the menu door', () => {
  const ROW = openLotRow({ name: 'Brandywine — saved 2026', is_member: true, same_variety: true })
  function primeWithLots() {
    prime([BED_3])
    const base = fetchSpy.getMockImplementation()
    fetchSpy.mockImplementation((url, opts = {}) => {
      const u = String(url)
      if (u.startsWith('/api/inventory-items/seed-lots-open')) {
        return Promise.resolve(openLotsReply({ plant_id: 'pl-1', crop_slug: 'tomato', open_lots: [ROW] }))
      }
      if (opts.method === 'POST' && u === `/api/inventory-items/${ROW.id}/seed-additions`) {
        return Promise.resolve(additionReply({ name: ROW.name }))
      }
      return base(url, opts)
    })
  }
  const openLotsReads = () => fetchSpy.mock.calls.filter(([p]) => String(p).startsWith('/api/inventory-items/seed-lots-open'))

  it('shows the general link only, and reads the lots on the tap, not before', async () => {
    primeWithLots()
    await renderLog('event_type=seed_saved&plant=pl-1&project=proj-1')
    await waitFor(() => expect(screen.getByTestId('save-seed-put-in-lot')).toBeTruthy())
    expect(screen.getByTestId('save-seed-put-in-lot').textContent).toBe('Put it in a seed lot I already started')
    expect(openLotsReads()).toHaveLength(0)
    await act(async () => { fireEvent.click(screen.getByTestId('save-seed-put-in-lot')) })
    await waitFor(() => expect(screen.getByTestId('seed-lot-row')).toBeTruthy())
    expect(openLotsReads()).toHaveLength(1)
    expect(String(openLotsReads()[0][0])).toBe('/api/inventory-items/seed-lots-open?plant_id=pl-1')
  })

  it('after a successful add it goes to that planting\'s page, and does not fall back to the type chooser', async () => {
    primeWithLots()
    await renderLog('event_type=seed_saved&plant=pl-1&project=proj-1')
    await waitFor(() => expect(screen.getByTestId('save-seed-put-in-lot')).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByTestId('save-seed-put-in-lot')) })
    await waitFor(() => expect(screen.getByTestId('seed-lot-row')).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByTestId('seed-lot-row')) })
    await act(async () => { fireEvent.click(screen.getByTestId('save-seed-submit')) })

    await waitFor(() => expect(navigateSpy).toHaveBeenCalledTimes(1))
    expect(navigateSpy.mock.calls[0][0]).toBe('/plantings/pl-1')
    // One timeline entry, the addition's own; and no lot was created.
    expect(posts('/api/events')).toHaveLength(1)
    const ev = JSON.parse(posts('/api/events')[0][1].body)
    expect(ev.plant_id).toBe('pl-1')
    expect(ev.metadata.addition).toBe(true)
    expect(ev.notes).toBe(`Added seed to "${ROW.name}".`)
    expect(posts('/api/inventory-items')).toHaveLength(0)
    // The type was not cleared: the sheet is still this page's until the route changes under it.
    expect(screen.getByTestId('seed-add-form')).toBeTruthy()
  })

  it('closing the list without adding still clears the type, as closing the sheet always has', async () => {
    primeWithLots()
    await renderLog('event_type=seed_saved&plant=pl-1&project=proj-1')
    await waitFor(() => expect(screen.getByTestId('save-seed-put-in-lot')).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByTestId('save-seed-put-in-lot')) })
    await waitFor(() => expect(screen.getByTestId('seed-lot-row')).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Close' })) })
    await waitFor(() => expect(screen.queryByTestId('seed-lot-list-heading')).toBeNull())
    expect(screen.queryByTestId('save-seed-submit')).toBeNull()
    expect(navigateSpy).not.toHaveBeenCalled()
  })
})
