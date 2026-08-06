// V4-BACKNAV-001 Slice 2 — the remaining 7 role="dialog" surfaces join the registry.
//
// Slice 1 registered Sheet and Lightbox. This pins the rest, and the two behaviours that only
// become possible once they are all in ONE stack:
//   (a) one Escape closes exactly one surface, chosen by paint order, ACROSS component families;
//   (b) `busy` blocks the dismiss for the surfaces with an in-flight write — the only way
//       SpaceAttachPicker and FacebookShareSheet could join without regressing the guards they
//       already hand-rolled.
//
// Uses the real components, not stand-ins, because the thing under test is precisely that these
// specific files stopped binding their own ungated document/window keydowns.
import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

const flags = { DISMISS_REGISTRY_ENABLED: true }
vi.mock('../lib/featureFlags.js', async (importOriginal) => ({
  ...(await importOriginal()),
  get DISMISS_REGISTRY_ENABLED() { return flags.DISMISS_REGISTRY_ENABLED },
}))
vi.mock('../components/PhotoImg.jsx', () => ({ default: ({ alt }) => <img alt={alt || ''} src="stub" /> }))
// useShareToFacebook drives FacebookShareSheet's `state`; drive it from the test instead.
const fbState = { state: 'idle' }
vi.mock('../hooks/useShareToFacebook.js', () => ({
  useShareToFacebook: () => ({
    get state() { return fbState.state },
    result: null, error: null, share: vi.fn(), reset: vi.fn(),
  }),
}))

import Sheet from '../components/forms/Sheet.jsx'
import CritterFactsPopover from '../components/CritterFactsPopover.jsx'
import LoveMehPopover from '../components/LoveMehPopover.jsx'
import FacebookShareSheet from '../components/FacebookShareSheet.jsx'
import { DismissRegistryProvider } from '../context/DismissRegistry.jsx'

const esc = () => act(() => { fireEvent.keyDown(document, { key: 'Escape' }) })

const CRITTER = { id: 'c1', common_name: 'Ladybug', slug: 'ladybug' }

describe('Slice 2 — non-Sheet dialogs arbitrate through the one registry', () => {
  beforeEach(() => { flags.DISMISS_REGISTRY_ENABLED = true; fbState.state = 'idle' })

  // CritterFactsPopover bound an UNGATED document keydown. Over an open Sheet, one Escape fired
  // both onCloses. This is the same shipped-defect class Slice 1 fixed for Lightbox.
  it('a popover over a Sheet closes ONLY the popover', () => {
    const onSheetClose = vi.fn()
    const onPopoverClose = vi.fn()
    render(
      <DismissRegistryProvider>
        <Sheet open onClose={onSheetClose} title="Details"><button>inner</button></Sheet>
        <CritterFactsPopover critter={CRITTER} theme={{}} content={{}} onClose={onPopoverClose} />
      </DismissRegistryProvider>
    )
    esc()
    expect(onPopoverClose).toHaveBeenCalledTimes(1)
    expect(onSheetClose).not.toHaveBeenCalled()
  })

  it('two non-Sheet popovers: the later one wins (same layer, insertion order)', () => {
    const first = vi.fn()
    const second = vi.fn()
    render(
      <DismissRegistryProvider>
        <CritterFactsPopover critter={CRITTER} theme={{}} content={{}} onClose={first} />
        <LoveMehPopover open onClose={second} />
      </DismissRegistryProvider>
    )
    esc()
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
  })

  // THE busy CONTRACT. FacebookShareSheet is the one surface in the app with a non-idempotent
  // in-flight action; it already disabled its Close button while posting but had NO Escape handler
  // at all. Registering ADDS Escape — blockOnBusy is what stops that becoming a way to abandon a
  // post mid-flight.
  it('Escape closes the share sheet when idle', () => {
    const onClose = vi.fn()
    render(<DismissRegistryProvider><FacebookShareSheet open photos={[]} onClose={onClose} /></DismissRegistryProvider>)
    esc()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Escape is REFUSED while a post is in flight (busy blocks the dismiss)', () => {
    fbState.state = 'posting'
    const onClose = vi.fn()
    render(<DismissRegistryProvider><FacebookShareSheet open photos={[]} onClose={onClose} /></DismissRegistryProvider>)
    esc()
    expect(onClose).not.toHaveBeenCalled()
  })

  // busy is read from the TOPMOST only — a buried busy surface must not freeze the whole app.
  it('a busy surface underneath does not block dismissing the one on top', () => {
    fbState.state = 'posting'
    const onShareClose = vi.fn()
    const onPopoverClose = vi.fn()
    render(
      <DismissRegistryProvider>
        <FacebookShareSheet open photos={[]} onClose={onShareClose} />
        <CritterFactsPopover critter={CRITTER} theme={{}} content={{}} onClose={onPopoverClose} />
      </DismissRegistryProvider>
    )
    esc()
    expect(onPopoverClose).toHaveBeenCalledTimes(1)
    expect(onShareClose).not.toHaveBeenCalled()
  })

  it('single-modality holds across the mixed family', () => {
    render(
      <DismissRegistryProvider>
        <Sheet open onClose={() => {}} title="Details"><button>inner</button></Sheet>
        <CritterFactsPopover critter={CRITTER} theme={{}} content={{}} onClose={() => {}} />
      </DismissRegistryProvider>
    )
    expect(document.querySelectorAll('[aria-modal="true"]').length).toBe(1)
  })

  it('closing the top surface hands arbitration back to the one beneath', () => {
    function Stack() {
      const [sheet, setSheet] = useState(true)
      const [pop, setPop] = useState(true)
      return (
        <DismissRegistryProvider>
          {sheet && <Sheet open onClose={() => setSheet(false)} title="Details"><button>inner</button></Sheet>}
          {pop && <CritterFactsPopover critter={CRITTER} theme={{}} content={{}} onClose={() => setPop(false)} />}
          <span data-testid="s">{`${sheet ? 'S' : '-'}${pop ? 'P' : '-'}`}</span>
        </DismissRegistryProvider>
      )
    }
    render(<Stack />)
    expect(screen.getByTestId('s').textContent).toBe('SP')
    esc()
    expect(screen.getByTestId('s').textContent).toBe('S-')
    esc()
    expect(screen.getByTestId('s').textContent).toBe('--')
  })
})

describe('Slice 2 — flag OFF restores every legacy handler', () => {
  beforeEach(() => { flags.DISMISS_REGISTRY_ENABLED = false; fbState.state = 'idle' })

  it('the popover handles its own Escape again, and double-fires as it did before', () => {
    const onSheetClose = vi.fn()
    const onPopoverClose = vi.fn()
    render(
      <DismissRegistryProvider>
        <Sheet open onClose={onSheetClose} title="Details"><button>inner</button></Sheet>
        <CritterFactsPopover critter={CRITTER} theme={{}} content={{}} onClose={onPopoverClose} />
      </DismissRegistryProvider>
    )
    esc()
    // Pinning the OLD behaviour on purpose: this is the defect the registry removes, and proving
    // the flag brings it back is what proves the flag is a real rollback rather than a half-apply.
    expect(onPopoverClose).toHaveBeenCalledTimes(1)
    expect(onSheetClose).toHaveBeenCalledTimes(1)
  })
})
