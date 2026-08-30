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

const { fetchSpy, toastSpy, deckSpy } = vi.hoisted(() => ({
  fetchSpy: vi.fn(), toastSpy: vi.fn(), deckSpy: vi.fn(),
}))

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
// The carousel is stubbed to report the DECK IT WAS HANDED. The subject of the BUG-QUICKTAGSCOPE-001
// tests below is which photos PhotoLibrary puts in that deck, not how the carousel renders them —
// that is QuickTagCarousel.test.jsx's job. Stubbing also keeps this file free of the dismiss
// registry and PhotoView the real component needs.
vi.mock('../components/photo/QuickTagCarousel.jsx', () => ({
  default: ({ photos, seedTargets }) => {
    deckSpy(photos.map(p => p.id), seedTargets)
    return <div data-testid="quicktag-carousel-stub">{photos.length}</div>
  },
}))
vi.mock('../context/ToastContext.jsx', async (importActual) => ({
  ...(await importActual()),
  useOptionalToast: () => ({ show: toastSpy, dismiss: vi.fn() }),
}))

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
  toastSpy.mockReset()
  deckSpy.mockReset()
  if (typeof URL.createObjectURL !== 'function') URL.createObjectURL = vi.fn(() => 'blob:stub')
  if (typeof URL.revokeObjectURL !== 'function') URL.revokeObjectURL = vi.fn()
})

// Mount under a project filter with a global list that differs from the scoped one — the exact shape
// BUG-QUICKTAGSCOPE-001 lived in. Returns once the scoped response has landed.
async function mountScopedToProject({ global: globalList, scoped }) {
  fetchSpy.mockImplementation((path) => {
    if (path === '/api/projects') return Promise.resolve([PROJECT])
    if (path === '/api/locations/with-path') return Promise.resolve([LOCATION])
    if (path === '/api/photos') return Promise.resolve(globalList)
    if (String(path).startsWith('/api/photos?project_id=')) return Promise.resolve(scoped)
    return Promise.resolve([])
  })
  render(<PhotoLibrary />)
  await waitFor(() => expect(countSeg()).toBeTruthy())
  fireEvent.change(screen.getByDisplayValue('Filter by project…'), { target: { value: 'proj-1' } })
  await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/photos?project_id=proj-1'))
  await act(async () => { await Promise.resolve() })
}

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
// V4-PHOTOBULK-001 S6 (Dave, D4): the count became its OWN button beside the label — tapping the
// number opens the tagging carousel, tapping the word still filters. A <button> inside a <button>
// is invalid HTML, so "two behaviours on one chip" had to become two segments in one pill. These
// assertions moved from the label's text to the count segment; the subject of every test below
// (whether a count is measured, from which fetch, and on which chip) is unchanged.
const countSeg = () => screen.queryByTestId('pl-filter-untagged-count')
const countText = () => countSeg()?.textContent ?? null

describe('PhotoLibrary — the Untagged count', () => {
  it('shows how many photos are waiting to be tagged, and ONLY on that chip', async () => {
    mountWith([pending('a'), pending('b'), pending('c'), attachedToProject('d'), attachedToEvent('e')])
    await waitFor(() => expect(countText()).toBe('3'))
    expect(chip().textContent).toBe('Untagged')
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
    expect(countSeg()).toBeNull()
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
    expect(countSeg()).toBeNull()                    // in-flight: no count segment at all
    await act(async () => { release(); await Promise.resolve() })
    await waitFor(() => expect(countText()).toBe('1'))
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
    await waitFor(() => expect(countText()).toBe('3'))
    expect(chip().textContent).toBe('Untagged')

    fireEvent.change(screen.getByDisplayValue('Filter by project…'), { target: { value: 'proj-1' } })
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/photos?project_id=proj-1'))
    await act(async () => { await Promise.resolve() })
    expect(countText()).toBe('3')    // held, not recomputed from a subset
  })

  it('the count and the filter use the SAME predicate, so they cannot drift', async () => {
    // inventory_item_id is the parent photoModel added after a hand-written five-way predicate
    // missed it and reported 6 live attached photos as unfinished work. If the count ever grows its
    // own predicate, this row is where the two will disagree first.
    const inventoryAttached = { id: 'inv', storage_path: 's/inv.jpg', created_at: '2026-08-29T12:00:00Z', inventory_item_id: 'ii-1' }
    mountWith([pending('a'), inventoryAttached])
    await waitFor(() => expect(countText()).toBe('1'))
    // The badge says 1; the filter must show exactly that 1. If either grew its own predicate, the
    // inventory-attached row would appear on one side and not the other.
    fireEvent.click(chip())
    await waitFor(() => expect(screen.getAllByTestId('pl-photo-card')).toHaveLength(1))
  })
})

// BUG-QUICKTAGSCOPE-001 — the badge is global, so the DECK behind it must be global.
//
// The sibling test above pins that the count HOLDS its global value under a scope filter. That guard
// was necessary and not sufficient: `openQuickTag` went on building its deck from the SCOPED photos
// list. Under ?project_id= every returned row carries a project_id, so `isAttached` is true for all
// of them, the pending list was always empty, and the early return made tapping the number a silent
// no-op — in prod, on every scoped view. These tests hold the two halves to the same globality.
describe('PhotoLibrary — opening the drain from a scoped view', () => {
  it('opens the GLOBAL untagged deck, not the scoped one', async () => {
    // 3 pending globally; the project's own photos contain none. Pre-fix this deck was empty and the
    // tap did nothing at all.
    await mountScopedToProject({
      global: [pending('a'), pending('b'), pending('c'), attachedToProject('d')],
      scoped: [attachedToProject('d')],
    })
    expect(countText()).toBe('3')

    fetchSpy.mockClear()
    fireEvent.click(countSeg())
    await waitFor(() => expect(screen.getByTestId('quicktag-carousel-stub')).toBeTruthy())
    // The unscoped list is re-fetched precisely because the in-memory one cannot answer this.
    expect(fetchSpy).toHaveBeenCalledWith('/api/photos')
    // Oldest-first ordering is the drain's contract; ids here share a timestamp so this also pins
    // that the deck is the three global pending rows and not the scoped row.
    expect(deckSpy).toHaveBeenCalledWith(['a', 'b', 'c'], expect.anything())
  })

  it('seeds the shortcut row from the same list it built the deck from', async () => {
    // The second consumer of the scoped/global split. The scoped view's only photo is attached to
    // planting `pl-scoped`; the global list's attached photo is on `pl-global`. A seed still read off
    // the page's scoped `photos` would offer pl-scoped — shortcuts for the project the user happens
    // to be filtered to, beside a deck drawn from the whole garden.
    const scopedAttached = { ...attachedToProject('d'), plant_id: 'pl-scoped' }
    const globalAttached = { ...attachedToProject('e'), plant_id: 'pl-global' }
    await mountScopedToProject({
      global: [pending('a'), globalAttached],
      scoped: [scopedAttached],
    })
    fireEvent.click(countSeg())
    await waitFor(() => expect(screen.getByTestId('quicktag-carousel-stub')).toBeTruthy())
    expect(deckSpy).toHaveBeenCalledWith(['a'], ['pl-global'])
  })

  it('does NOT re-fetch when no scope filter is active — the common path stays one request', async () => {
    mountWith([pending('a'), pending('b'), attachedToProject('d')])
    await waitFor(() => expect(countText()).toBe('2'))

    fetchSpy.mockClear()
    fireEvent.click(countSeg())
    await waitFor(() => expect(screen.getByTestId('quicktag-carousel-stub')).toBeTruthy())
    expect(fetchSpy).not.toHaveBeenCalledWith('/api/photos')
    expect(deckSpy).toHaveBeenCalledWith(['a', 'b'], expect.anything())
  })

  it('says so when the list cannot be loaded, instead of failing silently', async () => {
    // The regression this whole item is about is a tap that does nothing and reports nothing. A
    // failed fetch must not rebuild it by a different route.
    await mountScopedToProject({
      global: [pending('a')],
      scoped: [attachedToProject('d')],
    })
    fetchSpy.mockImplementation((path) => {
      if (path === '/api/photos') return Promise.reject(new Error('offline'))
      return Promise.resolve([])
    })
    fireEvent.click(countSeg())
    await waitFor(() => expect(toastSpy).toHaveBeenCalled())
    expect(toastSpy.mock.calls[0][0]).toMatchObject({ tone: 'error' })
    expect(screen.queryByTestId('quicktag-carousel-stub')).toBeNull()
  })

  it('heals a stale count rather than opening an empty deck', async () => {
    // The badge holds its last global value by design, so it can outlive the photos it counted —
    // another device drains the inbox and this tab still reads 2. On open we have just measured the
    // truth, so the number is reconciled to it: the badge disappears, which is the honest report.
    // Pre-fix this case was indistinguishable from the bug — a tap that did nothing.
    await mountScopedToProject({
      global: [pending('a'), pending('b')],
      scoped: [attachedToProject('d')],
    })
    expect(countText()).toBe('2')

    fetchSpy.mockImplementation((path) => {
      if (path === '/api/photos') return Promise.resolve([attachedToProject('d')])
      return Promise.resolve([])
    })
    fetchSpy.mockClear()
    fireEvent.click(countSeg())
    await waitFor(() => expect(countSeg()).toBeNull())
    // The RE-MEASUREMENT is asserted, not just the outcome. Both the scoped in-memory list and the
    // true global list are empty of pending rows here — realistically so, because every row under a
    // project filter carries a project_id — so the badge would also vanish if the deck were still
    // built from the scoped list. Without this line the test passes against the unfixed code.
    expect(fetchSpy).toHaveBeenCalledWith('/api/photos')
    expect(screen.queryByTestId('quicktag-carousel-stub')).toBeNull()
    expect(toastSpy).not.toHaveBeenCalled()
  })
})
