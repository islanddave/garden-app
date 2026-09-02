// TranscriptReview × the REAL transcribe.js — gate B3.
//
// TranscriptReview.test.jsx and TranscriptReview.handoff.test.jsx both `vi.mock` ../lib/transcribe.js
// down to a stub that captures its callbacks, so both are structurally blind to the wrapper: the
// duplicate-suppression rules could all be deleted and neither file would move. This is the
// non-mocked half, driving the real wrapper over the SHARED fake recogniser (gate B4).
//
// WHAT THIS SURFACE MAKES OBSERVABLE that no other consumer does: handleSpeakItNow accumulates
// `accumulated = (accumulated + ' ' + transcript).trim()` on every final it is handed, with no dedup
// of its own, and writes the result straight into the textarea. So the textarea IS the wrapper's
// emit stream, verbatim — a duplicate that gets past transcribe.js is visible here as doubled words
// in a field Dave then saves. That is exactly the shape he reported on 2026-08-30.
//
// FAKE TIMERS ARE LOAD-BEARING, not scaffolding. The cross-slot echo guard's ONLY discriminator is
// Date.now() against DUPLICATE_ECHO_WINDOW_MS, so a test that cannot move the clock can only ever
// exercise one side of the bound — and a guard tested on one side of its threshold is a guard whose
// threshold is untested.
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { installFakeSpeechRecognition } from './helpers/fakeSpeechRecognition.js'
import { resetMicArbiter } from '../lib/micArbiter.js'

vi.mock('../lib/captureQueue.js', () => ({
  setTranscript: vi.fn(async (args) => ({ id: args.id, transcript: args.transcript })),
  incrementTranscribeAttempt: vi.fn(async () => ({ id: 'x', transcribeAttempts: 1 })),
  TRANSCRIPT_SOURCE: { MANUAL: 'manual', WEB_SPEECH: 'web-speech' },
}))

if (!global.URL.createObjectURL) global.URL.createObjectURL = () => 'blob:fake'
if (!global.URL.revokeObjectURL) global.URL.revokeObjectURL = () => {}

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

let mic

beforeEach(() => {
  vi.useFakeTimers({ now: 1_700_000_000_000 })
  resetMicArbiter()
  mic = installFakeSpeechRecognition(vi)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  resetMicArbiter()
  vi.unstubAllGlobals()
})

const draft = () => screen.getByTestId('transcript-draft').value
const advance = (ms) => act(() => { vi.advanceTimersByTime(ms) })

function speakItNow() {
  render(<TranscriptReview entry={audioEntry} />)
  act(() => { fireEvent.click(screen.getByTestId('transcript-speak-now')) })
  // Before latest(): with transcribe.js mocked away this list is empty and every assertion below
  // would run against undefined instead of failing on the behaviour it pins.
  expect(mic.instances.length, 'no recogniser was constructed — the real transcribe.js did not run').toBe(1)
  return mic.latest()
}

describe('TranscriptReview × real transcribe.js — the cross-slot echo bound', () => {
  it('drops a re-delivery at a NEW slot inside the echo window', async () => {
    const rec = speakItNow()

    act(() => { rec.deliverFinal('310 g', 0) })
    expect(draft()).toBe('310 g')

    // The device pair, timed twice: resultIndex=4 "310 G" then resultIndex=5 "310 G", 272 ms apart.
    // A new slot, so the same-slot guard cannot see it; the 600 ms window is the whole discriminator.
    advance(272)
    act(() => { rec.deliverFinal('310 g', 1) })

    expect(draft()).toBe('310 g')
  })

  it('keeps the same words spoken again OUTSIDE the window — the guard is a bound, not a ban', async () => {
    const rec = speakItNow()

    act(() => { rec.deliverFinal('310 g', 0) })
    advance(700)
    act(() => { rec.deliverFinal('310 g', 1) })

    // A deliberate repeat has to wait out a segment-closing pause first, so it lands outside the
    // window and is real speech. Widening the window would delete words Dave actually said, which is
    // precisely the objection the -004 guard had to answer before it could ship.
    expect(draft()).toBe('310 g 310 g')
  })

  it('recognises the echo through capitalisation and trailing punctuation (BUG-VOICEDUPE-005)', async () => {
    const rec = speakItNow()

    act(() => { rec.deliverFinal('bitter melon', 0) })
    advance(272)
    // Chrome does NOT re-emit byte-identically: the re-delivery arrives capitalised and with
    // sentence punctuation appended. Comparing raw bytes made the guard say "different" while the
    // trimmed join said "same" — a doubled phrase on screen, reported three days after -004 shipped.
    act(() => { rec.deliverFinal('Bitter melon.', 1) })

    expect(draft()).toBe('bitter melon')
  })
})

describe('TranscriptReview × real transcribe.js — session end', () => {
  it('a stop delivers the slot-joined transcript and returns the panel to idle', async () => {
    const rec = speakItNow()

    act(() => { rec.deliverFinal('aphids on the kale', 0) })
    expect(screen.getByTestId('transcript-stop')).toBeTruthy()

    act(() => { rec.stop() })

    // showStopNow is `state === 'transcribing'`, so the control disappearing IS the state having
    // been carried back by the wrapper's onEnd rather than left hanging on a dead recogniser.
    expect(screen.queryByTestId('transcript-stop')).toBe(null)
    expect(screen.getByTestId('transcript-speak-now')).toBeTruthy()
    expect(draft()).toBe('aphids on the kale')
  })
})

// A REVISED final is the one shape this surface cannot see through onResult, because transcribe.js
// suppresses that emit by design (the VOICEDUPE-003 fix). Before this was fixed, the corrected value
// arrived at onEnd and was DISCARDED by `setDraft((cur) => cur || finalTranscript)` — so the textarea,
// and therefore handleSave, kept the truncated prefix. A wrong SAVED value, not a display artifact.
describe('TranscriptReview × real transcribe.js — a revised final must reach the saved draft', () => {
  it('a slot revised after it finalised replaces the prefix in the textarea', async () => {
    const rec = speakItNow()

    // Chrome finalises "231" on the enunciated pause, then revises THAT SAME SLOT once the phrase
    // completes. Same index is what makes it a revision rather than new speech.
    act(() => { rec.deliverFinal('231', 0) })
    expect(draft(), 'the first final should reach the draft normally').toBe('231')

    act(() => { rec.deliverFinal('231 grams', 0) })
    // The emit IS suppressed — that is correct and deliberate, and this pins it. If this line ever
    // reads "231 grams", transcribe.js started emitting revisions and VOICEDUPE-003 is re-opened for
    // every consumer that appends.
    expect(draft(), 'the revision must NOT be emitted through onResult').toBe('231')

    act(() => { rec.endSession() })

    // ...and this is the fix: onEnd's finalTranscript is re-joined from the slots, so it carries the
    // correction, and the draft now takes it.
    expect(draft()).toBe('231 grams')
  })

  it('does NOT clobber text the user typed after speaking', async () => {
    const rec = speakItNow()

    act(() => { rec.deliverFinal('231', 0) })
    act(() => { rec.deliverFinal('231 grams', 0) })

    // The user edits the textarea before the session ends. The old `cur ||` guard existed to protect
    // exactly this, and the fix must not trade one bug for a worse one — losing typing is far worse
    // than keeping a prefix.
    act(() => {
      fireEvent.change(screen.getByTestId('transcript-draft'), { target: { value: 'my own words' } })
    })
    act(() => { rec.endSession() })

    expect(draft()).toBe('my own words')
  })

  it('refills a draft the user emptied — unchanged from the original guard', async () => {
    const rec = speakItNow()

    act(() => { rec.deliverFinal('231', 0) })
    act(() => { rec.deliverFinal('231 grams', 0) })
    act(() => {
      fireEvent.change(screen.getByTestId('transcript-draft'), { target: { value: '' } })
    })
    act(() => { rec.endSession() })

    // The `!cur` arm. This is NOT new behaviour — the original `cur || finalTranscript` refilled an
    // empty box too, so the fix neither introduces nor removes it. Pinned deliberately rather than
    // left implicit: if clearing the box should mean "discard what I said", that is a product
    // decision to take on purpose, and this test is where it would be changed.
    expect(draft()).toBe('231 grams')
  })
})
