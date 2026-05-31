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

// Bite 7: controllable Web Speech mock — fires alongside the recorder.
let mockTranscriptionSupported = () => true
const liveCb = { last: null }
const mockStartLive = vi.fn((opts) => { liveCb.last = opts; return { stop: vi.fn(), cancel: vi.fn() } })
vi.mock('../lib/transcribe.js', () => ({
  isTranscriptionSupported: () => mockTranscriptionSupported(),
  startLiveTranscription:   (opts) => mockStartLive(opts),
  START_TIMEOUT_MS: 3500,
  NO_SPEECH_TIMEOUT_MS: 8000,
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
    mockTranscriptionSupported = () => false   // Bite 4 behavior: no live transcription
    mockStartLive.mockClear()
    liveCb.last = null
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

describe('MicCaptureButton (Inc 2 Bite 7 — one-pass capture)', () => {
  beforeEach(() => {
    mockSupportedImpl = () => true
    mockStartImpl = () => Promise.resolve(makeHandle())
    mockTranscriptionSupported = () => true
    mockStartLive.mockClear()
    liveCb.last = null
  })

  it('tap fires live transcription ALONGSIDE recording (same gesture frame)', async () => {
    render(<MicCaptureButton onRecorded={() => {}} queuedCount={0} />)
    fireEvent.click(screen.getByTestId('mic-capture-button'))
    // startLiveTranscription must be called synchronously in the click frame,
    // before any awaited boundary.
    expect(mockStartLive).toHaveBeenCalledTimes(1)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByTestId('mic-capture-button').getAttribute('data-state')).toBe('recording')
  })

  it('accumulated transcript is passed through onRecorded on stop', async () => {
    const onRecorded = vi.fn()
    render(<MicCaptureButton onRecorded={onRecorded} queuedCount={0} />)
    fireEvent.click(screen.getByTestId('mic-capture-button'))
    await act(async () => { await Promise.resolve() })
    // Simulate Web Speech delivering two final chunks during recording.
    act(() => {
      liveCb.last.onResult({ transcript: 'tomatoes are', isFinal: true })
      liveCb.last.onResult({ transcript: 'flowering', isFinal: true })
    })
    fireEvent.click(screen.getByTestId('mic-capture-button'))
    await act(async () => {
      liveCb.last.onEnd({ finalTranscript: '' })   // recognizer flushes on stop
      await Promise.resolve(); await Promise.resolve()
    })
    expect(onRecorded).toHaveBeenCalledTimes(1)
    const arg = onRecorded.mock.calls[0][0]
    expect(arg.transcript).toBe('tomatoes are flowering')
    expect(arg.transcriptSource).toBe('web-speech')
    expect(arg.blob).toBeTruthy()
  })

  it('interim (non-final) results are ignored in the accumulator', async () => {
    const onRecorded = vi.fn()
    render(<MicCaptureButton onRecorded={onRecorded} queuedCount={0} />)
    fireEvent.click(screen.getByTestId('mic-capture-button'))
    await act(async () => { await Promise.resolve() })
    act(() => {
      liveCb.last.onResult({ transcript: 'partial guess', isFinal: false })
      liveCb.last.onResult({ transcript: 'aphids', isFinal: true })
    })
    fireEvent.click(screen.getByTestId('mic-capture-button'))
    await act(async () => {
      liveCb.last.onEnd({ finalTranscript: '' })
      await Promise.resolve(); await Promise.resolve()
    })
    expect(onRecorded.mock.calls[0][0].transcript).toBe('aphids')
  })

  it('transcript delivered ONLY via onEnd (post-stop flush) is still captured — race fix', async () => {
    const onRecorded = vi.fn()
    render(<MicCaptureButton onRecorded={onRecorded} queuedCount={0} />)
    fireEvent.click(screen.getByTestId('mic-capture-button'))
    await act(async () => { await Promise.resolve() })
    // No interim/final during recording — recognizer holds everything until stop.
    fireEvent.click(screen.getByTestId('mic-capture-button'))
    // Recorder resolves first (blob ready) but emit must WAIT for onEnd.
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(onRecorded).not.toHaveBeenCalled()
    await act(async () => {
      liveCb.last.onEnd({ finalTranscript: 'leeks looking leggy' })
      await Promise.resolve()
    })
    expect(onRecorded).toHaveBeenCalledTimes(1)
    expect(onRecorded.mock.calls[0][0].transcript).toBe('leeks looking leggy')
    expect(onRecorded.mock.calls[0][0].transcriptSource).toBe('web-speech')
  })

  it('Web Speech unsupported: recording still works, transcript empty, source null', async () => {
    mockTranscriptionSupported = () => false
    const onRecorded = vi.fn()
    render(<MicCaptureButton onRecorded={onRecorded} queuedCount={0} />)
    fireEvent.click(screen.getByTestId('mic-capture-button'))
    await act(async () => { await Promise.resolve() })
    expect(mockStartLive).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('mic-capture-button'))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(onRecorded).toHaveBeenCalledTimes(1)
    expect(onRecorded.mock.calls[0][0].transcript).toBe('')
    expect(onRecorded.mock.calls[0][0].transcriptSource).toBe(null)
  })

  it('Web Speech error mid-recording does NOT block the recording / onRecorded', async () => {
    const onRecorded = vi.fn()
    render(<MicCaptureButton onRecorded={onRecorded} queuedCount={0} />)
    fireEvent.click(screen.getByTestId('mic-capture-button'))
    await act(async () => { await Promise.resolve() })
    act(() => { liveCb.last.onError('silent-failure') })
    fireEvent.click(screen.getByTestId('mic-capture-button'))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(onRecorded).toHaveBeenCalledTimes(1)
    expect(onRecorded.mock.calls[0][0].transcript).toBe('')
    expect(onRecorded.mock.calls[0][0].blob).toBeTruthy()
  })

  it('recording start failure cancels the live recognizer (cancel called)', async () => {
    mockStartImpl = () => Promise.reject('denied')
    const cancel = vi.fn()
    mockStartLive.mockImplementationOnce((opts) => { liveCb.last = opts; return { stop: vi.fn(), cancel } })
    render(<MicCaptureButton onRecorded={() => {}} onError={() => {}} queuedCount={0} />)
    fireEvent.click(screen.getByTestId('mic-capture-button'))
    await act(async () => { await Promise.resolve() })
    expect(cancel).toHaveBeenCalledTimes(1)
  })
})
