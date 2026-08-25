// V4-HANDEDNESSCONTROLS-001 (BD-054) — the handedness preference's pure layer.
//
// The layout claims this module makes are jsdom-falsifiable in a way the wizard's are not: nothing
// here is about pixels, it is about DOM ORDER, which is exactly what jsdom can see. The rendered
// consequence of that order is pinned in HarvestWatchBand.test.jsx.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  HANDS, DEFAULT_HAND, HANDEDNESS_KEY, HANDEDNESS_EVENT,
  normalizeHand, readHand, writeHand, orderByThumb, thumbEdge, offhandEdge,
} from '../lib/handedness.js'

beforeEach(() => { localStorage.clear() })

describe('handedness — the value', () => {
  it('offers exactly two hands and defaults to right', () => {
    // Pins the SCOPE. A third value ('either', 'auto') would silently become the default at every
    // normalizeHand call site rather than doing whatever it was added to do.
    expect(HANDS).toEqual(['right', 'left'])
    expect(DEFAULT_HAND).toBe('right')
  })

  it('reads right-handed when nothing is stored — the never-set user is unaffected', () => {
    expect(readHand()).toBe('right')
  })

  it('treats a corrupt, unknown or future value as the default rather than throwing', () => {
    for (const junk of ['LEFT', 'ambidextrous', '', '1', null, undefined, 0]) {
      expect(normalizeHand(junk)).toBe('right')
    }
    localStorage.setItem(HANDEDNESS_KEY, 'sideways')
    expect(readHand()).toBe('right')
  })

  it('round-trips a real choice and announces it so every surface turns over on one tap', () => {
    let fired = 0
    const onChange = () => { fired += 1 }
    window.addEventListener(HANDEDNESS_EVENT, onChange)
    try {
      expect(writeHand('left')).toBe('left')
      expect(localStorage.getItem(HANDEDNESS_KEY)).toBe('left')
      expect(readHand()).toBe('left')
      expect(fired).toBe(1)
    } finally { window.removeEventListener(HANDEDNESS_EVENT, onChange) }
  })

  it('never persists a value it would not read back — a junk write normalizes before storage', () => {
    // Otherwise the stored string and the effective hand disagree, and the Settings page would show
    // "right" while localStorage said something else.
    expect(writeHand('nonsense')).toBe('right')
    expect(localStorage.getItem(HANDEDNESS_KEY)).toBe('right')
  })
})

describe('handedness — orderByThumb, the safety primitive', () => {
  // THE INVARIANT, stated once: the argument named `underThumb` ends up on the edge the user's
  // thumb reaches, in BOTH modes. Everything wired to this setting inherits that property; nothing
  // at a call site re-derives "left" or "right".
  it('right-handed puts the under-thumb control LAST in DOM order (the right edge)', () => {
    expect(orderByThumb('right', 'SAFE', 'RISKY')).toEqual(['RISKY', 'SAFE'])
  })

  it('left-handed puts the under-thumb control FIRST in DOM order (the left edge)', () => {
    expect(orderByThumb('left', 'SAFE', 'RISKY')).toEqual(['SAFE', 'RISKY'])
  })

  it('an unset or junk hand orders exactly as right-handed — the default is a no-op', () => {
    // This is what makes the change provably invisible to anyone who never opens the setting.
    for (const junk of [undefined, null, '', 'LEFT', 'auto']) {
      expect(orderByThumb(junk, 'SAFE', 'RISKY')).toEqual(['RISKY', 'SAFE'])
    }
  })

  it('is a genuine inversion, not two spellings of one order', () => {
    // Guards the mutation "return the same array regardless of hand", which every individual
    // assertion above would still pass if only one of them were kept.
    expect(orderByThumb('left', 'A', 'B')).not.toEqual(orderByThumb('right', 'A', 'B'))
  })
})

describe('handedness — the physical edges (absolute-positioned slots)', () => {
  it('names the thumb edge and its opposite, and they are always opposite', () => {
    expect(thumbEdge('right')).toBe('right')
    expect(offhandEdge('right')).toBe('left')
    expect(thumbEdge('left')).toBe('left')
    expect(offhandEdge('left')).toBe('right')
    for (const h of ['left', 'right', 'junk']) expect(thumbEdge(h)).not.toBe(offhandEdge(h))
  })

  it('defaults to the right edge — comboboxInput’s shipped ⌨/🎤 positions are unchanged', () => {
    expect(thumbEdge(undefined)).toBe('right')
    expect(offhandEdge(undefined)).toBe('left')
  })
})
