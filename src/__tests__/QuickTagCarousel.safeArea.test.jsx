// QuickTagCarousel.safeArea.test.jsx — V4-PHOTOBULK-001 S6.
//
// A STATIC guard, on purpose, for a defect no rendering test can reach.
//
// The app sets viewport-fit=cover, so a full-bleed `position: fixed` overlay that pads with plain
// pixels puts its header under the status bar and its action row under the gesture bar on a real
// phone. Every other full-screen surface in this codebase already pads with env(safe-area-inset-*)
// — Lightbox, ConfirmSheet, PhotoHero, SpaceAttachPicker — so this is a house convention, and the
// failure mode is that a new overlay silently does not join it.
//
// WHY NOT A RENDERED ASSERTION. jsdom does not implement env(), and neither does the browser harness
// in any useful way: desktop Chrome resolves both insets to 0, so the layout measures perfectly
// clean at 390x844 while being wrong on the only device that matters. There is no environment
// available to CI in which the correct and incorrect versions differ. So the guard reads the source
// — a weak instrument, chosen because the strong ones cannot see this at all, and far better than
// the nothing that was here before.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(resolve(here, '../components/photo/QuickTagCarousel.jsx'), 'utf8')

describe('QuickTagCarousel — safe-area insets', () => {
  it('pads the header for the top inset', () => {
    expect(src).toMatch(/paddingTop:\s*'calc\([^']*env\(safe-area-inset-top/)
  })

  it('pads the action band for the bottom inset', () => {
    expect(src).toMatch(/env\(safe-area-inset-bottom/)
  })

  it('is still a full-bleed fixed overlay — the reason the insets are needed', () => {
    // If this ever stops being position:fixed/inset:0, the insets above may become wrong rather
    // than merely unnecessary, and this file should be revisited rather than deleted.
    expect(src).toMatch(/position:\s*'fixed',\s*inset:\s*0/)
  })
})
