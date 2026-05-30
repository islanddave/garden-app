import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

const mockSetTranscript = vi.fn(async (args) => ({
  id: args.id,
  transcript: args.transcript,
  transcriptSource: args.source,
  status: 'transcribed',
  transcribedAt: new Date().toISOString(),
  transcribeAttempts: 1,
}))
const mockIncrementTranscribeAttempt = vi.fn(async () => ({ id: 'x', transcribeAttempts: 1 }))

vi.mock('../lib/captureQueue.js', () => ({
  setTranscript: (...args) => mockSetTranscript(...args),
  incrementTranscribeAttempt: (...args) => mockIncrementTranscribeAttempt(...args),
  TRANSCRIPT_SOURCE: { MANUAL: 'manual', WEB_SPEECH: 'web-speech' },
}))

// Controllable transcribe mock — gives tests precise control of the lifecycle.
const liveCallbacks = { last: null }
const mockStartLive = vi.fn((opts) => {
  liveCallbacks.last = opts
  return {
    stop:   vi.fn(),
    cancel: vi.fn(),
  }
})
const mockIsSupportedFn = vi.fn(() => true)
vi.mock('../lib/transcribe.js', () => ({
  isTranscriptionSupported: () => mockIsSupportedFn(),
  startLiveTranscription:    (opts) => mockStartLive(opts),
  START_TIMEOUT_MS:          3500,
  NO_SPEECH_TIMEOUT_MS:      8000,
}))

// Polyfill URL.createObjectURL / revokeObjectURL for jsdom.
if (!global.URL.createObjectURL) {
  global.URL.createObjectURL = () => 'blob:fake'
}
if (!global.URL.revokeObjectURL) {
  global.URL.revokeObjectURL = () => {}
}

import TranscriptReview from '../components/TranscriptReview.jsx'

const audioEntry = {
  id: 'a1',
  kind: 'audio',
  blob: new Blob(['x'], { type: 'audio/webm' }),
  mime: 'audio/webm',
  durationMs: 4500,
  text: null,
  capturedAt: '2026-05-30T10:00:00.000Z',
  status: 'recorded',
  attemptCount: 0,
  transcript: null,
  transcribedAt: null,
  transcribeAttempts: 0,
  transcriptSource: null,
}

const textEntry = {
  id: 't1',
  kind: 'text',
  blob: null,
  mime: null,
  durationMs: null,
  text: 'tomato leaves curling',
  capturedAt: '2026-05-30T10:01:00.000Z',
  status: 'queued',
  attemptCount: 0,
  transcript: null,
  transcribedAt: null,
  transcribeAttempts: 0,
  transcriptSource: null,
}

describe('TranscriptReview (Inc 2 Bite 5)', () => {
  beforeEach(() => {
    mockSetTranscript.mockClear()
    mockIncrementTranscribeAttempt.mockClear()
    mockStartLive.mockClear()
    mockIsSupportedFn.mockReset().mockImplementation(() => true)
    liveCallbacks.last = null
  })

  it('renders audio playback for an audio entry', () => {
    render(<TranscriptReview entry={audioEntry} />)
    expect(screen.getByTestId('transcript-review')).toBeDefined()
    expect(screen.getByTestId('transcript-audio-playback')).toBeDefined()
  })

  it('seeds the textarea with text for a text entry', () => {
    render(<TranscriptReview entry={textEntry} />)
    const ta = screen.getByTestId('transcript-draft')
    expect(ta.value).toBe('tomato leaves curling')
  })

  it('disables Save when draft is empty', () => {
    render(<TranscriptReview entry={audioEntry} />)
    const save = screen.getByTestId('transcript-save')
    expect(save.disabled).toBe(true)
  })

  it('typing enables Save and successful save calls setTranscript with manual source', async () => {
    render(<TranscriptReview entry={audioEntry} />)
    const ta = screen.getByTestId('transcript-draft')
    fireEvent.change(ta, { target: { value: 'aphids on the cherry tomatoes' } })
    const save = screen.getByTestId('transcript-save')
    expect(save.disabled).toBe(false)
    await act(async () => { fireEvent.click(save); await Promise.resolve() })
    expect(mockSetTranscript).toHaveBeenCalledWith({
      id: 'a1',
      transcript: 'aphids on the cherry tomatoes',
      source: 'manual',
    })
    expect(screen.getByTestId('transcript-review').getAttribute('data-state')).toBe('transcribed')
  })

  it('Speak it now button absent when Web Speech is unsupported', () => {
    mockIsSupportedFn.mockImplementation(() => false)
    render(<TranscriptReview entry={audioEntry} />)
    expect(screen.queryByTestId('transcript-speak-now')).toBeNull()
  })

  it('Speak it now button absent for text entries (audio-only feature)', () => {
    render(<TranscriptReview entry={textEntry} />)
    expect(screen.queryByTestId('transcript-speak-now')).toBeNull()
  })

  it('Speak it now → onResult final → updates textarea (Web Speech happy path)', async () => {
    render(<TranscriptReview entry={audioEntry} />)
    const speak = screen.getByTestId('transcript-speak-now')
    await act(async () => { fireEvent.click(speak) })
    expect(mockStartLive).toHaveBeenCalled()
    // Now simulate a Web Speech final result via captured callback
    await act(async () => {
      liveCallbacks.last.onResult({ transcript: 'tomato leaves curling', isFinal: true })
    })
    await act(async () => { liveCallbacks.last.onEnd({ finalTranscript: 'tomato leaves curling' }) })
    expect(screen.getByTestId('transcript-draft').value).toBe('tomato leaves curling')
    expect(screen.getByTestId('transcript-review').getAttribute('data-state')).toBe('idle')
  })

  it('Speak it now → silent-failure → state flips to silent-fallback and surfaces fallback message', async () => {
    render(<TranscriptReview entry={audioEntry} />)
    await act(async () => { fireEvent.click(screen.getByTestId('transcript-speak-now')) })
    await act(async () => { liveCallbacks.last.onError('silent-failure') })
    const r = screen.getByTestId('transcript-review')
    expect(r.getAttribute('data-state')).toBe('silent-fallback')
    expect(screen.getByTestId('transcript-state-label').textContent).toMatch(/couldn.t transcribe/i)
    expect(mockIncrementTranscribeAttempt).toHaveBeenCalledWith('a1')
  })

  it('Speak it now → denied → state flips to failed with denied message', async () => {
    render(<TranscriptReview entry={audioEntry} />)
    await act(async () => { fireEvent.click(screen.getByTestId('transcript-speak-now')) })
    await act(async () => { liveCallbacks.last.onError('denied') })
    const r = screen.getByTestId('transcript-review')
    expect(r.getAttribute('data-state')).toBe('failed')
    expect(screen.getByTestId('transcript-state-label').textContent).toMatch(/permission denied/i)
  })

  it('Speak it now → no-speech → state flips to failed with no-speech message', async () => {
    render(<TranscriptReview entry={audioEntry} />)
    await act(async () => { fireEvent.click(screen.getByTestId('transcript-speak-now')) })
    await act(async () => { liveCallbacks.last.onError('no-speech') })
    const r = screen.getByTestId('transcript-review')
    expect(r.getAttribute('data-state')).toBe('failed')
    expect(screen.getByTestId('transcript-state-label').textContent).toMatch(/didn.t hear/i)
  })

  it('Save error (quota) calls onError prop with the code', async () => {
    mockSetTranscript.mockImplementationOnce(async () => { throw 'quota' })
    const onError = vi.fn()
    render(<TranscriptReview entry={audioEntry} onError={onError} />)
    fireEvent.change(screen.getByTestId('transcript-draft'), { target: { value: 'x' } })
    await act(async () => { fireEvent.click(screen.getByTestId('transcript-save')); await Promise.resolve() })
    expect(onError).toHaveBeenCalledWith('quota')
  })

  it('successful save fires onTranscriptSaved with the entry id', async () => {
    const onSaved = vi.fn()
    render(<TranscriptReview entry={audioEntry} onTranscriptSaved={onSaved} />)
    fireEvent.change(screen.getByTestId('transcript-draft'), { target: { value: 'x' } })
    await act(async () => { fireEvent.click(screen.getByTestId('transcript-save')); await Promise.resolve() })
    expect(onSaved).toHaveBeenCalledWith('a1')
  })

  it('pre-existing transcript renders in transcribed state', () => {
    const e = { ...audioEntry, transcript: 'aphids spotted', status: 'transcribed', transcribedAt: new Date().toISOString(), transcribeAttempts: 1 }
    render(<TranscriptReview entry={e} />)
    expect(screen.getByTestId('transcript-review').getAttribute('data-state')).toBe('transcribed')
    expect(screen.getByTestId('transcript-draft').value).toBe('aphids spotted')
  })
})
