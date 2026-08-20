import React, { useEffect, useRef, useState } from 'react'
import { P } from '../lib/constants.js'
import { startRecording, isAudioCaptureSupported } from '../lib/audioCapture.js'
import { startLiveTranscription, isTranscriptionSupported } from '../lib/transcribe.js'

/**
 * src/components/MicCaptureButton.jsx
 *
 * Bite 4: REAL audio capture wired in.
 * Bite 7 (one-pass capture): Web Speech live transcription fires ALONGSIDE the
 *   MediaRecorder, in the SAME user-activation frame as the tap. The user speaks
 *   ONCE — audio blob AND transcript are captured together (Dave 2026-05-31:
 *   "There is no reason to record twice.").
 *
 * Bite 7.1 race fix: MediaRecorder.stop() resolves on the next tick, but Web
 *   Speech flushes its final result + onend asynchronously (cloud round-trip).
 *   Reading the transcript at recorder-stop time loses the final → empty
 *   transcript every time. We instead (a) accumulate interim+final continuously
 *   so liveTranscriptRef always holds the latest text, and (b) gate the emit on
 *   BOTH the blob being ready AND the recognizer being done (onEnd/onError),
 *   with a 1.5s safety cap so a hung recognizer never blocks the capture.
 *
 * iOS landmine: BOTH getUserMedia (inside startRecording) AND
 * webkitSpeechRecognition.start() (inside startLiveTranscription) require the
 * user-activation gesture. We invoke BOTH synchronously in the click handler
 * with NO awaited boundary between them. If Web Speech fails (silent-failure,
 * denied, no-speech, unavailable), recording STILL succeeds; the entry queues
 * without a transcript and TranscriptReview's "Speak it now" stays the redo path.
 *
 * Two-tap model (glove tolerance):
 *   tap 1 → start recording + start live transcription
 *   tap 2 → stop both → { blob, mime, durationMs, transcript, transcriptSource }
 *
 * Color-independent state per V100 §7.
 * States: idle | recording | unsupported | denied | no-device | failed.
 *
 * Props:
 *   - onRecorded({blob, mime, durationMs, transcript, transcriptSource})
 *   - onError(code)
 *   - onRecordingChange(bool)  fires on every idle↔recording flip
 *   - queuedCount   number
 *   - oldestAgeMs   number | null
 *   - disabled      boolean
 */

function formatAge(ms) {
  if (!ms || ms < 0) return null
  const m = Math.floor(ms / 60000)
  if (m >= 60) { const h = Math.floor(m / 60); return `${h}h` }
  if (m >= 1)  return `${m}m`
  const s = Math.floor(ms / 1000)
  return `${s}s`
}

function formatElapsed(ms) {
  const total = Math.floor(ms / 1000)
  const mm = String(Math.floor(total / 60)).padStart(2, '0')
  const ss = String(total % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

const RECOGNIZER_FLUSH_CAP_MS = 1500

export default function MicCaptureButton({
  onRecorded,
  onError,
  onRecordingChange,
  queuedCount = 0,
  oldestAgeMs = null,
  disabled = false,
}) {
  const [state, setState]       = useState('idle')      // idle | recording | unsupported | denied | no-device | failed
  const [elapsedMs, setElapsed] = useState(0)
  const [liveText, setLiveText] = useState('')   // interim transcript shown during recording
  const handleRef               = useRef(null)
  const tickRef                 = useRef(null)
  const startedAtRef            = useRef(0)

  // Bite 7: live-transcription handle + accumulators for the current capture.
  const liveHandleRef     = useRef(null)
  const liveTranscriptRef = useRef('')   // best-so-far transcript (never shrinks)
  const finalTextRef      = useRef('')   // confirmed final segments only
  const interimRef        = useRef('')   // latest interim (in-progress) segment

  // Bite 7.1: emit coordination — emit only when blob ready AND recognizer done.
  const blobRef        = useRef(null)
  const blobReadyRef   = useRef(false)
  const recogDoneRef   = useRef(true)    // true when no recognizer is running
  const emittedRef     = useRef(false)
  const recogTimerRef  = useRef(null)

  // One-shot capability probe on mount (no permission prompt — just feature detection).
  useEffect(() => {
    if (!isAudioCaptureSupported()) setState('unsupported')
  }, [])

  // V4-DIRTYGUARDSWEEP-001 — report idle↔recording out to the page. A live recording exists ONLY
  // inside this component: nothing reaches captureQueue until maybeEmit fires onRecorded, so the
  // hosting page cannot hold the SW reload gate over it without being told. Reported rather than
  // derived because `state` is internal — the alternative is the page reading data-state off the
  // DOM. No cleanup-to-false: FieldCapture renders this unconditionally, so the only unmount is the
  // page's own, and its gate effect releases the key there anyway.
  useEffect(() => {
    if (onRecordingChange) onRecordingChange(state === 'recording')
  }, [state, onRecordingChange])

  // Recording elapsed-time ticker.
  useEffect(() => {
    if (state !== 'recording') return
    tickRef.current = setInterval(() => {
      setElapsed(Date.now() - startedAtRef.current)
    }, 250)
    return () => { if (tickRef.current) clearInterval(tickRef.current) }
  }, [state])

  // Cancel any in-flight recognition + timer on unmount.
  useEffect(() => {
    return () => {
      if (liveHandleRef.current) {
        try { liveHandleRef.current.cancel() } catch {}
        liveHandleRef.current = null
      }
      if (recogTimerRef.current) { clearTimeout(recogTimerRef.current); recogTimerRef.current = null }
    }
  }, [])

  function cancelLive() {
    if (liveHandleRef.current) {
      try { liveHandleRef.current.cancel() } catch {}
      liveHandleRef.current = null
    }
    if (recogTimerRef.current) { clearTimeout(recogTimerRef.current); recogTimerRef.current = null }
  }

  // Emit the recording once BOTH the blob is ready and the recognizer has flushed.
  function maybeEmit() {
    if (emittedRef.current) return
    if (!blobReadyRef.current || !recogDoneRef.current) return
    emittedRef.current = true
    if (recogTimerRef.current) { clearTimeout(recogTimerRef.current); recogTimerRef.current = null }
    handleRef.current = null
    setState('idle')
    setElapsed(0)
    const transcript = (liveTranscriptRef.current || '').trim()
    const result = blobRef.current || {}
    const enriched = transcript.length > 0
      ? { ...result, transcript, transcriptSource: 'web-speech' }
      : { ...result, transcript: '', transcriptSource: null }
    liveTranscriptRef.current = ''
    finalTextRef.current = ''
    interimRef.current = ''
    setLiveText('')
    blobRef.current = null
    blobReadyRef.current = false
    if (onRecorded) onRecorded(enriched)
  }

  // Bite 7: start live transcription in the SAME synchronous frame as the tap.
  // Best-effort — failures are swallowed; the recorded audio remains source of
  // truth and the review-time "Speak it now" redo covers misses.
  function startLiveCapture() {
    liveTranscriptRef.current = ''
    finalTextRef.current = ''
    interimRef.current = ''
    setLiveText('')
    if (!isTranscriptionSupported()) { recogDoneRef.current = true; return }
    recogDoneRef.current = false
    try {
      liveHandleRef.current = startLiveTranscription({
        languageCode: 'en-US',
        debugLabel: 'FieldCapture:mic',   // BUG-VOICEDUPE-002 — names this surface in /admin/voice-debug
        onResult: ({ transcript, isFinal }) => {
          // Confirmed segments append to finalText; the in-progress segment lives
          // in interimRef and is REPLACED by its final when it lands. The combined
          // view = finalText + current interim. Critically, a trailing interim that
          // never finalizes is preserved (the empty-transcript bug was dropping it).
          if (isFinal) {
            if (transcript) finalTextRef.current = (finalTextRef.current + ' ' + transcript).trim()
            interimRef.current = ''
          } else {
            interimRef.current = transcript || ''
          }
          liveTranscriptRef.current = (finalTextRef.current + ' ' + interimRef.current).trim()
          setLiveText(liveTranscriptRef.current)   // show words as the user speaks
        },
        onError: () => {
          // Web Speech failure does NOT block recording. Keep whatever text we
          // already captured; mark recognizer done so the capture can emit.
          liveHandleRef.current = null
          recogDoneRef.current = true
          maybeEmit()
        },
        onEnd: ({ finalTranscript }) => {
          // transcribe.js's finalTranscript holds only finalized segments. If it's
          // ahead of our accumulated finals, adopt it; otherwise keep ours + any
          // trailing interim (so an unfinalized last phrase is never lost).
          const ft = (finalTranscript || '').trim()
          if (ft.length > finalTextRef.current.length) finalTextRef.current = ft
          liveTranscriptRef.current = (finalTextRef.current + ' ' + interimRef.current).trim()
          liveHandleRef.current = null
          recogDoneRef.current = true
          maybeEmit()
        },
      })
    } catch {
      liveHandleRef.current = null
      recogDoneRef.current = true
    }
  }

  // CRITICAL: do NOT await before invoking startRecording / startLiveTranscription.
  // iOS requires both getUserMedia and recognition.start() to live in the same
  // user-activation frame as the tap. We invoke both synchronously here.
  function handleClick() {
    if (disabled) return
    if (state === 'recording') {
      stopAndEmit()
      return
    }
    if (state === 'unsupported') return

    if (state !== 'idle') setState('idle')

    // Reset emit-coordination state for this capture.
    emittedRef.current = false
    blobReadyRef.current = false
    blobRef.current = null

    // Synchronous invocation in the user-activation frame — BOTH APIs, no await
    // between them. startRecording() returns a promise; startLiveTranscription()
    // is fully synchronous (calls recognition.start() inline).
    const p = startRecording()
    startLiveCapture()

    p.then((handle) => {
      handleRef.current = handle
      startedAtRef.current = Date.now()
      setElapsed(0)
      setState('recording')
    }).catch((code) => {
      // Recording failed to start — abandon the live recognizer too.
      cancelLive()
      recogDoneRef.current = true
      const errCode = (typeof code === 'string') ? code : 'failed'
      setState(errCode === 'denied' ? 'denied'
              : errCode === 'no-device' ? 'no-device'
              : errCode === 'unavailable' ? 'unsupported'
              : 'failed')
      if (onError) onError(errCode)
    })
  }

  function stopAndEmit() {
    const h = handleRef.current

    // Stop the recognizer (if running) and wait for its onEnd/onError to flush
    // the final transcript — gated by maybeEmit + a safety cap.
    if (liveHandleRef.current) {
      try { liveHandleRef.current.stop() } catch { recogDoneRef.current = true }
      if (recogTimerRef.current) clearTimeout(recogTimerRef.current)
      recogTimerRef.current = setTimeout(() => {
        recogTimerRef.current = null
        recogDoneRef.current = true
        maybeEmit()
      }, RECOGNIZER_FLUSH_CAP_MS)
    } else {
      recogDoneRef.current = true
    }

    if (!h) { setState('idle'); return }

    h.stop().then((result) => {
      blobRef.current = result
      blobReadyRef.current = true
      maybeEmit()
    }).catch((code) => {
      handleRef.current = null
      cancelLive()
      setState('failed')
      setElapsed(0)
      liveTranscriptRef.current = ''
      finalTextRef.current = ''
      if (onError) onError(typeof code === 'string' ? code : 'failed')
    })
  }

  // --- Render config (per state) -----------------------------------------
  const isRecording = state === 'recording'
  const isError     = state === 'denied' || state === 'no-device' || state === 'failed' || state === 'unsupported'

  const bg = isRecording ? P.terra
            : isError    ? P.light
            : disabled   ? P.light
            : P.terra
  const icon = isRecording ? '⏹' : '🎤'
  const primaryLabel =
      state === 'idle'        ? 'Tap to capture'
    : state === 'recording'   ? 'Recording… Tap to stop'
    : state === 'unsupported' ? 'Mic unavailable'
    : state === 'denied'      ? 'Mic permission denied'
    : state === 'no-device'   ? 'No microphone found'
                              : 'Capture failed — tap to retry'
  const ariaLabel =
      state === 'idle'        ? 'Start voice capture'
    : state === 'recording'   ? 'Stop voice capture'
    : state === 'unsupported' ? 'Voice capture unavailable'
                              : 'Voice capture error — tap to retry'

  const hasQueue = queuedCount > 0
  const ageText  = hasQueue ? formatAge(oldestAgeMs) : null

  return (
    <div data-testid="mic-capture-root" data-state={state} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        data-testid="mic-capture-button"
        data-state={state}
        onClick={handleClick}
        disabled={disabled || state === 'unsupported'}
        aria-label={ariaLabel}
        style={{
          width: 128, height: 128, borderRadius: '50%',
          background: bg,
          color: P.white,
          border: `4px solid ${P.white}`,
          boxShadow: (disabled || isError)
            ? 'none'
            : isRecording
              ? `0 4px 16px rgba(0,0,0,0.25), 0 0 0 4px ${P.white}, 0 0 0 8px ${P.terra}, 0 0 0 12px rgba(183,83,42,0.35)`
              : `0 4px 16px rgba(0,0,0,0.25), 0 0 0 4px ${P.terra}`,
          cursor: (disabled || state === 'unsupported') ? 'not-allowed' : 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '3.5rem', lineHeight: 1,
          padding: 0,
          fontFamily: 'inherit',
        }}
      >
        <span aria-hidden="true">{icon}</span>
      </button>

      {/* Always-visible label — color-independent state per V100 §7. */}
      <div
        data-testid="mic-capture-label"
        style={{
          marginTop: 12, textAlign: 'center',
          fontSize: '1rem', fontWeight: 700, color: P.dark,
        }}
      >
        {primaryLabel}
      </div>

      {/* Recording elapsed-time counter (numeric, not color-coded). */}
      {isRecording && (
        <div
          data-testid="mic-capture-elapsed"
          aria-live="polite"
          style={{
            marginTop: 4, textAlign: 'center',
            fontSize: '0.92rem', fontVariantNumeric: 'tabular-nums',
            color: P.terra, fontWeight: 600,
          }}
        >
          {formatElapsed(elapsedMs)}
        </div>
      )}

      {/* Live transcript — words appear as the user speaks (confirms capture,
          self-diagnosing if the recognizer is silent). */}
      {isRecording && liveText && (
        <div
          data-testid="mic-live-transcript"
          aria-live="polite"
          style={{
            marginTop: 8, maxWidth: 320, textAlign: 'center',
            fontSize: '0.9rem', color: P.dark, fontStyle: 'italic',
            lineHeight: 1.3,
          }}
        >
          “{liveText}”
        </div>
      )}

      {/* Error-state secondary hint (text-only; no color reliance). */}
      {state === 'denied' && (
        <div data-testid="mic-capture-error-hint" style={{
          marginTop: 4, textAlign: 'center', fontSize: '0.82rem', color: P.light,
        }}>
          Enable microphone in browser settings.
        </div>
      )}

      {/* Queued-count badge — numeric + below-text "queued". */}
      {hasQueue && (
        <div
          data-testid="mic-queued-count"
          // role="img" (V4-A11YGATE-001) — a role-less div is role=generic and drops the label, so
          // this badge announced the bare count. Deliberately NOT role="status": a live region here
          // would interrupt on every queue change, which is the opposite of what this UI wants.
          role="img"
          aria-label={`${queuedCount} ${queuedCount === 1 ? 'capture' : 'captures'} queued`}
          style={{
            position: 'absolute', top: -4, right: -4,
            minWidth: 32, height: 32, borderRadius: 16,
            background: P.gold, color: P.white,
            border: `3px solid ${P.cream}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '0.85rem', fontWeight: 700,
            padding: '0 8px',
          }}
        >
          {queuedCount}
        </div>
      )}

      {hasQueue && (
        <div
          data-testid="mic-queued-summary"
          style={{
            marginTop: 6, textAlign: 'center',
            fontSize: '0.8rem', color: P.light,
          }}
        >
          {queuedCount} {queuedCount === 1 ? 'capture' : 'captures'} queued
          {ageText ? `, oldest ${ageText}` : ''}
        </div>
      )}
    </div>
  )
}
