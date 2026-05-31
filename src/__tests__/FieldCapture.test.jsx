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
const mockMarkHandedOff = vi.fn(async (id) => ({ id, status: 'handed_off' }))
let mockOnReconnectCb = null

vi.mock('../lib/captureQueue.js', () => ({
  enqueueRecording:         (...args) => mockEnqueueRecording(...args),
  enqueueText:              (...args) => mockEnqueueText(...args),
  list:                     () => mockList(),
  getUnprocessedDepth:      () => mockDepth(),
  getOldestUnprocessedAgeMs:() => mockOldest(),
  setTranscript:            (...args) => mockSetTranscript(...args),
  incrementTranscribeAttempt:(...args) => mockIncTranscribeAttempt(...args),
  markHandedOff:            (...args) => mockMarkHandedOff(...args),
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

describe('FieldCapture (Inc 2 Bite 7 — one-pass capture tile UX)', () => {
  let origShare, origClipboard
  beforeEach(() => {
    mockEnqueueRecording.mockClear()
    mockEnqueueText.mockClear()
    mockList.mockReset()
    mockDepth.mockReset().mockImplementation(async () => 0)
    mockOldest.mockReset().mockImplementation(async () => null)
    mockPersist.mockClear()
    mockSetTranscript.mockClear()
    mockIncTranscribeAttempt.mockClear()
    mockMarkHandedOff.mockReset().mockImplementation(async (id) => ({ id, status: 'handed_off' }))
    mockOnReconnectCb = null
    origShare = navigator.share
    origClipboard = navigator.clipboard
    delete navigator.share
    delete navigator.clipboard
  })

  it('handleRecorded passes one-pass transcript + source through to enqueueRecording', async () => {
    // Override the audioCapture stop to return a transcript (mimics Bite 7 MicCaptureButton).
    renderAt(MODE.FIELD)
    await act(async () => { await Promise.resolve() })
    // Simulate the MicCaptureButton emitting an enriched result by driving the
    // record→stop cycle; the mocked startRecording().stop() returns no transcript,
    // so we instead assert the wiring by calling through the public surface:
    // click record, then stop — and assert enqueueRecording received the keys
    // (transcript will be '' here since transcribe mock isTranscriptionSupported=false).
    fireEvent.click(screen.getByTestId('mic-capture-button'))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    fireEvent.click(screen.getByTestId('mic-capture-button'))
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    expect(mockEnqueueRecording).toHaveBeenCalledTimes(1)
    const arg = mockEnqueueRecording.mock.calls[0][0]
    expect('transcript' in arg).toBe(true)
    expect('transcriptSource' in arg).toBe(true)
    expect(arg.mode).toBe('field')
  })

  it('queue renders newest-first (fresh capture on top, stale empty one sinks)', async () => {
    const seed = [
      { id: 'old', kind: 'audio', blob: new Blob(['x']), mime: 'audio/webm', durationMs: 5000,
        transcript: null, status: 'recorded', capturedAt: '2026-05-31T02:59:00.000Z',
        transcribeAttempts: 0, transcriptSource: null },
      { id: 'new', kind: 'audio', blob: new Blob(['y']), mime: 'audio/webm', durationMs: 3000,
        transcript: 'absolutely love her boots', status: 'transcribed', capturedAt: '2026-05-31T03:51:00.000Z',
        transcribeAttempts: 1, transcriptSource: 'web-speech' },
    ]
    renderAt(MODE.FIELD, { initialList: seed })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    const items = screen.getAllByTestId('field-queue-item')
    // newest (transcribed) first
    expect(items[0].getAttribute('data-status')).toBe('transcribed')
    expect(items[1].getAttribute('data-status')).toBe('recorded')
  })

  it('audio tile with a transcript shows the transcript inline (not "Voice (Xs)")', async () => {
    const seed = [{
      id: 'a-1', kind: 'audio', blob: new Blob(['x']), mime: 'audio/webm',
      durationMs: 3200, transcript: 'beans need staking', status: 'transcribed',
      capturedAt: '2026-05-31T03:00:00.000Z', transcribeAttempts: 1, transcriptSource: 'web-speech',
    }]
    renderAt(MODE.FIELD, { initialList: seed })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(screen.getByTestId('field-queue-item-label').textContent).toMatch(/beans need staking/)
    expect(screen.queryByText(/Voice \(/)).toBe(null)
  })

  it('tile-level Send to Claude shown for transcribed audio + clipboard delivery marks handed_off', async () => {
    const writeSpy = vi.fn(async () => undefined)
    navigator.clipboard = { writeText: writeSpy }
    const seed = [{
      id: 'a-1', kind: 'audio', blob: new Blob(['x']), mime: 'audio/webm',
      durationMs: 3200, transcript: 'powdery mildew on squash', status: 'transcribed',
      capturedAt: '2026-05-31T03:00:00.000Z', transcribeAttempts: 1, transcriptSource: 'web-speech',
    }]
    renderAt(MODE.FIELD, { initialList: seed })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    const sendBtn = screen.getByTestId('field-queue-item-send')
    expect(sendBtn).toBeDefined()
    await act(async () => { fireEvent.click(sendBtn); await Promise.resolve(); await Promise.resolve() })
    expect(writeSpy).toHaveBeenCalledTimes(1)
    expect(writeSpy.mock.calls[0][0]).toContain('powdery mildew on squash')
    expect(mockMarkHandedOff).toHaveBeenCalledWith('a-1')
    expect(screen.getByTestId('field-queue-item-send-status').textContent).toMatch(/Copied/)
  })

  it('tile-level Send NOT shown when audio has no transcript', async () => {
    const seed = [{
      id: 'a-2', kind: 'audio', blob: new Blob(['x']), mime: 'audio/webm',
      durationMs: 1000, transcript: null, status: 'recorded',
      capturedAt: '2026-05-31T03:01:00.000Z', transcribeAttempts: 0, transcriptSource: null,
    }]
    renderAt(MODE.FIELD, { initialList: seed })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(screen.queryByTestId('field-queue-item-send')).toBe(null)
  })

  it('handed_off tile shows "Sent to Claude." and no send button', async () => {
    const seed = [{
      id: 'a-3', kind: 'audio', blob: new Blob(['x']), mime: 'audio/webm',
      durationMs: 1000, transcript: 'done', status: 'handed_off',
      capturedAt: '2026-05-31T03:02:00.000Z', transcribeAttempts: 1, transcriptSource: 'web-speech',
    }]
    renderAt(MODE.FIELD, { initialList: seed })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(screen.queryByTestId('field-queue-item-send')).toBe(null)
    expect(screen.getByTestId('field-queue-item-handed-off')).toBeDefined()
  })

  it('tile Send manual fallback when share + clipboard absent', async () => {
    const seed = [{
      id: 'a-4', kind: 'audio', blob: new Blob(['x']), mime: 'audio/webm',
      durationMs: 1000, transcript: 'manual path', status: 'transcribed',
      capturedAt: '2026-05-31T03:03:00.000Z', transcribeAttempts: 1, transcriptSource: 'web-speech',
    }]
    renderAt(MODE.FIELD, { initialList: seed })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    await act(async () => { fireEvent.click(screen.getByTestId('field-queue-item-send')); await Promise.resolve(); await Promise.resolve() })
    expect(mockMarkHandedOff).not.toHaveBeenCalled()
    expect(screen.getByTestId('field-queue-item-send-status').textContent).toMatch(/Could not share or copy/)
  })
})
