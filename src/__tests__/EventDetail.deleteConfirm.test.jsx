// DD9 / W-EVTDEL adoption — EventDetail's Delete now interposes EventDeleteConfirm (the
// disclose-and-offer sheet) instead of window.confirm. These pin the three confirm-step
// invariants on THIS surface (ProjectDetail.deleteConfirm.test.jsx pins the same three on the
// other — the two surfaces must not diverge):
//   1. the delete tap OPENS the dialog and fires no API call,
//   2. cancel ABORTS — the sheet closes and no DELETE is ever sent,
//   3. confirm PROCEEDS — the byte-identical DELETE /api/events/:id fires, then navigation.
// Plus the regression pin that window.confirm is gone from the path entirely.
//
// Harness mirrors EventDetail.test.jsx: useApiFetch/useAuth mocked, react-router-dom real
// (MemoryRouter) with useNavigate spied, PROJECTS_HIDDEN pinned FALSE so the post-delete
// redirect is the deterministic project route.

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, waitFor, fireEvent, cleanup } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const { apiFetchSpy, navigateSpy, dataRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  dataRef: { event: null, project: { id: 'p1', name: 'Tomatoes 2026' } },
}))

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

const EVENT = {
  id: 'e1', project_id: 'p1', event_type: 'observation',
  event_date: '2026-05-10T12:00:00.000Z', title: 'Spider mites on lower leaves',
  notes: null, private_notes: null, quantity: null, is_public: true,
  metadata: null, flagged_as_issue: false, severity: null, resolved_at: null,
  project_name: 'Tomatoes 2026',
}

const deleteCalls = () => apiFetchSpy.mock.calls.filter(([, opts]) => opts?.method === 'DELETE')

function wireApiFetch() {
  apiFetchSpy.mockImplementation((path, opts = {}) => {
    if (path === '/api/events/e1' && (opts.method ?? 'GET') === 'DELETE') return Promise.resolve({ ok: true })
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

async function flushLoad() {
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/events/e1'))
  await act(async () => { await Promise.resolve() })
}

// The header action (accessible name exactly "Delete") vs the sheet's confirm ("Delete event").
const headerDelete = () => screen.getByRole('button', { name: 'Delete' })
const sheetConfirm = () => screen.getByRole('button', { name: 'Delete event' })

let confirmSpy
beforeEach(() => {
  apiFetchSpy.mockReset()
  navigateSpy.mockReset()
  dataRef.event = { ...EVENT }
  dataRef.project = { id: 'p1', name: 'Tomatoes 2026' }
  wireApiFetch()
  confirmSpy = vi.spyOn(window, 'confirm')
})
afterEach(() => { confirmSpy.mockRestore(); cleanup() })

describe('EventDetail — delete interposes EventDeleteConfirm (DD9 / W-EVTDEL)', () => {
  it('the Delete tap opens the confirm dialog and fires NO API call', async () => {
    renderEventDetail()
    await flushLoad()
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(headerDelete())

    const dlg = screen.getByRole('dialog')
    expect(dlg.textContent).toContain('Delete this event?')
    // Soft-delete truthfulness: the sheet must not resurrect the old "permanently" lie.
    expect(dlg.textContent).not.toMatch(/permanent/i)
    expect(deleteCalls()).toHaveLength(0)
    expect(navigateSpy).not.toHaveBeenCalled()
  })

  it('window.confirm is never consulted — the sheet replaced it, not wrapped it', async () => {
    renderEventDetail()
    await flushLoad()
    fireEvent.click(headerDelete())
    await act(async () => { fireEvent.click(sheetConfirm()) })
    expect(confirmSpy).not.toHaveBeenCalled()
  })

  it('cancel ABORTS: the sheet closes and no DELETE is ever sent', async () => {
    renderEventDetail()
    await flushLoad()
    fireEvent.click(headerDelete())
    expect(screen.getByRole('dialog')).toBeTruthy()

    // The ConfirmBody Cancel button and the Sheet chrome close BOTH carry the name "Cancel";
    // either must abort. Click the body button (last in document order).
    const cancels = screen.getAllByRole('button', { name: 'Cancel' })
    fireEvent.click(cancels[cancels.length - 1])

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(deleteCalls()).toHaveLength(0)
    expect(navigateSpy).not.toHaveBeenCalled()
    // Re-arming still works after an abort.
    fireEvent.click(headerDelete())
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('confirm PROCEEDS: exactly one DELETE /api/events/e1, then the post-delete navigation', async () => {
    renderEventDetail()
    await flushLoad()
    fireEvent.click(headerDelete())

    await act(async () => { fireEvent.click(sheetConfirm()) })

    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith('/projects/p1'))
    const dels = deleteCalls()
    expect(dels).toHaveLength(1)
    expect(dels[0][0]).toBe('/api/events/e1')
  })

  it('a failed DELETE closes the sheet and surfaces the error inline (no navigation)', async () => {
    apiFetchSpy.mockImplementation((path, opts = {}) => {
      if (path === '/api/events/e1' && opts.method === 'DELETE') return Promise.reject(new Error('nope'))
      if (path === '/api/events/e1') return Promise.resolve(dataRef.event)
      if (path === '/api/projects/p1') return Promise.resolve(dataRef.project)
      return Promise.resolve(null)
    })
    renderEventDetail()
    await flushLoad()
    fireEvent.click(headerDelete())
    await act(async () => { fireEvent.click(sheetConfirm()) })

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(navigateSpy).not.toHaveBeenCalled()
    expect(screen.getByText('nope')).toBeTruthy()
  })
})
