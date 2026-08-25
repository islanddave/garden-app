// V4-HANDEDNESSCONTROLS-001 (BD-054) — the digit builder's corrective keys follow the setting.
//
// ⌫ is the key a one-handed operator returns to most on this surface (NumberPad.jsx calls it
// MANDATORY: under build semantics a mis-tap COMPOUNDS rather than being replaced). It shipped in
// the bottom-RIGHT cell, which is only the reachable corner for a right thumb.
//
// ASSERTED ON RENDERED DOM ORDER, never on source text. The grid is `repeat(6, 1fr)` in normal
// flow, so DOM order is column order; there is no CSS `order` and no `row-reverse` anywhere in this
// component, which the last case pins.
import React from 'react'
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import NumberPad from '../components/NumberPad.jsx'
import { HANDEDNESS_KEY } from '../lib/handedness.js'

beforeEach(() => { localStorage.clear() })

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

// The rendered key order, read off the grid children.
const keyOrder = () => [...screen.getByRole('group', { name: 'Quantity keypad' }).children]
  .map(el => el.getAttribute('data-testid').replace('qty-chip-', ''))

describe('NumberPad — handedness', () => {
  it('right-handed (the default, unset) renders exactly the shipped order', () => {
    // Byte-for-byte the pre-change layout: this is what makes the setting a no-op for Jen and for
    // every pinned oracle that renders a pad.
    pad()
    expect(keyOrder()).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'dot', 'back'])
  })

  it('left-handed moves ⌫ and . to the leading cells, ⌫ outermost', () => {
    localStorage.setItem(HANDEDNESS_KEY, 'left')
    pad()
    expect(keyOrder()).toEqual(['1', '2', '3', '4', '5', '6', 'back', 'dot', '7', '8', '9', '0'])
  })

  it('never reverses the DIGITS — 0 9 8 7 would be a worse defect than the one being fixed', () => {
    localStorage.setItem(HANDEDNESS_KEY, 'left')
    pad()
    const order = keyOrder()
    expect(order.slice(0, 6)).toEqual(['1', '2', '3', '4', '5', '6'])
    expect(order.slice(2)).toEqual(['3', '4', '5', '6', 'back', 'dot', '7', '8', '9', '0'])
  })

  it('the full-width primary has no handedness and stays last in both modes', () => {
    // §6 item 6 of the wizard design: `gridColumn: '1 / -1'` spans the row, so there is no edge for
    // it to sit on. Pinned so a future "flip everything" pass cannot invent one.
    for (const hand of ['right', 'left']) {
      localStorage.setItem(HANDEDNESS_KEY, hand)
      const { unmount } = pad({ onPrimary: () => {}, primaryLabel: 'Next →' })
      const kids = [...screen.getByRole('group', { name: 'Quantity keypad' }).children]
      const last = kids[kids.length - 1]
      expect(last.getAttribute('data-testid')).toBe('qty-chip-primary')
      expect(last.style.gridColumn).toBe('1 / -1')
      unmount()
    }
  })

  it('uses DOM order as the only mechanism — no CSS order, no row-reverse', () => {
    // A second mechanism would flip the pixels while leaving every assertion above green, and would
    // also mask a mutation to whichever half you did not break.
    localStorage.setItem(HANDEDNESS_KEY, 'left')
    pad()
    const grid = screen.getByRole('group', { name: 'Quantity keypad' })
    expect(grid.style.flexDirection).toBe('')
    expect(grid.style.direction).toBe('')
    for (const el of grid.children) expect(el.style.order).toBe('')
  })
})

// NAMED MUTATION TARGETS (each VERIFIED red on the listed test, 2026-08-25):
//   orderByThumb ignores `hand` on the corrective pair  => the left-handed order test
//   the pair moves but ⌫/. keep their relative order    => the left-handed order test
//   reverse bottomDigits as well as the pair            => the "never reverses the DIGITS" test
//   drop gridColumn '1 / -1' from the primary           => the full-width primary test
