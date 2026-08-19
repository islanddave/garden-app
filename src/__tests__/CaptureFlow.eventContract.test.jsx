// BUG-LOCEVENT400-001 — the guard that makes CaptureFlow and the events Lambda fail TOGETHER.
//
// This contract has now split TWICE. BUG-CAPTUREFLOW400-001 was the first: CaptureFlow POSTed an
// event for a project-less planting while validatePostBody demanded `project_id`, so every save
// 400'd. The relaxation to "project_id OR plant_id" fixed that instance and left the *mechanism*
// intact, and V4-SNAPDEST-001 promptly split it again by shipping a location destination that sent
// NEITHER id — 400 on every save from the day it shipped, in a destination Dave had asked for.
//
// Both halves were tested, and both suites were green the whole time. That is the actual defect:
//   - CaptureFlow.locationDest.test.jsx mocked POST /api/events to resolve { id: 'ev-loc' } and
//     asserted the client sent plant_id null and project_id null, calling that shape "supported".
//   - lambda/events/index.test.js asserted the same shape is rejected.
// Neither could ever observe the other. A test that pins one side is how a contract splits a third
// time, so this file pins the JOIN: it drives the real component and runs the bodies it actually
// sends through the real server validator, imported — not re-described, not mocked.
//
// The Lambda-side import is established precedent in this directory (sowEngine, preservation*,
// slugUniverseConsistency all import from ../../lambda/). validators.js was extracted precisely so
// it could be imported without dragging in neon/clerk/aws.
// No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { validatePostBody } from '../../lambda/events/validators.js'

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

const LOCS = [{ id: 'loc-1', full_path: 'Back garden › Bed 3', level: 2, is_active: true }]
const PLANTS = [{ id: 'pl-1', name: 'Basil', project_id: 'proj-9' }]

beforeEach(() => {
  fetchSpy.mockReset(); uploadSpy.mockReset(); navigateSpy.mockReset()
  global.URL.createObjectURL = vi.fn(() => 'blob:preview')
  global.URL.revokeObjectURL = vi.fn()
  uploadSpy.mockResolvedValue({ photo: { id: 'photo-1' } })
  fetchSpy.mockImplementation((path, options = {}) => {
    const m = options.method ?? 'GET'
    if (m === 'GET' && path === '/api/plants') return Promise.resolve(PLANTS)
    if (m === 'GET' && path === '/api/locations/with-path') return Promise.resolve(LOCS)
    if (m === 'POST' && path === '/api/events') return Promise.resolve({ id: 'ev-1' })
    if (m === 'POST' && path === '/api/plants') return Promise.resolve({ id: 'pl-new', name: 'Charentais' })
    return Promise.resolve({ ok: true })
  })
})

const eventPosts = () => fetchSpy.mock.calls
  .filter(([p, o]) => p === '/api/events' && o?.method === 'POST')
  .map(([, o]) => JSON.parse(o.body))

async function snapTo(modeTestId) {
  await waitFor(() => expect(screen.getByTestId('capture-input')).toBeDefined())
  const file = new File(['x'], 'snap.jpg', { type: 'image/jpeg' })
  await act(async () => { fireEvent.change(screen.getByTestId('capture-input'), { target: { files: [file] } }) })
  await act(async () => { fireEvent.click(screen.getByTestId(modeTestId)) })
}

// V4-PLANTPICKER-001: the shared combobox opens on focus; pick by clicking the option row. A plain
// fireEvent.change on the testid is a no-op here and would leave the destination unsaved — i.e. an
// event-body assertion with no event body, which is the vacuum this file exists to avoid.
async function pickPlanting(testid) {
  await act(async () => { fireEvent.focus(screen.getByTestId(testid)) })
  await act(async () => { fireEvent.click(await screen.findByTestId('ps-opt-pl-1')) })
}

describe('CaptureFlow ↔ events Lambda — one contract, both halves', () => {
  // NON-VACUITY. Everything below is an assertion that the REAL validator accepts something, and an
  // assertion of that shape is worthless if the import silently resolved to a stub, or if the
  // validator can no longer reject anything. So first: prove this exact imported function still
  // fails, on the exact body the location destination used to send.
  it('the imported validator is the real one and can still reject', () => {
    expect(typeof validatePostBody).toBe('function')
    const theOldLocationBody = {
      project_id: null, plant_id: null, location_id: 'loc-1',
      event_type: 'observation', event_date: '2026-08-18', is_public: true,
    }
    expect(validatePostBody(theOldLocationBody)).toEqual({
      status: 400, error: 'project_id or plant_id is required',
    })
  })

  // The server half of the pair. If someone relaxes validatePostBody to admit location_id as a third
  // parent WITHOUT first migrating the database, this reds — and it should, because prod's
  // event_log_has_anchor CHECK is (plant_id IS NOT NULL OR project_id IS NOT NULL): two-way, no
  // location arm, and NOT VALID only suppresses back-validation, never enforcement on INSERT.
  // Verified on live prod 2026-08-18; migrations/v4-evtanchordel-001/README.md documents the same
  // constraint from its own live inventory. Relaxing the validator alone would trade a truthful 400
  // for a 23514 surfacing as an opaque 500.
  it('location_id is NOT a third parent — the DB CHECK is two-way', () => {
    const err = validatePostBody({ event_type: 'observation', location_id: 'loc-1' })
    expect(err?.status).toBe(400)
  })

  // The client half. Every event body Snap actually puts on the wire must survive the real validator.
  it('the planting-event destination sends a body the server accepts', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-event')
    await pickPlanting('cap-evplant')
    await act(async () => { fireEvent.click(screen.getByTestId('cap-save')) })
    await waitFor(() => expect(eventPosts().length).toBe(1))
    for (const body of eventPosts()) expect(validatePostBody(body)).toBeNull()
  })

  // The destination this ticket is about. The assertion is NOT "it sends a valid event body" — it is
  // that it sends NO event at all, because no valid one is constructible: there is no honest parent
  // for a photo of a bed, and inventing one (the nearest planting) is the exact lie V4-SNAPDEST-001
  // exists to stop. The photo hangs off the location directly instead, which photos_must_have_parent
  // admits in its own right and which LocationDetail already reads via /api/photos?location_id=.
  it('the location destination writes a photo on the place and posts NO event', async () => {
    await act(async () => { render(<CaptureFlow />) })
    await snapTo('mode-location')
    await act(async () => { fireEvent.change(screen.getByTestId('cap-locplace'), { target: { value: 'loc-1' } }) })
    await act(async () => { fireEvent.click(screen.getByTestId('cap-save')) })
    await waitFor(() => expect(uploadSpy).toHaveBeenCalled())

    expect(eventPosts()).toEqual([])
    const [, opts] = uploadSpy.mock.calls[0]
    // location_id alone IS a parent for photos_must_have_parent — unlike event_log, whose CHECK has
    // no location arm. That asymmetry is the whole reason this destination re-pointed at photos.
    expect(opts.linkage).toEqual({ location_id: 'loc-1' })
    expect(opts.keyPrefix).toBe('locations')
    expect(opts.parentId).toBe('loc-1')
  })

  // Belt and braces across the WHOLE surface: whatever any destination sends now or later, if it
  // reaches POST /api/events it must pass the server's own validator. A destination added in future
  // is covered by this without anyone remembering to extend the file.
  it('no destination can put an event on the wire that the server would reject', async () => {
    const DESTS = ['mode-planting', 'mode-event', 'mode-location', 'mode-replace', 'mode-inventory']
    let bodiesSeen = 0
    for (const dest of DESTS) {
      fetchSpy.mockClear()
      let view
      await act(async () => { view = render(<CaptureFlow />) })
      await snapTo(dest)
      if (dest === 'mode-event')     await pickPlanting('cap-evplant')
      if (dest === 'mode-replace')   await pickPlanting('cap-rpplant')
      if (dest === 'mode-location')  await act(async () => { fireEvent.change(screen.getByTestId('cap-locplace'), { target: { value: 'loc-1' } }) })
      if (dest === 'mode-inventory') await act(async () => { fireEvent.change(screen.getByTestId('cap-invname'), { target: { value: 'Twine' } }) })
      if (dest === 'mode-planting')  await act(async () => { fireEvent.change(document.getElementById('cap-plant-name'), { target: { value: 'Charentais' } }) })
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
      for (const body of eventPosts()) {
        bodiesSeen += 1
        expect(validatePostBody(body), `${dest} sent an event body the server rejects`).toBeNull()
      }
      view.unmount()
    }
    // A sweep of "every body is valid" over ZERO bodies passes while proving nothing — the shape of
    // the bug this file guards. At least one destination must genuinely have reached the wire.
    expect(bodiesSeen).toBeGreaterThan(0)
  })
})
