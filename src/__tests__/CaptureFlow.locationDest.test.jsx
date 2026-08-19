// V4-SNAPDEST-001 (BD0806-08) — the "log on a location" Snap destination.
//
// WHY IT EXISTS: Snap could only aim a photo at a PLANTING or an inventory item. Anything about the
// place itself — a washed-out bed edge, a leaning trellis, a new fence line — had no destination, so
// it got logged against whichever planting happened to be nearby. That is not a missing convenience;
// it is a photo filed against a plant it is not a photo of.
//
// BUG-LOCEVENT400-001 CORRECTION. This file used to assert that the destination POSTs an event with
// location_id set and plant_id AND project_id both null, on the stated grounds that "the events
// Lambda requires only event_type … so this shape is supported, not a hole". That was FALSE, and
// this file's fetch mock — which resolved POST /api/events to { id: 'ev-loc' } — is what made the
// falsehood invisible: validatePostBody rejects a parentless body outright, and prod's
// event_log_has_anchor CHECK has no location arm either, so every save 400'd from the day it
// shipped. The destination now writes the photo straight onto the location, which
// photos_must_have_parent admits as a parent in its own right and which LocationDetail already reads
// via /api/photos?location_id=. The client↔server join is pinned in CaptureFlow.eventContract.test.jsx,
// which runs the real validator over the bodies this component actually sends; this file keeps the
// destination's own behaviour (which places are offered, where the photo lands, and that 'inventory'
// is still the LAST destination, because the same ledger row that asked for this one also asked for
// Add Inventory to sit at the bottom and a naive append would have undone it).
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

  it('writes no event at all — there is no parent the server would accept', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-location')
    await act(async () => { fireEvent.change(screen.getByTestId('cap-locplace'), { target: { value: 'loc-1' } }) })
    await act(async () => { fireEvent.click(screen.getByTestId('cap-save')) })
    await waitFor(() => expect(uploadSpy).toHaveBeenCalled())
    // The save DID land (uploadSpy fired), so this is an absence with a save behind it, not a save
    // that silently never happened.
    expect(fetchSpy.mock.calls.some(([p, o]) => p === '/api/events' && o?.method === 'POST')).toBe(false)
  })

  it('attaches the photo to the LOCATION, which is a parent in its own right', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-location')
    await act(async () => { fireEvent.change(screen.getByTestId('cap-locplace'), { target: { value: 'loc-2' } }) })
    await act(async () => { fireEvent.click(screen.getByTestId('cap-save')) })
    await waitFor(() => expect(uploadSpy).toHaveBeenCalled())
    const [, opts] = uploadSpy.mock.calls[0]
    // location_id satisfies photos_must_have_parent on its own, and /api/photos?location_id= — the
    // grid LocationDetail already renders — is what makes the row readable once written.
    expect(opts.linkage).toEqual({ location_id: 'loc-2' })
    expect(opts.keyPrefix).toBe('locations')
    expect(opts.parentId).toBe('loc-2')
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
