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

// BUG-VOICEDUPE-005 — THE HIGH-WATER MARK DOES NOT COVER THE ENGINE ECHO, and this reader is the one
// path in the app that had no guard for it at all.
//
// The mark makes it impossible to read the SAME index twice. The echo the 2026-08-27 device run timed
// does not land on the same index — it lands on the NEXT one, 272 ms later, where a fresh slot is
// above the mark and passes straight through. Three of this reader's four call sites APPEND what they
// receive (`f.notes ? f.notes + ' ' + text : text`, EventNew.jsx), so the echo becomes a doubled word
// in the field. `transcribe.js` grew a bounded cross-slot guard for exactly this in BUG-VOICEDUPE-004;
// this reader never got one, because -004 was scoped to the surfaces that go through that wrapper and
// this is the one that does not.
//
// Dave reports the doubling on the PICKER, which is a transcribe.js surface — so this is not the
// defect he is looking at. It is the same defect on a path nobody has reported yet, found while
// tracing his, and left in only if we decide a known duplicate is fine because no one has complained.
//
// SAME RULE, SAME BOUND, deliberately: identical comparison key and identical 600 ms window as
// transcribe.js, imported rather than re-derived so the two cannot drift apart. Outside the window a
// repeat is real speech and is kept.
import { DUPLICATE_ECHO_WINDOW_MS, echoKey } from './transcribe.js'

export function createFinalResultReader({ now = () => Date.now() } = {}) {
  let nextIndex = 0
  let lastFinal = null   // { key, at } — echoKey of the most recent NON-EMPTY final emitted, and when

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
      // The mark advances either way. A dropped echo is CONSUMED, not deferred — leaving the index
      // below the mark would let the next event re-offer it and re-open the hole from the other side.
      nextIndex = i + 1
      if (!text) continue
      const key = echoKey(text)
      const at = now()
      if (lastFinal && lastFinal.key === key && (at - lastFinal.at) <= DUPLICATE_ECHO_WINDOW_MS) continue
      lastFinal = { key, at }
      out.push(text)
    }
    return out
  }
}
