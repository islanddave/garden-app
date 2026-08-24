// BUG-VOICEDUPE-002 — transcribe.js against realistic Android Chrome RAW event sequences.
//
// The existing transcribe.test.js models results as a FRESH single-element list with resultIndex
// pinned to 0 (its own `fireResult` helper), which is not a shape the browser ever dispatches. The
// sequences here are cumulative and index-accurate.
//
// SCOPE NOTE. The conclusive BUG-VOICEDUPE-002 defect lives in EventNew.jsx's own recognizer (see
// EventNew.voiceDupe.test.jsx) and is FIXED. This file additionally CHARACTERIZES two residual
// blind spots in transcribe.js's `${index}:${text}` dedupe. They are deliberately NOT fixed:
// distinguishing "the recognizer repeated itself" from "Dave said it twice" is not decidable from
// the code, only from a real device capture. Enable /admin/voice-debug, dictate, and read the
// sequence before touching them — a second unverifiable fix is worse than none.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

import { startLiveTranscription } from '../lib/transcribe.js'
import { setVoiceDebugEnabled, readVoiceDebugLog } from '../lib/voiceDebug.js'

class FakeSR {
  constructor() {
    this.lang = ''
    this.interimResults = false
    this.continuous = false
    this.maxAlternatives = 1
    this.onstart = null; this.onresult = null; this.onerror = null; this.onend = null
    this.started = false; this.stopped = false; this.aborted = false
    FakeSR.instances.push(this)
  }
  start() { this.started = true }
  stop()  { this.stopped = true }
  abort() { this.aborted = true }

  // RAW dispatch: `items` is the CUMULATIVE session list; `resultIndex` is the first CHANGED result.
  emit(resultIndex, items) {
    const results = items.map((it) => {
      const r = [{ transcript: it.text, confidence: it.confidence ?? 0.9 }]
      r.isFinal = !!it.final
      return r
    })
    results.length = items.length
    if (this.onresult) this.onresult({ resultIndex, results })
  }
}
FakeSR.instances = []

function session() {
  window.SpeechRecognition = FakeSR
  const onResult = vi.fn()
  const onEnd = vi.fn()
  startLiveTranscription({ onResult, onEnd, startTimeoutMs: 0, noSpeechTimeoutMs: 0 })
  const sr = FakeSR.instances.at(-1)
  sr.onstart()
  return { sr, onResult, onEnd }
}

const finalText = (onEnd) => onEnd.mock.calls[0][0].finalTranscript

beforeEach(() => {
  FakeSR.instances = []
  localStorage.clear()
  delete window.SpeechRecognition
  delete window.webkitSpeechRecognition
})
afterEach(() => { delete window.SpeechRecognition })

describe('transcribe.js — realistic Android Chrome cadence', () => {
  it('requests continuous + interim results (the config that makes results cumulative)', () => {
    const { sr } = session()
    expect(sr.continuous).toBe(true)
    expect(sr.interimResults).toBe(true)
  })

  it('interim→final promotion at the SAME index: one final, interims streamed, no duplication', () => {
    const { sr, onEnd, onResult } = session()
    sr.emit(0, [{ text: 'watered', final: false }])
    sr.emit(0, [{ text: 'watered the', final: false }])
    sr.emit(0, [{ text: 'watered the tomatoes', final: false }])
    sr.emit(0, [{ text: 'watered the tomatoes', final: true }])
    sr.onend()
    expect(finalText(onEnd)).toBe('watered the tomatoes')
    expect(onResult.mock.calls.map((c) => c[0]).filter((r) => r.isFinal)).toHaveLength(1)
  })

  it('multi-utterance session: the cumulative list re-presents settled finals without re-counting', () => {
    const { sr, onEnd } = session()
    sr.emit(0, [{ text: 'watered the tomatoes', final: true }])
    sr.emit(1, [
      { text: 'watered the tomatoes', final: true },
      { text: 'and the be', final: false },
    ])
    sr.emit(1, [
      { text: 'watered the tomatoes', final: true },
      { text: 'and the beans', final: true },
    ])
    sr.onend()
    expect(finalText(onEnd)).toBe('watered the tomatoes and the beans')
  })

  it('a final trailed by a fresh interim in the SAME event emits both, final once', () => {
    const { sr, onResult, onEnd } = session()
    sr.emit(0, [
      { text: 'checked the leeks', final: true },
      { text: 'they look', final: false },
    ])
    sr.onend()
    const emitted = onResult.mock.calls.map((c) => c[0])
    expect(emitted.filter((r) => r.isFinal).map((r) => r.transcript)).toEqual(['checked the leeks'])
    expect(emitted.filter((r) => !r.isFinal).map((r) => r.transcript)).toEqual(['they look'])
    expect(finalText(onEnd)).toBe('checked the leeks')
  })

  it('a verbatim re-delivery of an identical final is dropped (BUG-VOICEDUPE-001, still holding)', () => {
    const { sr, onEnd } = session()
    sr.emit(0, [{ text: 'aphids on the kale', final: true }])
    sr.emit(0, [{ text: 'aphids on the kale', final: true }])
    sr.onend()
    expect(finalText(onEnd)).toBe('aphids on the kale')
  })
})

// ── BUG-VOICEDUPE-003 — the revision shape, FIXED ──────────────────────────────────────────────
// These were CHARACTERIZATION tests pinning the live bug, deferred pending a device capture. Dave's
// 2026-08-24 report ("bitter melon" → "bitter bitter melon", worse when he enunciates) is that
// capture by symptom shape, so the first one is flipped to the desired behavior per its own note.
// results[i] is now a SLOT: a revision REPLACES it and the transcript is re-joined from the slots,
// so nothing the user said is dropped — which was -001's stated reason for not keying on index.
describe('transcribe.js — a revised final replaces its slot (BUG-VOICEDUPE-003)', () => {
  it('a REVISED final at the same index replaces it instead of appending', () => {
    // Chrome rewrites settled finals (capitalization, punctuation, "six"→"6") and re-dispatches the
    // index. Slot 0 is revised; slot 1 is new. Both survive, neither doubles.
    const { sr, onEnd } = session()
    sr.emit(0, [{ text: 'harvested six beans', final: true }])
    sr.emit(0, [
      { text: 'Harvested 6 beans.', final: true },
      { text: 'and two peppers', final: true },
    ])
    sr.onend()
    expect(finalText(onEnd)).toBe('Harvested 6 beans. and two peppers')
  })

  it("an extended revision of the first segment does not double the first word", () => {
    // Dave's literal report. The enunciated pause is what makes Chrome finalize "bitter" as its own
    // result before the phrase is done, creating the settled slot it then revises.
    const { sr, onEnd } = session()
    sr.emit(0, [{ text: 'bitter', final: false }])
    sr.emit(0, [{ text: 'bitter', final: true }])
    sr.emit(0, [{ text: 'bitter melon', final: true }])
    sr.onend()
    expect(finalText(onEnd)).toBe('bitter melon')
  })

  it('does NOT re-emit a revised slot through onResult (consumers append blindly)', () => {
    // The load-bearing half. MicCaptureButton and TranscriptReview append every isFinal they are
    // handed, so a fix confined to finalTranscript would leave the visible field duplicated.
    const { sr, onResult } = session()
    sr.emit(0, [{ text: 'bitter', final: true }])
    sr.emit(0, [{ text: 'bitter melon', final: true }])
    const finals = onResult.mock.calls.map((c) => c[0]).filter((r) => r.isFinal).map((r) => r.transcript)
    expect(finals).toEqual(['bitter'])
  })

  it('still drops a byte-identical re-delivery of the same slot', () => {
    const { sr, onEnd, onResult } = session()
    sr.emit(0, [{ text: 'bitter melon', final: true }])
    sr.emit(0, [{ text: 'bitter melon', final: true }])
    sr.onend()
    expect(finalText(onEnd)).toBe('bitter melon')
    expect(onResult.mock.calls.map((c) => c[0]).filter((r) => r.isFinal)).toHaveLength(1)
  })
})

// ── CHARACTERIZATION — current behavior, NOT desired behavior ──────────────────────────────────
// One residual duplication path remains, deliberately NOT fixed: it is indistinguishable from
// speech Dave genuinely repeated, and dropping it would delete real words to remove fake ones —
// exactly the trade BUG-VOICEDUPE-001's key was chosen to avoid. The slot model does not reach it,
// because the two deliveries land on genuinely different indices.
describe('transcribe.js — residual blind spot: repeat at a NEW index (characterization)', () => {
  it('CHARACTERIZATION: the same text re-emitted at a NEW index is counted twice', () => {
    // An on-device recognizer restart can replay the tail of an utterance at a fresh index. Indices
    // differ, so neither an index key nor an index+text key suppresses it — and it is byte-identical
    // to a user who really did say the word twice.
    const { sr, onEnd } = session()
    sr.emit(0, [{ text: 'check the beans', final: true }])
    sr.emit(1, [
      { text: 'check the beans', final: true },
      { text: 'check the beans', final: true },
    ])
    sr.onend()
    expect(finalText(onEnd)).toBe('check the beans check the beans')
  })
})

describe('transcribe.js — BUG-VOICEDUPE-002 instrumentation', () => {
  it('records nothing while the debug flag is off', () => {
    const { sr } = session()
    sr.emit(0, [{ text: 'silent', final: true }])
    sr.onend()
    expect(readVoiceDebugLog()).toEqual([])
  })

  it('captures the raw event stream and the lifecycle marks when the flag is on', () => {
    setVoiceDebugEnabled(true)
    const { sr } = session()
    sr.emit(0, [{ text: 'watered the', final: false }])
    sr.emit(0, [
      { text: 'watered the tomatoes', final: true },
      { text: 'and', final: false },
    ])
    sr.onend()

    const log = readVoiceDebugLog()
    expect(log.map((e) => e.kind)).toEqual(['start', 'result', 'result', 'end'])
    expect(log.every((e) => e.src === 'transcribe')).toBe(true)
    expect(log[2]).toMatchObject({
      resultIndex: 0,
      len: 2,
      results: [
        { i: 0, final: true,  text: 'watered the tomatoes' },
        { i: 1, final: false, text: 'and' },
      ],
    })
    expect(log[3].detail).toContain('watered the tomatoes')
  })

  it('honours a caller-supplied debugLabel so a capture names its surface', () => {
    setVoiceDebugEnabled(true)
    window.SpeechRecognition = FakeSR
    startLiveTranscription({ debugLabel: 'FieldCapture', startTimeoutMs: 0, noSpeechTimeoutMs: 0 })
    const sr = FakeSR.instances.at(-1)
    sr.onstart()
    sr.emit(0, [{ text: 'x', final: true }])
    expect(readVoiceDebugLog().every((e) => e.src === 'FieldCapture')).toBe(true)
  })

  it('records the mapped error code so a failed dictation is still diagnosable', () => {
    setVoiceDebugEnabled(true)
    const { sr } = session()
    sr.onerror({ error: 'no-speech' })
    const err = readVoiceDebugLog().find((e) => e.kind === 'error')
    expect(err.detail).toBe('no-speech')
  })
})
