// BUG-PHOTOUPLOADKBD-001 — the mini event logger's photo trigger, keyboard side.
//
// Sibling of the PhotoUpload defect and the same shape, one degree worse: a <label> wrapping a
// display:none <input type="file"> with no htmlFor and no aria-label, so the control was both
// unreachable by keyboard AND nameless to a screen reader. It is now a <button> that clicks the
// input.
//
// These assert the user-observable property — tab-order membership and key activation — because the
// axe gate provably cannot see this class: measured on the pre-fix tree, the FULL axe rule set
// returns zero findings on a label-wrapped display:none input (a display:none subtree is excluded
// from the audit, and a <label> is not interactive, so nothing has anything to fire on).
//
// Harness mirrors ProjectDetail.formGuard.test.jsx.
import React from 'react'
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest'
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

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
vi.mock('../lib/status.js', () => ({
  getStatusColors: () => ({ bg: '#fff', text: '#000', border: '#ccc' }),
}))

import ProjectDetail from '../pages/ProjectDetail.jsx'

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

// The '+ Log event' toggle schedules logFormRef.current?.scrollIntoView() on a timer and jsdom ships
// none, so it lands after the opening test finished and surfaces as an uncaught exception.
beforeAll(() => { Element.prototype.scrollIntoView = function () {} })
afterAll(() => { delete Element.prototype.scrollIntoView })

beforeEach(() => {
  global.URL.createObjectURL = vi.fn(() => 'blob:preview')
  global.URL.revokeObjectURL = vi.fn()
  apiFetchSpy.mockReset()
  navigateSpy.mockReset()
  apiFetchSpy.mockImplementation((path, options = {}) => {
    if ((options.method ?? 'GET') !== 'GET') return Promise.resolve({ id: 'new-1' })
    if (path === '/api/projects/proj-1') return Promise.resolve(PROJECT)
    if (path.startsWith('/api/events')) return Promise.resolve([])
    if (path === '/api/locations/with-path') return Promise.resolve([])
    if (path === '/api/projects') return Promise.resolve([])
    if (path.startsWith('/api/plants')) return Promise.resolve([])
    return Promise.resolve(null)
  })
})

async function openLogger() {
  await act(async () => { render(<ProjectDetail />) })
  await waitFor(() => expect(screen.getByText('Edit')).toBeTruthy())
  await act(async () => { fireEvent.click(screen.getByText('+ Log event')) })
  await waitFor(() => expect(screen.getByLabelText('Date *')).toBeTruthy())
}

const trigger = () => screen.getByRole('button', { name: 'Take or choose a photo' })

describe('ProjectDetail mini-logger photo trigger — keyboard reachability (BUG-PHOTOUPLOADKBD-001)', () => {
  it('is the next tab stop after the private-notes field', async () => {
    const user = userEvent.setup()
    await openLogger()
    // Tab-order membership, not just focusability: the trigger sits directly after Private notes in
    // the form and nothing focusable lies between them, so one Tab must land on it. Pre-fix this
    // Tab skipped straight past to 'Save event' — the <label> takes no focus and the display:none
    // input is out of the tab order.
    screen.getByLabelText('Private notes (never public)').focus()
    await user.tab()
    expect(document.activeElement).toBe(trigger())
  })

  it('Enter on the focused trigger opens the file picker', async () => {
    const user = userEvent.setup()
    await openLogger()
    const clickSpy = vi.spyOn(screen.getByTestId('mini-photo-input'), 'click')
    trigger().focus()
    await user.keyboard('{Enter}')
    expect(clickSpy).toHaveBeenCalledTimes(1)
  })

  it('Space on the focused trigger opens the file picker', async () => {
    const user = userEvent.setup()
    await openLogger()
    const clickSpy = vi.spyOn(screen.getByTestId('mini-photo-input'), 'click')
    trigger().focus()
    await user.keyboard(' ')
    // Asserted separately from Enter: a <label tabIndex={0}> would pass the tab-order test above and
    // forward neither key to its control.
    expect(clickSpy).toHaveBeenCalledTimes(1)
  })

  it('does not submit the form it sits inside', async () => {
    const user = userEvent.setup()
    await openLogger()
    vi.spyOn(screen.getByTestId('mini-photo-input'), 'click').mockImplementation(() => {})
    await user.click(trigger())
    expect(apiFetchSpy.mock.calls.filter(([, o = {}]) => (o.method ?? 'GET') !== 'GET')).toHaveLength(0)
  })

  it('the hidden input stays out of the tab order and the a11y tree', async () => {
    await openLogger()
    const input = screen.getByTestId('mini-photo-input')
    expect(input.getAttribute('tabindex')).toBe('-1')
    expect(input.getAttribute('aria-hidden')).toBe('true')
  })

  it('still stages a picked file — the trigger swap did not detach the change handler', async () => {
    await openLogger()
    const file = new File(['x'], 'bed.jpg', { type: 'image/jpeg' })
    await act(async () => {
      fireEvent.change(screen.getByTestId('mini-photo-input'), { target: { files: [file] } })
    })
    await waitFor(() => expect(screen.getByAltText('Preview')).toBeTruthy())
  })
})
