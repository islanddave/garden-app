// V4-RELOADGATEWIRE-001 — proves the PRODUCER half of OPS-SWRELOADGUARD-001 is connected for Log
// Many. Mirrors EventNew.reloadGateWire.test.jsx (see that file for the fuller "why this exists"
// context: reloadGate.js and registerSW's deferral shipped fully built and mutation-proved with
// zero callers, so their own unit tests could never see that nothing held the gate — an inert
// feature that passed every test it had and changed nothing for the user).
//
// reloadGate.js names LogMany explicitly as a second intended consumer ("Several surfaces can be
// dirty at once (a capture form under an open overlay, PutUp, LogMany)"), and a bulk batch confirm
// is exactly the burst-typing surface a mid-form deploy reload lands hardest on.
//
// Real reloadGate + real registerSW, nothing mocked between them — a spied setReloadBlocked would
// re-create the exact blind spot this file exists to close. `searchParams` is a STABLE
// module-scope URLSearchParams (mirrors LogManyNotes.test.jsx / LogManyDraftFullPage.test.jsx) —
// NOT `new URLSearchParams()` inlined in the mock factory: LogMany's initial-load effect depends
// on the destructured `params`, so a fresh instance on every call reruns that effect (and its
// fetch → setState → re-render) forever.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const navigate = vi.fn()
const searchParams = new URLSearchParams()
const setSearchParams = vi.fn()
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
  useSearchParams: () => [searchParams, setSearchParams],
  Link: ({ children }) => children,
}))

const apiFetch = vi.fn()
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetch }) }))

import LogMany from '../pages/LogMany.jsx'
import { OverlayDirtyProvider } from '../context/OverlayContext.jsx'
import { isReloadBlocked, clearReloadBlocks } from '../lib/reloadGate.js'
import { registerServiceWorker } from '../lib/registerSW.js'

function wireApiFetch() {
  apiFetch.mockImplementation((path, opts = {}) => {
    if (path === '/api/projects') return Promise.resolve([])
    if (path === '/api/locations') return Promise.resolve({ locations: [] })
    if (path === '/api/events/batch' && opts.method === 'POST') return Promise.resolve({ count: 0, plantings: [] })
    return Promise.resolve(null)
  })
}

async function renderReady(ui = <LogMany />) {
  const result = render(ui)
  await screen.findByText('Watered')
  return result
}

const openNotes = () => fireEvent.click(screen.getByTestId('logmany-notes-disclosure'))
const noteField = () => screen.getByLabelText('Notes for this batch')
const typeNote = (v) => { openNotes(); fireEvent.change(noteField(), { target: { value: v } }) }

// Mirrors registerSW.test.js / EventNew.reloadGateWire.test.jsx makeSwEnv: a prior controller so
// controllerchange counts as an UPDATE (the reload path) rather than a first install. `reload` is
// passed as an explicit opt (registerServiceWorker's injectable default), so it — not
// win.location.reload — is what the reload assertions read.
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
const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  navigate.mockClear()
  apiFetch.mockReset()
  wireApiFetch()
  try { localStorage.clear(); sessionStorage.clear() } catch { /* noop */ }
  clearReloadBlocks()
})

describe('LogMany ↔ reloadGate wiring (V4-RELOADGATEWIRE-001)', () => {
  it('a pristine form does NOT hold the gate', async () => {
    await renderReady()
    // Default event type 'watering', no date/notes, scope=all — the shared `dirty` predicate's own
    // rest state. Holding on a bare mount would wedge every update for a user who merely opened
    // Log Many.
    expect(isReloadBlocked()).toBe(false)
  })

  it('a typed note (the shared `dirty` predicate) holds the gate, and useReportOverlayDirty reports the same value', async () => {
    const onDirtyChange = vi.fn()
    await renderReady(<OverlayDirtyProvider onDirtyChange={onDirtyChange}><LogMany /></OverlayDirtyProvider>)
    onDirtyChange.mockClear()   // drop the pristine-mount false report
    typeNote('side-dressed the whole bed')
    expect(isReloadBlocked()).toBe(true)
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
  })

  it('clearing back to pristine (still mounted) releases the gate on both channels', async () => {
    const onDirtyChange = vi.fn()
    await renderReady(<OverlayDirtyProvider onDirtyChange={onDirtyChange}><LogMany /></OverlayDirtyProvider>)
    typeNote('half a thought')
    expect(isReloadBlocked()).toBe(true)
    fireEvent.change(noteField(), { target: { value: '' } })
    expect(isReloadBlocked()).toBe(false)
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
  })

  it('unmounting a dirty form releases the hold (never wedge updates — BUG-STALECLIENT-001)', async () => {
    const { unmount } = await renderReady()
    typeNote('half typed')
    expect(isReloadBlocked()).toBe(true)
    unmount()
    expect(isReloadBlocked()).toBe(false)
  })

  it('END TO END: a dirty batch DEFERS the SW reload, and unmount lets it fire exactly once', async () => {
    const env = makeSwEnv()
    const teardown = registerServiceWorker(env)
    await flush()

    const { unmount } = await renderReady()
    typeNote('two thirds of a sentence')

    // A deploy lands mid-batch. Before this row shipped, this reloaded and took the note with it.
    env.sw.dispatchEvent(new Event('controllerchange'))
    expect(env.reload).not.toHaveBeenCalled()

    // Deferred, NOT cancelled: the moment the form is gone, the pending reload lands.
    unmount()
    expect(env.reload).toHaveBeenCalledTimes(1)
    teardown()
  })
})
