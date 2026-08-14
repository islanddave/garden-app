// BUG-PROJEVENTTRUNC-001 + BUG-DELNOOPOK-001 fallout — ProjectDetail's event log.
//
// This surface had ZERO test coverage before this file, in a 1,300-line page, which is how it shipped
// silently truncated at 50 rows for a year: nothing here could go red. Every assertion below exists
// because the corresponding mistake is invisible without it.
//
// Harness mirrors ProjectDetail.deleteConfirm.test.jsx (router fully stubbed; heavy children stubbed).

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

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

import ProjectDetail, { normalizeEventPage } from '../pages/ProjectDetail.jsx'

const PROJECT = {
  id: 'proj-1', name: 'Peppers', slug: 'peppers', status: 'growing',
  is_public: false, start_date: '2026-03-15', parent_project_id: null,
  version: 4, variety: null, species: null, description: null, location_id: null,
  event_count: 5257,
}

const ev = (n) => ({
  id: `ev-${n}`, event_type: 'observation', event_date: '2026-05-10T12:00:00.000Z',
  title: `Event ${n}`, notes: null, private_notes: null, quantity: null,
})
const page = (from, count) => Array.from({ length: count }, (_, i) => ev(from + i))

// path -> response, for the event-list URLs only. Everything else gets the standard stubs.
function wire({ eventPages = {}, projectDelete, eventDelete } = {}) {
  apiFetchSpy.mockImplementation((path, opts = {}) => {
    const method = opts.method ?? 'GET'
    if (path === '/api/projects/proj-1' && method === 'DELETE') {
      return projectDelete ? projectDelete() : Promise.resolve({ ok: true })
    }
    if (/^\/api\/events\/ev-\d+$/.test(path) && method === 'DELETE') {
      return eventDelete ? eventDelete() : Promise.resolve({ ok: true })
    }
    if (path.startsWith('/api/events?project_id=proj-1')) {
      const offset = Number(new URLSearchParams(path.split('?')[1]).get('offset'))
      return Promise.resolve(eventPages[offset] ?? { events: [], limit: 200, offset, has_more: false })
    }
    if (/^\/api\/events\/ev-\d+$/.test(path)) return Promise.resolve({ ...ev(1), photos: [] })
    if (path === '/api/projects/proj-1') return Promise.resolve(PROJECT)
    // No sub-projects, so the delete dialog renders its plain "Delete project?" arm.
    if (path.startsWith('/api/projects?parent_id=')) return Promise.resolve([])
    if (path === '/api/locations/with-path') return Promise.resolve([])
    if (path.startsWith('/api/projects')) return Promise.resolve([PROJECT])
    if (path.startsWith('/api/plants')) return Promise.resolve([])
    return Promise.resolve(null)
  })
}

const listCalls = () => apiFetchSpy.mock.calls
  .filter(([p, o]) => p.startsWith('/api/events?project_id=proj-1') && (o?.method ?? 'GET') === 'GET')
  .map(([p]) => p)
const rows = () => screen.queryAllByTitle('Delete event')
const showMore = () => screen.queryByTestId('project-event-log-show-more')

beforeEach(() => { apiFetchSpy.mockReset(); navigateSpy.mockReset() })
afterEach(() => cleanup())

// ── the pure half ────────────────────────────────────────────────────────────────────────────────
// normalizeEventPage is the seam that lets this page survive the deploy window in which the SPA
// has shipped and the Lambda has not. Tested directly because the array arm is otherwise
// unreachable in prod and would rot into a silent crash.
describe('normalizeEventPage', () => {
  it('reads the paged envelope, taking has_more from the server rather than guessing', () => {
    expect(normalizeEventPage({ events: [ev(1)], limit: 200, offset: 0, has_more: true }))
      .toEqual({ events: [ev(1)], hasMore: true })
    expect(normalizeEventPage({ events: [ev(1)], limit: 200, offset: 0, has_more: false }).hasMore).toBe(false)
  })

  it('tolerates a bare array from a pre-offset Lambda, inferring hasMore from a full page', () => {
    expect(normalizeEventPage(page(1, 3), 3)).toEqual({ events: page(1, 3), hasMore: true })
    expect(normalizeEventPage(page(1, 2), 3)).toEqual({ events: page(1, 2), hasMore: false })
  })

  it('never throws on null/undefined/garbage — a failed page must not blank the log', () => {
    expect(normalizeEventPage(null)).toEqual({ events: [], hasMore: false })
    expect(normalizeEventPage(undefined)).toEqual({ events: [], hasMore: false })
    expect(normalizeEventPage({ events: 'nope' })).toEqual({ events: [], hasMore: false })
  })
})

// ── the fetch contract ───────────────────────────────────────────────────────────────────────────
describe('ProjectDetail event log — asks Route 4 for a real page', () => {
  // THE ORIGINAL BUG. Sending no limit took Route 4's 50-row default and presented it as the whole
  // history. MUTATION: drop &limit from eventsPath -> RED.
  it('the first fetch carries limit=200 and offset=0', async () => {
    wire({ eventPages: { 0: { events: page(1, 2), has_more: false } } })
    render(<ProjectDetail />)
    await waitFor(() => expect(rows()).toHaveLength(2))
    expect(listCalls()[0]).toBe('/api/events?project_id=proj-1&limit=200&offset=0')
  })

  // offset MUST be present on the first request: Route 4 discriminates the envelope on presence,
  // so omitting it here would return an array and hasMore would be a length guess forever.
  it('sends offset even on page 0, which is what opts this page into the envelope', async () => {
    wire({ eventPages: { 0: { events: page(1, 1), has_more: false } } })
    render(<ProjectDetail />)
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(listCalls()[0]).toContain('offset=0')
  })
})

describe('ProjectDetail event log — paging', () => {
  it('hides Show more when the server says the history is complete', async () => {
    wire({ eventPages: { 0: { events: page(1, 3), has_more: false } } })
    render(<ProjectDetail />)
    await waitFor(() => expect(rows()).toHaveLength(3))
    expect(showMore()).toBeNull()
  })

  it('offers Show more when the server says more remain, and appends the next page', async () => {
    wire({
      eventPages: {
        0: { events: page(1, 3), has_more: true },
        3: { events: page(4, 2), has_more: false },
      },
    })
    render(<ProjectDetail />)
    await waitFor(() => expect(rows()).toHaveLength(3))
    expect(showMore()).not.toBeNull()

    fireEvent.click(showMore())
    await waitFor(() => expect(rows()).toHaveLength(5))
    // The second request's offset is the number of rows already held — the whole point of paging.
    expect(listCalls()[1]).toBe('/api/events?project_id=proj-1&limit=200&offset=3')
    // And the button retires once the last page lands.
    expect(showMore()).toBeNull()
    expect(screen.getByText('Event 5')).toBeTruthy()
  })

  // OFFSET paging is positional: an event logged between two page fetches shifts every later row
  // by one and re-serves a row the client already holds. MUTATION: drop the id dedupe in
  // loadMoreEvents -> RED with 5 rows, two of them the same event rendered twice.
  it('dedupes by id, so a row that shifts across the page seam is not rendered twice', async () => {
    wire({
      eventPages: {
        0: { events: page(1, 3), has_more: true },
        3: { events: [ev(3), ev(4)], has_more: false },
      },
    })
    render(<ProjectDetail />)
    await waitFor(() => expect(rows()).toHaveLength(3))
    fireEvent.click(showMore())
    await waitFor(() => expect(rows()).toHaveLength(4))
    expect(screen.getAllByText('Event 3')).toHaveLength(1)
  })

  it('a failed page leaves the rows already loaded alone and re-arms the button', async () => {
    wire({ eventPages: { 0: { events: page(1, 3), has_more: true } } })
    render(<ProjectDetail />)
    await waitFor(() => expect(rows()).toHaveLength(3))

    const boom = Object.assign(new Error('offline'), { status: 500 })
    const prev = apiFetchSpy.getMockImplementation()
    apiFetchSpy.mockImplementation((path, opts) =>
      path.startsWith('/api/events?project_id=proj-1&limit=200&offset=3')
        ? Promise.reject(boom) : prev(path, opts))
    fireEvent.click(showMore())
    await waitFor(() => expect(showMore()?.disabled).toBe(false))
    expect(rows()).toHaveLength(3)
  })
})

describe('ProjectDetail event log — the count badge', () => {
  // It used to read (50) on a 5,257-event project: the truncation displayed as the total.
  it('counts loaded rows exactly once the history is complete', async () => {
    wire({ eventPages: { 0: { events: page(1, 3), has_more: false } } })
    render(<ProjectDetail />)
    await waitFor(() => expect(rows()).toHaveLength(3))
    expect(screen.getByText('(3)')).toBeTruthy()
  })

  // MUTATION: use project.event_count instead -> RED here, and wrong in prod: event_count is a
  // plain COUNT over event_log that knows nothing about the archived-planting filter this change
  // added to the same list, so three prod projects would show a non-zero badge over an empty log.
  it('appends "+" while more remain, and never shows the server total', async () => {
    wire({ eventPages: { 0: { events: page(1, 3), has_more: true } } })
    render(<ProjectDetail />)
    await waitFor(() => expect(rows()).toHaveLength(3))
    expect(screen.getByText('(3+)')).toBeTruthy()
    expect(screen.queryByText('(5257)')).toBeNull()
  })
})

// ── BUG-DELNOOPOK-001 fallout ────────────────────────────────────────────────────────────────────
// The DELETE routes now answer 404 instead of {ok:true} when nothing matched, and apiFetch throws
// on non-2xx. Deleting something already gone is, from the user's seat, success.
describe('ProjectDetail delete — 404 tolerance', () => {
  const openDeleteDialog = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await screen.findByText('Delete project?')
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }))
  }

  it('a 404 on DELETE project still navigates away (the record is already gone)', async () => {
    const gone = Object.assign(new Error('Not found'), { status: 404 })
    wire({
      eventPages: { 0: { events: [], has_more: false } },
      projectDelete: () => Promise.reject(gone),
    })
    render(<ProjectDetail />)
    await screen.findByRole('button', { name: 'Delete' })
    await openDeleteDialog()
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith('/projects'))
  })

  // The other half, and the one that makes the tolerance narrow rather than a blanket swallow.
  // MUTATION: catch every error instead of only 404 -> RED. A 500 would silently look like a
  // successful delete and the project would still be there when the user came back.
  it('a 500 on DELETE project does NOT navigate — a genuine failure still fails', async () => {
    const boom = Object.assign(new Error('server exploded'), { status: 500 })
    wire({
      eventPages: { 0: { events: [], has_more: false } },
      projectDelete: () => Promise.reject(boom),
    })
    render(<ProjectDetail />)
    await screen.findByRole('button', { name: 'Delete' })
    await openDeleteDialog()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy())
    expect(navigateSpy).not.toHaveBeenCalled()
  })

  it('a 404 on DELETE event still closes the sheet and refreshes the list', async () => {
    const gone = Object.assign(new Error('Not found'), { status: 404 })
    wire({
      eventPages: { 0: { events: page(1, 1), has_more: false } },
      eventDelete: () => Promise.reject(gone),
    })
    render(<ProjectDetail />)
    await waitFor(() => expect(rows()).toHaveLength(1))
    const before = listCalls().length

    fireEvent.click(rows()[0])
    fireEvent.click(await screen.findByRole('button', { name: 'Delete event' }))
    await waitFor(() => expect(listCalls().length).toBe(before + 1))
    expect(screen.queryByRole('button', { name: 'Delete event' })).toBeNull()
  })
})
