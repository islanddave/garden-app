// V4-SHEETBUSY-001 — the Edit fly-up (V4-EDITINPLACE-001) must not be dismissable mid-save.
//
// THE GAP THIS PINS. That commit rendered PlantingEditor in a <Sheet> and passed `dirty`, which
// reads as full dismissal coverage but is not: `dirty` gates the BACKDROP TAP ALONE (Sheet.jsx:168),
// and `confirmOnDirty` is still false at BOTH registry call sites (DismissRegistry.jsx:126 for
// Escape, :228 for Back) pending a ConfirmSheet primitive that does not exist. So Escape and Android
// hardware Back closed a form with a PUT already on the wire. Because closing unmounts the editor,
// the failure path was the real harm: `setErr` had nothing left to render, so a save that did NOT
// happen looked exactly like one that did. Dave is Android-only, so Back is the primary gesture.
//
// WHY THE PROVIDER IS REAL HERE AND NOWHERE ELSE IN THE PlantingDetail FILES. PlantingDetail.test.jsx
// renders no DismissRegistryProvider, so `registered` is false and Sheet falls back to its own
// per-instance Escape handler (Sheet.jsx:123-126) — which closes unconditionally, consulting neither
// dirty nor busy. An Escape assertion written in that harness would fail for the wrong reason and,
// worse, could never pass. App.jsx:381 wraps the app in the provider, so THAT is the shape under
// test. Feature flags are deliberately NOT mocked: DISMISS_REGISTRY_ENABLED and BACKNAV_ENABLED are
// both `true` in featureFlags.js, and if either is ever flipped this guard genuinely stops working —
// a red test is the correct outcome, not something to paper over with a mock.
//
// NON-VACUITY. `busy` and `dirty` are both true during the ordinary save of a form the user typed
// into, so a naive test would pass on the dirty guard alone and keep passing after the busy wiring
// was ripped out. Every assertion below therefore submits an UNTOUCHED form — reachable, because
// Save is never disabled on a pristine edit — and asserts `isReloadBlocked() === false` at the
// moment of the dismissal attempt, which is this page's live read of `editing && editorDirty`
// (PlantingDetail.jsx:149). Dirty is proven absent; only busy can be doing the blocking.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, waitFor, fireEvent, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const { apiFetchSpy } = vi.hoisted(() => ({ apiFetchSpy: vi.fn() }))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: apiFetchSpy, getToken: vi.fn() }),
}))
vi.mock('../lib/uxEvents.js', () => ({
  FLOWS: { OPEN_PLANTING: 'open_planting' },
  useUxFlow: () => ({ step: vi.fn(), tap: vi.fn(), complete: vi.fn(), reset: vi.fn() }),
}))
vi.mock('../components/FavoriteToggle.jsx', () => ({ default: () => null }))
vi.mock('../lib/harvestWindows.js', () => import('./helpers/harvestWindowsSyncStub.js'))

import PlantingDetail from '../pages/PlantingDetail.jsx'
import { DismissRegistryProvider } from '../context/DismissRegistry.jsx'
import { isReloadBlocked, clearReloadBlocks } from '../lib/reloadGate.js'
import { readMarker } from '../lib/backNav.js'

const PLANTING = {
  id: 'pl1', name: 'Megatron Jalapeno', project_id: 'proj1', project_name: 'Peppers 2026',
  status: 'fruiting', quantity: 3, qty_initial: 6,
  sown_at: '2026-02-01', transplanted_at: '2026-04-15',
  variety_ref: { name: 'Megatron F4', species: 'Capsicum annuum' },
  location_path: 'Greenhouse / Bed 2', notes: 'Hot one',
  featured_photo_view_url: null,
}

// Wait for the traversal to LAND, not for a slice of wall clock. The 50ms this used to sleep was
// BackNav.history.test.jsx's idle-machine figure; under a parallel suite the popstate task has not
// run yet when it expires, and this file then queries a sheet that has not closed — surfacing as
// `Expected container to be an Element ... but got null`, which reads like a real regression.
// Measured under load: a real traversal lands in <=128ms, so NET_MS is a net, not the wait.
const NET_MS = 2000
let pops = 0
window.addEventListener('popstate', () => { pops += 1 })
const settle = (from = pops) => act(async () => {
  const deadline = Date.now() + NET_MS
  while (pops === from && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2))
  await new Promise((r) => setTimeout(r, 0))
})
const esc = () => act(() => { fireEvent.keyDown(document, { key: 'Escape' }) })
const backGesture = async () => { const from = pops; act(() => { window.history.back() }); await settle(from) }

// A floor entry so back() is never called at history index 0, where jsdom makes it a SILENT no-op —
// which would false-PASS "the sheet stayed open" for entirely the wrong reason.
const SENTINEL = { __floor: 1 }
const armed = () => !!readMarker(window.history.state)

// Resolvers for the in-flight write, so it can be held open across a dismissal attempt.
let rejectSave
let resolveDelete

function primeWithHangingSave() {
  apiFetchSpy.mockImplementation((path, opts) => {
    if (path === '/api/plants/pl1' && opts?.method === 'PUT') {
      return new Promise((_res, rej) => { rejectSave = () => rej(Object.assign(new Error('nope'), { status: 500 })) })
    }
    if (path.startsWith('/api/plants?')) return Promise.resolve([PLANTING])
    if (path.startsWith('/api/plants/')) return Promise.resolve(PLANTING)
    if (path.startsWith('/api/events')) return Promise.resolve([])
    return Promise.resolve(null)
  })
}

function primeWithHangingDelete() {
  apiFetchSpy.mockImplementation((path, opts) => {
    if (path === '/api/plants/pl1' && opts?.method === 'DELETE') {
      return new Promise((res) => { resolveDelete = () => res({ ok: true }) })
    }
    if (path.startsWith('/api/plants?')) return Promise.resolve([PLANTING])
    if (path.startsWith('/api/plants/')) return Promise.resolve(PLANTING)
    if (path.startsWith('/api/events')) return Promise.resolve([])
    return Promise.resolve(null)
  })
}

function renderPage() {
  return render(
    <DismissRegistryProvider>
      <MemoryRouter initialEntries={['/projects/proj1/plantings/pl1']}>
        <Routes>
          <Route path="/projects/:id/plantings/:plantingId" element={<PlantingDetail />} />
          <Route path="/garden" element={<div>GARDEN PAGE</div>} />
        </Routes>
      </MemoryRouter>
    </DismissRegistryProvider>,
  )
}

const sheet = () => screen.queryByRole('dialog', { name: 'Edit planting' })

// Open the editor and put a save on the wire WITHOUT touching a field, so dirty stays false.
async function openEditorAndStartSave() {
  await screen.findByRole('heading', { name: 'Megatron Jalapeno' })
  await act(async () => { fireEvent.click(screen.getByLabelText('Edit this planting')) })
  await waitFor(() => expect(screen.getByText('Edit Megatron Jalapeno')).toBeTruthy())
  const panel = sheet()
  expect(panel).toBeTruthy()
  await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: 'Save' })) })
  // The save is now hanging. Both preconditions, asserted rather than assumed.
  await waitFor(() => expect(within(sheet()).getByText('Saving…')).toBeTruthy())
  expect(isReloadBlocked()).toBe(false)   // pristine form => editorDirty is FALSE. Only busy is live.
}

beforeEach(() => {
  apiFetchSpy.mockReset()
  rejectSave = null
  resolveDelete = null
  window.scrollTo = vi.fn()
  clearReloadBlocks()
  window.history.replaceState(SENTINEL, '')
})
afterEach(() => { document.body.style.overflow = ''; document.body.style.overscrollBehavior = '' })

describe('PlantingDetail — V4-SHEETBUSY-001: the Edit fly-up resists dismissal while a save is in flight', () => {
  it('Escape does NOT close the fly-up mid-save, and DOES once the save has resolved', async () => {
    primeWithHangingSave()
    renderPage()
    await openEditorAndStartSave()

    esc()
    expect(sheet()).toBeTruthy()          // blocked: the write is still on the wire

    // Resolve the save as a FAILURE — the case that made this a correctness bug rather than polish.
    // The editor must still be mounted to report it.
    await act(async () => { rejectSave(); await Promise.resolve() })
    await waitFor(() => expect(within(sheet()).queryByText('Saving…')).toBeNull())
    expect(sheet()).toBeTruthy()          // a failed save leaves the form up, error visible

    esc()
    await waitFor(() => expect(sheet()).toBeNull())   // idle again: dismissal permitted
  })

  it('a backdrop tap does NOT close the fly-up mid-save, and DOES once the save has resolved', async () => {
    primeWithHangingSave()
    const { container } = renderPage()
    await openEditorAndStartSave()

    // The backdrop is the first position:fixed div Sheet renders (Sheet.jsx:174-177).
    const backdrop = () => container.querySelector('div[style*="position: fixed"]')
    act(() => { fireEvent.click(backdrop()) })
    expect(sheet()).toBeTruthy()

    await act(async () => { rejectSave(); await Promise.resolve() })
    await waitFor(() => expect(within(sheet()).queryByText('Saving…')).toBeNull())

    act(() => { fireEvent.click(backdrop()) })
    await waitFor(() => expect(sheet()).toBeNull())
  })

  it('Android hardware Back does NOT close the fly-up mid-save, and DOES once the save has resolved', async () => {
    primeWithHangingSave()
    renderPage()
    await openEditorAndStartSave()

    // SELF-TEST: the Sheet carries armsBack, so the provider must have pushed a marker. Without
    // one, back() would walk off the floor entry and every assertion below would be vacuous.
    expect(armed()).toBe(true)

    await backGesture()
    expect(sheet()).toBeTruthy()          // BLOCKED, and the provider re-armed to undo the traversal
    expect(armed()).toBe(true)

    await act(async () => { rejectSave(); await Promise.resolve() })
    await waitFor(() => expect(within(sheet()).queryByText('Saving…')).toBeNull())

    await backGesture()
    await waitFor(() => expect(sheet()).toBeNull())
  })

  // The destructive sibling. `busy` is fed by saving || deleting || archiving, not `saving` alone:
  // a guard that held Back mid-save but let it through mid-DELETE would be incoherent, and this is
  // the assertion that keeps the other two terms from being quietly narrowed away later.
  it('Escape does NOT close the fly-up while a Remove is in flight, and the delete still completes', async () => {
    primeWithHangingDelete()
    renderPage()
    await screen.findByRole('heading', { name: 'Megatron Jalapeno' })
    await act(async () => { fireEvent.click(screen.getByLabelText('Edit this planting')) })
    await waitFor(() => expect(screen.getByText('Edit Megatron Jalapeno')).toBeTruthy())
    await act(async () => { fireEvent.click(within(sheet()).getByRole('button', { name: 'Remove' })) })
    await waitFor(() => expect(within(sheet()).getByText('Removing…')).toBeTruthy())
    expect(isReloadBlocked()).toBe(false)   // untouched form => dirty absent; only busy can block

    esc()
    expect(sheet()).toBeTruthy()

    // Not merely blocked — the write it was protecting runs to completion and the page moves on.
    await act(async () => { resolveDelete(); await Promise.resolve() })
    await waitFor(() => expect(screen.getByText('GARDEN PAGE')).toBeTruthy())
  })
})

// ── BUG-DIRTYDISMISSGAP-001 — the DIRTY term, which `busy` above does not cover ─────────────────
//
// Sibling to the suite above: same root gap, other side of it. That one pins that a form with a
// WRITE ON THE WIRE resists dismissal (`busy`). This pins that a form with TYPING IN IT does too.
//
// REWRITTEN when the real fix landed. These tests used to assert on a `window.confirm` spy, because
// the guard was a per-surface `requestCloseEditor` patch in this page. That patch is DELETED and the
// registry now owns the confirm (`confirmOnDirty` on the Sheet → the provider raises ConfirmSheet),
// so the assertions moved to the ConfirmSheet surface — AND every one of them additionally asserts
// `window.confirm` was NOT called. That second half is not decoration: with both mechanisms live a
// test spying on window.confirm keeps passing while ConfirmSheet is entirely broken, so the two must
// be held apart or the guard is unfalsifiable. One mechanism, one place to break.
//
// WHY THIS SURFACE. Recovery is not uniform: EventNew carries a full draftStash so a discarded /log
// overlay restores, SowNow stashes an inventory id. PlantingEditor has NO draft stash, so what is
// typed here is simply gone. Dave is Android-only, so Back — not Escape — is the gesture that fires
// this in practice, and it gets its own assertions: Escape goes through decideDismiss and Back
// through decideBack, DIFFERENT call sites, so one passing proves nothing about the other.
//
// The editor's own Cancel and its post-save close keep plain closeEditor, because a save that
// SUCCEEDED must never ask to discard.
describe('PlantingDetail — BUG-DIRTYDISMISSGAP-001: a DIRTY Edit fly-up is not discarded silently', () => {
  const confirmUi = () => screen.queryByTestId('confirm-sheet')
  const discard = () => screen.getByTestId('confirm-sheet-confirm')
  const keepEditing = () => screen.getByTestId('confirm-sheet-cancel')

  // primeWithHangingSave serves the planting rows; its hang is on PUT, which nothing here fires.
  async function openEditorAndType(value = 'Renamed In Progress') {
    await screen.findByRole('heading', { name: 'Megatron Jalapeno' })
    await act(async () => { fireEvent.click(screen.getByLabelText('Edit this planting')) })
    await waitFor(() => expect(screen.getByText('Edit Megatron Jalapeno')).toBeTruthy())
    fireEvent.change(within(sheet()).getByLabelText(/Name/i), { target: { value } })
    // Precondition ASSERTED, not assumed — isReloadBlocked is the page's own read of editorDirty,
    // and it is what the sibling suite uses to prove its own forms are pristine.
    await waitFor(() => expect(isReloadBlocked()).toBe(true))
    // The other half of the same precondition: no write on the wire, so `busy` cannot be what keeps
    // the sheet up. Without this the BLOCKED branch (checked AHEAD of CONFIRM) is a second
    // suppression mechanism and the assertions below would pass with the confirm path dead.
    expect(within(sheet()).queryByText('Saving…')).toBeNull()
  }

  it('Escape on a dirty form asks, and declining keeps BOTH the sheet and the typing', async () => {
    primeWithHangingSave()
    renderPage()
    await openEditorAndType()
    const confirmSpy = vi.spyOn(window, 'confirm')
    await esc()
    await waitFor(() => expect(confirmUi()).toBeTruthy())
    expect(confirmSpy).not.toHaveBeenCalled()   // the deleted patch must stay deleted
    expect(sheet()).toBeTruthy()

    await act(async () => { fireEvent.click(keepEditing()) })
    expect(confirmUi()).toBeNull()
    expect(sheet()).toBeTruthy()
    // The characters, not just the sheet — losing the sheet is recoverable, losing these is not.
    expect(within(sheet()).getByLabelText(/Name/i).value).toBe('Renamed In Progress')
    confirmSpy.mockRestore()
  })

  it('Android hardware Back on a dirty form asks, keeps the sheet, and RE-ARMS', async () => {
    // Back routes through decideBack, a DIFFERENT registry call site from Escape's decideDismiss,
    // so one passing does not imply the other — which is exactly how the busy gap shipped half
    // covered. This is also the gesture Dave actually uses.
    primeWithHangingSave()
    renderPage()
    await openEditorAndType()
    expect(armed()).toBe(true)                       // SELF-TEST: back() will reach the arbiter
    expect(window.history.state.__floor).toBe(1)     // SELF-TEST: not at index 0, where back() is silent
    const confirmSpy = vi.spyOn(window, 'confirm')

    await backGesture()
    expect(confirmUi()).toBeTruthy()
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(sheet()).toBeTruthy()
    // THE MARKER. Back consumed it before the decision; the provider must push a fresh one, or the
    // user's next Back exits the installed PWA with a half-edited form still open.
    expect(armed()).toBe(true)

    // And it genuinely still works: a second Back lands on the confirm (SYSTEM outranks the sheet)
    // and closes it, leaving the sheet and the typing intact.
    await backGesture()
    expect(confirmUi()).toBeNull()
    expect(sheet()).toBeTruthy()
    expect(within(sheet()).getByLabelText(/Name/i).value).toBe('Renamed In Progress')
    confirmSpy.mockRestore()
  })

  it('the labelled Close on a dirty form asks too — the most discoverable exit is not a hole', async () => {
    primeWithHangingSave()
    renderPage()
    await openEditorAndType()
    await act(async () => { fireEvent.click(within(sheet()).getByRole('button', { name: 'Close' })) })
    expect(confirmUi()).toBeTruthy()
    expect(sheet()).toBeTruthy()
  })

  it('accepting DOES discard — the guard must not be a trap', async () => {
    primeWithHangingSave()
    renderPage()
    await openEditorAndType()
    await esc()
    await waitFor(() => expect(confirmUi()).toBeTruthy())
    await act(async () => { fireEvent.click(discard()) })
    await waitFor(() => expect(sheet()).toBeNull())
    expect(confirmUi()).toBeNull()
  })

  it('a PRISTINE form closes on Escape with NO question — no nag on an untouched sheet', async () => {
    primeWithHangingSave()
    renderPage()
    await screen.findByRole('heading', { name: 'Megatron Jalapeno' })
    await act(async () => { fireEvent.click(screen.getByLabelText('Edit this planting')) })
    await waitFor(() => expect(sheet()).toBeTruthy())
    await esc()
    await waitFor(() => expect(sheet()).toBeNull())
    expect(confirmUi()).toBeNull()
  })

  it('a PRISTINE form closes on Back with NO question', async () => {
    primeWithHangingSave()
    renderPage()
    await screen.findByRole('heading', { name: 'Megatron Jalapeno' })
    await act(async () => { fireEvent.click(screen.getByLabelText('Edit this planting')) })
    await waitFor(() => expect(sheet()).toBeTruthy())
    expect(armed()).toBe(true)
    await backGesture()
    await waitFor(() => expect(sheet()).toBeNull())
    expect(confirmUi()).toBeNull()
  })
})
