// V4-WATERMATH-001 F0 — the amount class on event history: readable always, editable behind
// WATER_DEPTH_EDIT_ENABLED (see featureFlags.js — PUT /api/events/:id does not yet persist or
// return `metadata`, so shipping the editor unflagged would silently discard corrections).
//
// Both flag states are asserted. A flag-gated feature tested in only one state is a feature whose
// other state ships untested — and here the OFF state is the one currently in production.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, waitFor, fireEvent, cleanup } from '@testing-library/react'
import { settle } from './helpers/settle.js'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const { apiFetchSpy, navigateSpy, dataRef, flagRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  dataRef: { event: null, project: { id: 'p1', name: 'Tomatoes 2026' } },
  flagRef: { current: false },
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))
// V4-REANCHORFLAG-001: useAuthOptional is owed because EventDetail's edit form now mounts
// PlantingSelect, which self-fetches through useCachedFetch. Null user on purpose — that puts
// the hook on its plain fetch branch rather than the module-level dataCache, so one test's
// plantings cannot leak into the next.
vi.mock('../context/AuthContext.jsx', () => ({
  useAuth: () => ({ user: { id: 'u1' } }),
  useAuthOptional: () => ({ user: null }),
}))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: vi.fn(), isUploading: false, error: null, photo: null, preview: null, reset: vi.fn(),
  }),
}))
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, useNavigate: () => navigateSpy }
})
// A getter so a single module instance can serve both flag states without re-importing the page.
vi.mock('../lib/featureFlags.js', async (importActual) => {
  const actual = await importActual()
  return { ...actual, get WATER_DEPTH_EDIT_ENABLED() { return flagRef.current } }
})

import EventDetail from '../pages/EventDetail.jsx'

const wateringEvent = {
  id: 'e1', project_id: 'p1', plant_id: 'pl1', location_id: null,
  event_type: 'watering', event_date: '2026-08-01T00:00:00Z',
  title: '', notes: '', private_notes: '', quantity: '', is_public: false,
  flagged_as_issue: false, severity: null, harvest: null,
  metadata: { water_depth: 'deep', water_depth_source: 'user' },
}

const putBodies = []

function setup(ev = wateringEvent) {
  dataRef.event = { ...ev }
  apiFetchSpy.mockReset()
  apiFetchSpy.mockImplementation((path, opts) => {
    if (path === '/api/events/e1') {
      if (opts?.method === 'PUT') { putBodies.push(JSON.parse(opts.body)); return Promise.resolve({ ...dataRef.event }) }
      return Promise.resolve(dataRef.event)
    }
    if (path === '/api/projects/p1') return Promise.resolve(dataRef.project)
    return Promise.resolve(null)
  })
  return render(
    <MemoryRouter initialEntries={['/projects/p1/events/e1']}>
      <Routes><Route path="/projects/:id/events/:eventId" element={<EventDetail />} /></Routes>
    </MemoryRouter>,
  )
}

async function flushLoad() {
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/events/e1'))
  await settle()
}

beforeEach(() => { putBodies.length = 0; flagRef.current = false })

describe('EventDetail — the stored class is READABLE (unflagged)', () => {
  it('renders the class in plain words, not the stored code', async () => {
    setup()
    await flushLoad()
    expect(screen.getByText('Water amount')).toBeTruthy()
    expect(screen.getByText('Deep')).toBeTruthy()
    expect(screen.queryByText('deep')).toBeNull()
  })

  it('does not render the machine provenance key', async () => {
    setup()
    await flushLoad()
    expect(screen.queryByText('water_depth_source')).toBeNull()
    expect(screen.queryByText('user')).toBeNull()
  })
})

describe('EventDetail — editing the class is flag-gated', () => {
  it('flag OFF: no chips in the edit form, and the PUT carries no metadata', async () => {
    flagRef.current = false
    setup()
    await flushLoad()
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }))
    expect(screen.queryByTestId('ev-water-depth-group')).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /save changes|save/i })) })
    await waitFor(() => expect(putBodies.length).toBe(1))
    expect(putBodies[0].metadata).toBeUndefined()
  })

  it('flag ON: chips render seeded from the SAVED row', async () => {
    flagRef.current = true
    setup()
    await flushLoad()
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }))
    expect(screen.getByTestId('ev-water-depth-group')).toBeTruthy()
    expect(screen.getByTestId('ev-water-depth-deep').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('ev-water-depth-normal').getAttribute('aria-pressed')).toBe('false')
  })

  it('flag ON: a corrected class reaches the PUT as source=user and MERGES over existing metadata', async () => {
    flagRef.current = true
    setup({ ...wateringEvent, metadata: { water_depth: 'deep', water_depth_source: 'user', amount_ml: 500 } })
    await flushLoad()
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }))
    fireEvent.click(screen.getByTestId('ev-water-depth-light'))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /save changes|save/i })) })
    await waitFor(() => expect(putBodies.length).toBe(1))
    expect(putBodies[0].metadata).toEqual({
      amount_ml: 500, water_depth: 'light', water_depth_source: 'user',
    })
  })

  it('flag ON: a class-less historical row seeds to the default rather than to nothing', async () => {
    flagRef.current = true
    setup({ ...wateringEvent, metadata: null })
    await flushLoad()
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }))
    expect(screen.getByTestId('ev-water-depth-normal').getAttribute('aria-pressed')).toBe('true')
  })

  // BUG-WATERDEPTHSINGLEEVENT-001 follow-on. The save used to stamp source='user' on every edit, so
  // changing only a note turned a one-tap `normal/default` row into a claimed choice. Dave
  // 2026-10-08: source is 'user' only when a chip is tapped in THAT edit. An untouched class sends
  // no `metadata` key at all — the PUT's has-key grammar then keeps the stored column byte-identical.
  async function editNoteAndSave({ tap } = {}) {
    await flushLoad()
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }))
    fireEvent.change(document.getElementById('ev-notes'), { target: { value: 'moved the hose' } })
    if (tap) fireEvent.click(screen.getByTestId(`ev-water-depth-${tap}`))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /save changes|save/i })) })
    await waitFor(() => expect(putBodies.length).toBe(1))
    expect(putBodies[0].notes).toBe('moved the hose')
    return putBodies[0]
  }

  it('flag ON: a note-only edit of a normal/default row does not touch its class or source', async () => {
    flagRef.current = true
    setup({ ...wateringEvent, metadata: { water_depth: 'normal', water_depth_source: 'default' } })
    const body = await editNoteAndSave()
    expect(Object.hasOwn(body, 'metadata')).toBe(false)
  })

  it('flag ON: a note-only edit of a deep/user row does not touch its class or source', async () => {
    flagRef.current = true
    setup()
    const body = await editNoteAndSave()
    expect(Object.hasOwn(body, 'metadata')).toBe(false)
  })

  it('flag ON: tapping the SAME class that was stored is still a choice (source=user)', async () => {
    flagRef.current = true
    setup({ ...wateringEvent, metadata: { water_depth: 'normal', water_depth_source: 'default' } })
    const body = await editNoteAndSave({ tap: 'normal' })
    expect(body.metadata).toEqual({ water_depth: 'normal', water_depth_source: 'user' })
  })

  it('flag ON: a bare legacy row (no metadata) is not given a class or a source by a note-only edit', async () => {
    flagRef.current = true
    setup({ ...wateringEvent, metadata: null })
    const body = await editNoteAndSave()
    expect(Object.hasOwn(body, 'metadata')).toBe(false)
  })

  it('flag ON: a stored class with no source is left as stored by a note-only edit', async () => {
    flagRef.current = true
    setup({ ...wateringEvent, metadata: { water_depth: 'light' } })
    const body = await editNoteAndSave()
    expect(Object.hasOwn(body, 'metadata')).toBe(false)
  })

  it('flag ON: other metadata keys survive both a note-only edit and a chip tap', async () => {
    flagRef.current = true
    const stored = { water_depth: 'normal', water_depth_source: 'default', batch_id: 'b-7', care_input_source: 'today' }
    setup({ ...wateringEvent, metadata: stored })
    const untouched = await editNoteAndSave()
    // Absent key = the server keeps the whole column, batch_id and care_input_source included.
    expect(Object.hasOwn(untouched, 'metadata')).toBe(false)
    cleanup()
    putBodies.length = 0
    setup({ ...wateringEvent, metadata: stored })
    const tapped = await editNoteAndSave({ tap: 'deep' })
    expect(tapped.metadata).toEqual({
      batch_id: 'b-7', care_input_source: 'today', water_depth: 'deep', water_depth_source: 'user',
    })
  })

  it('flag ON: re-typing a class-less event INTO watering without a tap records the default, not a choice', async () => {
    flagRef.current = true
    setup({ ...wateringEvent, event_type: 'observation', metadata: { batch_id: 'b-7' } })
    await flushLoad()
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }))
    fireEvent.change(document.getElementById('ev-event-type'), { target: { value: 'watering' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /save changes|save/i })) })
    await waitFor(() => expect(putBodies.length).toBe(1))
    expect(putBodies[0].metadata).toEqual({
      batch_id: 'b-7', water_depth: 'normal', water_depth_source: 'default',
    })
  })

  it('flag ON: a non-watering event gets no chips', async () => {
    flagRef.current = true
    setup({ ...wateringEvent, event_type: 'observation', metadata: null })
    await flushLoad()
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }))
    expect(screen.queryByTestId('ev-water-depth-group')).toBeNull()
  })
})
