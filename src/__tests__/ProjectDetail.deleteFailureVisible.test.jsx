// Four ProjectDetail archive/delete-path failures that used to render as benign successes.
//
//   BUG-PROJDELORPHAN-001 — the pre-delete orphan check caught into `[]`, and `[]` is also what a
//   project with no sub-projects reads as, so a 500/offline/expired-token check opened the dialog
//   on its REASSURING branch: "Delete project?", "This will permanently remove the project", no
//   warning, no list. The user confirmed a destructive delete believing nothing was downstream.
//
//   BUG-EVENTDELSILENT-001 — confirmEventDelete's outer catch was a bare console.error, so a failed
//   event delete closed the sheet, cleared the spinner and said nothing while the row stayed put.
//
//   BUG-PROJCONFIRMDELSILENT-001 — confirmDelete's outer catch was the same bare console.error one
//   page-level up, so a failed project delete OR archive closed the dialog and left the page
//   indistinguishable from a successful archive-in-place.
//
//   BUG-UNARCHIVESILENT-001 — handleUnarchive, the return leg of that same PATCH, had the fourth
//   bare console.error. The quietest of the four: it neither navigates nor closes anything, so a
//   failed unarchive left the page byte-identical to the one already on screen.
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
const ARCHIVED_AT = '2026-08-20T00:00:00.000Z'
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
  projectDelete = null,                // () => Promise ; overrides DELETE /api/projects/proj-1
  projectArchive = null,               // () => Promise ; overrides PATCH .../archive {archived:true}
  projectUnarchive = null,             // () => Promise ; overrides PATCH .../archive {archived:false}
  archived = false,                    // the project loads already archived (Unarchive button shown)
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
    if (path === '/api/projects/proj-1/archive') {
      // Both directions are the same PATCH; only the body says which, so the knobs split on it.
      if (JSON.parse(opts.body ?? '{}').archived === false) {
        return projectUnarchive ? projectUnarchive() : Promise.resolve({ archived_at: null })
      }
      return projectArchive ? projectArchive() : Promise.resolve({ archived_at: '2026-08-23T00:00:00Z' })
    }
    if (path === '/api/projects/proj-1' && method === 'DELETE') {
      return projectDelete ? projectDelete() : Promise.resolve({ ok: true })
    }
    if (path === '/api/projects/proj-1') {
      return Promise.resolve(archived ? { ...PROJECT, archived_at: ARCHIVED_AT } : PROJECT)
    }
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

// ── BUG-PROJCONFIRMDELSILENT-001 ────────────────────────────────────────────────────────────────
// The PROJECT-level twin of the section above. The dialog is dismissed before the request settles,
// so on failure the page returns to its ordinary resting state — which is why nothing on screen
// distinguished "the delete failed" from "the archive worked" pre-fix.
const projBanner = () => screen.queryByTestId('project-action-error')
const dialogOpen = () => screen.queryByText('Delete project?') != null

async function confirmProjectDelete() {
  await openDeleteDialog()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' })) })
}
async function confirmProjectArchive() {
  await openDeleteDialog()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Archive instead (recommended)' })) })
}

describe('ProjectDetail — a failed project delete/archive is visible (BUG-PROJCONFIRMDELSILENT-001)', () => {
  // THE bug, stated as the contrast. Neither half proves anything alone: pre-fix the failure arm
  // rendered a normal project page and the success arm navigated away, and "no banner" was true of
  // both. The pair is what pins the difference.
  it('a failed delete and a successful one do NOT render the same thing', async () => {
    wire({ projectDelete: () => Promise.reject(boom()) })
    await renderLoaded()
    await confirmProjectDelete()

    expect(projBanner()).toBeTruthy()
    expect(projBanner().textContent).toContain('it is still here')
    // Truthful state: the project really is still here, we are still on its page, and the Delete
    // button is live again so the banner's "try again" points at something real.
    expect(navigateSpy).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Delete' }).disabled).toBe(false)
    cleanup()

    // Same surface, same taps, the delete lands.
    navigateSpy.mockReset()
    wire()
    await renderLoaded()
    await confirmProjectDelete()

    expect(projBanner()).toBeNull()
    expect(navigateSpy).toHaveBeenCalledWith('/projects')
  })

  // Archive is the button the dialog RECOMMENDS, so its silent failure is the likelier one to be
  // hit — and it fails the most quietly of all, because the archive path stays on the page by
  // design. The only pre-fix difference between "archived" and "archive failed" was a badge the
  // user has no reason to be watching for.
  it('a failed archive and a successful one do NOT render the same thing, and it says ARCHIVE', async () => {
    wire({ projectArchive: () => Promise.reject(boom()) })
    await renderLoaded()
    await confirmProjectArchive()

    expect(projBanner()).toBeTruthy()
    expect(projBanner().textContent).toContain('could not be archived')
    // Naming the wrong verb is its own lie: this project was never up for deletion.
    expect(projBanner().textContent).not.toContain('could not be deleted')
    expect(screen.queryByText('Archived')).toBeNull()
    cleanup()

    wire()
    await renderLoaded()
    await confirmProjectArchive()

    expect(projBanner()).toBeNull()
    await waitFor(() => expect(screen.getByText('Archived')).toBeTruthy())
  })

  it('the failure is announced, and the dialog is closed so it can be seen', async () => {
    wire({ projectDelete: () => Promise.reject(boom()) })
    await renderLoaded()
    await confirmProjectDelete()
    // TalkBack, and the reason the banner lives beside the header controls rather than in the
    // deleteErr slot above the timeline: on a 390px phone that one is several scrolls away.
    expect(projBanner().getAttribute('role')).toBe('alert')
    expect(dialogOpen()).toBe(false)
  })

  // The tolerance that must NOT become a banner, mirroring the event path: a project already gone
  // is the outcome the user asked for, and navigating away is correct.
  it('a 404 stays silent and still navigates — already-gone is success', async () => {
    wire({ projectDelete: () => Promise.reject(boom(404)) })
    await renderLoaded()
    await confirmProjectDelete()
    expect(projBanner()).toBeNull()
    expect(navigateSpy).toHaveBeenCalledWith('/projects')
  })

  it('re-arming the dialog clears a stale failure banner', async () => {
    wire({ projectArchive: () => Promise.reject(boom()) })
    await renderLoaded()
    await confirmProjectArchive()
    expect(projBanner()).toBeTruthy()

    await openDeleteDialog()
    expect(projBanner()).toBeNull()
  })
})

// ── BUG-UNARCHIVESILENT-001 ─────────────────────────────────────────────────────────────────────
// The return leg of the archive PATCH, and the quietest member of the family. The other three each
// closed a dialog or navigated away, which at least gave the eye something to land on. This one
// does neither: the tap leaves the page on exactly the view it started from, so a failure and a
// success differed only by a small green badge the user has no reason to be watching.
const unarchiveBtn = () => screen.queryByRole('button', { name: 'Unarchive' })
const archivedBadge = () => screen.queryByText('Archived')

async function tapUnarchive() {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Unarchive' })) })
}

describe('ProjectDetail — a failed unarchive is visible (BUG-UNARCHIVESILENT-001)', () => {
  // THE bug, stated as the contrast. Neither half proves anything alone: pre-fix the failure arm
  // rendered an archived project page and the success arm rendered an active one, and "no banner"
  // was true of both. The pair is what pins the difference.
  it('a failed unarchive and a successful one do NOT render the same thing', async () => {
    wire({ archived: true, projectUnarchive: () => Promise.reject(boom()) })
    await renderLoaded()
    await tapUnarchive()

    expect(projBanner()).toBeTruthy()
    expect(projBanner().textContent).toContain('it is still archived')
    // Truthful state: it really is still archived, the badge still says so, and the button that
    // failed is live again so the banner's "try again" points at something real.
    expect(archivedBadge()).toBeTruthy()
    expect(unarchiveBtn().disabled).toBe(false)
    cleanup()

    // Same surface, same tap, the unarchive lands.
    wire({ archived: true })
    await renderLoaded()
    await tapUnarchive()

    expect(projBanner()).toBeNull()
    await waitFor(() => expect(archivedBadge()).toBeNull())
    expect(unarchiveBtn()).toBeNull()
  })

  it('the failure is announced, and it names UNARCHIVE rather than the opposite state', async () => {
    wire({ archived: true, projectUnarchive: () => Promise.reject(boom()) })
    await renderLoaded()
    await tapUnarchive()

    expect(projBanner().getAttribute('role')).toBe('alert')  // TalkBack
    const text = projBanner().textContent
    expect(text).toContain('could not be unarchived')
    // Reusing the archive line here would send someone whose project is still archived to look for
    // it in the active list. Wrong-verb copy is its own lie, same as the delete/archive split above.
    expect(text).not.toContain('it is still active')
    expect(text).not.toContain('could not be deleted')
  })

  // The deliberate DIVERGENCE from confirmDelete, which treats 404 as success and navigates away.
  // That tolerance is correct there and wrong here: a delete asked for the project to be gone, an
  // unarchive asked for it BACK. Guards against the tolerance being copied across by symmetry.
  it('a 404 is reported too — unlike delete, already-gone is not what Unarchive asked for', async () => {
    wire({ archived: true, projectUnarchive: () => Promise.reject(boom(404)) })
    await renderLoaded()
    await tapUnarchive()

    expect(projBanner()).toBeTruthy()
    expect(projBanner().textContent).toContain('could not be unarchived')
    expect(navigateSpy).not.toHaveBeenCalled()
  })

  // This button is its own arm — no dialog sits between the tap and the request — so the clear that
  // handleDeleteClick does on open has to happen at the top of the handler. Asserted mid-flight
  // rather than after, because a clear that only happens on success is indistinguishable from no
  // clear at all once the retry has landed.
  it('a retry clears the stale banner while it is in flight, and re-reports if it fails again', async () => {
    let release
    let attempt = 0
    wire({
      archived: true,
      projectUnarchive: () => {
        attempt += 1
        if (attempt === 1) return Promise.reject(boom())
        return new Promise((_resolve, reject) => { release = () => reject(boom()) })
      },
    })
    await renderLoaded()
    await tapUnarchive()
    expect(projBanner()).toBeTruthy()

    // Second tap, request deliberately still open. A stale failure hanging over an attempt that has
    // not resolved reads as "it failed again" before it has.
    await tapUnarchive()
    expect(projBanner()).toBeNull()
    // getAll, not get: Delete shares the same `deleting` flag, so two buttons read "Working…" here.
    expect(unarchiveBtn()).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Working…' }).length).toBeGreaterThan(0)

    // …and when it does resolve, badly, the banner comes back rather than staying cleared.
    await act(async () => { release(); await new Promise(r => setTimeout(r, 0)) })
    expect(projBanner()).toBeTruthy()
    expect(unarchiveBtn().disabled).toBe(false)
  })
})
