// V4-PLANTINGRAWDETAIL-001 (BD-030) — the read-side all-fields guard for the planting page.
//
// WHY THIS FILE EXISTS. V4-EDITCOMPLETE-001 made "every field of the thing is exposed" a rule for
// EDIT forms and stopped there; the Details fly-up stayed three CURATED arrays naming about twenty of
// the forty-plus columns GET /api/plants/:id returns. The failure mode is silent by construction — an
// unnamed column simply never appears, and every other test on this page stays green — so the guard
// has to assert COMPLETENESS, not the presence of a tab. Two assertions carry that: the rendered row
// count equals the record's key count exactly, and a key this codebase has never heard of still
// renders. Both go red if the implementation is ever swapped back to a hand-written list.
//
// Harness mirrors PlantingDetail.vesselGaps.test.jsx. No jest-dom (L-182): text/role assertions only.

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

// Column names and shapes taken from the real GET /api/plants/:id SELECT (lambda/plants/index.js
// idMatch GET) so the fixture is the payload the page actually receives, not an invented one.
// The interesting members are the ones NO curated tab names: germinated_at, planted_out_at, the
// *_approx booleans, qty_current/harvested/lost, loss_cause, acquired_mature_*, divergence_type,
// succession_*, workspace_id, version, metadata, updated_at.
const FULL = {
  id: 'pl1',
  name: 'Megatron Jalapeno',
  quantity: 3,
  status: 'fruiting',
  notes: 'Second flush coming in.',
  project_id: 'proj1',
  project_name: 'Peppers 2026',
  variety_id: 'var9',
  source_inventory_item_id: null,
  metadata: { seed_lot: 'A7-2025' },
  featured_photo_id: null,
  featured_photo_view_url: null,
  created_at: '2026-04-02T14:03:11.512Z',
  updated_at: '2026-08-11T09:41:00.000Z',
  sown_at: '2026-04-02',
  sown_at_approx: false,
  germinated_at: '2026-04-11',
  germinated_at_approx: true,
  transplanted_at: '2026-05-20',
  transplanted_at_approx: false,
  planted_out_at: null,
  planted_out_at_approx: false,
  qty_initial: 4,
  qty_current: 3,
  qty_harvested: 11,
  qty_lost: 1,
  loss_cause: 'damping_off',
  source_type: 'seed',
  source_ref: 'Fedco 2026',
  source_generation: 'F4',
  parent_plant_id: null,
  divergence_type: null,
  lineage_note: '',
  succession_group_id: null,
  succession_order: null,
  assignee_user_id: null,
  container_type: 'fabric_bag',
  container_size: '10 gal',
  location_id: 'loc3',
  location_path: 'Gardens at Mathews Ridge / Bag Area',
  acquired_mature: false,
  acquired_mature_source: null,
  acquired_mature_set_at: null,
  workspace_id: 'ws1',
  version: 7,
  last_watered_at: '2026-08-13',
  watering_interval_days: 2,
  variety_ref: { name: 'Megatron F4', species: 'Capsicum annuum' },
}

// The shape the curated tabs answer with "No additional details recorded yet." — the sparse planting
// whose raw record is the MOST worth reaching, which is why the All tab must not inherit that answer.
const BARE = {
  id: 'pl1', name: 'Bare Row', project_id: 'proj1', project_name: 'P',
  status: 'growing', variety_ref: null, location_path: null,
  container_type: null, container_size: null, featured_photo_view_url: null,
}

let PLANTING = FULL

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

// Open Details and switch to a tab. Returns the tab's row-group element so callers can assert on
// the WHOLE set (several assertions below are about a field being absent, which a per-row query
// cannot express) and can count rows.
async function openTab(label) {
  renderPage()
  await screen.findByRole('heading', { name: PLANTING.name })
  fireEvent.click(screen.getByRole('button', { name: /Details/ }))
  fireEvent.click(screen.getByRole('radio', { name: label }))
  const groupName = label === 'All' ? 'All fields' : label
  return screen.getByRole('group', { name: groupName })
}

// Each row renders as <div><div>KEY</div><div>VALUE</div></div> inside one flex container, so the
// container's child count IS the number of fields on screen.
function rowCount(group) {
  return group.firstChild.children.length
}

beforeEach(() => {
  apiFetchSpy.mockReset()
  window.scrollTo = vi.fn()
  apiFetchSpy.mockImplementation((path) => {
    if (path.startsWith('/api/plants/')) return Promise.resolve(PLANTING)
    if (path.startsWith('/api/events')) return Promise.resolve([])
    return Promise.resolve(null)
  })
  PLANTING = FULL
})

describe('PlantingDetail — All-fields tab (read-side counterpart to V4-EDITCOMPLETE-001)', () => {
  // THE headline assertion: every key of the fetched record is on screen, none added, none dropped.
  // An exact count rather than a spot check, because the defect being guarded is omission — a
  // hand-written list, or a `.filter(([, v]) => v)` copied from the curated rows, both fail here.
  it('renders exactly one row per field of the fetched record', async () => {
    const group = await openTab('All')
    expect(rowCount(group)).toBe(Object.keys(FULL).length)
  })

  // The self-maintaining property, and the single clearest separator between this implementation and
  // a fourth curated array: a column the client has never been taught about still reaches the screen.
  it('renders a field this codebase has never heard of', async () => {
    PLANTING = { ...FULL, some_future_column: 'shipped by the API tomorrow' }
    const group = await openTab('All')
    expect(group.textContent).toContain('some_future_column')
    expect(group.textContent).toContain('shipped by the API tomorrow')
    expect(rowCount(group)).toBe(Object.keys(FULL).length + 1)
  })

  // The gap BD-030 names, stated as a before/after on the same render: these columns are on the
  // record and on NO curated tab. If a future change adds them to Basics/Care/More this test still
  // passes — it only asserts they are reachable, which is the actual requirement.
  it('surfaces columns no curated tab names', async () => {
    const group = await openTab('All')
    const text = group.textContent
    for (const key of ['germinated_at', 'qty_harvested', 'loss_cause', 'workspace_id', 'version']) {
      expect(text).toContain(key)
    }
    expect(text).toContain('2026-04-11')   // germinated_at
    expect(text).toContain('damping_off')  // loss_cause
  })

  // Null is a fact about the record, not an absence of one. Dropping the row would answer "is
  // planted_out_at recorded?" with silence — indistinguishable from the column not existing.
  it('states a null field instead of dropping the row', async () => {
    const group = await openTab('All')
    const row = screen.getByText('planted_out_at').parentElement
    expect(row.textContent).toBe('planted_out_atNot recorded')
  })

  // The falsy trap: `false` is a recorded value on four real *_approx columns. A surface that
  // inherited the curated `.filter(([, v]) => v)` would hide every un-approximated date.
  it('renders a false boolean as false, not as blank or missing', async () => {
    const group = await openTab('All')
    expect(screen.getByText('sown_at_approx').parentElement.textContent).toBe('sown_at_approxfalse')
    expect(screen.getByText('germinated_at_approx').parentElement.textContent).toBe('germinated_at_approxtrue')
  })

  // "" and NULL are different facts on a raw surface, and a blank cell reads as a render bug.
  it('distinguishes an empty string from a null', async () => {
    const group = await openTab('All')
    expect(screen.getByText('lineage_note').parentElement.textContent).toBe('lineage_note""')
    expect(screen.getByText('divergence_type').parentElement.textContent).toBe('divergence_typeNot recorded')
  })

  // Nested payloads are data, not "[object Object]".
  it('renders nested objects as readable JSON', async () => {
    const group = await openTab('All')
    expect(screen.getByText('metadata').parentElement.textContent).toBe('metadata{"seed_lot":"A7-2025"}')
    expect(screen.getByText('variety_ref').parentElement.textContent).toContain('"species":"Capsicum annuum"')
  })

  // The sparse planting is the one whose raw record is most worth reaching. The curated tabs keep
  // their empty state (asserted here so the carve-out cannot be "fixed" by deleting one side of it).
  it('shows the raw record on a planting the curated tabs call empty', async () => {
    PLANTING = BARE
    renderPage()
    await screen.findByRole('heading', { name: 'Bare Row' })
    fireEvent.click(screen.getByRole('button', { name: /Details/ }))
    expect(screen.getByText('No additional details recorded yet.')).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: 'All' }))
    const group = screen.getByRole('group', { name: 'All fields' })
    expect(screen.queryByText('No additional details recorded yet.')).toBeNull()
    expect(rowCount(group)).toBe(Object.keys(BARE).length)
    expect(group.textContent).toContain('growing')
  })

  // ADDITIVE, not a redesign: the everyday tab must render exactly what it rendered before. Asserted
  // as the full label set so a row silently gained or lost by this change fails here.
  it('leaves the curated Basics tab untouched', async () => {
    const group = await openTab('Basics')
    const labels = [...group.firstChild.children].map(r => r.firstChild.textContent)
    expect(labels).toEqual([
      'Variety', 'Botanical', 'Location', 'Quantity', 'Started with', 'Sown', 'Transplanted',
      'Source', 'Pot / bag', 'Pot size',
    ])
  })
})
