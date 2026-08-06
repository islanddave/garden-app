// V4-NAVSTATE-002 — truth table for the scroll-restore retry decision.
//
// This is the half of the restore that CAN be tested. jsdom stubs window.scrollTo and never
// computes layout, so "did the row physically land near the top" is not assertable here at any
// effort — that belongs on the device gate. What is assertable is the decision: given where we
// are, where we want to be, and how many frames we have spent, do we retry, stop having landed,
// or stop having failed. src/lib/** is in coverage.include; src/pages/Garden.jsx is not.
import { describe, it, expect } from 'vitest'
import {
  restoreStep,
  hasRestoreTarget,
  RESTORE_TOLERANCE_PX,
  RESTORE_MAX_FRAMES,
} from '../lib/scrollRestore.js'

describe('restoreStep — landing', () => {
  it('is DONE on an exact hit', () => {
    expect(restoreStep({ currentY: 900, targetY: 900, frames: 1 })).toBe('DONE')
  })

  it.each([RESTORE_TOLERANCE_PX, -RESTORE_TOLERANCE_PX])(
    'is DONE at exactly the tolerance boundary (%i px off)',
    (delta) => {
      expect(restoreStep({ currentY: 900 + delta, targetY: 900, frames: 1 })).toBe('DONE')
    }
  )

  it('is RETRY one pixel outside the tolerance', () => {
    expect(restoreStep({ currentY: 900 + RESTORE_TOLERANCE_PX + 1, targetY: 900, frames: 1 }))
      .toBe('RETRY')
  })

  // The clamp is the whole reason this module exists: the window collapsed to 24 tiles, so the
  // document is short and the browser silently drops us well above the target.
  it('is RETRY when a clamp landed us far short', () => {
    expect(restoreStep({ currentY: 600, targetY: 5000, frames: 1 })).toBe('RETRY')
  })

  // Landing counts even if it took every frame — DONE must win over EXHAUSTED, or a restore that
  // succeeds on the last possible frame would be reported as a failure and trigger a fallback.
  it('prefers DONE over EXHAUSTED when both conditions hold', () => {
    expect(restoreStep({ currentY: 900, targetY: 900, frames: RESTORE_MAX_FRAMES })).toBe('DONE')
  })
})

describe('restoreStep — termination', () => {
  it('is EXHAUSTED once the frame budget is spent', () => {
    expect(restoreStep({ currentY: 600, targetY: 5000, frames: RESTORE_MAX_FRAMES }))
      .toBe('EXHAUSTED')
  })

  it('is EXHAUSTED past the budget, never RETRY', () => {
    expect(restoreStep({ currentY: 600, targetY: 5000, frames: RESTORE_MAX_FRAMES + 10 }))
      .toBe('EXHAUSTED')
  })

  // The loop must be provably finite: whatever it is handed, it terminates within the budget.
  // A restore that spins would keep calling scrollTo forever and fight the user permanently.
  it('always terminates within the frame budget for an unreachable target', () => {
    let frames = 0
    let step
    do {
      frames += 1
      step = restoreStep({ currentY: 0, targetY: 99999, frames })
    } while (step === 'RETRY' && frames < 1000)
    expect(step).toBe('EXHAUSTED')
    expect(frames).toBe(RESTORE_MAX_FRAMES)
  })

  it.each([
    ['currentY NaN', { currentY: NaN, targetY: 900, frames: 1 }],
    ['targetY NaN', { currentY: 100, targetY: NaN, frames: 1 }],
    ['frames NaN', { currentY: 100, targetY: 900, frames: NaN }],
    ['currentY Infinity', { currentY: Infinity, targetY: 900, frames: 1 }],
  ])('is EXHAUSTED rather than looping on a non-finite reading (%s)', (_label, s) => {
    expect(restoreStep(s)).toBe('EXHAUSTED')
  })
})

describe('hasRestoreTarget', () => {
  // The v1 bug: the one-shot latch was set BEFORE this check, so an inert mount permanently
  // disarmed the restore. Keeping the predicate separate is what lets the caller avoid that.
  it.each([0, -1, -0.5])('is false for a non-positive offset (%p)', (y) => {
    expect(hasRestoreTarget(y)).toBe(false)
  })

  it.each([NaN, Infinity, undefined, null, '900'])('is false for a non-finite offset (%p)', (y) => {
    expect(hasRestoreTarget(y)).toBe(false)
  })

  it.each([1, 640, 5000])('is true for a real offset (%p)', (y) => {
    expect(hasRestoreTarget(y)).toBe(true)
  })
})
