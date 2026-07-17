// V4-THEME-001 — Sheet (bottom-sheet fly-up) guard (dark primitive).
// No jest-dom (L-182): assert via roles + attributes + toBeTruthy.
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import Sheet from '../components/forms/Sheet.jsx'

describe('Sheet (V4-THEME-001)', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<Sheet open={false} onClose={() => {}}>x</Sheet>)
    expect(container.firstChild).toBe(null)
    expect(screen.queryByRole('dialog')).toBe(null)
  })

  it('open: role=dialog, aria-modal, and a COMPUTED accessible name (L-275: a11y tree, not raw attr)', () => {
    render(<Sheet open title="Favorites" onClose={() => {}}><button>a</button></Sheet>)
    // MUTANT-GUARD (accessible name): getByRole {name} computes the accessible name via
    // dom-accessibility-api and THROWS if the dialog has no computed name (role stripped, or the
    // label lands on a non-naming element). The prior getAttribute('aria-label')==='Favorites'
    // only proved the raw string attribute existed — the exact L-275 antipattern that let the
    // sow-forms a11y-blackout ship green. This asserts the a11y tree, not the attribute.
    const dlg = screen.getByRole('dialog', { name: 'Favorites' })
    expect(dlg).toBeTruthy()
    expect(dlg.getAttribute('aria-modal')).toBe('true')
  })

  it('accessible name falls back to ariaLabel prop when no title (title || ariaLabel branch)', () => {
    // MUTANT-GUARD: collapsing `aria-label={title || ariaLabel}` to just `title` nulls the name on
    // every ariaLabel-only consumer. Computed-name assertion, no jest-dom (L-182).
    render(<Sheet open ariaLabel="Quick log" onClose={() => {}}><button>a</button></Sheet>)
    expect(screen.getByRole('dialog', { name: 'Quick log' })).toBeTruthy()
  })

  it('MUTANT-GUARD (focus restore): closing restores focus to the element focused before open', () => {
    // qa-architect mutant: deleting the restore-focus cleanup (Sheet.jsx return-block) survived all
    // prior tests. This kills it: an external control holds focus, the open effect must capture it,
    // and close must return focus there (WCAG SC 2.4.3 — focus must not fall to <body>).
    const opener = document.createElement('button')
    opener.textContent = 'opener'
    document.body.appendChild(opener)
    opener.focus()
    expect(document.activeElement).toBe(opener)
    const { rerender } = render(
      <Sheet open title="T" onClose={() => {}}><button>inside</button></Sheet>
    )
    // focus moved off the opener, into the panel
    expect(document.activeElement).not.toBe(opener)
    // close → focus must return to the opener
    rerender(<Sheet open={false} title="T" onClose={() => {}}><button>inside</button></Sheet>)
    expect(document.activeElement).toBe(opener)
    document.body.removeChild(opener)
  })

  it('MUTANT-GUARD (tab trap): Tab at the last focusable wraps to the first; Shift+Tab at the first wraps to the last', () => {
    // qa-architect mutant: deleting the ENTIRE Tab-trap block survived all prior tests. This asserts
    // both wrap directions so removing (or half-removing) the trap fails (WCAG SC 2.1.2 — no focus
    // escape from a modal).
    render(
      <Sheet open title="T" onClose={() => {}}>
        <button>first</button>
        <button>last</button>
      </Sheet>
    )
    const first = screen.getByRole('button', { name: 'first' })
    const last = screen.getByRole('button', { name: 'last' })
    // forward wrap: focus last, Tab → first
    last.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
    // backward wrap: focus first, Shift+Tab → last
    first.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
  })

  it('Escape and backdrop click both call onClose', () => {
    const onClose = vi.fn()
    render(<Sheet open title="T" onClose={onClose}><button>a</button></Sheet>)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    // backdrop is the first fixed overlay sibling before the dialog
    const dlg = screen.getByRole('dialog')
    const backdrop = dlg.previousSibling
    fireEvent.click(backdrop)
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('BUG-SHEET-001: backdrop and panel sit above the bottom nav (zIndex > 100) so the sheet is modal over the nav', () => {
    render(<Sheet open title="T" onClose={() => {}}><button>a</button></Sheet>)
    const dlg = screen.getByRole('dialog')
    const backdrop = dlg.previousSibling
    expect(Number(dlg.style.zIndex)).toBeGreaterThan(100)
    expect(Number(backdrop.style.zIndex)).toBeGreaterThan(100)
    // panel must paint above its own backdrop
    expect(Number(dlg.style.zIndex)).toBeGreaterThan(Number(backdrop.style.zIndex))
  })

  it('BUG-SOWFOCUS-001: a parent re-render with a fresh inline onClose does NOT steal focus back to the first field', () => {
    const { rerender } = render(
      <Sheet open title="Sow" onClose={() => {}}>
        <input aria-label="name" />
        <input aria-label="qty" />
      </Sheet>
    )
    // Effect focuses the first field on open; user then moves to the qty field.
    const qty = screen.getByLabelText('qty')
    qty.focus()
    expect(document.activeElement).toBe(qty)
    // Simulate a keystroke-driven parent re-render: identical children, but a NEW inline onClose
    // closure (the exact pattern SowNow uses). Pre-fix this re-ran the focus effect and yanked
    // focus to the first field; post-fix (deps=[open]) focus must stay put.
    rerender(
      <Sheet open title="Sow" onClose={() => {}}>
        <input aria-label="name" />
        <input aria-label="qty" />
      </Sheet>
    )
    expect(document.activeElement).toBe(qty)
  })

  it('Escape calls the LATEST onClose after a re-render (ref stays current)', () => {
    const first = vi.fn(); const second = vi.fn()
    const { rerender } = render(<Sheet open title="T" onClose={first}><button>a</button></Sheet>)
    rerender(<Sheet open title="T" onClose={second}><button>a</button></Sheet>)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})
