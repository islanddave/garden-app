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

// popstate needs >0ms to settle in jsdom; 50ms is the figure BackNav.history.test.jsx measured.
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 50)) })
const esc = () => act(() => { fireEvent.keyDown(document, { key: 'Escape' }) })
const backGesture = async () => { act(() => { window.history.back() }); await settle() }

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
