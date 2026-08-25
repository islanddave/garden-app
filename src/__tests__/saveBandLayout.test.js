// BUG-WEIGHPADSAVEBAND-001 — the clearance rule for EventNew's sticky Save band.
//
// WHAT THIS FILE CAN AND CANNOT PROVE. jsdom has no layout engine: every getBoundingClientRect()
// is zeros and elementFromPoint answers nothing, so NO test here can show that the weight keypad
// actually clears the band on a 390x500 screen. That claim is gated by
// scripts/layout-gate/save-band-clearance.mjs against real Chrome, and this file deliberately does
// not restate it.
//
// What IS provable, and what the defect actually was, is the ARITHMETIC and the WIRING: the
// clearance is computed from the band as rendered rather than assumed to be a constant, the scroll
// it asks for is the exact deficit rather than a guess, and it declines to move the page in the
// cases where moving it would be wrong. Rects and the scroll model are therefore injected, not
// measured — the stubs below are the test's subject matter, not a shortcut around it.
// No jest-dom (L-182).
import { describe, it, expect, afterEach } from 'vitest'
import {
  SAVE_BAND_BOTTOM_INSET_PX,
  SAVE_BAND_MIN_CLEARANCE_PX,
  FRAME_SAVE_HEIGHT_PX,
  saveBandClearancePx,
  padClearanceScrollDelta,
  clearWeightPadOfSaveBand,
  framePadGapPx,
  frameSaveClearancePx,
} from '../lib/saveBandLayout.js'
import { BOTTOM_NAV_HEIGHT_PX } from '../lib/constants.js'

const rect = (top, bottom) => ({ top, bottom, left: 0, right: 390, width: 390, height: bottom - top })

// jsdom's Element.scrollTop is hard-wired to 0 (no layout box to scroll), so an own property is
// installed to give the helper a scroll model it can actually move. Shadowing the prototype on one
// element is the narrowest way to do that.
function makeScroller(el, { scrollHeight, clientHeight, scrollTop = 0 }) {
  let pos = scrollTop
  Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => pos, set: v => { pos = v } })
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight })
  return el
}

// The shape the helper queries for: a scrolling ancestor wrapping the pad, plus the band as a
// sibling. Mirrors EventNew's real DOM relationship (band is NOT inside the pad's scroller in the
// full-page case, and is inside it in the overlay case — neither matters to this helper, which
// only reads the band's rect).
function mountPanel({ padBottom, bandTop, bandVisibility = 'visible', scroll = {} } = {}) {
  document.body.innerHTML = `
    <div id="scroller" style="overflow-y: auto">
      <div role="group" aria-label="Harvest weight keypad"></div>
    </div>
    <div data-testid="save-sticky"></div>`
  const scroller = makeScroller(document.getElementById('scroller'), {
    scrollHeight: scroll.scrollHeight ?? 2000, clientHeight: scroll.clientHeight ?? 500, scrollTop: scroll.scrollTop ?? 0,
  })
  const pad = document.querySelector('[aria-label="Harvest weight keypad"]')
  const band = document.querySelector('[data-testid="save-sticky"]')
  pad.getBoundingClientRect = () => rect(padBottom - 104, padBottom)
  band.getBoundingClientRect = () => rect(bandTop, bandTop + 48)
  band.style.visibility = bandVisibility
  return { scroller, pad, band }
}

afterEach(() => { document.body.innerHTML = '' })

describe('saveBandLayout — the stated numbers', () => {
  it('the band inset is the nav height plus the 12px gap, in one place', () => {
    // EventNew renders `bottom: SAVE_BAND_BOTTOM_INSET_PX` and the clearance rule is measured
    // against that same edge. If the two ever resolve differently the rule is measuring a band
    // that is not where it says it is.
    expect(SAVE_BAND_BOTTOM_INSET_PX).toBe(BOTTOM_NAV_HEIGHT_PX + 12)
  })

  it('the stated minimum is 20px — the number the ticket exists to replace was 1', () => {
    expect(SAVE_BAND_MIN_CLEARANCE_PX).toBe(20)
  })
})

describe('saveBandClearancePx', () => {
  it('is positive when the control ends above the band', () => {
    expect(saveBandClearancePx(rect(300, 364), rect(384, 432))).toBe(20)
  })

  it('is NEGATIVE when the band covers the control — the shipped case, measured at -15', () => {
    expect(saveBandClearancePx(rect(351, 399), rect(384, 432))).toBe(-15)
  })

  it('is null rather than a plausible number when a rect is missing', () => {
    // A missing element must not read as "clearance 0", which is a value the caller would act on.
    expect(saveBandClearancePx(null, rect(384, 432))).toBeNull()
    expect(saveBandClearancePx(rect(351, 399), null)).toBeNull()
  })
})

describe('padClearanceScrollDelta', () => {
  it('asks for nothing when the control already clears by the minimum', () => {
    expect(padClearanceScrollDelta(rect(300, 364), rect(384, 432))).toBe(0)
  })

  it('asks for nothing when the control clears by MORE than the minimum', () => {
    // The 390x844 case: this helper must never scroll a page that is already fine.
    expect(padClearanceScrollDelta(rect(295, 399), rect(728, 776))).toBe(0)
  })

  it('asks for exactly the deficit — 15px of overlap plus the 20px minimum is 35', () => {
    expect(padClearanceScrollDelta(rect(351, 399), rect(384, 432))).toBe(35)
  })

  it('ceils a fractional shortfall rather than rounding it away', () => {
    // Sub-pixel layout is normal here (six 46.67px columns). Rounding down would reintroduce
    // exactly the sub-pixel accident this ticket is about.
    expect(padClearanceScrollDelta(rect(300, 364.4), rect(384, 432))).toBe(1)
  })

  it('honours an explicit minimum instead of the constant', () => {
    expect(padClearanceScrollDelta(rect(351, 399), rect(384, 432), 0)).toBe(15)
  })
})

describe('clearWeightPadOfSaveBand', () => {
  it('scrolls the pad clear by the deficit and reports what it moved', () => {
    const { scroller } = mountPanel({ padBottom: 399, bandTop: 384 })
    expect(clearWeightPadOfSaveBand(document)).toBe(35)
    expect(scroller.scrollTop).toBe(35)
  })

  it('does not move a page whose keypad already clears the band', () => {
    const { scroller } = mountPanel({ padBottom: 364, bandTop: 384, scroll: { scrollTop: 120 } })
    expect(clearWeightPadOfSaveBand(document)).toBe(0)
    expect(scroller.scrollTop).toBe(120)
  })

  it('does nothing while the band is hidden — the picker-open suppression occludes nothing', () => {
    // V4-PICKERUX-001 sets visibility:hidden on the whole band while the planting listbox is open,
    // which removes it from hit testing. Scrolling for a band that cannot take a tap would be a
    // jump with no cause the user could see.
    const { scroller } = mountPanel({ padBottom: 399, bandTop: 384, bandVisibility: 'hidden' })
    expect(clearWeightPadOfSaveBand(document)).toBe(0)
    expect(scroller.scrollTop).toBe(0)
  })

  it('does nothing when there is no weight keypad — the non-session harvest panel', () => {
    // The weight pad renders only `inHarvestSession`. Outside it the helper must be inert, not
    // fall back to scrolling something else.
    mountPanel({ padBottom: 399, bandTop: 384 })
    document.querySelector('[aria-label="Harvest weight keypad"]').remove()
    expect(clearWeightPadOfSaveBand(document)).toBe(0)
  })

  it('does nothing when there is no band', () => {
    mountPanel({ padBottom: 399, bandTop: 384 })
    document.querySelector('[data-testid="save-sticky"]').remove()
    expect(clearWeightPadOfSaveBand(document)).toBe(0)
  })

  it('clamps to the scroll room available rather than setting an impossible offset', () => {
    // A short document cannot deliver the full lift. Getting as close as the container allows is
    // the correct partial answer; silently claiming the full 35 would make the gate's numbers lie.
    const { scroller } = mountPanel({
      padBottom: 399, bandTop: 384, scroll: { scrollHeight: 520, clientHeight: 500, scrollTop: 0 },
    })
    expect(clearWeightPadOfSaveBand(document)).toBe(20)
    expect(scroller.scrollTop).toBe(20)
  })
})

// ── V4-WEIGHFRAME-001 R1 — the frame arm's half of the same rule ────────────────────────────────
//
// Same split as above: this is the ARITHMETIC, real Chrome is the pixels
// (scripts/layout-gate/save-band-clearance.mjs), and WeighInFrame.flagOn.test.jsx pins that
// EventNew's markup actually carries these numbers. The point of a derived gap rather than a spelled
// one is that changing the ledger height or Save's height cannot silently stop meaning 20px, so that
// is what these assert — the round trip, not the literal.
describe('V4-WEIGHFRAME-001 R1 — the frame arm has no band, and the same floor', () => {
  it('derives a gap that lands exactly on the policy floor for the shipped geometry', () => {
    // 48 is FRAME_LEDGER_PX (EventNew): the ledger row's content height, constant at every entry.
    expect(framePadGapPx(48)).toBe(15)
    expect(frameSaveClearancePx(48, framePadGapPx(48))).toBe(SAVE_BAND_MIN_CLEARANCE_PX)
  })

  it('holds the floor across ledger heights rather than only the one it was measured at', () => {
    for (const ledger of [40, 44, 48, 56, 64]) {
      expect(frameSaveClearancePx(ledger, framePadGapPx(ledger))).toBe(SAVE_BAND_MIN_CLEARANCE_PX)
    }
  })

  it('counts the height Save gives up, because that is 4 of the 20', () => {
    // A full-height Save (48 in a 48 row) leaves nothing dead at the top of the track, which is
    // exactly the geometry that measured 1px. The 4px is not decoration.
    expect(frameSaveClearancePx(48, framePadGapPx(48), 48)).toBe(SAVE_BAND_MIN_CLEARANCE_PX - 4)
    expect(FRAME_SAVE_HEIGHT_PX).toBeGreaterThanOrEqual(44)
  })

  it('is the same number as the legacy arm, not a second policy', () => {
    // Both arms ship — the frame by default, the band as the rollback lever — and a thumb does not
    // know which one it is on. SAVE_BAND_MIN_CLEARANCE_PX's own note is the argument for one number.
    expect(framePadGapPx(48, 12)).toBe(framePadGapPx(48) - 8)
    expect(frameSaveClearancePx(48, framePadGapPx(48, 12))).toBe(12)
  })
})
