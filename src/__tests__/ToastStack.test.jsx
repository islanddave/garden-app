// Regression pins for the global toast STACK POLICY (see src/context/ToastContext.jsx).
//
// Why this file exists: on 2026-09-10 Today's care list — where one tap per row is the primary
// interaction — buried the entire app under a column of overlapping undo toasts. Four faults
// compounded, and NOTHING in the suite pinned any of them, because every CareNeeded test mocks the
// toast api wholesale and so never exercises the provider. These tests drive the REAL provider.
import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { ToastProvider, useToast, MAX_VISIBLE_TOASTS } from '../context/ToastContext.jsx'

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

// Harness: exposes the api imperatively so a test can fire N calls in one act(), which is exactly
// the "tap down the list faster than the 5s window" shape that produced the pile-up.
function Harness({ apiRef }) {
  const api = useToast()
  apiRef.current = api
  return <div>app</div>
}
const mount = () => {
  const apiRef = React.createRef()
  render(<ToastProvider><Harness apiRef={apiRef} /></ToastProvider>)
  return apiRef
}
// Undo toasts are the interactive kind; count them by their Undo control.
const undoToasts = () => screen.queryAllByRole('button', { name: 'Undo' })

describe('toast stack — group coalescing', () => {
  it('repeat taps of one group collapse into a SINGLE toast, not a stack', () => {
    const api = mount()
    act(() => {
      for (const name of ['Purple Basil', 'Holy Basil', 'Tulsi Basil', 'Lemon Verbena']) {
        api.current.showUndo({
          message: 'Logged Water for ' + name,
          group: 'care-log-watering',
          groupMessage: (n) => 'Logged Water for ' + n + ' plants',
          onUndo: () => {},
        })
      }
    })
    expect(undoToasts()).toHaveLength(1)
    expect(screen.getByText('Logged Water for 4 plants')).toBeDefined()
  })

  it('the first tap still reads as the single plant it was', () => {
    const api = mount()
    act(() => {
      api.current.showUndo({
        message: 'Logged Water for Purple Basil',
        group: 'care-log-watering',
        groupMessage: (n) => 'Logged Water for ' + n + ' plants',
        onUndo: () => {},
      })
    })
    expect(screen.getByText('Logged Water for Purple Basil')).toBeDefined()
  })

  it('Undo on a coalesced toast reverses EVERY tap in the group', () => {
    const api = mount()
    const undos = [vi.fn(), vi.fn(), vi.fn()]
    act(() => {
      for (const fn of undos) {
        api.current.showUndo({
          message: 'Logged Water for a plant',
          group: 'care-log-watering',
          groupMessage: (n) => 'Logged Water for ' + n + ' plants',
          onUndo: fn,
        })
      }
    })
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'Undo' })) })
    for (const fn of undos) expect(fn).toHaveBeenCalledTimes(1)
    expect(undoToasts()).toHaveLength(0)
  })

  it('different groups stay separate statements (a Water run never absorbs a Feed run)', () => {
    const api = mount()
    act(() => {
      api.current.showUndo({ message: 'Logged Water for Basil', group: 'care-log-watering', onUndo: () => {} })
      api.current.showUndo({ message: 'Logged Feed for Basil', group: 'care-log-fertilizing', onUndo: () => {} })
    })
    expect(undoToasts()).toHaveLength(2)
  })

  it('an ungrouped caller is unaffected — one call, one toast', () => {
    const api = mount()
    act(() => {
      api.current.showUndo({ message: 'Archived a project', onUndo: () => {} })
      api.current.showUndo({ message: 'Archived another', onUndo: () => {} })
    })
    expect(undoToasts()).toHaveLength(2)
  })
})

describe('toast stack — hard cap', () => {
  it('never exceeds MAX_VISIBLE_TOASTS however many distinct toasts arrive', () => {
    const api = mount()
    act(() => {
      for (let i = 0; i < 14; i++) {
        api.current.showUndo({ message: 'Logged ' + i, group: 'g' + i, onUndo: () => {} })
      }
    })
    expect(undoToasts()).toHaveLength(MAX_VISIBLE_TOASTS)
    // Oldest is dropped, so the NEWEST confirmation — the one the thumb just earned — survives.
    expect(screen.getByText('Logged 13')).toBeDefined()
    expect(screen.queryByText('Logged 0')).toBeNull()
  })
})

describe('toast stack — timers own their own lifetime', () => {
  it('a later toast does NOT restart an earlier toast’s dismiss timer', () => {
    vi.useFakeTimers()
    const api = mount()
    act(() => { api.current.showUndo({ message: 'first', duration: 5000, onUndo: () => {} }) })
    // 4s in, push an unrelated toast. This used to re-render the provider with a fresh onDismiss
    // closure, which was an effect dep — restarting 'first' back to a full 5s. Repeated per tap,
    // that is why the stack never drained.
    act(() => { vi.advanceTimersByTime(4000) })
    act(() => { api.current.showUndo({ message: 'second', duration: 5000, onUndo: () => {} }) })
    act(() => { vi.advanceTimersByTime(1100) })
    expect(screen.queryByText('first')).toBeNull()
    expect(screen.getByText('second')).toBeDefined()
  })

  it('merging into a group RESTARTS that group’s window (it belongs to the last tap)', () => {
    vi.useFakeTimers()
    const api = mount()
    const push = () => api.current.showUndo({
      message: 'Logged Water', group: 'care-log-watering',
      groupMessage: (n) => 'Logged Water for ' + n + ' plants', duration: 5000, onUndo: () => {},
    })
    act(() => { push() })
    act(() => { vi.advanceTimersByTime(4000) })
    act(() => { push() })
    act(() => { vi.advanceTimersByTime(4000) })   // 8s since the first tap, 4s since the second
    expect(screen.getByText('Logged Water for 2 plants')).toBeDefined()
    act(() => { vi.advanceTimersByTime(1100) })
    expect(undoToasts()).toHaveLength(0)
  })

  it('a plain (non-undo) toast auto-resolves and is likewise not restarted by a newcomer', () => {
    vi.useFakeTimers()
    const api = mount()
    act(() => { api.current.show({ message: 'Saved', duration: 2500 }) })
    act(() => { vi.advanceTimersByTime(2000) })
    act(() => { api.current.show({ message: 'Saved again', duration: 2500 }) })
    act(() => { vi.advanceTimersByTime(600) })
    expect(screen.queryByText('Saved')).toBeNull()
    expect(screen.getByText('Saved again')).toBeDefined()
  })
})

describe('toast stack — layout is container-owned, not per-toast offset math', () => {
  it('all toasts share ONE fixed container and are flow children of it', () => {
    const api = mount()
    act(() => {
      api.current.showUndo({ message: 'Logged Water for Basil', onUndo: () => {} })
      api.current.show({ message: 'Saved' })
    })
    const undo = screen.getByText('Logged Water for Basil').closest('[role="status"]')
    const plain = screen.getByText('Saved')
    const container = undo.parentElement
    // Same parent = one stacking context; a flex column with a real gap is what replaced the
    // 56px-per-index stride that overlapped once a message wrapped to two lines.
    expect(plain.parentElement).toBe(container)
    expect(container.style.position).toBe('fixed')
    expect(container.style.display).toBe('flex')
    expect(container.style.flexDirection).toBe('column')
    // No toast may re-introduce its own fixed offset — that is the whole regression.
    expect(undo.style.position).not.toBe('fixed')
    expect(plain.style.position).not.toBe('fixed')
    expect(undo.style.bottom).toBe('')
    expect(plain.style.bottom).toBe('')
  })

  it('the container is pass-through but its controls stay tappable', () => {
    const api = mount()
    act(() => { api.current.showUndo({ message: 'Logged Water for Basil', onUndo: () => {} }) })
    const undo = screen.getByText('Logged Water for Basil').closest('[role="status"]')
    expect(undo.parentElement.style.pointerEvents).toBe('none')
    expect(undo.style.pointerEvents).toBe('auto')
  })

  it('renders no container at all when there is nothing to say', () => {
    mount()
    expect(screen.queryAllByRole('status')).toHaveLength(0)
  })
})
