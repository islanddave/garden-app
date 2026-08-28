// V4-EVENTDETAILRICH-001 (BD0806-18) — the read view is a SUBSET of the planting page.
//
// Pins the four halves of the ask: the planting anchor, the harvest amount + weight, the photos,
// and the removal of the repeated Type row.
//
// ⚠️ THE CROSS-LANE CONTRACT IS THE REASON THIS FILE HAS THREE PLANTING FIXTURES.
// `planting_name` is served by GET /api/events/:id — a SIBLING LANE's one-line SELECT widening, on a
// SEPARATE (earlier) deploy. So this client must be correct in three states, not two:
//   • present  — the wired-together world
//   • null     — the server says "this event has no planting anchor"
//   • ABSENT   — the key is missing because the Lambda half has not shipped yet (or an old Lambda is
//                paired with a new bundle). Absent MUST behave exactly as null.
// The absent case is the one a two-lane fleet gets wrong, and it is the one that would ship
// `undefined` under a "Planting" label, so it is asserted explicitly rather than assumed.
//
// No jest-dom (L-182) — plain DOM assertions throughout.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const { apiFetchSpy, dataRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  dataRef: { event: null },
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))
vi.mock('../context/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: vi.fn(), isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))

import EventDetail from '../pages/EventDetail.jsx'
import { __resetPhotoImgCache } from '../components/PhotoImg.jsx'

// A harvest event, wired the way the GET actually returns one: `quantity` is the FREE-TEXT
// event_log note, `harvest` is the harvest_log row the Harvests page totals. Conflating the two is
// the original defect.
const HARVEST = {
  id: 'e1', project_id: null, plant_id: 'g1', event_type: 'harvest',
  event_date: '2026-08-01T12:00:00.000Z', title: null,
  notes: null, private_notes: null, quantity: null, is_public: true,
  metadata: null, flagged_as_issue: false, severity: null, resolved_at: null,
  planting_name: 'Sungold cherry',
  harvest: { id: 'h1', quantity: 6, unit: 'count', quality_rating: null, weight_grams: 492, weight_estimated: true, weight_basis: 'cultivar_sample' },
}

const OBSERVATION = {
  id: 'e1', project_id: null, plant_id: null, event_type: 'pest_treatment',
  event_date: '2026-05-10T12:00:00.000Z', title: 'Spider mites',
  notes: null, private_notes: null, quantity: null, is_public: true,
  metadata: null, flagged_as_issue: false, severity: null, resolved_at: null,
  planting_name: null, harvest: null,
}

beforeEach(() => {
  apiFetchSpy.mockReset()
  __resetPhotoImgCache()
  dataRef.event = { ...HARVEST }
  apiFetchSpy.mockImplementation((path) => {
    if (path === '/api/events/e1') return Promise.resolve(dataRef.event)
    if (path.startsWith('/api/photos/view-url/')) {
      // BUG-TIERLESSPHOTOS-001: the mint URL now carries `?tier=thumb`, so the id is the path
      // SEGMENT — `split('/').pop()` would yield 'ph-1?tier=thumb' and fabricate a plausible-looking
      // but wrong src.
      const id = String(path).slice('/api/photos/view-url/'.length).split('?')[0]
      return Promise.resolve({ view_url: `https://example.test/${id}.jpg` })
    }
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

// ── The planting anchor + the cross-lane contract ────────────────────────────────────────────────
describe('EventDetail — planting anchor (cross-lane `planting_name` contract)', () => {
  it('renders the planting name from `planting_name`, linked to the canonical planting route', async () => {
    await renderDetail()
    const block = screen.getByTestId('event-planting')
    expect(block.textContent).toContain('Sungold cherry')
    const link = screen.getByRole('link', { name: /Sungold cherry/ })
    expect(link.getAttribute('href')).toBe('/plantings/g1')
  })

  it('renders the name WITHOUT a link when the event carries no plant_id', async () => {
    dataRef.event = { ...HARVEST, plant_id: null }
    await renderDetail()
    expect(screen.getByTestId('event-planting').textContent).toContain('Sungold cherry')
    expect(screen.queryByRole('link', { name: /Sungold cherry/ })).toBeNull()
  })

  it('renders the UN-ANCHORED case when `planting_name` is null', async () => {
    dataRef.event = { ...HARVEST, planting_name: null }
    await renderDetail()
    expect(screen.queryByTestId('event-planting')).toBeNull()
    expect(screen.queryByText(/Planting/)).toBeNull()
  })

  it('treats an ABSENT `planting_name` exactly as null — the pre-server-deploy window', async () => {
    // The sibling lane's Lambda has not shipped: the key is simply not on the payload.
    const { planting_name: _omitted, ...withoutKey } = HARVEST
    dataRef.event = withoutKey
    await renderDetail()
    expect(screen.queryByTestId('event-planting')).toBeNull()
    // The failure this guards: an unguarded render puts the literal "undefined" under a label.
    expect(document.body.textContent).not.toMatch(/undefined/)
    // The rest of the page must still be fully functional on the old payload.
    expect(screen.getByTestId('event-harvest-amount').textContent).toBe('6')
  })

  it('treats a blank/whitespace name as absent rather than rendering an empty labelled row', async () => {
    dataRef.event = { ...HARVEST, planting_name: '   ' }
    await renderDetail()
    expect(screen.queryByTestId('event-planting')).toBeNull()
  })
})

// ── "Drop the repeated type field" ───────────────────────────────────────────────────────────────
describe('EventDetail — the repeated Type row is gone', () => {
  it('renders NO Type row in the read view', async () => {
    await renderDetail()
    expect(screen.queryByText('TYPE')).toBeNull()
    expect(screen.queryByText('Type')).toBeNull()
  })

  it('states the type exactly ONCE — as the heading itself when the event has no title', async () => {
    await renderDetail()          // HARVEST has title: null
    expect(screen.queryByTestId('event-type-kicker')).toBeNull()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('harvest')
  })

  it('keeps the type in words as a header kicker when a title occupies the heading', async () => {
    dataRef.event = { ...OBSERVATION }
    await renderDetail()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Spider mites')
    // Humanised, not the raw schema token.
    expect(screen.getByTestId('event-type-kicker').textContent).toBe('pest treatment')
  })
})

// ── The harvest readout ──────────────────────────────────────────────────────────────────────────
describe('EventDetail — harvest amount and weight (the sparse case Dave named)', () => {
  it('renders a count amount as a bare number, never as "6 count"', async () => {
    await renderDetail()
    expect(screen.getByTestId('event-harvest-amount').textContent).toBe('6')
    expect(document.body.textContent).not.toMatch(/6 count/)
  })

  it('renders a mass amount with its unit', async () => {
    dataRef.event = { ...HARVEST, harvest: { ...HARVEST.harvest, quantity: 2.5, unit: 'lb' } }
    await renderDetail()
    expect(screen.getByTestId('event-harvest-amount').textContent).toBe('2.5 lb')
  })

  it('marks an ESTIMATED weight with ≈ and spells the provenance out as VISIBLE TEXT', async () => {
    await renderDetail()
    expect(screen.getByTestId('event-harvest-weight').textContent).toBe('≈ 492 g')
    // The whole point: Dave is on Chrome/Android, where a title= tooltip never fires on touch. The
    // sentence must be in the document's TEXT, not only in an attribute.
    const basis = screen.getByTestId('event-harvest-weight-basis')
    expect(basis.textContent).toMatch(/your own weighings of this variety/i)
    expect(screen.getByText(/your own weighings of this variety/i)).toBeTruthy()
  })

  it('renders a MEASURED weight with no ≈ and says so plainly', async () => {
    dataRef.event = { ...HARVEST, harvest: { ...HARVEST.harvest, weight_estimated: false, weight_basis: 'measured' } }
    await renderDetail()
    expect(screen.getByTestId('event-harvest-weight').textContent).toBe('492 g')
    expect(screen.getByTestId('event-harvest-weight-basis').textContent).toBe('Weighed.')
  })

  it('renders the ratchet copy — not an error — when nothing is weighable', async () => {
    dataRef.event = { ...HARVEST, harvest: { ...HARVEST.harvest, weight_grams: null, weight_estimated: null, weight_basis: null } }
    await renderDetail()
    expect(screen.queryByTestId('event-harvest-weight')).toBeNull()
    expect(screen.getByTestId('event-harvest-weight-none').textContent).toMatch(/No weight yet/i)
  })

  it('falls back to generic provenance copy for an unknown future weight_basis', async () => {
    dataRef.event = { ...HARVEST, harvest: { ...HARVEST.harvest, weight_basis: 'cultivar_lab_assay' } }
    await renderDetail()
    expect(screen.getByTestId('event-harvest-weight-basis').textContent).toBe('Currently estimated.')
    expect(document.body.textContent).not.toMatch(/undefined/)
  })

  it('says so when a harvest was logged with no amount recorded', async () => {
    dataRef.event = { ...HARVEST, harvest: { ...HARVEST.harvest, quantity: null } }
    await renderDetail()
    expect(screen.getByTestId('event-harvest-amount').textContent).toMatch(/no amount recorded/i)
  })

  it('renders NO harvest block for a non-harvest event', async () => {
    dataRef.event = { ...OBSERVATION }
    await renderDetail()
    expect(screen.queryByTestId('event-harvest')).toBeNull()
  })

  it('renders NO harvest block for a harvest event with no paired harvest_log row', async () => {
    dataRef.event = { ...HARVEST, harvest: null }
    await renderDetail()
    expect(screen.queryByTestId('event-harvest')).toBeNull()
  })

  it('keeps the free-text event Quantity note distinct from the harvest amount', async () => {
    dataRef.event = { ...HARVEST, quantity: 'first real pick' }
    await renderDetail()
    expect(screen.getByTestId('event-harvest-amount').textContent).toBe('6')
    expect(screen.getByText('first real pick')).toBeTruthy()
  })
})

// ── Photos ───────────────────────────────────────────────────────────────────────────────────────
describe('EventDetail — the event’s own photos', () => {
  const PHOTOS = [
    { id: 'ph-1', storage_path: 'events/e1/a.jpg', cover_for: [] },
    { id: 'ph-2', storage_path: 'events/e1/b.jpg', cover_for: [] },
  ]

  it('renders one tappable thumb per photo and counts them', async () => {
    dataRef.event = { ...HARVEST, photos: PHOTOS }
    await renderDetail()
    const block = screen.getByTestId('event-photos')
    expect(block.textContent).toContain('(2)')
    expect(screen.getAllByRole('button', { name: /^Open photo/ }).length).toBe(2)
  })

  it('resolves each id-only thumb through the photos view-url route (no view_url on the event GET)', async () => {
    // `?tier=thumb` since BUG-TIERLESSPHOTOS-001. The bare path was not neutral spelling: absent
    // tier means 'full' server-side, so it pinned the ~4.15 MB original into a 96 px box. The
    // degrade that makes the thumb safe on this arm is pinned in EventDetail.photoPrimitive.test.jsx.
    dataRef.event = { ...HARVEST, photos: PHOTOS }
    await renderDetail()
    await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/photos/view-url/ph-1?tier=thumb', expect.anything()))
    await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/photos/view-url/ph-2?tier=thumb', expect.anything()))
  })

  it('opens the shared Lightbox on tap', async () => {
    dataRef.event = { ...HARVEST, photos: PHOTOS }
    await renderDetail()
    expect(screen.queryByTestId('lightbox-image')).toBeNull()
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: /^Open photo/ })[1]) })
    expect(screen.getByTestId('lightbox-image')).toBeTruthy()
  })

  it('renders no photos block when the event has none, and tolerates the key being absent', async () => {
    dataRef.event = { ...HARVEST, photos: [] }
    await renderDetail()
    expect(screen.queryByTestId('event-photos')).toBeNull()
  })

  it('tolerates an event payload with no `photos` key at all', async () => {
    const { photos: _omitted, ...withoutKey } = { ...HARVEST, photos: [] }
    dataRef.event = withoutKey
    await renderDetail()
    expect(screen.queryByTestId('event-photos')).toBeNull()
  })
})
