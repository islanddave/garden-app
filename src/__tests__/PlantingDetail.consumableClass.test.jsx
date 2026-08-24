// V4-CONSUMABLECLASS-001 (BD-042) — the Harvested and Put-up sections are for plants grown to be
// EATEN, not plants grown to be LOOKED AT.
//
// Both sections rendered unconditionally by explicit design: "nothing yet" on a planting you are
// looking at is itself the answer. That reasoning is sound for a tomato and wrong for a pothos, and
// the Put-up empty state went further than saying nothing — it offered a live "Log a put-up from
// this planting" affordance on 49 live not-harvest-tracked plantings.
//
// No new column: `crop_types` already carries the axis and `plantingIsHarvestTracked` already gates
// the harvest projection off it. The helper's default is load-bearing and pinned below — an unknown
// or missing slug reads as TRACKED, so the only thing this gate can do is drop the sections from a
// plant somebody positively listed as not-harvested. It can never withhold harvest information from
// a food crop because a slug was missing.
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

// `pothos` and `geranium` are real entries in harvest-attributes-v1.json not_harvest_tracked.slugs;
// `pepper` and `tomato` are real food crops. Using real slugs rather than invented ones is
// deliberate — a fixture with a made-up slug would pass through the unknown-slug default and prove
// nothing about the list.
function planting(crop_type_slug, name = 'Subject') {
  return {
    id: 'pl1', name, project_id: 'proj1', project_name: 'Proj', status: 'growing', quantity: 1,
    variety_ref: crop_type_slug === undefined ? undefined : { name: 'V', crop_type_slug },
    featured_photo_view_url: null,
  }
}

function renderWith(pl) {
  apiFetchSpy.mockImplementation((path) => {
    if (path.startsWith('/api/plants/')) return Promise.resolve(pl)
    if (path.startsWith('/api/harvests')) return Promise.resolve({ entries: [] })
    // MUST be stubbed. Left to the null fallthrough, PutUpFromPlanting renders its EMPTY state via
    // `data?.groups ?? []` and happens to reach the same place — but the ungated-mutation run proved
    // the affordance assertion below was vacuous without an explicit, settled empty payload here.
    if (path.startsWith('/api/preservation/whats-put-up')) return Promise.resolve({ groups: [] })
    if (path.startsWith('/api/events/harvest-summary')) return Promise.resolve({ rows: [], unattributed: [] })
    if (path.startsWith('/api/events')) return Promise.resolve([])
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

const putUpFetched = () =>
  apiFetchSpy.mock.calls.some(c => String(c[0]).startsWith('/api/preservation/whats-put-up'))

beforeEach(() => { apiFetchSpy.mockReset(); window.scrollTo = vi.fn() })

describe('PlantingDetail — harvest sections are gated on the eaten/looked-at axis', () => {
  it('shows Harvested, Put up, AND the log-a-put-up affordance on a food crop', async () => {
    // The positive half. Without this, the two absence assertions below could both pass because the
    // affordance never renders in this harness at all — which is exactly what the first mutation run
    // caught before the whats-put-up stub was added.
    renderWith(planting('pepper', 'Megatron Jalapeno'))
    expect(await screen.findByText('Harvested')).toBeTruthy()
    expect(screen.getByText('Put up')).toBeTruthy()
    expect(await screen.findByText(/log a put-up from this planting/i)).toBeTruthy()
    expect(putUpFetched()).toBe(true)
  })

  it('hides BOTH on an ornamental', async () => {
    renderWith(planting('pothos', 'Golden Pothos'))
    // Wait on something that renders either way, so absence is asserted on a settled page rather
    // than on a page that simply has not finished loading yet.
    expect((await screen.findAllByText('Golden Pothos')).length).toBeGreaterThan(0)
    expect(screen.queryByText('Harvested')).toBeNull()
    expect(screen.queryByText('Put up')).toBeNull()
  })

  it('hides the "log a put-up from this planting" affordance on an ornamental', async () => {
    // The sharper half of the complaint: Harvested merely said nothing, Put up ASKED.
    renderWith(planting('geranium', 'Scented Geranium'))
    expect((await screen.findAllByText('Scented Geranium')).length).toBeGreaterThan(0)
    // Assert on the FETCH, not on the rendered text. A queryByText here runs before PutUpFromPlanting's
    // effect resolves, so it returns null whether or not the section is mounted — the ungated mutation
    // proved that version of this test could not fail. The section's effect fires on mount, so an
    // absent whats-put-up call is positive evidence the section was never rendered at all.
    expect(putUpFetched()).toBe(false)
    await waitFor(() => expect(screen.queryByText(/log a put-up from this planting/i)).toBeNull())
  })

  it('DEFAULTS TO SHOWN when the crop type is unknown', async () => {
    // A newly minted crop type, an older bundle, a cultivar whose slug has not been set. The gate
    // must fail toward showing harvest information, never toward hiding it from a food crop.
    renderWith(planting('crop-type-that-does-not-exist', 'Mystery Plant'))
    expect(await screen.findByText('Harvested')).toBeTruthy()
    expect(screen.getByText('Put up')).toBeTruthy()
  })

  it('DEFAULTS TO SHOWN when the planting has no variety_ref at all', async () => {
    renderWith(planting(undefined, 'Bare Record'))
    expect(await screen.findByText('Harvested')).toBeTruthy()
    expect(screen.getByText('Put up')).toBeTruthy()
  })
})
