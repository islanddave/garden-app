// V5-HEATRESPONSEDISPLAY-001 — the curated heat prose on the planting page.
//
// Two things are gated here and they are not the same thing:
//   (1) the RIGHT string reaches the RIGHT planting, on the page, with zero taps. Wiring, not
//       formatting: the component's own render is trivial, and the way this ships broken is the
//       page passing the wrong record's value or not passing one at all.
//   (2) an UNCOVERED planting renders honest absence. The corpus is silent on collards — Dave's one
//       live collard has no heat_response, and neither do his kale, carrot or bean — so the empty
//       case is the common case, not an edge case. Rendering nothing there would read as "nothing to
//       worry about", which is a claim the data does not support.
//
// Harness mirrors PlantingDetail.careFacts.test.jsx (mocked useApiFetch, real router, stubbed
// telemetry). No jest-dom (L-182): role/attr/text + toBe/toBeTruthy/toBeNull only.

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

// Verbatim prose from prod care_profile rows, resolved through v_resolved_care (read-only,
// 2026-09-02). Fixtures are the real distribution, not invented sentences: an invented string
// repeats nothing about how these actually read.
const TOMATO_PROSE = 'blossom drop >95F day / <55F night; watch heatwaves'
const LETTUCE_PROSE = 'bolts >80F; afternoon shade critical'

function planting(over) {
  return {
    id: 'pl1', name: 'Yellow Brandywine', project_id: 'proj1', project_name: 'Tomatoes 2026',
    status: 'fruiting', quantity: 1,
    variety_ref: { name: 'Yellow Brandywine', species: 'Solanum lycopersicum' },
    featured_photo_view_url: null,
    ...over,
  }
}

function renderPage(record) {
  apiFetchSpy.mockImplementation((path) => {
    if (path.startsWith('/api/plants/')) return Promise.resolve(record)
    if (path.startsWith('/api/events')) return Promise.resolve([])
    return Promise.resolve(null)
  })
  return render(
    <MemoryRouter initialEntries={['/projects/proj1/plantings/pl1']}>
      <Routes>
        <Route path="/projects/:id/plantings/:plantingId" element={<PlantingDetail />} />
        <Route path="/garden" element={<div>GARDEN PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  apiFetchSpy.mockReset()
  window.scrollTo = vi.fn()
})

describe('PlantingDetail — the right heat prose reaches the right planting', () => {
  // MUTATION: drop the `planting={pl}` prop at the HeatResponseNote call site, or read
  // pl.variety_ref.heat_response instead of pl.heat_response -> RED. Nothing in the component's own
  // suite can catch either: they are both wiring, and both render a plausible-looking empty note.
  it('renders this planting’s own string, on the page, with zero taps', async () => {
    renderPage(planting({ heat_response: TOMATO_PROSE }))
    await screen.findByRole('heading', { name: 'Yellow Brandywine' })

    const note = screen.getByTestId('heat-response-note')
    expect(note.textContent).toContain(TOMATO_PROSE)
    expect(note.textContent).toContain('In heat')
  })

  // The discriminating half. A component that hardcoded a string, or a page that read a shared
  // constant, would pass the case above and fail this one.
  it('a different planting gets a different string, not the first one', async () => {
    renderPage(planting({ id: 'pl1', name: 'Little Gem', heat_response: LETTUCE_PROSE }))
    await screen.findByRole('heading', { name: 'Little Gem' })

    const note = screen.getByTestId('heat-response-note')
    expect(note.textContent).toContain(LETTUCE_PROSE)
    expect(note.textContent.includes(TOMATO_PROSE)).toBe(false)
  })
})

describe('PlantingDetail — an uncovered planting says so', () => {
  // Collards is the real subject here: zero entries in the corpus match it, and its one live
  // planting resolves heat_response NULL (verified read-only on prod 2026-09-02). Same for kale,
  // carrot and bean.
  const COLLARD = planting({ id: 'pl1', name: 'Collards', heat_response: null })

  // MUTATION: `return null` when there is no prose -> RED. That is the tempting version and it is
  // the wrong one: an absent line is indistinguishable from a plant that wants nothing in the heat.
  it('renders the note anyway, stating the absence', async () => {
    renderPage(COLLARD)
    await screen.findByRole('heading', { name: 'Collards' })

    const note = screen.getByTestId('heat-response-note')
    expect(note).toBeTruthy()
    expect(note.textContent).toContain('nothing recorded for this plant')
  })

  // MUTATION: substitute any generic fallback ("water more in heat", "check daily above 85F") ->
  // RED. The app must never invent horticulture that reads, on screen, exactly like the 193 rows
  // where a human actually wrote something.
  it('invents no advice to fill the gap', async () => {
    renderPage(COLLARD)
    await screen.findByRole('heading', { name: 'Collards' })

    const text = screen.getByTestId('heat-response-note').textContent
    expect(/\d+\s*F/i.test(text)).toBe(false)
    expect(/water|shade|mulch|harvest|bolt/i.test(text)).toBe(false)
  })

  // A whitespace-only value is a data gap wearing a value's clothes. Rendering it produces a
  // labelled empty line, which is the silent-region failure the absence copy exists to prevent.
  it('treats a blank string as absent, not as prose', async () => {
    renderPage(planting({ id: 'pl1', name: 'Collards', heat_response: '   ' }))
    await screen.findByRole('heading', { name: 'Collards' })

    expect(screen.getByTestId('heat-response-note').textContent)
      .toContain('nothing recorded for this plant')
  })
})
