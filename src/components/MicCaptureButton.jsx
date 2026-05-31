import React, { useEffect, useRef, useState } from 'react'
import { P } from '../lib/constants.js'
import { startRecording, isAudioCaptureSupported } from '../lib/audioCapture.js'
import { startLiveTranscription, isTranscriptionSupported } from '../lib/transcribe.js'

/**
 * src/components/MicCaptureButton.jsx
 *
 * Bite 4: REAL audio capture wired in.
 * Bite 7 (one-pass capture): Web Speech live transcription now fires ALONGSIDE
 *   the MediaRecorder, in the SAME user-activation frame as the tap. The user
 *   speaks ONCE — both the audio blob AND a live transcript are captured. This
 *   replaces the Bite 5/6 "record, then re-speak into Web Speech at review time"
 *   flow (Dave 2026-05-31: "There is no reason to record twice.").
 *
 * iOS landmine: BOTH getUserMedia (inside startRecording) AND
 * webkitSpeechRecognition.start() (inside startLiveTranscription) require the
 * user-activation gesture. We invoke BOTH synchronously in the click handler
 * with NO awaited boundary between them. If Web Speech silently fails (iOS
 * silent-failure, denied, no-speech, unavailable), recording STILL succeeds;
 * the entry queues without a transcript and TranscriptReview's "Speak it now"
 * stays as the redo fallback.
 *
 * Two-tap model (glove tolerance):
 *   tap 1 → start recording + start live transcription
 *   tap 2 → stop both → { blob, mime, durationMs, transcript, transcriptSource }
 *           handed to onRecorded.
 *
 * Color-independent state per V100 §7: every state surfaces ICON + LABEL
 * + visible ring/border. Color is one of three signals, never the only one.
 *
 * States: idle | recording | unsupported | denied | no-device | failed.
 *
 * Props:
 *   - onRecorded({blob, mime, durationMs, transcript, transcriptSource})
 *   - onError(code)
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

export default function MicCaptureButton({
  onRecorded,
  onError,
  queuedCount = 0,
  oldestAgeMs = null,
  disabled = false,
}) {
  const [state, setState]       = useState('idle')      // idle | recording | unsupported | denied | no-device | failed
  const [elapsedMs, setElapsed] = useState(0)
  const handleRef               = useRef(null)
  const tickRef                 = useRef(null)
  const startedAtRef            = useRef(0)

  // Bite 7: live-transcription handle + accumulator for the current capture.
  const liveHandleRef     = useRef(null)
  const liveTranscriptRef = useRef('')

  // One-shot capability probe on mount (no permission prompt — just feature detection).
  useEffect(() => {
    if (!isAudioCaptureSupported()) setState('unsupported')
  }, [])

  // Recording elapsed-time ticker.
  useEffect(() => {
    if (state !== 'recording') return
    tickRef.current = setInterval(() => {
      setElapsed(Date.now() - startedAtRef.current)
    }, 250)
    return () => { if (tickRef.current) clearInterval(tickRef.current) }
  }, [state])

  // Cancel any in-flight live recognition on unmount.
  useEffect(() => {
    return () => {
      if (liveHandleRef.current) {
        try { liveHandleRef.current.cancel() } catch {}
        liveHandleRef.current = null
      }
    }
  }, [])

  function cancelLive() {
    if (liveHandleRef.current) {
      try { liveHandleRef.current.cancel() } catch {}
      liveHandleRef.current = null
    }
  }

  // Bite 7: start live transcription in the SAME synchronous frame as the tap.
  // Best-effort — any failure is swallowed here; the recorded audio remains the
  // source of truth and the review-time "Speak it now" redo covers misses.
  function startLiveCapture() {
    liveTranscriptRef.current = ''
    if (!isTranscriptionSupported()) return
    try {
      liveHandleRef.current = startLiveTranscription({
        languageCode: 'en-US',
        onResult: ({ transcript, isFinal }) => {
          if (isFinal && transcript) {
            liveTranscriptRef.current = (liveTranscriptRef.current + ' ' + transcript).trim()
          }
        },
        onError: () => {
          // Web Speech failure does NOT block recording. Drop the handle and
          // leave whatever transcript accumulated (possibly empty).
          liveHandleRef.current = null
        },
        onEnd: ({ finalTranscript }) => {
          if (finalTranscript && finalTranscript.length > liveTranscriptRef.current.length) {
            liveTranscriptRef.current = finalTranscript.trim()
          }
          liveHandleRef.current = null
        },
      })
    } catch {
      liveHandleRef.current = null
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

    // Reset transient error states so the button is clickable again
    if (state !== 'idle') setState('idle')

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
    // Stop live transcription first (sync). Transcript already accumulated in
    // liveTranscriptRef via onResult; onEnd may append a final flush.
    if (liveHandleRef.current) {
      try { liveHandleRef.current.stop() } catch {}
      liveHandleRef.current = null
    }
    if (!h) { setState('idle'); return }
    h.stop().then((result) => {
      handleRef.current = null
      setState('idle')
      setElapsed(0)
      const transcript = (liveTranscriptRef.current || '').trim()
      const enriched = transcript.length > 0
        ? { ...result, transcript, transcriptSource: 'web-speech' }
        : { ...result, transcript: '', transcriptSource: null }
      liveTranscriptRef.current = ''
      if (onRecorded) onRecorded(enriched)
    }).catch((code) => {
      handleRef.current = null
      liveTranscriptRef.current = ''
      setState('failed')
      setElapsed(0)
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
