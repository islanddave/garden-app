// V4-EVENTHISTPAGE-001 (BD0806-19) — the planting Event log no longer stops at the first 50.
//
// SERVER CEILING, VERIFIED HERE (not taken from the ledger): lambda/events/index.js Route 4 reads
// `Math.min(parseInt(limit ?? '50', 10), 200)` — default 50, hard cap 200 — and exposes NO `offset`
// parameter at all (only /api/events/feed does). That cap line has been in prod since the Apr-27
// lambda-code commit, so 200 is what the deployed function enforces, not just what dev source says.
// Prod today: the busiest single planting has 156 events, none exceed 200 — so requesting the
// ceiling returns 100% of every planting's history with room to spare.
//
// Hence RAISE-AND-PAGE rather than server paging: ask for the verified 200, then reveal the rows
// client-side 50 at a time so a 156-row list is not dumped into one 390px scroll. When the server
// returns exactly the ceiling we SAY so instead of silently truncating — silent truncation is the
// bug being fixed, and replacing it with a quieter version of itself would not be a fix.
//
// RENDER assertions only. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const { apiFetchSpy } = vi.hoisted(() => ({ apiFetchSpy: vi.fn() }))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn() }),
}))
vi.mock('../lib/uxEvents.js', () => ({
  FLOWS: { OPEN_PLANTING: 'open_planting' },
  useUxFlow: () => ({ step: vi.fn(), tap: vi.fn(), complete: vi.fn(), reset: vi.fn() }),
}))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => null }))
vi.mock('../lib/harvestWindows.js', () => import('./helpers/harvestWindowsSyncStub.js'))

import PlantingDetail from '../pages/PlantingDetail.jsx'

const PLANTING = {
  id: 'pl1', name: 'Megatron Jalapeno', project_id: 'proj1', status: 'fruiting',
  variety_ref: { name: 'Megatron F4', species: 'Capsicum annuum' },
  featured_photo_view_url: null,
}

// Titles are zero-padded so `Event 051` can never substring-match `Event 0510`.
const mkEvents = n => Array.from({ length: n }, (_, i) => ({
  id: `e${i + 1}`,
  event_type: 'watered',
  event_date: `2026-06-${String((i % 28) + 1).padStart(2, '0')}T12:00:00Z`,
  plant_id: 'pl1',
  title: `Event ${String(i + 1).padStart(3, '0')}`,
}))

function mountWith(events) {
  apiFetchSpy.mockImplementation((path) => {
    if (path.startsWith('/api/plants/')) return Promise.resolve(PLANTING)
    if (path.startsWith('/api/events')) return Promise.resolve(events)
    if (path.startsWith('/api/harvests')) return Promise.resolve({ entries: [] })
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

const showMoreBtn = () => screen.queryByTestId('event-log-show-more')

beforeEach(() => {
  apiFetchSpy.mockReset()
  window.scrollTo = vi.fn()
})

describe('PlantingDetail event log — raise-and-page (V4-EVENTHISTPAGE-001)', () => {
  it('asks the server for the verified 200 ceiling, not the 50 default', async () => {
    mountWith(mkEvents(120))
    await waitFor(() =>
      expect(apiFetchSpy).toHaveBeenCalledWith('/api/events?project_id=proj1&plant_id=pl1&limit=200'))
  })

  it('renders the first page only, and a Show more control for the rest', async () => {
    mountWith(mkEvents(120))
    await screen.findByText('Event 001')
    // NEW: page one renders...
    expect(screen.getByText('Event 050')).toBeTruthy()
    // ...and the rest does NOT paint yet (the old build dumped every fetched row at once).
    expect(screen.queryByText('Event 051')).toBeNull()
    expect(screen.queryByText('Event 120')).toBeNull()
    const btn = showMoreBtn()
    expect(btn).toBeTruthy()
    expect(btn.textContent).toMatch(/70 older/)
  })

  it('Show more reveals the next 50 and keeps the already-shown rows', async () => {
    mountWith(mkEvents(120))
    await screen.findByText('Event 001')
    await act(async () => { fireEvent.click(showMoreBtn()) })
    expect(screen.getByText('Event 001')).toBeTruthy()   // page one still there
    expect(screen.getByText('Event 051')).toBeTruthy()   // page two now painted
    expect(screen.getByText('Event 100')).toBeTruthy()
    expect(screen.queryByText('Event 101')).toBeNull()   // page three still withheld
    expect(showMoreBtn().textContent).toMatch(/20 older/)
  })

  it('retires the control once the whole history is on screen', async () => {
    mountWith(mkEvents(120))
    await screen.findByText('Event 001')
    await act(async () => { fireEvent.click(showMoreBtn()) })
    await act(async () => { fireEvent.click(showMoreBtn()) })
    expect(screen.getByText('Event 120')).toBeTruthy()
    expect(showMoreBtn()).toBeNull()
  })

  it('never shows a pager when the history fits on one page', async () => {
    mountWith(mkEvents(12))
    await screen.findByText('Event 001')
    expect(screen.getByText('Event 012')).toBeTruthy()
    expect(showMoreBtn()).toBeNull()
  })

  it('says so plainly when the server ceiling truncated the history', async () => {
    mountWith(mkEvents(200))           // exactly the cap → there may be older events we cannot reach
    await screen.findByText('Event 001')
    await act(async () => { fireEvent.click(showMoreBtn()) })
    await act(async () => { fireEvent.click(showMoreBtn()) })
    await act(async () => { fireEvent.click(showMoreBtn()) })
    expect(screen.getByText('Event 200')).toBeTruthy()
    expect(screen.getByTestId('event-log-ceiling')).toBeTruthy()
  })

  it('does not cry truncation one row below the ceiling', async () => {
    mountWith(mkEvents(199))
    await screen.findByText('Event 001')
    expect(screen.queryByTestId('event-log-ceiling')).toBeNull()
  })
})
