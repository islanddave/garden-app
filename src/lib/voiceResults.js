// src/lib/voiceResults.js — BUG-VOICEDUPE-002.
//
// The Web Speech contract that every duplication bug in this app has come from:
//
//   * `SpeechRecognitionEvent.results` is a CUMULATIVE SpeechRecognitionResultList for the whole
//     recognition session. It GROWS. It is not a delta and it is not per-event.
//   * `event.resultIndex` is "the lowest index value result that has actually CHANGED" — the first
//     CHANGED result, NOT the first NEW one. A result that already finalized can be revisited by a
//     later event (Chrome revises capitalization/punctuation/number formatting on finals), and when
//     it is, resultIndex points AT it.
//
// Consequence: any handler that reads a fixed index (`e.results[0]`) or that re-walks from
// `resultIndex` and APPENDS what it finds will emit the same words more than once. That is exactly
// "duplicated words the user did not say", and it is cadence-dependent — which is why it reproduces
// often but not always.
//
// createFinalResultReader() is the monotonic reader that makes duplication structurally impossible:
// it keeps a high-water mark and only ever emits results at indices it has never emitted before.
// resultIndex is deliberately NOT used as the loop's lower bound — it can point BACKWARDS at an
// already-consumed result, and honoring it there is the bug.
//
// Interim results are never emitted and never advance the high-water mark: an index holding a
// non-final result may still finalize, so consuming it would both duplicate (interim then final)
// and commit text the recognizer had not settled on.

export function createFinalResultReader() {
  let nextIndex = 0

  return function readNewFinals(event) {
    const results = (event && event.results) || []
    const len = (typeof results.length === 'number') ? results.length : 0
    const out = []
    for (let i = nextIndex; i < len; i++) {
      const r = results[i]
      // A hole or a still-interim result: stop. Advancing past either would let a later
      // finalization at this index be read a second time, or be skipped entirely.
      if (!r || !r[0]) break
      if (!r.isFinal) break
      const text = String(r[0].transcript || '').trim()
      if (text) out.push(text)
      nextIndex = i + 1
    }
    return out
  }
}
