// Put-Up R2a (prep) — src/components/pantry/WhereFromField.jsx: the shared "where it's from" control.
// Mounted nowhere by prep; these tests are its whole contract for the lanes that mount it (the door, the
// jar's Edit, the item's Edit). The kinds are bound to the server's list, the words to the registry.
// MUTATION: make a second tap on the chosen chip keep it chosen -> "a second tap … un-chooses it" reds.
// CI lane: `npm test` plus the TZ re-run. Nothing here reads a clock. No jest-dom (L-182).
import React, { useState } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import WhereFromField, {
  whereFromError, FIRST_SOURCE_KINDS, MORE_SOURCE_KINDS, MORE_SOURCES_LABEL, WHICH_ONE_LABEL, WHICH_ONE_PLACEHOLDER,
  WHERE_EXACTLY_LABEL, WHERE_EXACTLY_ERROR, SOURCE_LABEL_MAX,
} from '../components/pantry/WhereFromField.jsx'
import { PUTUP_SOURCE_LABELS } from '../lib/dropdownRegistry.js'
import { expectNoA11yViolations, A11Y_RULES } from './helpers/axe.js'
import { VALID_SOURCE_KINDS, SOURCE_LABEL_MAX as SERVER_LABEL_MAX, validateProvenance } from '../../lambda/preservation/provenance.js'

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

const HEADING = 'Where it\'s from'
// A host: holds the pair, as the door will.
function Host({ start = { kind: null, label: '' }, spy = () => {}, ...rest }) {
  const [v, setV] = useState(start)
  return <WhereFromField kind={v.kind} label={v.label} heading={HEADING} idPrefix="t" {...rest}
    onChange={(next) => { spy(next); setV(next) }} />
}
const chip = (kind) => screen.getByTestId(`t-source-${kind}`)
const chips = () => [...screen.getByTestId('t-source').querySelectorAll('[role="radio"]')]
const nameField = () => screen.queryByTestId('t-source-label')

describe('WhereFromField — the kinds and their words', () => {
  it('the eight kinds offered are exactly the server\'s source kinds', () => {
    expect([...FIRST_SOURCE_KINDS, ...MORE_SOURCE_KINDS].sort()).toEqual([...VALID_SOURCE_KINDS].sort())
    expect(SOURCE_LABEL_MAX).toBe(SERVER_LABEL_MAX)
    render(<Host />)
    fireEvent.click(screen.getByTestId('t-source-more'))
    expect(chips().map(c => c.getAttribute('data-testid').replace('t-source-', '')).sort()).toEqual([...VALID_SOURCE_KINDS].sort())
  })

  it('four chips first — My garden · Farm stand · Store · Gift — and nothing is chosen', () => {
    render(<Host />)
    expect(chips().map(c => c.textContent)).toEqual(['My garden', 'Farm stand', 'Store', 'Gift'])
    expect(chips().every(c => c.getAttribute('aria-checked') === 'false')).toBe(true)
    expect(screen.getByRole('radiogroup', { name: HEADING })).toBeTruthy()
    expect(nameField()).toBeNull()
  })

  it('the reveal names what it holds, opens the other four in the same group, and goes', () => {
    render(<Host />)
    const more = screen.getByTestId('t-source-more')
    expect(more.textContent).toBe(MORE_SOURCES_LABEL)
    expect(MORE_SOURCES_LABEL).toBe('U-pick, CSA share, foraged, other…')
    fireEvent.click(more)
    expect(chips().map(c => c.textContent)).toEqual([
      'My garden', 'Farm stand', 'Store', 'Gift', 'U-pick / picked it myself', 'CSA share', 'Foraged', 'Other…',
    ])
    expect(screen.queryByTestId('t-source-more')).toBeNull()
  })

  it('every chip reads its word from PUTUP_SOURCE_LABELS, verbatim', () => {
    render(<Host />)
    fireEvent.click(screen.getByTestId('t-source-more'))
    for (const k of VALID_SOURCE_KINDS) expect(chip(k).textContent).toBe(PUTUP_SOURCE_LABELS[k])
  })

  it('a kind chosen from behind the reveal stays on the row as one chip while it is closed', () => {
    render(<Host start={{ kind: 'csa', label: '' }} />)
    expect(chips().map(c => c.textContent)).toEqual(['My garden', 'Farm stand', 'Store', 'Gift', 'CSA share'])
    expect(chip('csa').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('t-source-more')).toBeTruthy()
  })
})

describe('WhereFromField — choosing', () => {
  it('a tap chooses; a second tap on the chosen chip un-chooses it', () => {
    const spy = vi.fn()
    render(<Host spy={spy} />)
    fireEvent.click(chip('farm_stand'))
    expect(spy).toHaveBeenLastCalledWith({ kind: 'farm_stand', label: '' })
    expect(chip('farm_stand').getAttribute('aria-checked')).toBe('true')
    fireEvent.click(chip('farm_stand'))
    expect(spy).toHaveBeenLastCalledWith({ kind: null, label: '' })
    expect(chip('farm_stand').getAttribute('aria-checked')).toBe('false')
    expect(nameField()).toBeNull()
  })

  it('un-choosing empties a typed name with the kind (a name with no kind is refused by the server)', () => {
    const spy = vi.fn()
    render(<Host spy={spy} start={{ kind: 'store', label: 'Costco' }} />)
    fireEvent.click(chip('store'))
    expect(spy).toHaveBeenLastCalledWith({ kind: null, label: '' })
    expect(validateProvenance({ source_kind: null, source_label: 'Costco' })).not.toBeNull()
  })

  it('a typed name stays between two kinds that take one, and goes when the garden is chosen', () => {
    const spy = vi.fn()
    render(<Host spy={spy} start={{ kind: 'farm_stand', label: 'Warner Farms' }} />)
    fireEvent.click(chip('gift'))
    expect(spy).toHaveBeenLastCalledWith({ kind: 'gift', label: 'Warner Farms' })
    expect(nameField().value).toBe('Warner Farms')
    fireEvent.click(chip('own_garden'))
    expect(spy).toHaveBeenLastCalledWith({ kind: 'own_garden', label: '' })
    expect(nameField()).toBeNull()
  })

  it('typing a name hands back the kind with it', () => {
    const spy = vi.fn()
    render(<Host spy={spy} start={{ kind: 'store', label: '' }} />)
    fireEvent.change(nameField(), { target: { value: 'Costco' } })
    expect(spy).toHaveBeenLastCalledWith({ kind: 'store', label: 'Costco' })
  })
})

describe('WhereFromField — the name field', () => {
  it('no field for the garden, and none before a kind is chosen', () => {
    render(<Host start={{ kind: 'own_garden', label: '' }} />)
    expect(nameField()).toBeNull()
  })

  it('a kind that is not the garden and not Other: "Which one?", marked optional, with its example', () => {
    render(<Host start={{ kind: 'farm_stand', label: '' }} />)
    const f = nameField()
    expect(f.getAttribute('placeholder')).toBe(WHICH_ONE_PLACEHOLDER)
    expect(WHICH_ONE_PLACEHOLDER).toBe('e.g. Warner Farms')
    expect(f.getAttribute('aria-required')).toBeNull()
    const label = document.querySelector('label[for="t-source-label"]')
    expect(label.textContent).toBe(`${WHICH_ONE_LABEL}optional`)
    expect(WHICH_ONE_LABEL).toBe('Which one?')
    expect(Number(f.getAttribute('maxlength'))).toBe(SOURCE_LABEL_MAX)
  })

  it('Other: "Where exactly?", required', () => {
    render(<Host start={{ kind: 'other', label: '' }} />)
    const f = nameField()
    expect(f.getAttribute('aria-required')).toBe('true')
    expect(f.getAttribute('placeholder')).toBeNull()
    const label = document.querySelector('label[for="t-source-label"]')
    expect(label.textContent).toBe(`${WHERE_EXACTLY_LABEL}*`)
    expect(label.querySelector('[aria-hidden="true"]').textContent).toBe('*')
    expect(WHERE_EXACTLY_LABEL).toBe('Where exactly?')
    expect(chip('other').getAttribute('aria-checked')).toBe('true')
  })

  it('`invalid` marks the Other name, and only the Other name', () => {
    const { unmount } = render(<Host start={{ kind: 'other', label: '' }} invalid />)
    expect(nameField().getAttribute('aria-invalid')).toBe('true')
    unmount()
    render(<Host start={{ kind: 'store', label: '' }} invalid />)
    expect(nameField().getAttribute('aria-invalid')).toBeNull()
  })

  it('Enter leaves the field (it submits nothing)', () => {
    render(<Host start={{ kind: 'store', label: 'Costco' }} />)
    const f = nameField()
    f.focus()
    expect(document.activeElement).toBe(f)
    const notPrevented = fireEvent.keyDown(f, { key: 'Enter' })
    expect(notPrevented).toBe(false)
    expect(document.activeElement).not.toBe(f)
    expect(f.getAttribute('enterkeyhint')).toBe('done')
  })
})

describe('whereFromError', () => {
  it('Other with no name is the one refusal, in the binding words', () => {
    expect(whereFromError({ kind: 'other', label: '' })).toBe(WHERE_EXACTLY_ERROR)
    expect(whereFromError({ kind: 'other', label: '   ' })).toBe(WHERE_EXACTLY_ERROR)
    expect(whereFromError({ kind: 'other', label: null })).toBe(WHERE_EXACTLY_ERROR)
    expect(WHERE_EXACTLY_ERROR).toBe('Where exactly is it from? Type it — or pick another.')
  })

  it('everything else has nothing to say', () => {
    expect(whereFromError({ kind: 'other', label: 'the co-op' })).toBeNull()
    expect(whereFromError({ kind: 'farm_stand', label: '' })).toBeNull()
    expect(whereFromError({ kind: 'own_garden', label: '' })).toBeNull()
    expect(whereFromError({ kind: null, label: '' })).toBeNull()
    expect(whereFromError()).toBeNull()
  })

  it('agrees with the server: what it passes the Lambda\'s own rule passes, and what it refuses the Lambda refuses', () => {
    for (const kind of VALID_SOURCE_KINDS) {
      for (const label of ['', 'Warner Farms']) {
        const sent = { source_kind: kind, source_label: kind === 'own_garden' ? null : label }
        expect(`${kind}/${label}: ${whereFromError({ kind, label }) == null}`).toBe(`${kind}/${label}: ${validateProvenance(sent) == null}`)
      }
    }
  })
})

describe('WhereFromField — the surface', () => {
  it('every chip, the reveal and the name field are 48 px targets', () => {
    render(<Host start={{ kind: 'other', label: '' }} />)
    for (const c of chips()) expect(c.style.minHeight).toBe('48px')
    expect(screen.getByTestId('t-source-more').style.minHeight).toBe('48px')
    expect(nameField().style.minHeight).toBe('48px')
  })

  it('`disabled` disables every control', () => {
    render(<Host start={{ kind: 'store', label: '' }} disabled />)
    expect(chips().every(c => c.disabled)).toBe(true)
    expect(screen.getByTestId('t-source-more').disabled).toBe(true)
    expect(nameField().disabled).toBe(true)
  })

  it('axe is clean in every state (the gate rule set, with nested-interactive)', async () => {
    const rules = [...A11Y_RULES, 'nested-interactive']
    for (const start of [{ kind: null, label: '' }, { kind: 'farm_stand', label: 'Warner Farms' }, { kind: 'other', label: '' }]) {
      const { container, unmount } = render(<Host start={start} invalid={start.kind === 'other'} />)
      fireEvent.click(screen.getByTestId('t-source-more'))
      await expectNoA11yViolations(container, { label: `WhereFromField ${start.kind}`, rules })
      unmount()
    }
  })

  it('no banned word, in any state: the pattern bites, then every string read or read out is swept', () => {
    expect('Nothing is done here.').toMatch(BANNED)
    const swept = []
    for (const start of [{ kind: null, label: '' }, { kind: 'farm_stand', label: '' }, { kind: 'other', label: '' }]) {
      const { container, unmount } = render(<Host start={start} />)
      swept.push(...wordsOf(container))
      fireEvent.click(screen.getByTestId('t-source-more'))
      swept.push(...wordsOf(container))
      unmount()
    }
    swept.push(WHERE_EXACTLY_ERROR, MORE_SOURCES_LABEL, ...Object.values(PUTUP_SOURCE_LABELS))
    expect(swept.length).toBeGreaterThan(8)
    expect(swept).toContain('e.g. Warner Farms')
    for (const s of swept) expect(`where-from: ${s}`).not.toMatch(BANNED)
  })
})
