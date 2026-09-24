// V5-NAVCUSTOM-001 — Sheet's additive `headerStart` prop (the More sheet's "Edit tab bar" door).
//
// Sheet has ~20 render sites and one of them asked for this. The property that matters is the one
// the other 19 rely on: WITHOUT the prop, the header is byte-identical to what shipped. Each case names
// the mutation that reds it.
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import Sheet from '../components/forms/Sheet.jsx'

// The header row is the panel's second child (after the grab handle); its first child is the slot.
const headerOf = (container) => container.querySelector('[role="dialog"]').children[1]

describe('Sheet — headerStart', () => {
  // KILLING MUTATION: always render the slot wrapper (e.g. <div style={{flex:1, display:'flex'…}}>
  // with no children). RESULT: RED — every title-less sheet's markup changes.
  it('absent: the empty left slot is exactly the shipped spacer', () => {
    // The shipped spacer is `<div style={{ flex: 1 }} />`, serialised by the same renderer.
    const { container: ref } = render(<div style={{ flex: 1 }} />)
    const shipped = ref.firstElementChild.outerHTML
    const { container } = render(<Sheet open onClose={vi.fn()} ariaLabel="x"><p>body</p></Sheet>)
    expect(headerOf(container).firstElementChild.outerHTML).toBe(shipped)
  })

  it('present on a title-less sheet: fills the left slot, before the Close control', () => {
    const { container } = render(
      <Sheet open onClose={vi.fn()} ariaLabel="x" headerStart={<a href="/admin/config">Edit tab bar</a>}><p>body</p></Sheet>
    )
    const header = headerOf(container)
    expect(header.firstElementChild.textContent).toBe('Edit tab bar')
    expect(header.lastElementChild.getAttribute('data-sheet-close')).toBe('true')
  })

  // KILLING MUTATION: let headerStart win over a title. RESULT: RED — the title would vanish.
  it('a title still owns the slot', () => {
    const { container } = render(
      <Sheet open onClose={vi.fn()} title="Details" headerStart={<span>ignored</span>}><p>body</p></Sheet>
    )
    expect(headerOf(container).firstElementChild.textContent).toBe('Details')
    expect(container.textContent).not.toContain('ignored')
  })
})
