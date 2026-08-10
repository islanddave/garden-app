// V4-DRAFTFULLPAGE-001 (a) — the draft stash now covers the FULL-PAGE /log path, not just the
// overlay (both stash effects used to early-return on !inOverlay, so a mis-tap away from full-page
// /log destroyed in-progress input: no persistence, and no router blocker is possible — useBlocker
// needs a data router, App uses declarative BrowserRouter). Also pins the NARROWED dirty predicate
// (typed text only): the old any-field predicate meant sticky/seeded picks rewrote a post-save
// draft whose empty plant_id clobbered the V4-LOGTARGET-001 remembered-planting seed on the next
// bare mount. Harness mirrors EventNewOverlaySlice2.test.jsx.
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
import { OverlaySurfaceProvider } from '../context/OverlayContext.jsx'

const PROJECT = { id: 'proj-1', name: 'Tomatoes 2026', status: 'growing' }
const DRAFT_KEY = 'gardenApp.draft.logone'

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

function renderFullPage(query = '') {
  searchParamsRef.current = new URLSearchParams(query)
  return render(<ToastProvider><EventNew /></ToastProvider>)
}

function renderInOverlay(query = '') {
  searchParamsRef.current = new URLSearchParams(query)
  return render(<ToastProvider><OverlaySurfaceProvider><EventNew /></OverlaySurfaceProvider></ToastProvider>)
}

async function flushLoad() {
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/projects'))
  await act(async () => { await Promise.resolve() })
}

function seedDraft(formOverrides = {}) {
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify({
    v: 1,
    data: {
      form: {
        event_type: 'watering', notes: 'half-typed note', private_notes: '', quantity: '',
        event_date: '2026-08-01T10:00', is_public: true, plant_id: '',
        ...formOverrides,
      },
      showPrivate: false, showAddDetails: false,
    },
  }))
}

beforeEach(() => {
  apiFetchSpy.mockReset(); navigateSpy.mockReset(); postCalls.length = 0
  searchParamsRef.current = new URLSearchParams()
  dataRef.projects = [PROJECT]; dataRef.locations = []; dataRef.plants = []
  dataRef.postResult = { id: 'evt-1', project_id: 'proj-1' }; dataRef.postError = null
  sessionStorage.clear()
  try { localStorage.clear() } catch { /* noop */ }
  wireApiFetch()
})

describe('EventNew — V4-DRAFTFULLPAGE-001 full-page draft stash', () => {
  it('typing notes on the FULL PAGE writes the draft (was overlay-only)', async () => {
    renderFullPage('event_type=watering')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'aphids on the kale' } })
    const raw = sessionStorage.getItem(DRAFT_KEY)
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw)
    expect(parsed.data.form.notes).toBe('aphids on the kale')
    expect(parsed.data.form.event_type).toBe('watering') // picks ride along with typed text
  })

  it('a bare full-page mount restores the stashed draft', async () => {
    seedDraft()
    renderFullPage('')
    await flushLoad()
    expect(screen.getByLabelText('Notes').value).toBe('half-typed note')
  })

  it('a seed deep-link expresses fresh intent — the stale draft is NOT restored', async () => {
    seedDraft({ notes: 'stale draft text' })
    renderFullPage('event_type=watering')
    await flushLoad()
    expect(screen.getByLabelText('Notes').value).toBe('')
  })

  it('picks alone never write a draft (narrowed predicate — the sticky-seed clobber guard)', async () => {
    renderFullPage('event_type=watering')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await act(async () => { await Promise.resolve() })
    expect(sessionStorage.getItem(DRAFT_KEY)).toBeNull()
  })

  it('a successful save clears the draft and the post-save reset does NOT rewrite it', async () => {
    renderFullPage('event_type=watering')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'about to save' } })
    expect(sessionStorage.getItem(DRAFT_KEY)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj-1' } })
    await act(async () => { fireEvent.click(screen.getByText('Save')) })
    expect(postCalls.length).toBe(1)
    // resetForNext keeps event_type (keepMode 'type') — under the old any-field predicate that
    // alone re-stashed a draft here, which is exactly the clobber this pin exists to prevent.
    expect(sessionStorage.getItem(DRAFT_KEY)).toBeNull()
  })

  it('the overlay surface still restores a draft (unchanged contract)', async () => {
    seedDraft()
    renderInOverlay('')
    await flushLoad()
    expect(screen.getByLabelText('Notes').value).toBe('half-typed note')
  })
})
