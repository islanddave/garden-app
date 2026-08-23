// Two ProjectDetail delete-path failures that used to render as benign successes.
//
//   BUG-PROJDELORPHAN-001 — the pre-delete orphan check caught into `[]`, and `[]` is also what a
//   project with no sub-projects reads as, so a 500/offline/expired-token check opened the dialog
//   on its REASSURING branch: "Delete project?", "This will permanently remove the project", no
//   warning, no list. The user confirmed a destructive delete believing nothing was downstream.
//
//   BUG-EVENTDELSILENT-001 — confirmEventDelete's outer catch was a bare console.error, so a failed
//   event delete closed the sheet, cleared the spinner and said nothing while the row stayed put.
//
// The discriminating assertion in BOTH sections is a PAIR: the failure case and the ordinary
// success case are asserted against each other, because either one alone is satisfied by the buggy
// code — a failed check already rendered a valid-looking dialog, and a failed delete already left
// a valid-looking list.
//
// Harness mirrors ProjectDetail.deleteConfirm.test.jsx (router fully stubbed; heavy children
// stubbed) so the two files disagree about nothing except what the requests do.

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
const CHILD = { id: 'proj-2', name: 'Second sowing' }
const boom = (status = 500) => Object.assign(new Error('server exploded'), { status })

// Knobs are per-request-shape so a test names only the request it is breaking. `refreshFails` is
// scoped to refetches that happen AFTER the event DELETE — the mount-time load must still succeed
// or there is no row to delete.
function wire({
  childProjects = [],
  childCheck = null,                   // () => Promise ; overrides the childProjects arm
  eventDelete = () => Promise.resolve({ ok: true }),
  eventsAfterDelete = null,            // null => the same list comes back
  refreshFails = false,
  photos = [],
  photoDeleteFails = [],
} = {}) {
  const log = []
  let deleteSeen = false
  apiFetchSpy.mockImplementation((path, opts = {}) => {
    const method = opts.method ?? 'GET'
    log.push(`${method} ${path}`)
    if (path === '/api/events/ev-1' && method === 'DELETE') { deleteSeen = true; return eventDelete() }
    if (path === '/api/events/ev-1' && method === 'GET') return Promise.resolve({ ...EVENTS[0], photos })
    if (method === 'DELETE' && path.startsWith('/api/photos/')) {
      const pid = path.slice('/api/photos/'.length)
      return photoDeleteFails.includes(pid)
        ? Promise.reject(new Error('photo delete failed'))
        : Promise.resolve({ id: pid, deleted_at: '2026-08-23T00:00:00Z', affected: [] })
    }
    if (path === '/api/projects/proj-1/archive') return Promise.resolve({ archived_at: '2026-08-23T00:00:00Z' })
    if (path === '/api/projects/proj-1' && method === 'DELETE') return Promise.resolve({ ok: true })
    if (path === '/api/projects/proj-1') return Promise.resolve(PROJECT)
    if (path.startsWith('/api/projects?parent_id=')) {
      return childCheck ? childCheck() : Promise.resolve(childProjects)
    }
    if (path.startsWith('/api/events?project_id=')) {
      if (deleteSeen && refreshFails) return Promise.reject(boom())
      return Promise.resolve(deleteSeen && eventsAfterDelete ? [...eventsAfterDelete] : [...EVENTS])
    }
    if (path === '/api/locations/with-path') return Promise.resolve([])
    if (path === '/api/projects') return Promise.resolve([PROJECT])
    if (path.startsWith('/api/plants')) return Promise.resolve([])
    return Promise.resolve(null)
  })
  return log
}

let errSpy
beforeEach(() => {
  apiFetchSpy.mockReset()
  navigateSpy.mockReset()
  // The handlers still console.error for diagnosis; the assertions are about the SCREEN.
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { errSpy.mockRestore(); cleanup() })

async function renderLoaded() {
  await act(async () => { render(<ProjectDetail />) })
  await screen.findByText('Watered deeply')
}

// ── BUG-PROJDELORPHAN-001 ───────────────────────────────────────────────────────────────────────
const checkNotice = () => screen.queryByTestId('project-delete-check-failed')
const permanentDelete = () => screen.queryByRole('button', { name: 'Delete permanently' })
const reassurance = () => screen.queryByText(/This will permanently remove the project/)

async function openDeleteDialog() {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete' })) })
}

describe('ProjectDetail — a failed orphan check is not a safety assurance (BUG-PROJDELORPHAN-001)', () => {
  // THE bug, stated as the contrast. Neither half proves anything alone: pre-fix, a project with
  // no sub-projects already rendered this dialog, and a failed check rendered the same one.
  it('a failed check and a genuinely childless project do NOT render the same dialog', async () => {
    wire({ childCheck: () => Promise.reject(boom()) })
    await renderLoaded()
    await openDeleteDialog()

    expect(checkNotice()).toBeTruthy()
    expect(screen.getByText('We couldn’t check for sub-projects')).toBeTruthy()
    // The reassuring path is WITHDRAWN, not annotated — no copy claiming this is a clean delete…
    expect(reassurance()).toBeNull()
    // …and no button to act on that claim.
    expect(permanentDelete()).toBeNull()
    cleanup()

    // Same surface, same taps, the check succeeds and there is genuinely nothing downstream.
    wire({ childProjects: [] })
    await renderLoaded()
    await openDeleteDialog()

    expect(checkNotice()).toBeNull()
    expect(screen.getByText('Delete project?')).toBeTruthy()
    expect(reassurance()).toBeTruthy()
    expect(permanentDelete()).toBeTruthy()
  })

  it('the notice is announced, not merely drawn', async () => {
    wire({ childCheck: () => Promise.reject(boom()) })
    await renderLoaded()
    await openDeleteDialog()
    // TalkBack is how Dave would hear this; the dialog covers the page, so a silent inline note
    // on a destructive confirm is not enough.
    expect(checkNotice().getAttribute('role')).toBe('alert')
    expect(checkNotice().textContent).toContain('Couldn’t check what is filed under this project')
  })

  it('a failed check leaves the non-destructive way out reachable — Archive still works', async () => {
    const log = wire({ childCheck: () => Promise.reject(boom()) })
    await renderLoaded()
    await openDeleteDialog()
    expect(permanentDelete()).toBeNull()

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Archive instead (recommended)' })) })
    expect(log).toContain('PATCH /api/projects/proj-1/archive')
    // Blocking the delete must not block the escape hatch: archive leaves every sub-project
    // attached whether or not one exists, which is exactly why it is safe under an unknown.
    expect(log.filter(l => l === 'DELETE /api/projects/proj-1')).toHaveLength(0)
  })

  it('Retry re-runs the SAME check, and a check that comes back warning shows the real warning', async () => {
    let fail = true
    wire({ childCheck: () => (fail ? Promise.reject(boom()) : Promise.resolve([CHILD])) })
    await renderLoaded()
    await openDeleteDialog()
    expect(checkNotice()).toBeTruthy()

    fail = false
    await act(async () => { fireEvent.click(screen.getByTestId('project-delete-recheck')) })
    await waitFor(() => expect(checkNotice()).toBeNull())

    // The warning the failure had been hiding.
    expect(screen.getByText('This project has sub-projects')).toBeTruthy()
    expect(screen.getByText('Second sowing')).toBeTruthy()
    expect(permanentDelete()).toBeTruthy()
  })

  it('Retry is a button, never a submit — a broken check must not delete anything', async () => {
    const log = wire({ childCheck: () => Promise.reject(boom()) })
    await renderLoaded()
    await openDeleteDialog()
    const retry = screen.getByTestId('project-delete-recheck')
    expect(retry.getAttribute('type')).toBe('button')
    await act(async () => { fireEvent.click(retry) })
    expect(log.filter(l => l.startsWith('DELETE '))).toHaveLength(0)
  })

  it('a SUCCESSFUL check that finds children still warns and still offers the delete', async () => {
    wire({ childProjects: [CHILD] })
    await renderLoaded()
    await openDeleteDialog()
    expect(checkNotice()).toBeNull()
    expect(screen.getByText('This project has sub-projects')).toBeTruthy()
    expect(screen.getByText(/1 sub-project will become top-level/)).toBeTruthy()
    expect(permanentDelete()).toBeTruthy()
  })
})

// ── BUG-EVENTDELSILENT-001 ──────────────────────────────────────────────────────────────────────
const rowDelete = () => screen.getByTitle('Delete event')
const sheetConfirm = () => screen.getByRole('button', { name: /^Delete event/ })
const failBanner = () => screen.queryByText(/could not be deleted|could not refresh/)

async function deleteTheEvent({ checkPhotos = false } = {}) {
  await act(async () => { fireEvent.click(rowDelete()) })
  if (checkPhotos) fireEvent.click(screen.getByRole('checkbox'))
  await act(async () => { fireEvent.click(sheetConfirm()) })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
}

describe('ProjectDetail — a failed event delete is visible (BUG-EVENTDELSILENT-001)', () => {
  // THE bug, stated as the contrast. Pre-fix both arms ended the same way: sheet closed, spinner
  // cleared, nothing said — the only difference being a row the user had no reason to re-read.
  it('a failed delete and a successful one do NOT render the same thing', async () => {
    wire({ eventDelete: () => Promise.reject(boom()) })
    await renderLoaded()
    await deleteTheEvent()

    expect(failBanner()).toBeTruthy()
    expect(failBanner().textContent).toContain('it is still in your log')
    // Truthful state: the event really is still there, and the list says so.
    expect(screen.getByText('Watered deeply')).toBeTruthy()
    cleanup()

    // Same surface, same taps, the delete lands.
    wire({ eventsAfterDelete: [] })
    await renderLoaded()
    await deleteTheEvent()

    expect(failBanner()).toBeNull()
    await waitFor(() => expect(screen.queryByText('Watered deeply')).toBeNull())
  })

  it('the failure is announced, and the sheet is closed so it can be seen', async () => {
    wire({ eventDelete: () => Promise.reject(boom()) })
    await renderLoaded()
    await deleteTheEvent()
    // ErrorBanner carries role="alert" — the banner sits above the timeline, where the sheet was.
    expect(failBanner().closest('[role="alert"]')).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a delete that landed but could not refresh says THAT, not "the delete failed"', async () => {
    wire({ refreshFails: true })
    await renderLoaded()
    await deleteTheEvent()

    const banner = failBanner()
    expect(banner).toBeTruthy()
    expect(banner.textContent).toContain('The event was deleted, but the log could not refresh')
    // The opposite lie is just as bad: sending someone back to re-delete a row that is already gone.
    expect(banner.textContent).not.toContain('it is still in your log')
  })

  it('a partial photo-delete report survives a refresh failure — the more actionable message wins', async () => {
    wire({
      photos: [{ id: 'ph-1', storage_path: 'events/ev-1/a.jpg', cover_for: [] }],
      photoDeleteFails: ['ph-1'],
      refreshFails: true,
    })
    await renderLoaded()
    await deleteTheEvent({ checkPhotos: true })
    expect(screen.getByText(/its photo could not be deleted/)).toBeTruthy()
  })

  // The tolerance that must NOT become a banner: deleting something already gone is, from the
  // user's seat, the outcome they asked for. Guards the fix against over-reporting.
  it('a 404 stays silent and still refreshes — already-gone is success', async () => {
    wire({ eventDelete: () => Promise.reject(boom(404)), eventsAfterDelete: [] })
    await renderLoaded()
    await deleteTheEvent()
    expect(failBanner()).toBeNull()
    await waitFor(() => expect(screen.queryByText('Watered deeply')).toBeNull())
  })

  it('arming the next delete clears a stale failure banner', async () => {
    wire({ eventDelete: () => Promise.reject(boom()) })
    await renderLoaded()
    await deleteTheEvent()
    expect(failBanner()).toBeTruthy()

    await act(async () => { fireEvent.click(rowDelete()) })
    expect(failBanner()).toBeNull()
  })
})
