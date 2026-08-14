// V4-SNAPDEST-001 (BD0806-08) — the "log on a location" Snap destination.
//
// WHY IT EXISTS: Snap could only aim a photo at a PLANTING or an inventory item. Anything about the
// place itself — a washed-out bed edge, a leaning trellis, a new fence line — had no destination, so
// it got logged against whichever planting happened to be nearby. That is not a missing convenience;
// it is a photo filed against a plant it is not a photo of.
//
// The three assertions that matter here are the ones a reviewer would otherwise have to take on
// trust: that the POST carries location_id with plant_id AND project_id explicitly null (the events
// Lambda requires only event_type and ownership-checks location_id, so this shape is supported, not
// a hole); that the photo's linkage carries the location as well as the event; and that 'inventory'
// is still the LAST destination, because the same ledger row that asked for this one also asked for
// Add Inventory to sit at the bottom and a naive append would have undone it.
// No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

const { fetchSpy, uploadSpy, navigateSpy } = vi.hoisted(() => ({
  fetchSpy: vi.fn(), uploadSpy: vi.fn(), navigateSpy: vi.fn(),
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: uploadSpy, isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateSpy,
  Link: ({ children, to }) => <a href={typeof to === 'string' ? to : '#'}>{children}</a>,
}))

import CaptureFlow from '../pages/CaptureFlow.jsx'

const LOCS = [
  { id: 'loc-1', full_path: 'Back garden › Bed 3', level: 2, is_active: true },
  { id: 'loc-2', full_path: 'Greenhouse', level: 1, is_active: true },
  // Inactive locations are filtered on load — logging against a retired bed is not a thing to offer.
  { id: 'loc-3', full_path: 'Old nursery row', level: 1, is_active: false },
]

beforeEach(() => {
  fetchSpy.mockReset(); uploadSpy.mockReset(); navigateSpy.mockReset()
  global.URL.createObjectURL = vi.fn(() => 'blob:preview')
  global.URL.revokeObjectURL = vi.fn()
  uploadSpy.mockResolvedValue({ photo: { id: 'photo-1' } })
  fetchSpy.mockImplementation((path, options = {}) => {
    const m = options.method ?? 'GET'
    if (m === 'GET' && path === '/api/plants') return Promise.resolve([{ id: 'pl-1', name: 'Basil', project_id: 'proj-9' }])
    if (m === 'GET' && path === '/api/locations/with-path') return Promise.resolve(LOCS)
    if (m === 'POST' && path === '/api/events') return Promise.resolve({ id: 'ev-loc' })
    return Promise.resolve({ ok: true })
  })
})

async function snapTo(modeTestId) {
  await waitFor(() => expect(screen.getByTestId('capture-input')).toBeDefined())
  const file = new File(['x'], 'snap.jpg', { type: 'image/jpeg' })
  await act(async () => { fireEvent.change(screen.getByTestId('capture-input'), { target: { files: [file] } }) })
  await act(async () => { fireEvent.click(screen.getByTestId(modeTestId)) })
}

const postBody = (path) => JSON.parse(fetchSpy.mock.calls.find(
  ([p, o]) => p === path && o?.method === 'POST')[1].body)

describe('CaptureFlow — log on a location (V4-SNAPDEST-001)', () => {
  it('offers the destination, and keeps Add inventory LAST', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await waitFor(() => expect(screen.getByTestId('capture-input')).toBeDefined())
    const file = new File(['x'], 'snap.jpg', { type: 'image/jpeg' })
    await act(async () => { fireEvent.change(screen.getByTestId('capture-input'), { target: { files: [file] } }) })
    const ids = Array.from(document.querySelectorAll('[data-testid^="mode-"]'))
      .map((b) => b.getAttribute('data-testid'))
    expect(ids).toContain('mode-location')
    // The row asked for BOTH: a location destination AND inventory at the bottom.
    expect(ids[ids.length - 1]).toBe('mode-inventory')
  })

  it('lists only ACTIVE locations, by full path', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-location')
    const opts = Array.from(screen.getByTestId('cap-locplace').querySelectorAll('option'))
      .map((o) => o.textContent)
    expect(opts).toContain('Back garden › Bed 3')
    expect(opts).toContain('Greenhouse')
    expect(opts).not.toContain('Old nursery row')
  })

  it('POSTs a place-scoped event: location_id set, plant_id and project_id explicitly null', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-location')
    await act(async () => { fireEvent.change(screen.getByTestId('cap-locplace'), { target: { value: 'loc-1' } }) })
    await act(async () => { fireEvent.click(screen.getByTestId('cap-save')) })
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/events', expect.objectContaining({ method: 'POST' })))
    const body = postBody('/api/events')
    expect(body.location_id).toBe('loc-1')
    // NULL, not absent: the whole point is that this event belongs to a place and to no planting.
    expect(body.plant_id).toBeNull()
    expect(body.project_id).toBeNull()
    expect(body.event_type).toBe('observation')
  })

  it('attaches the photo to the event AND carries the location on the linkage', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-location')
    await act(async () => { fireEvent.change(screen.getByTestId('cap-locplace'), { target: { value: 'loc-2' } }) })
    await act(async () => { fireEvent.click(screen.getByTestId('cap-save')) })
    await waitFor(() => expect(uploadSpy).toHaveBeenCalled())
    const [, opts] = uploadSpy.mock.calls[0]
    // event_id is the photos_must_have_parent parent; location_id is what the photo is OF.
    expect(opts.linkage).toEqual({ event_id: 'ev-loc', location_id: 'loc-2' })
    expect(opts.keyPrefix).toBe('events')
  })

  it('refuses to save with no location picked — and posts nothing', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-location')
    await act(async () => { fireEvent.click(screen.getByTestId('cap-save')) })
    expect(fetchSpy.mock.calls.some(([p, o]) => p === '/api/events' && o?.method === 'POST')).toBe(false)
    expect(uploadSpy).not.toHaveBeenCalled()
  })

  it('does not disturb the planting destination it sits beside', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-event')
    expect(screen.getByTestId('cap-evplant')).toBeDefined()
    // The location fields must NOT be on the planting-event form — separate state, separate step.
    expect(document.querySelector('[data-testid="cap-locplace"]')).toBeNull()
  })
})
