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
import { isReloadBlocked, clearReloadBlocks } from '../lib/reloadGate.js'

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

  // ───────────────────────────────────────────────────────────────────────────
  // V4-DIRTYGUARDSWEEP-001 — the SW reload gate over a live recording.
  //
  // Driven against the REAL reloadGate, never a spy on setReloadBlocked: the bug this row closes is
  // "the primitive shipped with no callers", and a spy proves only that a call was made, not that
  // the gate ends up held. Every assertion below reads isReloadBlocked().
  //
  // The false-positive half is load-bearing. A recording is the ONLY in-memory state this page owns
  // — the queue is IndexedDB, and the two typed surfaces guard themselves — so a guard that fired on
  // a merely-visited /field would hold every deploy for a user with nothing at risk.
  describe('dirty guard — live recording holds the SW reload', () => {
    const startRecording = async () => {
      fireEvent.click(screen.getByTestId('mic-capture-button'))
      await act(async () => { await Promise.resolve(); await Promise.resolve() })
    }
    const stopRecording = async () => {
      fireEvent.click(screen.getByTestId('mic-capture-button'))
      await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    }

    beforeEach(() => { clearReloadBlocks() })

    it('a merely-VISITED page does not hold the gate; tapping record does', async () => {
      renderAt(MODE.FIELD)
      await act(async () => { await Promise.resolve() })
      expect(screen.getByTestId('field-capture-page')).toBeDefined()
      expect(isReloadBlocked(), 'a merely-visited /field must not hold a deploy').toBe(false)
      // Paired with the flip in the SAME test on purpose: a lone "does not hold" assertion also
      // passes when nothing is wired at all, so on its own it discriminates nothing.
      await startRecording()
      expect(screen.getByTestId('mic-capture-root').dataset.state).toBe('recording')
      expect(isReloadBlocked()).toBe(true)
    })

    it('stopping the recording releases the hold once the blob is queued', async () => {
      renderAt(MODE.FIELD)
      await act(async () => { await Promise.resolve() })
      await startRecording()
      expect(isReloadBlocked()).toBe(true)
      await stopRecording()
      expect(mockEnqueueRecording).toHaveBeenCalledTimes(1)
      expect(isReloadBlocked(), 'a queued recording has nothing left to protect').toBe(false)
    })

    it('the hold spans the ENQUEUE, not just the recording', async () => {
      // The gap this covers: maybeEmit() flips the recorder to idle and only then calls onRecorded,
      // so between "idle" and captureQueue owning the bytes the blob is still memory-only. Without
      // the enqueueing term the gate would be open for exactly that window — and on a phone writing
      // an audio blob to IndexedDB it is not a short one.
      // Asserted with the enqueue held open on purpose: the earlier tests flush recording→idle→
      // queued in one act() and cannot see the dip, so they pass with the term deleted.
      let release
      mockEnqueueRecording.mockImplementationOnce(
        () => new Promise((resolve) => { release = () => resolve({ id: 'audio-held' }) }))
      renderAt(MODE.FIELD)
      await act(async () => { await Promise.resolve() })
      await startRecording()
      await stopRecording()
      expect(screen.getByTestId('mic-capture-root').dataset.state).toBe('idle')
      expect(isReloadBlocked(), 'recorder idle but the blob is still only in memory').toBe(true)
      await act(async () => { release(); await Promise.resolve(); await Promise.resolve() })
      expect(isReloadBlocked(), 'queued — nothing left to protect').toBe(false)
    })

    it('a FAILED enqueue still releases — never wedge updates', async () => {
      // The blob is gone either way; keeping the hold after the banner is up would park the SW
      // update forever, which is BUG-STALECLIENT-001's failure mode and the reason this is a
      // deferral rather than a cancellation.
      mockEnqueueRecording.mockImplementationOnce(async () => { throw 'quota' })
      renderAt(MODE.FIELD)
      await act(async () => { await Promise.resolve() })
      await startRecording()
      expect(isReloadBlocked()).toBe(true)
      await stopRecording()
      expect(screen.getByTestId('field-error-banner').textContent).toMatch(/Storage is full/)
      expect(isReloadBlocked()).toBe(false)
    })

    it('unmounting mid-recording releases the hold', async () => {
      const { unmount } = renderAt(MODE.FIELD)
      await act(async () => { await Promise.resolve() })
      await startRecording()
      expect(isReloadBlocked()).toBe(true)
      unmount()
      expect(isReloadBlocked()).toBe(false)
    })

    it('typing in the tap fallback and expanding a tile are separately guarded, not by this page', async () => {
      // Regression fence for the predicate's exclusions. expandedId is navigation and must never
      // hold; the textarea DOES hold, but via TapCaptureFallback's own key — so the page-level
      // predicate staying narrow does not leave the typed note undefended.
      const seed = [{ id: 't-1', kind: 'text', text: 'note one', capturedAt: '2026-05-29T12:00:00.000Z', status: 'queued' }]
      renderAt(MODE.FIELD, { initialList: seed })
      await act(async () => { await Promise.resolve(); await Promise.resolve() })
      fireEvent.click(screen.getByTestId('field-queue-item-toggle'))
      expect(isReloadBlocked(), 'expanding a queued tile must not hold a deploy').toBe(false)
      fireEvent.change(screen.getByTestId('tap-capture-textarea'), { target: { value: 'aphids' } })
      expect(isReloadBlocked()).toBe(true)
    })
  })
})
