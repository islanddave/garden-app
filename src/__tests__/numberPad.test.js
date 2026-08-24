// numberPad — V4-QUICKHITRANGE-001 (BD-047) / V4-WEIGHKBDNEXT-001 (BD-046).
//
// WHAT THIS CAN AND CANNOT PROVE. appendDigit is pure string math, so everything below is a real
// falsifiable assertion. The pad's VALUE claim — that it removes the soft keyboard and buys back
// ~300px of a 390px viewport — is NOT testable here: jsdom has no layout engine and no keyboard
// (tests/harness/README.md:14-16, every getBoundingClientRect returns zeros). That claim needs
// tests/harness/. Do not read a green run here as evidence the pad is worth its screen space.
import { describe, it, expect } from 'vitest'
import { appendDigit, padKeyDisabled, PAD_BACKSPACE, PAD_MAX_LEN } from '../lib/numberPad.js'

describe('appendDigit — build, not replace', () => {
  it('appends rather than replacing: 1 then 3 is 13, not 3', () => {
    // The entire reason this module exists. Under the outgoing chips this sequence yielded '3'.
    expect(appendDigit(appendDigit('', '1'), '3')).toBe('13')
  })

  it('leaves the single-digit fast path at exactly one tap', () => {
    // 83.2% of measured prod quantities are a single digit. If this regresses, the feature is a
    // net loss no matter how good the tail is.
    expect(appendDigit('', '7')).toBe('7')
  })

  it('builds arbitrarily long values up to the cap', () => {
    expect(['1', '2', '3', '4'].reduce((v, d) => appendDigit(v, d), '')).toBe('1234')
  })

  it('treats null/undefined as an empty field', () => {
    expect(appendDigit(null, '5')).toBe('5')
    expect(appendDigit(undefined, '5')).toBe('5')
  })
})

describe('appendDigit — leading zero', () => {
  it('does not build 05: a digit after a lone 0 replaces it', () => {
    expect(appendDigit('0', '5')).toBe('5')
  })

  it('a second 0 on a lone 0 is a no-op rather than 00', () => {
    expect(appendDigit('0', '0')).toBe('0')
  })

  it('but 0. keeps building — 0.5 is a real weight', () => {
    expect(appendDigit(appendDigit('0', '.'), '5')).toBe('0.5')
  })
})

describe('appendDigit — the decimal point', () => {
  it('a leading . becomes 0. rather than a bare .', () => {
    expect(appendDigit('', '.')).toBe('0.')
  })

  it('appends a . mid-value', () => {
    expect(appendDigit('12', '.')).toBe('12.')
  })

  it('REFUSES a second . — Number("3.4.5") is NaN', () => {
    // The failure this guards is late and confusing: validateHarvest() would reject the whole
    // entry with a generic message only after the user finished typing. Refuse at the keypress.
    expect(appendDigit('3.4', '.')).toBe('3.4')
    expect(Number(appendDigit('3.4', '.'))).not.toBeNaN()
  })

  it('never produces a value Number() cannot parse, over a long random-ish key sequence', () => {
    const keys = ['1', '.', '2', '.', '0', '.', '9', '.', '3', '.']
    const built = keys.reduce((v, k) => appendDigit(v, k), '')
    expect(Number(built)).not.toBeNaN()
    expect((built.match(/\./g) || []).length).toBeLessThanOrEqual(1)
  })
})

describe('appendDigit — backspace', () => {
  it('removes the last character', () => {
    expect(appendDigit('137', PAD_BACKSPACE)).toBe('13')
  })

  it('removes a trailing decimal point like any other character', () => {
    expect(appendDigit('13.', PAD_BACKSPACE)).toBe('13')
  })

  it('is a safe no-op on an empty field', () => {
    expect(appendDigit('', PAD_BACKSPACE)).toBe('')
  })

  it('can fully undo a mis-built value — the reason ⌫ is mandatory, not optional', () => {
    // Under replace semantics a mis-tap was corrected by tapping the right chip. Under build
    // semantics it COMPOUNDS, so without this the pad would be strictly worse than the chips.
    let v = ['9', '9', '9'].reduce((acc, d) => appendDigit(acc, d), '')
    expect(v).toBe('999')
    v = [PAD_BACKSPACE, PAD_BACKSPACE, PAD_BACKSPACE].reduce((acc, k) => appendDigit(acc, k), v)
    expect(v).toBe('')
  })
})

describe('appendDigit — length cap', () => {
  it('stops accepting digits at the cap', () => {
    const full = '1'.repeat(PAD_MAX_LEN)
    expect(appendDigit(full, '9')).toBe(full)
  })

  it('honours an explicit maxLen', () => {
    expect(appendDigit('12', '3', { maxLen: 2 })).toBe('12')
    expect(appendDigit('1', '3', { maxLen: 2 })).toBe('13')
  })

  it('still allows backspace at the cap — the cap must never trap the user', () => {
    const full = '1'.repeat(PAD_MAX_LEN)
    expect(appendDigit(full, PAD_BACKSPACE)).toBe('1'.repeat(PAD_MAX_LEN - 1))
  })

  it('ignores keys that are not digits, . or ⌫', () => {
    expect(appendDigit('12', 'e')).toBe('12')
    expect(appendDigit('12', '-')).toBe('12')
    expect(appendDigit('12', '')).toBe('12')
  })
})

describe('padKeyDisabled', () => {
  it('disables the . once one is present', () => {
    expect(padKeyDisabled('3.4', '.')).toBe(true)
    expect(padKeyDisabled('34', '.')).toBe(false)
  })

  it('disables ⌫ on an empty field only', () => {
    expect(padKeyDisabled('', PAD_BACKSPACE)).toBe(true)
    expect(padKeyDisabled('1', PAD_BACKSPACE)).toBe(false)
  })

  it('disables digits at the cap', () => {
    expect(padKeyDisabled('1'.repeat(PAD_MAX_LEN), '5')).toBe(true)
    expect(padKeyDisabled('1', '5')).toBe(false)
  })

  it('agrees with appendDigit by construction — a disabled key never changes the value', () => {
    // Guards the two from drifting apart, which would render a live-looking key that does nothing.
    for (const value of ['', '0', '3.4', '12', '1'.repeat(PAD_MAX_LEN)]) {
      for (const key of ['0', '5', '.', PAD_BACKSPACE]) {
        if (padKeyDisabled(value, key)) expect(appendDigit(value, key)).toBe(value)
      }
    }
  })
})
