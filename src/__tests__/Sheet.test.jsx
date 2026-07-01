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

  it('open: role=dialog, aria-modal, accessible name from title', () => {
    render(<Sheet open title="Favorites" onClose={() => {}}><button>a</button></Sheet>)
    const dlg = screen.getByRole('dialog')
    expect(dlg.getAttribute('aria-modal')).toBe('true')
    expect(dlg.getAttribute('aria-label')).toBe('Favorites')
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
})
