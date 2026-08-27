// src/__tests__/helpers/fakeSpeechRecognition.js
//
// V5-HARVESTVOICEFLOW-001 (BD-068) — a fake SpeechRecognition that models THE RE-ARM LOOP.
//
// Gate B4 in build plan V101 exists because two fakes already live in this suite and NEITHER models
// `onend` → `start()` → `onstart`. The device probe proved that loop is the DOMINANT path on Chrome
// Android — the recogniser ends a session after every utterance and re-arms in 16–133 ms — so a fake
// without it cannot exercise any behaviour that spans an utterance boundary, which is all of the
// interesting ones: cross-session duplicates, a write command held past a session end, the cooldown.
//
// This is not yet the shared fake B4 asks for (the five start-paths still each need converting to
// it); it is the one the S0 host test needs, put where a shared one would live.
//
// SHAPE FIDELITY. Chrome delivers the WHOLE accumulated result list on every event with
// `resultIndex` pointing at the first changed entry, and a revised or re-delivered final lands at the
// SAME index — that pair is the entire VOICEDUPE signature, so `deliverFinal` takes an explicit index
// and defaults to appending. The list resets per session, which is exactly why transcribe.js's
// per-session slot guard cannot see a duplicate that crosses a boundary.

const makeResult = (transcript, isFinal) =>
  Object.assign([{ transcript, confidence: 0.9 }], { isFinal })

export class FakeSpeechRecognition {
  constructor() {
    this.continuous = false
    this.interimResults = false
    this.maxAlternatives = 1
    this.lang = ''
    this.started = false
    this.startCount = 0
    this._results = []
    FakeSpeechRecognition.instances.push(this)
  }

  start() {
    // The real thing throws InvalidStateError on a double start; a host that leaks one recogniser
    // and arms another should fail loudly in a test rather than quietly double-listen.
    if (this.started) throw new Error('InvalidStateError: recognition already started')
    this.started = true
    this.startCount += 1
    this._results = []
    this.onstart?.({})
  }

  stop() { this._end() }

  abort() { this._end() }

  _end() {
    if (!this.started) return
    this.started = false
    this.onend?.({})
  }

  /** End the session the way Chrome does after a silence window — the host decides whether to re-arm. */
  endSession() { this._end() }

  /**
   * Deliver a final result. `index` defaults to appending; pass an explicit index to model a
   * revision or a byte-identical re-delivery at the same slot.
   */
  deliverFinal(transcript, index = null) {
    const i = index == null ? this._results.length : index
    this._results[i] = makeResult(transcript, true)
    this.onresult?.({ resultIndex: i, results: this._results.slice() })
  }

  deliverInterim(transcript, index = null) {
    const i = index == null ? this._results.length : index
    this._results[i] = makeResult(transcript, false)
    this.onresult?.({ resultIndex: i, results: this._results.slice() })
  }

  deliverError(error) { this.onerror?.({ error }) }
}

FakeSpeechRecognition.instances = []

/** Install on window and hand back the live instance list. Pair with `vi.unstubAllGlobals()`. */
export function installFakeSpeechRecognition(vi) {
  FakeSpeechRecognition.instances = []
  vi.stubGlobal('SpeechRecognition', FakeSpeechRecognition)
  vi.stubGlobal('webkitSpeechRecognition', FakeSpeechRecognition)
  return {
    instances: FakeSpeechRecognition.instances,
    latest: () => FakeSpeechRecognition.instances[FakeSpeechRecognition.instances.length - 1],
  }
}
