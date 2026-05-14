// Unit tests for src/pages/EventDetail.jsx — V1.2a-2 Session 3 Wave 5b:
// the issue-Resolve flow. Exercises SeverityBadge rendering, the Resolve
// button's visibility gate (flagged + unresolved only), the confirm step,
// the PATCH wiring, the dashboard navigation, and the optimistic-revert
// error path. Pre-existing EventDetail behavior is touched only as far as
// needed to reach the new code.
//
// useApiFetch is mocked to a controllable fetch: the event + project GETs
// resolve from fixture refs; PATCH /api/events/:id captures the body and
// resolves (or rejects) per-test. useAuth is mocked (EventDetail consumes
// it). react-router-dom is REAL — MemoryRouter provides :id / :eventId
// params; useNavigate is spied via a mock on the module.

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

// ── Hoisted mock plumbing ───────────────────────────────────────────────
const { apiFetchSpy, navigateSpy, patchCalls, dataRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  patchCalls: [],
  dataRef: {
    event: null,
    project: { id: 'p1', name: 'Tomatoes 2026' },
    patchResult: {
      id: 'e1', project_id: 'p1', event_type: 'observation',
      flagged_as_issue: true, severity: 2,
      resolved_at: '2026-05-14T12:00:00.000Z', resolved_by: 'u1',
      newly_earned_achievements: [], xp_gained: 0,
    },
    patchError: null,
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

// ── apiFetch behavior: route GETs to fixture data, capture PATCHes ──────
function wireApiFetch() {
  apiFetchSpy.mockImplementation((path, options = {}) => {
    if (options.method === 'PATCH' && path === '/api/events/e1') {
      patchCalls.push(JSON.parse(options.body))
      if (dataRef.patchError) return Promise.reject(dataRef.patchError)
      return Promise.resolve(dataRef.patchResult)
    }
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
  patchCalls.length = 0
  dataRef.event = { ...FLAGGED_UNRESOLVED }
  dataRef.project = { id: 'p1', name: 'Tomatoes 2026' }
  dataRef.patchResult = {
    id: 'e1', project_id: 'p1', event_type: 'observation',
    flagged_as_issue: true, severity: 2,
    resolved_at: '2026-05-14T12:00:00.000Z', resolved_by: 'u1',
    newly_earned_achievements: [], xp_gained: 0,
  }
  dataRef.patchError = null
  vi.restoreAllMocks()
  wireApiFetch()
})

describe('EventDetail — Resolve button visibility', () => {
  it('renders the Resolve button and a SeverityBadge for a flagged + unresolved event', async () => {
    renderEventDetail()
    await flushLoad()
    expect(screen.getByText('Resolve')).toBeTruthy()
    expect(screen.getByTestId('severity-badge')).toBeTruthy()
  })

  it('does NOT render the Resolve button for a non-flagged event', async () => {
    dataRef.event = { ...FLAGGED_UNRESOLVED, flagged_as_issue: false, severity: null }
    renderEventDetail()
    await flushLoad()
    expect(screen.queryByText('Resolve')).toBeNull()
    expect(screen.queryByTestId('severity-badge')).toBeNull()
  })

  it('does NOT render the Resolve button for a flagged + already-resolved event', async () => {
    dataRef.event = { ...FLAGGED_UNRESOLVED, resolved_at: '2026-05-13T09:00:00.000Z' }
    renderEventDetail()
    await flushLoad()
    expect(screen.queryByText('Resolve')).toBeNull()
    // SeverityBadge still shows — the event is still a flagged issue.
    expect(screen.getByTestId('severity-badge')).toBeTruthy()
  })
})

describe('EventDetail — Resolve flow', () => {
  it('clicking Resolve (confirm=true) PATCHes /api/events/e1 with { resolved: true } and navigates to /dashboard', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderEventDetail()
    await flushLoad()

    await act(async () => {
      fireEvent.click(screen.getByText('Resolve'))
    })

    expect(confirmSpy).toHaveBeenCalled()
    expect(patchCalls.length).toBe(1)
    expect(patchCalls[0]).toEqual({ resolved: true })
    expect(navigateSpy).toHaveBeenCalledTimes(1)
    const [dest, opts] = navigateSpy.mock.calls[0]
    expect(dest).toBe('/dashboard')
    expect(opts.state.refreshDashboard).toBe(true)
    expect(opts.state.newly_earned_achievements).toEqual([])
  })

  it('confirm=false fires no PATCH and no navigation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    renderEventDetail()
    await flushLoad()

    await act(async () => {
      fireEvent.click(screen.getByText('Resolve'))
    })

    expect(patchCalls.length).toBe(0)
    expect(navigateSpy).not.toHaveBeenCalled()
    // Button still present — nothing was resolved.
    expect(screen.getByText('Resolve')).toBeTruthy()
  })

  it('PATCH error reverts the optimistic resolve and surfaces a friendly error', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    dataRef.patchError = Object.assign(new Error('Internal Server Error'), { status: 500 })
    renderEventDetail()
    await flushLoad()

    await act(async () => {
      fireEvent.click(screen.getByText('Resolve'))
    })

    expect(patchCalls.length).toBe(1)
    expect(navigateSpy).not.toHaveBeenCalled()
    // Optimistic resolved_at reverted → Resolve button is back.
    expect(screen.getByText('Resolve')).toBeTruthy()
    // Friendly, non-raw error shown.
    expect(screen.getByText("Couldn't resolve this issue — try again.")).toBeTruthy()
    expect(screen.queryByText(/Internal Server Error/)).toBeNull()
  })
})
