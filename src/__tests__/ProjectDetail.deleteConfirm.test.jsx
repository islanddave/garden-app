// DD9 / W-EVTDEL adoption — ProjectDetail's per-row event delete (the × on each EventRow) now
// interposes EventDeleteConfirm instead of window.confirm. Pins the SAME three confirm-step
// invariants as EventDetail.deleteConfirm.test.jsx — the two event-delete surfaces must not
// diverge:
//   1. the × tap OPENS the dialog and fires no API call,
//   2. cancel ABORTS — sheet closes, no DELETE sent, the row survives,
//   3. confirm PROCEEDS — the byte-identical DELETE /api/events/:id fires, then refreshEvents.
// Plus the window.confirm-is-gone regression pin.
//
// Harness mirrors ProjectDetail.reparent.test.jsx (router fully stubbed; heavy children stubbed).

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react'

const { apiFetchSpy, navigateSpy, paramsRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  paramsRef: { id: 'proj-1' },
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => (<a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>),
  useParams: () => paramsRef,
  useNavigate: () => navigateSpy,
}))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: vi.fn(), isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))
vi.mock('../components/PhotoUpload.jsx', () => ({ default: () => <div data-testid="photo-upload-stub" /> }))
vi.mock('../components/Breadcrumb.jsx', () => ({ default: () => <div data-testid="breadcrumb-stub" /> }))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <div data-testid="favorite-toggle-stub" /> }))
vi.mock('../components/AssigneePicker.jsx', () => ({ default: () => <div data-testid="assignee-stub" /> }))
vi.mock('../lib/status.js', () => ({ getStatusColors: () => ({ bg: '#fff', text: '#000', border: '#ccc' }) }))

import ProjectDetail from '../pages/ProjectDetail.jsx'

const PROJECT = {
  id: 'proj-1', name: 'Charentais', slug: 'charentais', status: 'growing',
  is_public: false, start_date: '2026-03-15', parent_project_id: null,
  version: 4, variety: null, species: null, description: null, location_id: null,
}
const EVENTS = [{
  id: 'ev-1', event_type: 'observation', event_date: '2026-05-10T12:00:00.000Z',
  title: 'Watered deeply', notes: null, private_notes: null, quantity: null,
}]

const deleteCalls = () => apiFetchSpy.mock.calls.filter(([, opts]) => opts?.method === 'DELETE')

function wire({ deleteError = null } = {}) {
  apiFetchSpy.mockImplementation((path, opts = {}) => {
    const method = opts.method ?? 'GET'
    if (path === '/api/events/ev-1' && method === 'DELETE') {
      return deleteError ? Promise.reject(deleteError) : Promise.resolve({ ok: true })
    }
    if (path === '/api/projects/proj-1') return Promise.resolve(PROJECT)
    if (path.startsWith('/api/events')) return Promise.resolve([...EVENTS])
    if (path === '/api/locations/with-path') return Promise.resolve([])
    if (path === '/api/projects') return Promise.resolve([PROJECT])
    if (path.startsWith('/api/plants')) return Promise.resolve([])
    return Promise.resolve(null)
  })
}

// The per-row delete affordance (EventRow's ×) vs the sheet's confirm button.
const rowDelete = () => screen.getByTitle('Delete event')
const sheetConfirm = () => screen.getByRole('button', { name: 'Delete event' })
// BUG-PROJEVENTTRUNC-001 widened this URL with &limit=&offset= (the page now asks Route 4 for a
// real page rather than riding its 50-row default). Matched by PREFIX so this counter keeps
// measuring what it was written to measure — how many times the list refetched — instead of
// silently going to zero and passing the "no extra fetch" half of these assertions vacuously.
const eventsListFetches = () =>
  apiFetchSpy.mock.calls.filter(([path, opts]) =>
    path.startsWith('/api/events?project_id=proj-1') && (opts?.method ?? 'GET') === 'GET').length

let confirmSpy
beforeEach(() => {
  apiFetchSpy.mockReset()
  navigateSpy.mockReset()
  confirmSpy = vi.spyOn(window, 'confirm')
})
afterEach(() => { confirmSpy.mockRestore(); cleanup() })

async function renderLoaded() {
  await act(async () => { render(<ProjectDetail />) })
  await screen.findByText('Watered deeply')
}

describe('ProjectDetail — event delete interposes EventDeleteConfirm (DD9 / W-EVTDEL)', () => {
  it('the × tap opens the confirm dialog and fires NO API call', async () => {
    wire()
    await renderLoaded()
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(rowDelete())

    const dlg = screen.getByRole('dialog')
    expect(dlg.textContent).toContain('Delete this event?')
    // Soft-delete truthfulness — no "permanently" claim anywhere in the sheet.
    expect(dlg.textContent).not.toMatch(/permanent/i)
    expect(deleteCalls()).toHaveLength(0)
  })

  it('window.confirm is never consulted — the sheet replaced it, not wrapped it', async () => {
    wire()
    await renderLoaded()
    fireEvent.click(rowDelete())
    await act(async () => { fireEvent.click(sheetConfirm()) })
    expect(confirmSpy).not.toHaveBeenCalled()
  })

  it('cancel ABORTS: sheet closes, no DELETE sent, the row survives, and re-arming works', async () => {
    wire()
    await renderLoaded()
    fireEvent.click(rowDelete())
    expect(screen.getByRole('dialog')).toBeTruthy()

    const cancels = screen.getAllByRole('button', { name: 'Cancel' })
    fireEvent.click(cancels[cancels.length - 1])

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(deleteCalls()).toHaveLength(0)
    expect(screen.getByText('Watered deeply')).toBeTruthy()
    fireEvent.click(rowDelete())
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('confirm PROCEEDS: exactly one DELETE /api/events/ev-1, the list refetches, the sheet closes', async () => {
    wire()
    await renderLoaded()
    const listFetchesBefore = eventsListFetches()
    fireEvent.click(rowDelete())

    await act(async () => { fireEvent.click(sheetConfirm()) })

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const dels = deleteCalls()
    expect(dels).toHaveLength(1)
    expect(dels[0][0]).toBe('/api/events/ev-1')
    // refreshEvents ran after the delete — the timeline re-syncs with the server.
    expect(eventsListFetches()).toBe(listFetchesBefore + 1)
  })

  it('a failed DELETE still closes the sheet and never crashes the page (legacy behavior kept)', async () => {
    wire({ deleteError: new Error('nope') })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await renderLoaded()
    fireEvent.click(rowDelete())
    await act(async () => { fireEvent.click(sheetConfirm()) })

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByText('Watered deeply')).toBeTruthy()
    errSpy.mockRestore()
  })
})

// ── V4-EVTDELCONFIRM-001 — the photo path on THIS surface: the project events list carries no
// photo data, so arming a delete LAZILY fetches the single event (GET /api/events/:id now reports
// photos + cover usage) — one read per delete-tap. { deletePhotos } semantics are pinned to match
// EventDetail.deleteConfirm.test.jsx verbatim — the two surfaces must not diverge. ────────────────
const PHOTOS = [
  { id: 'ph-1', storage_path: 'events/ev-1/a.jpg', cover_for: [] },
  { id: 'ph-2', storage_path: 'events/ev-1/b.jpg', cover_for: [{ type: 'planting', id: 'g1', name: 'Celebrity Rescue' }] },
]

// Records every call as "METHOD path", in order — sequencing assertions read this.
function wirePhotoPath({ photos = PHOTOS, failIds = [] } = {}) {
  const log = []
  apiFetchSpy.mockImplementation((path, opts = {}) => {
    const method = opts.method ?? 'GET'
    log.push(`${method} ${path}`)
    if (path === '/api/events/ev-1' && method === 'DELETE') return Promise.resolve({ ok: true })
    // The lazy per-arm read — must be matched BEFORE the startsWith list arm below.
    if (path === '/api/events/ev-1' && method === 'GET') return Promise.resolve({ ...EVENTS[0], photos })
    if (method === 'DELETE' && path.startsWith('/api/photos/')) {
      const id = path.slice('/api/photos/'.length)
      return failIds.includes(id)
        ? Promise.reject(new Error('photo delete failed'))
        : Promise.resolve({ id, deleted_at: '2026-08-12T00:00:00Z', affected: [] })
    }
    if (path === '/api/projects/proj-1') return Promise.resolve(PROJECT)
    if (path.startsWith('/api/events')) return Promise.resolve([...EVENTS])
    if (path === '/api/locations/with-path') return Promise.resolve([])
    if (path === '/api/projects') return Promise.resolve([PROJECT])
    if (path.startsWith('/api/plants')) return Promise.resolve([])
    return Promise.resolve(null)
  })
  return log
}

const photoDeletes = (log) => log.filter((l) => l.startsWith('DELETE /api/photos/'))
// Once the box is ticked the confirm's accessible name grows to "Delete event and N photos" —
// the exact-name sheetConfirm() above would miss it, so the photo-path tests match the prefix.
const confirmBtn = () => screen.getByRole('button', { name: /^Delete event/ })

async function armAndSettle() {
  await act(async () => { fireEvent.click(rowDelete()) })
}

describe('ProjectDetail — the photo path (V4-EVTDELCONFIRM-001)', () => {
  it('arming LAZILY fetches the single event; the sheet shows the count and names the cover parent', async () => {
    const log = wirePhotoPath()
    await renderLoaded()
    expect(log).not.toContain('GET /api/events/ev-1') // no per-event reads at list time — no bloat
    await armAndSettle()

    expect(log).toContain('GET /api/events/ev-1')
    expect(screen.getByText('Also delete all 2 photos')).toBeTruthy()
    expect(screen.getByTestId('cover-disclosure').textContent).toContain('Celebrity Rescue')
  })

  it('UNCHECKED (the default) fires ZERO photo DELETEs — today\'s behavior exactly', async () => {
    const log = wirePhotoPath()
    await renderLoaded()
    await armAndSettle()
    await act(async () => { fireEvent.click(sheetConfirm()) })

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(log).toContain('DELETE /api/events/ev-1')
    expect(photoDeletes(log)).toHaveLength(0)
  })

  it('CHECKED fires one DELETE per photo, all AFTER the event DELETE; the list still refetches', async () => {
    const log = wirePhotoPath()
    await renderLoaded()
    const listFetchesBefore = eventsListFetches()
    await armAndSettle()
    fireEvent.click(screen.getByRole('checkbox'))
    await act(async () => { fireEvent.click(confirmBtn()) })

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const dels = photoDeletes(log)
    expect(dels.sort()).toEqual(['DELETE /api/photos/ph-1', 'DELETE /api/photos/ph-2'])
    const evIdx = log.indexOf('DELETE /api/events/ev-1')
    for (const d of dels) expect(log.indexOf(d)).toBeGreaterThan(evIdx)
    expect(eventsListFetches()).toBe(listFetchesBefore + 1)
  })

  it('partial failure: continue-and-report — honest banner, sheet closed, page alive', async () => {
    const log = wirePhotoPath({ failIds: ['ph-2'] })
    await renderLoaded()
    await armAndSettle()
    fireEvent.click(screen.getByRole('checkbox'))
    await act(async () => { fireEvent.click(confirmBtn()) })

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // Both deletes attempted — one failure never strands the rest.
    expect(photoDeletes(log)).toHaveLength(2)
    // Same copy as EventDetail's banner (the two surfaces must not diverge).
    expect(screen.getByText(/1 of 2 photos could not be deleted/)).toBeTruthy()
  })

  it('a failed lazy read degrades to the plain sheet — no checkbox, and the delete still works', async () => {
    const log = wirePhotoPath()
    apiFetchSpy.mockImplementation((path, opts = {}) => {
      const method = opts.method ?? 'GET'
      log.push(`${method} ${path}`)
      if (path === '/api/events/ev-1' && method === 'DELETE') return Promise.resolve({ ok: true })
      if (path === '/api/events/ev-1' && method === 'GET') return Promise.reject(new Error('offline'))
      if (path === '/api/projects/proj-1') return Promise.resolve(PROJECT)
      if (path.startsWith('/api/events')) return Promise.resolve([...EVENTS])
      if (path === '/api/locations/with-path') return Promise.resolve([])
      if (path === '/api/projects') return Promise.resolve([PROJECT])
      if (path.startsWith('/api/plants')) return Promise.resolve([])
      return Promise.resolve(null)
    })
    await renderLoaded()
    await armAndSettle()

    // No offer is safer than a wrong one — the unchecked default IS today's behavior.
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.queryByRole('checkbox')).toBeNull()

    await act(async () => { fireEvent.click(sheetConfirm()) })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(log).toContain('DELETE /api/events/ev-1')
    expect(photoDeletes(log)).toHaveLength(0)
  })
})
