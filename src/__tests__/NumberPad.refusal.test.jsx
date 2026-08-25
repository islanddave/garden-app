// NumberPad.refusal — a REFUSED key must be observable, and must still change nothing.
//
// The change under test: refused keys carry `aria-disabled` instead of the DOM `disabled`
// attribute, so the press actually dispatches, and the value guard lives in press() instead of in
// the DOM. Both halves need pinning, and the second is the dangerous half — moving a guard out of
// the platform and into a handler is how a guard quietly stops guarding.
//
// ⚠️ EVERY PRESS HERE USES NATIVE `el.click()`, NEVER `fireEvent.click`, AND THAT IS NOT A STYLE
// CHOICE. Measured in this jsdom (throwaway probe, 2026-08-25):
//     DOM `disabled` + fireEvent.click -> the event BUBBLES; React's onClick does not fire
//     DOM `disabled` + el.click()      -> nothing dispatches at all      <- what a real browser does
//     `aria-disabled` + either         -> both fire
// So a bubbling assertion written with fireEvent.click passes whether or not this change is
// present — it cannot tell the two mechanisms apart, and the first draft of this file shipped
// exactly that vacuous test. el.click() is the only dispatch here that models the browser.
//
// ⚠️ AND EVERY REFUSAL CASE ASSERTS BOTH HALVES IN THE SAME TEST — that the press WAS observed, and
// that onChange was NOT called. Alone, "onChange was not called" is a negative that passes most
// loudly when nothing dispatched at all, which is precisely the bug. The pair is what has teeth:
// revert to DOM `disabled` and the first half fails; drop the guard and the second half does.
//
// "onChange was not called" is also deliberately not "the value did not change". appendDigit is
// idempotent for a refused key, so a broken guard still produces an identical string — a value
// assertion would pass with the bug present. It is not a no-op at the call site either: EventNew's
// handler builds a fresh object and clears harvestError on every onChange, so a refused tap that
// reaches it wipes a validation message off the screen.
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import NumberPad from '../components/NumberPad.jsx'
import { PAD_MAX_LEN } from '../lib/numberPad.js'

const pad = (props = {}) => {
  const onChange = vi.fn()
  const utils = render(
    <NumberPad
      value=""
      onChange={onChange}
      idPrefix="wt-key"
      ariaLabel="Weight keypad"
      keyAriaPrefix="Weight"
      {...props}
    />
  )
  // Listener on the GROUP, so an observed press also proves the event bubbles out of the key —
  // which is what any future feedback (a haptic, a live-region announcement) would hang on.
  const seen = vi.fn()
  screen.getByRole('group', { name: 'Weight keypad' }).addEventListener('click', seen)
  return { ...utils, onChange, seen }
}

const grid = () => screen.getByRole('group', { name: 'Weight keypad' })
const key = (id) => screen.getByTestId(`wt-key-${id}`)

describe('NumberPad — refused keys', () => {
  it('marks a refused key aria-disabled and leaves it OPERABLE', () => {
    // The DOM property is the falsifiable half: `disabled` is what suppresses the event, so it is
    // what must be false. aria-disabled alone on a disabled button would announce correctly and
    // still dispatch nothing.
    pad({ value: '3.5' })            // a second '.' cannot change '3.5'
    expect(key('dot').getAttribute('aria-disabled')).toBe('true')
    expect(key('dot').disabled).toBe(false)
  })

  it('an accepted key carries no aria-disabled attribute at all', () => {
    // Not `aria-disabled="false"`: present-and-false is a different thing to a screen reader than
    // absent, and every key on the pad would carry it.
    pad({ value: '3' })
    expect(key('7').hasAttribute('aria-disabled')).toBe(false)
    expect(key('7').disabled).toBe(false)
  })

  it('a refused key is OBSERVED and still changes nothing — every refusal branch', () => {
    // The blocker this change exists to clear: a `disabled` button dispatches nothing, so a refusal
    // is observable by nothing — no event, no announcement, no feedback, only the dimming. Each
    // case below is a different branch of appendDigit.
    const cases = [
      ['3.5', 'dot'],                          // a second decimal point
      ['', 'back'],                            // backspace on an empty field
      ['0', '0'],                              // a leading-zero build-up
      ['1'.repeat(PAD_MAX_LEN), '7'],          // a digit at the length cap
      ['1'.repeat(PAD_MAX_LEN), 'dot'],        // a decimal point at the length cap
    ]
    for (const [value, k] of cases) {
      const { onChange, seen, unmount } = pad({ value })
      expect(key(k).getAttribute('aria-disabled')).toBe('true') // the dimming agrees it is refused
      key(k).click()
      expect(seen).toHaveBeenCalledTimes(1)     // ← the press dispatched and bubbled
      expect(onChange).not.toHaveBeenCalled()   // ← and the guard held
      unmount()
    }
  })

  it('an ACCEPTED key still calls onChange with the appended value', () => {
    // Non-vacuity for the guard. Without this, a press() that returned unconditionally would pass
    // every refusal case above, and the pad would be a very well-tested brick.
    for (const [value, k, expected] of [
      ['', '7', '7'], ['3', '7', '37'], ['3', 'dot', '3.'], ['', 'dot', '0.'],
      ['37', 'back', '3'], ['0', '5', '5'],
    ]) {
      const { onChange, seen, unmount } = pad({ value })
      expect(key(k).hasAttribute('aria-disabled')).toBe(false)
      key(k).click()
      expect(seen).toHaveBeenCalledTimes(1)
      expect(onChange).toHaveBeenCalledTimes(1)
      expect(onChange).toHaveBeenCalledWith(expected)
      unmount()
    }
  })

  it('a null/undefined value + ⌫ is REFUSED, not accepted', () => {
    // The normalisation trap, and it is not hypothetical: press() compares `next` against `cur`,
    // and appendDigit(null, '⌫') returns ''. Compare against the RAW value and `'' === null` is
    // false, so this takes the ACCEPT path and calls onChange('') — while the key sits there
    // dimmed, because padKeyDisabled normalises and correctly says refused. The dimming and the
    // behaviour would disagree on the one case a user hits by opening the field and tapping ⌫.
    for (const value of [null, undefined]) {
      const { onChange, seen, unmount } = pad({ value })
      expect(key('back').getAttribute('aria-disabled')).toBe('true')
      key('back').click()
      expect(seen).toHaveBeenCalledTimes(1)
      expect(onChange).not.toHaveBeenCalled()
      unmount()
    }
  })

  it('keeps the dimming, the cell count and the geometry when keys are refused', () => {
    // The standing rule (comboboxInput.js:138-144): a refused key dims, it does not vanish, resize
    // or move. Swapping the attribute must not have changed any of that.
    pad({ value: '3.5' })
    const dot = key('dot')
    expect(dot.style.opacity).toBe('0.35')
    expect(dot.style.cursor).toBe('default')
    expect(dot.style.minHeight).toBe('56px')
    expect(grid().children).toHaveLength(12)
    expect(grid().style.gridTemplateColumns).toBe('repeat(6, 1fr)')
    // ...and an accepted key is NOT dimmed, so the branch is doing something.
    expect(key('7').style.opacity).toBe('')
    expect(key('7').style.cursor).toBe('pointer')
  })

  it('keeps refused keys in the focus order', () => {
    // `disabled` removes a key from TalkBack's swipe order entirely, so today a screen-reader user
    // cannot even reach the refused key to be told why it did nothing.
    pad({ value: '3.5' })
    key('dot').focus()
    expect(document.activeElement).toBe(key('dot'))
  })
})

// NAMED MUTATION TARGETS — applied to src/components/NumberPad.jsx, run, VERIFIED red on the listed
// case, reverted from a `cp` copy (never `git checkout --`). Recorded 2026-08-25.
//   R1  aria-disabled -> DOM disabled (revert the swap)  => "marks a refused key ... OPERABLE"
//                                                         + "is OBSERVED and still changes nothing"
//   R2  drop `if (next === cur) return` from press()     => "is OBSERVED and still changes nothing"
//                                                         (NOT a value assertion — appendDigit is
//                                                          idempotent, so the string is identical)
//   R3  compare raw `value` instead of normalised `cur`  => "a null/undefined value + ⌫"
//   R4  press() returns unconditionally (guard too wide) => "an ACCEPTED key still calls onChange"
//   R5  aria-disabled={!!disabled} (present-and-false)   => "no aria-disabled attribute at all"
//   R6  drop the opacity/cursor dimming branch           => "keeps the dimming, the cell count"
