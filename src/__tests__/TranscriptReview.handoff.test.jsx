import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

const mockSetTranscript = vi.fn(async (args) => ({ id: args.id, transcript: args.transcript, status: 'transcribed' }))
const mockIncrementTranscribeAttempt = vi.fn(async () => ({}))
const mockMarkHandedOff = vi.fn(async (id) => ({ id, status: 'handed_off' }))

vi.mock('../lib/captureQueue.js', () => ({
  setTranscript: (...a) => mockSetTranscript(...a),
  incrementTranscribeAttempt: (...a) => mockIncrementTranscribeAttempt(...a),
  markHandedOff: (...a) => mockMarkHandedOff(...a),
  TRANSCRIPT_SOURCE: { MANUAL: 'manual', WEB_SPEECH: 'web-speech' },
}))

vi.mock('../lib/transcribe.js', () => ({
  isTranscriptionSupported: () => false,
  startLiveTranscription:    () => ({ stop: () => {}, cancel: () => {} }),
  START_TIMEOUT_MS:          3500,
  NO_SPEECH_TIMEOUT_MS:      8000,
}))

if (!global.URL.createObjectURL) global.URL.createObjectURL = () => 'blob:fake'
if (!global.URL.revokeObjectURL) global.URL.revokeObjectURL = () => {}

import TranscriptReview from '../components/TranscriptReview.jsx'
import { HELPER_PROMPT_FENCE } from '../lib/helperPrompt.js'

const transcribedAudio = {
  id: 'a1',
  kind: 'audio',
  blob: new Blob(['x'], { type: 'audio/webm' }),
  mime: 'audio/webm',
  durationMs: 4500,
  text: 'aphids on the cherry tomatoes',
  transcript: 'aphids on the cherry tomatoes',
  status: 'transcribed',
  capturedAt: '2026-05-30T10:00:00.000Z',
  transcribeAttempts: 1,
  transcriptSource: 'manual',
}
const textEntry = {
  id: 't1', kind: 'text', text: 'tomato leaves curling',
  blob: null, mime: null, durationMs: null,
  transcript: null, status: 'queued',
  capturedAt: '2026-05-30T10:01:00.000Z',
  transcribeAttempts: 0, transcriptSource: null,
}
const emptyAudio = {
  id: 'a2', kind: 'audio',
  blob: new Blob(['y']), mime: 'audio/webm', durationMs: 1000,
  text: null, transcript: null, status: 'recorded',
  capturedAt: '2026-05-30T10:02:00.000Z',
  transcribeAttempts: 0, transcriptSource: null,
}

describe('TranscriptReview — Bite 6 Send to Claude handoff', () => {
  let origShare, origClipboard
  beforeEach(() => {
    mockSetTranscript.mockClear()
    mockIncrementTranscribeAttempt.mockClear()
    mockMarkHandedOff.mockReset().mockImplementation(async (id) => ({ id, status: 'handed_off' }))
    // Save and reset window.navigator surface between tests
    origShare = navigator.share
    origClipboard = navigator.clipboard
    delete navigator.share
    delete navigator.clipboard
  })

  it('Send-to-Claude button NOT shown when entry has no transcript/text content', () => {
    render(<TranscriptReview entry={emptyAudio} />)
    expect(screen.queryByTestId('transcript-send-to-claude')).toBe(null)
  })

  it('Send-to-Claude button shown when transcript is present', () => {
    render(<TranscriptReview entry={transcribedAudio} />)
    expect(screen.getByTestId('transcript-send-to-claude')).toBeDefined()
  })

  it('Send-to-Claude button shown for text entry with text content', () => {
    render(<TranscriptReview entry={textEntry} />)
    expect(screen.getByTestId('transcript-send-to-claude')).toBeDefined()
  })

  it('happy path: navigator.share invoked with assembled prompt containing fence + transcript', async () => {
    const shareSpy = vi.fn(async () => undefined)
    navigator.share = shareSpy
    render(<TranscriptReview entry={transcribedAudio} />)
    await act(async () => { fireEvent.click(screen.getByTestId('transcript-send-to-claude')); await Promise.resolve(); await Promise.resolve() })
    expect(shareSpy).toHaveBeenCalledTimes(1)
    const arg = shareSpy.mock.calls[0][0]
    expect(arg).toBeDefined()
    expect(typeof arg.text).toBe('string')
    expect(arg.text).toContain(HELPER_PROMPT_FENCE.open)
    expect(arg.text).toContain(HELPER_PROMPT_FENCE.close)
    expect(arg.text).toContain('aphids on the cherry tomatoes')
    expect(mockMarkHandedOff).toHaveBeenCalledWith('a1')
    expect(screen.getByTestId('transcript-review').getAttribute('data-state')).toBe('handed-off')
    expect(screen.getByTestId('transcript-send-status').textContent).toMatch(/Shared/)
  })

  it('clipboard fallback when navigator.share absent', async () => {
    const writeSpy = vi.fn(async () => undefined)
    navigator.clipboard = { writeText: writeSpy }
    render(<TranscriptReview entry={transcribedAudio} />)
    await act(async () => { fireEvent.click(screen.getByTestId('transcript-send-to-claude')); await Promise.resolve(); await Promise.resolve() })
    expect(writeSpy).toHaveBeenCalledTimes(1)
    expect(writeSpy.mock.calls[0][0]).toContain('aphids on the cherry tomatoes')
    expect(mockMarkHandedOff).toHaveBeenCalledWith('a1')
    expect(screen.getByTestId('transcript-send-status').textContent).toMatch(/Copied/)
  })

  it('navigator.share rejects → falls through to clipboard', async () => {
    navigator.share = vi.fn(async () => { throw new Error('AbortError') })
    const writeSpy = vi.fn(async () => undefined)
    navigator.clipboard = { writeText: writeSpy }
    render(<TranscriptReview entry={transcribedAudio} />)
    await act(async () => { fireEvent.click(screen.getByTestId('transcript-send-to-claude')); await Promise.resolve(); await Promise.resolve() })
    expect(writeSpy).toHaveBeenCalledTimes(1)
    expect(mockMarkHandedOff).toHaveBeenCalledWith('a1')
  })

  it('manual fallback when both share AND clipboard are absent', async () => {
    render(<TranscriptReview entry={transcribedAudio} />)
    await act(async () => { fireEvent.click(screen.getByTestId('transcript-send-to-claude')); await Promise.resolve(); await Promise.resolve() })
    expect(mockMarkHandedOff).not.toHaveBeenCalled()
    expect(screen.getByTestId('transcript-manual-fallback')).toBeDefined()
    expect(screen.getByTestId('transcript-manual-fallback').textContent).toMatch(/Long-press|copy/)
  })

  it('onHandedOff prop fires with entry id on successful delivery', async () => {
    navigator.share = vi.fn(async () => undefined)
    const onHandedOff = vi.fn()
    render(<TranscriptReview entry={transcribedAudio} onHandedOff={onHandedOff} />)
    await act(async () => { fireEvent.click(screen.getByTestId('transcript-send-to-claude')); await Promise.resolve(); await Promise.resolve() })
    expect(onHandedOff).toHaveBeenCalledWith('a1')
  })

  it('markHandedOff storage error → still shows delivered status (advisory feedback)', async () => {
    navigator.share = vi.fn(async () => undefined)
    mockMarkHandedOff.mockImplementationOnce(async () => { throw 'quota' })
    const onError = vi.fn()
    render(<TranscriptReview entry={transcribedAudio} onError={onError} />)
    await act(async () => { fireEvent.click(screen.getByTestId('transcript-send-to-claude')); await Promise.resolve(); await Promise.resolve() })
    expect(onError).toHaveBeenCalledWith('quota')
    // Did not undo delivery — share was successful, send status still shared.
    expect(screen.getByTestId('transcript-send-status').textContent).toMatch(/Shared/)
  })

  it('handed-off entries render in handed-off state with disabled save + no send button', () => {
    const e = { ...transcribedAudio, status: 'handed_off' }
    render(<TranscriptReview entry={e} />)
    expect(screen.getByTestId('transcript-review').getAttribute('data-state')).toBe('handed-off')
    expect(screen.queryByTestId('transcript-send-to-claude')).toBe(null)
    expect(screen.getByTestId('transcript-save').disabled).toBe(true)
  })

  it('after successful send, save button is disabled (handed-off lock)', async () => {
    navigator.share = vi.fn(async () => undefined)
    render(<TranscriptReview entry={transcribedAudio} />)
    await act(async () => { fireEvent.click(screen.getByTestId('transcript-send-to-claude')); await Promise.resolve(); await Promise.resolve() })
    expect(screen.getByTestId('transcript-save').disabled).toBe(true)
  })

  it('send uses current draft when user has typed beyond saved transcript', async () => {
    const shareSpy = vi.fn(async () => undefined)
    navigator.share = shareSpy
    render(<TranscriptReview entry={transcribedAudio} />)
    fireEvent.change(screen.getByTestId('transcript-draft'), { target: { value: 'edited content with new detail' } })
    await act(async () => { fireEvent.click(screen.getByTestId('transcript-send-to-claude')); await Promise.resolve(); await Promise.resolve() })
    // After typing, state flips to idle (no longer transcribed); the prompt should reflect the draft content
    // EXCEPT entry.transcript still takes precedence per assembleFromEntry rules.
    // Per implementation: handleSendToClaude builds sendEntry={...entry, transcript: text} from draft, so draft wins.
    expect(shareSpy).toHaveBeenCalledTimes(1)
    expect(shareSpy.mock.calls[0][0].text).toContain('edited content with new detail')
  })
})
