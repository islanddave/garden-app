// V4-RELOADGATEWIRE-001 — proves the PRODUCER half of OPS-SWRELOADGUARD-001 is connected.
//
// Why this file exists at all: reloadGate.js shipped fully built and mutation-proved, registerSW
// shipped consuming it, and the whole thing was still inert in production — nothing ever CALLED
// setReloadBlocked, so isReloadBlocked() was false at every controllerchange. reloadGate.test.js
// was green throughout, because a primitive's own unit tests cannot see that it has no callers.
//
// So every assertion here is deliberately an INTEGRATION one: real reloadGate, real registerSW,
// real EventNew, nothing mocked between them. A test that asserted on a spied setReloadBlocked
// would re-create the exact blind spot this row exists to close.
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
import { isReloadBlocked, clearReloadBlocks } from '../lib/reloadGate.js'
import { registerServiceWorker } from '../lib/registerSW.js'

const PROJECT = { id: 'proj-1', name: 'Tomatoes 2026', status: 'growing' }

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

// FULL PAGE on purpose. useReportOverlayDirty is a no-op without a provider, so the full page is
// precisely where the Sheet's dirty channel does NOT protect the form — if the gate were wired
// through that hook instead of independently, every assertion below would fail.
function renderFullPage(query = '') {
  searchParamsRef.current = new URLSearchParams(query)
  return render(<ToastProvider><EventNew /></ToastProvider>)
}

async function flushLoad() {
  await waitFor(() => expect(apiFetchSpy).toHaveBeenCalledWith('/api/projects'))
  await act(async () => { await Promise.resolve() })
}

function typeNotes(text) {
  fireEvent.click(screen.getByTestId('notes-disclosure'))
  fireEvent.change(screen.getByLabelText('Notes'), { target: { value: text } })
}

const flush = () => new Promise((r) => setTimeout(r, 0))

// Mirrors registerSW.test.js makeEnv, with a prior controller so controllerchange counts as an
// UPDATE (the reload path) rather than a first install.
function makeSwEnv() {
  const registration = { update: vi.fn().mockResolvedValue(undefined) }
  const sw = new EventTarget()
  sw.controller = {}
  sw.register = vi.fn().mockResolvedValue(registration)
  const nav = { serviceWorker: sw }
  const win = Object.assign(new EventTarget(), { location: { reload: vi.fn() } })
  const doc = Object.assign(new EventTarget(), { readyState: 'complete', visibilityState: 'visible' })
  const reload = vi.fn()
  return { registration, sw, nav, win, doc, reload }
}

beforeEach(() => {
  apiFetchSpy.mockReset(); navigateSpy.mockReset()
  searchParamsRef.current = new URLSearchParams()
  dataRef.projects = [PROJECT]; dataRef.locations = []; dataRef.plants = []
  dataRef.postResult = { id: 'evt-1', project_id: 'proj-1' }; dataRef.postError = null
  sessionStorage.clear()
  try { localStorage.clear() } catch { /* noop */ }
  clearReloadBlocks()
  wireApiFetch()
})

describe('EventNew ↔ reloadGate wiring (V4-RELOADGATEWIRE-001)', () => {
  it('a pristine form does NOT hold the gate', async () => {
    renderFullPage('event_type=watering')
    await flushLoad()
    // Seeded event_type/plant_id are picks, not typed content — holding on a bare mount would
    // wedge every update for a user who merely opened the form.
    expect(isReloadBlocked()).toBe(false)
  })

  it('typed notes on the FULL PAGE hold the gate', async () => {
    renderFullPage('event_type=watering')
    await flushLoad()
    typeNotes('aphids on the kale')
    expect(isReloadBlocked()).toBe(true)
  })

  it('a typed harvest weight holds the gate — the field the draft stash cannot restore', async () => {
    renderFullPage('event_type=harvest')
    await flushLoad()
    // Exact label, not /weight/i — that also matches the adjacent unit <select>.
    const weight = screen.queryByLabelText('Harvest weight')
    // Guard the guard: if the harvest weight input is renamed, fail loudly rather than silently
    // asserting nothing. DRAFT_FORM_FIELDS does not cover harvest.weight, so the gate is the ONLY
    // thing standing between a deploy and a lost weight.
    expect(weight, 'harvest weight input not found — selector needs updating').toBeTruthy()
    fireEvent.change(weight, { target: { value: '2.4' } })
    expect(isReloadBlocked()).toBe(true)
  })

  it('unmounting a dirty form RELEASES the hold (never wedge updates — BUG-STALECLIENT-001)', async () => {
    const { unmount } = renderFullPage('event_type=watering')
    await flushLoad()
    typeNotes('half typed')
    expect(isReloadBlocked()).toBe(true)
    unmount()
    expect(isReloadBlocked()).toBe(false)
  })

  it('END TO END: a dirty form DEFERS the SW reload, and unmount lets it fire exactly once', async () => {
    const env = makeSwEnv()
    const teardown = registerServiceWorker(env)
    await flush()

    const { unmount } = renderFullPage('event_type=watering')
    await flushLoad()
    typeNotes('two thirds of a sentence')

    // A deploy lands mid-form. Before this row shipped, this reloaded and took the text with it.
    env.sw.dispatchEvent(new Event('controllerchange'))
    expect(env.reload).not.toHaveBeenCalled()

    // Deferred, NOT cancelled: the moment the form is gone, the pending reload lands.
    unmount()
    expect(env.reload).toHaveBeenCalledTimes(1)
    teardown()
  })

  it('typing MORE while dirty does not fire the deferred reload, but clearing the text does', async () => {
    // The hold effect's dep is a boolean, so continued typing (true→true) compares equal and the
    // effect never re-runs — the cleanup cannot release mid-form. Both halves are asserted here
    // because they are the same guarantee from opposite sides: the gate must survive every
    // keystroke, and must NOT survive the form going clean (that would wedge updates).
    const env = makeSwEnv()
    const teardown = registerServiceWorker(env)
    await flush()

    renderFullPage('event_type=watering')
    await flushLoad()
    typeNotes('first')
    env.sw.dispatchEvent(new Event('controllerchange'))
    expect(env.reload).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'first and second' } })
    await act(async () => { await Promise.resolve() })
    expect(env.reload, 'a keystroke must not release the hold').not.toHaveBeenCalled()
    expect(isReloadBlocked()).toBe(true)

    // Form goes clean — the deferred reload is now safe and must actually land.
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Notes'), { target: { value: '' } })
    })
    expect(isReloadBlocked()).toBe(false)
    expect(env.reload).toHaveBeenCalledTimes(1)
    teardown()
  })

  it('with nothing dirty, a controllerchange still reloads immediately (gate is not a disarm)', async () => {
    const env = makeSwEnv()
    const teardown = registerServiceWorker(env)
    await flush()

    renderFullPage('event_type=watering')
    await flushLoad()
    env.sw.dispatchEvent(new Event('controllerchange'))
    expect(env.reload).toHaveBeenCalledTimes(1)
    teardown()
  })
})
