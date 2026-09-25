// The gold key-fact pill on the planting hero, end to end (keyFact.js selectKeyFact -> HeroPhoto ->
// PlantingDetail). Rung 2 used to hand back a habit that did not START with determ/indeterm whole, and
// the pill is white-space: nowrap, so on a 426px phone "Purple Blush Tomatillo" carried a 113-character
// sentence that could not wrap. Fixtures are prod rows in the plants Lambda's variety_ref shape.
// Harness mirrors PlantingDetail.sunLabel.test.jsx (mocked useApiFetch, real router, stubbed telemetry).
// No jest-dom (L-182): role/attr/text + toBe/toBeTruthy/toBeNull only.

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { P } from '../lib/constants.js'

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

const BLUSH_PROSE = 'bushy upright; 3-5 in jalapeño-size fruit, compact productive plants; simultaneous green/purple/red fruit display'
const BLUSH = {
  id: 'pl1', name: 'Purple Blush Tomatillo', project_id: 'proj1', project_name: 'Drive',
  status: 'harvested', quantity: 2, featured_photo_view_url: null,
  variety_ref: { name: 'Purple blush', crop_type_slug: 'tomatillo', days_to_maturity_min: 70, days_to_maturity_max: 75,
    sun_requirements: 'full_sun', growth_habit: BLUSH_PROSE },
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

// The key-fact pill is the one child of the hero's pill row painted P.warn (HeroPhoto.jsx). jsdom
// normalises colours, so read the expected value back through a style declaration.
const probe = document.createElement('span')
probe.style.backgroundColor = P.warn
const GOLD = probe.style.backgroundColor

function heroGoldPills(name) {
  const row = screen.getByRole('heading', { level: 1, name }).nextElementSibling
  return [...row.children].filter(el => el.style.backgroundColor === GOLD).map(el => el.textContent)
}

beforeEach(() => {
  apiFetchSpy.mockReset()
  window.scrollTo = vi.fn()
})

describe('PlantingDetail — the hero key-fact pill never carries habit prose', () => {
  it('Purple Blush Tomatillo: the pill is its days, and the sentence is nowhere on the page', async () => {
    renderPage(BLUSH)
    await screen.findByRole('heading', { name: 'Purple Blush Tomatillo' })
    expect(heroGoldPills('Purple Blush Tomatillo')).toEqual(['70–75 days'])
    expect(document.body.textContent.toLowerCase()).not.toContain('bushy upright')
  })
})
