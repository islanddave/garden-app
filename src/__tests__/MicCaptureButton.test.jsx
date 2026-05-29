import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import MicCaptureButton from '../components/MicCaptureButton.jsx'

describe('MicCaptureButton (Inc 2 Bite 3)', () => {
  it('renders with required aria-label and the always-visible "Tap to capture" label', () => {
    render(<MicCaptureButton onCapture={() => {}} queuedCount={0} />)
    const btn = screen.getByTestId('mic-capture-button')
    expect(btn.getAttribute('aria-label')).toBe('Capture a voice note')
    expect(screen.getByText('Tap to capture')).toBeDefined()
  })

  it('hides the queued-count badge when queue is empty (color-independent: numeric + word "queued")', () => {
    render(<MicCaptureButton onCapture={() => {}} queuedCount={0} />)
    expect(screen.queryByTestId('mic-queued-count')).toBeNull()
    expect(screen.queryByText(/queued/i)).toBeNull()
  })

  it('shows the queued-count badge AND the "{n} captures queued" text when count > 0', () => {
    render(<MicCaptureButton onCapture={() => {}} queuedCount={3} />)
    const badge = screen.getByTestId('mic-queued-count')
    expect(badge.textContent).toContain('3')
    expect(badge.getAttribute('aria-label')).toBe('3 captures queued')
    expect(screen.getByText('3 captures queued')).toBeDefined()
  })

  it('singularizes label and aria when queuedCount === 1', () => {
    render(<MicCaptureButton onCapture={() => {}} queuedCount={1} />)
    expect(screen.getByTestId('mic-queued-count').getAttribute('aria-label')).toBe('1 capture queued')
    expect(screen.getByText('1 capture queued')).toBeDefined()
  })

  it('fires onCapture when tapped (stub for Bite 4 audio capture)', () => {
    const onCapture = vi.fn()
    render(<MicCaptureButton onCapture={onCapture} queuedCount={0} />)
    fireEvent.click(screen.getByTestId('mic-capture-button'))
    expect(onCapture).toHaveBeenCalledTimes(1)
  })

  it('does NOT fire onCapture when disabled', () => {
    const onCapture = vi.fn()
    render(<MicCaptureButton onCapture={onCapture} queuedCount={0} disabled />)
    fireEvent.click(screen.getByTestId('mic-capture-button'))
    expect(onCapture).not.toHaveBeenCalled()
    expect(screen.getByTestId('mic-capture-button').disabled).toBe(true)
  })

  it('tap target is at least 96px (glove-and-glare ≥ 2cm floor; spec allows 76px+, we ship 128px)', () => {
    render(<MicCaptureButton onCapture={() => {}} queuedCount={0} />)
    const btn = screen.getByTestId('mic-capture-button')
    expect(btn.style.width).toBe('128px')
    expect(btn.style.height).toBe('128px')
  })
})
