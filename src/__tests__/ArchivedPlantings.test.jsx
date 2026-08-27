// V4-ARCHIVEBROWSE-001 — ArchivedPlantings renders, unarchives, and empties.
//
// EVERY ASSERTION HERE IS ABOUT OUTPUT, following its sibling RecentlyDeleted.test.jsx and for the
// reason that file gives: a feature in this repo shipped inert to prod because its tests asserted
// that modules imported each other and never checked the DOM. So the list is asserted by the text of
// its rows, unarchive by the row LEAVING the document, and the empty state by its copy.
//
// The fixtures are real prod shapes, read off the live database 2026-08-27 — including the two that
// decide the subtitle rule: 21 of the 30 archived rows have display_name === the variety name
// ("Emerald Green"), and 9 differ ("Biquinho" / "Biquinho Yellow F1").
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'

const { fetchSpy, invalidateSpy, toastSpy } = vi.hoisted(() => ({
  fetchSpy: vi.fn(),
  invalidateSpy: vi.fn(),
  toastSpy: vi.fn(),
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
vi.mock('../lib/dataCache.js', () => ({ invalidatePrefix: invalidateSpy }))
vi.mock('../context/ToastContext.jsx', () => ({ useOptionalToast: () => ({ show: toastSpy }) }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))

import ArchivedPlantings, {
  ARCHIVED_PLANTINGS_PATH, unarchivePath, rowSubtitle, cropLabelFromSlug,
} from '../pages/ArchivedPlantings.jsx'

const row = (over = {}) => ({
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Emerald Green',
  status: 'failed',
  archived_at: '2026-08-21T14:02:00Z',
  variety_name: 'Emerald Green',
  crop_type_slug: 'pepper',
  ...over,
})

let listBody

beforeEach(() => {
  fetchSpy.mockReset()
  invalidateSpy.mockReset()
  toastSpy.mockReset()
  listBody = { plants: [], truncated: false }
  fetchSpy.mockImplementation((path, options) => {
    if (path === ARCHIVED_PLANTINGS_PATH) return Promise.resolve(listBody)
    if (options?.method === 'PATCH') return Promise.resolve({ id: 'x', archived_at: null })
    return Promise.reject(new Error(`unexpected path ${path}`))
  })
})

describe('rowSubtitle / cropLabelFromSlug', () => {
  it('title-cases a crop slug, including a hyphenated one', () => {
    expect(cropLabelFromSlug('pepper')).toBe('Pepper')
    expect(cropLabelFromSlug('sweet-potato')).toBe('Sweet Potato')
    expect(cropLabelFromSlug(null)).toBe(null)
  })

  it('omits the variety name when it equals the row title (21 of 30 prod rows)', () => {
    expect(rowSubtitle(row())).toBe('Pepper · Archived Aug 21, 2026')
  })

  it('shows the variety name when it differs (the 9 where it earns its space)', () => {
    const sub = rowSubtitle(row({ name: 'Biquinho', variety_name: 'Biquinho Yellow F1' }))
    expect(sub).toContain('Biquinho Yellow F1')
    expect(sub).toContain('Pepper')
  })

  it('omits the crop label when the planting IS named for its crop (4 of 30 prod rows)', () => {
    // Caught by a real-browser render, not by these tests: the original fixture was a pepper called
    // "Emerald Green", the one shape where nothing repeats. "Culantro" under a title of "Culantro"
    // is what the page actually showed.
    expect(rowSubtitle(row({ name: 'Culantro', crop_type_slug: 'culantro', variety_name: 'Culantro' })))
      .toBe('Archived Aug 21, 2026')
  })

  it('still shows the variety when only the CROP repeats the title', () => {
    const sub = rowSubtitle(row({ name: 'Lettuce', crop_type_slug: 'lettuce', variety_name: 'Buttercrunch' }))
    expect(sub).toBe('Buttercrunch · Archived Aug 21, 2026')
  })

  it('compares case- and space-insensitively, so " culantro " still counts as a repeat', () => {
    expect(rowSubtitle(row({ name: ' Culantro ', crop_type_slug: 'CULANTRO', variety_name: 'culantro' })))
      .toBe('Archived Aug 21, 2026')
  })

  it('never renders a container name even if the server sends one', () => {
    // Containers are not a user-facing noun. The server does not select project_name, but the
    // subtitle must not become the place that reintroduces it if some future read does.
    const sub = rowSubtitle(row({ project_name: 'Peppers 2026' }))
    expect(sub).not.toContain('Peppers 2026')
  })
})

describe('ArchivedPlantings', () => {
  it('lists archived plantings with their crop, date and status', async () => {
    listBody = { plants: [row(), row({ id: 'b', name: 'Culantro', crop_type_slug: 'culantro', variety_name: 'Culantro', status: 'ended' })], truncated: false }
    render(<ArchivedPlantings />)

    await waitFor(() => expect(screen.getAllByTestId('archived-planting-row')).toHaveLength(2))
    expect(screen.getByText('Emerald Green')).toBeTruthy()
    expect(screen.getByText(/Pepper · Archived/)).toBeTruthy()
    // Status is a real badge, not a bare string — three channels, per PlantStatusBadge.
    expect(screen.getByLabelText('Status: Ended')).toBeTruthy()
    expect(fetchSpy).toHaveBeenCalledWith(ARCHIVED_PLANTINGS_PATH)
  })

  it('links each row to the planting, which stays openable while archived', async () => {
    listBody = { plants: [row()], truncated: false }
    render(<ArchivedPlantings />)

    await waitFor(() => expect(screen.getByText('Emerald Green')).toBeTruthy())
    expect(screen.getByText('Emerald Green').getAttribute('href'))
      .toBe('/plantings/22222222-2222-4222-8222-222222222222')
  })

  it('unarchives through the EXISTING archive PATCH and drops the row', async () => {
    listBody = { plants: [row()], truncated: false }
    render(<ArchivedPlantings />)

    await waitFor(() => expect(screen.getByText('Emerald Green')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('Unarchive Emerald Green'))

    await waitFor(() => expect(screen.queryByText('Emerald Green')).toBeNull())
    expect(fetchSpy).toHaveBeenCalledWith(
      unarchivePath('22222222-2222-4222-8222-222222222222'),
      { method: 'PATCH', body: JSON.stringify({ archived: false }) },
    )
    // The planting belongs back in Garden, so every cached plants list that filtered it out is wrong.
    expect(invalidateSpy).toHaveBeenCalledWith('/api/plants')
    expect(toastSpy).toHaveBeenCalledWith({ message: 'Planting unarchived' })
  })

  it('an unarchive failure keeps the list standing and every other row actionable', async () => {
    listBody = { plants: [row(), row({ id: 'b', name: 'Culantro' })], truncated: false }
    fetchSpy.mockImplementation((path, options) => {
      if (path === ARCHIVED_PLANTINGS_PATH) return Promise.resolve(listBody)
      if (options?.method === 'PATCH') return Promise.reject(new Error('Network unreachable'))
      return Promise.reject(new Error('unexpected'))
    })
    render(<ArchivedPlantings />)

    await waitFor(() => expect(screen.getAllByTestId('archived-planting-row')).toHaveLength(2))
    fireEvent.click(screen.getByLabelText('Unarchive Emerald Green'))

    await waitFor(() => expect(screen.getByText('Network unreachable')).toBeTruthy())
    // THE POINT OF THE TWO ERROR STATES: the rows are still there and still have their buttons.
    expect(screen.getAllByTestId('archived-planting-row')).toHaveLength(2)
    expect(screen.getByLabelText('Unarchive Culantro')).toBeTruthy()
  })

  it('a load failure replaces the region and offers a retry', async () => {
    fetchSpy.mockImplementation(() => Promise.reject(new Error('Could not reach the server')))
    render(<ArchivedPlantings />)

    await waitFor(() => expect(screen.getByText('Could not reach the server')).toBeTruthy())
    expect(screen.queryAllByTestId('archived-planting-row')).toHaveLength(0)
  })

  it('says what archiving IS in the empty state, since most users arrive never having used it', async () => {
    render(<ArchivedPlantings />)
    await waitFor(() => expect(screen.getByText(/Nothing is archived/)).toBeTruthy())
    expect(screen.getByText(/without deleting it/)).toBeTruthy()
  })

  it('says so out loud when the server truncated the list', async () => {
    listBody = { plants: [row()], truncated: true }
    render(<ArchivedPlantings />)
    await waitFor(() => expect(screen.getByText(/most recently archived/)).toBeTruthy())
  })

  it('does not claim truncation when the server did not report it', async () => {
    listBody = { plants: [row()], truncated: false }
    render(<ArchivedPlantings />)
    await waitFor(() => expect(screen.getByText('Emerald Green')).toBeTruthy())
    expect(screen.queryByText(/most recently archived/)).toBeNull()
  })
})

// THE REACHABILITY INVARIANT, in the spirit of DebugMenu.reachability.test.jsx.
//
// The defect that guard exists for is not a broken page; it is a page that works perfectly and that
// nobody can open. Three /admin/* routes shipped "unlinked, reachable by URL" — sound on a desktop,
// a dead end in an installed PWA where there is no address bar. This page is one Link away from the
// same fate, and the failure would be invisible: the route resolves, the tests above all pass, and
// the feature simply never gets used.
//
// Read as TEXT rather than by rendering Garden. Garden is one of the heaviest components in the app
// and its tests are the waitFor-dense ones that flake under parallel load; the invariant is about
// what a developer wrote in the action row, which text answers directly and cheaply.
describe('ArchivedPlantings — reachability', () => {
  const ROOT = path.resolve(__dirname, '../..')
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

  it('is registered as a route in App.jsx', () => {
    expect(read('src/App.jsx')).toMatch(/path: '\/plantings\/archived'/)
  })

  it('is declared ABOVE the by-id planting route', () => {
    // React Router v6 ranks static above dynamic regardless of order, so this is belt-and-braces —
    // but the failure it guards is silent (PlantingDetail would fetch a planting called "archived"),
    // so the ordering is pinned rather than left to a ranking rule a future edit may not know.
    const src = read('src/App.jsx')
    expect(src.indexOf("path: '/plantings/archived'"))
      .toBeLessThan(src.indexOf("path: '/plantings/:plantingId'"))
  })

  it('has an entry point on Garden — the page that fills the archive', () => {
    const garden = read('src/pages/Garden.jsx')
    expect(garden).toMatch(/to="\/plantings\/archived"/)
    expect(garden).toMatch(/aria-label="Archived plantings"/)
  })
})
