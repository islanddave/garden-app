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
    // The §5.3 Close control is now the first node in the DOM focus ring; compute boundaries from
    // the actual ring rather than assuming the children are the boundaries.
    const dlg = screen.getByRole('dialog')
    const ring = [...dlg.querySelectorAll('button')] // [Close, first, last] in DOM order
    const ringFirst = ring[0]
    const ringLast = ring[ring.length - 1]
    expect(ringLast).toBe(screen.getByRole('button', { name: 'last' }))
    // forward wrap: focus the last, Tab wraps to the first (the Close control)
    ringLast.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(ringFirst)
    // backward wrap: focus the first, Shift+Tab wraps to the last
    ringFirst.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(ringLast)
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

  // ── V4-OVERLAY-001 Slice 1 §5 guards ─────────────────────────────────────────────
  it('§5.3 MUTANT-GUARD (close control): a labelled Close button is present and calls onClose', () => {
    const onClose = vi.fn()
    render(<Sheet open title="T" onClose={onClose}><button>a</button></Sheet>)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('§5.1 size: peek uses 85vh; full uses a near-fullscreen dvh height', () => {
    const { rerender } = render(<Sheet open title="T" onClose={() => {}}><button>a</button></Sheet>)
    expect(screen.getByRole('dialog').style.maxHeight).toBe('85vh')
    rerender(<Sheet open size="full" title="T" onClose={() => {}}><button>a</button></Sheet>)
    expect(screen.getByRole('dialog').style.maxHeight).toContain('dvh')
  })

  // BUG-SHEETOVERSHOOT-001. WHAT THIS DOES NOT PROVE: jsdom has no layout engine — every
  // getBoundingClientRect returns zero and nothing rasterises — so the 12px overshoot this fixes is
  // unfalsifiable here, and so is the claim that peek is unaffected. Both were MEASURED in real
  // headless Chrome (tests/harness/sheetcensus.jsx at 390x500: full went from top y=-12 h=512 to
  // y=+8 h=492; all three peek consumers byte-identical). What IS falsifiable here is the DECISION,
  // which is the part a later edit would silently undo: on `full` the cap governs the PAINTED box,
  // the padding stays on the panel so border-box has something to absorb, and `peek` is left alone.
  it('BUG-SHEETOVERSHOOT-001 MUTANT-GUARD (sizing model): full caps the painted box, peek is untouched', () => {
    const { rerender } = render(<Sheet open size="full" title="T" onClose={() => {}}><button>a</button></Sheet>)
    const full = screen.getByRole('dialog')
    expect(full.style.boxSizing).toBe('border-box')
    // The cap and the padding must sit on the SAME element or border-box absorbs nothing. Moving the
    // padding to an inner wrapper is a valid alternative fix but a DIFFERENT one; it would leave
    // this panel padding-less and this assertion is what makes that swap visible rather than silent.
    expect(full.style.paddingTop).toBe('8px')
    expect(full.style.paddingBottom).toContain('safe-area-inset-bottom')
    // peek is 17 of the 24 surfaces these 21 render sites produce, and CANNOT overshoot (its cap is
    // 85vh, so the panel top is 15vh-20px — positive on any real viewport). Converting it would cost
    // each of them 20px of visible content for no defect: PhotoDeleteConfirm at 390x500 measures
    // 417px of content against a 425px cap and would flip from fits-whole to scrolls. That is why
    // this fix is branch-scoped.
    rerender(<Sheet open title="T" onClose={() => {}}><button>a</button></Sheet>)
    expect(screen.getByRole('dialog').style.boxSizing).toBe('content-box')
  })

  it('§5.4 MUTANT-GUARD (scroll lock): body scroll locks on open and the prior value is restored on close', () => {
    // qa mutant class: dropping the body scroll-lock (or its restore). Asserts both edges.
    expect(document.body.style.overflow).toBe('')
    const { rerender } = render(<Sheet open title="T" onClose={() => {}}><button>a</button></Sheet>)
    expect(document.body.style.overflow).toBe('hidden')
    expect(document.body.style.overscrollBehavior).toBe('contain')
    rerender(<Sheet open={false} title="T" onClose={() => {}}><button>a</button></Sheet>)
    expect(document.body.style.overflow).toBe('') // restored to the prior value
  })

  it('§5.4 MUTANT-GUARD (no brick): unmounting WHILE open releases the scroll lock', () => {
    // A stacked/cross-close path that unmounts an open sheet must not strand body.overflow:hidden
    // (that bricks the whole app). Asserts release on unmount-while-open.
    expect(document.body.style.overflow).toBe('')
    const { unmount } = render(<Sheet open title="T" onClose={() => {}}><button>a</button></Sheet>)
    expect(document.body.style.overflow).toBe('hidden')
    unmount()
    expect(document.body.style.overflow).toBe('')
  })

  it('§5.5 MUTANT-GUARD (escape arbitration): with two sheets stacked, one Escape closes ONLY the topmost', () => {
    // qa mutant: no depth check -> one Escape fires BOTH onCloses (keyboard-only double-close, SC 2.1.1).
    const outer = vi.fn(); const inner = vi.fn()
    render(
      <>
        <Sheet open title="outer" onClose={outer}><button>o</button></Sheet>
        <Sheet open title="inner" onClose={inner}><button>i</button></Sheet>
      </>
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(inner).toHaveBeenCalledTimes(1)
    expect(outer).not.toHaveBeenCalled()
  })

  it('§5.2 MUTANT-GUARD (dirty backdrop): when dirty a backdrop tap no-ops but Escape still closes', () => {
    // A stray backdrop tap must not discard a dirty form; the deliberate Escape/Close paths stay live.
    const onClose = vi.fn()
    render(<Sheet open dirty title="T" onClose={onClose}><button>a</button></Sheet>)
    const backdrop = screen.getByRole('dialog').previousSibling
    fireEvent.click(backdrop)
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
