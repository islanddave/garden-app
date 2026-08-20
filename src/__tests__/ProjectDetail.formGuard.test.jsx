// V4-DIRTYGUARDSWEEP-001 — ProjectDetail's half of the dirty-guard contract.
//
// Drives the real reloadGate, never a spy (see InventoryDetail.formGuard.test.jsx's header for why
// a spy would rebuild the exact blind spot V4-RELOADGATEWIRE-001 shipped with).
//
// This is the widest surface in the sweep: three independent forms, three different seedings, any
// combination open at once. So each of the three terms gets BOTH directions proved, plus the
// interaction the union exists for — closing one form must not release a hold the other still owns.
//
// Harness mirrors ProjectDetail.plantForm.test.jsx.
import React from 'react'
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

const { apiFetchSpy, navigateSpy, paramsRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  paramsRef: { id: 'proj-1' },
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useParams: () => paramsRef,
  useNavigate: () => navigateSpy,
}))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({
    upload: vi.fn().mockResolvedValue({ photo: { id: 'p1' } }),
    isUploading: false, error: null, photo: null, preview: null, reset: vi.fn(),
  }),
}))
vi.mock('../components/PhotoUpload.jsx', () => ({ default: () => <div data-testid="photo-upload-stub" /> }))
vi.mock('../components/Breadcrumb.jsx', () => ({ default: () => <div data-testid="breadcrumb-stub" /> }))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => <div data-testid="favorite-toggle-stub" /> }))
// Interactive stub: `variety` is a term in addPlantDirty, and a null stub would leave that term
// unreachable — a predicate branch no test can fail is not a guard.
vi.mock('../components/VarietyPicker.jsx', () => ({
  default: ({ onChange }) => (
    <button type="button" onClick={() => onChange({ id: 'var-1', name: 'Sungold' })}>pick-variety</button>
  ),
}))
vi.mock('../lib/status.js', () => ({
  getStatusColors: () => ({ bg: '#fff', text: '#000', border: '#ccc' }),
}))

import ProjectDetail from '../pages/ProjectDetail.jsx'
import { isReloadBlocked, clearReloadBlocks } from '../lib/reloadGate.js'

const PROJECT = {
  id: 'proj-1',
  name: 'Tomatoes 2026',
  slug: 'tomatoes-2026',
  status: 'growing',
  is_public: true,
  start_date: '2026-03-15',
  parent_project_id: null,
  parent_project_name: null,
  variety: null, species: null, description: null,
  location_id: null,
}

function wireApiFetch({ postResult = { id: 'new-1', name: 'x' }, postError = null } = {}) {
  apiFetchSpy.mockImplementation((path, options = {}) => {
    if ((options.method ?? 'GET') !== 'GET') {
      if (postError) return Promise.reject(postError)
      return Promise.resolve(postResult)
    }
    if (path === '/api/projects/proj-1') return Promise.resolve(PROJECT)
    if (path.startsWith('/api/events')) return Promise.resolve([])
    if (path === '/api/locations/with-path') return Promise.resolve([])
    if (path === '/api/projects') return Promise.resolve([])
    if (path.startsWith('/api/plants')) return Promise.resolve([])
    return Promise.resolve(null)
  })
}

// The '+ Log event' toggle schedules logFormRef.current?.scrollIntoView() on a timer, and jsdom
// ships no scrollIntoView at all — so it lands after the test that opened the form has finished and
// surfaces as an uncaught exception rather than a failure. Defined, not spied on.
beforeAll(() => { Element.prototype.scrollIntoView = function () {} })
afterAll(() => { delete Element.prototype.scrollIntoView })

beforeEach(() => {
  global.URL.createObjectURL = vi.fn(() => 'blob:preview')
  global.URL.revokeObjectURL = vi.fn()
  apiFetchSpy.mockReset()
  navigateSpy.mockReset()
  clearReloadBlocks()
  wireApiFetch()
})

async function renderPage() {
  let out
  await act(async () => { out = render(<ProjectDetail />) })
  await waitFor(() => expect(screen.getByText('Edit')).toBeTruthy())
  return out
}

const click = async (text) => { await act(async () => { fireEvent.click(screen.getByText(text)) }) }
const clickNode = async (node) => { await act(async () => { fireEvent.click(node) }) }

describe('ProjectDetail ↔ dirty guard — project edit form', () => {
  it('a page at rest, and a merely-OPENED edit form, do not hold the gate', async () => {
    await renderPage()
    expect(isReloadBlocked()).toBe(false)
    await click('Edit')
    // The form arrives fully seeded from the row. A truthiness predicate would hold a deploy for
    // anyone who tapped Edit and then thought better of it.
    expect(screen.getByLabelText('Name *').value).toBe('Tomatoes 2026')
    expect(isReloadBlocked()).toBe(false)
  })

  it('one keystroke holds it; typing back to the row value releases it', async () => {
    await renderPage()
    await click('Edit')
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'south beds' } })
    await waitFor(() => expect(isReloadBlocked()).toBe(true))
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: '' } })
    await waitFor(() => expect(isReloadBlocked()).toBe(false))
  })

  it('the name field holds it too', async () => {
    await renderPage()
    await click('Edit')
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Tomatoes 2027' } })
    await waitFor(() => expect(isReloadBlocked()).toBe(true))
  })

  it('a name typed back to the row value STAYS held — the derived slug really has changed', async () => {
    // Not a false positive: the name input also rewrites `slug` via generateSlug(name, start_date),
    // and that round trip does not land back on the stored slug ('tomatoes-2026' becomes
    // 'tomatoes-2026-2026'). The form would save something different from the row, so held is the
    // honest answer. Pinned because it is surprising, and because a future "just diff the visible
    // fields" simplification would silently change it.
    await renderPage()
    await click('Edit')
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Tomatoes 2027' } })
    await waitFor(() => expect(isReloadBlocked()).toBe(true))
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Tomatoes 2026' } })
    await waitFor(() => expect(screen.getByLabelText('Name *').value).toBe('Tomatoes 2026'))
    expect(isReloadBlocked()).toBe(true)
  })

  it('Cancel releases the hold', async () => {
    await renderPage()
    await click('Edit')
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'south beds' } })
    await waitFor(() => expect(isReloadBlocked()).toBe(true))
    await click('Cancel')
    await waitFor(() => expect(isReloadBlocked()).toBe(false))
  })

  it('a successful save releases the hold', async () => {
    await renderPage()
    await click('Edit')
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'south beds' } })
    await waitFor(() => expect(isReloadBlocked()).toBe(true))
    wireApiFetch({ postResult: { ...PROJECT, description: 'south beds' } })
    await click('Save changes')
    await waitFor(() => expect(isReloadBlocked()).toBe(false))
  })
})

describe('ProjectDetail ↔ dirty guard — mini event logger', () => {
  // Held by node, not by text: once the logger is open its toggle reads 'Cancel' and so does the
  // form's own footer button, so getByText('Cancel') is ambiguous. React keeps the same DOM node
  // across the label flip.
  let loggerToggle
  const openLogger = async () => {
    loggerToggle = screen.getByText('+ Log event')
    await clickNode(loggerToggle)
  }

  it('a merely-OPENED logger does not hold it — event_type/date/is_public are seeded', async () => {
    await renderPage()
    await openLogger()
    expect(screen.getByLabelText('Date *')).toBeTruthy()
    expect(isReloadBlocked()).toBe(false)
  })

  it('typed notes hold it, and clearing them releases it', async () => {
    await renderPage()
    await openLogger()
    fireEvent.change(screen.getByLabelText('Notes (public)'), { target: { value: 'first flowers' } })
    await waitFor(() => expect(isReloadBlocked()).toBe(true))
    fireEvent.change(screen.getByLabelText('Notes (public)'), { target: { value: '   ' } })
    await waitFor(() => expect(isReloadBlocked()).toBe(false))
  })

  it('a STAGED photo holds it — it lives in memory until the event POST succeeds', async () => {
    await renderPage()
    await openLogger()
    const file = new File(['x'], 'bed.jpg', { type: 'image/jpeg' })
    await act(async () => {
      fireEvent.change(screen.getByTestId('mini-photo-input'), { target: { files: [file] } })
    })
    await waitFor(() => expect(isReloadBlocked()).toBe(true))
  })

  it('private notes count as well — they are typed content a reload would destroy', async () => {
    await renderPage()
    await openLogger()
    fireEvent.change(screen.getByLabelText('Private notes (never public)'), { target: { value: 'aphids' } })
    await waitFor(() => expect(isReloadBlocked()).toBe(true))
  })

  // Every remaining counted field, one test each. An OR-term no test can fail is not a guard: it
  // reads as covered because the predicate as a whole is covered, while dropping it changes nothing.
  it.each([
    ['Title (optional)',    'First true leaves'],
    ['Quantity (optional)', '6 plants'],
  ])('a typed %s holds it', async (label, value) => {
    await renderPage()
    await openLogger()
    fireEvent.change(screen.getByLabelText(label), { target: { value } })
    await waitFor(() => expect(isReloadBlocked()).toBe(true))
  })

  it('collapsing the logger releases it — dismissed text must not hold a deploy invisibly', async () => {
    await renderPage()
    await openLogger()
    fireEvent.change(screen.getByLabelText('Notes (public)'), { target: { value: 'first flowers' } })
    await waitFor(() => expect(isReloadBlocked()).toBe(true))
    await clickNode(loggerToggle)   // the toggle, which collapses without clearing
    await waitFor(() => expect(isReloadBlocked()).toBe(false))
    // …and the text really is still there, which is what makes the showLogForm term load-bearing
    // rather than decorative.
    await openLogger()
    expect(screen.getByLabelText('Notes (public)').value).toBe('first flowers')
  })
})

describe('ProjectDetail ↔ dirty guard — add-planting form', () => {
  const openAddPlant = async () => { await click('+ Add planting') }

  it('a merely-OPENED add form does not hold it — quantity seeds to 1', async () => {
    await renderPage()
    await openAddPlant()
    expect(screen.getByLabelText('Quantity').value).toBe('1')
    expect(isReloadBlocked()).toBe(false)
  })

  it('a typed planting name holds it', async () => {
    await renderPage()
    await openAddPlant()
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Sungold' } })
    await waitFor(() => expect(isReloadBlocked()).toBe(true))
  })

  it('a quantity that differs from the seeded 1 holds it', async () => {
    await renderPage()
    await openAddPlant()
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '6' } })
    await waitFor(() => expect(isReloadBlocked()).toBe(true))
  })

  it('collapsing the add form releases it — dismissed text must not hold a deploy invisibly', async () => {
    await renderPage()
    const addToggle = screen.getByText('+ Add planting')
    await clickNode(addToggle)
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Sungold' } })
    await waitFor(() => expect(isReloadBlocked()).toBe(true))
    await clickNode(addToggle)   // the toggle collapses without clearing plantForm
    await waitFor(() => expect(isReloadBlocked()).toBe(false))
    // …and the name really is still typed, which is what makes the showAddPlant term load-bearing.
    await clickNode(addToggle)
    expect(screen.getByLabelText(/Name/).value).toBe('Sungold')
  })

  // Same rule as the logger's table above — one test per counted field.
  it.each([
    [/^Notes/,           'from the co-op flat'],
    [/Initial quantity/, '12'],
    [/Source reference/, 'Johnny\'s'],
    [/Generation/,       'F2'],
    [/Lineage note/,     'saved from last year'],
    [/Pot size/,         '3 gal'],
  ])('a typed %s holds it', async (label, value) => {
    await renderPage()
    await openAddPlant()
    fireEvent.change(screen.getByLabelText(label), { target: { value } })
    await waitFor(() => expect(isReloadBlocked()).toBe(true))
  })

  it('a sown date holds it — it is entered, not seeded', async () => {
    await renderPage()
    await openAddPlant()
    fireEvent.change(screen.getByLabelText(/Sown date/), { target: { value: '2026-04-02' } })
    await waitFor(() => expect(isReloadBlocked()).toBe(true))
  })

  it('a picked variety holds it — a search-and-pick is not a one-tap redo', async () => {
    await renderPage()
    await openAddPlant()
    await click('pick-variety')
    await waitFor(() => expect(isReloadBlocked()).toBe(true))
  })

  it('a successful add releases it — handleAddPlant resets the form and closes', async () => {
    await renderPage()
    await openAddPlant()
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Sungold' } })
    await waitFor(() => expect(isReloadBlocked()).toBe(true))
    await click('Add planting')
    await waitFor(() => expect(isReloadBlocked()).toBe(false))
  })
})

describe('ProjectDetail ↔ dirty guard — the union', () => {
  it('closing one dirty form does not release a hold the OTHER still owns', async () => {
    await renderPage()
    const loggerToggle = screen.getByText('+ Log event')
    await clickNode(loggerToggle)
    fireEvent.change(screen.getByLabelText('Notes (public)'), { target: { value: 'first flowers' } })
    await click('+ Add planting')
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Sungold' } })
    await waitFor(() => expect(isReloadBlocked()).toBe(true))
    // Collapse the logger only. The planting name is still typed and still unsaved.
    await clickNode(loggerToggle)
    await waitFor(() => expect(screen.queryByLabelText('Notes (public)')).toBeNull())
    expect(isReloadBlocked()).toBe(true)
  })

  it('unmounting a dirty page releases the hold', async () => {
    const { unmount } = await renderPage()
    await click('+ Log event')
    fireEvent.change(screen.getByLabelText('Notes (public)'), { target: { value: 'first flowers' } })
    await waitFor(() => expect(isReloadBlocked()).toBe(true))
    act(() => { unmount() })
    expect(isReloadBlocked()).toBe(false)
  })
})
