import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  isTranscriptionSupported,
  startLiveTranscription,
  START_TIMEOUT_MS,
  NO_SPEECH_TIMEOUT_MS,
} from '../lib/transcribe.js'

// FakeSpeechRecognition with controllable event firing.
class FakeSpeechRecognition {
  constructor() {
    this.lang = ''
    this.interimResults = false
    this.continuous = false
    this.maxAlternatives = 1
    this.onstart = null
    this.onresult = null
    this.onerror = null
    this.onend = null
    this.started = false
    this.aborted = false
    this.stopped = false
    FakeSpeechRecognition.instances.push(this)
  }
  start() {
    this.started = true
    // The fake never auto-fires onstart; tests control it explicitly.
  }
  stop() { this.stopped = true }
  abort() { this.aborted = true }
  // Test helpers
  fireStart()         { if (this.onstart) this.onstart() }
  fireResult(results) { if (this.onresult) this.onresult({ resultIndex: 0, results }) }
  // BUG-VOICEDUPE-001: the real SpeechRecognition event carries a CUMULATIVE results list for the
  // whole session, and resultIndex marks the first CHANGED result — which does not reliably advance
  // past entries that already finalized. fireResult() above models neither (fresh list, index pinned
  // to 0), which is precisely why a duplicate-final bug could not be expressed against it. This
  // helper takes the cumulative list and an explicit resultIndex so a re-delivery can be modelled.
  fireResultAt(resultIndex, results) { if (this.onresult) this.onresult({ resultIndex, results }) }
  fireError(code)     { if (this.onerror) this.onerror({ error: code }) }
  fireEnd()           { if (this.onend) this.onend() }
}
FakeSpeechRecognition.instances = []

function fakeResults(items) {
  // items: [{ transcript, isFinal, confidence }]
  return items.map((i) => {
    const alt = { transcript: i.transcript, confidence: i.confidence ?? 0.9 }
    const list = [alt]
    list.isFinal = !!i.isFinal
    return list
  })
}

describe('transcribe.js', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeSpeechRecognition.instances = []
    delete window.SpeechRecognition
    delete window.webkitSpeechRecognition
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('isTranscriptionSupported', () => {
    it('returns false when neither constructor is on window', () => {
      expect(isTranscriptionSupported()).toBe(false)
    })

    it('returns true when webkitSpeechRecognition is exposed (iOS Safari pattern)', () => {
      window.webkitSpeechRecognition = FakeSpeechRecognition
      expect(isTranscriptionSupported()).toBe(true)
    })

    it('returns true when SpeechRecognition is exposed (Chrome pattern)', () => {
      window.SpeechRecognition = FakeSpeechRecognition
      expect(isTranscriptionSupported()).toBe(true)
    })
  })

  describe('startLiveTranscription', () => {
    it('synchronously invokes onError with unavailable when no ctor is present', () => {
      const onError = vi.fn()
      const handle = startLiveTranscription({ onError })
      expect(onError).toHaveBeenCalledWith('unavailable')
      expect(typeof handle.stop).toBe('function')
      expect(typeof handle.cancel).toBe('function')
    })

    it('returns a working handle when a constructor is present', () => {
      window.SpeechRecognition = FakeSpeechRecognition
      const onError = vi.fn()
      const handle = startLiveTranscription({ onError })
      expect(onError).not.toHaveBeenCalled()
      expect(FakeSpeechRecognition.instances.length).toBe(1)
      const sr = FakeSpeechRecognition.instances[0]
      expect(sr.started).toBe(true)
      handle.cancel()
      expect(sr.aborted).toBe(true)
    })

    it('iOS silent-failure: fires onError with silent-failure when no event arrives in startTimeoutMs', () => {
      window.webkitSpeechRecognition = FakeSpeechRecognition
      const onError = vi.fn()
      startLiveTranscription({ onError, startTimeoutMs: 1000 })
      const sr = FakeSpeechRecognition.instances[0]
      // No onstart, no events. Advance time past the start watchdog.
      vi.advanceTimersByTime(1500)
      expect(onError).toHaveBeenCalledWith('silent-failure')
      expect(sr.aborted).toBe(true)
    })

    it('clears the start watchdog when onstart fires (no false silent-failure)', () => {
      window.SpeechRecognition = FakeSpeechRecognition
      const onError = vi.fn()
      startLiveTranscription({ onError, startTimeoutMs: 1000, noSpeechTimeoutMs: 0 })
      const sr = FakeSpeechRecognition.instances[0]
      sr.fireStart()
      vi.advanceTimersByTime(2000)
      expect(onError).not.toHaveBeenCalledWith('silent-failure')
    })

    it('no-speech watchdog fires after noSpeechTimeoutMs of silence post-start', () => {
      window.SpeechRecognition = FakeSpeechRecognition
      const onError = vi.fn()
      startLiveTranscription({ onError, startTimeoutMs: 5000, noSpeechTimeoutMs: 800 })
      const sr = FakeSpeechRecognition.instances[0]
      sr.fireStart()
      vi.advanceTimersByTime(900)
      expect(onError).toHaveBeenCalledWith('no-speech')
      expect(sr.aborted).toBe(true)
    })

    it('streams interim and final results via onResult, accumulating final transcript', () => {
      window.SpeechRecognition = FakeSpeechRecognition
      const onResult = vi.fn()
      const onEnd = vi.fn()
      startLiveTranscription({ onResult, onEnd, startTimeoutMs: 0, noSpeechTimeoutMs: 0 })
      const sr = FakeSpeechRecognition.instances[0]
      sr.fireStart()
      sr.fireResult(fakeResults([{ transcript: 'tomato', isFinal: false }]))
      sr.fireResult(fakeResults([{ transcript: 'tomato leaves', isFinal: true }]))
      sr.fireResult(fakeResults([{ transcript: 'curling', isFinal: true }]))
      sr.fireEnd()
      expect(onResult).toHaveBeenCalledTimes(3)
      expect(onResult.mock.calls[0][0].isFinal).toBe(false)
      expect(onResult.mock.calls[1][0].isFinal).toBe(true)
      expect(onEnd).toHaveBeenCalledTimes(1)
      expect(onEnd.mock.calls[0][0].finalTranscript).toBe('tomato leaves curling')
    })

    it('maps not-allowed error to denied', () => {
      window.SpeechRecognition = FakeSpeechRecognition
      const onError = vi.fn()
      startLiveTranscription({ onError, startTimeoutMs: 0, noSpeechTimeoutMs: 0 })
      const sr = FakeSpeechRecognition.instances[0]
      sr.fireStart()
      sr.fireError('not-allowed')
      expect(onError).toHaveBeenCalledWith('denied')
    })

    it('maps audio-capture error to unavailable', () => {
      window.SpeechRecognition = FakeSpeechRecognition
      const onError = vi.fn()
      startLiveTranscription({ onError, startTimeoutMs: 0, noSpeechTimeoutMs: 0 })
      const sr = FakeSpeechRecognition.instances[0]
      sr.fireStart()
      sr.fireError('audio-capture')
      expect(onError).toHaveBeenCalledWith('unavailable')
    })

    it('maps aborted to aborted (so the UI can decide whether to treat as a benign stop)', () => {
      window.SpeechRecognition = FakeSpeechRecognition
      const onError = vi.fn()
      startLiveTranscription({ onError, startTimeoutMs: 0, noSpeechTimeoutMs: 0 })
      const sr = FakeSpeechRecognition.instances[0]
      sr.fireStart()
      sr.fireError('aborted')
      expect(onError).toHaveBeenCalledWith('aborted')
    })

    it('stop() invokes recognition.stop() and onEnd fires once', () => {
      window.SpeechRecognition = FakeSpeechRecognition
      const onEnd = vi.fn()
      const handle = startLiveTranscription({ onEnd, startTimeoutMs: 0, noSpeechTimeoutMs: 0 })
      const sr = FakeSpeechRecognition.instances[0]
      sr.fireStart()
      handle.stop()
      expect(sr.stopped).toBe(true)
      sr.fireEnd()
      expect(onEnd).toHaveBeenCalledTimes(1)
    })

    it('cancel() suppresses onEnd', () => {
      window.SpeechRecognition = FakeSpeechRecognition
      const onEnd = vi.fn()
      const handle = startLiveTranscription({ onEnd, startTimeoutMs: 0, noSpeechTimeoutMs: 0 })
      const sr = FakeSpeechRecognition.instances[0]
      sr.fireStart()
      handle.cancel()
      sr.fireEnd()
      expect(onEnd).not.toHaveBeenCalled()
      expect(sr.aborted).toBe(true)
    })

    it('exposes the default START_TIMEOUT_MS and NO_SPEECH_TIMEOUT_MS constants', () => {
      expect(START_TIMEOUT_MS).toBeGreaterThan(0)
      expect(NO_SPEECH_TIMEOUT_MS).toBeGreaterThan(START_TIMEOUT_MS)
    })
  })
})

// BUG-VOICEDUPE-001 — Dave: voice entry "often" inserts duplicated words he did not say.
// "Often, not always" is the tell: it is cadence-dependent, which is what a re-delivered result
// looks like. event.results is CUMULATIVE for the session and event.resultIndex is the first
// CHANGED index, so an already-finalized result can be visited by more than one event. Without a
// record of which finals were consumed, each visit appends the same words again — into
// finalTranscript here AND, via onResult({isFinal:true}), into MicCaptureButton's finalTextRef,
// which appends blindly.
describe('BUG-VOICEDUPE-001 — a re-delivered final is consumed exactly once', () => {
  function startWithFake(onResult) {
    window.SpeechRecognition = FakeSpeechRecognition
    const onEnd = vi.fn()
    startLiveTranscription({ onResult, onEnd })
    const sr = FakeSpeechRecognition.instances.at(-1)
    sr.fireStart()
    return { sr, onEnd }
  }

  it('does not double-count a final that a later event re-delivers', () => {
    const onResult = vi.fn()
    const { sr, onEnd } = startWithFake(onResult)

    const first  = fakeResults([{ transcript: 'water the tomatoes', isFinal: true }])
    // cumulative list grows; index 0 is ALREADY final and is re-delivered because resultIndex
    // did not advance past it (the observed Chrome behaviour on a paused multi-utterance dictation)
    const second = fakeResults([
      { transcript: 'water the tomatoes', isFinal: true },
      { transcript: 'and the beans', isFinal: true },
    ])
    sr.fireResultAt(0, first)
    sr.fireResultAt(0, second)
    sr.fireEnd()

    const finalText = onEnd.mock.calls[0][0].finalTranscript
    expect(finalText).toBe('water the tomatoes and the beans')
    // the phrase must appear exactly once, not twice
    expect(finalText.match(/water the tomatoes/g)).toHaveLength(1)
  })

  it('emits onResult isFinal once per distinct final, so a blind appender stays correct', () => {
    const onResult = vi.fn()
    const { sr } = startWithFake(onResult)
    const list = fakeResults([{ transcript: 'harvested six', isFinal: true }])
    sr.fireResultAt(0, list)
    sr.fireResultAt(0, list)   // same index AND same text — a verbatim re-delivery, not new speech
    const finals = onResult.mock.calls.map(c => c[0]).filter(r => r.isFinal)
    expect(finals).toHaveLength(1)
  })

  it('still streams interim revisions of the SAME index freely (they replace, not accumulate)', () => {
    const onResult = vi.fn()
    const { sr, onEnd } = startWithFake(onResult)
    sr.fireResultAt(0, fakeResults([{ transcript: 'har', isFinal: false }]))
    sr.fireResultAt(0, fakeResults([{ transcript: 'harvest', isFinal: false }]))
    sr.fireResultAt(0, fakeResults([{ transcript: 'harvested', isFinal: true }]))
    sr.fireEnd()
    const interims = onResult.mock.calls.map(c => c[0]).filter(r => !r.isFinal)
    expect(interims).toHaveLength(2)              // interim updates are NOT suppressed
    expect(onEnd.mock.calls[0][0].finalTranscript).toBe('harvested')
  })
})
