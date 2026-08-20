// Unit tests for src/pages/EventDetail.jsx — FLAG-REMOVAL (2026-06-10) regression suite.
// The V1.2a-2 issue-Resolve flow (SeverityBadge + Resolve button + PATCH resolve wiring) was
// removed from the UI; the server PATCH /api/events/:id resolve endpoint is intentionally left
// in place. These tests pin the removal: an event row that still carries the legacy flag
// columns renders WITHOUT any flagging affordance.
//
// useApiFetch is mocked to a controllable fetch; useAuth is mocked. react-router-dom is REAL —
// MemoryRouter provides :id / :eventId params; useNavigate is spied via a mock on the module.

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, waitFor, fireEvent, cleanup } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

// ── Hoisted mock plumbing ───────────────────────────────────────────────
const { apiFetchSpy, navigateSpy, dataRef, uploadRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  dataRef: {
    event: null,
    project: { id: 'p1', name: 'Tomatoes 2026' },
  },
  // V4-DIRTYGUARDSWEEP-001: the upload result is CONTROLLABLE now, so the reload-gate tests at the
  // bottom of this file can hold the pick→registered window open and observe the hold across it.
  // beforeEach reinstates a resolve-immediately stub, which is what every pre-existing test in this
  // file assumed (none of them touch the picker at all).
  uploadRef: { upload: null },
}))

// V4-PROJHIDE-001: the flag flipped TRUE in source on 2026-08-10. This suite predates the flip and
// its assertions describe the projects-VISIBLE UI (project chooser, project tree, "By project" scope),
// which remains a live configuration — rollback is a one-line revert. Pinned FALSE so every assertion
// below keeps covering what it was written to cover, rather than being rewritten to the flag-ON world
// and silently weakened. Flag-ON is covered by the *.projhide.test.jsx suites.
// importActual spread so every other flag keeps its real value.
vi.mock('../lib/featureFlags.js', async (importActual) => ({
  ...(await importActual()),
  PROJECTS_HIDDEN: false,
}))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: apiFetchSpy }),
}))

vi.mock('../context/AuthContext.jsx', () => ({
  useAuth: () => ({ user: { id: 'u1' } }),
}))

// PhotoUpload (rendered in EventDetail view mode) pulls in the upload hook —
// stub it so the test stays decoupled from the photo-upload network path.
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: (...args) => uploadRef.upload(...args),
    isUploading: false,
    error: null,
    photo: null,
    preview: null,
    reset: vi.fn(),
  }),
}))

// Spy useNavigate while keeping the rest of react-router-dom real.
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, useNavigate: () => navigateSpy }
})

import EventDetail from '../pages/EventDetail.jsx'

function wireApiFetch() {
  apiFetchSpy.mockImplementation((path) => {
    if (path === '/api/events/e1') return Promise.resolve(dataRef.event)
    if (path === '/api/projects/p1') return Promise.resolve(dataRef.project)
    return Promise.resolve(null)
  })
}

function renderEventDetail() {
  return render(
    <MemoryRouter initialEntries={['/projects/p1/events/e1']}>
      <Routes>
        <Route path="/projects/:id/events/:eventId" element={<EventDetail />} />
      </Routes>
    </MemoryRouter>,
  )
}

// Wait for the mount-time event + project load to settle and the page to render.
async function flushLoad() {
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/events/e1'))
  await act(async () => { await Promise.resolve() })
}

// An event row that STILL carries the legacy flag columns (server/db untouched by the removal).
const FLAGGED_UNRESOLVED = {
  id: 'e1', project_id: 'p1', event_type: 'observation',
  event_date: '2026-05-10T12:00:00.000Z', title: 'Spider mites on lower leaves',
  notes: null, private_notes: null, quantity: null, is_public: true,
  metadata: null, flagged_as_issue: true, severity: 2, resolved_at: null,
  project_name: 'Tomatoes 2026',
}

beforeEach(() => {
  apiFetchSpy.mockReset()
  navigateSpy.mockReset()
  dataRef.event = { ...FLAGGED_UNRESOLVED }
  dataRef.project = { id: 'p1', name: 'Tomatoes 2026' }
  vi.restoreAllMocks()
  uploadRef.upload = vi.fn(() => Promise.resolve({ photo: { id: 'ph1' } }))
  wireApiFetch()
})

describe('EventDetail — flag severity badge (V4-FLAG-001)', () => {
  it('renders a SeverityBadge for a flagged event (severity 2 -> Needs attention)', async () => {
    renderEventDetail()
    await flushLoad()
    expect(screen.getByText(/Spider mites/)).toBeTruthy()
    const badge = screen.getByTestId('severity-badge')
    expect(badge.getAttribute('data-variant')).toBe('flagged-2')
    expect(badge.textContent).toContain('Needs attention')
  })

  it('still renders the Edit and Delete actions', async () => {
    renderEventDetail()
    await flushLoad()
    expect(screen.getByText('Edit')).toBeTruthy()
    expect(screen.getByText('Delete')).toBeTruthy()
  })

  it('renders NO SeverityBadge for a plain (non-flagged) event', async () => {
    dataRef.event = { ...FLAGGED_UNRESOLVED, flagged_as_issue: false, severity: null }
    renderEventDetail()
    await flushLoad()
    expect(screen.queryByTestId('severity-badge')).toBeNull()
  })
})

// V3-CONFIG-001 — the edit-mode event-type <select> is now sourced from the dropdownRegistry
// (EVENT_TYPE_OPTIONS), derived from the canonical EVENT_TYPES taxonomy. This pins that the
// edit picker offers exactly the registry's options with its exact (behavior-preserving) labels.
import { EVENT_TYPE_OPTIONS } from '../lib/dropdownRegistry.js'

describe('EventDetail — edit event-type select sourced from dropdownRegistry (V3-CONFIG-001)', () => {
  it('renders one option per EVENT_TYPE_OPTIONS entry with the registry label, in registry order', async () => {
    renderEventDetail()
    await flushLoad()
    fireEvent.click(screen.getByText('Edit'))
    const sel = document.getElementById('ev-event-type')
    expect(sel).toBeTruthy()
    const opts = Array.from(sel.options)
    expect(opts.map(o => o.value)).toEqual(EVENT_TYPE_OPTIONS.map(o => o.value))
    expect(opts.map(o => o.textContent)).toEqual(EVENT_TYPE_OPTIONS.map(o => o.label))
  })
})

// V4-UNSCOPEDROUTES-001 — /events/:eventId is the canonical route; the project is derived from
// the event record, and a project-less event still renders (Home breadcrumb, no project fetch).
describe('EventDetail — un-scoped route (V4-UNSCOPEDROUTES-001)', () => {
  function renderUnscoped() {
    return render(
      <MemoryRouter initialEntries={['/events/e1']}>
        <Routes>
          <Route path="/events/:eventId" element={<EventDetail />} />
        </Routes>
      </MemoryRouter>,
    )
  }

  it('derives the project from the event record when the route has no project param', async () => {
    renderUnscoped()
    await flushLoad()
    await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/projects/p1'))
    expect(screen.getByText('Tomatoes 2026')).toBeTruthy()
    expect(screen.getByText(/Spider mites/)).toBeTruthy()
  })

  it('renders a project-less event with the Home breadcrumb and no project fetch', async () => {
    dataRef.event = { ...FLAGGED_UNRESOLVED, project_id: null, project_name: null }
    renderUnscoped()
    await flushLoad()
    expect(screen.getByText(/Spider mites/)).toBeTruthy()
    expect(screen.getByText('Home')).toBeTruthy()
    expect(apiFetchSpy).not.toHaveBeenCalledWith(expect.stringMatching(/^\/api\/projects\//))
  })
})

// ── V4-DIRTYGUARDSWEEP-001 — the service-worker reload gate ──────────────────────────────────────
//
// Every assertion below drives the REAL reloadGate and reads isReloadBlocked(). None of them spies
// on setReloadBlocked: a spy proves a call happened, not that the gate ends up held, and that exact
// blind spot is how V4-RELOADGATEWIRE-001 shipped a primitive with zero callers and a green suite.
//
// The predicate under test is a DIFFERS-FROM-THE-SEED comparison, not truthiness — startEdit() fills
// all 20 fields from the saved row, so the pristine-open case below is the one that would fail on a
// copied `form.notes || form.title || …` predicate. Both directions are covered on purpose: without
// the "must NOT hold" tests, a predicate pinned true passes everything.
import { isReloadBlocked, clearReloadBlocks } from '../lib/reloadGate.js'

const HARVEST_EVENT = {
  id: 'e1', project_id: 'p1', event_type: 'harvest',
  event_date: '2026-08-01T12:00:00.000Z', title: 'First picking',
  notes: null, private_notes: null, quantity: null, is_public: true,
  metadata: null, flagged_as_issue: false, severity: null, resolved_at: null,
  project_name: 'Tomatoes 2026',
  harvest: { quantity: 4, unit: 'count', quality_rating: null, weight_grams: null, weight_estimated: true, disposition: null },
}

describe('EventDetail — reload gate (V4-DIRTYGUARDSWEEP-001)', () => {
  beforeEach(() => { clearReloadBlocks() })

  async function openEditor() {
    renderEventDetail()
    await flushLoad()
    await act(async () => { fireEvent.click(screen.getByText('Edit')) })
  }

  it('holds nothing while the event is merely being read', async () => {
    renderEventDetail()
    await flushLoad()
    expect(isReloadBlocked()).toBe(false)
  })

  // THE false-positive case. This event has a title and a flag set, so a truthiness predicate copied
  // from EventNew would report dirty here and hold a deploy for anyone who tapped Edit to LOOK.
  it('does NOT hold the reload when the editor is opened and nothing is changed', async () => {
    await openEditor()
    expect(document.getElementById('ev-title').value).toBe('Spider mites on lower leaves')
    expect(isReloadBlocked()).toBe(false)
  })

  it('holds the reload as soon as a field differs from the saved row', async () => {
    await openEditor()
    await act(async () => {
      fireEvent.change(document.getElementById('ev-notes'), { target: { value: 'webbing under the leaves' } })
    })
    expect(isReloadBlocked()).toBe(true)
  })

  // The property truthiness cannot express: typing and undoing leaves nothing to lose, so the gate
  // must reopen. A `!==`-against-the-seed predicate gets this for free; a dirty FLAG would not.
  it('releases the hold when the edit is reverted to the saved value', async () => {
    await openEditor()
    const title = document.getElementById('ev-title')
    await act(async () => { fireEvent.change(title, { target: { value: 'Spider mites everywhere' } }) })
    expect(isReloadBlocked()).toBe(true)
    await act(async () => { fireEvent.change(title, { target: { value: 'Spider mites on lower leaves' } }) })
    expect(isReloadBlocked()).toBe(false)
  })

  // Not a text-only guard: the seed snapshot covers booleans and pickers too. Un-flagging an issue
  // is a real pending change to existing data that a reload silently reverts.
  it('holds the reload for a non-text change (the issue flag)', async () => {
    await openEditor()
    await act(async () => { fireEvent.click(document.getElementById('ev-flagged')) })
    expect(isReloadBlocked()).toBe(true)
  })

  // reloadGate.js's own header names this field as the thing the gate exists for: "DRAFT_FORM_FIELDS
  // does not cover harvest quantity/weight, so nothing restores it."
  it('holds the reload for a corrected harvest amount', async () => {
    dataRef.event = { ...HARVEST_EVENT }
    await openEditor()
    await act(async () => {
      fireEvent.change(document.getElementById('ev-harvest-qty'), { target: { value: '7' } })
    })
    expect(isReloadBlocked()).toBe(true)
  })

  // The `editing` term. Cancel does not clear `form`, but re-opening re-seeds it from the row, so a
  // cancelled edit is already unreachable — keeping the hold would wedge updates over content the
  // user cannot get back to. Both halves asserted: released, and genuinely discarded on re-open.
  it('releases the hold on Cancel, and the discarded text does not come back', async () => {
    await openEditor()
    await act(async () => {
      fireEvent.change(document.getElementById('ev-notes'), { target: { value: 'throwaway' } })
    })
    expect(isReloadBlocked()).toBe(true)
    await act(async () => { fireEvent.click(screen.getByText('Cancel')) })
    expect(isReloadBlocked()).toBe(false)
    await act(async () => { fireEvent.click(screen.getByText('Edit')) })
    expect(document.getElementById('ev-notes').value).toBe('')
    expect(isReloadBlocked()).toBe(false)
  })

  it('releases the hold after a successful save', async () => {
    await openEditor()
    await act(async () => {
      fireEvent.change(document.getElementById('ev-notes'), { target: { value: 'webbing under the leaves' } })
    })
    expect(isReloadBlocked()).toBe(true)
    apiFetchSpy.mockImplementation((path, opts) => {
      if (path === '/api/events/e1' && opts?.method === 'PUT') {
        return Promise.resolve({ ...FLAGGED_UNRESOLVED, notes: 'webbing under the leaves' })
      }
      if (path === '/api/events/e1') return Promise.resolve(dataRef.event)
      if (path === '/api/projects/p1') return Promise.resolve(dataRef.project)
      return Promise.resolve(null)
    })
    await act(async () => { fireEvent.click(screen.getByText('Save changes')) })
    expect(isReloadBlocked()).toBe(false)
  })

  // The cleanup release. A dirty form that navigates away while still holding its key would wedge
  // updates forever — BUG-STALECLIENT-001, which is why this is a deferral and not a cancellation.
  it('releases the hold when the page unmounts mid-edit', async () => {
    renderEventDetail()
    await flushLoad()
    await act(async () => { fireEvent.click(screen.getByText('Edit')) })
    await act(async () => {
      fireEvent.change(document.getElementById('ev-notes'), { target: { value: 'still typing' } })
    })
    expect(isReloadBlocked()).toBe(true)
    cleanup()
    expect(isReloadBlocked()).toBe(false)
  })

  // The uploadingPhoto term. <PhotoUpload> stages nothing — it uploads inside the picker's onChange
  // — so the bytes live only in RAM between the pick and the registered row, and a reload aborts
  // that. Held open with a deferred so the in-flight window is observable at all.
  it('holds the reload while a photo is on the wire, and releases when it lands', async () => {
    let settle
    uploadRef.upload = vi.fn(() => new Promise(res => { settle = res }))
    renderEventDetail()
    await flushLoad()
    expect(isReloadBlocked()).toBe(false)

    const file = new File(['x'], 'mites.jpg', { type: 'image/jpeg' })
    await act(async () => {
      fireEvent.change(screen.getByTestId('photo-upload-input'), { target: { files: [file] } })
    })
    expect(uploadRef.upload).toHaveBeenCalled()
    expect(isReloadBlocked()).toBe(true)

    await act(async () => { settle({ photo: { id: 'ph1' } }); await Promise.resolve() })
    expect(isReloadBlocked()).toBe(false)
  })

  // A failed upload must release too. errorMode='swallow' makes useUploadPhoto return {error}
  // rather than throw, so exactly one of the two callbacks always fires — a hold that only released
  // on success would strand on every failed upload.
  it('releases the hold when the photo upload fails', async () => {
    let settle
    uploadRef.upload = vi.fn(() => new Promise(res => { settle = res }))
    renderEventDetail()
    await flushLoad()
    const file = new File(['x'], 'mites.jpg', { type: 'image/jpeg' })
    await act(async () => {
      fireEvent.change(screen.getByTestId('photo-upload-input'), { target: { files: [file] } })
    })
    expect(isReloadBlocked()).toBe(true)
    await act(async () => { settle({ error: 'network died' }); await Promise.resolve() })
    expect(isReloadBlocked()).toBe(false)
  })
})
