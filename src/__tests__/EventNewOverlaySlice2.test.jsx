// V4-OVERLAY-001 Slice 2 — EventNew overlay behaviors: the Save CTA is `sticky` (not `fixed`, the
// BUG-SHEET-001 class where a fixed CTA escapes the Sheet's scroll region), and inside the overlay a
// successful save surfaces an in-surface, announced, focusable Undo (the global toast is AT-invisible
// behind aria-modal). Mirrors EventNew.test's bare-mock harness + OverlaySurfaceProvider to mark the
// form as overlay-rendered.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const { apiFetchSpy, navigateSpy, postCalls, dataRef, searchParamsRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  postCalls: [],
  dataRef: { projects: [], locations: [], plants: [], postResult: { id: 'evt-1' }, postError: null },
  searchParamsRef: { current: new URLSearchParams() },
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: vi.fn().mockResolvedValue({ photo: { id: 'p1' } }), isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useNavigate: () => navigateSpy,
  useSearchParams: () => [searchParamsRef.current, vi.fn()],
}))

import EventNew from '../pages/EventNew.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import { OverlaySurfaceProvider } from '../context/OverlayContext.jsx'

const PROJECT = { id: 'proj-1', name: 'Tomatoes 2026', status: 'growing' }

function wireApiFetch() {
  apiFetchSpy.mockImplementation((path, options = {}) => {
    if (options.method === 'POST' && path === '/api/events') {
      postCalls.push(JSON.parse(options.body))
      return dataRef.postError ? Promise.reject(dataRef.postError) : Promise.resolve(dataRef.postResult)
    }
    if (path === '/api/projects') return Promise.resolve(dataRef.projects)
    if (path === '/api/locations/with-path') return Promise.resolve(dataRef.locations)
    if (path.startsWith('/api/plants')) return Promise.resolve(dataRef.plants)
    return Promise.resolve(null)
  })
}

function renderInOverlay(query = '') {
  searchParamsRef.current = new URLSearchParams(query)
  return render(<ToastProvider><OverlaySurfaceProvider><EventNew /></OverlaySurfaceProvider></ToastProvider>)
}

async function flushLoad() {
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/projects'))
  await act(async () => { await Promise.resolve() })
}

beforeEach(() => {
  apiFetchSpy.mockReset(); navigateSpy.mockReset(); postCalls.length = 0
  searchParamsRef.current = new URLSearchParams()
  dataRef.projects = [PROJECT]; dataRef.locations = []; dataRef.plants = []
  dataRef.postResult = { id: 'evt-1' }; dataRef.postError = null
  sessionStorage.clear()
  wireApiFetch()
})

describe('EventNew — overlay Slice 2', () => {
  it('renders the Save CTA as position:sticky (not fixed — BUG-SHEET-001)', async () => {
    const { container } = renderInOverlay('event_type=watering')
    await flushLoad()
    const saveBtn = screen.getByText('Save')
    // walk up to the positioned wrapper
    let el = saveBtn
    let found = null
    while (el && el !== container) {
      if (el.getAttribute && /position:\s*sticky/.test(el.getAttribute('style') || '')) { found = el; break }
      el = el.parentElement
    }
    expect(found).not.toBeNull()
    expect(container.querySelector('[style*="position: fixed"]')).toBeNull()
  })

  it('surfaces an in-surface, announced Undo after a save when rendered as an overlay', async () => {
    renderInOverlay('event_type=watering')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    expect(postCalls.length).toBe(1)
    const status = await screen.findByRole('status')
    expect(status.textContent).toMatch(/Logged event/)
    const undo = status.querySelector('button')
    expect(undo?.textContent).toBe('Undo')
    // Undo soft-deletes the just-logged event via the same DELETE path.
    await act(async () => { fireEvent.click(undo) })
    expect(apiFetchSpy).toHaveBeenCalledWith('/api/events/evt-1', { method: 'DELETE' })
  })
})
