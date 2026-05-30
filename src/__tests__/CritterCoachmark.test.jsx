import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'
import CritterCoachmark from '../components/CritterCoachmark.jsx'
import { DEFAULT_COACHMARK_COPY, COACHMARK_MIN_VISIBLE_MS } from '../lib/critterCoachmarkCopy.js'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); cleanup() })

describe('CritterCoachmark', () => {
  it('renders nothing when not eligible', () => {
    const { container } = render(<CritterCoachmark eligible={false} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders the default copy when eligible', () => {
    render(<CritterCoachmark eligible={true} />)
    const el = screen.getByTestId('critter-coachmark')
    expect(el.textContent).toBe(DEFAULT_COACHMARK_COPY)
  })

  it('renders custom copy when passed', () => {
    render(<CritterCoachmark eligible={true} copy="Custom line" />)
    expect(screen.getByTestId('critter-coachmark').textContent).toBe('Custom line')
  })

  it('uses role=status + aria-live=polite (ambient, never interrupt)', () => {
    render(<CritterCoachmark eligible={true} />)
    const el = screen.getByTestId('critter-coachmark')
    expect(el.getAttribute('role')).toBe('status')
    expect(el.getAttribute('aria-live')).toBe('polite')
  })

  it('does NOT call onDismiss on unmount when visible-time < 1500ms', () => {
    const onDismiss = vi.fn()
    const { unmount } = render(<CritterCoachmark eligible={true} onDismiss={onDismiss} />)
    // Only 500ms passes before unmount
    act(() => { vi.advanceTimersByTime(500) })
    unmount()
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('CALLS onDismiss on unmount when visible-time >= 1500ms', () => {
    const onDismiss = vi.fn()
    const { unmount } = render(<CritterCoachmark eligible={true} onDismiss={onDismiss} />)
    act(() => { vi.advanceTimersByTime(COACHMARK_MIN_VISIBLE_MS) })
    unmount()
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('does NOT call onDismiss when eligible=false (effect early returns)', () => {
    const onDismiss = vi.fn()
    const { unmount } = render(<CritterCoachmark eligible={false} onDismiss={onDismiss} />)
    act(() => { vi.advanceTimersByTime(5000) })
    unmount()
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('respects minVisibleMs test seam', () => {
    const onDismiss = vi.fn()
    const { unmount } = render(<CritterCoachmark eligible={true} onDismiss={onDismiss} minVisibleMs={100} />)
    act(() => { vi.advanceTimersByTime(150) })
    unmount()
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('does NOT render any button (V100: never tap-to-claim, never interrupt)', () => {
    render(<CritterCoachmark eligible={true} />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})
