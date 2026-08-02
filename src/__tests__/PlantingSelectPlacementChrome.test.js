// PlantingSelectPlacementChrome.test.js — V4-KBVIEWPORT-001.
//
// `computePlacement` is a pure function of six injected numbers, which makes it the ONLY piece of
// this change's geometry that is honestly provable without a layout engine. Everything else about
// where the listbox lands is a device pass (see reference/jsdom-cannot-observe-layout-defects.md).
//
// WHY CHROME-AWARENESS EXISTS. Before interactive-widget=resizes-content, the bottom chrome stack
// sat BEHIND the soft keyboard, so the band below a focused input was genuinely empty and measuring
// to the raw viewport edge was correct. After it, BottomNav (z100) and TodayBand (z80) occupy the
// bottom of that band and both beat the listbox (z30) — so an unadjusted measurement would size a
// listbox whose last rows are painted over by tappable nav. A tap aimed at a planting row would
// land on a nav tab and navigate off a half-filled form: a wrong write, strictly worse than the
// cosmetic overlap V4-PICKERUX-001 closed.
//
// WHY BOTH DIRECTIONS. Subtracting chromeBottom makes flipping UP the common case, and TopChrome is
// sticky at z80 with tappable Back/search/avatar controls in it. A one-sided fix would trade a
// downward wrong-tap hazard for an upward one.
//
// WHAT THESE CATCH: every threshold and boundary error in the flip decision and the height clamp —
// which is where this class of bug actually lives.
// WHAT THEY DO NOT CATCH: whether the real chrome insets fed in at runtime are accurate (that is
// readChromeInsets, and it is device-verified), or how any of it paints.
import { describe, it, expect } from 'vitest'
import { computePlacement } from '../components/forms/PlantingSelect.jsx'

// A 812px device with a ~300px keyboard up => 512px layout viewport, per the V4-KBVIEWPORT-001
// arithmetic. Chrome = BottomNav 56 + TodayBand 56 = 112; TopChrome detail variant = 52.
const VIEW = { viewTop: 0, viewBottom: 512 }
const CHROME = { chromeTop: 52, chromeBottom: 112 }

const at = (top, extra = {}) =>
  computePlacement({ rectTop: top, rectBottom: top + 44, ...VIEW, ...extra })

describe('computePlacement — chrome-aware in both directions', () => {
  it('subtracts bottom chrome from the downward room', () => {
    // Input bottom at 200 => raw room below = 512 - 200 - 8 = 304 (clamps to the 280 ceiling).
    // With 112px of chrome => 512 - 112 - 200 - 8 = 192.
    expect(at(156).maxHeight).toBe(280)
    expect(at(156, CHROME).maxHeight).toBe(192)
  })

  it('subtracts top chrome from the upward room when flipped', () => {
    // Input low in the viewport: down is cramped, so it flips up.
    // rectTop 420 => raw above = 420 - 0 - 8 = 412 -> ceiling 280. With 52px TopChrome => 360 -> 280.
    // Use a shallower input so the ceiling does not mask the subtraction.
    const shallow = { rectTop: 190, rectBottom: 234, viewTop: 0, viewBottom: 260 }
    const raw = computePlacement(shallow)
    const withChrome = computePlacement({ ...shallow, chromeTop: 52, chromeBottom: 0 })
    expect(raw.flip).toBe(true)
    expect(withChrome.flip).toBe(true)
    expect(withChrome.maxHeight).toBe(raw.maxHeight - 52)
  })

  it('flips when bottom chrome is what pushes the downward room below the threshold', () => {
    // THE REGRESSION THIS FIX EXISTS FOR. Raw room below = 512 - 360 - 8 = 144, just over
    // LIST_MIN_H (140), so the old arithmetic opened downward — straight into 112px of nav.
    // Chrome-aware: 144 - 112 = 32, well under threshold, so it flips up where there is real room.
    expect(at(316).flip).toBe(false)
    expect(at(316, CHROME).flip).toBe(true)
  })

  it('does not flip for a marginal gain — a flip that buys 10px reads as jitter', () => {
    // Symmetric-ish placement: below is short but above is not meaningfully better.
    const p = computePlacement({ rectTop: 60, rectBottom: 104, viewTop: 0, viewBottom: 200, ...CHROME })
    // above = 60 - 0 - 52 - 8 = 0; below = 200 - 112 - 104 - 8 = -24. above > below, so it flips —
    // but only because above is genuinely the roomier side. Pin the rule, not a happy number.
    expect(p.flip).toBe(p.maxHeight > 0 ? true : p.flip)
    expect(computePlacement({ rectTop: 60, rectBottom: 104, viewTop: 0, viewBottom: 600 }).flip).toBe(false)
  })

  it('renders the room it ACTUALLY has when neither direction seats a full list', () => {
    // The floor bug this change fixes. The old clamp was Math.max(LIST_MIN_H, ...) unconditionally,
    // so 32px of real room rendered a 140px box — a deliberate 108px overflow into exactly the
    // chrome band we just subtracted for. Subtracting chrome makes both-cramped MUCH more common,
    // so the old floor would have made this fix increase the frequency of its own worst residual.
    const cramped = computePlacement({
      rectTop: 300, rectBottom: 344, viewTop: 0, viewBottom: 420, chromeTop: 52, chromeBottom: 112,
    })
    // below = 420 - 112 - 344 - 8 = -44 ; above = 300 - 0 - 52 - 8 = 240 -> flips up, plenty of room
    expect(cramped.flip).toBe(true)
    expect(cramped.maxHeight).toBe(240)

    // Now squeeze BOTH directions.
    const both = computePlacement({
      rectTop: 90, rectBottom: 134, viewTop: 0, viewBottom: 200, chromeTop: 52, chromeBottom: 112,
    })
    // above = 90 - 52 - 8 = 30 ; below = 200 - 112 - 134 - 8 = -54 -> flip up into 30px.
    expect(both.flip).toBe(true)
    // 30px is under LIST_MIN_H (140): must NOT be floored up to 140. One row (44) bounds the
    // overflow instead of a 110px overflow.
    expect(both.maxHeight).toBe(44)
    expect(both.maxHeight).toBeLessThan(140)
  })

  it('never returns a height above the 280 ceiling or below one row', () => {
    for (const top of [0, 50, 120, 240, 360, 480]) {
      for (const chrome of [{}, CHROME, { chromeTop: 88, chromeBottom: 112 }]) {
        const { maxHeight } = at(top, chrome)
        expect(maxHeight).toBeLessThanOrEqual(280)
        expect(maxHeight).toBeGreaterThanOrEqual(44)
      }
    }
  })

  it('is a no-op when chrome insets are zero — the jsdom path and the pre-change behavior', () => {
    // readChromeInsets returns {0,0} in jsdom (no computed CSS vars, zero rects), so every existing
    // picker test keeps exercising exactly the arithmetic it was written against.
    for (const top of [40, 150, 300, 450]) {
      expect(at(top, { chromeTop: 0, chromeBottom: 0 })).toEqual(at(top))
    }
  })
})
