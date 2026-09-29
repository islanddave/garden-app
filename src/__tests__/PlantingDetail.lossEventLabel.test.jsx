// BUG-LOSSEVENTLABEL-001 — the planting's Event log never says "failed" for a plants-lost event.
//
// Dave, 2026-09-29: eight Mini Roses, two died coming inside, he logged "Plants lost" for 2 — and the
// log said "failed". The planting is alive (status vegetative, quantity 6), and Failed is a planting
// status. The row now reads the count and the reason: "2 plants lost · Weather".
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

// The live shape: prod planting 'Mini Rose' after the loss (quantity 6, qty_lost 2, still vegetative).
const PLANTING = {
  id: 'pl1', name: 'Mini Rose', project_id: 'proj1', project_name: 'Houseplants',
  status: 'vegetative', quantity: 6, qty_lost: 2,
  variety_ref: null, featured_photo_view_url: null,
}
const ev = (id, event_type, metadata, extra = {}) => ({
  id, event_type, event_date: '2026-09-28', plant_id: 'pl1', project_id: 'proj1',
  title: null, notes: null, metadata, ...extra,
})
const EVENTS = [
  ev('ev-lost2', 'failed', { loss_reason: 'weather', qty_reduced: 2 }),
  ev('ev-lost1', 'failed', { loss_reason: 'culled', qty_reduced: 1 }),
  ev('ev-gift', 'given_away', { giveaway_reason: 'friend', qty_reduced: 3 }),
  ev('ev-titled', 'failed', { loss_reason: 'pest', qty_reduced: 1 }, { title: 'Slugs took one' }),
  ev('ev-water', 'watering', null),
]

function renderIt() {
  apiFetchSpy.mockImplementation((path) => {
    const p = String(path)
    if (p === '/api/plants/pl1/seed-lots') return Promise.resolve({ plant_id: 'pl1', seed_lots: [] })
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

const row = (id) => document.querySelector(`a[href="/events/${id}"]`)
const title = (id) => row(id)?.querySelector('[data-testid="event-row-title"]')?.textContent
const reason = (id) => row(id)?.querySelector('[data-testid="event-row-reason"]')?.textContent.trim() ?? null

beforeEach(() => { apiFetchSpy.mockReset(); window.scrollTo = vi.fn() })

describe('PlantingDetail Event log — plant-reduction rows (BUG-LOSSEVENTLABEL-001)', () => {
  it("Dave's row reads '2 plants lost · Weather'", async () => {
    renderIt()
    await waitFor(() => expect(row('ev-lost2')).toBeTruthy())
    expect(title('ev-lost2')).toBe('2 plants lost')
    expect(reason('ev-lost2')).toBe('· Weather')
  })

  it('no row in the log says "failed"', async () => {
    renderIt()
    await waitFor(() => expect(row('ev-water')).toBeTruthy())
    // Non-vacuity: all five rows rendered, three of them stored as event_type 'failed'.
    for (const id of ['ev-lost2', 'ev-lost1', 'ev-gift', 'ev-titled', 'ev-water']) expect(row(id), id).toBeTruthy()
    for (const id of ['ev-lost2', 'ev-lost1', 'ev-gift', 'ev-titled', 'ev-water']) {
      expect(row(id).textContent, id).not.toMatch(/fail/i)
    }
  })

  it('singular, give-away and a titled loss', async () => {
    renderIt()
    await waitFor(() => expect(row('ev-gift')).toBeTruthy())
    expect(title('ev-lost1')).toBe('1 plant lost')
    expect(reason('ev-lost1')).toBe('· Culled / thinned')
    expect(title('ev-gift')).toBe('3 plants given away')
    expect(reason('ev-gift')).toBe('· A friend')
    expect(title('ev-titled')).toBe('Slugs took one')
    expect(reason('ev-titled')).toBe('· Pest')
  })

  it('an ordinary row is untouched: its token, and no reason line', async () => {
    renderIt()
    await waitFor(() => expect(row('ev-water')).toBeTruthy())
    expect(title('ev-water')).toBe('watering')
    expect(reason('ev-water')).toBeNull()
  })
})
