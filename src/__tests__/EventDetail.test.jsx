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
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

// ── Hoisted mock plumbing ───────────────────────────────────────────────
const { apiFetchSpy, navigateSpy, dataRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  dataRef: {
    event: null,
    project: { id: 'p1', name: 'Tomatoes 2026' },
  },
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
    upload: vi.fn(),
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
