// V4-HARVDRAFTGAP-001 — the harvest panel now survives a dismiss/navigate.
//
// The gap: harvest quantity/weight/quality live in their own `harvest` state object, not in `form`,
// so DRAFT_FORM_FIELDS could never carry them however it was spelled. A typed weight was simply
// never stashed — Escape, Android Back, and the overlay's own "Done" all destroyed it with nothing
// to restore. EventNew.jsx even carried a comment naming this as a STATED LOSS.
//
// This is the dismiss/navigate leg of the same user-facing loss whose SW-reload leg is held by
// V4-RELOADGATEWIRE-001. A reload can be deferred; a dismiss cannot, so this one has to persist.
//
// Harness mirrors EventNewDraftFullPage.test.jsx.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const { apiFetchSpy, navigateSpy, dataRef, searchParamsRef } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
  navigateSpy: vi.fn(),
  dataRef: { projects: [], locations: [], plants: [], postResult: { id: 'evt-1', project_id: 'proj-1' }, postError: null },
  searchParamsRef: { current: new URLSearchParams() },
}))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: vi.fn().mockResolvedValue({ photo: { id: 'p1' } }), isUploading: false, error: null, photo: null, stage: null, progress: null, preview: null, reset: vi.fn() }),
}))
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

const PROJECT = { id: 'proj-1', name: 'Tomatoes 2026', status: 'growing' }
const DRAFT_KEY = 'gardenApp.draft.logone'

function wireApiFetch() {
  apiFetchSpy.mockImplementation((path, options = {}) => {
    if (options.method === 'POST' && path === '/api/events') {
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

async function flushLoad() {
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/projects'))
  await act(async () => { await Promise.resolve() })
}

const readDraft = () => JSON.parse(sessionStorage.getItem(DRAFT_KEY) || 'null')

beforeEach(() => {
  apiFetchSpy.mockReset(); navigateSpy.mockReset()
  searchParamsRef.current = new URLSearchParams()
  dataRef.projects = [PROJECT]; dataRef.locations = []; dataRef.plants = []
  dataRef.postResult = { id: 'evt-1', project_id: 'proj-1' }; dataRef.postError = null
  sessionStorage.clear()
  try { localStorage.clear() } catch { /* noop */ }
  wireApiFetch()
})

describe('EventNew — harvest draft stash (V4-HARVDRAFTGAP-001)', () => {
  it('a typed weight ALONE is stashed (no notes needed to arm the predicate)', async () => {
    renderFullPage('event_type=harvest')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Harvest weight'), { target: { value: '2.4' } })
    // Weight alone used to satisfy nothing: the old predicate counted only notes/private_notes/
    // quantity, so this wrote no draft at all.
    expect(readDraft()?.data?.harvest?.weight).toBe('2.4')
  })

  it('a typed weight is restored on a bare re-mount', async () => {
    const first = renderFullPage('event_type=harvest')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Harvest weight'), { target: { value: '2.4' } })
    first.unmount()

    renderFullPage('')
    await flushLoad()
    expect(screen.getByLabelText('Harvest weight').value).toBe('2.4')
  })

  it('a stashed quality rating survives the restore round-trip', async () => {
    // Driven through storage, not the UI: the quality control is behind HARVEST_QUALITY_HIDDEN
    // (currently ON), so it renders nowhere and quality_rating cannot be set by a user today. The
    // field is carried anyway so the stash is already correct if that flag flips — but a test that
    // pretended to click it would be asserting against a control that does not exist.
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify({
      v: 1,
      data: {
        form: { event_type: 'harvest', notes: '', private_notes: '', quantity: '', event_date: '2026-08-17T10:00', is_public: true, plant_id: '' },
        showPrivate: false, showAddDetails: false, showHarvestMore: false,
        harvest: { quantity: '', weight: '3.1', quality_rating: 3, unit: 'handfuls', weight_unit: 'lb', unitTouched: false },
      },
    }))
    renderFullPage('')
    await flushLoad()
    expect(screen.getByLabelText('Harvest weight').value).toBe('3.1')

    // Touch a field so the stash rewrites, and confirm the restored rating rode along rather than
    // being dropped back to null on the way through component state.
    fireEvent.change(screen.getByLabelText('Harvest weight'), { target: { value: '3.2' } })
    expect(readDraft()?.data?.harvest?.quality_rating).toBe(3)
  })

  it('a PRISTINE harvest mount writes NO draft — units alone must not arm the predicate', async () => {
    // The regression this guards is the one the narrowed predicate was introduced to kill:
    // freshHarvest() seeds unit/weight_unit from stored prefs, so counting them as dirty would
    // stash on every pristine mount and let an empty draft clobber the sticky seeds on the next.
    localStorage.setItem('logone.lastHarvestUnit', 'lb')
    renderFullPage('event_type=harvest')
    await flushLoad()
    expect(readDraft()).toBeNull()
  })

  it('a restored unit does not get clobbered by the crop-default reseed', async () => {
    // The restore carries unitTouched, not just the unit value: the reseed effect re-fires on
    // plant/type changes and yields only to unitTouchedRef, so a deliberately-chosen unit needs the
    // flag to survive. The type-change reset also clears that ref, which is the second reason the
    // restore has to claim its own transition.
    const first = renderFullPage('event_type=harvest')
    await flushLoad()
    fireEvent.change(screen.getByLabelText('Harvest weight'), { target: { value: '1.5' } })
    fireEvent.change(screen.getByLabelText('Harvest weight unit'), { target: { value: 'oz' } })
    expect(readDraft()?.data?.harvest?.weight_unit).toBe('oz')
    first.unmount()

    renderFullPage('')
    await flushLoad()
    expect(screen.getByLabelText('Harvest weight unit').value).toBe('oz')
  })
})
