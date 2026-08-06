// V4-BACKNAV-001 Slice 1 — the shared dismiss registry, integration level.
//
// The headline case is a SHIPPED DEFECT this slice repairs with no Back involved: Lightbox binds a
// document keydown gated on nothing and never appeared in Sheet.jsx's openStack, so with a Sheet
// open underneath (PlantingDetail renders its Details Sheet and a Lightbox from independent state)
// ONE Escape fired BOTH onCloses. Reverting src/components/Lightbox.jsx and src/components/forms/
// Sheet.jsx to their pre-slice form makes 'closes exactly ONE surface' fail with 2 calls.
//
// Also pins the rollback contract: with DISMISS_REGISTRY_ENABLED false, nothing registers, the
// provider binds no listener, and both components fall back to their own per-instance handlers —
// which is what keeps ~380 pre-existing tests (that render these components with NO provider)
// passing untouched.
import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

const flags = { DISMISS_REGISTRY_ENABLED: true }
vi.mock('../lib/featureFlags.js', async (importOriginal) => ({
  ...(await importOriginal()),
  get DISMISS_REGISTRY_ENABLED() { return flags.DISMISS_REGISTRY_ENABLED },
}))

// Lightbox renders PhotoImg, which calls useApiFetch -> Clerk's useAuth and throws outside a
// ClerkProvider. Stubbed to a plain img: this file is about Escape arbitration, not image loading.
vi.mock('../components/PhotoImg.jsx', () => ({
  default: ({ alt }) => <img alt={alt || ''} src="stub" />,
}))

import Sheet from '../components/forms/Sheet.jsx'
import Lightbox from '../components/Lightbox.jsx'
import { DismissRegistryProvider } from '../context/DismissRegistry.jsx'

const IMAGES = [{ id: 'ph-1', url: 'https://example.test/a.jpg', alt: 'A' }]

function esc() {
  act(() => { fireEvent.keyDown(document, { key: 'Escape' }) })
}

describe('DismissRegistry — Escape arbitration across Sheet and Lightbox', () => {
  beforeEach(() => { flags.DISMISS_REGISTRY_ENABLED = true })

  it('closes exactly ONE surface per Escape, and it is the visually topmost (Lightbox over Sheet)', () => {
    const onSheetClose = vi.fn()
    const onLightboxClose = vi.fn()
    render(
      <DismissRegistryProvider>
        <Sheet open onClose={onSheetClose} title="Details"><button>inner</button></Sheet>
        <Lightbox open images={IMAGES} onClose={onLightboxClose} />
      </DismissRegistryProvider>
    )
    esc()
    // Pre-slice this was 1 and 1 — one press, two dismissals.
    expect(onLightboxClose).toHaveBeenCalledTimes(1)
    expect(onSheetClose).not.toHaveBeenCalled()
  })

  it('resolves by PAINT order, not insertion order — a Lightbox mounted FIRST still wins', () => {
    const onSheetClose = vi.fn()
    const onLightboxClose = vi.fn()
    render(
      <DismissRegistryProvider>
        <Lightbox open images={IMAGES} onClose={onLightboxClose} />
        <Sheet open onClose={onSheetClose} title="Details"><button>inner</button></Sheet>
      </DismissRegistryProvider>
    )
    esc()
    expect(onLightboxClose).toHaveBeenCalledTimes(1)
    expect(onSheetClose).not.toHaveBeenCalled()
  })

  it('stacked Sheets: the LAST opened closes, and only it', () => {
    const first = vi.fn()
    const second = vi.fn()
    render(
      <DismissRegistryProvider>
        <Sheet open onClose={first} title="First"><button>a</button></Sheet>
        <Sheet open onClose={second} title="Second"><button>b</button></Sheet>
      </DismissRegistryProvider>
    )
    esc()
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
  })

  it('after the topmost closes, the next Escape reaches the one beneath', () => {
    function Stack() {
      const [lightbox, setLightbox] = useState(true)
      const [sheet, setSheet] = useState(true)
      return (
        <DismissRegistryProvider>
          {sheet && <Sheet open onClose={() => setSheet(false)} title="Details"><button>inner</button></Sheet>}
          {lightbox && <Lightbox open images={IMAGES} onClose={() => setLightbox(false)} />}
          <span data-testid="state">{`${sheet ? 'S' : '-'}${lightbox ? 'L' : '-'}`}</span>
        </DismissRegistryProvider>
      )
    }
    render(<Stack />)
    expect(screen.getByTestId('state').textContent).toBe('SL')
    esc()
    expect(screen.getByTestId('state').textContent).toBe('S-')
    esc()
    expect(screen.getByTestId('state').textContent).toBe('--')
  })

  it('an Escape with nothing registered is not swallowed (no throw, no listener side effect)', () => {
    render(<DismissRegistryProvider><div>quiet</div></DismissRegistryProvider>)
    expect(() => esc()).not.toThrow()
  })

  // SINGLE-MODALITY INVARIANT (invalid ARIA otherwise; screen readers resolve it inconsistently).
  it('exactly one element claims aria-modal at a time', () => {
    render(
      <DismissRegistryProvider>
        <Sheet open onClose={() => {}} title="Details"><button>inner</button></Sheet>
        <Lightbox open images={IMAGES} onClose={() => {}} />
      </DismissRegistryProvider>
    )
    expect(document.querySelectorAll('[aria-modal="true"]').length).toBe(1)
  })
})

describe('DismissRegistry — flag OFF is a true rollback', () => {
  beforeEach(() => { flags.DISMISS_REGISTRY_ENABLED = false })

  it('does not register, and each surface handles its own Escape as before the slice', () => {
    const onSheetClose = vi.fn()
    render(
      <DismissRegistryProvider>
        <Sheet open onClose={onSheetClose} title="Details"><button>inner</button></Sheet>
      </DismissRegistryProvider>
    )
    esc()
    expect(onSheetClose).toHaveBeenCalledTimes(1)   // legacy per-instance path still live
  })

  it('flag OFF restores the pre-slice unconditional aria-modal on every surface', () => {
    render(
      <DismissRegistryProvider>
        <Sheet open onClose={() => {}} title="Details"><button>inner</button></Sheet>
        <Lightbox open images={IMAGES} onClose={() => {}} />
      </DismissRegistryProvider>
    )
    // Two modal claimants is the pre-slice (invalid-ARIA) state — pinning it proves the flag really
    // does return the app to its old behaviour rather than half-applying the new one.
    expect(document.querySelectorAll('[aria-modal="true"]').length).toBe(2)
  })
})

describe('DismissRegistry — no provider (isolated unit tests / legacy render paths)', () => {
  beforeEach(() => { flags.DISMISS_REGISTRY_ENABLED = true })

  it('a Sheet rendered with NO provider still closes on Escape', () => {
    const onClose = vi.fn()
    render(<Sheet open onClose={onClose} title="Details"><button>inner</button></Sheet>)
    esc()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('Sheet focus restore — detached-node guard (SC 2.4.3)', () => {
  beforeEach(() => { flags.DISMISS_REGISTRY_ENABLED = true })

  it('restores focus to the invoking control when it is still in the document', () => {
    function Harness() {
      const [open, setOpen] = useState(false)
      return (
        <DismissRegistryProvider>
          <button onClick={() => setOpen(true)}>open me</button>
          <Sheet open={open} onClose={() => {}} title="Details"><button>inner</button></Sheet>
          <button onClick={() => setOpen(false)}>close</button>
        </DismissRegistryProvider>
      )
    }
    render(<Harness />)
    const trigger = screen.getByText('open me')
    // fireEvent.click does NOT move focus in jsdom, so focus the trigger explicitly first —
    // otherwise restoreRef captures <body> and this would pass for the wrong reason.
    act(() => { trigger.focus() })
    act(() => { fireEvent.click(trigger) })
    act(() => { fireEvent.click(screen.getByText('close')) })
    expect(document.activeElement).toBe(trigger)
  })

  // NEGATIVE pin, and deliberately honest about what it asserts. The guard makes the detached case
  // explicit; it does NOT repair it, because the app has no <main>/landmark to fall back to (see
  // the comment in Sheet.jsx). So the contract this pins is "does not throw, and does not focus a
  // node that has left the document" — NOT "focus lands somewhere useful". If a later slice adds a
  // focus landmark, THIS is the test that should change to assert the stronger property.
  it('does not throw, and does not focus a detached node, when the invoking control is gone', () => {
    function Harness() {
      const [open, setOpen] = useState(false)
      const [showTrigger, setShowTrigger] = useState(true)
      return (
        <DismissRegistryProvider>
          {showTrigger && <button onClick={() => setOpen(true)}>open me</button>}
          <Sheet open={open} onClose={() => {}} title="Details"><button>inner</button></Sheet>
          <button onClick={() => { setShowTrigger(false); setOpen(false) }}>close and destroy trigger</button>
        </DismissRegistryProvider>
      )
    }
    render(<Harness />)
    const trigger = screen.getByText('open me')
    act(() => { fireEvent.click(trigger) })
    expect(() => {
      act(() => { fireEvent.click(screen.getByText('close and destroy trigger')) })
    }).not.toThrow()
    expect(trigger.isConnected).toBe(false)
    expect(document.activeElement).not.toBe(trigger)
  })
})
