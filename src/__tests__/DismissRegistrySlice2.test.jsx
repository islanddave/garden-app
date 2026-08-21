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
// useShareToSocial drives FacebookShareSheet's `state`; drive it from the test instead.
// (Was useShareToFacebook until V4-IGSHARE-001 made the sheet post to both targets. Mocking the
// module the component no longer imports would leave this suite silently exercising the REAL hook
// against an unmocked api.js — the mock would be inert rather than loudly wrong.)
const fbState = { state: 'idle' }
// The whole module is replaced — NOT importOriginal()-spread. This suite does not mock
// ../lib/api.js, and the real useShareToSocial imports useApiFetch from it, which pulls in
// @clerk/react. Spreading the original therefore drags Clerk into a suite that only wants to drive
// `state`, and the file collects its tests then runs ZERO of them with one module-level error —
// a 189s no-op that reads as a hang, not a failure. The two pure helpers are stubbed instead
// because the sheet calls them on every render; their real values are irrelevant to dismissal.
// The returned object and its members are HOISTED, not rebuilt per call. A `reset: vi.fn()` inside
// the factory mints a new function identity on every render, and the sheet's open-effect lists
// `reset` in its deps — so an unstable identity re-fires the effect every render. Paired with a
// non-bailing setState that is an unbounded loop; this exact mock is what surfaced it.
const shareStub = { facebook: null, instagram: null }
const shareFn = vi.fn()
const resetFn = vi.fn()
vi.mock('../hooks/useShareToSocial.js', () => ({
  captionLimitFor: () => 5000,
  validateForTargets: () => [],
  useShareToSocial: () => ({
    get state() { return fbState.state },
    perTarget: shareStub, share: shareFn, reset: resetFn,
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

  // CORRECTED 2026-08-06 (Slice 3a layer/paint alignment). This test used to assert that the LATER
  // popover wins "same layer, insertion order" — but the two are NOT on the same layer and never
  // were: CritterFactsPopover paints zIndex 1000, LoveMehPopover paints 200. They only tied because
  // LoveMehPopover was registered at LAYER.DIALOG while painting 200, one of four surfaces whose
  // registered layer disagreed with its paint. The old expectation therefore pinned the DEFECT:
  // Escape closed the popover UNDERNEATH while the one the user could see stayed open.
  //
  // With the layers corrected, paint order and arbitration order agree and the visibly-topmost
  // surface is the one that closes. Insertion-order tie-breaking is still exercised — by the
  // preceding test, where the two surfaces genuinely do share a layer.
  it('the visibly-topmost popover closes, even though it was inserted FIRST', () => {
    const facts = vi.fn()
    const loveMeh = vi.fn()
    render(
      <DismissRegistryProvider>
        <CritterFactsPopover critter={CRITTER} theme={{}} content={{}} onClose={facts} />
        <LoveMehPopover open onClose={loveMeh} />
      </DismissRegistryProvider>
    )
    esc()
    expect(facts).toHaveBeenCalledTimes(1)
    expect(loveMeh).not.toHaveBeenCalled()
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

// Pre-promote regression pass (2026-08-06) findings, pinned so they cannot silently return.
describe('Slice 2 — pre-promote regression fixes', () => {
  beforeEach(() => { flags.DISMISS_REGISTRY_ENABLED = true })

  // A duplicate aria-modal attribute shipped in the built bundle: the later literal won, so this
  // surface ALWAYS claimed modality and the single-modality invariant was broken on 1 of 10
  // surfaces. Nothing caught it — eslint has no react plugin, the build is happy with duplicate
  // JSX attributes, and no test rendered it. A source assertion is the cheapest real guard.
  it('no source file declares aria-modal twice on one element', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs')
    const { join } = await import('node:path')
    const SRC = join(process.cwd(), 'src') + '/'
    const walk = (d, out = []) => {
      for (const n of readdirSync(d)) {
        if (n === '__tests__' || n === 'node_modules') continue
        const f = join(d, n)
        statSync(f).isDirectory() ? walk(f, out) : /\.jsx?$/.test(n) && out.push(f)
      }
      return out
    }
    // Comment lines are excluded first — the same trap modalSurfaceFreeze hit: this codebase
    // documents heavily and three files DISCUSS aria-modal in prose, which a raw scan reports as
    // duplicates. A scanner that over-reports gets muted; one that under-reports passes while blind.
    const isCommentLine = (l) => {
      const t = l.trim()
      return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('{/*')
    }
    const offenders = walk(SRC).filter((f) => {
      const src = readFileSync(f, 'utf8').split('\n').filter((l) => !isCommentLine(l)).join('\n')
      // Two aria-modal attributes inside the same opening tag (no intervening '>').
      return /aria-modal[^>]*aria-modal/.test(src)
    })
    expect(offenders).toEqual([])
  })
})

describe('Sheet backdrop — busy guard (pre-promote fix)', () => {
  beforeEach(() => { flags.DISMISS_REGISTRY_ENABLED = true })

  // Moving TransplantDatePrompt from dirty={saving} to busy={saving} was semantically right but
  // silently dropped its backdrop protection: Sheet's no-op was gated on `dirty` alone. On mobile a
  // stray backdrop tap is far likelier than an Escape press, so that was a net regression on the
  // surface's dominant interaction.
  it('a backdrop tap no-ops while a write is in flight', () => {
    const onClose = vi.fn()
    const { container } = render(
      <DismissRegistryProvider>
        <Sheet open busy onClose={onClose} title="Saving"><button>inner</button></Sheet>
      </DismissRegistryProvider>
    )
    fireEvent.click(container.querySelector('div[style*="position: fixed"]'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('a backdrop tap still closes when idle', () => {
    const onClose = vi.fn()
    const { container } = render(
      <DismissRegistryProvider>
        <Sheet open onClose={onClose} title="Idle"><button>inner</button></Sheet>
      </DismissRegistryProvider>
    )
    fireEvent.click(container.querySelector('div[style*="position: fixed"]'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
