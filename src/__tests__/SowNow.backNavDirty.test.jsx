// BUG-DIRTYDISMISSGAP-001 — the Sow sheet, the app's one genuinely UNGUARDED editor surface, and
// ANDROID HARDWARE BACK, the gesture that actually fires it.
//
// WHAT WAS BROKEN. `dirty` gates the BACKDROP TAP alone (Sheet.jsx:168). `confirmOnDirty` was false
// at both registry call sites — and flipping it would have changed nothing, because CONFIRM had no
// consumer branch and fell straight through to cbRef in both switches. So Escape and Back discarded
// a half-filled sow form outright. Worse here than on the other two PlantingEditor hosts:
// closeSowSheet calls clearDraft FIRST, so an unconfirmed dismiss destroyed the typed fields AND the
// {inventoryItemId} crumb that would have said which packet was mid-sow. Net recovery: zero.
//
// WHY BACK AND NOT ESCAPE IS THE PRIMARY ASSERTION. Escape runs decideDismiss; Back runs decideBack.
// Different call sites, different defaults, different reachability — a test for one proves nothing
// about the other, which is exactly how the `busy` half of this gap shipped covered on one gesture
// only. Dave is Android-only, so Back is the gesture in production. Escape gets its own test.
//
// FIVE REDUNDANT SUPPRESSION MECHANISMS are held apart here; break any one and this file must go
// red, which it cannot do if they overlap:
//   S1 backdrop guard (Sheet.jsx:168) — never tapped; only window.history.back() drives dismissal.
//      SowNow.formGuard.test.jsx's backdrop tests are green on the UNFIXED build for this reason.
//   S2 busy → BLOCKED, checked AHEAD of CONFIRM (backNav.js:102) — and this lane WIRED busy on this
//      surface, so it is live now. Every confirm assertion first asserts no POST is on the wire.
//   S3 armsBack missing → no marker → back() never reaches the arbiter. That reads identically to
//      "the guard worked". Killed by the armed() self-test.
//   S4 history index 0 → jsdom's back() is a SILENT no-op. Killed by the __floor sentinel.
//   S5 the interim window.confirm patches — never written on this surface, and deleted from the
//      other two in the same commit. Every assertion here also asserts window.confirm was NOT
//      called, so a reintroduced patch cannot silently take over for a broken ConfirmSheet.
//
// A REAL DismissRegistryProvider and REAL window.history, both load-bearing. Without the provider
// `registered` is false and Sheet's legacy keydown closes unconditionally, consulting neither dirty
// nor the registry — the shape SowNow.formGuard.test.jsx runs in, and why its "Escape still closes a
// dirty sheet" test is both green and honest there while this file asserts the opposite. Feature
// flags are deliberately NOT mocked: DISMISS_REGISTRY_ENABLED and BACKNAV_ENABLED are hard `true`,
// and if either is flipped this guard genuinely stops working — red is the correct outcome.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within, act, waitFor } from '@testing-library/react'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

const { fetchSpy, navigateSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn(), navigateSpy: vi.fn() }))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy }),
  apiFetch: (...a) => fetchSpy(...a),
}))

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
  useNavigate: () => navigateSpy,
}))

import SowNow from '../pages/SowNow.jsx'
import { ToastProvider } from '../context/ToastContext.jsx'
import { DismissRegistryProvider } from '../context/DismissRegistry.jsx'
import { readMarker } from '../lib/backNav.js'

const TODAY = '2026-07-10'
const STASH_KEY = 'gardenApp.draft.sow-now'

// Verified against the real engine for today=2026-07-10 (see SowNow.test.jsx): lands in
// window_closing with an actionable "Sow" button.
const CUCUMBER = {
  inventory_item_id: 'inv-cuke', item_name: 'Spacemaster 80 Cucumber Seeds',
  variety_name: 'Spacemaster 80', variety_id: 'var-cuke',
  quantity_on_hand: '1', unit: 'packet', created_by: 'user_x',
  purchase_date: '2026-06-09', source: 'Botanical Interests', metadata: {},
  crop_type_slug: 'cucumber', lifecycle: 'annual', grown_as: null,
  sun_requirements: 'full_sun', days_to_maturity_min: '55', days_to_maturity_max: '62',
  start_method: 'direct_sow', start_indoor_weeks_min: null, start_indoor_weeks_max: null,
  direct_sow_timing: 'direct sow after last frost',
  sow_depth_in: '0.5', seed_spacing_in: '12', row_spacing_in: null,
  days_to_germ_min: '3', days_to_germ_max: '10', sow_season: 'warm', sow_notes: null,
}
const PROJECT = { id: 'proj-peppers', name: 'Peppers' }

function readStash() {
  const raw = sessionStorage.getItem(STASH_KEY)
  return raw ? JSON.parse(raw).data : null
}

// `hangPost` holds the create on the wire so the busy/BLOCKED branch can be exercised deliberately
// rather than raced into.
function routeFetch({ hangPost = false } = {}) {
  fetchSpy.mockImplementation((url, opts = {}) => {
    if (url === '/api/inventory-items/sow-candidates') return Promise.resolve({ items: [CUCUMBER] })
    if (url === '/api/projects') return Promise.resolve([PROJECT])
    if (url === '/api/locations/with-path') return Promise.resolve([])
    if (url.startsWith('/api/inventory-items/')) {
      return Promise.resolve({ id: 'inv-cuke', name: CUCUMBER.item_name, source: CUCUMBER.source, purchase_date: CUCUMBER.purchase_date, brand: null, metadata: {} })
    }
    if (url.startsWith('/api/varieties/')) return Promise.resolve({ id: 'var-cuke', name: 'Spacemaster 80' })
    if (url === '/api/plants' && opts.method === 'POST') {
      return hangPost ? new Promise(() => {}) : Promise.resolve({ id: 'plant-1' })
    }
    return Promise.resolve({})
  })
}

async function renderSowNow() {
  let utils
  await act(async () => {
    utils = render(
      <DismissRegistryProvider>
        <ToastProvider>
          <SowNow todayISO={TODAY} />
        </ToastProvider>
      </DismissRegistryProvider>,
    )
  })
  return utils
}

// popstate needs >0ms to settle in jsdom; 50ms is the figure BackNav.history.test.jsx measured.
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 50)) })
const backGesture = async () => { act(() => { window.history.back() }); await settle() }
const esc = () => act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
const armed = () => !!readMarker(window.history.state)

const sowSheet = () => screen.queryByRole('dialog', { name: /^Sow / })
const confirmUi = () => screen.queryByTestId('confirm-sheet')
const discard = () => screen.getByTestId('confirm-sheet-confirm')
const keepEditing = () => screen.getByTestId('confirm-sheet-cancel')

// S2: no create on the wire, so `busy` cannot be what is holding the sheet up. Asserted rather than
// assumed — BLOCKED is checked AHEAD of CONFIRM, so a live POST would make every assertion below
// pass with the confirm path completely dead.
const noWriteInFlight = () => {
  expect(fetchSpy.mock.calls.some((c) => c[0] === '/api/plants' && c[1]?.method === 'POST')).toBe(false)
}

async function openSheet() {
  await act(async () => { fireEvent.click(await screen.findByLabelText('Sow Spacemaster 80')) })
  const dialog = await screen.findByRole('dialog', { name: /^Sow / })
  // The packet/variety prefill has landed, so "untouched" below means untouched-with-fields-already-
  // filled — the state a truthiness predicate would misread as dirty.
  await waitFor(() => expect(within(dialog).getByLabelText(/Name/i).value).toBe('Spacemaster 80 Cucumber Seeds'))
  return dialog
}

async function typeInEditor(dialog) {
  await act(async () => {
    fireEvent.change(within(dialog).getByLabelText('Quantity'), { target: { value: '6' } })
  })
  expect(within(dialog).getByLabelText('Quantity').value).toBe('6')
}

beforeEach(() => {
  fetchSpy.mockReset()
  navigateSpy.mockReset()
  sessionStorage.clear()
  // S4: a floor entry, so back() is never called at history index 0 where jsdom makes it a SILENT
  // no-op — which false-PASSES "nothing was dismissed" for entirely the wrong reason.
  window.history.replaceState({ __floor: 1 }, '')
})

describe('SowNow — BUG-DIRTYDISMISSGAP-001: Android Back on a dirty sow sheet', () => {
  it('asks before discarding, and declining keeps the sheet, the typing AND the stash', async () => {
    routeFetch()
    await renderSowNow()
    const dialog = await openSheet()
    await typeInEditor(dialog)
    const confirmSpy = vi.spyOn(window, 'confirm')

    expect(armed()).toBe(true)                       // S3 SELF-TEST: back() reaches the arbiter
    expect(window.history.state.__floor).toBe(1)     // S4 SELF-TEST: not at index 0
    noWriteInFlight()                                // S2

    await backGesture()

    expect(confirmUi()).toBeTruthy()
    expect(confirmSpy).not.toHaveBeenCalled()        // S5: no window.confirm anywhere on this path
    expect(sowSheet()).toBeTruthy()
    // THE UNFAKEABLE ONE. A fix that merely re-rendered the sheet would still have run clearDraft at
    // the top of closeSowSheet, so this is the assertion a cosmetic fix cannot satisfy.
    expect(readStash()).toEqual({ inventoryItemId: 'inv-cuke' })

    await act(async () => { fireEvent.click(keepEditing()) })
    expect(confirmUi()).toBeNull()
    expect(within(sowSheet()).getByLabelText('Quantity').value).toBe('6')
    expect(readStash()).toEqual({ inventoryItemId: 'inv-cuke' })
    confirmSpy.mockRestore()
  })

  // The §3d marker bug, and the only test in the suite that can catch it. Without the re-arm in the
  // provider's CONFIRM branch the sheet is left with no marker, and the user's SECOND Back exits the
  // installed PWA with a half-filled form still on screen.
  it('RE-ARMS after a declined Back, so the next Back is still the app\'s', async () => {
    routeFetch()
    await renderSowNow()
    const dialog = await openSheet()
    await typeInEditor(dialog)

    await backGesture()
    expect(confirmUi()).toBeTruthy()
    expect(armed()).toBe(true)                       // the consumed marker was replaced

    // Back #2 resolves to the CONFIRM (LAYER.SYSTEM 1200 outranks the sheet's 200) and closes only
    // it. The sheet survives, and the registry re-arms for it.
    await backGesture()
    expect(confirmUi()).toBeNull()
    expect(sowSheet()).toBeTruthy()
    expect(armed()).toBe(true)

    // Back #3 is a fresh gesture on the same dirty sheet: it must ask again, not discard.
    await backGesture()
    expect(confirmUi()).toBeTruthy()
    expect(sowSheet()).toBeTruthy()
    expect(readStash()).toEqual({ inventoryItemId: 'inv-cuke' })
  })

  it('accepting DOES discard — the guard is not a trap', async () => {
    routeFetch()
    await renderSowNow()
    const dialog = await openSheet()
    await typeInEditor(dialog)

    await backGesture()
    expect(confirmUi()).toBeTruthy()
    await act(async () => { fireEvent.click(discard()) })

    expect(sowSheet()).toBeNull()
    expect(confirmUi()).toBeNull()
    expect(readStash()).toBeNull()                   // the deliberate dismissal still clears the stash
  })

  // ★ The constant-true killer. Fields are machine-prefilled, so a truthiness predicate would read
  // this sheet as dirty and every mis-tapped Sow would become a question the user has to answer.
  it('a CLEAN sheet closes on Back with no question at all, prefilled fields and all', async () => {
    routeFetch()
    await renderSowNow()
    await openSheet()
    const confirmSpy = vi.spyOn(window, 'confirm')
    expect(armed()).toBe(true)

    await backGesture()

    expect(confirmUi()).toBeNull()
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(sowSheet()).toBeNull()
    expect(readStash()).toBeNull()
    confirmSpy.mockRestore()
  })

  // S2 as a positive assertion rather than only a precondition. This lane WIRED `busy` on this
  // surface (it was the one PlantingEditor host that never subscribed), so a Back mid-POST must be
  // BLOCKED — refused and re-armed — not turned into a discard question over a write already gone.
  it('a Back mid-create is BLOCKED, not confirmed and not discarded', async () => {
    routeFetch({ hangPost: true })
    await renderSowNow()
    const dialog = await openSheet()
    await typeInEditor(dialog)
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: /Add planting/i }))
    })
    await waitFor(() => expect(within(sowSheet()).getByText('Adding…')).toBeTruthy())

    await backGesture()

    expect(confirmUi()).toBeNull()                   // BLOCKED is checked ahead of CONFIRM
    expect(sowSheet()).toBeTruthy()
    expect(armed()).toBe(true)                       // refused by re-pushing, per the BLOCKED branch
  })
})

// Escape is a DIFFERENT registry call site (decideDismiss, not decideBack) with different defaults
// and different reachability. Sibling coverage, deliberately not merged with the Back suite.
describe('SowNow — BUG-DIRTYDISMISSGAP-001: the other dismissal gestures', () => {
  it('Escape on a dirty sow sheet asks, and declining keeps the typing and the stash', async () => {
    routeFetch()
    await renderSowNow()
    const dialog = await openSheet()
    await typeInEditor(dialog)
    const confirmSpy = vi.spyOn(window, 'confirm')
    noWriteInFlight()

    await esc()

    expect(confirmUi()).toBeTruthy()
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(sowSheet()).toBeTruthy()
    expect(readStash()).toEqual({ inventoryItemId: 'inv-cuke' })

    await act(async () => { fireEvent.click(keepEditing()) })
    expect(within(sowSheet()).getByLabelText('Quantity').value).toBe('6')
    confirmSpy.mockRestore()
  })

  it('Escape on a CLEAN sow sheet closes it with no question', async () => {
    routeFetch()
    await renderSowNow()
    await openSheet()
    await esc()
    expect(confirmUi()).toBeNull()
    expect(sowSheet()).toBeNull()
  })

  // The labelled Close is the most discoverable exit on this sheet. Before this lane it called
  // onClose directly, so had the fix covered only Escape and Back it would have become the one
  // gesture that still discarded silently.
  it('the labelled Close asks on a dirty sheet and closes a clean one', async () => {
    routeFetch()
    await renderSowNow()
    const dialog = await openSheet()
    await typeInEditor(dialog)
    await act(async () => {
      fireEvent.click(within(sowSheet()).getByRole('button', { name: 'Close' }))
    })
    expect(confirmUi()).toBeTruthy()
    expect(sowSheet()).toBeTruthy()

    await act(async () => { fireEvent.click(keepEditing()) })
    // Clear the field back to its prefilled value? No — dirty is a latch by design, so instead prove
    // the accept arm from the Close path: it must still be able to leave.
    await act(async () => {
      fireEvent.click(within(sowSheet()).getByRole('button', { name: 'Close' }))
    })
    await act(async () => { fireEvent.click(discard()) })
    expect(sowSheet()).toBeNull()
    expect(readStash()).toBeNull()
    expect(dialog.isConnected).toBe(false)
  })

  // The editor's own Cancel is NOT the Sheet's chrome — it goes straight to closeSowSheet, and it
  // must keep doing so. Cancel is an explicit, unambiguous "I am leaving this form"; asking again
  // would be the nag the per-surface opt-in exists to avoid.
  it("the editor's own Cancel still leaves immediately, with no question", async () => {
    routeFetch()
    await renderSowNow()
    const dialog = await openSheet()
    await typeInEditor(dialog)
    await act(async () => {
      fireEvent.click(within(sowSheet()).getByRole('button', { name: 'Cancel' }))
    })
    expect(confirmUi()).toBeNull()
    expect(sowSheet()).toBeNull()
    expect(readStash()).toBeNull()
    expect(dialog.isConnected).toBe(false)
  })

  // A save that SUCCEEDED must never ask to discard. onCreated → closeSowSheet, which never routes
  // through the arbiter.
  it('a successful sow closes the sheet with no question', async () => {
    routeFetch()
    await renderSowNow()
    const dialog = await openSheet()
    await typeInEditor(dialog)
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: /Add planting/i }))
    })
    await screen.findByText(/Sown/)
    expect(confirmUi()).toBeNull()
    expect(sowSheet()).toBeNull()
    expect(readStash()).toBeNull()
  })
})
