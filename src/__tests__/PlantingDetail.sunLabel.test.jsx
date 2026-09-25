// The Sun value across the planting page, end to end. Three places print it: the hero's gold key-fact
// pill, the CropCard "Sun" row, and the Details sheet's Care tab ("Light"). Until 2026-09-25 all three
// printed the stored code (`part_shade`); now all three read the one Sun list in lib/varietySpec.js,
// the same words VarietyEditor offers. The fixture is prod-shaped: the code as the column holds it, and a
// crop that is not harvest-tracked, so the hero pill falls through to the sun rung (45 live plantings).
// Harness mirrors PlantingDetail.careFacts.test.jsx (mocked useApiFetch, real router, stubbed telemetry).
// No jest-dom (L-182): role/attr/text + toBe/toBeTruthy/toBeNull only.

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
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

const NAME = 'Fairway Orange Coleus Clone 1'
const planting = (sun) => ({
  id: 'pl1', name: NAME, project_id: 'proj1', project_name: 'Drive',
  status: 'vegetative', quantity: 1,
  variety_ref: { name: 'Fairway Orange', crop_type_slug: 'coleus', sun_requirements: sun },
  location_path: 'Drive > Drive-Shade',
  featured_photo_view_url: null,
})

function renderPage(sun) {
  apiFetchSpy.mockImplementation((path) => {
    if (path.startsWith('/api/plants/')) return Promise.resolve(planting(sun))
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

function openTab(name) {
  fireEvent.click(screen.getByRole('button', { name: /Details/ }))
  fireEvent.click(screen.getByRole('radio', { name }))
}

beforeEach(() => {
  apiFetchSpy.mockReset()
  window.scrollTo = vi.fn()
})

describe('PlantingDetail — the Sun value reads as words on every curated surface', () => {
  it('hero pill and crop card say Part shade; the page never shows the code', async () => {
    renderPage('part_shade')
    await screen.findByRole('heading', { name: NAME })
    expect(screen.getAllByText('Part shade')).toHaveLength(2) // hero key-fact pill + CropCard Sun row
    expect(screen.getByText('Sun').parentElement.textContent).toBe('SunPart shade')
    expect(document.body.textContent).not.toContain('part_shade')
  })

  it("the Care tab's Light row says Part shade", async () => {
    renderPage('part_shade')
    await screen.findByRole('heading', { name: NAME })
    openTab('Care')
    const care = screen.getByRole('group', { name: 'Care' })
    expect(within(care).getByText('Light').parentElement.textContent).toBe('LightPart shade')
    expect(document.body.textContent).not.toContain('part_shade')
  })

  // Left raw on purpose: the All tab is the record itself ("Field names render RAW ... on purpose").
  // This also shows the code really is on the fixture the two cases above say never reaches the page.
  it('the All tab still shows the stored code', async () => {
    renderPage('part_shade')
    await screen.findByRole('heading', { name: NAME })
    openTab('All')
    const all = screen.getByRole('group', { name: 'All fields' })
    expect(all.textContent).toContain('"sun_requirements":"part_shade"')
  })

  it('no sun value: no pill, no Sun row, no Light row (unchanged)', async () => {
    renderPage(null)
    await screen.findByRole('heading', { name: NAME })
    expect(screen.queryByText('Sun')).toBeNull()
    openTab('Care')
    const care = screen.getByRole('group', { name: 'Care' })
    expect(within(care).queryByText('Light')).toBeNull()
  })
})
