// V4-OVERLAY-001 Slice 2 + V4-LOGCONF-001 (C1/C2) — EventNew overlay behaviors: the Save CTA is
// `sticky` (not `fixed`, the BUG-SHEET-001 class where a fixed CTA escapes the Sheet's scroll
// region), and inside the overlay a successful save replaces the sheet body with a DURABLE
// confirmation card — no auto-dismiss timer, explicit actions only (Close primary / View event
// secondary / Log another rapid entry / Undo tertiary via the sanctioned soft-delete). The
// non-overlay branch DELIBERATELY keeps the timed global undo toast (asserted below — this seam
// has regressed 3×, so BOTH branches are pinned here). Queries are role-based per L-275: assert
// what the a11y tree exposes, not attribute presence.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const { apiFetchSpy, navigateSpy, postCalls, dataRef, searchParamsRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  postCalls: [],
  dataRef: { projects: [], locations: [], plants: [], postResult: { id: 'evt-1', project_id: 'proj-1' }, postError: null, deleteError: null },
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
    if (options.method === 'DELETE') {
      return dataRef.deleteError ? Promise.reject(dataRef.deleteError) : Promise.resolve({ undone: true })
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

function renderFullPage(query = '') {
  searchParamsRef.current = new URLSearchParams(query)
  return render(<ToastProvider><EventNew /></ToastProvider>)
}

async function flushLoad() {
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/projects'))
  await act(async () => { await Promise.resolve() })
}

async function saveOnce() {
  fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
  await act(async () => { fireEvent.click(screen.getByText('Save')) })
}

beforeEach(() => {
  apiFetchSpy.mockReset(); navigateSpy.mockReset(); postCalls.length = 0
  searchParamsRef.current = new URLSearchParams()
  dataRef.projects = [PROJECT]; dataRef.locations = []; dataRef.plants = []
  dataRef.postResult = { id: 'evt-1', project_id: 'proj-1' }; dataRef.postError = null; dataRef.deleteError = null
  sessionStorage.clear()
  wireApiFetch()
})

afterEach(() => { vi.useRealTimers() })

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
})

describe('EventNew — V4-LOGCONF-001 durable confirmation (C1/C2)', () => {
  it('save replaces the sheet body with a durable confirmation card — no auto-dismiss timer', async () => {
    renderInOverlay('event_type=watering')
    await flushLoad()
    vi.useFakeTimers()
    await saveOnce()
    expect(postCalls.length).toBe(1)
    // card announced via the a11y tree
    const status = screen.getByRole('status')
    expect(status.textContent).toMatch(/Logged/)
    // body replaced: the form's Save is gone
    expect(screen.queryByText('Save')).toBeNull()
    // three actions with correct roles: Close (primary button), View event (link, literal noun),
    // Undo (tertiary button, separated from the footer cluster)
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'View event' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /undo/i })).toBeTruthy()
    // deliberate focus management: focus lands on the primary/default action
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))
    // DURABLE: a minute of timer advancement does not dismiss it
    act(() => { vi.advanceTimersByTime(60000) })
    expect(screen.getByRole('status').textContent).toMatch(/Logged/)
    expect(screen.getByRole('button', { name: /undo/i })).toBeTruthy()
  })

  it('View event link is built from the POST response, not staged client state', async () => {
    // response project intentionally differs from the selected form project — the link must follow the response
    dataRef.postResult = { id: 'evt-7', project_id: 'proj-9' }
    renderInOverlay('event_type=watering')
    await flushLoad()
    await saveOnce()
    const view = screen.getByRole('link', { name: 'View event' })
    expect(view.getAttribute('href')).toBe('/projects/proj-9/events/evt-7')
  })

  it('Undo soft-deletes via the sanctioned DELETE path and flips to a durable undone state', async () => {
    renderInOverlay('event_type=watering')
    await flushLoad()
    vi.useFakeTimers()
    await saveOnce()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /undo/i })) })
    expect(apiFetchSpy).toHaveBeenCalledWith('/api/events/evt-1', { method: 'DELETE' })
    expect(screen.getByRole('status').textContent).toMatch(/removed/i)
    // undone is terminal for this log: View + Undo withdrawn, explicit exits remain
    expect(screen.queryByRole('link', { name: 'View event' })).toBeNull()
    expect(screen.queryByRole('button', { name: /undo/i })).toBeNull()
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Log another' })).toBeTruthy()
    // still no timer dismissal in the undone state
    act(() => { vi.advanceTimersByTime(60000) })
    expect(screen.getByRole('status').textContent).toMatch(/removed/i)
  })

  it('a failed Undo keeps the card with a retryable error — never a silent loss', async () => {
    dataRef.deleteError = new Error('boom')
    renderInOverlay('event_type=watering')
    await flushLoad()
    await saveOnce()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /undo/i })) })
    expect(screen.getByRole('alert').textContent).toMatch(/undo/i)
    // card intact, Undo still offered for retry
    expect(screen.getByRole('status').textContent).toMatch(/Logged/)
    expect(screen.getByRole('button', { name: /undo/i })).toBeTruthy()
    // retry succeeds
    dataRef.deleteError = null
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /undo/i })) })
    expect(screen.getByRole('status').textContent).toMatch(/removed/i)
  })

  it('Log another returns to the reset form — rapid entry (V3-EVENT-001) preserved', async () => {
    dataRef.plants = [{ id: 'pl-1', name: 'Cayenne #1' }, { id: 'pl-2', name: 'Cayenne #2' }]
    renderInOverlay('event_type=watering')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await waitFor(() => screen.getByText('Cayenne #1'))
    fireEvent.change(screen.getByLabelText('Plant or group'), { target: { value: 'pl-1' } })
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Log another' })) })
    // form is back with rapid-entry scope: project kept, type kept, plant cleared
    expect(screen.getByText('Save')).toBeTruthy()
    expect(screen.getByLabelText('Project').value).toBe('proj-1')
    expect(screen.getByLabelText('Plant or group').value).toBe('')
    // second save works end-to-end without re-picking the type
    fireEvent.change(screen.getByLabelText('Plant or group'), { target: { value: 'pl-2' } })
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    expect(postCalls.length).toBe(2)
    expect(postCalls[1].event_type).toBe('watering')
    expect(postCalls[1].plant_id).toBe('pl-2')
  })

  it('Close dismisses the overlay explicitly', async () => {
    renderInOverlay('event_type=watering')
    await flushLoad()
    await saveOnce()
    expect(navigateSpy).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Close' })) })
    // no OverlayProvider in this harness → useOverlayDismiss falls back to /today (replace)
    expect(navigateSpy).toHaveBeenCalledWith('/today', { replace: true })
  })

  it('non-overlay branch: no confirmation card; the timed global undo toast is preserved', async () => {
    renderFullPage('event_type=watering')
    await flushLoad()
    vi.useFakeTimers()
    await saveOnce()
    expect(postCalls.length).toBe(1)
    // no card: form stays visible (zero-tap rapid entry), no View link
    expect(screen.getByText('Save')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'View event' })).toBeNull()
    // the global operational toast announces with its existing 5s lifetime
    expect(screen.getByRole('status').textContent).toMatch(/Logged event for Tomatoes 2026/)
    act(() => { vi.advanceTimersByTime(5001) })
    expect(screen.queryByRole('status')).toBeNull()
  })
})
