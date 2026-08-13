// PlantingSelectPlacement.test.jsx — V4-PICKERUX-001 P1.
//
// The "only about three rows fit" half of Dave's report. Separate defect from the P0 Save
// collision that shared its symptom: the listbox opened downward only, at a hardcoded 280px, with
// no measurement of the space actually below the input.
//
// WHAT THIS FILE CAN AND CANNOT PROVE. jsdom has no layout engine, so it cannot tell you where the
// panel lands on screen. What IS deterministic — and is the entire decision logic — is the mapping
// from (input rect, visual viewport) to (flip, maxHeight). So this stubs those two inputs and pins
// the arithmetic. The paint still needs a device pass; that is on V4-PICKERUX-001, not claimed here.
//
// The most important case in the file is the LAST one: with nothing stubbed, placement must be
// null and the rendered style must equal the pre-P1 constant. That is what keeps 340 other test
// files honest — if measurement silently kicked in under jsdom, every existing picker test would
// start exercising a path no one wrote them for.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: vi.fn(() => Promise.resolve([])) }) }))

import PlantingSelect, { computePlacement } from '../components/forms/PlantingSelect.jsx'

const PLANTS = Array.from({ length: 12 }, (_, i) => ({
  id: `pl-${i}`, name: `Planting ${i}`, project_id: 'pr-1', project_name: 'Herbs',
}))

// Place the input at a given y, and put the (visual) viewport bottom at a given y.
function stubGeometry({ inputTop, inputBottom, viewportHeight, viewportOffsetTop = 0 }) {
  Element.prototype.getBoundingClientRect = function () {
    if (this.tagName === 'INPUT') {
      return { top: inputTop, bottom: inputBottom, height: inputBottom - inputTop, left: 0, right: 360, width: 360, x: 0, y: inputTop }
    }
    return { top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0, x: 0, y: 0 }
  }
  window.visualViewport = {
    height: viewportHeight,
    offsetTop: viewportOffsetTop,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
}

const origRect = Element.prototype.getBoundingClientRect
const origVV = window.visualViewport

afterEach(() => {
  Element.prototype.getBoundingClientRect = origRect
  if (origVV === undefined) delete window.visualViewport
  else window.visualViewport = origVV
})

async function openPicker() {
  render(<PlantingSelect plants={PLANTS} value="" onChange={() => {}} aria-label="Plant or group" />)
  fireEvent.focus(screen.getByLabelText('Plant or group'))
  await act(async () => { await Promise.resolve() })
  return screen.getByRole('listbox')
}

describe('V4-PICKERUX-001 P1 — measured listbox placement', () => {
  beforeEach(() => { vi.stubGlobal('requestAnimationFrame', cb => { cb(); return 1 }) })

  // Plenty of room: behave exactly as before. A fix that changes the good case is a regression.
  it('opens downward at the full height when there is room', async () => {
    stubGeometry({ inputTop: 100, inputBottom: 144, viewportHeight: 900 })
    const list = await openPicker()
    expect(list.style.top).toBe('100%')
    expect(list.style.maxHeight).toBe('280px')
  })

  // The reported case: keyboard up, field mid-form. 520 - 300 - 8 = 212px below — enough to stay
  // down, but the old code would still have declared 280 and been clipped by 68px.
  it('clamps the height to the space below instead of overflowing it', async () => {
    stubGeometry({ inputTop: 256, inputBottom: 300, viewportHeight: 520 })
    const list = await openPicker()
    expect(list.style.top).toBe('100%')
    expect(list.style.maxHeight).toBe('212px')
  })

  // Below the 3-row floor: opening downward is not a chooser, so flip.
  it('flips above the input when the space below cannot seat three rows', async () => {
    stubGeometry({ inputTop: 400, inputBottom: 444, viewportHeight: 520 })
    const list = await openPicker()
    expect(list.style.bottom).toBe('100%')
    expect(list.style.top).toBe('auto')
    expect(list.style.maxHeight).toBe('280px')  // 400 - 0 - 8 = 392, clamped to the 280 ceiling
  })

  // Cramped BOTH ways — flip to the roomier side and render the room it ACTUALLY has.
  //
  // REWRITTEN by V4-KBVIEWPORT-001. This case previously asserted `>= 140` (LIST_MIN_H) on the
  // reasoning that "the floor keeps the panel choosable rather than collapsing it to 92px". That
  // reasoning does not survive: below = 60, above = 92, so flooring to 140 renders a box 48px
  // taller than the space it sits in. The third row it buys is off-viewport — the user sees two
  // rows either way, and with the floor the third is INVISIBLE rather than scrollable. The listbox
  // has its own scroll, so a shorter maxHeight costs reachability nothing.
  //
  // It also actively backfires now: chrome-aware measurement (computePlacement) subtracts
  // BottomNav + TodayBand from the downward room, which makes both-cramped far more common — so
  // the old floor would have made the chrome fix increase the frequency of its own worst residual,
  // overflowing straight into the chrome band the subtraction exists to avoid.
  //
  // The floor is now LIST_ABS_MIN (one 44px row), which bounds a worst-case overflow at 44px
  // instead of 140px. Arithmetic for the general case is pinned in PlantingSelectPlacementChrome.
  it('prefers the roomier side and renders the room it actually has', async () => {
    stubGeometry({ inputTop: 100, inputBottom: 148, viewportHeight: 216 })
    const list = await openPicker()
    expect(list.style.bottom).toBe('100%')            // above (92) > below (60) -> flip up
    expect(list.style.maxHeight).toBe('92px')         // the real room, not a 140px overflow
  })

  // Tight below but tighter above → stay down. A flip that buys nothing is jitter.
  it('does not flip when above is no roomier than below', async () => {
    stubGeometry({ inputTop: 40, inputBottom: 84, viewportHeight: 200 })
    const list = await openPicker()
    expect(list.style.top).toBe('100%')
  })

  it('contains overscroll so a flick cannot drag the sheet under the keyboard', async () => {
    stubGeometry({ inputTop: 100, inputBottom: 144, viewportHeight: 900 })
    const list = await openPicker()
    expect(list.style.overscrollBehavior).toBe('contain')
  })
})

// V4-CROPFILTERLAYOUT-001 (BD-011) — regression pin on the UNCHANGED computePlacement, in this
// file's injected-numbers style: pure inputs, pinned arithmetic, no layout engine pretended.
//
// BD-011's mechanism was never a computePlacement bug: an UNBOUNDED chip tray (~80 chips ≈
// 1,400px) entered as panelExtra, drove below/above deeply negative, and the Math.max(
// LIST_ABS_MIN, room) floor rendered ONE 44px row. The fix bounds the INPUT — the tray caps at
// TRAY_MAX_H (184) + chip-row chrome, so panelExtra arrives ≈200, never ≈1,400. This pin is the
// contract that makes that bound sufficient: with panelExtra bounded at ~200, any anchor with
// raw room ≥ LIST_MIN_H + 200 (340px — i.e., virtually every real phone layout, keyboard up or
// down) still seats a full 3-row listbox. If someone "improves" the clamp chain and this fails,
// the one-row starvation is back.
describe('V4-CROPFILTERLAYOUT-001 — bounded panelExtra can never starve the listbox', () => {
  it('keeps maxHeight ≥ LIST_MIN_H (140) whenever raw room ≥ LIST_MIN_H + panelExtra (200)', () => {
    // Raw downward room = viewBottom - rectBottom - LIST_GAP(8). Sweep from the exact threshold
    // upward; below = raw - 200 ≥ 140 at every step, so the ≥140 branch of the clamp must hold.
    for (const raw of [340, 341, 360, 420, 520, 800]) {
      const { flip, maxHeight } = computePlacement({
        rectTop: 100, rectBottom: 144,
        viewTop: 0, viewBottom: 144 + 8 + raw,
        chromeTop: 0, chromeBottom: 0,
        panelExtra: 200,
      })
      expect(flip).toBe(false)                       // down still seats ≥ LIST_MIN_H — no churn
      expect(maxHeight).toBeGreaterThanOrEqual(140)  // never the one-row floor
      expect(maxHeight).toBe(Math.min(280, raw - 200))
    }
  })

  it('still floors at LIST_ABS_MIN below the threshold — the pre-BD-011 clamp is untouched', () => {
    // Contrast case: room genuinely too small in BOTH directions (input at the very top, tiny
    // viewport). The bounded-overflow behavior V4-KBVIEWPORT-001 chose stays byte-identical —
    // BD-011 changed the panelExtra INPUT, not this arithmetic.
    const { maxHeight } = computePlacement({
      rectTop: 10, rectBottom: 54,
      viewTop: 0, viewBottom: 200,
      chromeTop: 0, chromeBottom: 0,
      panelExtra: 200,
    })
    expect(maxHeight).toBe(44)
  })
})

describe('V4-PICKERUX-001 P1 — unmeasurable environments keep the pre-P1 behavior', () => {
  // THE GUARD. No stubs: jsdom returns a zero rect and has no visualViewport, so measurePlacement
  // must return null and the panel must render the exact constant it always did. If this ever
  // fails, the other 340 test files silently changed meaning.
  it('renders down-280 when geometry cannot be measured', async () => {
    const list = await openPicker()
    expect(list.style.top).toBe('100%')
    expect(list.style.maxHeight).toBe('280px')
    expect(list.style.bottom).toBe('auto')
  })
})
