// V4-RELOADGATEWIRE-001 — proves PutUpForm carries the same three-part form guard as
// EventNew/LogMany: a versioned sessionStorage draft (draftStash), the Sheet backdrop-tap guard
// (useReportOverlayDirty), and the SW reload deferral (reloadGate).
//
// TWO predicates, mirroring EventNew: a BROAD one for the stash (anything worth keeping) and a
// NARROW one for the two guard channels (only content a reload/dismiss would actually destroy).
// The narrow one is what the prefilled + post-save cases below exercise — a single shared
// predicate armed both guards on a pristine harvest-triggered mount and never released them after
// a save, because every field it counted was either seeded by the prefill or carried forward by
// resetForNext().
//
// Mirrors four existing files rather than inventing new conventions:
//   - PutUp.test.jsx           — mock shape for useApiFetch/useUploadPhoto/useCropTypes, renderPutUp.
//   - LogManyDraftFullPage.test.jsx — readStash/seedStash sessionStorage helpers.
//   - EventNew.reloadGateWire.test.jsx — REAL reloadGate (isReloadBlocked/clearReloadBlocks) and
//     REAL registerSW, no spy between them: a mocked setReloadBlocked would hide exactly the
//     "shipped but never wired" blind spot that file exists to catch (reloadGate.js's own header
//     names EventNew as the "FIRST INTENDED CONSUMER" — this file proves PutUp is a second, real
//     one). Its makeSwEnv + the 'gate is not a disarm' negative control are ported verbatim in
//     shape, because a gate with no proof it still LETS a clean reload through is a gate that can
//     silently become a permanent disarm.
//   - OverlayDirtyWiring.test.jsx — real OverlayHost + backdrop-tap dismiss check for the dirty
//     channel (a mocked useReportOverlayDirty would prove nothing about wiring).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const fetchMock = vi.fn()
vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchMock, getToken: vi.fn() }),
  apiFetch: (...args) => fetchMock(...args),
}))
const uploadMock = vi.fn()
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: uploadMock, isUploading: false, error: null, photo: null, preview: null, reset: vi.fn() }),
}))
vi.mock('../hooks/useCropTypes.js', () => ({
  useCropTypes: () => ({
    cropTypes: [
      { slug: 'tomato', display_name: 'Tomato', category: 'vegetable' },
      { slug: 'pepper', display_name: 'Peppers', category: 'vegetable' },
    ],
    loading: false,
  }),
}))

// PARTIAL mock — the spy WRAPS the real hook rather than replacing it, so the backdrop-tap tests
// below still exercise the genuine OverlayHost wiring while the prefilled/post-save cases can
// assert on the exact values PutUp reported. Replacing it would make those cases vacuous.
const { overlayDirtySpy } = vi.hoisted(() => ({ overlayDirtySpy: vi.fn() }))
vi.mock('../context/OverlayContext.jsx', async (importActual) => {
  const actual = await importActual()
  return {
    ...actual,
    useReportOverlayDirty: (dirty) => { overlayDirtySpy(dirty); return actual.useReportOverlayDirty(dirty) },
  }
})

import PutUp from '../pages/PutUp.jsx'
import { OverlayHost } from '../App.jsx'
import { isReloadBlocked, clearReloadBlocks } from '../lib/reloadGate.js'
import { registerServiceWorker } from '../lib/registerSW.js'

const STASH_KEY = 'gardenApp.draft.put-up'
function readStash() {
  const raw = sessionStorage.getItem(STASH_KEY)
  return raw ? JSON.parse(raw).data : null
}
function seedStash(data) {
  sessionStorage.setItem(STASH_KEY, JSON.stringify({ v: 1, data }))
}

function wire() {
  fetchMock.mockImplementation((path, options = {}) => {
    const method = options.method || 'GET'
    if (path === '/api/storage-locations' && method === 'GET') return Promise.resolve([])
    if (path.startsWith('/api/plants') && method === 'GET') return Promise.resolve([])
    if (path.startsWith('/api/preservation/whats-put-up')) return Promise.resolve({ groups: [] })
    if (path === '/api/preservation' && method === 'POST') return Promise.resolve({ id: 'new-1', source_kind: 'own_garden' })
    return Promise.resolve(null)
  })
}

function lastPost() {
  const call = [...fetchMock.mock.calls].reverse().find(([, o]) => o?.method === 'POST')
  return call ? JSON.parse(call[1].body) : null
}

function entryFor(prefill) {
  return prefill ? { pathname: '/put-up', state: { prefill } } : { pathname: '/put-up' }
}
function renderFullPage(prefill) {
  return render(<MemoryRouter initialEntries={[entryFor(prefill)]}><PutUp /></MemoryRouter>)
}
// Location sink for the overlay-dirty backdrop tests — a dismiss navigates to the background
// (here: falls back to /today, since no background was pushed), a no-op leaves us on /put-up.
function Loc() {
  return <div data-testid="loc">{useLocation().pathname}</div>
}
function renderInOverlay(prefill) {
  return render(
    <MemoryRouter initialEntries={[entryFor(prefill)]}>
      <Loc />
      <OverlayHost ariaLabel="Put-Up" size="full"><PutUp /></OverlayHost>
    </MemoryRouter>
  )
}
const backdrop = () => screen.getByRole('dialog').previousSibling

function openLogForm() {
  fireEvent.click(screen.getByRole('radio', { name: 'Log a put-up' }))
}
function typeQty(v) {
  fireEvent.change(screen.getByRole('textbox', { name: 'Quantity' }), { target: { value: v } })
}

// The harvest-log "preserve this?" trigger sends all three — this is the shape the PRIMARY entry
// path actually arrives with, not the single-field convenience prefill.
const HARVEST_PREFILL = { crop_type_slug: 'tomato', plant_id: 'p-1', harvest_log_id: 'h-1' }

const flush = () => new Promise((r) => setTimeout(r, 0))

// Mirrors registerSW.test.js makeEnv (via EventNew.reloadGateWire.test.jsx), with a prior
// controller so controllerchange counts as an UPDATE (the reload path), not a first install.
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
  fetchMock.mockReset(); uploadMock.mockReset(); overlayDirtySpy.mockReset(); wire()
  sessionStorage.clear()
  clearReloadBlocks()
})
afterEach(() => { vi.useRealTimers() })

describe('PutUp — draft stash (V4-RELOADGATEWIRE-001)', () => {
  it('does NOT persist a pristine form', async () => {
    renderFullPage()
    openLogForm()
    await screen.findByRole('combobox', { name: 'Crop' })
    expect(readStash()).toBeNull()
  })

  it('persists a dirty form (a crop pick alone, no typed text)', async () => {
    renderFullPage()
    openLogForm()
    fireEvent.change(screen.getByRole('combobox', { name: 'Crop' }), { target: { value: 'tomato' } })
    await waitFor(() => expect(readStash()?.cropSlug).toBe('tomato'))
  })

  it('restores a stashed draft on mount (no prefill)', async () => {
    seedStash({ cropSlug: 'pepper', qtyValue: '7' })
    renderFullPage()
    openLogForm()
    const cropSelect = await screen.findByRole('combobox', { name: 'Crop' })
    await waitFor(() => expect(cropSelect.value).toBe('pepper'))
    expect(screen.getByRole('textbox', { name: 'Quantity' }).value).toBe('7')
  })

  it('clears the stash on a successful submit', async () => {
    renderFullPage({ crop_type_slug: 'tomato' }) // prefill -> lands directly on the log form
    typeQty('3')
    await waitFor(() => expect(readStash()?.qtyValue).toBe('3'))
    fireEvent.click(screen.getByRole('button', { name: 'Save put-up' }))
    await waitFor(() => expect(lastPost()).not.toBeNull())
    await screen.findByText(/Now in/i)
    expect(readStash()).toBeNull()
  })

  // BLOCKER-3, the data defect. resetForNext() deliberately carries crop/method/storage/unit/
  // use-by/source forward, so the BROAD stash predicate is still satisfied the instant the "Log
  // another" form renders — and the persist effect re-fired and RESURRECTED the draft that
  // handleSubmit's clearDraft had just removed. The user's next mount then restored a spent draft.
  it('a successful submit followed by "Log another" leaves the stash CLEARED', async () => {
    renderFullPage({ crop_type_slug: 'tomato' })
    typeQty('3')
    await waitFor(() => expect(readStash()?.qtyValue).toBe('3'))
    fireEvent.click(screen.getByRole('button', { name: 'Save put-up' }))
    await screen.findByText(/Now in/i)
    expect(readStash()).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Log another' }))
    await screen.findByRole('combobox', { name: 'Crop' })
    await act(async () => { await flush() })
    expect(readStash()).toBeNull()
  })

  // ...and the stash must still WORK afterwards, or the fix above would just be a permanent
  // disable dressed up as a guard.
  it('typing into the "Log another" form starts a fresh draft', async () => {
    renderFullPage({ crop_type_slug: 'tomato' })
    typeQty('3')
    fireEvent.click(screen.getByRole('button', { name: 'Save put-up' }))
    await screen.findByText(/Now in/i)
    fireEvent.click(screen.getByRole('button', { name: 'Log another' }))
    await screen.findByRole('combobox', { name: 'Crop' })
    typeQty('8')
    await waitFor(() => expect(readStash()?.qtyValue).toBe('8'))
  })

  // The precedence rule mirrored from EventNew's hasSeed / LogMany's seedProject|seedLocation: an
  // explicit fresh navigation (here, a harvest-triggered "preserve this?" prefill) must win over an
  // unrelated stale draft left by an earlier session — never silently swap the user's attribution.
  it('a harvest-triggered prefill is NOT clobbered by an unrelated stashed draft', async () => {
    seedStash({ cropSlug: 'pepper', qtyValue: '99', notes: 'unrelated old draft' })
    renderFullPage({ crop_type_slug: 'tomato' })
    const cropSelect = await screen.findByRole('combobox', { name: 'Crop' })
    expect(cropSelect.value).toBe('tomato')
    expect(screen.getByRole('textbox', { name: 'Quantity' }).value).toBe('')
  })
})

describe('PutUp — the guard predicate does not arm on state the user never entered', () => {
  // BLOCKER-2. `/put-up` is overlayable, and the harvest-log "preserve this?" trigger is the
  // PRIMARY way this form is reached. Counting the prefilled crop/planting/harvest link meant the
  // SW reload was deferred and the backdrop tap was dead before a single keystroke.
  it('a PRISTINE prefilled mount (the primary entry path) arms neither guard', async () => {
    renderFullPage({ crop_type_slug: 'tomato' })
    await screen.findByRole('combobox', { name: 'Crop' })
    expect(isReloadBlocked()).toBe(false)
    expect(overlayDirtySpy).not.toHaveBeenCalledWith(true)
  })

  it('a PRISTINE mount carrying the full harvest triple arms neither guard', async () => {
    renderFullPage(HARVEST_PREFILL)
    await screen.findByRole('combobox', { name: 'Crop' })
    expect(isReloadBlocked()).toBe(false)
    expect(overlayDirtySpy).not.toHaveBeenCalledWith(true)
  })

  it('the pristine prefilled overlay still dismisses on a backdrop tap', async () => {
    renderInOverlay({ crop_type_slug: 'tomato' })
    await screen.findByRole('combobox', { name: 'Crop' })
    fireEvent.click(backdrop())
    expect(screen.getByTestId('loc').textContent).toBe('/today')
  })

  // The success screen has no typeable field and handleSubmit already cleared the draft — a held
  // gate there is a wedged update for nothing.
  it('the post-save success screen arms neither guard', async () => {
    renderFullPage({ crop_type_slug: 'tomato' })
    typeQty('3')
    expect(isReloadBlocked()).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Save put-up' }))
    await screen.findByText(/Now in/i)
    expect(isReloadBlocked()).toBe(false)
    expect(overlayDirtySpy).toHaveBeenLastCalledWith(false)
  })

  it('the "Log another" form arms neither guard until something new is entered', async () => {
    renderFullPage({ crop_type_slug: 'tomato' })
    typeQty('3')
    fireEvent.click(screen.getByRole('button', { name: 'Save put-up' }))
    await screen.findByText(/Now in/i)
    fireEvent.click(screen.getByRole('button', { name: 'Log another' }))
    await screen.findByRole('combobox', { name: 'Crop' })
    expect(isReloadBlocked()).toBe(false)
    typeQty('8')
    expect(isReloadBlocked()).toBe(true)
  })

  // A bare crop pick is EXCLUDED from the guard predicate on purpose: it is fully restorable from
  // the draft stash (asserted above) and resetForNext() carries it forward, so counting it would
  // pin both guards on for the rest of the session after the first save. This is the negative
  // control for that decision — if someone re-widens the predicate, this fails and says why.
  it('a bare crop pick stashes but does NOT arm the guards (recoverable, and carried forward)', async () => {
    renderFullPage()
    openLogForm()
    const cropSelect = await screen.findByRole('combobox', { name: 'Crop' })
    fireEvent.change(cropSelect, { target: { value: 'tomato' } })
    await waitFor(() => expect(readStash()?.cropSlug).toBe('tomato'))
    expect(isReloadBlocked()).toBe(false)
    expect(overlayDirtySpy).not.toHaveBeenCalledWith(true)
  })

  // The put-up date defaults to "today", and `dirty` compared it against a freshly-computed
  // todayYMD() during render. A form left open across midnight therefore went dirty with no user
  // action and armed both guards — on the phone left on the counter overnight.
  it('crossing midnight with the form untouched arms neither guard', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-18T23:59:00'))
    renderFullPage()
    openLogForm()
    await screen.findByRole('combobox', { name: 'Crop' })
    expect(isReloadBlocked()).toBe(false)

    vi.setSystemTime(new Date('2026-08-19T00:01:00'))
    // Any re-render re-evaluates the predicate; the disclosure toggle is excluded from BOTH
    // predicates, so it changes nothing but the render pass.
    fireEvent.click(screen.getByRole('button', { name: /More/i }))
    expect(isReloadBlocked()).toBe(false)
    expect(overlayDirtySpy).not.toHaveBeenCalledWith(true)
    expect(readStash()).toBeNull()
  })
})

describe('PutUp — reloadGate + overlay-dirty wiring on the SAME predicate', () => {
  it('a pristine mount does not hold the reload gate', async () => {
    renderFullPage()
    openLogForm()
    await screen.findByRole('combobox', { name: 'Crop' })
    expect(isReloadBlocked()).toBe(false)
  })

  it('a typed quantity holds the reload gate; clearing it back to pristine releases the hold', async () => {
    renderFullPage()
    openLogForm()
    await screen.findByRole('combobox', { name: 'Crop' })
    typeQty('4')
    expect(isReloadBlocked()).toBe(true)
    typeQty('')
    expect(isReloadBlocked()).toBe(false)
  })

  it('unmounting a dirty form releases the reload-gate hold (never wedge updates)', async () => {
    const { unmount } = renderFullPage()
    openLogForm()
    typeQty('5')
    expect(isReloadBlocked()).toBe(true)
    unmount()
    expect(isReloadBlocked()).toBe(false)
  })

  // THE PROOF the task asks for: the identical action fires BOTH guard hooks off the identical
  // predicate — a typed quantity blocks the reload gate AND locks the Sheet backdrop in the same
  // breath, and a clean form does neither.
  it('the same typed quantity that holds the reload gate also locks the Sheet backdrop', async () => {
    renderInOverlay()
    openLogForm()
    typeQty('4')
    expect(isReloadBlocked()).toBe(true)
    fireEvent.click(backdrop())
    // Dirty -> the backdrop tap no-ops (still on /put-up, never reached the /today dismiss).
    expect(screen.getByTestId('loc').textContent).toBe('/put-up')
  })

  it('a clean form lets the backdrop tap dismiss (baseline — the guard is not permanently on)', async () => {
    renderInOverlay()
    openLogForm()
    fireEvent.click(backdrop())
    expect(screen.getByTestId('loc').textContent).toBe('/today')
  })
})

// Ported from EventNew.reloadGateWire.test.jsx: real registerSW, real reloadGate, real PutUp,
// nothing mocked between them. Unit tests on either half stay green while the two are unconnected,
// which is the whole reason that row existed — PutUp had no equivalent until now.
describe('PutUp ↔ registerSW end to end', () => {
  it('a dirty form DEFERS the SW reload, and unmount lets it fire exactly once', async () => {
    const env = makeSwEnv()
    const teardown = registerServiceWorker(env)
    await flush()

    const { unmount } = renderFullPage({ crop_type_slug: 'tomato' })
    typeQty('6')

    // A deploy lands mid-form. Without the hold this reloaded and took the quantity with it.
    env.sw.dispatchEvent(new Event('controllerchange'))
    expect(env.reload).not.toHaveBeenCalled()

    // Deferred, NOT cancelled: the moment the form is gone, the pending reload lands.
    unmount()
    expect(env.reload).toHaveBeenCalledTimes(1)
    teardown()
  })

  it('with nothing dirty, a controllerchange still reloads immediately (gate is not a disarm)', async () => {
    const env = makeSwEnv()
    const teardown = registerServiceWorker(env)
    await flush()

    renderFullPage()
    openLogForm()
    await screen.findByRole('combobox', { name: 'Crop' })
    env.sw.dispatchEvent(new Event('controllerchange'))
    expect(env.reload).toHaveBeenCalledTimes(1)
    teardown()
  })

  // The BLOCKER-2 consequence stated as the user actually meets it: arriving from a harvest, a
  // deploy that lands before you type must still install. Holding there deferred every update for
  // a form the user had not touched.
  it('a pristine harvest-triggered mount does NOT defer a deploy reload', async () => {
    const env = makeSwEnv()
    const teardown = registerServiceWorker(env)
    await flush()

    renderFullPage(HARVEST_PREFILL)
    await screen.findByRole('combobox', { name: 'Crop' })
    env.sw.dispatchEvent(new Event('controllerchange'))
    expect(env.reload).toHaveBeenCalledTimes(1)
    teardown()
  })

  // The post-save mirror of the case above: a saved form must let a deferred deploy land rather
  // than hold the gate for the rest of the session.
  it('a save RELEASES a reload deferred mid-form', async () => {
    const env = makeSwEnv()
    const teardown = registerServiceWorker(env)
    await flush()

    renderFullPage({ crop_type_slug: 'tomato' })
    typeQty('6')
    env.sw.dispatchEvent(new Event('controllerchange'))
    expect(env.reload).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Save put-up' }))
    await screen.findByText(/Now in/i)
    expect(env.reload).toHaveBeenCalledTimes(1)
    teardown()
  })
})
