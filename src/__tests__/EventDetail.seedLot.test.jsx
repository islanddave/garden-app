// V5-SEEDSTAB-001 slice 2 — a `seed_saved` event's detail page opens the lot it made.
//
// The event carries the lot as metadata.seed_lot_id (SaveSeedSheet), a raw uuid METADATA_HIDDEN_KEYS keeps
// out of Details. The "Seed lot" block resolves it among the planting's LIVE seed lots and links it:
//   · fermenting or drying -> Seeds › Saved seeds on that lot, spelled by the seeds URL module;
//   · anything else        -> the lot's own page;
//   · a lot that is gone   -> no block at all, the page as it was — with positive evidence the lot list
//                             was read, so the absence is an answer and not a lookup that never ran;
//   · no seed_lot_id       -> no lookup and no block (every other event is untouched).
//
// No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const { apiFetchSpy, dataRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  dataRef: { event: null, lots: [] },
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))
vi.mock('../context/AuthContext.jsx', () => ({
  useAuth: () => ({ user: { id: 'u1' } }),
  useAuthOptional: () => ({ user: null }),
}))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: vi.fn(), isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))

import EventDetail from '../pages/EventDetail.jsx'
import { seedsHref } from '../lib/seedsRoutes.js'

const SEED_LOTS_PATH = '/api/plants/g1/seed-lots'
const SEED_SAVED = {
  id: 'e1', project_id: null, plant_id: 'g1', event_type: 'seed_saved',
  event_date: '2026-09-12T12:00:00.000Z', title: null,
  notes: "Saved seed lot 'Big Boy — saved 2026'", private_notes: null, quantity: null, is_public: true,
  metadata: { seed_lot_id: 'lot-1' }, flagged_as_issue: false, severity: null, resolved_at: null,
  planting_name: 'Big Boy, bed 3', harvest: null,
}
const LOT = { id: 'lot-1', name: 'Big Boy — saved 2026', seed_stage: 'fermenting', quantity_on_hand: 1, variety_name: 'Big Boy', created_at: '2026-09-12' }

beforeEach(() => {
  apiFetchSpy.mockReset()
  dataRef.event = { ...SEED_SAVED }
  dataRef.lots = [LOT]
  apiFetchSpy.mockImplementation((path) => {
    if (path === '/api/events/e1') return Promise.resolve(dataRef.event)
    if (path === SEED_LOTS_PATH) return Promise.resolve({ plant_id: 'g1', seed_lots: dataRef.lots })
    return Promise.resolve(null)
  })
})

async function renderDetail() {
  render(
    <MemoryRouter initialEntries={['/events/e1']}>
      <Routes><Route path="/events/:eventId" element={<EventDetail />} /></Routes>
    </MemoryRouter>,
  )
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/events/e1'))
  await act(async () => { await Promise.resolve() })
}
const lotsRead = () => apiFetchSpy.mock.calls.some(([p]) => p === SEED_LOTS_PATH)

describe('EventDetail — a seed_saved event opens its lot (V5-SEEDSTAB-001 slice 2)', () => {
  it('a lot still fermenting opens Seeds › Saved seeds on that lot', async () => {
    await renderDetail()
    const link = await screen.findByTestId('event-seed-lot-link')
    expect(link.getAttribute('href')).toBe(seedsHref('saved', { lot: 'lot-1' }))
    expect(link.getAttribute('href')).toBe('/seeds?view=saved&lot=lot-1')
    expect(link.textContent).toContain('Big Boy — saved 2026')
    expect(link.style.minHeight).toBe('44px')
    expect(screen.getByTestId('event-seed-lot').textContent).toContain('Seed lot')
  })

  it('a stored lot opens its own page', async () => {
    dataRef.lots = [{ ...LOT, seed_stage: 'stored' }]
    await renderDetail()
    expect((await screen.findByTestId('event-seed-lot-link')).getAttribute('href')).toBe('/inventory/lot-1')
  })

  it('a lot that is gone leaves the page exactly as it was — no block, no link to nowhere', async () => {
    dataRef.lots = [{ ...LOT, id: 'lot-other' }]
    await renderDetail()
    await waitFor(() => expect(lotsRead()).toBe(true))
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByTestId('event-seed-lot')).toBeNull()
    // The rest of the event still reads: the planting anchor and the note.
    expect(screen.getByTestId('event-planting').textContent).toContain('Big Boy, bed 3')
    expect(document.body.textContent).toContain("Saved seed lot 'Big Boy — saved 2026'")
    // And the raw id stays hidden, as before.
    expect(document.body.textContent).not.toContain('seed_lot_id')
  })

  it('an event with no seed_lot_id makes no lookup and renders no block', async () => {
    dataRef.event = { ...SEED_SAVED, metadata: null }
    await renderDetail()
    await act(async () => { await Promise.resolve() })
    expect(lotsRead()).toBe(false)
    expect(screen.queryByTestId('event-seed-lot')).toBeNull()
  })
})
