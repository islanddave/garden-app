// NumberPad.keyLayout — the pad's CELL ASSIGNMENT and KEY SIZING.
//
// Scope discipline, because this component's header is mostly pixels and none of those are
// testable here: jsdom has no layout engine, so getBoundingClientRect is zeros and elementFromPoint
// is meaningless (tests/harness/README.md:14-16). What jsdom CAN falsify, and all this file
// asserts, is (a) rendered DOM order — the grid is `repeat(6, 1fr)` in normal flow with no CSS
// `order` and no reversing flex direction, which the last case pins, so DOM order IS column order —
// and (b) the inline style object. The 320px group width, the 46.7px key width and the Save-band
// clearance were measured in real Chrome and belong to the header comment, not to this file.
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import NumberPad from '../components/NumberPad.jsx'

const SHIPPED = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'dot', 'back']
const LEFT = ['1', '2', '3', '4', '5', '6', 'back', 'dot', '7', '8', '9', '0']
const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']

const pad = (props = {}) => render(
  <NumberPad
    value=""
    onChange={() => {}}
    idPrefix="qty-chip"
    ariaLabel="Quantity keypad"
    keyAriaPrefix="Quantity"
    {...props}
  />
)

const grid = () => screen.getByRole('group', { name: 'Quantity keypad' })
const keyOrder = () => [...grid().children].map(el => el.getAttribute('data-testid').replace('qty-chip-', ''))

describe('NumberPad — key layout', () => {
  it('right-handed is the default and renders exactly the shipped order', () => {
    // No `hand` prop at all — this is what both EventNew call sites pass today, so the reorder must
    // be a provable no-op for them and for every pinned oracle that renders a pad.
    pad()
    expect(keyOrder()).toEqual(SHIPPED)
  })

  it('an explicit hand="right" is identical to the default', () => {
    pad({ hand: 'right' })
    expect(keyOrder()).toEqual(SHIPPED)
  })

  it('left-handed moves ⌫ to the NEAR column, ⌫ outermost, . beside it', () => {
    // The whole point: ⌫ is the most-needed corrective key and column 6 is the hardest cell for a
    // left thumb. Dave works the weigh-in left-handed because his right hand is on the scale.
    pad({ hand: 'left' })
    expect(keyOrder()).toEqual(LEFT)
    expect(keyOrder()[0]).toBe('1')          // top row still leads with 1
    expect(keyOrder().indexOf('back')).toBe(6) // first cell of the bottom row = column 1
  })

  it('NEVER mirrors the digits — reading order 1-2-3-4-5-6 / 7-8-9-0 in BOTH modes', () => {
    // Mirror the frame, never the numerals. A pad rendering `0 9 8 7` would guarantee mis-entry on
    // a surface whose entire job is entering a number correctly.
    for (const hand of ['right', 'left']) {
      const { unmount } = pad({ hand })
      expect(keyOrder().filter(k => DIGITS.includes(k))).toEqual(DIGITS)
      unmount()
    }
  })

  it('a mid-session re-render never reorders — not on value change, not on re-render', () => {
    // THE standing-rule guarantee (comboboxInput.js:138-144 forbids a target that moves under a
    // thumb already in flight). Cell assignment is a function of `hand` ALONE, so typing — which is
    // the only thing that changes on this surface mid-session — cannot move a key. Both modes,
    // because a bug that only bites left-handers is the one that would ship.
    for (const [hand, expected] of [['right', SHIPPED], ['left', LEFT]]) {
      const { rerender, unmount } = pad({ hand })
      expect(keyOrder()).toEqual(expected)
      // Every distinct state the pad passes through while a real value is built, including the
      // states that flip `disabled` on '.', on ⌫ and on the digits at the cap.
      for (const v of ['', '3', '33', '337', '337.', '337.5', '33', '3', '', '0.', '12345678']) {
        rerender(
          <NumberPad value={v} onChange={() => {}} idPrefix="qty-chip" ariaLabel="Quantity keypad" keyAriaPrefix="Quantity" hand={hand} />
        )
        expect(keyOrder()).toEqual(expected)
      }
      unmount()
    }
  })

  it('keeps 12 cells and one grid geometry in both modes — only the glyph-to-cell map differs', () => {
    // This is precisely why the reorder does not violate the "tap targets never move" rule: nothing
    // appears, disappears, resizes or reflows. Same count, same grid, same rows.
    const seen = {}
    for (const hand of ['right', 'left']) {
      const { unmount } = pad({ hand })
      const g = grid()
      expect(g.children).toHaveLength(12)
      expect(g.style.gridTemplateColumns).toBe('repeat(6, 1fr)')
      expect(g.style.gap).toBe('8px')
      expect(g.style.marginBottom).toBe('8px')
      seen[hand] = keyOrder().slice().sort()
      unmount()
    }
    expect(seen.left).toEqual(seen.right) // same multiset of keys, different order
  })

  it('every key is 56px tall — the house floor on the axis that is actually free', () => {
    // 46.7x48 already cleared WCAG 2.5.8 (24px) and 2.5.5 (44px); this is a motor fix, not a
    // conformance one. Width is pinned by a 320px group over 6 columns and cannot grow without
    // adding a row, so height is the only axis with room.
    pad({ hand: 'left' })
    const keys = [...grid().children]
    expect(keys).toHaveLength(12)
    for (const k of keys) {
      expect(k.style.minHeight).toBe('56px')
      expect(k.style.minWidth).toBe('44px')
    }
  })

  it('uses DOM order as the ONLY mechanism — no CSS order, no row-reverse, no dir flip', () => {
    // A second mechanism would flip the pixels while leaving every assertion above green, and would
    // also mask a mutation to whichever half you did not break.
    for (const hand of ['right', 'left']) {
      const { unmount } = pad({ hand })
      const g = grid()
      expect(g.style.flexDirection).toBe('')
      expect(g.style.direction).toBe('')
      expect(g.style.display).toBe('grid')
      for (const el of g.children) expect(el.style.order).toBe('')
      unmount()
    }
  })

  it('an unknown or missing hand lays out the way the app has always laid out', () => {
    // Same contract as lib/handedness.js normalizeHand: a corrupted value, a value written by a
    // future version and "never set" are all the same answer. Not a throw, not a blank pad.
    for (const hand of [undefined, null, '', 'LEFT', 'southpaw', 0, true]) {
      const { unmount } = pad({ hand })
      expect(keyOrder()).toEqual(SHIPPED)
      unmount()
    }
  })

  it('keeps . present-and-dimmed when it cannot fire, never absent', () => {
    // A vanishing key shifts every key after it — the exact thing the standing rule forbids, and
    // the reason '.' was not traded away for a double-width ⌫ (WEIGHT_UNITS has fractional units).
    // Refused, NOT DOM-disabled: NumberPad.refusal.test.jsx owns that semantics and why.
    pad({ hand: 'left', value: '3.5' })
    const dot = screen.getByTestId('qty-chip-dot')
    expect(dot).toBeTruthy()
    expect(dot.getAttribute('aria-disabled')).toBe('true')
    expect(dot.style.opacity).toBe('0.35')
    expect(keyOrder()).toEqual(LEFT) // still in its cell, still 12 cells
  })

  it('the full-width primary has no handedness and stays last in both modes', () => {
    // `gridColumn: '1 / -1'` spans the row, so there is no edge for it to sit on. Unrendered on the
    // shipped surface since BD-063 removed both call sites' props; pinned so a future "flip
    // everything" pass cannot invent a handedness for it.
    for (const hand of ['right', 'left']) {
      const { unmount } = pad({ hand, onPrimary: () => {}, primaryLabel: 'Next →' })
      const kids = [...grid().children]
      expect(kids).toHaveLength(13)
      const last = kids[kids.length - 1]
      expect(last.getAttribute('data-testid')).toBe('qty-chip-primary')
      expect(last.style.gridColumn).toBe('1 / -1')
      unmount()
    }
  })
})

// NAMED MUTATION TARGETS — each applied to src/components/NumberPad.jsx, run, VERIFIED red on the
// listed case, then reverted from a `cp` copy (never `git checkout --`, which reverts to HEAD).
// Recorded 2026-08-25; the table with observed failure counts is in the lane report.
//   M1  keyBase.minHeight 56 -> 48                        => "every key is 56px tall"
//   M2  orderByThumb ignores `hand` (always far-side)      => "left-handed moves ⌫ to the NEAR column"
//   M3  corrective pair keeps ⌫/. relative order in left   => "left-handed moves ⌫ to the NEAR column"
//   M4  reverse bottomDigits along with the pair           => "NEVER mirrors the digits"
//   M5  hand === 'left' -> hand !== 'right' (truthy junk)  => "unknown or missing hand"
//   M6  cell assignment keys off `value` as well as `hand` => "mid-session re-render never reorders"
//   M7  drop gridColumn '1 / -1' from the primary          => "full-width primary ... in both modes"
//   M8  render '.' as null when disabled (vanishing key)   => "keeps . present-and-dimmed"
//   M9  add flexDirection 'row-reverse' beside DOM order   => "DOM order as the ONLY mechanism"
