// PlantingSelectDismiss.test.jsx — BUG-PICKERUNDISMISSABLE-001.
//
// THE DEFECT. On the harvest fast path (header Harvest action -> /log?event_type=harvest, an
// OverlayLink, so EventNew renders inside a kind='route' Sheet) the planting picker auto-opens with
// NO user gesture and, deliberately, NO focus — forcing focus there would summon the Android
// keyboard over the list the user came to read. Every exit the panel had assumed one of the two:
//   * onBlur's deferred close needs the input to have been focused. It never was.
//   * the Escape branch needs an Escape key. Chrome for Android has none.
//   * Tab, likewise.
// and the panel paints no backdrop, so a tap outside lands on the page beneath and changes nothing.
// EventNew additionally hides its sticky Save while the picker is open, so the form had no visible
// control at all. Committing a planting was the only way out of the app's most frequent form —
// ~32% of Dave's logged actions — and Back discarded the whole half-filled form, because the route
// overlay is the router's to close (decideBack returns NONE for kind='route').
//
// WHAT THIS SUITE PINS: the auto-open still fires and still does not steal focus; the panel now
// carries a visible labelled exit; Back closes the PANEL and leaves the form standing; and none of
// that costs the fast path — the picker still re-opens and still commits a selection afterwards.
//
// WHAT IT CANNOT PROVE. That a real Android Back gesture behaves this way on Dave's handset, or
// that the soft keyboard stayed down. jsdom has neither. Those are the GATE-A device-pass items
// (tests/device/GATE-A.md); this file pins the inputs that pass is entitled to assume — the same
// honesty scoping as PlantingSelectA11y/Keyboard.
import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

const flags = { DISMISS_REGISTRY_ENABLED: true, BACKNAV_ENABLED: true }
vi.mock('../lib/featureFlags.js', async (importOriginal) => ({
  ...(await importOriginal()),
  get DISMISS_REGISTRY_ENABLED() { return flags.DISMISS_REGISTRY_ENABLED },
  get BACKNAV_ENABLED() { return flags.BACKNAV_ENABLED },
}))

const apiFetchSpy = vi.hoisted(() => vi.fn(() => Promise.resolve([])))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: apiFetchSpy }) }))

import PlantingSelect from '../components/forms/PlantingSelect.jsx'
import Sheet from '../components/forms/Sheet.jsx'
import { DismissRegistryProvider } from '../context/DismissRegistry.jsx'
import { readMarker } from '../lib/backNav.js'

const PLANTS = [
  { id: 'p1', name: 'Sungold', quantity: 1 },
  { id: 'p2', name: 'Jalapeño', quantity: 1 },
  { id: 'p3', name: 'Dark Green Zucchini', quantity: 1 },
]

const field = () => screen.getByRole('combobox')
const panel = () => screen.queryByRole('listbox')
const closeBtn = () => screen.queryByRole('button', { name: 'Close the planting list' })

// Ported verbatim from BackNav.history.test.jsx, whose header records the measured jsdom facts this
// depends on: popstate needs >0ms to settle, and back() at index 0 is a SILENT no-op — which would
// false-PASS "the panel closed" for the wrong reason. Hence the floor sentinel and its self-test.
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 50)) })
const back = async () => { act(() => { window.history.back() }); await settle() }
const SENTINEL = { __floor: 1 }
const armed = () => !!readMarker(window.history.state)
const atFloor = () => !armed() && window.history.state?.__floor === 1

beforeEach(() => {
  flags.DISMISS_REGISTRY_ENABLED = true
  flags.BACKNAV_ENABLED = true
  window.history.replaceState(SENTINEL, '')
})
afterEach(() => { document.body.style.overflow = ''; document.body.style.overscrollBehavior = '' })

// The real host shape: a kind='route' Sheet (App.jsx's OverlayHost) wrapping the form. `onDismiss`
// is the ROUTE's close — the thing that must NOT fire when Back is meant for the panel.
//
// The leading button is not filler. Sheet's open effect focuses the FIRST focusable in its panel,
// and on EventNew's harvest layout the planting field is not it (the harvest tray toggle and the
// blocks above it come first), so the panel opens with the input UNFOCUSED — the state in which
// onBlur's deferred close can never fire. Render the picker alone in a Sheet and the Sheet hands it
// focus, which quietly hides exactly the case under test. `leadingFocusable={false}` is the other
// arrangement, asserted separately.
function HarvestArrival({ onDismiss = () => {}, onChange = () => {}, leadingFocusable = true, ...props }) {
  const [value, setValue] = useState('')
  return (
    <DismissRegistryProvider>
      <Sheet open onClose={onDismiss} ariaLabel="Log an event" kind="route">
        {leadingFocusable && <button type="button">What happened?</button>}
        <PlantingSelect
          plants={PLANTS}
          value={value}
          onChange={(id, p) => { setValue(id); onChange(id, p) }}
          aria-label="Plant or group"
          autoOpen
          {...props}
        />
      </Sheet>
    </DismissRegistryProvider>
  )
}

describe('SELF-TEST — the harness, before any behaviour is asserted', () => {
  it('SELF-TEST/not-at-index-0: the floor sentinel is current before each traversal', () => {
    expect(atFloor()).toBe(true)
  })
})

describe('BUG-PICKERUNDISMISSABLE-001 — the auto-open survives', () => {
  it('auto-opens the panel with no user gesture', () => {
    render(<HarvestArrival />)
    expect(panel()).toBeTruthy()
    expect(field().getAttribute('aria-expanded')).toBe('true')
  })

  // The clause the whole fix had to preserve: an auto-open that focused the field would raise the
  // Android keyboard over the list, which is why autoOpen never focused. The dismiss affordance
  // must not smuggle that back in — and this is also the pre-fix trap, since an input that was
  // never focused can never blur, and blur was the only tap-driven close the panel had.
  it('does not steal focus on the auto-open, so no keyboard is summoned', () => {
    render(<HarvestArrival />)
    expect(panel()).toBeTruthy()
    expect(document.activeElement).not.toBe(field())
  })
})

describe('BUG-PICKERUNDISMISSABLE-001 — a visible exit', () => {
  it('renders a labelled close control while the panel is open, and none when it is closed', () => {
    render(<HarvestArrival />)
    expect(closeBtn()).toBeTruthy()
    fireEvent.click(closeBtn())
    expect(panel()).toBeNull()
    expect(closeBtn()).toBeNull()
  })

  it('closes the panel on tap', () => {
    render(<HarvestArrival />)
    fireEvent.click(closeBtn())
    expect(panel()).toBeNull()
    expect(field().getAttribute('aria-expanded')).toBe('false')
  })

  // Its mousedown MUST be default-prevented. With the field focused that preventDefault is what
  // stops a blur racing the close; with the field UNfocused (the auto-open path) it is what stops
  // the tap giving the input focus and raising the keyboard on the way out.
  it('prevents mousedown, so dismissing never moves focus into the field', () => {
    render(<HarvestArrival />)
    const prevented = !fireEvent.mouseDown(closeBtn())
    expect(prevented).toBe(true)
    expect(document.activeElement).not.toBe(field())
  })

  // The other arrangement: the picker IS the sheet's first focusable, so it holds focus. Closing
  // must leave focus in the combobox (APG, and the same rule the Escape branch follows) rather than
  // dropping the TalkBack cursor to <body>.
  it('keeps focus in the combobox when the field did hold it', () => {
    render(<HarvestArrival leadingFocusable={false} />)
    expect(document.activeElement).toBe(field())
    fireEvent.click(closeBtn())
    expect(panel()).toBeNull()
    expect(document.activeElement).toBe(field())
  })
})

describe('BUG-PICKERUNDISMISSABLE-001 — Android Back closes the panel, not the form', () => {
  it('arms a history entry while the panel is open', () => {
    render(<HarvestArrival />)
    expect(armed()).toBe(true)
  })

  it('one Back closes the panel and leaves the route overlay standing', async () => {
    const onDismiss = vi.fn()
    render(<HarvestArrival onDismiss={onDismiss} />)
    expect(armed()).toBe(true)
    await back()
    expect(panel()).toBeNull()
    expect(onDismiss).not.toHaveBeenCalled()
    expect(atFloor()).toBe(true)
  })

  // Parity with Back, through the same arbiter: the panel outranks the route Sheet it opened
  // inside, so Escape must not close the form out from under it either.
  it('Escape resolves to the panel, not to the route overlay beneath it', () => {
    const onDismiss = vi.fn()
    render(<HarvestArrival onDismiss={onDismiss} />)
    act(() => { fireEvent.keyDown(document, { key: 'Escape' }) })
    expect(panel()).toBeNull()
    expect(onDismiss).not.toHaveBeenCalled()
  })
})

describe('BUG-PICKERUNDISMISSABLE-001 — the fast path still works after a dismissal', () => {
  it('re-opens on tap and still commits a selection after the close control was used', () => {
    const onChange = vi.fn()
    render(<HarvestArrival onChange={onChange} />)
    fireEvent.click(closeBtn())
    expect(panel()).toBeNull()

    fireEvent.click(field())
    expect(panel()).toBeTruthy()
    fireEvent.click(screen.getByTestId('ps-opt-p1'))
    expect(onChange).toHaveBeenCalledWith('p1', expect.objectContaining({ id: 'p1' }))
  })

  it('re-opens and still commits a selection after Back dismissed the panel', async () => {
    const onChange = vi.fn()
    const onDismiss = vi.fn()
    render(<HarvestArrival onChange={onChange} onDismiss={onDismiss} />)
    await back()
    expect(panel()).toBeNull()

    fireEvent.click(field())
    fireEvent.click(screen.getByTestId('ps-opt-p2'))
    expect(onChange).toHaveBeenCalledWith('p2', expect.objectContaining({ id: 'p2' }))
    expect(onDismiss).not.toHaveBeenCalled()
  })

  // The seam that gives EventNew its Save button back. It hides the sticky Save while the picker is
  // open (V4-PICKERUX-001 — Save was painting over rows 2-3 and taking their taps), so a dismissal
  // that closed the panel WITHOUT reporting it would leave the form with no visible Save at all —
  // trading one dead end for another. Asserted for BOTH new dismissal paths.
  it('reports the close through onOpenChange, on the control and on Back alike', async () => {
    const onOpenChange = vi.fn()
    render(<HarvestArrival onOpenChange={onOpenChange} />)
    expect(onOpenChange).toHaveBeenLastCalledWith(true)

    fireEvent.click(closeBtn())
    expect(onOpenChange).toHaveBeenLastCalledWith(false)

    // Settle before re-opening. Closing disarms, which is a history TRAVERSAL, and jsdom needs >0ms
    // for one (BackNav.history.test.jsx's measured facts). Pushing a fresh marker inside that window
    // is a test artefact — two taps by a human are never 0ms apart — and it scrambles the stack the
    // Back below is asserting on.
    await settle()
    fireEvent.click(field())
    expect(onOpenChange).toHaveBeenLastCalledWith(true)
    await back()
    expect(onOpenChange).toHaveBeenLastCalledWith(false)
  })

  // Committing from the AUTO-OPENED panel — the fast path itself — is untouched: no dismissal, one
  // tap from arrival to a chosen planting.
  it('commits straight from the auto-opened panel, with no intervening gesture', () => {
    const onChange = vi.fn()
    render(<HarvestArrival onChange={onChange} />)
    fireEvent.click(screen.getByTestId('ps-opt-p3'))
    expect(onChange).toHaveBeenCalledWith('p3', expect.objectContaining({ id: 'p3' }))
  })
})
