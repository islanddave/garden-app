// V4-DRAFTFULLPAGE-001 (b) — EventNew's dirty REPORT to the hosting Sheet. The predicate is
// deliberately broader than the draft-stash one (it counts the non-stashed panels a dismiss would
// truly lose: photo, harvest qty, metadata, treatment, container, issue text) and deliberately
// EXCLUDES bare event_type/plant_id picks — sticky/deep-link seeding must never lock the backdrop
// on a pristine mount. False while the confirmation card shows (already saved). Harness mirrors
// EventNewOverlaySlice2.test.jsx; the provider is driven with a value-capturing spy.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const { apiFetchSpy, navigateSpy, postCalls, dataRef, searchParamsRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  postCalls: [],
  dataRef: { projects: [], locations: [], plants: [], postResult: { id: 'evt-1', project_id: 'proj-1' }, postError: null },
  searchParamsRef: { current: new URLSearchParams() },
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: vi.fn().mockResolvedValue({ photo: { id: 'p1' } }), isUploading: false, error: null, photo: null, stage: null, progress: null, preview: null, reset: vi.fn() }),
}))
// V4-PLANTREQUIRED-001: the flag flipped TRUE in source on 2026-08-10. This suite predates the flip
// and its assertions describe the planting-OPTIONAL behavior, which remains a live configuration
// (rollback = one-line revert). Mocked FALSE so every assertion below keeps covering what it was
// written to cover, rather than being rewritten to the flag-ON world. Flag-ON is covered by
// EventNew.plantRequired.test.jsx and EventNew.plantMismatch.plantRequired.test.jsx.
// importActual spread so every other flag (OVERLAY_ROUTES_ENABLED etc.) keeps its real value.
vi.mock('../lib/featureFlags.js', async (importActual) => ({
  ...(await importActual()),
  PROJECTS_HIDDEN: false,
  PLANTING_REQUIRED_ENABLED: false,
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useNavigate: () => navigateSpy,
  useSearchParams: () => [searchParamsRef.current, vi.fn()],
}))

import EventNew from '../pages/EventNew.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import { OverlaySurfaceProvider, OverlayDirtyProvider } from '../context/OverlayContext.jsx'

const PROJECT = { id: 'proj-1', name: 'Tomatoes 2026', status: 'growing' }
const PLANT_A = { id: 'pl-A', name: 'Sungold #1', project_id: 'proj-1' }

const reported = { current: null }
const onDirtyChange = (v) => { reported.current = v }

function wireApiFetch() {
  apiFetchSpy.mockImplementation((path, options = {}) => {
    if (options.method === 'POST' && path === '/api/events') {
      postCalls.push(JSON.parse(options.body))
      return dataRef.postError ? Promise.reject(dataRef.postError) : Promise.resolve(dataRef.postResult)
    }
    if (path === '/api/projects') return Promise.resolve(dataRef.projects)
    if (path === '/api/locations/with-path') return Promise.resolve(dataRef.locations)
    if (path.startsWith('/api/plants')) return Promise.resolve(dataRef.plants)
    if (path.startsWith('/api/harvests')) return Promise.resolve(null)
    return Promise.resolve(null)
  })
}

function renderReporting(query = '') {
  searchParamsRef.current = new URLSearchParams(query)
  return render(
    <ToastProvider>
      <OverlaySurfaceProvider>
        <OverlayDirtyProvider onDirtyChange={onDirtyChange}>
          <EventNew />
        </OverlayDirtyProvider>
      </OverlaySurfaceProvider>
    </ToastProvider>
  )
}

async function flushLoad() {
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/projects'))
  await act(async () => { await Promise.resolve() })
}

beforeEach(() => {
  apiFetchSpy.mockReset(); navigateSpy.mockReset(); postCalls.length = 0
  searchParamsRef.current = new URLSearchParams()
  dataRef.projects = [PROJECT]; dataRef.locations = []; dataRef.plants = []
  dataRef.postResult = { id: 'evt-1', project_id: 'proj-1' }; dataRef.postError = null
  reported.current = null
  sessionStorage.clear()
  try { localStorage.clear() } catch { /* noop */ }
  wireApiFetch()
})

describe('EventNew — dirty report to the hosting Sheet (V4-DRAFTFULLPAGE-001 b)', () => {
  it('a pristine seeded mount reports NOT dirty', async () => {
    renderReporting('event_type=watering')
    await flushLoad()
    expect(reported.current).toBe(false)
  })

  it('sticky-seeded plant/project picks do NOT report dirty (backdrop stays live on a pristine mount)', async () => {
    localStorage.setItem('logone.lastProject', 'proj-1')
    localStorage.setItem('logone.lastPlant', 'pl-A')
    dataRef.plants = [PLANT_A]
    renderReporting('')
    await flushLoad()
    await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/plants?view=picker&project_id=proj-1'))
    expect(reported.current).toBe(false)
  })

  it('typed notes report dirty; clearing them reports clean again', async () => {
    renderReporting('event_type=watering')
    await flushLoad()
    // V4-NOTESCOLLAPSE-001: Notes is a collapsed disclosure at the foot of the form — open it first.
    fireEvent.click(screen.getByTestId('notes-disclosure'))
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'leggy seedlings' } })
    expect(reported.current).toBe(true)
    // V4-NOTESCOLLAPSE-001: Notes is a collapsed disclosure at the foot of the form — open it first.
    fireEvent.click(screen.getByTestId('notes-disclosure'))
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: '' } })
    expect(reported.current).toBe(false)
  })

  it('a typed harvest quantity (non-stashed panel) reports dirty', async () => {
    renderReporting('event_type=harvest')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Harvest quantity'), { target: { value: '2.5' } })
    expect(reported.current).toBe(true)
  })

  it('an attached photo (never stashed — real loss on dismiss) reports dirty', async () => {
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock')
    globalThis.URL.revokeObjectURL = vi.fn()
    renderReporting('event_type=watering')
    await flushLoad()
    const fileInput = document.querySelector('input[type="file"]')
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [new File(['x'], 'kale.jpg', { type: 'image/jpeg' })] } })
    })
    expect(reported.current).toBe(true)
  })

  it('after a save the confirmation card reports NOT dirty (card stays backdrop-dismissable)', async () => {
    renderReporting('event_type=watering')
    await flushLoad()
    // V4-NOTESCOLLAPSE-001: Notes is a collapsed disclosure at the foot of the form — open it first.
    fireEvent.click(screen.getByTestId('notes-disclosure'))
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'watered deeply' } })
    expect(reported.current).toBe(true)
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    expect(postCalls.length).toBe(1)
    expect(screen.getByRole('status')).toBeTruthy() // confirmation card is up
    expect(reported.current).toBe(false)
  })
})
