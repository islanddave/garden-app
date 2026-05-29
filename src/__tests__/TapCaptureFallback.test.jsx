import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import TapCaptureFallback from '../components/TapCaptureFallback.jsx'

describe('TapCaptureFallback (Inc 2 Bite 3)', () => {
  it('renders a labeled textarea and a disabled submit button when empty', () => {
    render(<TapCaptureFallback onSubmit={() => {}} />)
    expect(screen.getByText('Or type a note')).toBeDefined()
    expect(screen.getByTestId('tap-capture-textarea')).toBeDefined()
    expect(screen.getByTestId('tap-capture-submit').disabled).toBe(true)
  })

  it('enables the submit button once the user types non-whitespace', () => {
    render(<TapCaptureFallback onSubmit={() => {}} />)
    const textarea = screen.getByTestId('tap-capture-textarea')
    fireEvent.change(textarea, { target: { value: 'tomatoes leafy yellow' } })
    expect(screen.getByTestId('tap-capture-submit').disabled).toBe(false)
  })

  it('keeps the submit button disabled on whitespace-only input', () => {
    render(<TapCaptureFallback onSubmit={() => {}} />)
    const textarea = screen.getByTestId('tap-capture-textarea')
    fireEvent.change(textarea, { target: { value: '   \n  ' } })
    expect(screen.getByTestId('tap-capture-submit').disabled).toBe(true)
  })

  it('fires onSubmit with trimmed text and clears the textarea', () => {
    const onSubmit = vi.fn()
    render(<TapCaptureFallback onSubmit={onSubmit} />)
    const textarea = screen.getByTestId('tap-capture-textarea')
    fireEvent.change(textarea, { target: { value: '  basil moved indoors  ' } })
    fireEvent.click(screen.getByTestId('tap-capture-submit'))
    expect(onSubmit).toHaveBeenCalledWith('basil moved indoors')
    expect(textarea.value).toBe('')
  })

  it('shows a transient "Saved to queue." ACK after submit then auto-clears', () => {
    vi.useFakeTimers()
    render(<TapCaptureFallback onSubmit={() => {}} />)
    const textarea = screen.getByTestId('tap-capture-textarea')
    fireEvent.change(textarea, { target: { value: 'watered raised bed' } })
    fireEvent.click(screen.getByTestId('tap-capture-submit'))
    expect(screen.getByTestId('tap-capture-ack')).toBeDefined()
    act(() => { vi.advanceTimersByTime(1600) })
    expect(screen.queryByTestId('tap-capture-ack')).toBeNull()
    vi.useRealTimers()
  })

  it('does NOT fire onSubmit when the textarea is empty (form submit guard)', () => {
    const onSubmit = vi.fn()
    render(<TapCaptureFallback onSubmit={onSubmit} />)
    const form = screen.getByTestId('tap-capture-fallback')
    fireEvent.submit(form)
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
