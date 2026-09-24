// BUG-UNDOTOASTTAPTARGET-001 — the shared undo toast's two controls are 48px tap targets, and the
// toast did not grow to make them so.
//
// Every undo toast in the app renders ToastContext's UndoToast (callers: CareNeeded x4 incl. Skip,
// Dashboard, InactiveProjects, EventNew), so the pin lives on the component, through the real
// provider — not on one screen.
//
// WHAT THIS CAN AND CANNOT PROVE. jsdom has no layout engine: nothing here measures 48 CSS px, and it
// cannot see a toast grow. scripts/layout-gate/undo-toast-target.mjs does both in real Chrome at
// Dave's 426x836 (tests/harness/undotap.*). What this pins is the DECLARATION those numbers come
// from: each control's box carries the 48px minimum; the negative margin that stops the toast growing
// is exactly the toast's own padding; the painted pill is NOT the box (so the bulky fix — a visible
// 48px button — fails here); and x's extra width comes from the toast's edge padding, never from the
// gap it shares with Undo.
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ToastProvider, useToast } from '../context/ToastContext.jsx'
import { T } from '../components/forms/formStyles.js'

function Harness({ apiRef }) {
  apiRef.current = useToast()
  return null
}
const mount = () => {
  const apiRef = React.createRef()
  render(<ToastProvider><Harness apiRef={apiRef} /></ToastProvider>)
  return apiRef
}
// The three shapes the callers produce: plain (Dashboard, InactiveProjects, a first Today tap),
// EventNew's with a detail line, and a coalesced low-priority group (a run of Today Skips).
// duration 0 = no timer, so nothing dismisses a toast mid-assertion.
const SHAPES = {
  plain: { raise: api => api.showUndo({ message: 'Logged event for Peppers 2026', onUndo: () => {}, duration: 0 }), reads: 'Logged event for Peppers 2026' },
  detail: { raise: api => api.showUndo({ message: 'Logged event — Cayenne #1', detail: 'Deep — soaked to runoff', onUndo: () => {}, duration: 0 }), reads: 'Deep — soaked to runoff' },
  coalesced: {
    raise: api => {
      for (const name of ['Habanero', 'Sungold Tomato']) api.showUndo({
        message: 'Skipped ' + name + ' for today', group: 'care-skip', groupMessage: n => 'Skipped ' + n + ' plants for today',
        priority: 'low', onUndo: () => {}, duration: 0,
      })
    },
    reads: 'Skipped 2 plants for today',
  },
}
const parts = () => {
  const undo = screen.getByRole('button', { name: 'Undo' })
  const close = screen.getByRole('button', { name: 'Dismiss' })
  return { undo, close, toast: undo.closest('[role="status"]') }
}

describe('BUG-UNDOTOASTTAPTARGET-001 — undo toast tap targets', () => {
  // INSTRUMENT CHECK first. The assertions below spell '48px' as a literal on purpose: an expectation
  // derived from the token would agree with it at any value, including a lowered one.
  it('the tap-target token is 48', () => {
    expect(T.buttonMinHeight).toBe(48)
  })

  for (const [shape, { raise, reads }] of Object.entries(SHAPES)) {
    describe(shape + ' toast', () => {
      const show = () => {
        const api = mount()
        act(() => { raise(api.current) })
        // The shape is real only if the toast actually says what that caller says.
        expect(screen.getByText(reads)).toBeTruthy()
        return parts()
      }

      it('Undo is a box at least 48x48, named exactly "Undo"', () => {
        const { undo } = show()
        expect(undo.style.minHeight).toBe('48px')
        expect(undo.style.minWidth).toBe('48px')
      })

      // The toast must not grow: the box's extra height is handed back by a negative margin equal to
      // the toast's own vertical padding. Mutation: margin 0 -> every toast 20px taller in Chrome.
      it('Undo hands back exactly the toast padding, top and bottom', () => {
        const { undo, toast } = show()
        expect(toast.style.paddingTop).toBe('10px')
        expect(undo.style.marginTop).toBe('-' + toast.style.paddingTop)
        expect(undo.style.marginBottom).toBe('-' + toast.style.paddingBottom)
      })

      // The pill the eye sees is a CHILD of the target. A border on the button itself means the
      // painted button is the target again — 28px tall, or 48px and bulky. (jsdom drops `border: none`
      // entirely, so "no border" reads as no solid style and no width, not as the string 'none'.)
      it('the painted pill is inside the target, not the target', () => {
        const { undo } = show()
        expect(undo.style.borderStyle).not.toBe('solid')
        expect(parseFloat(undo.style.borderWidth || '0')).toBe(0)
        expect(undo.style.backgroundColor).toBe('transparent')
        const pill = undo.firstElementChild
        expect(pill && pill.textContent).toBe('Undo')
        expect(pill.style.borderStyle).toBe('solid')
        expect(pill.style.borderWidth).toBe('1px')
      })

      // x: 48 tall the same way, and its extra width comes from the toast's RIGHT padding. Its left
      // margin stays 0 on purpose: the gap to Undo is dead space, so a thumb that misses Undo lands
      // on nothing instead of on the control that throws the undo away.
      it('x is 48 tall, reaches the toast edge, and does not spend the gap to Undo', () => {
        const { close, toast } = show()
        expect(close.style.minHeight).toBe('48px')
        expect(close.style.marginTop).toBe('-' + toast.style.paddingTop)
        expect(close.style.marginBottom).toBe('-' + toast.style.paddingBottom)
        expect(toast.style.paddingRight).toBe('14px')
        expect(close.style.marginRight).toBe('-' + toast.style.paddingRight)
        expect(close.style.marginLeft).toBe('0px')
      })
    })
  }

  it('Undo is still a real button: Tab reaches Undo then x, and Enter undoes', async () => {
    const api = mount()
    const onUndo = vi.fn()
    act(() => { api.current.showUndo({ message: 'Logged Water for Habanero', onUndo, duration: 0 }) })
    const { undo, close } = parts()
    expect(undo.tagName).toBe('BUTTON')
    await userEvent.tab()
    expect(document.activeElement).toBe(undo)
    await userEvent.tab()
    expect(document.activeElement).toBe(close)
    await userEvent.tab({ shift: true })
    await userEvent.keyboard('{Enter}')
    expect(onUndo).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Logged Water for Habanero')).toBeNull()
  })
})
