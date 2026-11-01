/**
 * src/lib/transcribe.js: Web Speech transcription wrapper (live input only).
 *
 * Two iOS-specific safety nets:
 *
 *   1. START WATCHDOG. iOS Safari sometimes ACCEPTS a `.start()` without ever firing `onstart`,
 *      `onresult`, `onerror` or `onend`. A timer armed right after `.start()` marks the session
 *      `silent-failure` if no recognition event arrives within START_TIMEOUT_MS, so TranscriptReview can
 *      flip from "transcribing" to "couldn't transcribe, type it".
 *
 *   2. NO-SPEECH WATCHDOG. The `no-speech` error is browser-divergent and sometimes never fires, so a
 *      second timer (NO_SPEECH_TIMEOUT_MS, measured from `onstart`) keeps the caller from hanging on a
 *      quiet mic.
 *
 * LIVE-INPUT only: Web Speech cannot consume pre-recorded audio blobs (the IndexedDB MediaRecorder
 * output), so previously-recorded captures fall back to manual text entry.
 * Caller contract (`startLiveTranscription`):
 *   const handle = startLiveTranscription({
 *     languageCode:        'en-US',
 *     onResult:            ({ transcript, isFinal, confidence }) => {...},
 *     onError:             (code) => {...},  // 'unavailable' | 'denied' | 'silent-failure' | 'no-speech' | 'aborted' | 'failed'
 *     onEnd:               ({ finalTranscript }) => {...},
 *     startTimeoutMs:      START_TIMEOUT_MS,  // default 3500
 *     noSpeechTimeoutMs:   NO_SPEECH_TIMEOUT_MS, // default 8000
 *   })
 *   // handle.stop()    -> graceful stop, fires onEnd with accumulated transcript
 *   // handle.cancel()  -> abort without onEnd
 *
 * Synchronous user-activation: like getUserMedia, iOS requires `.start()` in the same call frame as the
 * user gesture. Call startLiveTranscription synchronously from a click/tap handler, NOT across an awaited
 * async boundary.
 */

import { recordVoiceEvent, recordVoiceMark } from './voiceDebug.js'
import { acquireMic, releaseMic } from './micArbiter.js'

export const START_TIMEOUT_MS = 3500
export const NO_SPEECH_TIMEOUT_MS = 8000

// BUG-VOICEDUPE-004: how long after a final an identical final at a DIFFERENT slot is treated as the
// engine echoing rather than the user repeating. Measured echo intervals: 272 ms and 274 ms. A deliberate
// repeat has to wait out a segment-closing pause first, so it lands far outside this. n=2 and loose
// against it on purpose; see the guard in onresult for what to revisit if a longer echo ever appears.
export const DUPLICATE_ECHO_WINDOW_MS = 600

// BUG-VOICEDUPE-005: the comparison key for the echo guard, and ONLY for the echo guard.
//
// The -004 guard compared raw transcripts with `===`, assuming Chrome re-emits an echo byte-identically.
// It does not: a continuation segment carries a LEADING SPACE, the first final of a segment is
// capitalised where a continuation is not, and sentence punctuation gets appended to a settled final. The
// string the user receives is joined from TRIMMED slots (see finalTranscript below), so each variant made
// the guard say "different" and the join say "same": a doubled word on screen.
//
// NOT NORMALISED: the value stored in the slot and handed to onResult/onEnd stay exactly what the engine
// said. This key is never written anywhere a caller can see it; a guard that rewrote the transcript would
// fix a duplicate by corrupting the data.
//
// Only a TRAILING punctuation run is stripped. Interior punctuation is load-bearing: the grammar reads
// "1.2 kilograms" as a decimal (voiceHarvestGrammar.normalise), so collapsing interior dots here would let
// two genuinely different weights compare equal.
export function echoKey(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,!?;:]+$/, '')
}

function getSpeechRecognitionCtor() {
  if (typeof window === 'undefined') return null
  return window.SpeechRecognition || window.webkitSpeechRecognition || null
}

/**
 * Synchronous probe -- returns true if the Web Speech API is exposed by the
 * runtime. Does NOT verify that .start() actually works (iOS exposes the
 * constructor without honoring it); that probe is the watchdog's job.
 */
export function isTranscriptionSupported() {
  return getSpeechRecognitionCtor() !== null
}

function noop() {}

/**
 * Start a live transcription session. Must be called synchronously in the
 * user-activation frame for iOS to honor the mic gesture.
 *
 * Returns a handle: { stop, cancel }. stop() initiates graceful shutdown and
 * triggers onEnd with the accumulated final transcript. cancel() aborts the
 * recognizer without invoking onEnd.
 *
 * If the API is unavailable, onError is invoked synchronously with
 * 'unavailable' and a no-op handle is returned.
 */
export function startLiveTranscription(opts = {}) {
  const {
    languageCode      = 'en-US',
    onResult          = noop,
    onError           = noop,
    onEnd             = noop,
    startTimeoutMs    = START_TIMEOUT_MS,
    noSpeechTimeoutMs = NO_SPEECH_TIMEOUT_MS,
    // BUG-VOICEDUPE-002: names this session in the /admin/voice-debug capture so a recorded
    // sequence can be traced back to the surface that produced it. Inert unless the flag is on.
    debugLabel        = 'transcribe',
  } = opts

  const Ctor = getSpeechRecognitionCtor()
  if (!Ctor) {
    try { onError('unavailable') } catch {}
    return { stop: noop, cancel: noop }
  }

  let recognition
  try {
    recognition = new Ctor()
  } catch {
    try { onError('failed') } catch {}
    return { stop: noop, cancel: noop }
  }

  recognition.lang            = languageCode
  recognition.interimResults  = true
  recognition.continuous      = true
  recognition.maxAlternatives = 1

  let finalTranscript  = ''
  // BUG-VOICEDUPE-003: results[i] is a SLOT that Chrome may REVISE, not a stream to append to.
  //
  // event.results is cumulative for the session and event.resultIndex is "the lowest index value result
  // that has actually changed", yet Web Speech implementations both re-deliver AND revise, depending on how
  // cadence batches results. Keying on `${index}:${text}` and appending on a miss suppressed only a
  // BYTE-IDENTICAL re-delivery: a REVISION of a settled slot (final@0 "bitter", then final@0 "bitter melon",
  // provoked by an enunciated pause) is a different key and APPENDED: "bitter bitter melon".
  // transcribe.rawEvents.test.js guards the slot behaviour.
  //
  // The fear that keying on index alone deletes words the user really said is answered by the slot model: a
  // revision REPLACES the slot and the transcript is re-joined from the slots, so the revised text wins and
  // nothing is lost.
  //
  // Qualified by -004: saying the same word twice for real still lands on two different indices and is kept
  // (a deliberate repeat has to wait out a segment-closing pause), but the engine also echoes a settled
  // final onto the next index ~272 ms later. The cross-slot guard below is bounded by that interval.
  const finalsByIndex  = []
  // Session-scoped, a real limit: a continuous flow that re-arms every 15-22 ms gets a FRESH one per
  // session, so an echo crossing a session boundary is not covered here. lib/voiceCommitDebounce.js's
  // wall-clock cooldown covers that for the consumer that needs it; this guard is for the single-capture
  // flows.
  let lastFinal = null   // { key, at } — echoKey of the most recent NON-EMPTY final, and when
  let startWatchdog    = null
  let noSpeechWatchdog = null
  let started   = false
  let stopped   = false
  let cancelled = false
  let endedFired = false
  // Assigned at .start() time, below. Declared here so the handlers attached above the acquire can
  // close over it without a temporal-dead-zone read if a watchdog ever fires early.
  let micToken  = null

  function clearWatchdogs() {
    if (startWatchdog    !== null) { clearTimeout(startWatchdog);    startWatchdog    = null }
    if (noSpeechWatchdog !== null) { clearTimeout(noSpeechWatchdog); noSpeechWatchdog = null }
  }

  function armNoSpeechWatchdog() {
    if (noSpeechTimeoutMs <= 0) return
    if (noSpeechWatchdog !== null) clearTimeout(noSpeechWatchdog)
    noSpeechWatchdog = setTimeout(() => {
      if (stopped || cancelled || endedFired) return
      clearWatchdogs()
      safeAbort()
      try { onError('no-speech') } catch {}
    }, noSpeechTimeoutMs)
  }

  function safeAbort() {
    try { recognition.abort() } catch {}
  }

  recognition.onstart = () => {
    started = true
    recordVoiceMark(debugLabel, 'start')
    if (startWatchdog !== null) { clearTimeout(startWatchdog); startWatchdog = null }
    armNoSpeechWatchdog()
  }

  recognition.onresult = (event) => {
    // BUG-VOICEDUPE-002: capture the RAW event BEFORE any interpretation, so the recorded
    // sequence is ground truth about the browser rather than about this file's reading of it.
    recordVoiceEvent(debugLabel, event)
    // Any result resets the no-speech watchdog (user is speaking).
    armNoSpeechWatchdog()
    const results = event.results || []
    for (let i = event.resultIndex || 0; i < results.length; i++) {
      const r = results[i]
      if (!r || !r[0]) continue
      const transcript = r[0].transcript || ''
      const confidence = typeof r[0].confidence === 'number' ? r[0].confidence : null
      const isFinal    = !!r.isFinal
      if (isFinal) {
        const prev = finalsByIndex[i]
        // Byte-identical re-delivery AT THE SAME SLOT: not new speech, nothing changed, drop it.
        if (prev === transcript) continue

        // ...AND THE SAME TEXT AT A NEW SLOT WITHIN A SHORT WINDOW (the engine echoing a settled final onto
        // the next index).
        //
        // With only text and index, an echo is indistinguishable from speech genuinely repeated, and dropping
        // it would delete real words (transcribe.rawEvents.test.js characterises that blind spot). The
        // discriminator is TIME. The device run timed the pair at 272 ms (an earlier run: 274 ms):
        //     9916ms  resultIndex=4 len=5   [4] FINAL "310 G"
        //    10188ms  resultIndex=5 len=6   [5] FINAL "310 G"
        // A human cannot produce a second final that fast, because the first has to END (a pause long enough
        // to close the segment) before the words can be said again. A repeat inside one breath ("very very
        // ripe") arrives as ONE final and never reaches this branch. Outside the window a repeat is real
        // speech and kept.
        //
        // CALIBRATION IS n=2 and the threshold is deliberately loose against it. If a longer engine interval
        // ever shows up in a device log, revisit this number, not the rule.
        //
        // COMPARED ON echoKey, NOT RAW BYTES (BUG-VOICEDUPE-005; see echoKey): with `===`, an echo carrying a
        // leading space, different capitalisation or trailing punctuation was not dropped and the trimmed
        // join below then duplicated it. The 600 ms bound is still the entire discriminator.
        const key = transcript ? echoKey(transcript) : ''
        if (key && lastFinal &&
            lastFinal.key === key &&
            (Date.now() - lastFinal.at) <= DUPLICATE_ECHO_WINDOW_MS) continue

        finalsByIndex[i] = transcript
        // Tracks the most recent non-empty final, which is NOT slot i-1: the device run interleaved empty
        // finals with the real ones, so i-1 is very often ''. Real speech in between replaces this, which
        // keeps two genuine identical readings either side of a different value from collapsing.
        if (transcript) lastFinal = { key, at: Date.now() }
        // Re-join from the slots rather than appending, so a revision REPLACES its slot and no stale prefix
        // survives.
        finalTranscript = finalsByIndex.filter(Boolean).map((s) => s.trim()).filter(Boolean).join(' ')
        // Suppressing the emit on a REVISION is the load-bearing half: downstream consumers
        // (MicCaptureButton, TranscriptReview's accumulator) append each isFinal with no dedup of their own,
        // so fixing only finalTranscript would still duplicate on screen. A first final at this slot still
        // emits normally.
        if (prev !== undefined) continue
      }
      try { onResult({ transcript, isFinal, confidence }) } catch {}
    }
  }

  recognition.onerror = (event) => {
    clearWatchdogs()
    const err = (event && event.error) || 'failed'
    recordVoiceMark(debugLabel, 'error', err)
    const code =
        err === 'not-allowed'          ? 'denied'
      : err === 'service-not-allowed'  ? 'denied'
      : err === 'no-speech'            ? 'no-speech'
      : err === 'aborted'              ? 'aborted'
      : err === 'audio-capture'        ? 'unavailable'
      : err === 'network'              ? 'failed'
      :                                  'failed'
    try { onError(code) } catch {}
  }

  recognition.onend = () => {
    clearWatchdogs()
    // Release before the endedFired guard: onend is the one terminus every path reaches (natural
    // end, stop(), cancel()'s abort(), and the watchdogs' abort()), and a hold that outlives its
    // recogniser is a mic no other surface can ever take. Stale-token releases no-op by design.
    releaseMic(micToken)
    if (endedFired) return
    endedFired = true
    recordVoiceMark(debugLabel, 'end', `finalTranscript=${JSON.stringify(finalTranscript)}`)
    if (cancelled) return
    try { onEnd({ finalTranscript }) } catch {}
  }

  if (startTimeoutMs > 0) {
    startWatchdog = setTimeout(() => {
      if (started || stopped || cancelled || endedFired) return
      clearWatchdogs()
      safeAbort()
      try { onError('silent-failure') } catch {}
    }, startTimeoutMs)
  }

  // Take the mic in the same frame as .start(), never at mount. Eviction uses the GRACEFUL stop, not abort:
  // the words already spoken belong to this caller's own field, and every handler here is closed over THIS
  // session, so a finalising onresult after the handover lands in the right place, not the new owner's.
  micToken = acquireMic(debugLabel, () => {
    if (stopped || cancelled) return
    stopped = true
    clearWatchdogs()
    try { recognition.stop() } catch {}
  })

  try {
    recognition.start()
  } catch {
    clearWatchdogs()
    releaseMic(micToken)
    try { onError('failed') } catch {}
    return { stop: noop, cancel: noop }
  }

  return {
    // Both paths normally release via onend. These are the belt-and-braces case: if stop()/abort()
    // throws, the engine never dispatches end and the hold would outlive the session, wedging the
    // mic for every other surface. Releasing twice is a no-op.
    stop() {
      if (stopped || cancelled) return
      stopped = true
      clearWatchdogs()
      try { recognition.stop() } catch { releaseMic(micToken) }
    },
    cancel() {
      if (stopped || cancelled) return
      cancelled = true
      clearWatchdogs()
      try { recognition.abort() } catch { releaseMic(micToken) }
    },
  }
}
