// V4-NOTESCOLLAPSE-001 (BD0806-12) — Notes is no longer a always-open textarea sitting in the
// middle of the Log Event form. Dave: "rarely used; currently eats vertical space above Save and is
// in the way of the common path… present but collapsed at the bottom, expandable on tap."
//
// Measured on the repo's own mobile harness at 390x844 BEFORE this change (overlay surface,
// event type "watered"): Notes label at y=789, and the REQUIRED Planting field pushed to y=957 —
// 113px below the fold. Notes cost ~168px of scroll ahead of the field the user actually has to
// fill. Save is `position: sticky` and pinned to the viewport bottom on every surface, so "below
// Save" is document order, not viewport order: Notes moves to the END of the form.
//
// The harvest branch is NOT touched — its Notes already lives inside the collapsed
// "Photo, notes & date · optional" disclosure, so it already satisfied the ask.
//
// RENDER assertions only. No jest-dom (L-182).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const { apiFetchSpy, navigateSpy, dataRef, searchParamsRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  dataRef: { projects: [], locations: [], plants: [] },
  searchParamsRef: { current: new URLSearchParams() },
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: vi.fn(), isUploading: false, error: null, photo: null, stage: null, progress: null, preview: null, reset: vi.fn() }),
}))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useNavigate: () => navigateSpy,
  useSearchParams: () => [searchParamsRef.current, vi.fn()],
}))

import EventNew from '../pages/EventNew.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import { OverlaySurfaceProvider, OverlayDirtyProvider } from '../context/OverlayContext.jsx'

beforeEach(() => {
  apiFetchSpy.mockReset()
  localStorage.clear()
  apiFetchSpy.mockImplementation((path) => {
    if (path === '/api/projects') return Promise.resolve(dataRef.projects)
    if (path === '/api/locations/with-path') return Promise.resolve(dataRef.locations)
    if (path.startsWith('/api/plants')) return Promise.resolve(dataRef.plants)
    return Promise.resolve(null)
  })
})

async function renderForm(query = '') {
  searchParamsRef.current = new URLSearchParams(query)
  await act(async () => {
    render(
      <ToastProvider>
        <OverlaySurfaceProvider>
          <OverlayDirtyProvider onDirtyChange={() => {}}>
            <EventNew />
          </OverlayDirtyProvider>
        </OverlaySurfaceProvider>
      </ToastProvider>
    )
  })
}

const toggle = () => screen.queryByTestId('notes-disclosure')
const notesField = () => screen.queryByLabelText('Notes')

describe('EventNew — Notes collapsed at the bottom (V4-NOTESCOLLAPSE-001)', () => {
  it('does not render the Notes textarea on arrival', async () => {
    await renderForm()
    // OLD state: an always-open 90px textarea mid-form. It must not paint.
    expect(notesField()).toBeNull()
    // NEW state: a tap target in its place.
    expect(toggle()).toBeTruthy()
  })

  it('reveals the textarea on tap and hides it again', async () => {
    await renderForm()
    await act(async () => { fireEvent.click(toggle()) })
    const ta = notesField()
    expect(ta).toBeTruthy()
    expect(ta.tagName).toBe('TEXTAREA')
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    await act(async () => { fireEvent.click(toggle()) })
    expect(notesField()).toBeNull()
  })

  it('sits AFTER the When? field in document order — the end of the form, not the middle', async () => {
    await renderForm()
    const when = screen.getByLabelText('Event date')
    const pos = when.compareDocumentPosition(toggle())
    // DOCUMENT_POSITION_FOLLOWING === 4. Before this change Notes preceded both Planting and When?.
    expect(pos & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('stays open while it holds text — collapsing must never hide what the user wrote', async () => {
    await renderForm()
    await act(async () => { fireEvent.click(toggle()) })
    await act(async () => { fireEvent.change(notesField(), { target: { value: 'aphids on the kale' } }) })
    await act(async () => { fireEvent.click(toggle()) })   // try to collapse over content
    expect(notesField()).toBeTruthy()
    expect(notesField().value).toBe('aphids on the kale')
  })

  it('is a full-size tap target, not a bare text link', async () => {
    await renderForm()
    expect(toggle().style.minHeight).toBe('44px')
  })

  it('leaves the harvest form alone — its Notes already lived in a collapsed disclosure', async () => {
    await renderForm('event_type=harvest')
    // The harvest layout keeps its own "Photo, notes & date" disclosure and gains no second one.
    expect(screen.getByTestId('harvest-more-toggle')).toBeTruthy()
    expect(toggle()).toBeNull()
    expect(notesField()).toBeNull()
    await act(async () => { fireEvent.click(screen.getByTestId('harvest-more-toggle')) })
    expect(notesField()).toBeTruthy()
  })
})
