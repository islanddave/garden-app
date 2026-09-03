// BUG-VARIETYEDITUNREACHABLE-001 — the variety editor's only door.
//
// WHY THIS FILE EXISTS. `/varieties/:varietyId/edit` has been a registered, working, tested route
// since V4-EDITCOMPLETE-001 and, until this change, NOTHING in the app linked to it: a repo-wide
// search for the path returned the route registration, two source comments and two `source_url`
// strings — no `to=`, no `navigate(`, no `href=`. Dave is Android-only in an installed PWA with no
// address bar, so an unlinked route is not "hard to find", it is unreachable. `VarietyEditor.jsx:1`
// calls itself "the variety edit surface that did not exist"; it was built and never connected.
//
// That is not a cosmetic gap. It is the mechanism that leaves columns inert in this codebase —
// `inventory_items.year_harvested` and `lot_number` are in live prod with no reader and no writer —
// and it is the reason V5-VARIETYHYBRIDFLAG-001 is blocked on this row: the maintenance writer for
// a variety-level field is a page nobody can open.
//
// So this guard is about REACHABILITY, not about markup. It fails if the link is removed, if it
// stops pointing at the edit route, or if it stops carrying the variety's own id — the three ways
// the door silently closes again. A future tidy-up that deletes it as "an unused link" is exactly
// what this file exists to stop.
//
// Harness mirrors PlantingDetail.allFields.test.jsx. No jest-dom (L-182): text/role assertions only.

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

const VARIETY_ID = 'var-9f3c1e77-0000-4000-8000-000000000001'

// `id` is the FIRST key of the by-id GET's variety_ref jsonb_build_object
// (lambda/plants/index.js — 'id', pv.id), so a joined variety always carries it. The fixture
// reflects that rather than inventing a shape.
const BASE = {
  id: 'pl1',
  name: 'Ghost Pepper',
  project_id: 'proj1',
  project_name: 'Peppers 2026',
  status: 'fruiting',
  location_path: null,
  container_type: null,
  container_size: null,
  featured_photo_view_url: null,
  variety_ref: { id: VARIETY_ID, name: 'Ghost', species: 'Capsicum chinense' },
}

let PLANTING = BASE

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/projects/proj1/plantings/pl1']}>
      <Routes>
        <Route path="/projects/:id/plantings/:plantingId" element={<PlantingDetail />} />
        <Route path="/varieties/:varietyId/edit" element={<div>VARIETY EDIT PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

async function openBasics() {
  renderPage()
  await screen.findByRole('heading', { name: PLANTING.name })
  fireEvent.click(screen.getByRole('button', { name: /Details/ }))
  fireEvent.click(screen.getByRole('radio', { name: 'Basics' }))
}

beforeEach(() => {
  PLANTING = BASE
  apiFetchSpy.mockReset()
  apiFetchSpy.mockImplementation((url) => {
    if (/\/api\/plants\/pl1(\?|$)/.test(url)) return Promise.resolve(PLANTING)
    return Promise.resolve([])
  })
})

describe('BUG-VARIETYEDITUNREACHABLE-001 — the variety editor has a door', () => {
  it('renders an Edit variety link on the planting page', async () => {
    await openBasics()
    expect(screen.getByTestId('planting-variety-edit-link')).toBeTruthy()
  })

  it('points at THIS variety\'s edit route — the assertion that catches a wrong or stale id', async () => {
    await openBasics()
    const link = screen.getByTestId('planting-variety-edit-link')
    expect(link.getAttribute('href')).toBe(`/varieties/${VARIETY_ID}/edit`)
  })

  it('actually navigates — reachability, not just markup', async () => {
    await openBasics()
    fireEvent.click(screen.getByTestId('planting-variety-edit-link'))
    expect(screen.getByText('VARIETY EDIT PAGE')).toBeTruthy()
  })

  it('still shows the variety NAME beside the link', async () => {
    // The door must not cost the information the row existed to show.
    await openBasics()
    expect(screen.getByText('Ghost')).toBeTruthy()
  })
})

describe('degrades without an id rather than linking somewhere wrong', () => {
  it('renders the name and no link when variety_ref carries no id', async () => {
    // Older cached payloads and the grid projection carry a narrower variety_ref. A link built from
    // an absent id would resolve to `/varieties/undefined/edit` — a 404 door is worse than none.
    PLANTING = { ...BASE, variety_ref: { name: 'Ghost', species: 'Capsicum chinense' } }
    await openBasics()
    expect(screen.getByText('Ghost')).toBeTruthy()
    expect(screen.queryByTestId('planting-variety-edit-link')).toBeNull()
  })

  it('renders no Variety row at all when the planting has no variety', async () => {
    PLANTING = { ...BASE, name: 'Bare Row', variety_ref: null }
    await openBasics()
    expect(screen.queryByTestId('planting-variety-edit-link')).toBeNull()
  })
})
