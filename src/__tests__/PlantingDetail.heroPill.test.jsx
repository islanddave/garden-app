// The gold key-fact pill on the planting hero, end to end (keyFact.js selectKeyFact -> HeroPhoto ->
// PlantingDetail). Rung 2 used to hand back a habit that did not START with determ/indeterm whole, and
// the pill is white-space: nowrap, so on a 426px phone "Purple Blush Tomatillo" carried a 113-character
// sentence that could not wrap. Fixtures are prod rows in the plants Lambda's variety_ref shape.
// Harness mirrors PlantingDetail.sunLabel.test.jsx (mocked useApiFetch, real router, stubbed telemetry).
// No jest-dom (L-182): role/attr/text + toBe/toBeTruthy/toBeNull only.

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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

// Named by cultivar, like 44 of the 46 live tomato plantings: nothing in the name says tomato.
const CHEROKEE = {
  id: 'pl1', name: 'Cherokee Green', project_id: 'proj1', project_name: 'Drive',
  status: 'harvested', quantity: 1, featured_photo_view_url: null,
  variety_ref: { name: 'Cherokee Green', crop_type_slug: 'tomato', days_to_maturity_min: 75, days_to_maturity_max: 85,
    sun_requirements: 'full_sun', growth_habit: 'indeterminate vine; 6-8 ft; stake or cage required' },
}

// Peppers named by cultivar: the old name test (\bpepper|chil[ei]|jalape|habanero|serrano|cayenne) misses
// both, and neither page showed heat on the hero. Prod rows, 2026-09-25.
const BLACK_OLIVE = {
  id: 'pl1', name: 'Black Olive', project_id: 'proj1', project_name: 'Drive',
  status: 'fruiting', quantity: 1, featured_photo_view_url: null,
  variety_ref: { name: 'Black Olive', crop_type_slug: 'pepper', scoville_min: 10000, scoville_max: 30000, scoville_source: null,
    days_to_maturity_min: 70, days_to_maturity_max: 80, sun_requirements: 'full_sun' },
}
const CARMEN = {
  id: 'pl1', name: 'Carmen', project_id: 'proj1', project_name: 'Drive',
  status: 'fruiting', quantity: 1, featured_photo_view_url: null,
  variety_ref: { name: 'Carmen', crop_type_slug: 'pepper', scoville_min: 0, scoville_max: 0, scoville_source: null,
    days_to_maturity_min: 60, days_to_maturity_max: 80, sun_requirements: 'full_sun' },
}

// The cultivar's derived tags as GET /api/entity-tags projects them onto a planting (lambda/tags/index.js,
// the `projected` SELECT): one row per facet, in the Lambda's column list.
const tagRow = (facet, slug, label) => ({
  id: `tag-${facet}-${slug}`, facet, label, slug, source: 'derived', owner_id: 'system', visibility: 'shared',
  created_by: 'system', created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z',
})
const CHEROKEE_TAGS = [
  tagRow('type', 'tomato', 'Tomato'),
  tagRow('lifecycle', 'tender_perennial', 'Tender Perennial'),
  tagRow('determinacy', 'indeterminate', 'Indeterminate'),
]

function renderPage(planting, { projected } = {}) {
  apiFetchSpy.mockImplementation((path) => {
    if (path.startsWith('/api/plants/')) return Promise.resolve(planting)
    if (projected && path.startsWith('/api/entity-tags?')) return Promise.resolve({ direct: [], projected })
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
afterEach(() => { vi.unstubAllEnvs() })

describe('PlantingDetail — the hero key-fact pill never carries habit prose', () => {
  // The sentence is on the page once, as the crop card's Habit row (V5-PLANTPAGEDESIGNQS-001, Dave
  // 2026-10-11 "add habit"); until then it was nowhere. Never in the hero.
  it('Purple Blush Tomatillo: the pill is its days, and the sentence is the card\'s Habit row only', async () => {
    renderPage(BLUSH)
    await screen.findByRole('heading', { name: 'Purple Blush Tomatillo' })
    expect(heroGoldPills('Purple Blush Tomatillo')).toEqual(['70–75 days'])
    const prose = screen.getAllByText(BLUSH_PROSE)
    expect(prose).toHaveLength(1)
    expect(prose[0].parentElement.textContent).toBe(`Habit${BLUSH_PROSE}`)
    expect(screen.getByRole('heading', { level: 1 }).parentElement.textContent).not.toContain('bushy upright')
  })

  // The growth type shows ONCE, as the crop card's green pill (V5-PLANTPAGEDESIGNQS-001 part 1, Dave
  // 2026-10-12: "Green pill on the card"). From 2026-09-25 to then the hero's gold pill said it too
  // ("SHU for peppers, determinate/indeterminate for tomatoes", the V200 design) and the hero's days were
  // gone; the gold pill is now the next rung of its ladder, the days.
  // "Once" is a count over THREE surfaces: the hero pill, the card's green pill, and the grey facet chip
  // the tags substrate projects. Tags are on here, as in the prod build, and the mocked Lambda answers
  // the determinacy row, so the count below includes the chip the card drops.
  it('Cherokee Green (a tomato named by cultivar): Indeterminate is the card\'s green pill only; the hero pill is its days', async () => {
    vi.stubEnv('VITE_API_TAGS', 'https://tags.test')
    renderPage(CHEROKEE, { projected: CHEROKEE_TAGS })
    await screen.findByRole('heading', { name: 'Cherokee Green' })
    // The chip row has painted: the two tags the card keeps are on the page.
    await screen.findByText('Tender Perennial')
    expect(apiFetchSpy.mock.calls.some(([path]) => path === '/api/entity-tags?entity_type=plant&entity_id=pl1')).toBe(true)
    expect(heroGoldPills('Cherokee Green')).toEqual(['75–85 days'])
    const word = screen.getAllByText('Indeterminate')
    expect(word).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 1 }).parentElement.contains(word[0])).toBe(false) // not in the hero
    expect(screen.getAllByText('75–85 days')).toHaveLength(2) // the hero pill and the card's Days to maturity row
  })
})

// "SHU for peppers" (the V200 design). Until 2026-09-25 rung 1 read keys the plants Lambda never sends, so
// no live pepper showed its heat here; the hero now prints the crop card's own SHU chip text.
describe('PlantingDetail — a pepper\'s hero pill is its heat', () => {
  it('Black Olive (a pepper named by cultivar): the pill is its Scoville range, the same words as the card chip', async () => {
    renderPage(BLACK_OLIVE)
    await screen.findByRole('heading', { name: 'Black Olive' })
    expect(heroGoldPills('Black Olive')).toEqual(['10K–30K SHU'])
    expect(screen.getAllByText('10K–30K SHU')).toHaveLength(2) // the hero pill and the crop card's SHU chip
    expect(screen.getAllByText('70–80 days')).toHaveLength(1) // the days stay, in the card's row
  })

  it('Carmen (a sweet pepper, 0–0): the pill says Sweet · 0 SHU, as the card does', async () => {
    renderPage(CARMEN)
    await screen.findByRole('heading', { name: 'Carmen' })
    expect(heroGoldPills('Carmen')).toEqual(['Sweet · 0 SHU'])
    expect(screen.getAllByText('Sweet · 0 SHU')).toHaveLength(2)
  })
})
