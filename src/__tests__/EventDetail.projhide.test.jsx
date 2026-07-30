// V4-PROJHIDE-001 — EventDetail post-delete nav with PROJECTS_HIDDEN mocked TRUE. Deleting an event
// must land on Home (/today), NOT the hidden /projects/:id page — even when the event carries a
// resolved project. Flag-OFF behavior (navigate to /projects/:id) is covered by EventDetail.test.jsx.
// importActual spread so other flags keep their values. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const { apiFetchSpy, navigateSpy, dataRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  dataRef: { event: null, project: { id: 'p1', name: 'Tomatoes 2026' } },
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))
vi.mock('../context/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: vi.fn(), isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))
// Spy useNavigate while keeping the rest of react-router-dom real.
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, useNavigate: () => navigateSpy }
})
// Flag ON — spread the real module so every other flag keeps its value.
vi.mock('../lib/featureFlags.js', async (importActual) => ({
  ...(await importActual()),
  PROJECTS_HIDDEN: true,
}))

import EventDetail from '../pages/EventDetail.jsx'

const EVENT = {
  id: 'e1', project_id: 'p1', event_type: 'observation',
  event_date: '2026-05-10T12:00:00.000Z', title: 'Spider mites',
  notes: null, private_notes: null, quantity: null, is_public: true,
  metadata: null, flagged_as_issue: false, severity: null, resolved_at: null,
  project_name: 'Tomatoes 2026',
}

beforeEach(() => {
  apiFetchSpy.mockReset()
  navigateSpy.mockReset()
  dataRef.event = { ...EVENT }
  dataRef.project = { id: 'p1', name: 'Tomatoes 2026' }
  apiFetchSpy.mockImplementation((path, opts) => {
    if (path === '/api/events/e1' && opts?.method === 'DELETE') return Promise.resolve({})
    if (path === '/api/events/e1') return Promise.resolve(dataRef.event)
    if (path === '/api/projects/p1') return Promise.resolve(dataRef.project)
    return Promise.resolve(null)
  })
})

describe('EventDetail — PROJHIDE post-delete nav', () => {
  it('navigates to /today after delete even with a resolved project', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(
      <MemoryRouter initialEntries={['/events/e1']}>
        <Routes><Route path="/events/:eventId" element={<EventDetail />} /></Routes>
      </MemoryRouter>,
    )
    // Event + project both loaded, so the test proves the flag overrides a PRESENT project.
    await waitFor(() => expect(screen.getByText(/Spider mites/)).toBeTruthy())
    await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/projects/p1'))
    await act(async () => { await Promise.resolve() })

    await act(async () => { fireEvent.click(screen.getByText('Delete')) })
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith('/today'))
    expect(navigateSpy).not.toHaveBeenCalledWith('/projects/p1')
  })
})
