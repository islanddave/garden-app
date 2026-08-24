// PlantingSelectPlacementLatch.test.jsx — V4-WEIGHMOBILEVIEWPORT-001 (BD-045), the direction latch.
//
// Dave's second BD-045 complaint: the chooser "pops ABOVE or BELOW inconsistently… wants that
// HOMOGENIZED". The mechanism is worse than between-opens inconsistency — the placement effect is
// subscribed to visualViewport `resize` AND `scroll`, both of which fire per compositor frame while
// the Android keyboard animates, and the old bail only skipped no-op renders. So a direction change
// always committed and the panel could flip WHILE it was being watched open.
//
// WHAT THIS FILE CAN AND CANNOT PROVE, in the house style of PlantingSelectPlacement.test.jsx:
// jsdom has no layout engine, so nothing here proves where the panel lands. What IS deterministic
// is the state machine — (rect, viewport, latch) -> (flip, maxHeight) — so the geometry is stubbed
// and the arithmetic pinned. The paint needs tests/harness/, not this.
//
// The rAF stub here is DEFERRED, not synchronous, and that is load-bearing. `schedule()` guards on
// `if (raf) return` and assigns `raf` from requestAnimationFrame's RETURN value, so a stub that
// invokes the callback inline leaves raf permanently non-zero and every subsequent viewport event
// is silently dropped — a test written that way would pass whether or not the latch existed,
// because the second measure never happens at all.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: vi.fn(() => Promise.resolve([])) }) }))

import PlantingSelect, { computePlacement } from '../components/forms/PlantingSelect.jsx'

const PLANTS = Array.from({ length: 12 }, (_, i) => ({
  id: `pl-${i}`, name: `Planting ${i}`, project_id: 'pr-1', project_name: 'Herbs',
}))

// Live geometry: the stubs read this object on every call, so a test can move the input and shrink
// the viewport mid-open exactly the way the keyboard animation does.
let geom
const vvListeners = new Map()
let rafQueue

function installStubs() {
  geom = { inputTop: 100, inputBottom: 144, viewportHeight: 900, viewportOffsetTop: 0 }
  vvListeners.clear()
  rafQueue = []
  Element.prototype.getBoundingClientRect = function () {
    if (this.tagName === 'INPUT') {
      return {
        top: geom.inputTop, bottom: geom.inputBottom, height: geom.inputBottom - geom.inputTop,
        left: 0, right: 360, width: 360, x: 0, y: geom.inputTop,
      }
    }
    return { top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0, x: 0, y: 0 }
  }
  window.visualViewport = {
    get height() { return geom.viewportHeight },
    get offsetTop() { return geom.viewportOffsetTop },
    addEventListener: (type, fn) => {
      if (!vvListeners.has(type)) vvListeners.set(type, new Set())
      vvListeners.get(type).add(fn)
    },
    removeEventListener: (type, fn) => { vvListeners.get(type)?.delete(fn) },
  }
}

// Fire a visualViewport event the way Chrome does during the keyboard animation, then let the rAF
// it scheduled run. Returns the number of callbacks flushed so a test can assert it re-measured at
// all — the difference between "the latch held" and "nothing ran".
function fireViewport(type) {
  for (const fn of vvListeners.get(type) ?? []) fn()
  const queued = rafQueue
  rafQueue = []
  for (const cb of queued) cb()
  return queued.length
}

const origRect = Element.prototype.getBoundingClientRect
const origVV = window.visualViewport

beforeEach(() => {
  installStubs()
  vi.stubGlobal('requestAnimationFrame', cb => { rafQueue.push(cb); return rafQueue.length })
  vi.stubGlobal('cancelAnimationFrame', () => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  Element.prototype.getBoundingClientRect = origRect
  if (origVV === undefined) delete window.visualViewport
  else window.visualViewport = origVV
})

function renderPicker() {
  render(<PlantingSelect plants={PLANTS} value="" onChange={() => {}} aria-label="Plant or group" />)
  return screen.getByLabelText('Plant or group')
}

async function openPanel(input) {
  fireEvent.focus(input)
  await act(async () => { await Promise.resolve() })
  return screen.getByRole('listbox')
}

// The keyboard-up state used throughout: field pushed down the shrunken layout viewport, so a FREE
// decision flips up. below = 500 - 444 - 8 = 48 (< LIST_MIN_H 140); above = 400 - 0 - 8 = 392.
function raiseKeyboard() {
  geom.inputTop = 400
  geom.inputBottom = 444
  geom.viewportHeight = 500
}

describe('V4-WEIGHMOBILEVIEWPORT-001 — the chooser cannot change direction mid-open', () => {
  it('holds the opening direction when the keyboard animation would have flipped it', async () => {
    // Keyboard down: below = 900 - 144 - 8 = 748, so it opens DOWN at the 280 ceiling.
    const input = renderPicker()
    const list = await openPanel(input)
    expect(list.style.top).toBe('100%')
    expect(list.style.bottom).toBe('auto')
    expect(list.style.maxHeight).toBe('280px')

    // Keyboard animates in. Un-latched, this geometry flips the panel UP at 280px under the finger.
    await act(async () => { raiseKeyboard(); expect(fireViewport('resize')).toBe(1) })

    expect(list.style.top).toBe('100%')       // still DOWN — the whole point
    expect(list.style.bottom).toBe('auto')
    // maxHeight is deliberately NOT latched: the clamp tracks the room the latched side really has
    // (48px), rather than keeping the 280 it was opened with and overflowing the chrome band.
    expect(list.style.maxHeight).toBe('48px')
  })

  it('holds it across a visualViewport scroll too, not just a resize', async () => {
    // Both events are subscribed and both fire per frame during the animation; latching only the
    // resize path would leave the defect reachable by the one that fires more often.
    const input = renderPicker()
    const list = await openPanel(input)
    expect(list.style.top).toBe('100%')

    await act(async () => { raiseKeyboard(); expect(fireViewport('scroll')).toBe(1) })

    expect(list.style.top).toBe('100%')
    expect(list.style.bottom).toBe('auto')
  })

  it('releases the latch on close, so the next open decides freely', async () => {
    // The latch is per-OPEN, not per-mount. A panel reopened in genuinely different geometry must
    // still be allowed to pick the roomier side — freezing direction for the life of the component
    // would trade Dave's flip for a permanently clipped list.
    const input = renderPicker()
    const first = await openPanel(input)
    expect(first.style.top).toBe('100%')

    fireEvent.keyDown(input, { key: 'Escape' })
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByRole('listbox')).toBeNull()

    raiseKeyboard()
    const second = await openPanel(input)
    expect(second.style.bottom).toBe('100%')   // free decision: above (392) > below (48)
    expect(second.style.top).toBe('auto')
    expect(second.style.maxHeight).toBe('280px')
  })

  it('arms on the first MEASURABLE frame, not on an unmeasurable one', async () => {
    // measurePlacement returns null for a zero rect. If that null armed the latch it would arm to
    // `false` (the render default) before any real geometry existed, and the panel would be pinned
    // downward forever — a latch that is always "down" is not the fix, it is a different bug.
    geom.inputTop = 0
    geom.inputBottom = 0
    const input = renderPicker()
    const list = await openPanel(input)
    expect(list.style.top).toBe('100%')        // unmeasurable → the pre-P1 constant
    expect(list.style.maxHeight).toBe('280px')

    // First measurable frame arrives with keyboard-up geometry: it must be free to open UP.
    await act(async () => { raiseKeyboard(); expect(fireViewport('resize')).toBe(1) })
    expect(list.style.bottom).toBe('100%')
    expect(list.style.top).toBe('auto')
  })
})

describe('V4-WEIGHMOBILEVIEWPORT-001 — computePlacement.forceFlip sizes the side it pins', () => {
  // The arithmetic half, in PlantingSelectPlacement.test.jsx's injected-numbers style. This is the
  // property that makes the latch safe rather than merely stubborn: pinning the direction on the
  // RESULT would keep the maxHeight of the side that was declined.
  const CRAMPED_BELOW = {
    rectTop: 400, rectBottom: 444, viewTop: 0, viewBottom: 500, chromeTop: 0, chromeBottom: 0,
  }

  it('decides freely and flips up when forceFlip is null', () => {
    expect(computePlacement({ ...CRAMPED_BELOW, forceFlip: null }))
      .toEqual({ flip: true, maxHeight: 280 })
  })

  it('omitting forceFlip is byte-identical to null — every pre-latch caller is untouched', () => {
    expect(computePlacement(CRAMPED_BELOW))
      .toEqual(computePlacement({ ...CRAMPED_BELOW, forceFlip: null }))
  })

  it('pinned DOWN reports the room BELOW (48), not the 280 it could have had above', () => {
    expect(computePlacement({ ...CRAMPED_BELOW, forceFlip: false }))
      .toEqual({ flip: false, maxHeight: 48 })
  })

  it('pinned UP reports the room ABOVE even where down was the free choice', () => {
    // Mirror case: plenty of room below (748), so the free decision is DOWN at the ceiling. Pinned
    // up, the room is above = 100 - 8 = 92 — under LIST_MIN_H, so the LIST_ABS_MIN branch applies.
    const roomyBelow = {
      rectTop: 100, rectBottom: 144, viewTop: 0, viewBottom: 900, chromeTop: 0, chromeBottom: 0,
    }
    expect(computePlacement(roomyBelow)).toEqual({ flip: false, maxHeight: 280 })
    expect(computePlacement({ ...roomyBelow, forceFlip: true })).toEqual({ flip: true, maxHeight: 92 })
  })

  it('never returns a maxHeight under the one-row floor for a pinned side', () => {
    // A latched direction can go arbitrarily cramped mid-animation. The clamp must bottom out at
    // LIST_ABS_MIN (44) rather than at zero or a negative, which would render an invisible panel.
    const { flip, maxHeight } = computePlacement({
      rectTop: 400, rectBottom: 444, viewTop: 0, viewBottom: 446, chromeTop: 0, chromeBottom: 0,
      forceFlip: false,
    })
    expect(flip).toBe(false)
    expect(maxHeight).toBe(44)
  })
})
