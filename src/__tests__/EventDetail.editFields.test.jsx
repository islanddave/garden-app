// BUG-EVENTEDITFIELDS-001 slices 2 + 4 — the client half.
//
// THE FAILURE THIS FILE EXISTS TO PREVENT is not "the field is missing". It is the mirror image of
// the bug being fixed: a save that NULLs a column the form never rendered. `clear` is derived from
// a loop, so if that loop ever ranges wider than what is on screen, every save silently wipes
// columns the user cannot see — no error, no log line, and the prior values are gone.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

// Harness copied verbatim from EventDetail.test.jsx — useApiFetch returns { fetch }, and the
// upload HOOK is what needs stubbing, not the PhotoUpload component.
const { apiFetchSpy, navigateSpy, dataRef, flags } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  dataRef: { event: null, project: { id: 'p1', name: 'Tomatoes 2026' } },
  flags: { EVENT_REANCHOR_ENABLED: false },
}))

// BUG-VACUOUSREANCHORTEST-001 — slice 4's guard has to be able to see BOTH flag states, so the flag
// is read through a getter rather than baked in at import. Every other flag keeps its real value:
// EventDetail also reads PROJECTS_HIDDEN and WATER_DEPTH_EDIT_ENABLED, and stubbing those would
// quietly re-route the page this file is meant to be testing.
vi.mock('../lib/featureFlags.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, get EVENT_REANCHOR_ENABLED() { return flags.EVENT_REANCHOR_ENABLED } }
})

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))
// V4-REANCHORFLAG-001: with the flag ON this page now mounts PlantingSelect, which self-fetches
// through useCachedFetch — and that hook calls useAuthOptional. A null user is deliberate: it puts
// the hook on its plain fetch-on-mount branch rather than the module-level dataCache, so one test's
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

import EventDetail from '../pages/EventDetail.jsx'

const baseEvent = {
  id: 'e1', project_id: 'p1', plant_id: 'pl1', location_id: null,
  event_type: 'pest_treatment', event_date: '2026-08-01T00:00:00Z',
  title: 't', notes: '', private_notes: '', quantity: '', is_public: false,
  flagged_as_issue: true, severity: 2,
  treatment_product_text: 'Neem oil', treatment_category: 'pest_control',
  treatment_amount: '2 tbsp', pest_target: 'aphids',
  harvest: null,
}

function setup(ev = baseEvent) {
  dataRef.event = { ...ev }
  apiFetchSpy.mockReset()
  apiFetchSpy.mockImplementation((path, opts) => {
    if (path === '/api/events/e1') {
      if (opts?.method === 'PUT') return Promise.resolve({ ...dataRef.event })
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
  await act(async () => { await Promise.resolve() })
}

const clickEdit = async () => {
  await flushLoad()
  fireEvent.click(await screen.findByRole('button', { name: /edit/i }))
}

const save = async () => {
  fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
  await waitFor(() => expect(apiFetchSpy.mock.calls.some(c => c[1]?.method === 'PUT')).toBe(true))
}

const savedBody = () => {
  const call = apiFetchSpy.mock.calls.find(c => c[1]?.method === 'PUT')
  expect(call, 'a PUT must have been issued').toBeTruthy()
  return JSON.parse(call[1].body)
}

describe('slice 2: the edit form seeds and saves what it can now write', () => {
  beforeEach(() => { apiFetchSpy.mockReset() })

  it('seeds the treatment fields from the GET body', async () => {
    setup(); await clickEdit()
    expect(screen.getByLabelText(/product/i).value).toBe('Neem oil')
    expect(screen.getByLabelText(/amount \(optional\)/i).value).toBe('2 tbsp')
    expect(screen.getByLabelText(/pest \/ target/i).value).toBe('aphids')
  })

  it('seeds the flag and severity, and renders severity only while flagged', async () => {
    setup(); await clickEdit()
    expect(screen.getByLabelText(/flag as an issue/i).checked).toBe(true)
    expect(screen.getByLabelText(/severity/i).value).toBe('2')
    fireEvent.click(screen.getByLabelText(/flag as an issue/i))
    expect(screen.queryByLabelText(/severity/i)).toBeNull()
  })

  it('an unrelated edit ROUND-TRIPS the treatment columns unchanged', async () => {
    // The regression that would otherwise ship: editing the title and blanking four columns.
    setup(); await clickEdit()
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'new title' } })
    await save()
    const b = savedBody()
    expect(b.treatment_product_text).toBe('Neem oil')
    expect(b.pest_target).toBe('aphids')
    expect(b.clear ?? []).toEqual([])
  })

  it('emptying a rendered field emits it in clear[] — and ONLY it', async () => {
    setup(); await clickEdit()
    fireEvent.change(screen.getByLabelText(/amount \(optional\)/i), { target: { value: '' } })
    await save()
    const b = savedBody()
    expect(b.clear).toEqual(['treatment_amount'])
    expect(b.treatment_product_text).toBe('Neem oil')
  })

  it('unflagging sends severity absent, never a stale value', async () => {
    // The server refuses severity-without-flag with a 400. This proves the client cannot
    // construct that request, so the user never sees an unexplained save failure.
    setup(); await clickEdit()
    fireEvent.click(screen.getByLabelText(/flag as an issue/i))
    await save()
    const b = savedBody()
    expect(b.flagged_as_issue).toBe(false)
    expect(b.severity).toBeUndefined()
  })

  it('a NON-treatment event neither renders nor clears the treatment fields', async () => {
    // The clear loop must be gated on the same condition as the render. If it were not, editing an
    // observation would emit clear:[...4 columns] for fields never shown.
    setup({ ...baseEvent, event_type: 'observation' }); await clickEdit()
    expect(screen.queryByLabelText(/pest \/ target/i)).toBeNull()
    await save()
    expect(savedBody().clear ?? []).toEqual([])
  })
})

// BUG-VACUOUSREANCHORTEST-001 — what this describe used to be, and why it was replaced.
//
// The old single test clicked Edit, saved an UNTOUCHED form, and asserted plant_id/project_id were
// undefined. The emit it was guarding is `EVENT_REANCHOR_ENABLED && form.plant_id !== (event.plant_id
// ?? null)` (EventDetail.jsx:349). On an untouched form the SECOND conjunct is independently false —
// `form.plant_id` is seeded from `event.plant_id` (EventDetail.jsx:214) — so the keys were absent no
// matter what the flag said. Verified, not inferred: flipping EVENT_REANCHOR_ENABLED to true left all
// 7 tests in this file green. A guard that passes in the state it claims to forbid protects nothing.
//
// It also had a second, quieter hole: `expect(b.plant_id).toBeUndefined()` passes just as happily on
// a body of `{}`, so a save that silently stopped sending anything would have read as a pass. Both
// tests below therefore carry a positive control on the same body they assert absence in.
//
// WHAT THIS FILE STILL DOES NOT COVER, and where it moved to. Until V4-REANCHORFLAG-001 the flag
// conjunct could not be falsified from anywhere: nothing in EventDetail wrote `form.plant_id` — the
// seed was its only writer, Delete (the one path that refetches the event) is gated on `!editing`,
// and no re-anchor control was rendered — so the emit branch had no reachable trigger in the client
// and deleting `EVENT_REANCHOR_ENABLED &&` kept every test here green. The control now exists and
// is itself flag-gated, so the falsifying tests live with it in
// EventDetail.reanchor.test.jsx: flag OFF renders no control at all, flag ON + an actual anchor
// change emits the keys, and the move is a PUT to the same event id rather than a re-log.
// What remains HERE is the other half, and it is still the one worth pinning on this file: an
// UNTOUCHED anchor never reaches the wire, in either flag state.
describe('slice 4: the re-anchor keys never reach the wire from an untouched form', () => {
  beforeEach(() => { flags.EVENT_REANCHOR_ENABLED = false })

  const anchorKeys = (b) => Object.keys(b).filter(k => k === 'plant_id' || k === 'project_id')

  it('flag OFF (the shipped state) — an ordinary edit saves without the anchor keys', async () => {
    setup(); await clickEdit()
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'new title' } })
    await save()
    const b = savedBody()
    // Positive control FIRST: absence only means something on a body that carried the edit.
    expect(b.title).toBe('new title')
    expect(anchorKeys(b)).toEqual([])
  })

  it('flag ON — the SEED, not the flag, is what holds the anchor still', async () => {
    // The failure this exists to prevent is the one the flag's own comment names: SILENT DATA
    // MOVEMENT. If `form.plant_id` ever stops mirroring the saved row, then the moment this flag is
    // flipped on, opening an event and pressing Save re-anchors it to something the user never
    // chose — no error, no prompt, and the old anchor is gone. Forcing the flag on is what makes
    // that reachable from a test at all; with it off the assertion below cannot fail for any reason.
    flags.EVENT_REANCHOR_ENABLED = true
    setup(); await clickEdit()
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'new title' } })
    await save()
    const b = savedBody()
    expect(b.title).toBe('new title')
    expect(anchorKeys(b)).toEqual([])
  })

  it('flipping the flag alone does not change the wire — the "byte-identical" promise', async () => {
    // featureFlags.js:123 claims "Flag OFF leaves EventDetail byte-identical". Stated that way it is
    // untestable; stated as "both flag states produce the same PUT for the same interaction" it is
    // exactly checkable, and it fails the moment the emit stops being conditioned on a real change.
    flags.EVENT_REANCHOR_ENABLED = false
    const { unmount } = setup(); await clickEdit()
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'new title' } })
    await save()
    const off = savedBody()
    // Read `off` BEFORE unmounting and re-rendering: setup() resets the spy, so the second pass
    // wipes the call log the first assertion would otherwise be read from.
    unmount()

    flags.EVENT_REANCHOR_ENABLED = true
    setup(); await clickEdit()
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'new title' } })
    await save()
    const on = savedBody()

    expect(Object.keys(on).sort()).toEqual(Object.keys(off).sort())
    expect(on).toEqual(off)
  })
})
