// FieldCapture × the REAL transcribe.js — gate B3.
//
// FieldCapture.test.jsx mocks ../lib/transcribe.js with `isTranscriptionSupported: () => false`,
// annotated "transcribe is unused in FieldCapture but pulled in via TranscriptReview". It is not
// unused: MicCaptureButton starts a live recogniser inside this page's own capture flow, and the
// text it produces is what lands in the durable queue. With the stub returning false that whole
// branch is dead in all 24 of that file's tests — the page's ONLY writer of a web-speech transcript
// has never executed under test.
//
// This is the page-level composition, non-mocked, over the SHARED fake recogniser (gate B4).
// MicCaptureButton.realTranscribe.test.jsx pins the wrapper's behaviour at the component; this pins
// that the resulting text survives the hand-off into the queue record, which is a different seam
// (MicCaptureButton emits through onRecorded, and FieldCapture decides what to persist).
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ModeProvider } from '../context/ModeContext.jsx'
import { MODE } from '../lib/mode.js'
import { installFakeSpeechRecognition } from './helpers/fakeSpeechRecognition.js'
import { resetMicArbiter } from '../lib/micArbiter.js'

const mockEnqueueRecording = vi.fn(async (rec) => ({ id: 'audio-1', kind: 'audio', ...rec, capturedAt: new Date().toISOString(), status: 'recorded' }))

vi.mock('../lib/captureQueue.js', () => ({
  enqueueRecording:          (...args) => mockEnqueueRecording(...args),
  enqueueText:               vi.fn(async () => ({ id: 'text-1', kind: 'text', status: 'queued' })),
  list:                      async () => [],
  getUnprocessedDepth:       async () => 0,
  getOldestUnprocessedAgeMs: async () => null,
  setTranscript:             vi.fn(async (args) => ({ id: args.id, transcript: args.transcript })),
  incrementTranscribeAttempt: vi.fn(async () => ({})),
  markHandedOff:             vi.fn(async (id) => ({ id, status: 'handed_off' })),
  STATUS: { QUEUED: 'queued', RECORDED: 'recorded', TRANSCRIBED: 'transcribed', HANDED_OFF: 'handed_off' },
  KIND: { AUDIO: 'audio', TEXT: 'text' },
  TRANSCRIPT_SOURCE: { MANUAL: 'manual', WEB_SPEECH: 'web-speech' },
}))

vi.mock('../lib/durableStorage.js', () => ({ requestPersistence: async () => ({ supported: true, granted: true }) }))
vi.mock('../lib/reconnect.js', () => ({ onReconnect: () => () => {} }))

vi.mock('../lib/audioCapture.js', () => ({
  isAudioCaptureSupported: () => true,
  startRecording: () => Promise.resolve({
    mime: 'audio/webm',
    stop: () => Promise.resolve({ blob: new Blob(['x']), mime: 'audio/webm', durationMs: 1234 }),
    cancel: vi.fn(),
  }),
}))

if (!global.URL.createObjectURL) global.URL.createObjectURL = () => 'blob:fake'
if (!global.URL.revokeObjectURL) global.URL.revokeObjectURL = () => {}

import FieldCapture from '../pages/FieldCapture.jsx'

let mic

beforeEach(() => {
  mockEnqueueRecording.mockClear()
  resetMicArbiter()
  mic = installFakeSpeechRecognition(vi)
})

afterEach(() => {
  cleanup()
  resetMicArbiter()
  vi.unstubAllGlobals()
})

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })

describe('FieldCapture × real transcribe.js — a spoken capture reaches the queue', () => {
  it('persists the slot-joined transcript with source web-speech', async () => {
    render(
      <ModeProvider initialMode={MODE.FIELD}>
        <MemoryRouter initialEntries={['/field']}>
          <Routes>
            <Route path="/field" element={<FieldCapture />} />
            <Route path="/dashboard" element={<div data-testid="dashboard-stub" />} />
          </Routes>
        </MemoryRouter>
      </ModeProvider>,
    )
    await flush()

    fireEvent.click(screen.getByTestId('mic-capture-button'))
    await flush()
    // Asserted before latest(): with transcribe.js stubbed unsupported — which is exactly what the
    // mocked sibling suite does — this list is empty and the assertions below would read undefined.
    expect(mic.instances.length, 'no recogniser was constructed — the real transcribe.js did not run').toBe(1)
    const rec = mic.latest()

    await act(async () => { rec.deliverFinal('aphids', 0) })
    await act(async () => { rec.deliverFinal('on the kale', 1) })

    fireEvent.click(screen.getByTestId('mic-capture-button'))
    await flush()

    expect(mockEnqueueRecording).toHaveBeenCalledTimes(1)
    const arg = mockEnqueueRecording.mock.calls[0][0]
    expect(arg.transcript).toBe('aphids on the kale')
    expect(arg.transcriptSource).toBe('web-speech')
    expect(arg.mode).toBe('field')
  })
})
