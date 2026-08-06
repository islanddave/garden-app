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

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 50)) })
const back = async () => { act(() => { window.history.back() }); await settle() }
const esc = () => act(() => { fireEvent.keyDown(document, { key: 'Escape' }) })

// A floor entry, so we are never AT index 0 when a test calls back(). Its sentinel is asserted
// immediately before every traversal under test, which is what makes a silent no-op distinguishable
// from a handled Back.
//
// atFloor must ALSO require the absence of our marker: arm() MERGES history.state, so the marker
// entry carries __floor forward too (that merge is required — react-router owns {usr,key,idx}).
// Checking the sentinel alone cannot tell "armed" from "back at the floor".
const SENTINEL = { __floor: 1 }
const armed = () => !!readMarker(window.history.state)
const atFloor = () => !armed() && window.history.state?.__floor === 1

beforeEach(() => {
  flags.DISMISS_REGISTRY_ENABLED = true
  flags.BACKNAV_ENABLED = true
  window.history.replaceState(SENTINEL, '')
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
    await back()
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
