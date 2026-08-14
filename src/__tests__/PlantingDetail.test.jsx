// PlantingDetail (V3-NAV-001 / Lane C, PR2) unit tests.
// Covers the four-state contract (loading / fetch-error / 404 / empty-but-exists), the
// ownership guard, the HS-2 server-side event filter URL, null-variety tolerance, and the
// multi-channel status badge. useApiFetch is mocked to a controllable fetch; react-router-dom
// is REAL (MemoryRouter supplies :id / :plantingId). uxEvents is stubbed (no telemetry network).

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const { apiFetchSpy } = vi.hoisted(() => ({ apiFetchSpy: vi.fn() }))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn() }),
}))
// Telemetry must not touch the network in tests.
vi.mock('../lib/uxEvents.js', () => ({
  FLOWS: { OPEN_PLANTING: 'open_planting' },
  useUxFlow: () => ({ step: vi.fn(), tap: vi.fn(), complete: vi.fn(), reset: vi.fn() }),
}))
// V3-FAV-001: FavoriteToggle calls useAuth (no AuthProvider in this harness) — stub it to a no-op.
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => null }))
// V4-RIPENESSCUES-001: CropCard lazy-loads the colour-window resolver in an effect — stub it to
// the sync no-window resolver so nothing async mutates state mid-test (no act() churn; absence
// assertions race-free). Window rendering is covered in CropCard.window*.test.jsx.
vi.mock('../lib/harvestWindows.js', () => import('./helpers/harvestWindowsSyncStub.js'))

import PlantingDetail from '../pages/PlantingDetail.jsx'

const PLANTING = {
  id: 'pl1', name: 'Megatron Jalapeno', project_id: 'proj1', project_name: 'Peppers 2026',
  status: 'fruiting', quantity: 3, qty_initial: 6,
  sown_at: '2026-02-01', transplanted_at: '2026-04-15',
  variety_ref: { name: 'Megatron F4', species: 'Capsicum annuum' },
  source_type: 'saved_seed', source_ref: 'Dave lot 12', lineage_note: 'F4 selection',
  location_path: 'Greenhouse / Bed 2', notes: 'Hot one',
  featured_photo_view_url: null,
}

const EVENTS = [
  { id: 'e2', event_type: 'harvest', event_date: '2026-06-01T12:00:00Z', plant_id: 'pl1', title: 'Big pick' },
  { id: 'e1', event_type: 'first_harvest', event_date: '2026-05-20T12:00:00Z', plant_id: 'pl1', title: null },
]

function renderAt(path = '/projects/proj1/plantings/pl1') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/projects/:id/plantings/:plantingId" element={<PlantingDetail />} />
        <Route path="/projects/:id" element={<div>PROJECT PAGE</div>} />
        <Route path="/garden" element={<div>GARDEN PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  apiFetchSpy.mockReset()
  window.scrollTo = vi.fn()
})

describe('PlantingDetail — four states', () => {
  it('shows a loading state before data resolves', async () => {
    let resolvePlanting
    apiFetchSpy.mockImplementation(() => new Promise(r => { resolvePlanting = () => r(PLANTING) }))
    renderAt()
    expect(screen.getByText('Loading…')).toBeTruthy()
    await act(async () => { resolvePlanting(); await Promise.resolve() })
  })

  it('renders the planting (loaded) with name, multi-channel status, and grower fields', async () => {
    apiFetchSpy.mockImplementation((path) => {
      if (path.startsWith('/api/plants/')) return Promise.resolve(PLANTING)
      if (path.startsWith('/api/events')) return Promise.resolve(EVENTS)
      return Promise.resolve(null)
    })
    renderAt()
    // Name appears in both the H1 and the breadcrumb — assert the heading specifically.
    await screen.findByRole('heading', { name: 'Megatron Jalapeno' })
    // Status: multi-channel — the label text is present AND aria-labelled (not color alone).
    const badge = screen.getByLabelText('Status: Fruiting')  // humanized via statusLabel (V3-FORMSYS-001 §3.2)
    expect(badge.textContent).toContain('Fruiting')
    // 'Transplanted' appears in the V4-PLANTINGUI Life-story spine (visible without the fly-up).
    expect(screen.getAllByText('Transplanted').length).toBeGreaterThan(0)
    // V200 Slice 5b: the grower Details rows moved into the tabbed Details fly-up. Open it via
    // the Details pill on the hero, then read the Basics-tab fields (Location lives there now).
    fireEvent.click(screen.getByRole('button', { name: /Details/ }))
    expect(await screen.findByText('Greenhouse / Bed 2', { exact: false })).toBeTruthy()
    // First harvest (derived from the event log) lives on the More tab — switch to it. The
    // derivation needs the async events fetch, so await the row after switching.
    fireEvent.click(screen.getByRole('radio', { name: 'More' }))
    await screen.findByText('First harvest')
  })

  it('fetch-error (non-404) shows a friendly error + back link, not a thrown page', async () => {
    apiFetchSpy.mockImplementation((path) => {
      if (path.startsWith('/api/plants/')) return Promise.reject(Object.assign(new Error('boom'), { status: 500 }))
      return Promise.resolve(null)
    })
    renderAt()
    await screen.findByText('boom')
    expect(screen.getByText(/Back to project/)).toBeTruthy()
  })

  it('404 from the by-id endpoint shows the friendly "not found" state', async () => {
    apiFetchSpy.mockImplementation((path) => {
      if (path.startsWith('/api/plants/')) return Promise.reject(Object.assign(new Error('Not found'), { status: 404 }))
      return Promise.resolve(null)
    })
    renderAt()
    await screen.findByText('Planting not found')
    expect(screen.getByText(/Back to project/)).toBeTruthy()
  })

  it('empty-but-exists: planting loads but has zero events (distinct from a load failure)', async () => {
    apiFetchSpy.mockImplementation((path) => {
      if (path.startsWith('/api/plants/')) return Promise.resolve({ ...PLANTING, notes: null })
      if (path.startsWith('/api/events')) return Promise.resolve([])
      return Promise.resolve(null)
    })
    renderAt()
    await screen.findByRole('heading', { name: 'Megatron Jalapeno' })
    await screen.findByText('No events logged for this planting yet.')
  })
})

describe('PlantingDetail — ownership guard + HS-2 filter', () => {
  it('ownership mismatch (URL project != planting.project_id) → 404 semantics, no leak', async () => {
    apiFetchSpy.mockImplementation((path) => {
      // URL says proj-OTHER but the planting belongs to proj1.
      if (path.startsWith('/api/plants/')) return Promise.resolve(PLANTING)
      return Promise.resolve(null)
    })
    renderAt('/projects/proj-OTHER/plantings/pl1')
    await screen.findByText('Planting not found')
    // It must NOT render the planting name (no existence leak across projects).
    expect(screen.queryByText('Megatron Jalapeno')).toBeNull()
  })

  it('calls the events endpoint with the HS-2 server-side plant_id filter', async () => {
    apiFetchSpy.mockImplementation((path) => {
      if (path.startsWith('/api/plants/')) return Promise.resolve(PLANTING)
      if (path.startsWith('/api/events')) return Promise.resolve(EVENTS)
      return Promise.resolve(null)
    })
    renderAt()
    await waitFor(() =>
      // V4-EVENTHISTPAGE-001 appended &limit=200 (the verified server ceiling) — the HS-2 filter
      // this case guards is unchanged.
      expect(apiFetchSpy).toHaveBeenCalledWith('/api/events?project_id=proj1&plant_id=pl1&limit=200'))
  })

  it('event-log error state is distinct from the page error (page still renders)', async () => {
    apiFetchSpy.mockImplementation((path) => {
      if (path.startsWith('/api/plants/')) return Promise.resolve(PLANTING)
      if (path.startsWith('/api/events')) return Promise.reject(new Error('events down'))
      return Promise.resolve(null)
    })
    renderAt()
    await screen.findByRole('heading', { name: 'Megatron Jalapeno' })  // page loaded fine
    await screen.findByText("Couldn't load this planting's events.")    // only the log failed
  })
})

describe('PlantingDetail — null tolerance', () => {
  it('renders without a variety (null variety_ref) and without a photo', async () => {
    apiFetchSpy.mockImplementation((path) => {
      if (path.startsWith('/api/plants/')) {
        return Promise.resolve({
          id: 'pl1', name: 'Bare Planting', project_id: 'proj1', project_name: 'P',
          status: null, quantity: 1, variety_ref: null,
          sown_at: null, transplanted_at: null, source_type: null,
          lineage_note: null, notes: null, location_path: null, featured_photo_view_url: null,
        })
      }
      if (path.startsWith('/api/events')) return Promise.resolve([])
      return Promise.resolve(null)
    })
    renderAt()
    await screen.findByRole('heading', { name: 'Bare Planting' })
    // No status badge when status is null; no crash on absent variety/photo.
    expect(screen.queryByLabelText(/^Status:/)).toBeNull()
    // V200 Slice 5b: the "nothing recorded" copy moved into the Details fly-up. Open it to read.
    fireEvent.click(screen.getByRole('button', { name: /Details/ }))
    expect(await screen.findByText('No additional details recorded yet.')).toBeTruthy()
  })
})

// V3-IA: Plantings page retired — the Edit affordance must deep-link into the Garden editor.
describe('PlantingDetail — V3-EDIT-001 edit affordance', () => {
  it('Edit links to /garden?edit=<plantingId>', async () => {
    apiFetchSpy.mockImplementation((path) => {
      if (path.startsWith('/api/plants/')) return Promise.resolve(PLANTING)
      if (path.startsWith('/api/events')) return Promise.resolve(EVENTS)
      return Promise.resolve(null)
    })
    renderAt()
    await screen.findByRole('heading', { name: 'Megatron Jalapeno' })
    const link = screen.getByLabelText('Edit this planting')
    expect(link.getAttribute('href')).toBe('/garden?edit=pl1')
  })
})

describe('PlantingDetail — V3-PHOTOMULTI-001 photos widget (V1 display-only)', () => {
  // V4-PHOTOGALLERY-001: the gallery is fed by the attachment-scoped ?attachedTo=<plantingId> fetch.
  // Exclusion of other plantings' photos is now the SERVER's job (WHERE plant_id = P OR event-of-P),
  // so the server returns exactly ph1 (plant_id) + ph2 (event); the client only de-dups + sorts.
  it('feeds the Photos section from the ?attachedTo fetch (server-scoped union), not the project fetch', async () => {
    // Server returns only the attached union — ph3 (other planting) is excluded server-side, so it is
    // never in the response the client sees.
    const ATTACHED = [
      { id: 'ph1', plant_id: 'pl1', event_id: null, view_url: 'https://img/ph1.jpg', caption: 'Seedling' },
      { id: 'ph2', plant_id: null, event_id: 'e2', view_url: 'https://img/ph2.jpg', caption: null },
    ]
    apiFetchSpy.mockImplementation((path) => {
      if (path.startsWith('/api/plants/')) return Promise.resolve(PLANTING)
      if (path.startsWith('/api/events')) return Promise.resolve(EVENTS)
      if (path.startsWith('/api/photos')) return Promise.resolve(ATTACHED)
      return Promise.resolve(null)
    })
    renderAt()
    await screen.findByRole('heading', { name: 'Megatron Jalapeno' })
    expect(await screen.findByRole('heading', { name: /Photos/ })).toBeTruthy()
    // Contract: the photo fetch is planting-attachment-scoped, NOT container(project)-scoped — this is
    // the fix (a plant_id-attached photo in a different container must not be dropped by a project fetch).
    expect(apiFetchSpy).toHaveBeenCalledWith('/api/photos?attachedTo=pl1')
    expect(apiFetchSpy).not.toHaveBeenCalledWith('/api/photos?project_id=proj1')
    // ph1 (plant_id) renders its caption; ph2 (event e2, no caption) once events load -> by alt.
    expect((await screen.findAllByText('Seedling')).length).toBeGreaterThan(0)
    // V200 Slice 5b: the GrowthStrip compare/thumbs render the same photos as the Photos grid,
    // so each photo's alt can appear more than once — assert presence, not a single match.
    expect((await screen.findAllByAltText('Seedling')).length).toBeGreaterThan(0)
    expect((await screen.findAllByAltText('Megatron Jalapeno photo')).length).toBeGreaterThan(0)
  })

  it('V4-PHOTOFEATURE-001: shows Set as featured on a photo and PUTs featured_photo_id', async () => {
    const PHOTOS = [{ id: 'ph1', plant_id: 'pl1', event_id: null, view_url: 'https://img/ph1.jpg', caption: 'Seedling' }]
    const putCalls = []
    apiFetchSpy.mockImplementation((path, opts) => {
      if (opts?.method === 'PUT' && path.startsWith('/api/plants/')) { putCalls.push(JSON.parse(opts.body)); return Promise.resolve({ featured_photo_id: 'ph1' }) }
      if (path.startsWith('/api/plants/')) return Promise.resolve(PLANTING)
      if (path.startsWith('/api/events')) return Promise.resolve(EVENTS)
      if (path.startsWith('/api/photos')) return Promise.resolve(PHOTOS)
      return Promise.resolve(null)
    })
    renderAt()
    const btn = await screen.findByRole('button', { name: /Set as featured/i })
    fireEvent.click(btn)
    await waitFor(() => expect(putCalls).toContainEqual({ featured_photo_id: 'ph1' }))
  })
})


describe('PlantingDetail — V3-ARCHIVE-001 archived restore path', () => {
  it('archived planting shows the Archived badge + Unarchive, and Unarchive PATCHes /archive {archived:false}', async () => {
    const patchCalls = []
    apiFetchSpy.mockImplementation((path, opts) => {
      if (typeof path === 'string' && path.endsWith('/archive')) { patchCalls.push([path, opts]); return Promise.resolve({ archived_at: null }) }
      if (path.startsWith('/api/plants/')) return Promise.resolve({ ...PLANTING, archived_at: '2026-06-20T00:00:00Z' })
      if (path.startsWith('/api/events')) return Promise.resolve(EVENTS)
      return Promise.resolve(null)
    })
    renderAt()
    await screen.findByRole('heading', { name: 'Megatron Jalapeno' })
    expect(screen.getByText('Archived')).toBeTruthy()
    const btn = screen.getByRole('button', { name: /Unarchive this planting/i })
    await act(async () => { fireEvent.click(btn); await Promise.resolve() })
    expect(patchCalls.length).toBe(1)
    expect(patchCalls[0][0]).toBe('/api/plants/pl1/archive')
    expect(JSON.parse(patchCalls[0][1].body)).toEqual({ archived: false })
    await waitFor(() => expect(screen.queryByText('Archived')).toBeNull())
  })

  it('non-archived planting shows neither the Archived badge nor Unarchive', async () => {
    apiFetchSpy.mockImplementation((path) => {
      if (path.startsWith('/api/plants/')) return Promise.resolve(PLANTING)
      if (path.startsWith('/api/events')) return Promise.resolve(EVENTS)
      return Promise.resolve(null)
    })
    renderAt()
    await screen.findByRole('heading', { name: 'Megatron Jalapeno' })
    expect(screen.queryByText('Archived')).toBeNull()
    expect(screen.queryByRole('button', { name: /Unarchive/i })).toBeNull()
  })
})

// V4-ARCHIVEINPLACE-001 (BD0806-23) — the forward half of the archive pair, on the planting page.
// Before this, archiving meant Edit -> /garden?edit=<id> -> open the details disclosure -> Archive,
// four steps to reach a control whose UNDO already lived on this page.
describe('PlantingDetail — V4-ARCHIVEINPLACE-001 archive in place', () => {
  it('Archive PATCHes /archive {archived:true} and flips the page to the archived shape in place', async () => {
    const patchCalls = []
    apiFetchSpy.mockImplementation((path, opts) => {
      if (typeof path === 'string' && path.endsWith('/archive')) {
        patchCalls.push([path, opts])
        return Promise.resolve({ archived_at: '2026-06-20T00:00:00Z' })
      }
      if (path.startsWith('/api/plants/')) return Promise.resolve(PLANTING)
      if (path.startsWith('/api/events')) return Promise.resolve(EVENTS)
      return Promise.resolve(null)
    })
    renderAt()
    await screen.findByRole('heading', { name: 'Megatron Jalapeno' })
    const btn = screen.getByRole('button', { name: /^Archive this planting$/i })
    await act(async () => { fireEvent.click(btn); await Promise.resolve() })
    expect(patchCalls.length).toBe(1)
    expect(patchCalls[0][0]).toBe('/api/plants/pl1/archive')
    expect(patchCalls[0][1].method).toBe('PATCH')
    expect(JSON.parse(patchCalls[0][1].body)).toEqual({ archived: true })
    // STAY-IN-PLACE contract: no navigation away. The badge + the reverse control appear in the
    // row the Archive button just vacated, so the undo is permanent rather than a timed race.
    await waitFor(() => expect(screen.getByText('Archived')).toBeTruthy())
    expect(screen.getByRole('button', { name: /Unarchive this planting/i })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Megatron Jalapeno' })).toBeTruthy()
    expect(screen.queryByText('PROJECT PAGE')).toBeNull()
    expect(screen.queryByText('GARDEN PAGE')).toBeNull()
    // The two directions are never offered at once. Anchored — an unanchored /Archive this
    // planting/i is a SUBSTRING of "Unarchive this planting" and would pass vacuously.
    expect(screen.queryByRole('button', { name: /^Archive this planting$/i })).toBeNull()
  })

  // The recon-flagged collision: PlantingDetail.test.jsx already pins queryByRole(/Unarchive/i) as
  // null on a live planting. A control named plain "Archive" would satisfy that, but the reverse
  // query on an ARCHIVED planting must not become ambiguous either. Pin both directions.
  it('the two controls have mutually exclusive accessible names, one per archived state', async () => {
    apiFetchSpy.mockImplementation((path) => {
      if (path.startsWith('/api/plants/')) return Promise.resolve({ ...PLANTING, archived_at: '2026-06-20T00:00:00Z' })
      if (path.startsWith('/api/events')) return Promise.resolve(EVENTS)
      return Promise.resolve(null)
    })
    renderAt()
    await screen.findByRole('heading', { name: 'Megatron Jalapeno' })
    // Archived: exactly the reverse control, and the forward one is gone.
    expect(screen.getAllByRole('button', { name: /Unarchive this planting/i })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: /^Archive this planting$/i })).toBeNull()
  })

  it('a failed archive says so and leaves the planting live — never a silent no-op', async () => {
    apiFetchSpy.mockImplementation((path) => {
      if (typeof path === 'string' && path.endsWith('/archive')) return Promise.reject(new Error('nope'))
      if (path.startsWith('/api/plants/')) return Promise.resolve(PLANTING)
      if (path.startsWith('/api/events')) return Promise.resolve(EVENTS)
      return Promise.resolve(null)
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    renderAt()
    await screen.findByRole('heading', { name: 'Megatron Jalapeno' })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Archive this planting$/i })); await Promise.resolve() })
    // Still live: no badge, and the control comes back out of its in-flight state.
    await waitFor(() => expect(screen.getByRole('button', { name: /^Archive this planting$/i }).textContent).toContain('Archive'))
    expect(screen.queryByText('Archived')).toBeNull()
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })
})

// V4-PLANTQTY-001 — the quantity was already rendered, but only inside the Details fly-up. These
// pin it ABOVE THE FOLD (in the hero overlay, alongside the <h1>) with the ×1 gate intact.
describe('PlantingDetail — V4-PLANTQTY-001 quantity above the fold', () => {
  it('renders ×<quantity> in the hero overlay without opening the Details fly-up', async () => {
    apiFetchSpy.mockImplementation((path) => {
      if (path.startsWith('/api/plants/')) return Promise.resolve(PLANTING)   // quantity: 3
      if (path.startsWith('/api/events')) return Promise.resolve(EVENTS)
      return Promise.resolve(null)
    })
    renderAt()
    const h1 = await screen.findByRole('heading', { name: 'Megatron Jalapeno' })
    const pill = screen.getByTestId('hero-quantity')
    expect(pill.textContent).toBe('×3')
    // "Above the fold" concretely: same hero bottom-overlay container as the page <h1>, and
    // reachable with the Details sheet still closed (Sheet renders null until opened).
    expect(h1.parentElement.contains(pill)).toBe(true)
    expect(screen.getAllByText('×3')).toHaveLength(1)
  })

  it('hides the pill at ×1 — the same gate PlantingTile and PlantingSelect use', async () => {
    apiFetchSpy.mockImplementation((path) => {
      if (path.startsWith('/api/plants/')) return Promise.resolve({ ...PLANTING, quantity: 1, qty_initial: null })
      if (path.startsWith('/api/events')) return Promise.resolve(EVENTS)
      return Promise.resolve(null)
    })
    renderAt()
    await screen.findByRole('heading', { name: 'Megatron Jalapeno' })
    expect(screen.queryByTestId('hero-quantity')).toBeNull()
    expect(screen.queryByText('×1')).toBeNull()
  })

  // numeric(N,3) serializes through the pg driver as "3.000"; the gate compares the raw value and
  // formatQty rounds for display, so a string from the wire must render exactly like a number.
  it('renders the wire form ("6.000") as ×6', async () => {
    apiFetchSpy.mockImplementation((path) => {
      if (path.startsWith('/api/plants/')) return Promise.resolve({ ...PLANTING, quantity: '6.000' })
      if (path.startsWith('/api/events')) return Promise.resolve(EVENTS)
      return Promise.resolve(null)
    })
    renderAt()
    await screen.findByRole('heading', { name: 'Megatron Jalapeno' })
    expect(screen.getByTestId('hero-quantity').textContent).toBe('×6')
  })
})


// Slice 5a — live care band (CareStatus wired between the title row and QuickActions).
describe('PlantingDetail — Slice 5a care band', () => {
  it('renders the Overdue care band when the by-id record has a past next_water_at', async () => {
    const past = new Date(Date.now() - 3 * 86400000 - 5000).toISOString()
    apiFetchSpy.mockImplementation((path) => {
      if (path.startsWith('/api/plants/')) return Promise.resolve({ ...PLANTING, next_water_at: past, location_type: 'outdoor_bed' })
      if (path.startsWith('/api/events')) return Promise.resolve(EVENTS)
      return Promise.resolve(null)
    })
    renderAt()
    await screen.findByRole('heading', { name: 'Megatron Jalapeno' })
    expect(await screen.findByText(/Overdue|Due today/)).toBeTruthy()
  })

  it('renders NO care band when next_water_at is null (calm)', async () => {
    apiFetchSpy.mockImplementation((path) => {
      if (path.startsWith('/api/plants/')) return Promise.resolve({ ...PLANTING, next_water_at: null })
      if (path.startsWith('/api/events')) return Promise.resolve(EVENTS)
      return Promise.resolve(null)
    })
    renderAt()
    await screen.findByRole('heading', { name: 'Megatron Jalapeno' })
    expect(screen.queryByText(/Overdue|Due today/)).toBeNull()
  })
})

describe('PlantingDetail — V4-HARVESTVIEW-001 S4b "All harvests →"', () => {
  it('links the Harvested block to the crop-filtered Harvests page when the crop key resolves', async () => {
    const planting = { ...PLANTING, variety_ref: { name: 'Sungold', crop_type_slug: 'tomato' } }
    apiFetchSpy.mockImplementation((path) => {
      if (path.startsWith('/api/plants/')) return Promise.resolve(planting)
      if (path.startsWith('/api/events')) return Promise.resolve([])
      return Promise.resolve(null)
    })
    renderAt()
    const link = await screen.findByRole('link', { name: /All harvests/ })
    expect(link.getAttribute('href')).toBe('/harvests?crop=tomato')
  })

  it('omits the link when the planting has no crop key (nothing to filter by)', async () => {
    apiFetchSpy.mockImplementation((path) => {
      if (path.startsWith('/api/plants/')) return Promise.resolve(PLANTING) // variety_ref has no crop_type_slug
      if (path.startsWith('/api/events')) return Promise.resolve([])
      return Promise.resolve(null)
    })
    renderAt()
    await screen.findByRole('heading', { name: 'Megatron Jalapeno' })
    expect(screen.queryByRole('link', { name: /All harvests/ })).toBeNull()
  })
})
