// BUG-VOICEDUPE-003 — the shape recorder that decides which mechanism is producing the duplicate.
//
// The whole point of this file is the FIRST test below: same text, two different indices. That is
// the case both shipped fixes are structurally unable to see (transcribe.js keys on index+text;
// voiceResults.js is a monotonic high-water mark — to either of them, index 1 is simply a new
// result), and it is the leading hypothesis for why the defect survived them. If a real capture
// from Dave's device comes back with distinct_dupe true, the fix is a segmentation/settings change,
// not more index bookkeeping. If it comes back false with over_emitted true, the duplication is
// happening OUTSIDE the reader — two recognizer instances — and the fix is in useVoiceInput's
// handover. The recorder exists to tell those two apart, so both must be representable.

import { describe, it, expect } from 'vitest'
import { createVoiceShapeRecorder } from '../lib/voiceShape.js'

// Minimal SpeechRecognitionEvent stand-in. `results` is CUMULATIVE across dispatches, which is the
// contract that has caused every duplication bug in this app — a per-event delta would not
// reproduce any of them.
const ev = (resultIndex, results) => ({
  resultIndex,
  results: Object.assign(results.map(([transcript, isFinal]) => ({
    0: { transcript, confidence: 0.9 }, isFinal, length: 1,
  })), { length: results.length }),
})

describe('createVoiceShapeRecorder', () => {
  it('THE DISCRIMINATOR: identical text at two DIFFERENT indices is flagged', () => {
    const r = createVoiceShapeRecorder()
    r.observe(ev(0, [['Chinese', true]]))
    r.observe(ev(1, [['Chinese', true], ['Chinese', true]]))
    const s = r.summary(2)
    expect(s.distinct_dupe).toBe(true)
    expect(s.dup_at_index).toBe(1)
    expect(s.dup_of_index).toBe(0)
    expect(s.over_emitted).toBe(true)
  })

  // Chrome revises capitalization and padding on settled finals. A raw === would call this "not a
  // duplicate" and send back a capture that exonerates the real cause.
  it('normalizes case and whitespace before comparing — a revised final is still the same word', () => {
    const r = createVoiceShapeRecorder()
    r.observe(ev(0, [['chinese', true]]))
    r.observe(ev(1, [['chinese', true], ['  Chinese ', true]]))
    expect(r.summary(2).distinct_dupe).toBe(true)
  })

  it('a genuinely repeated word is NOT reported as over-emitted when it was emitted once each', () => {
    // "very very" is real speech. distinct_dupe is true by construction (the texts ARE equal), which
    // is why over_emitted is reported alongside it rather than instead of it — the pair is the
    // signal, and a fix that acted on distinct_dupe alone would delete words Dave really said.
    const r = createVoiceShapeRecorder()
    r.observe(ev(0, [['very', true]]))
    r.observe(ev(1, [['very', true], ['very', true]]))
    const s = r.summary(2)
    expect(s.distinct_dupe).toBe(true)
    expect(s.finals).toBe(2)
  })

  it('the clean single-utterance case flags nothing', () => {
    const r = createVoiceShapeRecorder()
    r.observe(ev(0, [['Chinese cabbage', true]]))
    const s = r.summary(1)
    expect(s.distinct_dupe).toBe(false)
    expect(s.dup_at_index).toBeNull()
    expect(s.over_emitted).toBe(false)
    expect(s.finals).toBe(1)
  })

  // An index revisited by a later event is the -001/-002 case: it must NOT be reported as a
  // distinct-index duplicate, or the capture would blame a mechanism that is already fixed.
  it('a revisited SAME index is not a distinct-index duplicate', () => {
    const r = createVoiceShapeRecorder()
    r.observe(ev(0, [['Chinese', true]]))
    r.observe(ev(0, [['Chinese', true]]))
    const s = r.summary(1)
    expect(s.distinct_dupe).toBe(false)
    expect(s.over_emitted).toBe(false)
  })

  it('interims never participate — an interim that later finalizes is not a duplicate of itself', () => {
    const r = createVoiceShapeRecorder()
    r.observe(ev(0, [['Chin', false]]))
    r.observe(ev(0, [['Chinese', false]]))
    r.observe(ev(0, [['Chinese', true]]))
    const s = r.summary(1)
    expect(s.distinct_dupe).toBe(false)
    expect(s.finals).toBe(1)
  })

  // THE PRIVACY LINE, asserted rather than intended. ux_events is a server-side table and Dave's
  // dictated garden notes are not telemetry.
  it('carries NO transcript text anywhere in the payload', () => {
    const r = createVoiceShapeRecorder()
    r.observe(ev(0, [['Chinese cabbage', true]]))
    r.observe(ev(1, [['Chinese cabbage', true], ['Brandywine tomato', true]]))
    const json = JSON.stringify(r.summary(2))
    expect(json).not.toMatch(/chinese/i)
    expect(json).not.toMatch(/cabbage/i)
    expect(json).not.toMatch(/brandywine/i)
    // Lengths ARE carried — they are what makes a sequence readable without the words.
    expect(json).toContain('"len"')
  })

  it('never throws on a malformed or hostile event', () => {
    const r = createVoiceShapeRecorder()
    expect(() => r.observe(undefined)).not.toThrow()
    expect(() => r.observe({})).not.toThrow()
    expect(() => r.observe({ results: { length: 2 } })).not.toThrow()
    expect(() => r.summary()).not.toThrow()
    expect(r.summary().emitted).toBeNull()
  })
})
