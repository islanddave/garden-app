// MicCaptureButton × the REAL transcribe.js — gate B3.
//
// MicCaptureButton.test.jsx `vi.mock`s ../lib/transcribe.js and hands itself a stub whose
// startLiveTranscription only records its options. Every assertion in that file therefore holds no
// matter what the wrapper does — the whole of transcribe.js could be deleted and it would stay
// green. That is the blind spot gate B3 exists to close, and it is why the mic arbiter needed a new
// suite rather than being covered by an existing one.
//
// This is the non-mocked half. It drives the real `startLiveTranscription` over the SHARED fake
// recogniser (helpers/fakeSpeechRecognition.js — gate B4), so a change to the wrapper is visible
// here. It does not replace the mocked file: that one owns the recorder state machine, the error
// codes and the queued-count chrome, and those still need a controllable seam.
//
// audioCapture IS mocked, and deliberately: MediaRecorder does not exist in jsdom, and the recorder
// is not the seam under test.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { installFakeSpeechRecognition } from './helpers/fakeSpeechRecognition.js'
import { isMicHeld, micHolder, resetMicArbiter } from '../lib/micArbiter.js'

vi.mock('../lib/audioCapture.js', () => ({
  isAudioCaptureSupported: () => true,
  startRecording: () => Promise.resolve({
    mime: 'audio/webm',
    stop: () => Promise.resolve({ blob: new Blob(['x']), mime: 'audio/webm', durationMs: 1234 }),
    cancel: vi.fn(),
  }),
}))

import MicCaptureButton from '../components/MicCaptureButton.jsx'

let mic

beforeEach(() => {
  resetMicArbiter()
  mic = installFakeSpeechRecognition(vi)
})

afterEach(() => {
  cleanup()
  resetMicArbiter()
  vi.unstubAllGlobals()
})

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })

async function startCapture(props = {}) {
  render(<MicCaptureButton onRecorded={() => {}} queuedCount={0} {...props} />)
  await flush()
  fireEvent.click(screen.getByTestId('mic-capture-button'))
  await flush()
  // Asserted before latest() is read: if transcribe.js were mocked away the list would be empty and
  // every assertion below would run against `undefined` rather than failing on the thing it pins.
  expect(mic.instances.length, 'no recogniser was constructed — the real transcribe.js did not run').toBe(1)
  return mic.latest()
}

describe('MicCaptureButton × real transcribe.js — the mic arbiter hold', () => {
  it('takes the mic under this surface’s own label and hands it back when the session ends', async () => {
    const rec = await startCapture()
    expect(isMicHeld()).toBe(true)
    // The label is the surface name transcribe.js is handed as debugLabel, so this also pins that
    // the wrapper passes it through rather than falling back to its 'transcribe' default.
    expect(micHolder()).toBe('FieldCapture:mic')

    await act(async () => { rec.endSession() })

    // Released from `onend`, which is the one terminus every path reaches. A hold that outlives its
    // recogniser is a mic no other surface can ever take.
    expect(isMicHeld()).toBe(false)
  })
})

describe('MicCaptureButton × real transcribe.js — a revised final', () => {
  it('reaches the live line once, and the committed transcript is the revision', async () => {
    const onRecorded = vi.fn()
    const rec = await startCapture({ onRecorded })

    await act(async () => { rec.deliverFinal('three', 0) })
    expect(screen.getByTestId('mic-live-transcript').textContent).toContain('three')

    // Chrome REVISES a settled slot when an enunciated pause makes it finalise early — the
    // "bitter" → "bitter melon" shape from BUG-VOICEDUPE-003, measured again on device as
    // "three" → "three counts" 195 ms later.
    await act(async () => { rec.deliverFinal('three counts', 0) })

    // This consumer appends every final it is handed with no dedup of its own (line 178), so if the
    // wrapper emitted the revision the line would read "three three counts". Suppressing that emit
    // is the load-bearing half of the -003 fix, and this is the only place it is observable from a
    // consumer's own DOM.
    const live = screen.getByTestId('mic-live-transcript').textContent
    expect(live).not.toContain('three three')
    expect(live).toContain('three')

    // ...and the value that actually gets stored is the revision, not the prefix: onEnd adopts
    // transcribe.js's slot-joined finalTranscript wholesale (line 201), which is right even when it
    // is SHORTER than what this component appended.
    fireEvent.click(screen.getByTestId('mic-capture-button'))
    await flush()

    expect(onRecorded).toHaveBeenCalledTimes(1)
    expect(onRecorded.mock.calls[0][0].transcript).toBe('three counts')
    expect(onRecorded.mock.calls[0][0].transcriptSource).toBe('web-speech')
  })
})
