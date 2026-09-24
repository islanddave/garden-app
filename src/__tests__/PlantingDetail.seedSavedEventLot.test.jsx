// V5-SEEDSTAB-001 slice 2 — on the planting's Event log, a `seed_saved` event is a door to the lot it made.
//
// SaveSeedSheet writes the lot's id into the event's metadata.seed_lot_id. The planting page already
// reads the lots saved from this planting (GET /api/plants/:id/seed-lots, live rows only), and the event
// resolves its lot against that list. Pinned:
//   · a lot fermenting or drying opens Seeds › Saved seeds ON that lot (the seeds URL module's spelling);
//   · any other lot opens its own page;
//   · a lot that is gone (soft-deleted, or no longer this planting's) leaves its event exactly as it was
//     — no link, the row untouched — with positive evidence the lot list WAS read, so "no link" cannot
//     pass as "never looked";
//   · the row itself still opens the event, and the lot link is its sibling, never nested inside it.
//
// No jest-dom (L-182).
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
import { seedsHref } from '../lib/seedsRoutes.js'

const PLANTING = {
  id: 'pl1', name: 'Cinderella #2', project_id: 'proj1', project_name: 'Pumpkins',
  status: 'growing', quantity: 1,
  variety_ref: { name: 'Cinderella', crop_type_slug: 'pumpkin' },
  featured_photo_view_url: null,
}
const SEED_LOTS_PATH = '/api/plants/pl1/seed-lots'
const LOTS = [
  { id: 'lot-a', name: 'Cinderella seed 2026', seed_stage: 'drying', quantity_on_hand: 1, variety_name: 'Cinderella', created_at: '2026-09-01' },
  { id: 'lot-b', name: 'Cinderella seed 2025', seed_stage: 'stored', quantity_on_hand: 1, variety_name: 'Cinderella', created_at: '2025-09-01' },
  { id: 'lot-c', name: 'Cinderella seed, not started', seed_stage: null, quantity_on_hand: 1, variety_name: 'Cinderella', created_at: '2026-09-10' },
]
const saved = (id, lotId, date) => ({
  id, event_type: 'seed_saved', event_date: date, plant_id: 'pl1', project_id: 'proj1',
  title: null, notes: `Saved seed lot ${id}`, metadata: { seed_lot_id: lotId },
})
const EVENTS = [
  saved('ev-dry', 'lot-a', '2026-09-12'),
  saved('ev-stored', 'lot-b', '2026-09-11'),
  saved('ev-unstarted', 'lot-c', '2026-09-10'),
  saved('ev-gone', 'lot-deleted', '2026-09-09'),
  { id: 'ev-water', event_type: 'watering', event_date: '2026-09-08', plant_id: 'pl1', project_id: 'proj1', title: null, notes: null, metadata: null },
]

function renderWith(lots = LOTS) {
  apiFetchSpy.mockImplementation((path) => {
    const p = String(path)
    // Checked BEFORE the generic /api/plants/ branch, which would answer it with the planting record.
    if (p === SEED_LOTS_PATH) return Promise.resolve({ plant_id: 'pl1', seed_lots: lots })
    if (p.startsWith('/api/plants/')) return Promise.resolve(PLANTING)
    if (p.startsWith('/api/harvests')) return Promise.resolve({ entries: [] })
    if (p.startsWith('/api/preservation/whats-put-up')) return Promise.resolve({ groups: [] })
    if (p.startsWith('/api/events/harvest-summary')) return Promise.resolve({ rows: [], unattributed: [] })
    if (p.startsWith('/api/events')) return Promise.resolve(EVENTS)
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

const rowLink = (evId) => document.querySelector(`a[href="/events/${evId}"]`)
// The lot link belonging to an event row is the element right after that row — never a later row's.
const lotLinkBeside = (evId) => {
  const next = rowLink(evId)?.nextElementSibling
  return next?.getAttribute('data-testid') === 'event-seed-lot-link' ? next : null
}

beforeEach(() => { apiFetchSpy.mockReset(); window.scrollTo = vi.fn() })

describe('PlantingDetail Event log — a seed_saved event opens its lot (V5-SEEDSTAB-001 slice 2)', () => {
  it('a lot drying opens Seeds › Saved seeds on that lot; a stored or not-started lot opens its own page', async () => {
    renderWith()
    await waitFor(() => expect(screen.getAllByTestId('event-seed-lot-link').length).toBe(3))
    expect(lotLinkBeside('ev-dry').getAttribute('href')).toBe(seedsHref('saved', { lot: 'lot-a' }))
    expect(lotLinkBeside('ev-dry').getAttribute('href')).toBe('/seeds?view=saved&lot=lot-a')
    expect(lotLinkBeside('ev-stored').getAttribute('href')).toBe('/inventory/lot-b')
    expect(lotLinkBeside('ev-unstarted').getAttribute('href')).toBe('/inventory/lot-c')
  })

  it('the row still opens the event, and the lot link is its SIBLING, never inside it', async () => {
    renderWith()
    await waitFor(() => expect(lotLinkBeside('ev-dry')).toBeTruthy())
    expect(rowLink('ev-dry').querySelector('a')).toBeNull()
    expect(rowLink('ev-dry').contains(lotLinkBeside('ev-dry'))).toBe(false)
    expect(lotLinkBeside('ev-dry').textContent).toBe('Open the seed lot →')
  })

  // The door is a full 44px box, not a line of text under the row (QA T01: dropping the floor left
  // every test in this file green, and no layout gate renders PlantingDetail).
  it('every lot link sits on the 44px tap floor', async () => {
    renderWith()
    await waitFor(() => expect(screen.getAllByTestId('event-seed-lot-link').length).toBe(3))
    for (const a of screen.getAllByTestId('event-seed-lot-link')) expect(a.style.minHeight).toBe('44px')
  })

  it('an event whose lot is gone renders exactly as before: no link, the row where it always was', async () => {
    renderWith()
    await waitFor(() => expect(screen.getAllByTestId('event-seed-lot-link').length).toBe(3))
    // Positive evidence the lot list was read — "no link" is an answer, not a lookup that never ran.
    expect(apiFetchSpy.mock.calls.some(([p]) => String(p) === SEED_LOTS_PATH)).toBe(true)
    expect(rowLink('ev-gone')).toBeTruthy()
    expect(lotLinkBeside('ev-gone')).toBeNull()
    // Unwrapped: the row sits directly in the log's list, as the watering row beside it does.
    expect(rowLink('ev-gone').parentElement).toBe(rowLink('ev-water').parentElement)
  })

  it('with no live lots at all, no seed_saved row carries a link', async () => {
    renderWith([])
    await waitFor(() => expect(rowLink('ev-dry')).toBeTruthy())
    await waitFor(() => expect(apiFetchSpy.mock.calls.some(([p]) => String(p) === SEED_LOTS_PATH)).toBe(true))
    expect(screen.queryAllByTestId('event-seed-lot-link').length).toBe(0)
  })
})
