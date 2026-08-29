// PhotoLibrary.untaggedCount.test.jsx — V4-PHOTOBULK-001, making the drain visible.
//
// Bulk upload can now put a pile of photos into the inbox in one action, and the only route back to
// them is a filter chip that looked the same holding zero photos as holding forty. This pins the
// count that turns "Untagged" from a filter into a to-do, and — more importantly — pins the two
// cases where showing a number would be WORSE than showing none:
//
//   • Before the first list lands, `untaggedCount` is null and no badge renders. A "0" there would
//     assert an empty inbox nobody has checked.
//   • Under a project or zone filter the response is a SUBSET, so a count taken from it answers
//     "untagged within this project" while rendering in a chip that reads as global. The badge holds
//     its last unscoped value instead. A stale-but-true global count beats a fresh-but-mislabelled
//     local one, and that trade is the whole reason the guard exists.

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))

vi.mock('../lib/featureFlags.js', async (importActual) => ({
  ...(await importActual()),
  PROJECTS_HIDDEN: false,
}))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: vi.fn(), isUploading: false, error: null, photo: null, preview: null,
    stage: null, progress: null, reset: vi.fn(),
  }),
}))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))
vi.mock('../components/PhotoUpload.jsx', () => ({ default: () => <div data-testid="photo-upload-stub" /> }))

import PhotoLibrary from '../pages/PhotoLibrary.jsx'

const PROJECT = { id: 'proj-1', name: 'Spring 2026' }
const LOCATION = { id: 'loc-1', full_path: 'Garden › Bed A', is_active: true }

// A parentless row is what the inbox IS — intake_status='pending_tag' with no FK set. Attached rows
// carry one; which FK does not matter to the predicate, so the fixture uses two different kinds so a
// predicate that only counts project_id would fail here.
const pending = (id) => ({ id, storage_path: `s/${id}.jpg`, created_at: '2026-08-29T12:00:00Z', intake_status: 'pending_tag' })
const attachedToProject = (id) => ({ id, storage_path: `s/${id}.jpg`, created_at: '2026-08-29T12:00:00Z', project_id: 'proj-1' })
const attachedToEvent = (id) => ({ id, storage_path: `s/${id}.jpg`, created_at: '2026-08-29T12:00:00Z', event_id: 'evt-1' })

beforeEach(() => {
  fetchSpy.mockReset()
  if (typeof URL.createObjectURL !== 'function') URL.createObjectURL = vi.fn(() => 'blob:stub')
  if (typeof URL.revokeObjectURL !== 'function') URL.revokeObjectURL = vi.fn()
})

function mountWith(photos) {
  fetchSpy.mockImplementation((path) => {
    if (path === '/api/projects') return Promise.resolve([PROJECT])
    if (path === '/api/locations/with-path') return Promise.resolve([LOCATION])
    if (String(path).startsWith('/api/photos')) return Promise.resolve(photos)
    return Promise.resolve([])
  })
  return render(<PhotoLibrary />)
}

const chip = () => screen.getByTestId('pl-filter-untagged')

describe('PhotoLibrary — the Untagged count', () => {
  it('shows how many photos are waiting to be tagged, and ONLY on that chip', async () => {
    mountWith([pending('a'), pending('b'), pending('c'), attachedToProject('d'), attachedToEvent('e')])
    await waitFor(() => expect(chip().textContent).toBe('Untagged 3'))
    // The sibling chips are the half a mutation run showed was unguarded: dropping the
    // `mode === 'untagged'` term stamps the same number onto All / Today / No event, where it means
    // nothing, and the assertion above passes anyway because it only ever read one chip.
    expect(screen.getByTestId('pl-filter-all').textContent).toBe('All')
    expect(screen.getByTestId('pl-filter-today').textContent).toBe('Today')
    expect(screen.getByTestId('pl-filter-standalone').textContent).toBe('No event')
  })

  it('renders NO badge when nothing is waiting — the empty chip is its own answer', async () => {
    mountWith([attachedToProject('d'), attachedToEvent('e')])
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/photos'))
    await act(async () => { await Promise.resolve() })
    expect(chip().textContent).toBe('Untagged')
  })

  it('renders no badge before the first list lands, rather than a 0 nobody has verified', async () => {
    let release
    fetchSpy.mockImplementation((path) => {
      if (path === '/api/projects') return Promise.resolve([PROJECT])
      if (path === '/api/locations/with-path') return Promise.resolve([LOCATION])
      if (String(path).startsWith('/api/photos')) return new Promise(res => { release = () => res([pending('a')]) })
      return Promise.resolve([])
    })
    render(<PhotoLibrary />)
    await waitFor(() => expect(screen.queryByTestId('pl-filter-untagged')).toBeTruthy())
    expect(chip().textContent).toBe('Untagged')      // in-flight: no number
    await act(async () => { release(); await Promise.resolve() })
    await waitFor(() => expect(chip().textContent).toBe('Untagged 1'))
  })

  it('does NOT recount from a project-scoped response — it holds the global number', async () => {
    // 3 pending globally. The scoped response deliberately contains ZERO pending rows, so a naive
    // recount would flip the badge to nothing and tell the user the inbox had emptied itself
    // because they touched an unrelated filter.
    const all = [pending('a'), pending('b'), pending('c'), attachedToProject('d')]
    fetchSpy.mockImplementation((path) => {
      if (path === '/api/projects') return Promise.resolve([PROJECT])
      if (path === '/api/locations/with-path') return Promise.resolve([LOCATION])
      if (path === '/api/photos') return Promise.resolve(all)
      if (String(path).startsWith('/api/photos?project_id=')) return Promise.resolve([attachedToProject('d')])
      return Promise.resolve([])
    })
    render(<PhotoLibrary />)
    await waitFor(() => expect(chip().textContent).toBe('Untagged 3'))

    fireEvent.change(screen.getByDisplayValue('Filter by project…'), { target: { value: 'proj-1' } })
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/photos?project_id=proj-1'))
    await act(async () => { await Promise.resolve() })
    expect(chip().textContent).toBe('Untagged 3')    // held, not recomputed from a subset
  })

  it('the count and the filter use the SAME predicate, so they cannot drift', async () => {
    // inventory_item_id is the parent photoModel added after a hand-written five-way predicate
    // missed it and reported 6 live attached photos as unfinished work. If the count ever grows its
    // own predicate, this row is where the two will disagree first.
    const inventoryAttached = { id: 'inv', storage_path: 's/inv.jpg', created_at: '2026-08-29T12:00:00Z', inventory_item_id: 'ii-1' }
    mountWith([pending('a'), inventoryAttached])
    await waitFor(() => expect(chip().textContent).toBe('Untagged 1'))
    // The badge says 1; the filter must show exactly that 1. If either grew its own predicate, the
    // inventory-attached row would appear on one side and not the other.
    fireEvent.click(chip())
    await waitFor(() => expect(screen.getAllByTestId('pl-photo-card')).toHaveLength(1))
  })
})
