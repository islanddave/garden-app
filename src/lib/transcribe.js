/**
 * src/lib/transcribe.js
 *
 * Bite 5 of Post-V2 UX overhaul Increment 2: Web Speech transcription wrapper.
 *
 * Wraps the browser Web Speech API (window.SpeechRecognition /
 * window.webkitSpeechRecognition) with two iOS-specific safety nets:
 *
 *   1. START WATCHDOG. iOS Safari sometimes ACCEPTS a `.start()` call without
 *      ever firing `onstart`, `onresult`, `onerror`, or `onend` — the
 *      recognition session silently no-ops. We arm a watchdog timer immediately
 *      after `.start()`; if no recognition event arrives within
 *      START_TIMEOUT_MS, we mark the session as `silent-failure` and surface
 *      the manual-text fallback. Bite 5's TranscriptReview UI consumes this
 *      code path to flip its state from "transcribing" to "couldn't transcribe
 *      — type it".
 *
 *   2. NO-SPEECH WATCHDOG. Even when iOS does dispatch events, the `no-speech`
 *      error condition is browser-divergent and sometimes never fires. A
 *      secondary timer (NO_SPEECH_TIMEOUT_MS, measured from `onstart`) ensures
 *      the caller is never left hanging on a quiet mic.
 *
 * The wrapper is intentionally LIVE-INPUT only. Web Speech does NOT consume
 * pre-recorded audio blobs — you can't feed it the IndexedDB-stored MediaRecorder
 * output. For previously-recorded captures, Rung-1 falls back to manual text
 * entry (the dominant Bite 5 path). Live transcription is wired for callers
 * that want to ask the user to repeat their note while recognition runs —
 * useful when the user is reviewing a 30-second voice memo and would rather
 * speak it cleanly into the live recognizer than type it out.
 *
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
 * Synchronous user-activation: like getUserMedia, iOS requires `.start()` in
 * the same call frame as the user gesture. Callers must invoke
 * startLiveTranscription synchronously from a click/tap handler -- NOT through
 * an awaited async boundary.
 */

import { recordVoiceEvent, recordVoiceMark } from './voiceDebug.js'

export const START_TIMEOUT_MS = 3500
export const NO_SPEECH_TIMEOUT_MS = 8000

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
  // event.results is cumulative for the session and MDN defines event.resultIndex as "the lowest
  // index value result that has actually changed" — so a correct implementation never re-reports a
  // settled final. In practice Web Speech implementations do re-deliver AND revise, which is what
  // produces Dave's "often, not always" duplication: cadence decides how results get batched.
  //
  // -001 kept a Set keyed `${index}:${text}` and appended on a miss. That suppressed only a
  // BYTE-IDENTICAL re-delivery. A REVISION of a settled slot (final@0 "bitter", then final@0
  // "bitter melon" — which is what an enunciated pause provokes, because the pause makes Chrome
  // finalize "bitter" on its own before the phrase is done) is a different key, so it fell through
  // and APPENDED: "bitter bitter melon". Dave's 2026-08-24 report is exactly that shape, and the
  // repo already knew: transcribe.rawEvents.test.js carried a passing CHARACTERIZATION test
  // asserting the duplicated string, whose comment prescribed this fix and deferred it pending a
  // device capture. The symptom shape is that capture.
  //
  // -001's stated fear — that keying on index ALONE would delete words the user really said — is
  // what the slot model answers. A revision does not drop the second delivery; it REPLACES the slot
  // and the transcript is re-joined from the slots, so the revised text wins and nothing is lost.
  // Saying the same word twice for real still lands on two different indices and is preserved.
  const finalsByIndex  = []
  let startWatchdog    = null
  let noSpeechWatchdog = null
  let started   = false
  let stopped   = false
  let cancelled = false
  let endedFired = false

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
        // Byte-identical re-delivery: not new speech, nothing changed, drop it entirely.
        if (prev === transcript) continue
        finalsByIndex[i] = transcript
        // Re-join from the slots rather than appending, so a revision REPLACES its slot instead of
        // extending the transcript. Never carries a stale prefix, because it is recomputed whole.
        finalTranscript = finalsByIndex.filter(Boolean).map((s) => s.trim()).filter(Boolean).join(' ')
        // Suppressing the emit on a REVISION is the load-bearing half. Every downstream consumer
        // appends each isFinal it receives with no dedup of its own (MicCaptureButton, and
        // TranscriptReview's accumulator), so a fix confined to finalTranscript would still
        // duplicate on the surface Dave uses. A first final at this slot still emits normally.
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

  try {
    recognition.start()
  } catch {
    clearWatchdogs()
    try { onError('failed') } catch {}
    return { stop: noop, cancel: noop }
  }

  return {
    stop() {
      if (stopped || cancelled) return
      stopped = true
      clearWatchdogs()
      try { recognition.stop() } catch {}
    },
    cancel() {
      if (stopped || cancelled) return
      cancelled = true
      clearWatchdogs()
      safeAbort()
    },
  }
}
