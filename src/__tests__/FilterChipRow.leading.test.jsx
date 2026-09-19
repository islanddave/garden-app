// V5-SEEDCARDS-001 — FilterChipRow's optional per-option `leading` node (the supplier swatch in My
// seeds). The contract is additive: an option WITHOUT `leading` must render exactly as before, and one
// with it draws the node before the label inside the same aria-pressed button.
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import FilterChipRow from '../components/forms/FilterChipRow.jsx'

describe('FilterChipRow — optional leading node', () => {
  it('an option without `leading` renders its label as the button\'s only child (byte-identical arm)', () => {
    render(<FilterChipRow options={[{ value: 'a', label: 'Alpha' }]} selected={new Set()} onToggle={() => {}} />)
    const btn = screen.getByRole('button', { name: 'Alpha' })
    expect(btn.childNodes).toHaveLength(1)
    expect(btn.firstChild.nodeType).toBe(Node.TEXT_NODE)
  })

  it('an option with `leading` draws it before the label, inside the same pressed-state button', () => {
    render(
      <FilterChipRow
        options={[{ value: 'b', label: 'Beta', leading: <span data-testid="swatch" /> }]}
        selected={new Set(['b'])}
        onToggle={() => {}}
      />,
    )
    const btn = screen.getByRole('button', { name: 'Beta' })
    expect(btn.getAttribute('aria-pressed')).toBe('true')
    const swatch = screen.getByTestId('swatch')
    expect(btn.contains(swatch)).toBe(true)
    expect(swatch.compareDocumentPosition(btn.querySelector('span').lastChild) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
