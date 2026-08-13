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
const eventsListFetches = () =>
  apiFetchSpy.mock.calls.filter(([path, opts]) =>
    path === '/api/events?project_id=proj-1' && (opts?.method ?? 'GET') === 'GET').length

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
