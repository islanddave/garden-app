// V4-BACKNAV-001 Slice 3a — provider-level Back against REAL jsdom history.
//
// THIS FILE IS THE REPO'S ONLY REAL-HISTORY TEST HARNESS. It replaces useBackDismiss.test.jsx and
// must stay green before that file is deleted — deleting first would leave a window with zero real
// history coverage. The 6 behaviours that file pinned are carried forward here: marker merge, the
// self-pop guard, boundedness, two-surface discrimination, marker validation (in backNav.test.js),
// and flag-off inertness.
//
// WHY THE SELF-TESTS EXIST. ~30 of the suite's files use MemoryRouter, which never touches
// window.history — a back-nav test written in the house style passes VACUOUSLY. Worse, back() at
// history index 0 is a SILENT no-op in jsdom (no event, no error), so a test sitting at index 0
// would false-PASS a "nothing was dismissed" assertion for entirely the wrong reason. Both clauses
// below run before any behavioural assertion.
//
// MEASURED jsdom facts this file is built on (do not re-litigate):
//   - popstate DOES fire on history.back(), but needs >0ms to settle; 50ms is reliable.
//   - history.length does NOT shrink on back(), and a push from a popped position TRUNCATES the
//     forward entry — so length is unusable as an assertion. Assert on history.state.
import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const flags = { DISMISS_REGISTRY_ENABLED: true, BACKNAV_ENABLED: true }
vi.mock('../lib/featureFlags.js', async (importOriginal) => ({
  ...(await importOriginal()),
  get DISMISS_REGISTRY_ENABLED() { return flags.DISMISS_REGISTRY_ENABLED },
  get BACKNAV_ENABLED() { return flags.BACKNAV_ENABLED },
}))

import Sheet from '../components/forms/Sheet.jsx'
import { DismissRegistryProvider, useDismissable } from '../context/DismissRegistry.jsx'
import { LAYER } from '../lib/dismissLayers.js'
import { MARKER_KEY, readMarker } from '../lib/backNav.js'

// Wait for the traversal to LAND, not for a slice of wall clock. jsdom runs a back() as a queued
// task, and everything the provider does in response is synchronous inside that dispatch — so the
// only thing worth awaiting is the popstate itself. The 50ms this used to sleep was measured on an
// idle machine; when the suite runs 700+ files in parallel the task has not been scheduled yet when
// the sleep expires, and every assertion after it reads pre-Back state. That surfaces as
// `expected "spy" to be called 1 times, but got 0 times` — a plain AssertionError indistinguishable
// from a real regression, which is what makes it expensive rather than merely annoying.
//
// NET_MS is a safety net, not the wait: 12 of the 13 traversals in this file return the moment the
// event arrives. The one exception traverses from history index 0, where jsdom no-ops SILENTLY (the
// measured fact in the header above) and no event is ever coming — that call, and only that call,
// pays the net.
const NET_MS = 2000
let pops = 0
window.addEventListener('popstate', () => { pops += 1 })

// Defaults to the count read at call time, so a standalone `settle()` after an action that triggers
// its own back() (the close-by-button case) still waits for that traversal rather than guessing.
//
// THE MARKER SETTLES ONE TRAVERSAL LATER (BUG-BACKTWICECLOSESAPP-001). A Back the registry refuses or
// steps (busy, the discard question, a panel, a stacked close) is answered by a RETURN: history.go(1)
// back onto the same marker, which jsdom runs as two more queued tasks and a second popstate. So the
// drain is no longer one turn: wait until a whole round of turns passes with no further popstate.
// Node runs equal-delay timers first-in first-out, so three turns always outlast the two the
// traversal needs; this is ordering, not a sleep, and it holds under load.
const TURNS = 3
const settle = (from = pops) => act(async () => {
  const deadline = Date.now() + NET_MS
  while (pops === from && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2))
  let seen
  do {
    seen = pops
    for (let i = 0; i < TURNS; i++) await new Promise((r) => setTimeout(r, 0))
  } while (pops !== seen && Date.now() < deadline)
})
const back = async () => { const from = pops; act(() => { window.history.back() }); await settle(from) }
const esc = () => act(() => { fireEvent.keyDown(document, { key: 'Escape' }) })

// A floor entry, so we are never AT index 0 when a test calls back(). Its sentinel is asserted
// immediately before every traversal under test, which is what makes a silent no-op distinguishable
// from a handled Back.
//
// atFloor must ALSO require the absence of our marker: arm() MERGES history.state, so the marker
// entry carries __floor forward too (that merge is required — react-router owns {usr,key,idx}).
// Checking the sentinel alone cannot tell "armed" from "back at the floor".
const SENTINEL = { __floor: 1 }
const BASE = { __base: 1 }
const armed = () => !!readMarker(window.history.state)
const atFloor = () => !armed() && window.history.state?.__floor === 1
const seqNow = () => readMarker(window.history.state)?.seq ?? null

// THE REGISTRY'S OWN SOURCE, for the two things only its text can give a test. (1) How long it waits
// for a return to land (RETURN_LANDS_WITHIN_MS). It does not export that, and a copy here would go
// stale silently: a test that must OUTWAIT the window would, after a retune, stop outwaiting it and
// pass through a different line of the handler. SELF-TEST-5 pins that the read worked. (2) The text
// of the popstate handler, for the static pin at the foot of this file.
const REGISTRY_SRC = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../context/DismissRegistry.jsx'), 'utf8')
const RETURN_LANDS_WITHIN_MS = Number(/^const RETURN_LANDS_WITHIN_MS = (\d+)$/m.exec(REGISTRY_SRC)?.[1])
const PAST_THE_WINDOW_MS = RETURN_LANDS_WITHIN_MS + 50

// BUG-BACKNAVVACUOUSTEST-001. This used to be a bare `replaceState(SENTINEL, '')`, and that is NOT
// a floor: replaceState REWRITES the current entry and creates nothing beneath it, so on a fresh
// jsdom the "floor" WAS history index 0. A back() from index 0 is a SILENT no-op — no event, no
// error, the measured fact this file's own header records — so any test whose assertion is
// "nothing happened" passed without a Back ever occurring. One did (the non-opt-in Sheet case), and
// it was the sole reason one test paid the full 2000ms NET_MS waiting for an event that was never
// coming.
//
// replaceState FIRST so we own whatever entry we inherit, THEN pushState so there is a genuine
// entry below the floor and every traversal in this file actually traverses. SELF-TEST-3 proves it
// rather than trusting it.
beforeEach(() => {
  flags.DISMISS_REGISTRY_ENABLED = true
  flags.BACKNAV_ENABLED = true
  window.history.replaceState(BASE, '')
  window.history.pushState(SENTINEL, '')
})
afterEach(() => { document.body.style.overflow = ''; document.body.style.overscrollBehavior = '' })

// A registry-only surface (no Sheet, no Back) — stands in for VarietyPicker's ConflictModal, the
// surface that produced the shipped Escape/Back divergence.
function BareDialog({ open, onClose, layer = LAYER.DIALOG }) {
  useDismissable({ open, onDismiss: onClose, layer })
  return open ? <div role="dialog" aria-label="conflict" /> : null
}

describe('SELF-TEST — the harness itself, before any behaviour is asserted', () => {
  it('SELF-TEST-1/popstate-arrives: a real popstate reaches a listener', async () => {
    const seen = vi.fn()
    window.addEventListener('popstate', seen)
    window.history.pushState({ probe: 1 }, '')
    await back()
    window.removeEventListener('popstate', seen)
    expect(seen).toHaveBeenCalled()
  })

  it('SELF-TEST-2/not-at-index-0: the floor sentinel is current before each traversal', () => {
    expect(atFloor()).toBe(true)
  })

  it('SELF-TEST-3/the-floor-is-a-real-floor: a back() from the floor actually traverses', async () => {
    // SELF-TEST-2 proves the sentinel is CURRENT. It cannot prove there is anything BENEATH it, and
    // that is the whole difference between a floor and index 0 — which is where
    // BUG-BACKNAVVACUOUSTEST-001 lived: a replaceState floor satisfied SELF-TEST-2 perfectly while
    // every back() from it silently did nothing.
    //
    // This is the instrument check for every "nothing was dismissed" assertion in the file. If it
    // fails, those assertions are not wrong — they are VACUOUS, which is worse, because they stay
    // green against a broken implementation.
    expect(atFloor()).toBe(true)
    const before = pops
    await back()
    expect(pops, 'back() from the floor fired no popstate — the floor is history index 0 again')
      .toBe(before + 1)
    expect(window.history.state?.__base, 'back() from the floor did not land on the base entry').toBe(1)
  })

  it('SELF-TEST-4/forward-traverses: history.go(1) lands on the entry a Back just left, and fires popstate', async () => {
    // BUG-BACKTWICECLOSESAPP-001. The registry no longer PUSHES a marker after a Back it refuses or
    // steps; it RETURNS to the one the Back left, with history.go(1). Every "no pushState across a
    // Back" test below stands on jsdom doing that traversal. If it did not (no event, or no move),
    // those tests would read a registry that never got back onto its marker and blame the fix.
    window.history.pushState({ __fwd: 1 }, '')
    await back()
    expect(atFloor()).toBe(true)
    const before = pops
    act(() => { window.history.go(1) })
    await settle(before)
    expect(pops, 'history.go(1) fired no popstate — jsdom did not traverse forward').toBe(before + 1)
    expect(window.history.state?.__fwd, 'history.go(1) did not land on the entry the Back left').toBe(1)
  })

  it('SELF-TEST-5/the-window-is-readable: the registry\'s return window was read from its source', () => {
    // Two tests below wait PAST this window in real time (the slow return; the pushState watch that
    // outlasts the return's timer). If the read came back NaN, setTimeout(NaN) fires at once and both
    // would "wait" for nothing and pass for the wrong reason.
    expect(Number.isInteger(RETURN_LANDS_WITHIN_MS), 'RETURN_LANDS_WITHIN_MS was not found in DismissRegistry.jsx').toBe(true)
    expect(RETURN_LANDS_WITHIN_MS).toBeGreaterThan(0)
    expect(PAST_THE_WINDOW_MS).toBeGreaterThan(RETURN_LANDS_WITHIN_MS)
  })
})

describe('Back is arbitrated by the registry', () => {
  it('arms on open, and one Back closes the surface without leaving the page', async () => {
    const onClose = vi.fn()
    render(
      <DismissRegistryProvider>
        <Sheet open onClose={onClose} title="Details" armsBack><button>x</button></Sheet>
      </DismissRegistryProvider>
    )
    // MERGE, never replace: the floor sentinel must survive alongside our marker.
    expect(readMarker(window.history.state)).toBeTruthy()
    expect(window.history.state.__floor).toBe(1)

    await back()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(atFloor()).toBe(true)
  })

  it('a Sheet that does NOT opt in never arms — Back falls through untouched', async () => {
    const onClose = vi.fn()
    render(
      <DismissRegistryProvider>
        <Sheet open onClose={onClose} title="Nav"><button>x</button></Sheet>
      </DismissRegistryProvider>
    )
    expect(readMarker(window.history.state)).toBeNull()
    expect(atFloor()).toBe(true)
    // BUG-BACKNAVVACUOUSTEST-001: assert the Back HAPPENED before asserting what it did not do.
    // This test's whole claim is "a real Back fell through untouched", and until the floor became a
    // real floor no Back occurred at all — onClose was un-called because nothing had been
    // traversed, which is exactly the outcome a broken implementation would also produce.
    const before = pops
    await back()
    expect(pops, 'no popstate — this assertion would be vacuous').toBe(before + 1)
    expect(window.history.state?.__base, 'the Back did not traverse off the floor').toBe(1)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('kind="route" never arms — the router owns its entry', async () => {
    const onClose = vi.fn()
    render(
      <DismissRegistryProvider>
        <Sheet open onClose={onClose} ariaLabel="overlay" kind="route" armsBack><button>x</button></Sheet>
      </DismissRegistryProvider>
    )
    expect(readMarker(window.history.state)).toBeNull()
  })
})

describe('THE POINT OF THE SLICE — Back and Escape resolve to the SAME surface', () => {
  // This is the shipped v3.103.0 defect, reproduced as a test: an armed Sheet with a registry-only
  // dialog on top. Escape closed the dialog (right) while Back closed the sheet beneath and tore
  // the dialog down with it. If the arbiter is reverted, this test fails.
  function Stack({ onSheet, onDialog }) {
    return (
      <DismissRegistryProvider>
        <Sheet open onClose={onSheet} title="Sow" armsBack><button>x</button></Sheet>
        <BareDialog open onClose={onDialog} />
      </DismissRegistryProvider>
    )
  }

  it('Escape closes the topmost dialog, not the sheet beneath', () => {
    const onSheet = vi.fn(); const onDialog = vi.fn()
    render(<Stack onSheet={onSheet} onDialog={onDialog} />)
    esc()
    expect(onDialog).toHaveBeenCalledTimes(1)
    expect(onSheet).not.toHaveBeenCalled()
  })

  it('Back closes the SAME surface Escape would — the divergence is gone', async () => {
    const onSheet = vi.fn(); const onDialog = vi.fn()
    render(<Stack onSheet={onSheet} onDialog={onDialog} />)
    expect(atFloor()).toBe(false)   // armed
    await back()
    expect(onDialog).toHaveBeenCalledTimes(1)
    expect(onSheet).not.toHaveBeenCalled()
  })
})

describe('stacked surfaces — the single marker re-arms so depth still works', () => {
  // The failure this pins: with ONE marker and arming keyed on a level-triggered scalar, the second
  // Back would have no marker and would exit the installed PWA with a sheet still open.
  function TwoStack() {
    const [sheet, setSheet] = useState(true)
    const [dialog, setDialog] = useState(true)
    return (
      <DismissRegistryProvider>
        {sheet && <Sheet open onClose={() => setSheet(false)} title="Sow" armsBack><button>x</button></Sheet>}
        <BareDialog open={dialog} onClose={() => setDialog(false)} />
        <span data-testid="state">{`${sheet}:${dialog}`}</span>
      </DismissRegistryProvider>
    )
  }

  it('two Backs close two surfaces, and the page is only left on the third', async () => {
    render(<TwoStack />)
    expect(screen.getByTestId('state').textContent).toBe('true:true')

    await back()
    expect(screen.getByTestId('state').textContent).toBe('true:false')
    expect(atFloor()).toBe(false)     // re-armed for the surface still open

    await back()
    expect(screen.getByTestId('state').textContent).toBe('false:false')
    expect(atFloor()).toBe(true)      // nothing left — the next Back belongs to the app
  })
})

describe('close-by-button consumes the entry without re-entering onDismiss', () => {
  it('closing via Close leaves the stack where it started and fires onClose once', async () => {
    const onClose = vi.fn()
    function Host() {
      const [open, setOpen] = useState(true)
      return (
        <DismissRegistryProvider>
          <Sheet open={open} onClose={() => { onClose(); setOpen(false) }} title="Details" armsBack>
            <button>x</button>
          </Sheet>
        </DismissRegistryProvider>
      )
    }
    render(<Host />)
    expect(atFloor()).toBe(false)
    act(() => { fireEvent.click(screen.getByRole('button', { name: /close/i })) })
    await settle()
    expect(onClose).toHaveBeenCalledTimes(1)   // the self-pop guard: not re-entered by our own back()
    expect(atFloor()).toBe(true)               // our entry was consumed, stack not grown
  })
})

describe('busy refuses Back — but boundedly, never a trap', () => {
  it('the first refusals hold the surface open, then Back is allowed through', async () => {
    const onClose = vi.fn()
    render(
      <DismissRegistryProvider>
        <Sheet open onClose={onClose} title="Saving" busy armsBack><button>x</button></Sheet>
      </DismissRegistryProvider>
    )
    await back()
    expect(onClose).not.toHaveBeenCalled()
    expect(atFloor()).toBe(false)      // re-armed: the refusal undid the traversal

    await back()
    expect(onClose).not.toHaveBeenCalled()
    // The SECOND refusal holds too (QA M-e). "onClose not called" is also true of a Back that was let
    // through, so without this line a cap of one would pass everything above.
    expect(atFloor(), 'the second refusal did not return to the marker').toBe(false)

    // Bounded: after MAX_CONSECUTIVE_BLOCKS the gesture is honoured rather than trapping the user
    // behind a `busy` that may never clear.
    await back()
    expect(atFloor()).toBe(true)
  })
})

describe('backIntercept — the topmost handles its own sub-state first', () => {
  it('a truthy intercept keeps the surface open and restores the entry', async () => {
    const onClose = vi.fn()
    const intercept = vi.fn(() => true)
    render(
      <DismissRegistryProvider>
        <Sheet open onClose={onClose} title="Zoom" armsBack backIntercept={intercept}><button>x</button></Sheet>
      </DismissRegistryProvider>
    )
    await back()
    expect(intercept).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
    expect(atFloor()).toBe(false)      // still armed — the surface is still open
  })

  it('a falsey intercept falls through to dismissal', async () => {
    const onClose = vi.fn()
    render(
      <DismissRegistryProvider>
        <Sheet open onClose={onClose} title="Zoom" armsBack backIntercept={() => false}><button>x</button></Sheet>
      </DismissRegistryProvider>
    )
    await back()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(atFloor()).toBe(true)
  })
})

// BUG-BACKTWICECLOSESAPP-001 — Back twice, with no touch between, closed the installed app.
//
// Chrome on Android marks an entry a page creates WITHOUT a tap as "skip on the Back button", and a
// Back press itself clears whatever tap came before it. The registry used to answer four kinds of
// Back by pushing a NEW marker from inside its popstate handler; that entry was skippable, so the
// next Back had nowhere to go. jsdom has no such rule, so "the surface is still armed" stayed green
// the whole time the phone was closing the app. What jsdom CAN show is the cause: was an entry
// created? These four pin that none is, and that the marker under the cursor afterwards is the SAME
// one (same seq), reached again rather than replaced.
describe('BUG-BACKTWICECLOSESAPP-001 — a Back the registry answers creates NO history entry', () => {
  // One Back, with history.pushState watched from just before the press until the marker has settled.
  // `popped` is how many popstates the press produced. `lingerMs` keeps the watch up that much longer
  // and reports what it saw by then: the settle ends a few zero-delay turns after the Back, so a push
  // made in a LATER task (a timer, an arm held back for the next tap) would otherwise go unseen.
  async function watchedBack({ lingerMs = 0 } = {}) {
    const before = seqNow()
    const pops0 = pops
    const spy = vi.spyOn(window.history, 'pushState')
    await back()
    const pushes = spy.mock.calls.length
    const popped = pops - pops0
    const after = seqNow()
    if (lingerMs) await act(async () => { await new Promise((r) => setTimeout(r, lingerMs)) })
    const lingered = { pushes: spy.mock.calls.length, seq: seqNow() }
    spy.mockRestore()
    return { pushes, before, after, popped, lingered }
  }

  it('BLOCKED (a write in flight): the refusal pushes nothing and stands on the same marker', async () => {
    const onClose = vi.fn()
    render(
      <DismissRegistryProvider>
        <Sheet open onClose={onClose} title="Saving" busy armsBack><button>x</button></Sheet>
      </DismissRegistryProvider>
    )
    const r = await watchedBack()
    expect(onClose).not.toHaveBeenCalled()
    expect(r.before, 'SELF-TEST: the sheet was armed before the Back').not.toBeNull()
    expect(r.pushes, 'a history entry was created inside the Back').toBe(0)
    expect(r.after, 'not standing on the same marker after the Back').toBe(r.before)
    // THE BACK HAPPENED (QA C2). Every line above is also true if no popstate ever fired: the other
    // three cases carry their own evidence (the intercept ran, the question is up, the dialog closed),
    // a refusal leaves none. A refusal is exactly two traversals, the Back and the return; one would be
    // a Back let through, none would be no Back at all.
    expect(r.popped, 'a refused Back is two popstates: the Back and the return').toBe(2)
  })

  it('CONFIRM (unsaved typing): raising the question pushes nothing and stands on the same marker', async () => {
    const onClose = vi.fn()
    render(
      <DismissRegistryProvider>
        <Sheet open onClose={onClose} title="Form" dirty confirmOnDirty armsBack><button>x</button></Sheet>
      </DismissRegistryProvider>
    )
    const r = await watchedBack()
    expect(screen.getByTestId('confirm-sheet')).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
    expect(r.before, 'SELF-TEST: the sheet was armed before the Back').not.toBeNull()
    expect(r.pushes, 'a history entry was created inside the Back').toBe(0)
    expect(r.after, 'not standing on the same marker after the Back').toBe(r.before)
  })

  it('INTERCEPT (a panel steps back): the step pushes nothing and stands on the same marker', async () => {
    const onClose = vi.fn()
    const intercept = vi.fn(() => true)
    render(
      <DismissRegistryProvider>
        <Sheet open onClose={onClose} title="Row" armsBack backIntercept={intercept}><button>x</button></Sheet>
      </DismissRegistryProvider>
    )
    const r = await watchedBack({ lingerMs: PAST_THE_WINDOW_MS })
    expect(intercept).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
    expect(r.before, 'SELF-TEST: the sheet was armed before the Back').not.toBeNull()
    expect(r.pushes, 'a history entry was created inside the Back').toBe(0)
    expect(r.after, 'not standing on the same marker after the Back').toBe(r.before)
    // AND NONE LATER (QA M-b). This case alone keeps watching until the return's own timer has come
    // and gone: still no entry, and the timer has not moved us off the marker the return landed on.
    expect(r.lingered.pushes, 'a history entry was created after the Back had settled').toBe(0)
    expect(r.lingered.seq, 'the marker under the cursor changed after the Back had settled').toBe(r.before)
  })

  it('STACKED (the top surface closes, one stays open): the close pushes nothing and stands on the same marker', async () => {
    const onSheet = vi.fn(); const onDialog = vi.fn()
    function Host() {
      const [dialog, setDialog] = useState(true)
      return (
        <DismissRegistryProvider>
          <Sheet open onClose={onSheet} title="Sow" armsBack><button>x</button></Sheet>
          <BareDialog open={dialog} onClose={() => { onDialog(); setDialog(false) }} />
        </DismissRegistryProvider>
      )
    }
    render(<Host />)
    const r = await watchedBack()
    expect(onDialog).toHaveBeenCalledTimes(1)
    expect(onSheet).not.toHaveBeenCalled()
    expect(r.before, 'SELF-TEST: the sheet was armed before the Back').not.toBeNull()
    expect(r.pushes, 'a history entry was created inside the Back').toBe(0)
    expect(r.after, 'not standing on the same marker after the Back').toBe(r.before)
  })
})

// The return is a traversal, so it is not instant: between the Back and the landing the cursor is on
// the page's own entry with our marker one step forward. In a browser that window is a frame or two;
// in jsdom it is two queued tasks. Neither is wide enough to act inside from a test, so these HOLD
// the registry's history.go(1) and release it by hand. Nothing else is faked: the same history, the
// same popstate, the real Back (jsdom's back() does not route through the method being held).
describe('BUG-BACKTWICECLOSESAPP-001 — what happens INSIDE the return\'s window', () => {
  const drain = () => act(async () => { for (let i = 0; i < TURNS; i++) await new Promise((r) => setTimeout(r, 0)) })
  let goSpy = null
  function holdReturn() {
    const real = window.history.go.bind(window.history)
    const held = []
    goSpy = vi.spyOn(window.history, 'go').mockImplementation((n) => { held.push(n) })
    return {
      held,
      release: async () => {
        const from = pops
        goSpy.mockRestore(); goSpy = null
        act(() => { for (const n of held.splice(0)) real(n) })
        await settle(from)
      },
    }
  }
  let pushSpy = null
  afterEach(() => {
    if (goSpy) { goSpy.mockRestore(); goSpy = null }
    if (pushSpy) { pushSpy.mockRestore(); pushSpy = null }
  })

  it('the sheet CLOSES inside the window: the return lands on a marker nobody owns and steps off it — no dead press', async () => {
    let closeIt
    function Host() {
      const [open, setOpen] = useState(true)
      closeIt = () => setOpen(false)
      return (
        <DismissRegistryProvider>
          {open && <Sheet open onClose={() => setOpen(false)} title="Row" armsBack backIntercept={() => true}><button>x</button></Sheet>}
        </DismissRegistryProvider>
      )
    }
    render(<Host />)
    expect(armed()).toBe(true)
    const ret = holdReturn()

    await back()                                   // the panel steps back; the return is in flight
    expect(ret.held, 'SELF-TEST: the registry asked for exactly one return').toEqual([1])
    expect(atFloor()).toBe(true)                   // the cursor is on the page's entry, the marker one step forward

    act(() => { closeIt() })                       // a save lands and closes the sheet, inside the window
    await drain()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(atFloor()).toBe(true)                   // disarm() found no marker under it and popped nothing

    await ret.release()                            // the return lands... on a marker nobody owns
    expect(armed(), 'the cursor was left on an orphan marker').toBe(false)
    expect(atFloor()).toBe(true)

    // NO DEAD PRESS: the very next Back leaves the page. On an orphan marker it would land here again.
    const before = pops
    await back()
    expect(pops).toBe(before + 1)
    expect(window.history.state?.__base, 'that Back was eaten by an entry the sheet left behind').toBe(1)
  })

  it('a SECOND Back inside the window navigates, and dismisses nothing a second time', async () => {
    function TwoStack() {
      const [sheet, setSheet] = useState(true)
      const [dialog, setDialog] = useState(true)
      return (
        <DismissRegistryProvider>
          {sheet && <Sheet open onClose={() => setSheet(false)} title="Sow" armsBack><button>x</button></Sheet>}
          <BareDialog open={dialog} onClose={() => setDialog(false)} />
          <span data-testid="state">{`${sheet}:${dialog}`}</span>
        </DismissRegistryProvider>
      )
    }
    render(<TwoStack />)
    const ret = holdReturn()

    await back()                                   // closes the dialog; the return for the sheet is in flight
    expect(screen.getByTestId('state').textContent).toBe('true:false')
    expect(ret.held).toEqual([1])

    const before = pops
    await back()                                   // the second press, before the return has landed
    expect(pops, 'SELF-TEST: the second Back really traversed').toBe(before + 1)
    expect(window.history.state?.__base).toBe(1)   // it left the page's entry: that is all it did
    expect(screen.getByTestId('state').textContent, 'one press closed two surfaces').toBe('true:false')

    await ret.release()                            // the late return moves forward again; nobody acts on it
    expect(screen.getByTestId('state').textContent).toBe('true:false')
    expect(armed()).toBe(false)
  })

  it('a return that NEVER lands is forgotten: it does not swallow the next sheet\'s Back', async () => {
    const onB = vi.fn()
    let show
    function Host() {
      const [which, setWhich] = useState('a')
      show = setWhich
      return (
        <DismissRegistryProvider>
          {which === 'a' && <Sheet open onClose={() => {}} title="A" armsBack backIntercept={() => true}><button>x</button></Sheet>}
          {which === 'b' && <Sheet open onClose={onB} title="B" armsBack><button>x</button></Sheet>}
        </DismissRegistryProvider>
      )
    }
    render(<Host />)
    holdReturn()                                   // held and never released: the return is cut off
    await back()
    expect(atFloor()).toBe(true)

    act(() => { show(null) })                      // A closes inside the window...
    await drain()
    act(() => { fireEvent.click(document.body) })  // ...the user taps...
    act(() => { show('b') })                       // ...and B opens and arms a marker of its own
    await drain()
    expect(armed()).toBe(true)

    await back()
    expect(onB, 'B\'s Back was taken for the stale return and dismissed nothing').toHaveBeenCalledTimes(1)
  })

  // QA C1 / RIA P-6 item 1 — THE SLOW RETURN. stepBackOn stops believing it is armed when the return
  // has not landed within RETURN_LANDS_WITHIN_MS (its timer). On a janky phone the return then lands
  // LATE: on the marker, with the sheet still open, and nobody holding it. The ADOPT half of the orphan
  // branch is what takes the marker back. Without it the registry steps off, the open sheet is left
  // with no marker, and the next Back leaves the page (or closes the app when it is the first page).
  //
  // The wait is real time on purpose: the registry's timer is real, and the two are ordered (ours is
  // set later and runs longer, so it cannot fire first, however late the loop is running).
  // MUTATION: delete `if (hasArmable(entriesRef.current)) { armedRef.current = cur.seq; return }` ->
  // red at "stepped off the marker under an open sheet".
  it('a return that lands LATE, after the registry stopped waiting for it, is adopted: the open sheet is armed again and the next Back reaches it', async () => {
    const onClose = vi.fn()
    const intercept = vi.fn(() => true)
    render(
      <DismissRegistryProvider>
        <Sheet open onClose={onClose} title="Row" armsBack backIntercept={intercept}><button>x</button></Sheet>
      </DismissRegistryProvider>
    )
    const seq0 = seqNow()
    expect(seq0, 'SELF-TEST: the sheet was armed before the Back').not.toBeNull()
    pushSpy = vi.spyOn(window.history, 'pushState')
    const ret = holdReturn()

    const t0 = Date.now()
    await back()                                   // the panel steps back; the return is in flight, and held
    expect(intercept).toHaveBeenCalledTimes(1)
    expect(ret.held, 'SELF-TEST: the registry asked for exactly one return').toEqual([1])
    expect(atFloor()).toBe(true)

    await act(async () => { await new Promise((r) => setTimeout(r, PAST_THE_WINDOW_MS)) })
    expect(Date.now() - t0, 'SELF-TEST: the wait did not outlast the registry\'s window')
      .toBeGreaterThan(RETURN_LANDS_WITHIN_MS)
    expect(atFloor()).toBe(true)                   // nothing has landed: still on the page's entry

    await ret.release()                            // the slow return lands, on a marker nobody holds
    expect(seqNow(), 'stepped off the marker under an open sheet').toBe(seq0)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()

    await back()                                   // ...and the NEXT Back is the sheet's again
    expect(intercept, 'the next Back did not reach the sheet').toHaveBeenCalledTimes(2)
    expect(onClose).not.toHaveBeenCalled()
    expect(seqNow(), 'not standing on the same marker after the next Back').toBe(seq0)
    expect(pushSpy.mock.calls.length, 'a history entry was created').toBe(0)
  })

  // RIA P-5 — A KNOWN RESIDUAL, PINNED AS IT IS. NOT A GOAL.
  //
  // The "return landed somewhere else" guard unarms and decides nothing: right, because the second
  // press has already navigated. But when the surface's host stays mounted across that entry change
  // (page-level state, such as Put-Up's "Put something up" door), the surface is still OPEN and now
  // holds NO marker. `armable` never went false, so the arm effect does not run again, and nothing
  // else arms it. From here Back walks the page under an open sheet until the sheet is closed by its
  // own controls. Before the fix the same two presses closed the app, so this is the better end; it
  // is still not what anyone wants. A2 (BUG-SHEETARMSWITHOUTTAP-001, arm on the next tap) is what
  // closes it, and the commit that does must change this test. It exists so that nothing ELSE changes
  // this state without notice: a dismissal on the second press, or a dead press on the third.
  it('KNOWN RESIDUAL, not a goal (RIA P-5; A2 = BUG-SHEETARMSWITHOUTTAP-001 closes it): after a second Back lands elsewhere inside the window, a sheet that is still mounted is left OPEN and UNARMED, and the next Back is the page\'s, not a dismissal', async () => {
    const onClose = vi.fn()
    const intercept = vi.fn(() => true)
    render(
      <DismissRegistryProvider>
        <Sheet open onClose={onClose} title="Door" armsBack backIntercept={intercept}><button>x</button></Sheet>
      </DismissRegistryProvider>
    )
    expect(armed()).toBe(true)
    const ret = holdReturn()

    await back()                                   // answered by the sheet; the return is in flight
    expect(intercept).toHaveBeenCalledTimes(1)
    expect(ret.held, 'SELF-TEST: the registry asked for exactly one return').toEqual([1])

    let before = pops
    await back()                                   // the second press, before the return has landed
    expect(pops, 'SELF-TEST: the second Back really traversed').toBe(before + 1)
    expect(window.history.state?.__base).toBe(1)   // it landed elsewhere: off the page's entry
    expect(intercept, 'one press was answered twice').toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
    expect(ret.held, 'the second press asked for a return of its own').toEqual([1])

    await ret.release()                            // the late return moves forward again; nobody acts on it
    // THE STATE, AS IT IS: the sheet is open and no marker is current.
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(armed()).toBe(false)
    expect(atFloor()).toBe(true)

    before = pops
    await back()                                   // the next Back is not the sheet's
    expect(pops, 'SELF-TEST: that Back really traversed').toBe(before + 1)
    expect(window.history.state?.__base, 'a dead press: the Back went nowhere').toBe(1)
    expect(intercept, 'the unarmed sheet was handed a Back').toHaveBeenCalledTimes(1)
    expect(onClose, 'the unarmed sheet was dismissed by a Back').not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
})

// RIA P-6 item 2 / M-2 — the orphan step-off is not only a return's safety net. ANY landing on a marker
// nobody holds is stepped off. The everyday case is the browser's Forward after a sheet was closed by
// Back: the marker entry is still there, one step forward (no API removes it), so Forward lands on it.
// Left there it would eat the next Back. Stepped off, Forward visibly does nothing, which is the
// accepted cost on desktop.
// MUTATION M5 (delete the step-off) -> red at "Forward was left standing on a stale marker".
describe('BUG-BACKTWICECLOSESAPP-001 — Forward onto a marker nobody holds', () => {
  it('a sheet closed by Back, then Forward: the registry steps back off the stale marker and dismisses nothing a second time', async () => {
    const onClose = vi.fn()
    function Host() {
      const [open, setOpen] = useState(true)
      return (
        <DismissRegistryProvider>
          {open && <Sheet open onClose={() => { onClose(); setOpen(false) }} title="Details" armsBack><button>x</button></Sheet>}
        </DismissRegistryProvider>
      )
    }
    render(<Host />)
    expect(armed(), 'SELF-TEST: the sheet was armed').toBe(true)

    await back()                                   // Back closes the sheet; its marker stays one step forward
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(atFloor()).toBe(true)

    let before = pops
    act(() => { window.history.go(1) })            // the browser's Forward
    await settle(before)
    expect(armed(), 'Forward was left standing on a stale marker').toBe(false)
    expect(atFloor(), 'the step-off did not land on the page\'s entry').toBe(true)
    // Two popstates: Forward landing on the marker, and the registry stepping back off it. One would
    // mean nothing stepped off; none would mean Forward had nowhere to go and this test saw nothing.
    expect(pops - before, 'SELF-TEST: Forward landed on the marker and was stepped off').toBe(2)
    expect(onClose, 'the sheet was dismissed a second time').toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()

    // NO DEAD PRESS, and the step-off's own popstate was not mistaken for a Back: the next Back
    // leaves the page.
    before = pops
    await back()
    expect(pops).toBe(before + 1)
    expect(window.history.state?.__base, 'that Back was eaten by the stale marker').toBe(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('ARM-EFFECT-SCALAR-ONLY — typing must not churn history', () => {
  // The single highest-risk line in the slice. If the arm effect keys on the entries ARRAY rather
  // than a scalar, every keystroke that flips `dirty` pushes and pops a history entry.
  it('20 keystrokes that flip dirty produce exactly ONE pushState', async () => {
    const spy = vi.spyOn(window.history, 'pushState')
    function Host() {
      const [v, setV] = useState('')
      return (
        <DismissRegistryProvider>
          <Sheet open onClose={() => {}} title="Form" dirty={v.length > 0} armsBack>
            <input aria-label="note" value={v} onChange={(ev) => setV(ev.target.value)} />
          </Sheet>
        </DismissRegistryProvider>
      )
    }
    render(<Host />)
    const before = spy.mock.calls.length
    const el = screen.getByLabelText('note')
    for (let i = 1; i <= 20; i++) act(() => { fireEvent.change(el, { target: { value: 'x'.repeat(i) } }) })
    expect(spy.mock.calls.length - before).toBe(0)
    spy.mockRestore()
  })
})

describe('scroll lock is released by a Back-driven close', () => {
  // The failure with NO in-app recovery: a stranded body{overflow:hidden} bricks scrolling until
  // reload. Nothing asserted this across a Back before.
  it('body overflow is restored after Back closes the sheet', async () => {
    function Host() {
      const [open, setOpen] = useState(true)
      return (
        <DismissRegistryProvider>
          <Sheet open={open} onClose={() => setOpen(false)} title="Details" armsBack><button>x</button></Sheet>
        </DismissRegistryProvider>
      )
    }
    render(<Host />)
    expect(document.body.style.overflow).toBe('hidden')
    await back()
    expect(document.body.style.overflow).toBe('')
    expect(document.body.style.overscrollBehavior).toBe('')
  })
})

describe('stale markers from a previously shipped bundle', () => {
  // history.state survives reload AND deploy, and the service worker serves JS cache-first — so a
  // v1 per-surface marker written by v3.103.0 can be sitting in the stack when this bundle boots.
  it('a v1 marker present at mount is stripped, not consumed', () => {
    window.history.replaceState({ ...SENTINEL, [MARKER_KEY]: { v: 1, id: 'lightbox' } }, '')
    render(<DismissRegistryProvider><span /></DismissRegistryProvider>)
    expect(window.history.state[MARKER_KEY]).toBeUndefined()
    expect(window.history.state.__floor).toBe(1)   // merged, not clobbered
  })
})

describe('flag OFF is provably inert', () => {
  it('no marker is written and Back does nothing', async () => {
    flags.BACKNAV_ENABLED = false
    const onClose = vi.fn()
    render(
      <DismissRegistryProvider>
        <Sheet open onClose={onClose} title="Details" armsBack><button>x</button></Sheet>
      </DismissRegistryProvider>
    )
    expect(readMarker(window.history.state)).toBeNull()
    expect(atFloor()).toBe(true)
    await back()
    expect(onClose).not.toHaveBeenCalled()
  })
})

// QA M-c — NO FIFTH SITE. The four no-push tests above cover the four answers onPop gives today.
// Nothing stops a fifth being added that pushes, and jsdom would not object: an entry made inside
// popstate works here and closes the app on the phone. So this reads the handler's own text. A weak
// instrument (it cannot follow a call into a helper), kept because the strong ones cannot see a branch
// nobody has written a case for.
//
// `arm(` is matched as a CALL (word-bounded): the handler's own comment says "disarm() found no marker
// under it", and that is not a push.
describe('STATIC — the popstate handler creates no history entry (BUG-BACKTWICECLOSESAPP-001)', () => {
  const start = REGISTRY_SRC.indexOf('function onPop() {')
  const end = REGISTRY_SRC.indexOf("window.addEventListener('popstate', onPop)")
  const onPopText = REGISTRY_SRC.slice(start, end)

  it('the source text of onPop contains no arm( call and no pushState', () => {
    expect(start, 'SELF-TEST: onPop was not found in DismissRegistry.jsx').toBeGreaterThan(-1)
    expect(end, 'SELF-TEST: the end of onPop was not found').toBeGreaterThan(start)
    // The slice really is the handler: it holds the decision and the returns to the marker.
    expect(onPopText, 'SELF-TEST: the slice is not the handler').toContain('decideBack(')
    expect(onPopText, 'SELF-TEST: the slice is not the handler').toContain('stepBackOn(')
    expect(/\barm\(/.test(onPopText), 'onPop calls arm(): that is a pushState inside popstate').toBe(false)
    expect(onPopText.includes('pushState'), 'onPop mentions pushState').toBe(false)
  })
})
