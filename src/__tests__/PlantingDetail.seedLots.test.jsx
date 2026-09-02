// V4-SEEDREVERSE-001 — "Seed saved from this plant" on planting detail.
//
// The reverse of inventory_items.source_plant_id. V4-SEEDLINK-001 shipped the column and the index
// for THIS direction and nothing read it, so a user who saved seed from a planting had no way to
// ask the planting whether they already had. These tests pin the three states that matter and, in
// particular, that the two ABSENT-looking ones are not the same state:
//   * lots exist        -> heading + a link per lot to /inventory/<id>
//   * no lots           -> NO heading at all (an empty card on every planting is the thing this
//                          section is deliberately not)
//   * request FAILED    -> heading + an explicit "couldn't check", never silence and never a
//                          reading that says no seed was saved
//
// Every absence assertion below is paired with positive evidence the fetch actually happened, so a
// section that never mounted cannot pass as a section that mounted and found nothing.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const { apiFetchSpy } = vi.hoisted(() => ({ apiFetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn() }) }))
vi.mock('../lib/uxEvents.js', () => ({
  FLOWS: { OPEN_PLANTING: 'open_planting' },
  useUxFlow: () => ({ step: vi.fn(), tap: vi.fn(), complete: vi.fn(), reset: vi.fn() }),
}))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => null }))
vi.mock('../lib/harvestWindows.js', () => import('./helpers/harvestWindowsSyncStub.js'))

import PlantingDetail from '../pages/PlantingDetail.jsx'

const PLANTING = {
  id: 'pl1', name: 'Cinderella #2', project_id: 'proj1', project_name: 'Pumpkins',
  status: 'growing', quantity: 1,
  variety_ref: { name: 'Cinderella', crop_type_slug: 'pumpkin' },
  featured_photo_view_url: null,
}

const SEED_LOTS_PATH = '/api/plants/pl1/seed-lots'

// `seedLots` is either a rows array (resolved) or the string 'reject'.
function renderWith(seedLots) {
  apiFetchSpy.mockImplementation((path) => {
    // Checked BEFORE the generic /api/plants/ branch — the sub-route shares that prefix, and the
    // by-id stub would otherwise answer it with the planting record.
    if (String(path) === SEED_LOTS_PATH) {
      return seedLots === 'reject'
        ? Promise.reject(new Error('boom'))
        : Promise.resolve({ plant_id: 'pl1', seed_lots: seedLots })
    }
    if (String(path).startsWith('/api/plants/')) return Promise.resolve(PLANTING)
    if (String(path).startsWith('/api/harvests')) return Promise.resolve({ entries: [] })
    if (String(path).startsWith('/api/preservation/whats-put-up')) return Promise.resolve({ groups: [] })
    if (String(path).startsWith('/api/events/harvest-summary')) return Promise.resolve({ rows: [], unattributed: [] })
    if (String(path).startsWith('/api/events')) return Promise.resolve([])
    return Promise.resolve(null)
  })
  return render(
    <MemoryRouter initialEntries={['/projects/proj1/plantings/pl1']}>
      <Routes>
        <Route path="/projects/:id/plantings/:plantingId" element={<PlantingDetail />} />
      </Routes>
    </MemoryRouter>,
  )
}

const seedLotsFetched = () => apiFetchSpy.mock.calls.some(c => String(c[0]) === SEED_LOTS_PATH)

const HEADING = 'Seed saved from this plant'

beforeEach(() => { apiFetchSpy.mockReset(); window.scrollTo = vi.fn() })

describe('PlantingDetail — Seed saved from this plant (V4-SEEDREVERSE-001)', () => {
  it('lists each lot and links it to its inventory item', async () => {
    renderWith([
      { id: 'lot-a', name: 'Cinderella seed 2026', seed_stage: 'drying', quantity_on_hand: 40, variety_name: 'Cinderella', created_at: '2026-09-01' },
      { id: 'lot-b', name: 'Cinderella seed 2025', seed_stage: 'stored', quantity_on_hand: 12, variety_name: 'Cinderella', created_at: '2025-09-01' },
    ])
    expect(await screen.findByText(HEADING)).toBeTruthy()
    const first = screen.getByText('Cinderella seed 2026')
    // The link is the point of the section: the whole reason to render a lot here is to get to it.
    expect(first.closest('a').getAttribute('href')).toBe('/inventory/lot-a')
    expect(screen.getByText('Cinderella seed 2025').closest('a').getAttribute('href')).toBe('/inventory/lot-b')
    // Stage and count ride the same meta line.
    expect(screen.getByText(/Drying/)).toBeTruthy()
    expect(screen.getByText(/40 on hand/)).toBeTruthy()
  })

  it('renders NO section at all when the planting has no seed lots', async () => {
    renderWith([])
    // Settle on something that renders either way, so absence is asserted on a loaded page.
    expect((await screen.findAllByText('Cinderella #2')).length).toBeGreaterThan(0)
    // Positive evidence the read happened: without this, a section that never mounted would pass
    // this test exactly as a section that mounted and found nothing does.
    await waitFor(() => expect(seedLotsFetched()).toBe(true))
    expect(screen.queryByText(HEADING)).toBeNull()
  })

  it('a FAILED request says so — it never reads as "no seed saved"', async () => {
    renderWith('reject')
    // The heading IS rendered on the error branch. Silence here would be indistinguishable from the
    // empty case above, which is the misleading claim this arm exists to prevent.
    expect(await screen.findByText(HEADING)).toBeTruthy()
    expect(screen.getByText(/Couldn’t check for seed saved from this planting/)).toBeTruthy()
    expect(screen.getByText(/not the same as/)).toBeTruthy()
  })

  it('suppresses the variety line when it only repeats the lot name, and keeps it when it adds something', async () => {
    renderWith([
      { id: 'lot-same', name: 'Cinderella', seed_stage: 'stored', quantity_on_hand: 5, variety_name: 'Cinderella', created_at: '2026-09-01' },
      { id: 'lot-diff', name: 'Jar on the shelf', seed_stage: 'stored', quantity_on_hand: 5, variety_name: 'Cinderella', created_at: '2026-08-01' },
    ])
    expect(await screen.findByText(HEADING)).toBeTruthy()
    // The stutter row's meta line carries stage + count only.
    expect(screen.getByText('Stored · 5 on hand')).toBeTruthy()
    // The informative row keeps the variety.
    expect(screen.getByText('Cinderella · Stored · 5 on hand')).toBeTruthy()
  })

  it('distinguishes a counted zero from a lot that was never counted', async () => {
    // quantity_on_hand is NULLABLE and NULL means "never counted", not "none left" — the same
    // reading sowEngine's isDepleted takes of it. Printing 0 for a null would invent a measurement.
    renderWith([
      { id: 'lot-zero', name: 'Used up lot', seed_stage: 'stored', quantity_on_hand: 0, variety_name: null, created_at: '2026-09-01' },
      { id: 'lot-null', name: 'Uncounted lot', seed_stage: 'stored', quantity_on_hand: null, variety_name: null, created_at: '2026-08-01' },
    ])
    expect(await screen.findByText(HEADING)).toBeTruthy()
    expect(screen.getByText('Stored · 0 on hand')).toBeTruthy()
    expect(screen.getByText('Stored')).toBeTruthy()
    expect(screen.queryByText(/null on hand/)).toBeNull()
  })
})
