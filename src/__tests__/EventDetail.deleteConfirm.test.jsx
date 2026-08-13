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

// ── V4-EVTDELCONFIRM-001 — the photo path, now REACHABLE. GET /api/events/:id reports the event's
// photos + cover usage; the sheet's offer/disclosure populate from it, and { deletePhotos } is
// honored via the live DELETE /api/photos/:id (W-DEL soft deletes). ProjectDetail's suite pins the
// same semantics on the other surface — the two must not diverge. ────────────────────────────────
const PHOTOS = [
  { id: 'ph-1', storage_path: 'events/e1/a.jpg', cover_for: [] },
  { id: 'ph-2', storage_path: 'events/e1/b.jpg', cover_for: [{ type: 'planting', id: 'g1', name: 'Celebrity Rescue' }] },
]

// Records every call as "METHOD path", in order — the sequencing assertions read this, not the
// spy's argument lists.
function wirePhotoPath({ failIds = [] } = {}) {
  const log = []
  apiFetchSpy.mockImplementation((path, opts = {}) => {
    const method = opts.method ?? 'GET'
    log.push(`${method} ${path}`)
    if (method === 'DELETE' && path === '/api/events/e1') return Promise.resolve({ ok: true })
    if (method === 'DELETE' && path.startsWith('/api/photos/')) {
      const id = path.slice('/api/photos/'.length)
      return failIds.includes(id)
        ? Promise.reject(new Error('photo delete failed'))
        : Promise.resolve({ id, deleted_at: '2026-08-12T00:00:00Z', affected: [] })
    }
    if (path === '/api/events/e1') return Promise.resolve(dataRef.event)
    if (path === '/api/projects/p1') return Promise.resolve(dataRef.project)
    return Promise.resolve(null)
  })
  return log
}

const photoDeletes = (log) => log.filter((l) => l.startsWith('DELETE /api/photos/'))
// Once the box is ticked the confirm's accessible name grows to "Delete event and N photos" —
// the exact-name sheetConfirm() above would miss it, so the photo-path tests match the prefix.
const confirmBtn = () => screen.getByRole('button', { name: /^Delete event/ })

describe('EventDetail — the photo path (V4-EVTDELCONFIRM-001)', () => {
  it('the sheet shows the photoCount and NAMES the cover parent from the GET payload', async () => {
    dataRef.event = { ...EVENT, photos: PHOTOS }
    wirePhotoPath()
    renderEventDetail()
    await flushLoad()
    fireEvent.click(headerDelete())

    expect(screen.getByText('Also delete all 2 photos')).toBeTruthy()
    expect(screen.getByTestId('cover-disclosure').textContent).toContain('Celebrity Rescue')
  })

  it('UNCHECKED (the default) fires ZERO photo DELETEs — today\'s behavior exactly', async () => {
    dataRef.event = { ...EVENT, photos: PHOTOS }
    const log = wirePhotoPath()
    renderEventDetail()
    await flushLoad()
    fireEvent.click(headerDelete())
    await act(async () => { fireEvent.click(sheetConfirm()) })

    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith('/projects/p1'))
    expect(log).toContain('DELETE /api/events/e1')
    expect(photoDeletes(log)).toHaveLength(0)
  })

  it('CHECKED fires one DELETE per photo, all AFTER the event DELETE, then navigates', async () => {
    dataRef.event = { ...EVENT, photos: PHOTOS }
    const log = wirePhotoPath()
    renderEventDetail()
    await flushLoad()
    fireEvent.click(headerDelete())
    fireEvent.click(screen.getByRole('checkbox'))
    await act(async () => { fireEvent.click(confirmBtn()) })

    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith('/projects/p1'))
    const dels = photoDeletes(log)
    expect(dels.sort()).toEqual(['DELETE /api/photos/ph-1', 'DELETE /api/photos/ph-2'])
    // Order: the photo writes fire only after the event DELETE succeeded.
    const evIdx = log.indexOf('DELETE /api/events/e1')
    for (const d of dels) expect(log.indexOf(d)).toBeGreaterThan(evIdx)
  })

  it('partial failure: continue-and-report — honest banner, NO navigation, sheet closed', async () => {
    dataRef.event = { ...EVENT, photos: PHOTOS }
    const log = wirePhotoPath({ failIds: ['ph-2'] })
    renderEventDetail()
    await flushLoad()
    fireEvent.click(headerDelete())
    fireEvent.click(screen.getByRole('checkbox'))
    await act(async () => { fireEvent.click(confirmBtn()) })

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // Continue-and-report: BOTH deletes were attempted (one failure never strands the rest)…
    expect(photoDeletes(log)).toHaveLength(2)
    // …the report is an honest count, and navigation is withheld — leaving the page would discard
    // the only surface the message has.
    expect(screen.getByText(/1 of 2 photos could not be deleted/)).toBeTruthy()
    expect(navigateSpy).not.toHaveBeenCalled()
  })

  it('coverFor is deduped across photos — one entity covered twice is named ONCE', async () => {
    dataRef.event = {
      ...EVENT,
      photos: [
        { id: 'ph-1', storage_path: 'a.jpg', cover_for: [{ type: 'planting', id: 'g1', name: 'Celebrity Rescue' }] },
        { id: 'ph-2', storage_path: 'b.jpg', cover_for: [{ type: 'planting', id: 'g1', name: 'Celebrity Rescue' }] },
      ],
    }
    wirePhotoPath()
    renderEventDetail()
    await flushLoad()
    fireEvent.click(headerDelete())

    const line = screen.getByTestId('cover-disclosure').textContent
    expect(line).toContain('Celebrity Rescue')
    expect(line).not.toContain('Celebrity Rescue and Celebrity Rescue')
  })

  it('the Delete tap RE-READS the event, so a photo attached after mount still gets the offer', async () => {
    // PhotoUpload sits on this very page — the mount-time photo set can be stale by delete time.
    dataRef.event = { ...EVENT, photos: [] }
    wirePhotoPath()
    renderEventDetail()
    await flushLoad()

    dataRef.event = { ...EVENT, photos: PHOTOS }
    await act(async () => { fireEvent.click(headerDelete()) })

    await waitFor(() => expect(screen.getByText('Also delete all 2 photos')).toBeTruthy())
  })

  it('an event with NO photos keeps the plain sheet — no checkbox, no disclosure', async () => {
    dataRef.event = { ...EVENT, photos: [] }
    wirePhotoPath()
    renderEventDetail()
    await flushLoad()
    fireEvent.click(headerDelete())
    await act(async () => { await Promise.resolve() })

    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByTestId('cover-disclosure')).toBeNull()
  })
})
