// V4-BACKNAV-001 Slice 3 (pre-work) — a descendant that HANDLES Escape itself must not also lose
// its hosting surface to the registry.
//
// THE SHIPPED DEFECT THIS PINS. VarietyPicker owns a multi-stage create flow whose Escape steps the
// stage back (VarietyPicker.jsx:293 newcrop->crop, :304 crop->null, :322 close the listbox). All
// three call e.preventDefault() and NONE call e.stopPropagation(). React 18 attaches synthetic
// handlers at the root CONTAINER, which is a descendant of `document`, so the event continues on to
// the registry's document keydown (DismissRegistry.jsx) — which did not consult e.defaultPrevented.
// Net effect in prod: one Escape at a create stage steps the stage back AND closes the Sheet the
// picker is sitting in.
//
// This is the SAME class Slice 1 fixed for Lightbox and Slice 2 for CritterFactsPopover — an
// ungated handler firing a second dismissal — but arriving from the opposite direction: not a
// surface that failed to register, a DESCENDANT that legitimately consumed the key first.
//
// The fix is a one-line guard in the registry rather than N stopPropagation() calls at the call
// sites, because the guard covers descendants nobody has enumerated yet. The call sites should
// ALSO stopPropagation (belt and braces), but the guard is what makes the class unreachable.
//
// Deliberately uses a minimal stand-in rather than the real VarietyPicker: the behaviour under test
// belongs to the REGISTRY, and driving the real picker would need crop-type fetches, a combobox
// open state and a create stage — coupling this pin to unrelated surface area. The stand-in
// reproduces the exact DOM relationship that matters (a focusable descendant inside a registered
// surface, calling preventDefault and not stopPropagation).
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

const flags = { DISMISS_REGISTRY_ENABLED: true }
vi.mock('../lib/featureFlags.js', async (importOriginal) => ({
  ...(await importOriginal()),
  get DISMISS_REGISTRY_ENABLED() { return flags.DISMISS_REGISTRY_ENABLED },
}))

import Sheet from '../components/forms/Sheet.jsx'
import { DismissRegistryProvider } from '../context/DismissRegistry.jsx'

// Mirrors VarietyPicker's shape: consumes Escape to step its own sub-state back, marks the event
// handled with preventDefault, and does NOT stopPropagation.
function StagedInput({ onStepBack }) {
  return (
    <input
      aria-label="variety"
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onStepBack() } }}
    />
  )
}

describe('registry Escape respects a descendant that already handled the key', () => {
  beforeEach(() => { flags.DISMISS_REGISTRY_ENABLED = true })

  it('a descendant that preventDefaults Escape steps back WITHOUT closing the hosting Sheet', () => {
    const onSheetClose = vi.fn()
    const onStepBack = vi.fn()
    render(
      <DismissRegistryProvider>
        <Sheet open onClose={onSheetClose} title="Add planting">
          <StagedInput onStepBack={onStepBack} />
        </Sheet>
      </DismissRegistryProvider>
    )

    act(() => { fireEvent.keyDown(screen.getByLabelText('variety'), { key: 'Escape' }) })

    expect(onStepBack).toHaveBeenCalledTimes(1)
    // The defect: the registry also dismissed the Sheet, so one Escape did two things.
    expect(onSheetClose).not.toHaveBeenCalled()
  })

  // The guard must not swallow the ordinary case — Escape with nothing consuming it still closes
  // the topmost surface. Asserting BOTH directions, because a guard that always returns early
  // would pass the test above while silently disabling Escape app-wide.
  it('Escape that no descendant handled still closes the topmost surface', () => {
    const onSheetClose = vi.fn()
    render(
      <DismissRegistryProvider>
        <Sheet open onClose={onSheetClose} title="Add planting">
          <input aria-label="plain" />
        </Sheet>
      </DismissRegistryProvider>
    )

    act(() => { fireEvent.keyDown(screen.getByLabelText('plain'), { key: 'Escape' }) })

    expect(onSheetClose).toHaveBeenCalledTimes(1)
  })

  // A descendant handling a DIFFERENT key must not make Escape inert afterwards — pins that the
  // guard reads the current event, not any sticky state.
  it('a descendant consuming ArrowDown does not suppress a later Escape', () => {
    const onSheetClose = vi.fn()
    render(
      <DismissRegistryProvider>
        <Sheet open onClose={onSheetClose} title="Add planting">
          <input
            aria-label="combo"
            onKeyDown={(e) => { if (e.key === 'ArrowDown') e.preventDefault() }}
          />
        </Sheet>
      </DismissRegistryProvider>
    )

    const el = screen.getByLabelText('combo')
    act(() => { fireEvent.keyDown(el, { key: 'ArrowDown' }) })
    expect(onSheetClose).not.toHaveBeenCalled()

    act(() => { fireEvent.keyDown(el, { key: 'Escape' }) })
    expect(onSheetClose).toHaveBeenCalledTimes(1)
  })
})
