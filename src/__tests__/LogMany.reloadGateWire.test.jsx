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
// The guarded predicate is NOT the draft-stash `dirty`: LogMany runs two, as EventNew does. The
// cases below pin the difference — a sticky event type, a remembered scope and a ?project_id= deep
// link must NOT arm either channel on a mount with no user input, and a successful batch must
// release both — while the typed-note cases pin that the narrowing is not a disarm.
//
// Real reloadGate + real registerSW, nothing mocked between them — a spied setReloadBlocked would
// re-create the exact blind spot this file exists to close. `searchParams` is a STABLE
// module-scope URLSearchParams (mirrors LogManyNotes.test.jsx / LogManyDraftFullPage.test.jsx) —
// NOT `new URLSearchParams()` inlined in the mock factory: LogMany's initial-load effect depends
// on the destructured `params`, so a fresh instance on every call reruns that effect (and its
// fetch → setState → re-render) forever.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
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

// Stubbed ScopeChecklist (same shape as LogManyResultUndo/LogManyStickyType): commits a non-zero
// selection on demand so Confirm is reachable, and echoes the `scope` prop so a seeded-scope test
// can prove the seed actually landed — otherwise a "seeded scope does not arm the guard" assertion
// is satisfied just as well by the seed silently failing.
vi.mock('../components/forms', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    ScopeChecklist: ({ scope, onSelectionChange }) => (
      <div>
        <div data-testid="stub-scope">{JSON.stringify(scope)}</div>
        <button type="button" onClick={() => onSelectionChange({ committedCount: 4, excludedIds: [] })}>commit-scope</button>
      </div>
    ),
  }
})

import LogMany from '../pages/LogMany.jsx'
import { OverlayDirtyProvider } from '../context/OverlayContext.jsx'
import { isReloadBlocked, clearReloadBlocks } from '../lib/reloadGate.js'
import { registerServiceWorker } from '../lib/registerSW.js'

const PROJECT = { id: 'proj-1', name: 'Beds' }
const EVENT_TYPE_KEY = 'quicklog.lastEventType'
const SCOPE_KEY = 'quicklog.lastScope'

function wireApiFetch() {
  apiFetch.mockImplementation((path, opts = {}) => {
    // A real project so the ?project_id= / lastScope seeds validate against live data (both are
    // dropped when the id doesn't resolve).
    if (path === '/api/projects') return Promise.resolve([PROJECT])
    if (path === '/api/locations') return Promise.resolve({ locations: [] })
    if (path === '/api/events/batch' && opts.method === 'POST') {
      return JSON.parse(opts.body).dry_run
        ? Promise.resolve({ count: 4 })
        : Promise.resolve({ batch_id: 'b-1', count: 4 })
    }
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

  // ── Pristine-but-SEEDED mounts ───────────────────────────────────────────────────────────────
  // The guard predicate is deliberately NARROWER than the draft-stash `dirty`: sticky and deep-link
  // seeding put content on this form that the user did not enter THIS mount, and counting it armed
  // both channels on a mount with zero user input — a held SW reload plus a dead overlay backdrop
  // for anyone whose last batch was anything but watering, which is most of them. Same rule (and
  // the same reason) as EventNew's `hasUnsavedInput` excluding bare event_type/plant_id picks.
  it('a sticky non-watering event type does NOT arm either guard on a pristine mount', async () => {
    localStorage.setItem(EVENT_TYPE_KEY, 'flowering')   // seeded AFTER the beforeEach clear
    const onDirtyChange = vi.fn()
    await renderReady(<OverlayDirtyProvider onDirtyChange={onDirtyChange}><LogMany /></OverlayDirtyProvider>)
    // Non-vacuity: the seed really did take (confirm label is derived from eventType state).
    expect(screen.getByText('Log flowering on 0')).toBeTruthy()
    expect(isReloadBlocked()).toBe(false)
    expect(onDirtyChange).not.toHaveBeenCalledWith(true)
  })

  it('a remembered non-"all" scope does NOT arm either guard on a pristine mount', async () => {
    localStorage.setItem(SCOPE_KEY, JSON.stringify({ type: 'project', project_id: PROJECT.id }))
    const onDirtyChange = vi.fn()
    await renderReady(<OverlayDirtyProvider onDirtyChange={onDirtyChange}><LogMany /></OverlayDirtyProvider>)
    await waitFor(() => expect(screen.getByTestId('stub-scope').textContent).toContain(PROJECT.id))
    expect(isReloadBlocked()).toBe(false)
    expect(onDirtyChange).not.toHaveBeenCalledWith(true)
  })

  it('a ?project_id= deep-linked scope does NOT arm either guard on a pristine mount', async () => {
    // The module-scope searchParams is shared by every test in this file (stable identity is what
    // keeps LogMany's loader effect from self-triggering), so restore it before returning.
    searchParams.set('project_id', PROJECT.id)
    try {
      const onDirtyChange = vi.fn()
      await renderReady(<OverlayDirtyProvider onDirtyChange={onDirtyChange}><LogMany /></OverlayDirtyProvider>)
      await waitFor(() => expect(screen.getByTestId('stub-scope').textContent).toContain(PROJECT.id))
      expect(isReloadBlocked()).toBe(false)
      expect(onDirtyChange).not.toHaveBeenCalledWith(true)
    } finally {
      searchParams.delete('project_id')
    }
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

  // Negative control, ported from EventNew.reloadGateWire.test.jsx. Passes both before and after the
  // narrowing by design — its job is to catch the opposite failure (a gate that never lets go), which
  // is BUG-STALECLIENT-001 rebuilt. Without it, "isReloadBlocked() is false" assertions elsewhere in
  // this file could be satisfied by a gate that is simply broken.
  it('with nothing dirty, a controllerchange still reloads immediately (gate is not a disarm)', async () => {
    const env = makeSwEnv()
    const teardown = registerServiceWorker(env)
    await flush()

    await renderReady()
    env.sw.dispatchEvent(new Event('controllerchange'))
    expect(env.reload).toHaveBeenCalledTimes(1)
    teardown()
  })
})

// The other half of the narrowing: it must not become a DISARM. Everything the guard protected
// before still holds it, and the release happens on the save, not before it.
describe('LogMany ↔ reloadGate wiring — release on save (V4-RELOADGATEWIRE-001)', () => {
  it('a successful batch releases both channels on the result screen', async () => {
    const onDirtyChange = vi.fn()
    await renderReady(<OverlayDirtyProvider onDirtyChange={onDirtyChange}><LogMany /></OverlayDirtyProvider>)
    typeNote('side-dressed the whole bed')
    // Armed while the note is unwritten — the fix narrows the predicate, it does not disable it.
    expect(isReloadBlocked()).toBe(true)

    fireEvent.click(screen.getByText('commit-scope'))
    fireEvent.click(await screen.findByText('Log watered on 4'))
    await screen.findByText(/plantings watered|planting watered/)

    // The rows are in the DB and the draft is cleared: there is nothing left for a reload to destroy,
    // and a backdrop tap on the "batch saved / Undo" screen must dismiss rather than no-op.
    expect(isReloadBlocked()).toBe(false)
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
  })
})
