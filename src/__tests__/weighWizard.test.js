// weighWizard.test.js — V4-WEIGHWIZARDFLOW-001 (BD-055) Slice 1, the step machine.
// Pure functions, so this is the one part of the wizard a green jsdom run says something true
// about. Every LAYOUT claim in the design lives in tests/harness instead.
import { describe, it, expect } from 'vitest'
import {
  STEP_PLANTING, STEP_QUANTITY, STEP_WEIGHT, STEP_MORE, STEP_ORDER, LAST_BUILT_STEP,
  advance, back, canGoBack, isDirty, stepIndex, stepTitle,
} from '../lib/weighWizard.js'

describe('step order', () => {
  it('is Dave\'s flow: planting -> how many -> weight -> add more', () => {
    expect(STEP_ORDER).toEqual([STEP_PLANTING, STEP_QUANTITY, STEP_WEIGHT, STEP_MORE])
  })

  it('back is the order read right-to-left, so the two can never disagree', () => {
    for (let i = 1; i < STEP_ORDER.length; i++) {
      expect(back(STEP_ORDER[i])).toBe(STEP_ORDER[i - 1])
    }
  })
})

describe('advance', () => {
  it('stops at the last BUILT step — slice 1 hands off to the form rather than opening a blank sheet', () => {
    expect(LAST_BUILT_STEP).toBe(STEP_PLANTING)
    expect(advance(STEP_PLANTING)).toBeNull()
  })

  it('walks the whole flow once later slices raise the horizon', () => {
    // The lastBuilt seam is what makes each slice a one-word change rather than a rewrite; this
    // pins that the ORDER is already correct, not just slice 1's edge.
    expect(advance(STEP_PLANTING, { lastBuilt: STEP_MORE })).toBe(STEP_QUANTITY)
    expect(advance(STEP_QUANTITY, { lastBuilt: STEP_MORE })).toBe(STEP_WEIGHT)
    expect(advance(STEP_WEIGHT, { lastBuilt: STEP_MORE })).toBe(STEP_MORE)
    expect(advance(STEP_MORE, { lastBuilt: STEP_MORE })).toBeNull()
  })

  it('returns null for an unknown step instead of walking off the front of the array', () => {
    // stepIndex('nope') is -1; +1 would silently yield STEP_PLANTING and restart the flow.
    expect(stepIndex('nope')).toBe(-1)
    expect(advance('nope', { lastBuilt: STEP_MORE })).toBeNull()
  })
})

describe('back', () => {
  it('has no edge off step 1 — the exit there is dismiss, not back', () => {
    expect(back(STEP_PLANTING)).toBeNull()
    expect(canGoBack(STEP_PLANTING)).toBe(false)
    expect(canGoBack(STEP_QUANTITY)).toBe(true)
  })

  it('returns a destination only — nothing here clears a value', () => {
    // Back is NAVIGATION, never erasure (design §5). If a future edit makes back() return an entry
    // or a reset, this shape assertion fails and the reviewer is forced to notice.
    expect(typeof back(STEP_WEIGHT)).toBe('string')
  })
})

describe('isDirty — the in-flight entry only', () => {
  it('is false for nothing entered', () => {
    expect(isDirty(null)).toBe(false)
    expect(isDirty(undefined)).toBe(false)
    expect(isDirty({})).toBe(false)
    expect(isDirty({ plant_id: '', quantity: '', weight: '' })).toBe(false)
  })

  it('treats whitespace as nothing — a focused-and-cleared Input leaves "", not undefined', () => {
    expect(isDirty({ quantity: '   ' })).toBe(false)
  })

  it('is true for any one of planting, quantity or weight', () => {
    expect(isDirty({ plant_id: 'plant-1' })).toBe(true)
    expect(isDirty({ quantity: '3' })).toBe(true)
    // Weight is OPTIONAL on save but still counts here: the user typed it, so losing it is a loss.
    expect(isDirty({ weight: '337' })).toBe(true)
  })

  it('counts a literal zero, which a truthy test would drop', () => {
    expect(isDirty({ quantity: '0' })).toBe(true)
  })
})

describe('stepTitle', () => {
  it('names the planting on every step that holds a number', () => {
    // The mitigation for the original crucible's top usability failure — grams landing in the next
    // row's quantity. A number must never be ambiguous about what it belongs to.
    expect(stepTitle(STEP_QUANTITY, 'Sungold')).toContain('Sungold')
    expect(stepTitle(STEP_WEIGHT, 'Sungold')).toContain('Sungold')
    expect(stepTitle(STEP_MORE, 'Sungold')).toContain('Sungold')
  })

  it('does not name one on step 1, where none is chosen yet', () => {
    expect(stepTitle(STEP_PLANTING, 'Sungold')).toBe('Weigh-in')
  })

  it('degrades to the bare label rather than rendering "undefined" when the name is missing', () => {
    expect(stepTitle(STEP_QUANTITY, null)).toBe('How many')
    expect(stepTitle('nope', 'Sungold')).toBeNull()
  })
})
