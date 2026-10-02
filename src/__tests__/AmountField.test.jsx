// Put-Up R2a (prep) — src/components/pantry/AmountField.jsx: the shared amount-and-unit control, its two
// unit sets, the one reading of a typed number (parseAmount) and the words for a half-filled pair.
// Mounted nowhere by prep; these tests are its whole contract for the lanes that mount it. Every unit is
// bound to the server's stored list, so a chip can never send a unit the Lambda refuses.
// MUTATION: let parseAmount accept 0 -> the '0' cell of "parseAmount" reds.
// CI lane: `npm test` plus the TZ re-run. Nothing here reads a clock. No jest-dom (L-182).
import React, { useState } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import AmountField, {
  SIZE_UNITS, MORE_SIZE_UNITS, ITEM_AMOUNT_UNITS, MORE_ITEM_AMOUNT_UNITS, SIZE_WORDS, AMOUNT_WORDS,
  UNIT_GROUP_LABEL, MORE_UNITS_LABEL, parseAmount, amountError,
} from '../components/pantry/AmountField.jsx'
import { KITCHEN_UNITS } from '../../lambda/preservation/kitchenBatch.js'
import { JAR_UNITS, jarQuantityError } from '../../lambda/preservation/jarRules.js'
import { expectNoA11yViolations, A11Y_RULES } from './helpers/axe.js'

afterEach(() => cleanup())

const BANNED = /\b(safe|shelf life|shelf-stable|keeps|good|ready|done|expired|table|default|basis)\b/i
const READ_ATTRS = ['aria-label', 'placeholder', 'title', 'alt']
function wordsOf(root) {
  const out = [root.textContent]
  for (const el of [root, ...root.querySelectorAll('*')]) {
    for (const a of READ_ATTRS) if (el.hasAttribute?.(a)) out.push(el.getAttribute(a))
  }
  return out.filter(Boolean)
}

const SETS = [
  ['SIZE_UNITS', SIZE_UNITS], ['MORE_SIZE_UNITS', MORE_SIZE_UNITS],
  ['ITEM_AMOUNT_UNITS', ITEM_AMOUNT_UNITS], ['MORE_ITEM_AMOUNT_UNITS', MORE_ITEM_AMOUNT_UNITS],
]
const labels = (set) => set.map(o => o.label)

// A host: holds the pair, as the door will. The size words unless told otherwise.
function Host({ start = { value: '', unit: null }, spy = () => {}, words = SIZE_WORDS, units = SIZE_UNITS, moreUnits = MORE_SIZE_UNITS, ...rest }) {
  const [v, setV] = useState(start)
  return <AmountField value={v.value} unit={v.unit} label={words.label} placeholder={words.placeholder}
    clearLabel={words.clearLabel} units={units} moreUnits={moreUnits} idPrefix="t" {...rest}
    onChange={(next) => { spy(next); setV(next) }} />
}
const input = () => screen.getByTestId('t-value')
const chip = (unit) => screen.getByTestId(`t-unit-${unit}`)
const chips = () => [...screen.getByTestId('t-units').querySelectorAll('[role="radio"]')]

describe('the unit sets', () => {
  it.each(SETS)('%s: every value is one of the server\'s stored units (KITCHEN_UNITS), so both routes take it', (_name, set) => {
    expect(set.length).toBeGreaterThan(0)
    for (const o of set) {
      expect(`${o.value}: ${KITCHEN_UNITS.includes(o.value)}`).toBe(`${o.value}: true`)
      expect(`${o.value}: ${JAR_UNITS.includes(o.value)}`).toBe(`${o.value}: true`)
      expect(jarQuantityError(1, o.value)).toBeNull()
    }
  })

  it.each(SETS)('%s: { label, value } pairs, frozen, no unit twice', (_name, set) => {
    expect(Object.isFrozen(set)).toBe(true)
    for (const o of set) expect(Object.keys(o).sort()).toEqual(['label', 'value'])
    expect(new Set(set.map(o => o.value)).size).toBe(set.length)
  })

  it('a put-up\'s size: cup · pint · qt · fl oz · lb · oz (weight), then the ten behind More units…', () => {
    expect(labels(SIZE_UNITS)).toEqual(['cup', 'pint', 'qt', 'fl oz', 'lb', 'oz (weight)'])
    expect(labels(MORE_SIZE_UNITS)).toEqual(['gal', 'g', 'kg', 'ml', 'l', 'count', 'peck', 'bushel', 'half-bushel', 'flat'])
    expect(SIZE_UNITS.some(o => MORE_SIZE_UNITS.some(m => m.value === o.value))).toBe(false)
  })

  it('an as-is amount: lb · oz (weight) · count · bag · jar · qt, then the fourteen behind More units…', () => {
    expect(labels(ITEM_AMOUNT_UNITS)).toEqual(['lb', 'oz (weight)', 'count', 'bag', 'jar', 'qt'])
    expect(labels(MORE_ITEM_AMOUNT_UNITS)).toEqual([
      'pint', 'cup', 'fl oz', 'gal', 'g', 'kg', 'ml', 'l', 'bunch', 'head', 'peck', 'bushel', 'half-bushel', 'flat',
    ])
    expect(ITEM_AMOUNT_UNITS.some(o => MORE_ITEM_AMOUNT_UNITS.some(m => m.value === o.value))).toBe(false)
  })

  it('the label is the stored value, except the ounce — stored `oz`, never shown bare', () => {
    for (const [, set] of SETS) {
      for (const o of set) expect(o.label).toBe(o.value === 'oz' ? 'oz (weight)' : o.value)
    }
    expect(SIZE_UNITS.find(o => o.label === 'oz (weight)').value).toBe('oz')
  })

  it('not offered anywhere: a plural, `quart`, `other`; and no bag or jar on a put-up\'s size', () => {
    const all = SETS.flatMap(([, set]) => set.map(o => o.value))
    for (const no of ['quart', 'quarts', 'lbs', 'cups', 'pints', 'jars', 'bags', 'other']) expect(all).not.toContain(no)
    const size = [...SIZE_UNITS, ...MORE_SIZE_UNITS].map(o => o.value)
    expect(size).not.toContain('bag')
    expect(size).not.toContain('jar')
  })
})

describe('parseAmount', () => {
  it.each([
    ['0,5', 0.5], ['0.5', 0.5], ['.5', 0.5], ['1', 1], [' 2 ', 2], ['1.', 1], ['2.50', 2.5], ['12,25', 12.25],
    ['0.01', 0.01], ['0.005', 0.01], ['2.345', 2.35], ['2.344', 2.34], ['99999999.99', 99999999.99], ['99999999.994', 99999999.99],
  ])('%j is %s', (text, want) => {
    expect(parseAmount(text)).toBe(want)
  })

  it.each([
    ['0'], [''], ['abc'], ['1e3'], ['100000000'], ['0.00'], ['0.004'], ['-1'], ['+1'], ['1.2.3'], ['1,2,3'], ['1 000'],
    ['.'], [','], ['   '], ['99999999.995'], ['Infinity'], ['NaN'], ['0x10'], ['2 qt'],
  ])('%j is refused (null)', (text) => {
    expect(parseAmount(text)).toBeNull()
  })

  it('null and undefined are refused, and a number is read as its text', () => {
    expect(parseAmount(null)).toBeNull()
    expect(parseAmount(undefined)).toBeNull()
    expect(parseAmount(1.5)).toBe(1.5)
  })

  it('whatever it accepts the Lambda\'s own quantity rule accepts, with any unit offered', () => {
    for (const text of ['0,5', '0.01', '2.345', '99999999.99']) {
      const n = parseAmount(text)
      expect(Number.isFinite(n) && n >= 0.01 && n <= 99999999.99).toBe(true)
      expect(jarQuantityError(n, 'qt')).toBeNull()
    }
  })
})

describe('amountError', () => {
  it('empty is fine: the pair is optional', () => {
    expect(amountError({ value: '', unit: null }, SIZE_WORDS)).toBeNull()
    expect(amountError({ value: '   ', unit: null }, SIZE_WORDS)).toBeNull()
    expect(amountError()).toBeNull()
  })

  it('a number without a unit, in the binding words — size, and amount', () => {
    expect(amountError({ value: '1', unit: null }, SIZE_WORDS)).toBe('Pick a unit for the size — or clear the size.')
    expect(amountError({ value: '1', unit: null }, AMOUNT_WORDS)).toBe('Pick a unit for the amount — or clear the amount.')
  })

  it('a unit without a number above 0, in the binding words — size, and amount', () => {
    expect(amountError({ value: '', unit: 'qt' }, SIZE_WORDS)).toBe('Type the size as a number above 0 — or clear the size.')
    expect(amountError({ value: '0', unit: 'qt' }, SIZE_WORDS)).toBe('Type the size as a number above 0 — or clear the size.')
    expect(amountError({ value: 'abc', unit: 'lb' }, AMOUNT_WORDS)).toBe('Type the amount as a number above 0 — or clear the amount.')
    expect(amountError({ value: 'abc', unit: null }, AMOUNT_WORDS)).toBe('Type the amount as a number above 0 — or clear the amount.')
  })

  it('a whole pair has nothing to say; with no words given it speaks of the amount', () => {
    expect(amountError({ value: '0,5', unit: 'qt' }, SIZE_WORDS)).toBeNull()
    expect(amountError({ value: '2', unit: 'bag' }, AMOUNT_WORDS)).toBeNull()
    expect(amountError({ value: '2', unit: null })).toBe('Pick a unit for the amount — or clear the amount.')
  })
})

describe('AmountField — the control', () => {
  it('the number field: named by the label, text with a decimal keyboard, and its example', () => {
    render(<Host />)
    const f = input()
    expect(screen.getByLabelText('Size of each container')).toBe(f)
    expect(f.getAttribute('type')).toBe('text')
    expect(f.getAttribute('inputmode')).toBe('decimal')
    expect(f.getAttribute('enterkeyhint')).toBe('done')
    expect(f.getAttribute('placeholder')).toBe('e.g. 1')
  })

  it('the as-is words: How much, e.g. 2, Clear the amount', () => {
    render(<Host words={AMOUNT_WORDS} units={ITEM_AMOUNT_UNITS} moreUnits={MORE_ITEM_AMOUNT_UNITS} start={{ value: '2', unit: 'bag' }} />)
    expect(screen.getByLabelText('How much')).toBe(input())
    expect(input().getAttribute('placeholder')).toBe('e.g. 2')
    expect(screen.getByTestId('t-clear').textContent).toBe('Clear the amount')
    expect(chips().map(c => c.textContent)).toEqual(['lb', 'oz (weight)', 'count', 'bag', 'jar', 'qt'])
    expect(chip('bag').getAttribute('aria-checked')).toBe('true')
  })

  it('Enter leaves the field (it submits nothing)', () => {
    render(<Host start={{ value: '1', unit: null }} />)
    const f = input()
    f.focus()
    expect(document.activeElement).toBe(f)
    const notPrevented = fireEvent.keyDown(f, { key: 'Enter' })
    expect(notPrevented).toBe(false)
    expect(document.activeElement).not.toBe(f)
  })

  it('typing hands back the text as typed (a comma included) with the unit beside it', () => {
    const spy = vi.fn()
    render(<Host spy={spy} start={{ value: '', unit: 'qt' }} />)
    fireEvent.change(input(), { target: { value: '0,5' } })
    expect(spy).toHaveBeenLastCalledWith({ value: '0,5', unit: 'qt' })
    expect(input().value).toBe('0,5')
  })

  it('the unit chips are one group named Unit; a tap chooses, and hands back the typed text with it', () => {
    const spy = vi.fn()
    render(<Host spy={spy} start={{ value: '1', unit: null }} />)
    expect(screen.getByRole('radiogroup', { name: UNIT_GROUP_LABEL })).toBe(screen.getByTestId('t-units'))
    expect(UNIT_GROUP_LABEL).toBe('Unit')
    expect(chips().map(c => c.textContent)).toEqual(['cup', 'pint', 'qt', 'fl oz', 'lb', 'oz (weight)'])
    expect(chips().every(c => c.getAttribute('aria-checked') === 'false')).toBe(true)
    fireEvent.click(chip('qt'))
    expect(spy).toHaveBeenLastCalledWith({ value: '1', unit: 'qt' })
    expect(chip('qt').getAttribute('aria-checked')).toBe('true')
    fireEvent.click(chip('oz'))
    expect(spy).toHaveBeenLastCalledWith({ value: '1', unit: 'oz' })
  })

  it('More units… opens the rest in the same group, and goes', () => {
    render(<Host />)
    const more = screen.getByTestId('t-unit-more')
    expect(more.textContent).toBe(MORE_UNITS_LABEL)
    expect(MORE_UNITS_LABEL).toBe('More units…')
    fireEvent.click(more)
    expect(chips().map(c => c.textContent)).toEqual([...labels(SIZE_UNITS), ...labels(MORE_SIZE_UNITS)])
    expect(screen.queryByTestId('t-unit-more')).toBeNull()
  })

  it('a chosen More unit stays as one chip while the rest are closed', () => {
    render(<Host start={{ value: '1', unit: 'gal' }} />)
    expect(chips().map(c => c.textContent)).toEqual([...labels(SIZE_UNITS), 'gal'])
    expect(chip('gal').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('t-unit-more')).toBeTruthy()
  })

  it('with nothing behind it, More units… is not drawn', () => {
    render(<Host moreUnits={[]} />)
    expect(screen.queryByTestId('t-unit-more')).toBeNull()
  })

  it('Clear appears once either half is filled, and empties both', () => {
    const spy = vi.fn()
    render(<Host spy={spy} />)
    expect(screen.queryByTestId('t-clear')).toBeNull()
    fireEvent.click(chip('qt'))
    expect(screen.getByTestId('t-clear').textContent).toBe('Clear the size')
    fireEvent.click(screen.getByTestId('t-clear'))
    expect(spy).toHaveBeenLastCalledWith({ value: '', unit: null })
    expect(input().value).toBe('')
    expect(chips().every(c => c.getAttribute('aria-checked') === 'false')).toBe(true)
    expect(screen.queryByTestId('t-clear')).toBeNull()
  })

  it('`invalid` marks the number field and the unit group', () => {
    const { unmount } = render(<Host />)
    expect(input().getAttribute('aria-invalid')).toBeNull()
    expect(screen.getByTestId('t-units').getAttribute('aria-invalid')).toBeNull()
    unmount()
    render(<Host invalid />)
    expect(input().getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByTestId('t-units').getAttribute('aria-invalid')).toBe('true')
  })

  it('every chip, both links and the number field are 48 px targets', () => {
    render(<Host start={{ value: '1', unit: 'qt' }} />)
    for (const c of chips()) expect(c.style.minHeight).toBe('48px')
    expect(screen.getByTestId('t-unit-more').style.minHeight).toBe('48px')
    expect(screen.getByTestId('t-clear').style.minHeight).toBe('48px')
    expect(input().style.minHeight).toBe('48px')
  })

  it('`disabled` disables every control', () => {
    render(<Host start={{ value: '1', unit: 'qt' }} disabled />)
    expect(input().disabled).toBe(true)
    expect(chips().every(c => c.disabled)).toBe(true)
    expect(screen.getByTestId('t-unit-more').disabled).toBe(true)
    expect(screen.getByTestId('t-clear').disabled).toBe(true)
  })

  it('axe is clean, empty and filled, the rest open (the gate rule set, with nested-interactive)', async () => {
    const rules = [...A11Y_RULES, 'nested-interactive']
    for (const start of [{ value: '', unit: null }, { value: '1', unit: 'gal' }]) {
      const { container, unmount } = render(<Host start={start} invalid={start.unit == null} />)
      fireEvent.click(screen.getByTestId('t-unit-more'))
      await expectNoA11yViolations(container, { label: `AmountField ${start.unit}`, rules })
      unmount()
    }
  })

  it('no banned word, in either use: the pattern bites, then every string read or read out is swept', () => {
    expect('Nothing is done here.').toMatch(BANNED)
    const swept = []
    for (const [words, units, moreUnits] of [[SIZE_WORDS, SIZE_UNITS, MORE_SIZE_UNITS], [AMOUNT_WORDS, ITEM_AMOUNT_UNITS, MORE_ITEM_AMOUNT_UNITS]]) {
      const { container, unmount } = render(<Host words={words} units={units} moreUnits={moreUnits} start={{ value: '1', unit: 'qt' }} />)
      swept.push(...wordsOf(container))
      fireEvent.click(screen.getByTestId('t-unit-more'))
      swept.push(...wordsOf(container))
      unmount()
      swept.push(amountError({ value: '1', unit: null }, words), amountError({ value: '', unit: 'qt' }, words))
    }
    expect(swept.length).toBeGreaterThan(8)
    expect(swept).toContain('e.g. 1')
    expect(swept).toContain('Unit')
    for (const s of swept) expect(`amount: ${s}`).not.toMatch(BANNED)
  })
})
