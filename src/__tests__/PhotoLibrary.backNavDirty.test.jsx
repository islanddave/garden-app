// V4-DIRTYGUARDREST-001 — PhotoLibrary's tag modal, and ANDROID HARDWARE BACK.
//
// WHAT WAS BROKEN. The page computed `modalDirty` (V4-DIRTYGUARDSWEEP-001, for the reload gate) and
// never handed it to the arbiter, while PhotoModal registered `armsBack` — so Escape and Back BOTH
// reached this surface and both discarded a half-edited tag form outright: a re-pick of project,
// plant and location plus a retyped caption, gone on one gesture, with no stash to recover from. The
// backdrop tap was worse still: unlike <Sheet>, which no-ops a dirty backdrop, this one closed
// unconditionally. c0507f3 shipped the confirm mechanism and scoped itself to
// PlantingDetail/Garden/SowNow; this file covers the remainder on this surface.
//
// WHY BACK IS THE PRIMARY ASSERTION. Escape runs decideDismiss; Back runs decideBack. Different call
// sites, different defaults, different reachability. Dave is Android-only, so Back is the production
// gesture. Escape and the tap exits get their own block.
//
// THE SUPPRESSION MECHANISMS held apart here:
//   S1 `tagging` -> BLOCKED, checked AHEAD of CONFIRM (backNav.js:102). Every confirm assertion runs
//      with no PUT on the wire, asserted rather than assumed.
//   S2 armsBack -> no marker -> back() never reaches the arbiter, which reads exactly like a working
//      guard. It was already true on this surface, but PhotoDeleteConfirm and the share sheet can
//      also arm, so armed() is asserted before every gesture rather than trusted.
//   S3 history index 0 -> jsdom's back() is a SILENT no-op. Killed by the __floor sentinel.
//   S4 a reintroduced window.confirm patch. Asserted not-called on every confirm path.
//
// ★ THE PREDICATE IS THE RISK ON THIS SURFACE. Every field in this form is pre-seeded from the photo
// row, so a truthiness predicate would report dirty for any photo that already has a caption or a
// parent — turning a look-and-leave into a question on the app's most-browsed page. Two tests exist
// solely to kill a constant-true `dirty`: the untouched-but-prefilled case, and the revert case.
//
// A REAL DismissRegistryProvider and REAL window.history, both load-bearing. Feature flags are
// deliberately NOT mocked (unlike the sibling PhotoLibrary suites, which pin PROJECTS_HIDDEN for
// their own reasons): DISMISS_REGISTRY_ENABLED and BACKNAV_ENABLED are hard `true` in source, and if
// either is flipped this guard genuinely stops working — red is the correct outcome.
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }), apiFetch: (...a) => fetchSpy(...a) }))
vi.mock('../hooks/useUploadPhoto.js', () => ({
  useUploadPhoto: () => ({ upload: vi.fn(), isUploading: false, error: null, photo: null, preview: null, stage: null, progress: null, reset: vi.fn() }),
}))
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }) => <a href={typeof to === 'string' ? to : '#'} {...rest}>{children}</a>,
}))

import PhotoLibrary from '../pages/PhotoLibrary.jsx'
import { DismissRegistryProvider } from '../context/DismissRegistry.jsx'
import { readMarker } from '../lib/backNav.js'

const PROJECT  = { id: 'proj-1', name: 'Spring 2026' }
const LOCATION = { id: 'loc-1', full_path: 'Garden › Bed A', is_active: true }
// Location-parented and ALREADY CAPTIONED: passes the one-of gate without firing the modal's
// plants-for-project fetch, and seeds the form with real content so "untouched" below means
// untouched-with-fields-already-filled — the state a truthiness predicate would misread as dirty.
const PHOTO = {
  id: 'photo-1', caption: 'first true leaves', view_url: 'https://example/p.jpg',
  project_id: null, location_id: 'loc-1', plant_id: null, event_id: null,
}

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 50)) })
const backGesture = async () => { act(() => { window.history.back() }); await settle() }
const esc = () => act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
const armed = () => !!readMarker(window.history.state)

const modal = () => screen.queryByRole('dialog', { name: 'Photo details' })
const confirmUi = () => screen.queryByTestId('confirm-sheet')
const discard = () => screen.getByTestId('confirm-sheet-confirm')
const keepEditing = () => screen.getByTestId('confirm-sheet-cancel')
const captionInput = () => screen.getByPlaceholderText('What are you seeing?')

// S1: no tag PUT on the wire, so `busy` cannot be what is holding the modal up. BLOCKED is checked
// AHEAD of CONFIRM, so a live PUT would make every assertion below pass with the confirm path dead.
const noWriteInFlight = () => {
  expect(fetchSpy.mock.calls.some((c) => c[0] === `/api/photos/${PHOTO.id}` && c[1]?.method === 'PUT')).toBe(false)
}

function routeFetch({ hangPut = false } = {}) {
  fetchSpy.mockImplementation((url, opts = {}) => {
    if (url === '/api/projects') return Promise.resolve([PROJECT])
    if (url === '/api/locations/with-path') return Promise.resolve([LOCATION])
    if (url === '/api/photos') return Promise.resolve([PHOTO])
    if (url === `/api/photos/${PHOTO.id}` && opts.method === 'PUT') {
      return hangPut ? new Promise(() => {}) : Promise.resolve({ id: PHOTO.id })
    }
    return Promise.resolve([])
  })
}

async function openModal() {
  render(<DismissRegistryProvider><PhotoLibrary /></DismissRegistryProvider>)
  await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/photos'))
  await act(async () => {
    fireEvent.click(screen.getByAltText(PHOTO.caption).closest('button'))
  })
  await waitFor(() => expect(modal()).toBeTruthy())
  // The row prefill has landed — this is the seed every dirty assertion is measured against.
  expect(captionInput().value).toBe('first true leaves')
}

const edit = async (value) => {
  await act(async () => { fireEvent.change(captionInput(), { target: { value } }) })
  expect(captionInput().value).toBe(value)
}

beforeEach(() => {
  fetchSpy.mockReset()
  if (typeof URL.createObjectURL !== 'function') URL.createObjectURL = vi.fn(() => 'blob:stub')
  if (typeof URL.revokeObjectURL !== 'function') URL.revokeObjectURL = vi.fn()
  // S3: a floor entry, so back() is never called at history index 0 where jsdom makes it a SILENT
  // no-op — which false-PASSES "nothing was dismissed" for entirely the wrong reason.
  window.history.replaceState({ __floor: 1 }, '')
})

describe('PhotoLibrary — V4-DIRTYGUARDREST-001: Android Back on a dirty tag modal', () => {
  it('asks before discarding, and declining keeps the modal AND the edit', async () => {
    routeFetch()
    await openModal()
    await edit('first true leaves — cotyledons gone')
    const confirmSpy = vi.spyOn(window, 'confirm')

    expect(armed()).toBe(true)                     // S2 SELF-TEST: back() reaches the arbiter
    expect(window.history.state.__floor).toBe(1)   // S3 SELF-TEST: not at index 0
    noWriteInFlight()                              // S1

    await backGesture()

    expect(confirmUi()).toBeTruthy()
    expect(confirmSpy).not.toHaveBeenCalled()      // S4
    expect(modal()).toBeTruthy()

    await act(async () => { fireEvent.click(keepEditing()) })
    expect(confirmUi()).toBeNull()
    expect(captionInput().value).toBe('first true leaves — cotyledons gone')
    confirmSpy.mockRestore()
  })

  // Without the re-arm in the provider's CONFIRM branch the modal is left with no marker, and the
  // user's SECOND Back exits the installed PWA with a half-edited form still on screen.
  it("RE-ARMS after a declined Back, so the next Back is still the app's", async () => {
    routeFetch()
    await openModal()
    await edit('re-armed')

    await backGesture()
    expect(confirmUi()).toBeTruthy()
    expect(armed()).toBe(true)                     // the consumed marker was replaced

    // Back #2 resolves to the CONFIRM (LAYER.SYSTEM 1200 outranks SHEET 200) and closes only it.
    await backGesture()
    expect(confirmUi()).toBeNull()
    expect(modal()).toBeTruthy()
    expect(armed()).toBe(true)

    // Back #3 is a fresh gesture on the same dirty modal: it must ask again, not discard.
    await backGesture()
    expect(confirmUi()).toBeTruthy()
    expect(modal()).toBeTruthy()
  })

  it('accepting DOES discard — the guard is not a trap', async () => {
    routeFetch()
    await openModal()
    await edit('never mind')

    await backGesture()
    expect(confirmUi()).toBeTruthy()
    await act(async () => { fireEvent.click(discard()) })

    expect(modal()).toBeNull()
    expect(confirmUi()).toBeNull()
    noWriteInFlight()                              // discarded, not saved
  })

  // ★ Constant-true killer #1. Every field here is machine-seeded from the row, so a truthiness
  // predicate reads this modal as dirty and every photo the user merely opens becomes a question.
  it('an untouched modal closes on Back with no question, prefilled caption and all', async () => {
    routeFetch()
    await openModal()
    const confirmSpy = vi.spyOn(window, 'confirm')
    expect(armed()).toBe(true)

    await backGesture()

    expect(confirmUi()).toBeNull()
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(modal()).toBeNull()
    confirmSpy.mockRestore()
  })

  // ★ Constant-true killer #2, and the reason the predicate is differs-from-the-row rather than a
  // latch: typing and then putting it back is not unsaved work, and must release the guard.
  it('an edit reverted to the row value is not dirty', async () => {
    routeFetch()
    await openModal()
    await edit('typed something')
    await edit('first true leaves')

    await backGesture()

    expect(confirmUi()).toBeNull()
    expect(modal()).toBeNull()
  })

  // S1 as a positive assertion. A Back mid-save must be BLOCKED — refused and re-armed — not turned
  // into a discard question over a PUT already on the wire, and not allowed to unmount the form that
  // a failed save needs in order to render its error.
  it('a Back mid-save is BLOCKED, not confirmed and not discarded', async () => {
    routeFetch({ hangPut: true })
    await openModal()
    await edit('saving this')
    await act(async () => { fireEvent.click(screen.getByText('Save tags')) })
    await waitFor(() => expect(screen.getByText('Saving…')).toBeTruthy())

    await backGesture()

    expect(confirmUi()).toBeNull()                 // BLOCKED is checked ahead of CONFIRM
    expect(modal()).toBeTruthy()
    expect(armed()).toBe(true)                     // refused by re-pushing, per the BLOCKED branch
  })
})

// Escape is a DIFFERENT registry call site (decideDismiss, not decideBack), and the backdrop and ✕
// are a third path (requestDismiss). Sibling coverage, deliberately not merged: covering one gesture
// and not the others is exactly how this surface shipped half-guarded in the first place.
describe('PhotoLibrary — V4-DIRTYGUARDREST-001: the other dismissal gestures', () => {
  it('Escape on a dirty modal asks, and declining keeps the edit', async () => {
    routeFetch()
    await openModal()
    await edit('escape route')
    const confirmSpy = vi.spyOn(window, 'confirm')
    noWriteInFlight()

    await esc()

    expect(confirmUi()).toBeTruthy()
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(modal()).toBeTruthy()

    await act(async () => { fireEvent.click(keepEditing()) })
    expect(captionInput().value).toBe('escape route')
    confirmSpy.mockRestore()
  })

  it('Escape on an untouched modal closes it with no question', async () => {
    routeFetch()
    await openModal()
    await esc()
    expect(confirmUi()).toBeNull()
    expect(modal()).toBeNull()
  })

  // The backdrop was this modal's ORIGINAL and for a long time its only exit, and unlike <Sheet> it
  // never had a dirty guard of any kind — a stray tap beside the card discarded the edit outright.
  it('a backdrop tap asks on a dirty modal instead of discarding it', async () => {
    routeFetch()
    await openModal()
    await edit('stray tap territory')

    await act(async () => { fireEvent.click(modal()) })

    expect(confirmUi()).toBeTruthy()
    expect(modal()).toBeTruthy()

    await act(async () => { fireEvent.click(discard()) })
    expect(modal()).toBeNull()
  })

  it('a backdrop tap on an untouched modal still closes it immediately', async () => {
    routeFetch()
    await openModal()

    await act(async () => { fireEvent.click(modal()) })

    expect(confirmUi()).toBeNull()
    expect(modal()).toBeNull()
  })

  it('the ✕ asks on a dirty modal', async () => {
    routeFetch()
    await openModal()
    await edit('closing via the X')

    await act(async () => { fireEvent.click(screen.getByText('✕')) })

    expect(confirmUi()).toBeTruthy()
    expect(modal()).toBeTruthy()

    await act(async () => { fireEvent.click(keepEditing()) })
    expect(captionInput().value).toBe('closing via the X')
  })
})
