// BUG-CADENCESIZE-001 — WIRING guard for the vessel-gap surface on the planting page.
//
// WHY THIS FILE EXISTS SEPARATELY FROM vesselData.test.js. That suite proves the pure function decides
// correctly. It cannot prove the PAGE ever asks it — and the page's Details rows end in
// `.filter(([, v]) => v)`, so if the wiring is dropped the rows silently vanish again with every other
// test still green. That is the exact vacuous-guard trap a sibling lane hit on this same page, so the
// render path gets its own proof: delete the `vesselGap` call and this file goes red.
//
// Harness mirrors PlantingDetail.careFacts.test.jsx. No jest-dom (L-182): text/role assertions only.

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
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

// The live shape this whole change exists for: recorded plastic_pot, NO size, sitting in "Bag Area".
// 26 active prod rows look exactly like this; photos of three show black fabric grow bags.
const BAG_AREA_POT = {
  id: 'pl1', name: 'Eva Purple Ball', project_id: 'proj1', project_name: 'Tomatoes',
  status: 'fruiting', quantity: 1,
  variety_ref: { name: 'Eva Purple Ball', species: 'Solanum lycopersicum' },
  location_path: 'Gardens at Mathews Ridge / Bag Area',
  container_type: 'plastic_pot', container_size: null,
  last_watered_at: '2026-08-17', watering_interval_days: 1, featured_photo_view_url: null,
}
const COMPLETE_BAG = {
  ...BAG_AREA_POT, id: 'pl2', name: 'Granadero',
  container_type: 'fabric_bag', container_size: '10 gal',
}

let PLANTING = BAG_AREA_POT

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/projects/proj1/plantings/pl1']}>
      <Routes>
        <Route path="/projects/:id/plantings/:plantingId" element={<PlantingDetail />} />
        <Route path="/garden" element={<div>GARDEN PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

// Open the Details fly-up and return the text of the whole Basics row set (each row renders as
// <div><div>LABEL</div><div>VALUE</div></div>, so the label's grandparent is the rows container).
// Scoping to the container rather than to one row is deliberate: several assertions below are about a
// row being ABSENT, which a per-row query cannot express.
async function openDetails() {
  renderPage()
  await screen.findByRole('heading', { name: PLANTING.name })
  fireEvent.click(screen.getByRole('button', { name: /Details/ }))
  return screen.getByText('Pot / bag').parentElement.parentElement.textContent
}

beforeEach(() => {
  apiFetchSpy.mockReset()
  window.scrollTo = vi.fn()
  apiFetchSpy.mockImplementation((path) => {
    if (path.startsWith('/api/plants/')) return Promise.resolve(PLANTING)
    if (path.startsWith('/api/events')) return Promise.resolve([])
    return Promise.resolve(null)
  })
})

describe('PlantingDetail — vessel gaps are stated, not hidden', () => {
  it('shows the missing pot size instead of dropping the row', async () => {
    PLANTING = BAG_AREA_POT
    const text = await openDetails()
    // The row EXISTS (before this change `.filter` removed it entirely) and says what is missing.
    expect(screen.getByText('Pot size')).toBeTruthy()
    expect(text).toContain('Not recorded')
  })

  // The "Pot / bag" row has its own wiring, separate from "Pot size". Without this case a mutation that
  // drops ONLY the type wiring passed the whole file — 22 live rows have no container_type at all, so
  // that row is exactly as load-bearing as the size one.
  it('shows the missing pot type instead of dropping the row', async () => {
    PLANTING = { ...BAG_AREA_POT, container_type: null, container_size: null }
    const text = await openDetails()
    expect(screen.getByText('Pot / bag')).toBeTruthy()
    // Both vessel rows state their absence; neither vanishes.
    expect(text.match(/Not recorded/g).length).toBe(2)
    // ...and with no recorded type there is nothing to contradict, so no conflict row is invented.
    expect(screen.queryByText('Check pot / bag')).toBeNull()
  })

  it('shows the type/location contradiction that motivated the change', async () => {
    PLANTING = BAG_AREA_POT
    const text = await openDetails()
    expect(screen.getByText('Check pot / bag')).toBeTruthy()
    expect(text).toContain('Recorded as plastic pot, but this location is grow bags')
  })

  // The other half of the wiring, and the half that keeps this from becoming a chore list: a planting
  // whose record is complete and consistent must gain NOTHING. Asserted on a row that differs from the
  // flagged one only in its vessel fields, so a change that flags everything fails here.
  it('adds nothing to a planting whose vessel record is complete', async () => {
    PLANTING = COMPLETE_BAG
    renderPage()
    await screen.findByRole('heading', { name: 'Granadero' })
    fireEvent.click(screen.getByRole('button', { name: /Details/ }))
    const text = screen.getByText('Pot / bag').parentElement.parentElement.textContent
    expect(text).toContain('10 gal')
    expect(text).not.toContain('Not recorded')
    expect(screen.queryByText('Check pot / bag')).toBeNull()
  })

  // THE EMPTY-STATE CARVE-OUT. On a planting with nothing else recorded, two rows reading "Not recorded"
  // would replace the existing "No additional details recorded yet." copy with a form stub — the exact
  // chore-list feel this surface exists to avoid. Caught by the pre-existing PlantingDetail null-tolerance
  // test, and pinned here so the carve-out cannot be removed silently.
  it('leaves a wholly-empty planting on its existing empty-state copy', async () => {
    PLANTING = {
      id: 'pl1', name: 'Bare Row', project_id: 'proj1', project_name: 'P',
      status: 'growing', variety_ref: null, location_path: null,
      container_type: null, container_size: null, featured_photo_view_url: null,
    }
    renderPage()
    await screen.findByRole('heading', { name: 'Bare Row' })
    fireEvent.click(screen.getByRole('button', { name: /Details/ }))
    expect(screen.getByText('No additional details recorded yet.')).toBeTruthy()
    expect(screen.queryByText('Pot size')).toBeNull()
  })

  // A real recorded value must never be replaced by the gap copy — the surface describes, never overrides.
  it('never displaces a recorded value', async () => {
    PLANTING = { ...BAG_AREA_POT, container_size: '5 gal' }
    const text = await openDetails()
    expect(text).toContain('5 gal')
    expect(text).not.toContain('Not recorded')
  })
})
