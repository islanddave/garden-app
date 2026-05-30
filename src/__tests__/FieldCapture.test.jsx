import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ModeProvider } from '../context/ModeContext.jsx'
import { MODE } from '../lib/mode.js'

const mockEnqueueRecording = vi.fn(async (rec) => ({ id: 'audio-1', kind: 'audio', ...rec, capturedAt: new Date().toISOString(), status: 'recorded' }))
const mockEnqueueText = vi.fn(async (rec) => ({ id: `text-${Math.random().toString(36).slice(2,8)}`, kind: 'text', ...rec, capturedAt: new Date().toISOString(), status: 'queued' }))
const mockList = vi.fn()
const mockDepth = vi.fn(async () => 0)
const mockOldest = vi.fn(async () => null)
const mockPersist = vi.fn(async () => ({ supported: true, granted: true }))
const mockSetTranscript = vi.fn(async (args) => ({ id: args.id, transcript: args.transcript, status: 'transcribed' }))
const mockIncTranscribeAttempt = vi.fn(async () => ({}))
let mockOnReconnectCb = null

vi.mock('../lib/captureQueue.js', () => ({
  enqueueRecording:         (...args) => mockEnqueueRecording(...args),
  enqueueText:              (...args) => mockEnqueueText(...args),
  list:                     () => mockList(),
  getUnprocessedDepth:      () => mockDepth(),
  getOldestUnprocessedAgeMs:() => mockOldest(),
  setTranscript:            (...args) => mockSetTranscript(...args),
  incrementTranscribeAttempt:(...args) => mockIncTranscribeAttempt(...args),
  STATUS: { QUEUED: 'queued', RECORDED: 'recorded', TRANSCRIBED: 'transcribed', HANDED_OFF: 'handed_off' },
  KIND: { AUDIO: 'audio', TEXT: 'text' },
  TRANSCRIPT_SOURCE: { MANUAL: 'manual', WEB_SPEECH: 'web-speech' },
}))

vi.mock('../lib/durableStorage.js', () => ({
  requestPersistence: () => mockPersist(),
}))

vi.mock('../lib/reconnect.js', () => ({
  onReconnect: (cb) => { mockOnReconnectCb = cb; return () => { mockOnReconnectCb = null } },
}))

vi.mock('../lib/audioCapture.js', () => ({
  isAudioCaptureSupported: () => true,
  startRecording: () => Promise.resolve({
    mime: 'audio/webm',
    stop: () => Promise.resolve({ blob: new Blob(['x']), mime: 'audio/webm', durationMs: 1234 }),
    cancel: vi.fn(),
  }),
}))

// transcribe is unused in FieldCapture but pulled in via TranscriptReview.
vi.mock('../lib/transcribe.js', () => ({
  isTranscriptionSupported: () => false,
  startLiveTranscription:   () => ({ stop: () => {}, cancel: () => {} }),
  START_TIMEOUT_MS: 3500,
  NO_SPEECH_TIMEOUT_MS: 8000,
}))

// jsdom URL polyfill for TranscriptReview audio playback construction
if (!global.URL.createObjectURL) global.URL.createObjectURL = () => 'blob:fake'
if (!global.URL.revokeObjectURL) global.URL.revokeObjectURL = () => {}

import FieldCapture from '../pages/FieldCapture.jsx'

function renderAt(initialMode, opts = {}) {
  if (!('initialList' in opts) || opts.initialList !== undefined) {
    const list = opts.initialList === undefined ? [] : opts.initialList
    if (!opts.preservesMockList) mockList.mockImplementation(async () => list)
  }
  return render(
    <ModeProvider initialMode={initialMode}>
      <MemoryRouter initialEntries={['/field']}>
        <Routes>
          <Route path="/field"     element={<FieldCapture />} />
          <Route path="/dashboard" element={<div data-testid="dashboard-stub" />} />
        </Routes>
      </MemoryRouter>
    </ModeProvider>
  )
}

describe('FieldCapture (Inc 2 Bite 4 — durable queue wiring)', () => {
  beforeEach(() => {
    mockEnqueueRecording.mockClear()
    mockEnqueueText.mockClear()
    mockList.mockReset()
    mockDepth.mockReset().mockImplementation(async () => 0)
    mockOldest.mockReset().mockImplementation(async () => null)
    mockPersist.mockClear()
    mockSetTranscript.mockClear()
    mockIncTranscribeAttempt.mockClear()
    mockOnReconnectCb = null
  })

  it('renders in Field mode + calls requestPersistence on first mount', async () => {
    renderAt(MODE.FIELD)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByTestId('field-capture-page')).toBeDefined()
    expect(mockPersist).toHaveBeenCalledTimes(1)
  })

  it('redirects to /dashboard when mode === desk', () => {
    renderAt(MODE.DESK)
    expect(screen.getByTestId('dashboard-stub')).toBeDefined()
    expect(mockPersist).not.toHaveBeenCalled()
  })

  it('initial render loads the queue list', async () => {
    const seed = [
      { id: 'a', kind: 'text', text: 'note one', capturedAt: '2026-05-29T12:00:00.000Z', status: 'queued' },
      { id: 'b', kind: 'audio', mime: 'audio/webm', durationMs: 4200, capturedAt: '2026-05-29T12:01:00.000Z', status: 'recorded', blob: new Blob(['x']) },
    ]
    mockDepth.mockImplementation(async () => 2)
    mockOldest.mockImplementation(async () => 90 * 1000)
    renderAt(MODE.FIELD, { initialList: seed })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(screen.getByText(/Queued \(2\)/)).toBeDefined()
    expect(screen.getByText('note one')).toBeDefined()
    expect(screen.getByText(/Voice \(4\.2s\)/)).toBeDefined()
  })

  it('mic record → enqueueRecording called with blob + mime + durationMs', async () => {
    renderAt(MODE.FIELD)
    await act(async () => { await Promise.resolve() })
    fireEvent.click(screen.getByTestId('mic-capture-button'))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    fireEvent.click(screen.getByTestId('mic-capture-button'))
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    expect(mockEnqueueRecording).toHaveBeenCalledTimes(1)
    const arg = mockEnqueueRecording.mock.calls[0][0]
    expect(arg.mime).toBe('audio/webm')
    expect(arg.durationMs).toBe(1234)
    expect(arg.mode).toBe('field')
    expect(arg.blob).toBeTruthy()
  })

  it('tap fallback submit → enqueueText called with text', async () => {
    renderAt(MODE.FIELD)
    await act(async () => { await Promise.resolve() })
    fireEvent.change(screen.getByTestId('tap-capture-textarea'), { target: { value: 'broccoli flowering' } })
    fireEvent.click(screen.getByTestId('tap-capture-submit'))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(mockEnqueueText).toHaveBeenCalledTimes(1)
    expect(mockEnqueueText.mock.calls[0][0]).toEqual({ text: 'broccoli flowering', mode: 'field' })
  })

  it('no error banner on initial happy-path render', async () => {
    renderAt(MODE.FIELD)
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByTestId('field-error-banner')).toBe(null)
  })

  it('reconnect subscription wired on mount; trigger fires refresh', async () => {
    renderAt(MODE.FIELD)
    await act(async () => { await Promise.resolve() })
    expect(typeof mockOnReconnectCb).toBe('function')
    mockList.mockClear()
    mockOnReconnectCb()
    await act(async () => { await Promise.resolve() })
    expect(mockList).toHaveBeenCalled()
  })

  it('queue load error surfaces the error banner', async () => {
    mockList.mockImplementation(() => Promise.reject('unavailable'))
    renderAt(MODE.FIELD, { preservesMockList: true })
    const banner = await screen.findByTestId('field-error-banner')
    expect(banner.textContent).toMatch(/Storage unavailable/)
  })
})

describe('FieldCapture (Inc 2 Bite 5 — TranscriptReview wiring)', () => {
  beforeEach(() => {
    mockEnqueueRecording.mockClear()
    mockEnqueueText.mockClear()
    mockList.mockReset()
    mockDepth.mockReset().mockImplementation(async () => 0)
    mockOldest.mockReset().mockImplementation(async () => null)
    mockPersist.mockClear()
    mockSetTranscript.mockClear()
    mockIncTranscribeAttempt.mockClear()
    mockOnReconnectCb = null
  })

  it('tap a queued audio item → TranscriptReview expands inline', async () => {
    const seed = [{
      id: 'a-1', kind: 'audio',
      blob: new Blob(['x'], { type: 'audio/webm' }),
      mime: 'audio/webm', durationMs: 3200,
      capturedAt: '2026-05-30T10:00:00.000Z',
      status: 'recorded', transcribeAttempts: 0,
    }]
    renderAt(MODE.FIELD, { initialList: seed })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(screen.queryByTestId('transcript-review')).toBe(null)
    fireEvent.click(screen.getByTestId('field-queue-item-toggle'))
    expect(screen.getByTestId('transcript-review')).toBeDefined()
    expect(screen.getByTestId('transcript-review').getAttribute('data-entry-id')).toBe('a-1')
  })

  it('tap-to-expand again collapses', async () => {
    const seed = [{
      id: 'a-1', kind: 'audio', blob: new Blob(['x']), mime: 'audio/webm',
      durationMs: 1000, capturedAt: '2026-05-30T10:00:00.000Z', status: 'recorded',
    }]
    renderAt(MODE.FIELD, { initialList: seed })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    const toggle = screen.getByTestId('field-queue-item-toggle')
    fireEvent.click(toggle)
    expect(screen.getByTestId('transcript-review')).toBeDefined()
    fireEvent.click(toggle)
    expect(screen.queryByTestId('transcript-review')).toBe(null)
  })

  it('saving a transcript from TranscriptReview triggers refresh of the queue', async () => {
    const seed = [{
      id: 'a-1', kind: 'audio', blob: new Blob(['x']), mime: 'audio/webm',
      durationMs: 1000, capturedAt: '2026-05-30T10:00:00.000Z', status: 'recorded',
    }]
    renderAt(MODE.FIELD, { initialList: seed })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    fireEvent.click(screen.getByTestId('field-queue-item-toggle'))
    fireEvent.change(screen.getByTestId('transcript-draft'), { target: { value: 'aphids on tomatoes' } })
    mockList.mockClear()
    await act(async () => { fireEvent.click(screen.getByTestId('transcript-save')); await Promise.resolve(); await Promise.resolve() })
    expect(mockSetTranscript).toHaveBeenCalledWith({ id: 'a-1', transcript: 'aphids on tomatoes', source: 'manual' })
    expect(mockList).toHaveBeenCalled()
  })
})
