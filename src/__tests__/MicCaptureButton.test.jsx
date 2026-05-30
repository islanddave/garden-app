import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

// Mock audioCapture before importing MicCaptureButton
let mockStartImpl = null
let mockSupportedImpl = () => true
vi.mock('../lib/audioCapture.js', () => ({
  isAudioCaptureSupported: () => mockSupportedImpl(),
  startRecording: () => mockStartImpl(),
}))

import MicCaptureButton from '../components/MicCaptureButton.jsx'

function makeHandle({ stopResult = { blob: new Blob(['x']), mime: 'audio/webm', durationMs: 1234 }, stopFails = false } = {}) {
  return {
    mime: 'audio/webm',
    stop: () => stopFails ? Promise.reject('failed') : Promise.resolve(stopResult),
    cancel: vi.fn(),
  }
}

describe('MicCaptureButton (Inc 2 Bite 4 — real recorder)', () => {
  beforeEach(() => {
    mockSupportedImpl = () => true
    mockStartImpl = () => Promise.resolve(makeHandle())
  })

  it('idle state: aria-label = "Start voice capture"', () => {
    render(<MicCaptureButton onRecorded={() => {}} queuedCount={0} />)
    const btn = screen.getByTestId('mic-capture-button')
    expect(btn.getAttribute('aria-label')).toBe('Start voice capture')
    expect(btn.getAttribute('data-state')).toBe('idle')
    expect(screen.getByText('Tap to capture')).toBeDefined()
  })

  it('unsupported state: when isAudioCaptureSupported=false, button disabled + label "Mic unavailable"', async () => {
    mockSupportedImpl = () => false
    render(<MicCaptureButton onRecorded={() => {}} queuedCount={0} />)
    // useEffect fires after render — wait a microtask
    await act(async () => { await Promise.resolve() })
    const btn = screen.getByTestId('mic-capture-button')
    expect(btn.disabled).toBe(true)
    expect(btn.getAttribute('data-state')).toBe('unsupported')
    expect(screen.getByText('Mic unavailable')).toBeDefined()
  })

  it('tap → recording state (aria changes to "Stop voice capture")', async () => {
    render(<MicCaptureButton onRecorded={() => {}} queuedCount={0} />)
    fireEvent.click(screen.getByTestId('mic-capture-button'))
    await act(async () => { await Promise.resolve() })
    const btn = screen.getByTestId('mic-capture-button')
    expect(btn.getAttribute('data-state')).toBe('recording')
    expect(btn.getAttribute('aria-label')).toBe('Stop voice capture')
    expect(screen.getByText(/Recording.*Tap to stop/)).toBeDefined()
    expect(screen.getByTestId('mic-capture-elapsed')).toBeDefined()
  })

  it('tap-record then tap-stop → onRecorded fires with {blob, mime, durationMs}', async () => {
    const onRecorded = vi.fn()
    render(<MicCaptureButton onRecorded={onRecorded} queuedCount={0} />)
    fireEvent.click(screen.getByTestId('mic-capture-button'))
    await act(async () => { await Promise.resolve() })
    fireEvent.click(screen.getByTestId('mic-capture-button'))
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })
    expect(onRecorded).toHaveBeenCalledTimes(1)
    const arg = onRecorded.mock.calls[0][0]
    expect(arg.mime).toBe('audio/webm')
    expect(arg.durationMs).toBe(1234)
    expect(arg.blob).toBeTruthy()
  })

  it('permission denied → state=denied + onError("denied") + helpful hint', async () => {
    mockStartImpl = () => Promise.reject('denied')
    const onError = vi.fn()
    render(<MicCaptureButton onRecorded={() => {}} onError={onError} queuedCount={0} />)
    fireEvent.click(screen.getByTestId('mic-capture-button'))
    await act(async () => { await Promise.resolve() })
    const btn = screen.getByTestId('mic-capture-button')
    expect(btn.getAttribute('data-state')).toBe('denied')
    expect(onError).toHaveBeenCalledWith('denied')
    expect(screen.getByText('Mic permission denied')).toBeDefined()
    expect(screen.getByTestId('mic-capture-error-hint')).toBeDefined()
  })

  it('no microphone → state=no-device + onError("no-device")', async () => {
    mockStartImpl = () => Promise.reject('no-device')
    const onError = vi.fn()
    render(<MicCaptureButton onRecorded={() => {}} onError={onError} queuedCount={0} />)
    fireEvent.click(screen.getByTestId('mic-capture-button'))
    await act(async () => { await Promise.resolve() })
    expect(screen.getByTestId('mic-capture-button').getAttribute('data-state')).toBe('no-device')
    expect(onError).toHaveBeenCalledWith('no-device')
    expect(screen.getByText('No microphone found')).toBeDefined()
  })

  it('generic failure → state=failed + onError("failed")', async () => {
    mockStartImpl = () => Promise.reject('something-else')
    const onError = vi.fn()
    render(<MicCaptureButton onRecorded={() => {}} onError={onError} queuedCount={0} />)
    fireEvent.click(screen.getByTestId('mic-capture-button'))
    await act(async () => { await Promise.resolve() })
    expect(screen.getByTestId('mic-capture-button').getAttribute('data-state')).toBe('failed')
    expect(onError).toHaveBeenCalledWith('something-else')
  })

  it('queued-count badge + summary: shows numeric badge + "{n} captures queued, oldest {age}"', () => {
    render(<MicCaptureButton onRecorded={() => {}} queuedCount={3} oldestAgeMs={5 * 60 * 1000} />)
    expect(screen.getByTestId('mic-queued-count').textContent).toContain('3')
    expect(screen.getByTestId('mic-queued-summary').textContent).toMatch(/3 captures queued.*oldest 5m/)
  })

  it('queued-count singular: 1 capture queued', () => {
    render(<MicCaptureButton onRecorded={() => {}} queuedCount={1} oldestAgeMs={20 * 1000} />)
    expect(screen.getByTestId('mic-queued-summary').textContent).toMatch(/1 capture queued.*oldest 20s/)
  })

  it('queued-count badge hidden when queue empty', () => {
    render(<MicCaptureButton onRecorded={() => {}} queuedCount={0} />)
    expect(screen.queryByTestId('mic-queued-count')).toBe(null)
    expect(screen.queryByTestId('mic-queued-summary')).toBe(null)
  })

  it('tap target floor: 128px (≥ 2cm glove-and-glare per V100 §7)', () => {
    render(<MicCaptureButton onRecorded={() => {}} queuedCount={0} />)
    const btn = screen.getByTestId('mic-capture-button')
    expect(btn.style.width).toBe('128px')
    expect(btn.style.height).toBe('128px')
  })

  it('disabled prop overrides idle state', () => {
    render(<MicCaptureButton onRecorded={() => {}} queuedCount={0} disabled />)
    expect(screen.getByTestId('mic-capture-button').disabled).toBe(true)
  })
})
