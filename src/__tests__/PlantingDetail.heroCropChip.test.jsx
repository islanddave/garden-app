// The white crop-type chip beside the gold key-fact pill on the planting hero, end to end (keyFact.js
// selectCropType -> HeroPhoto -> PlantingDetail). Until 2026-09-25 its words came from name heuristics, so it
// said "Tomato" on both live tomatillos and "Pepper" on Peppermint (crop type mint). It now names the
// cultivar's crop type; the heuristics still decide where it shows, so plantings without it stay without it.
// Fixtures are prod rows in the plants Lambda's variety_ref shape (2026-09-25, read-only).
// Harness mirrors PlantingDetail.heroPill.test.jsx (mocked useApiFetch, real router, stubbed telemetry).
// No jest-dom (L-182): role/attr/text + toEqual only.

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
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

const BLUSH = {
  id: 'pl1', name: 'Purple Blush Tomatillo', project_id: 'proj1', project_name: 'Drive',
  status: 'harvested', quantity: 2, featured_photo_view_url: null,
  variety_ref: { name: 'Purple blush', genus: 'Physalis', species: 'philadelphica', crop_type_slug: 'tomatillo',
    days_to_maturity_min: 70, days_to_maturity_max: 75, sun_requirements: 'full_sun',
    growth_habit: 'bushy upright; 3-5 in jalapeño-size fruit, compact productive plants; simultaneous green/purple/red fruit display' },
}
const PEPPERMINT = {
  id: 'pl1', name: 'Peppermint', project_id: 'proj1', project_name: 'Herbs',
  status: 'vegetative', quantity: 3, featured_photo_view_url: null,
  variety_ref: { name: 'Peppermint', genus: 'Mentha', species: 'x piperita', crop_type_slug: 'mint',
    days_to_maturity_min: 70, days_to_maturity_max: 90, sun_requirements: 'part_sun', default_unit: 'cup',
    harvest_habit: 'cut_and_come_again', scoville_min: null, scoville_max: null, scoville_source: null },
}
// A pepper named by cultivar: the name heuristic misses it, so it has never had a chip.
const BLACK_OLIVE = {
  id: 'pl1', name: 'Black Olive', project_id: 'proj1', project_name: 'Drive',
  status: 'harvested', quantity: 17, featured_photo_view_url: null,
  variety_ref: { name: 'Black Olive', genus: 'Capsicum', species: 'annuum', crop_type_slug: 'pepper',
    scoville_min: 10000, scoville_max: 30000, scoville_source: null,
    days_to_maturity_min: 70, days_to_maturity_max: 80, sun_requirements: 'full_sun' },
}

function renderPage(planting) {
  apiFetchSpy.mockImplementation((path) => {
    if (path.startsWith('/api/plants/')) return Promise.resolve(planting)
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

// The chip is the child of the hero's pill row painted rgba(255,255,255,0.92) (HeroPhoto.jsx) that is not the
// quantity pill (same paint, data-testid="hero-quantity"). jsdom normalises colours, so read it back.
const probe = document.createElement('span')
probe.style.backgroundColor = 'rgba(255,255,255,0.92)'
const CHIP_WHITE = probe.style.backgroundColor

function heroCropChips(name) {
  const row = screen.getByRole('heading', { level: 1, name }).nextElementSibling
  return [...row.children].filter(el => el.style.backgroundColor === CHIP_WHITE && !el.dataset.testid).map(el => el.textContent)
}

beforeEach(() => {
  apiFetchSpy.mockReset()
  window.scrollTo = vi.fn()
})

describe('PlantingDetail — the hero crop-type chip is the crop type', () => {
  it('Purple Blush Tomatillo: the chip says Tomatillo', async () => {
    renderPage(BLUSH)
    await screen.findByRole('heading', { name: 'Purple Blush Tomatillo' })
    expect(heroCropChips('Purple Blush Tomatillo')).toEqual(['Tomatillo'])
  })

  it('Peppermint (crop type mint): the chip says Mint', async () => {
    renderPage(PEPPERMINT)
    await screen.findByRole('heading', { name: 'Peppermint' })
    expect(heroCropChips('Peppermint')).toEqual(['Mint'])
  })

  it('Black Olive (a pepper the name test misses) still has no chip: not a rollout', async () => {
    renderPage(BLACK_OLIVE)
    await screen.findByRole('heading', { name: 'Black Olive' })
    expect(heroCropChips('Black Olive')).toEqual([])
  })
})
