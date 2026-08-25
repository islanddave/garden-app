// V4-DIRTYGUARDREST-001 — the share composer, and ANDROID HARDWARE BACK.
//
// WHAT WAS BROKEN. This sheet computed `dirty` (V4-FBCAPTIONDIRTY-001, for the parent's reload gate)
// and then never handed it to the arbiter: Slice 2 registered it with `busy` only. So the largest
// single body of unsaved typing left in the app — up to 5000 characters of caption, with no draft
// stash of any kind — was discarded outright by Escape and by Back. c0507f3 shipped the confirm
// mechanism and deliberately scoped itself to PlantingDetail/Garden/SowNow; this file covers the
// remainder on this surface.
//
// WHY BACK IS THE PRIMARY ASSERTION. Escape runs decideDismiss; Back runs decideBack. Different call
// sites, different defaults, different reachability — a test for one proves nothing about the other.
// Dave is Android-only, so Back is the gesture that fires in production. Escape gets its own block.
//
// THE SUPPRESSION MECHANISMS held apart here, because a guard that cannot fail is worth nothing:
//   S1 `busy` -> BLOCKED, checked AHEAD of CONFIRM (backNav.js:102). This surface sets busy while
//      posting, so every confirm assertion runs from a NON-posting state and says so.
//   S2 armsBack missing -> hasArmable() false -> no marker -> back() never reaches the arbiter, and
//      the sheet sits there looking guarded. This was genuinely absent before this lane and nothing
//      else is open behind this sheet to arm on its behalf, so it is the likeliest false pass in the
//      file. Killed by asserting armed() before every gesture.
//   S3 history index 0 -> jsdom's back() is a SILENT no-op. Killed by the __floor sentinel.
//   S4 `closable` (!posting) already gates the ✕ / Cancel / backdrop. That is the busy mechanism, not
//      the dirty one; the dirty assertions never run while posting, so it cannot stand in.
//   S5 a reintroduced window.confirm patch. Asserted not-called on every confirm path.
//
// A REAL DismissRegistryProvider and REAL window.history, both load-bearing: without the provider
// `registered` is false, requestDismiss degrades to a bare onClose and the registry never sees this
// surface at all — which is the configuration FacebookShareSheet.test.jsx runs in, and why its
// close-button tests are green there and prove nothing about this. Feature flags are deliberately NOT
// mocked: DISMISS_REGISTRY_ENABLED and BACKNAV_ENABLED are hard `true` in source, and if either is
// flipped this guard genuinely stops working — red is the correct outcome.
import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

vi.mock('../components/PhotoImg.jsx', () => ({ default: ({ alt }) => <img alt={alt || ''} src="stub" /> }))

// useShareToFacebook drives the sheet's `state`; drive it from the test instead so `posting` and
// `success` are reachable without a real post on the wire.
// `reset` MUST be identity-stable across renders. The sheet's fresh-composer effect is keyed
// [open, reset], so a `vi.fn()` minted inside the hook body would re-run it on every render and
// silently blank the caption — every dirty assertion in this file would then pass for the wrong
// reason, on a clean sheet.
const fb = { state: 'idle', result: null, error: null }
const { shareSpy, resetSpy } = vi.hoisted(() => ({ shareSpy: vi.fn(), resetSpy: vi.fn() }))
vi.mock('../hooks/useShareToFacebook.js', () => ({
  useShareToFacebook: () => ({
    get state() { return fb.state },
    get result() { return fb.result },
    get error() { return fb.error },
    share: shareSpy, reset: resetSpy,
  }),
}))

import FacebookShareSheet from '../components/FacebookShareSheet.jsx'
import { DismissRegistryProvider } from '../context/DismissRegistry.jsx'
import { readMarker } from '../lib/backNav.js'

const PHOTOS = [{ id: 'ph-1', caption: 'seedlings', view_url: null }]

// The parent owns `open`, exactly as PhotoLibrary does — so "the sheet closed" is observable as an
// unmount rather than only as a spy call. A spy-only assertion would pass on a fix that called
// onClose and left the composer on screen.
const closeSpy = vi.fn()
function Host({ tick = 0 }) {
  const [open, setOpen] = useState(true)
  void tick
  return (
    <DismissRegistryProvider>
      <FacebookShareSheet
        open={open}
        photos={PHOTOS}
        onClose={() => { closeSpy(); setOpen(false) }}
      />
    </DismissRegistryProvider>
  )
}

// popstate needs >0ms to settle in jsdom; 50ms is the figure BackNav.history.test.jsx measured.
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 50)) })
const backGesture = async () => { act(() => { window.history.back() }); await settle() }
const esc = () => act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
const armed = () => !!readMarker(window.history.state)

const sheet = () => screen.queryByRole('dialog', { name: 'Share to Facebook' })
const confirmUi = () => screen.queryByTestId('confirm-sheet')
const discard = () => screen.getByTestId('confirm-sheet-confirm')
const keepEditing = () => screen.getByTestId('confirm-sheet-cancel')
const captionBox = () => screen.getByLabelText('Caption')

async function type(text) {
  await act(async () => { fireEvent.change(captionBox(), { target: { value: text } }) })
  expect(captionBox().value).toBe(text)
}

beforeEach(() => {
  fb.state = 'idle'; fb.result = null; fb.error = null
  shareSpy.mockReset()
  resetSpy.mockReset()
  closeSpy.mockReset()
  // S3: a floor entry, so back() is never called at history index 0 where jsdom makes it a SILENT
  // no-op — which false-PASSES "nothing was dismissed" for entirely the wrong reason.
  window.history.replaceState({ __floor: 1 }, '')
})

describe('FacebookShareSheet — V4-DIRTYGUARDREST-001: Android Back on a composed caption', () => {
  it('asks before discarding, and declining keeps the sheet AND the text', async () => {
    render(<Host />)
    await type('First tomatoes of the year 🍅')
    const confirmSpy = vi.spyOn(window, 'confirm')

    expect(armed()).toBe(true)                     // S2 SELF-TEST: back() reaches the arbiter
    expect(window.history.state.__floor).toBe(1)   // S3 SELF-TEST: not at index 0
    expect(fb.state).toBe('idle')                  // S1: busy cannot be what is holding the sheet up

    await backGesture()

    expect(confirmUi()).toBeTruthy()
    expect(confirmSpy).not.toHaveBeenCalled()      // S5
    expect(sheet()).toBeTruthy()
    expect(closeSpy).not.toHaveBeenCalled()

    await act(async () => { fireEvent.click(keepEditing()) })
    expect(confirmUi()).toBeNull()
    // THE UNFAKEABLE ONE: the caption is still there. A fix that re-rendered the sheet from scratch
    // would have run the open-effect's setCaption(''), so this is what a cosmetic fix cannot satisfy.
    expect(captionBox().value).toBe('First tomatoes of the year 🍅')
  })

  // The marker bug. Without the re-arm in the provider's CONFIRM branch the sheet is left with no
  // marker, and the user's SECOND Back exits the installed PWA with the caption still on screen.
  it("RE-ARMS after a declined Back, so the next Back is still the app's", async () => {
    render(<Host />)
    await type('bean trellis went up today')

    await backGesture()
    expect(confirmUi()).toBeTruthy()
    expect(armed()).toBe(true)                     // the consumed marker was replaced

    // Back #2 resolves to the CONFIRM (LAYER.SYSTEM 1200 outranks OVERLAY 300) and closes only it.
    await backGesture()
    expect(confirmUi()).toBeNull()
    expect(sheet()).toBeTruthy()
    expect(armed()).toBe(true)

    // Back #3 is a fresh gesture on the same dirty composer: it must ask again, not discard.
    await backGesture()
    expect(confirmUi()).toBeTruthy()
    expect(sheet()).toBeTruthy()
    expect(captionBox().value).toBe('bean trellis went up today')
  })

  it('accepting DOES discard — the guard is not a trap', async () => {
    render(<Host />)
    await type('something forgettable')

    await backGesture()
    expect(confirmUi()).toBeTruthy()
    await act(async () => { fireEvent.click(discard()) })

    expect(sheet()).toBeNull()
    expect(confirmUi()).toBeNull()
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })

  // ★ The constant-true killer. `dirty` here is trimmed-non-empty on a field the sheet itself blanks
  // on open, so a predicate stuck true would turn every mis-tapped "Post to Facebook" into a question
  // the user has to answer — and would make every assertion above pass for the wrong reason.
  it('an untouched composer closes on Back with no question at all', async () => {
    render(<Host />)
    const confirmSpy = vi.spyOn(window, 'confirm')
    expect(armed()).toBe(true)
    expect(captionBox().value).toBe('')

    await backGesture()

    expect(confirmUi()).toBeNull()
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(sheet()).toBeNull()
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })

  // Whitespace is not content. Same killer, one step finer: the predicate is caption.trim(), not
  // caption, so a spacebar tap must not arm a discard question.
  it('a whitespace-only caption is not dirty', async () => {
    render(<Host />)
    await type('   ')

    await backGesture()

    expect(confirmUi()).toBeNull()
    expect(sheet()).toBeNull()
  })

  // S1 as a positive assertion rather than only a precondition. A Facebook post is the one
  // non-idempotent in-flight action in the app: a Back mid-POST must be BLOCKED — refused and
  // re-armed — never turned into a discard question over bytes already gone.
  it('a Back mid-post is BLOCKED, not confirmed and not discarded', async () => {
    const { rerender } = render(<Host tick={0} />)
    await type('posting this one')
    await act(async () => { fb.state = 'posting'; rerender(<Host tick={1} />) })
    expect(screen.getByText('Posting…')).toBeTruthy()

    await backGesture()

    expect(confirmUi()).toBeNull()                 // BLOCKED is checked ahead of CONFIRM
    expect(sheet()).toBeTruthy()
    expect(closeSpy).not.toHaveBeenCalled()
    expect(armed()).toBe(true)                     // refused by re-pushing, per the BLOCKED branch
  })

  // A caption that POSTED is saved, not unsaved. The Success arm replaces the composer and nothing
  // clears `caption`, so without the `!done` term in the predicate Done would ask to discard work
  // that is already on Facebook.
  it('a posted caption asks nothing — Done just leaves', async () => {
    const { rerender } = render(<Host tick={0} />)
    await type('this one went out')
    await act(async () => {
      fb.state = 'success'
      fb.result = { post_id: '123', permalink: 'https://facebook.com/123' }
      rerender(<Host tick={1} />)
    })

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Done' })) })

    expect(confirmUi()).toBeNull()
    expect(sheet()).toBeNull()
  })
})

// Escape is a DIFFERENT registry call site (decideDismiss, not decideBack) with different defaults,
// and the three tap exits are a third path (requestDismiss). Sibling coverage, deliberately not
// merged: c0507f3's own note is that covering one gesture leaves the others discarding silently.
describe('FacebookShareSheet — V4-DIRTYGUARDREST-001: the other dismissal gestures', () => {
  it('Escape on a composed caption asks, and declining keeps the text', async () => {
    render(<Host />)
    await type('escape hatch')
    const confirmSpy = vi.spyOn(window, 'confirm')

    await esc()

    expect(confirmUi()).toBeTruthy()
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(sheet()).toBeTruthy()

    await act(async () => { fireEvent.click(keepEditing()) })
    expect(captionBox().value).toBe('escape hatch')
  })

  it('Escape on an untouched composer closes it with no question', async () => {
    render(<Host />)
    await esc()
    expect(confirmUi()).toBeNull()
    expect(sheet()).toBeNull()
  })

  // The ✕ is the most discoverable exit on this sheet. Had the opt-in covered only Escape and Back,
  // this would have become the one gesture that still discarded 5000 characters silently.
  it('the header ✕ asks on a composed caption', async () => {
    render(<Host />)
    await type('closing via the X')

    await act(async () => { fireEvent.click(screen.getByLabelText('Close')) })

    expect(confirmUi()).toBeTruthy()
    expect(sheet()).toBeTruthy()
    expect(closeSpy).not.toHaveBeenCalled()

    // And the accept arm still leaves, from this path too.
    await act(async () => { fireEvent.click(discard()) })
    expect(sheet()).toBeNull()
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })

  // Cancel sits one thumb-width from "Post to Facebook", so it is the mis-tap this guard is most
  // likely to catch. It is the sheet's OWN chrome, not a child editor's control, which is why it
  // confirms — the same call Sheet makes for its labelled Close (DismissRegistry.jsx:138-143).
  it('the Cancel button asks on a composed caption', async () => {
    render(<Host />)
    await type('cancel me')

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })) })

    expect(confirmUi()).toBeTruthy()
    expect(sheet()).toBeTruthy()
    expect(closeSpy).not.toHaveBeenCalled()

    await act(async () => { fireEvent.click(keepEditing()) })
    expect(confirmUi()).toBeNull()
    expect(captionBox().value).toBe('cancel me')
  })

  // Same control, nothing typed: no question. `dirty` here tracks the field rather than latching, so
  // this is the paired non-nag assertion for the tap path.
  it('the Cancel button leaves an untouched composer immediately', async () => {
    render(<Host />)

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })) })

    expect(confirmUi()).toBeNull()
    expect(sheet()).toBeNull()
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })

  it('a backdrop tap asks on a composed caption instead of discarding it', async () => {
    render(<Host />)
    await type('stray tap territory')

    await act(async () => { fireEvent.click(sheet()) })

    expect(confirmUi()).toBeTruthy()
    expect(sheet()).toBeTruthy()
    expect(closeSpy).not.toHaveBeenCalled()
  })
})
