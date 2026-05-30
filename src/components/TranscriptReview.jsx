import React, { useEffect, useMemo, useRef, useState } from 'react'
import { P } from '../lib/constants.js'
import { setTranscript, incrementTranscribeAttempt, TRANSCRIPT_SOURCE } from '../lib/captureQueue.js'
import {
  isTranscriptionSupported,
  startLiveTranscription,
  START_TIMEOUT_MS,
  NO_SPEECH_TIMEOUT_MS,
} from '../lib/transcribe.js'

/**
 * src/components/TranscriptReview.jsx
 *
 * Bite 5: per-capture transcript review surface. Renders inline inside
 * FieldCapture's queue list when a user taps an audio capture to expand it.
 *
 * Two transcript paths:
 *   1. MANUAL (always available). Textarea pre-populated with any existing
 *      transcript; "Type what you said" placeholder otherwise. Save commits
 *      via captureQueue.setTranscript({source: 'manual'}).
 *   2. LIVE WEB SPEECH (conditional). If isTranscriptionSupported(), a "Speak
 *      it now" button starts a live recognition session. Interim results
 *      stream into the textarea; final results commit on stop. iOS silent
 *      failure (the start watchdog firing) and no-speech timeout both flip
 *      the surface to the manual-fallback message and increment
 *      transcribeAttempts.
 *
 * State (5 visually-distinct values, color-INDEPENDENT per V100 §7):
 *   - 'idle'             : not transcribing, textarea editable
 *   - 'transcribing'     : Web Speech live recognition active
 *   - 'transcribed'      : transcript saved to queue (just now)
 *   - 'silent-fallback'  : Web Speech .start() never fired any event;
 *                          surface explains "couldn't transcribe -- type it"
 *   - 'failed'           : Web Speech denied / no-device / no-speech / failed
 *
 * Each state surfaces distinct text labels + button-disabled + ARIA roles +
 * data-state attribute, NEVER color alone.
 *
 * Operational surface, not reward. No celebrations / badges / streaks.
 *
 * Props:
 *   entry            (required) -- the queue record
 *   onTranscriptSaved (optional) -- fired after a successful setTranscript
 *   onError          (optional) -- fired on captureQueue errors with the code
 *   isTranscriptionSupported (optional, test-only) -- inject for deterministic
 *                                                    test of the Web Speech CTA
 *
 * For text entries (kind === 'text'), the textarea pre-populates with the
 * original text; Save converts it into a transcript (status -> 'transcribed',
 * transcriptSource='manual'). This matches the design that text-tap captures
 * and audio captures both end up as transcript-text by handoff time.
 */
export default function TranscriptReview({
  entry,
  onTranscriptSaved,
  onError,
  isTranscriptionSupported: isSupportedInjected,
}) {
  const isAudio = entry?.kind === 'audio'
  const seedTranscript = entry?.transcript || (isAudio ? '' : (entry?.text || ''))

  const [draft,    setDraft]    = useState(seedTranscript)
  const [state,    setState]    = useState(entry?.status === 'transcribed' ? 'transcribed' : 'idle')
  const [feedback, setFeedback] = useState(null)
  const [saving,   setSaving]   = useState(false)

  const liveHandleRef = useRef(null)
  const audioUrlRef   = useRef(null)

  const supported = useMemo(() => {
    if (typeof isSupportedInjected === 'function') return isSupportedInjected()
    return isTranscriptionSupported()
  }, [isSupportedInjected])

  // Audio playback URL — only for kind='audio' with a Blob.
  const audioUrl = useMemo(() => {
    if (!isAudio || !entry?.blob) return null
    try {
      const url = URL.createObjectURL(entry.blob)
      audioUrlRef.current = url
      return url
    } catch {
      return null
    }
  }, [isAudio, entry?.blob])

  useEffect(() => {
    return () => {
      if (audioUrlRef.current) {
        try { URL.revokeObjectURL(audioUrlRef.current) } catch {}
        audioUrlRef.current = null
      }
      if (liveHandleRef.current) {
        try { liveHandleRef.current.cancel() } catch {}
        liveHandleRef.current = null
      }
    }
  }, [])

  function stateLabel() {
    switch (state) {
      case 'transcribing':    return 'Listening... speak now. Tap stop when done.'
      case 'transcribed':     return 'Transcript saved.'
      case 'silent-fallback': return 'Couldn’t transcribe -- type what you said below.'
      case 'failed':          return feedback || 'Voice transcription failed. Type it below.'
      default:                return null
    }
  }

  async function handleSave() {
    if (saving) return
    const text = draft.trim()
    if (text.length === 0) {
      setFeedback('Add a transcript before saving.')
      return
    }
    setSaving(true)
    setFeedback(null)
    try {
      await setTranscript({ id: entry.id, transcript: text, source: TRANSCRIPT_SOURCE.MANUAL })
      setState('transcribed')
      setFeedback('Saved.')
      if (typeof onTranscriptSaved === 'function') onTranscriptSaved(entry.id)
    } catch (e) {
      const code = typeof e === 'string' ? e : 'failed'
      setFeedback(
        code === 'quota'       ? 'Storage is full. Transcript not saved.'
      : code === 'unavailable' ? 'Storage unavailable on this device. Transcript not saved.'
                               : 'Could not save the transcript.'
      )
      if (typeof onError === 'function') onError(code)
    } finally {
      setSaving(false)
    }
  }

  // Live Web Speech transcription. MUST be invoked synchronously in the click
  // handler frame -- no awaited boundary before startLiveTranscription -- so
  // iOS honors the user-activation gesture.
  function handleSpeakItNow() {
    if (state === 'transcribing') return
    setFeedback(null)
    setState('transcribing')

    let accumulated = ''
    liveHandleRef.current = startLiveTranscription({
      languageCode:      'en-US',
      startTimeoutMs:    START_TIMEOUT_MS,
      noSpeechTimeoutMs: NO_SPEECH_TIMEOUT_MS,
      onResult: ({ transcript, isFinal }) => {
        if (isFinal) {
          accumulated = (accumulated + ' ' + transcript).trim()
          setDraft(accumulated)
        } else {
          // Interim — preview in textarea but don't commit yet.
          const preview = (accumulated + ' ' + transcript).trim()
          setDraft(preview)
        }
      },
      onError: (code) => {
        liveHandleRef.current = null
        // Count this as an attempt for visibility.
        incrementTranscribeAttempt(entry.id).catch(() => {})
        if (code === 'silent-failure') {
          setState('silent-fallback')
          setFeedback(null)
        } else if (code === 'denied') {
          setState('failed')
          setFeedback('Mic permission denied. Type what you said below.')
        } else if (code === 'no-speech') {
          setState('failed')
          setFeedback('Didn’t hear anything. Try again or type it below.')
        } else if (code === 'unavailable') {
          setState('failed')
          setFeedback('Voice transcription not available on this device. Type it below.')
        } else if (code === 'aborted') {
          // User stopped before any error — go back to idle without complaining.
          setState((s) => (s === 'transcribing' ? 'idle' : s))
        } else {
          setState('failed')
          setFeedback('Voice transcription failed. Type it below.')
        }
      },
      onEnd: ({ finalTranscript }) => {
        liveHandleRef.current = null
        if (finalTranscript && finalTranscript.length > 0) {
          setDraft((cur) => cur || finalTranscript)
        }
        // Settle to idle so the user can edit + save.
        setState((s) => (s === 'transcribing' ? 'idle' : s))
      },
    })
  }

  function handleStop() {
    if (liveHandleRef.current) {
      try { liveHandleRef.current.stop() } catch {}
      liveHandleRef.current = null
    }
  }

  const isTranscribing = state === 'transcribing'
  const saveDisabled = saving || isTranscribing || draft.trim().length === 0
  const showSpeakNow = isAudio && supported && state !== 'transcribing' && state !== 'transcribed'
  const showStopNow  = isTranscribing

  return (
    <div
      data-testid="transcript-review"
      data-entry-id={entry?.id}
      data-state={state}
      style={{
        marginTop: 8,
        padding: 12,
        background: P.cream,
        border: `1px solid ${P.border}`,
        borderRadius: 8,
        display: 'flex', flexDirection: 'column', gap: 10,
      }}
    >
      <div style={{ fontSize: '0.85rem', fontWeight: 600, color: P.dark }}>
        {isAudio ? 'Review voice capture' : 'Review note'}
      </div>

      {isAudio && audioUrl && (
        <audio
          data-testid="transcript-audio-playback"
          controls
          preload="metadata"
          src={audioUrl}
          style={{ width: '100%' }}
        />
      )}

      {stateLabel() !== null && (
        <div
          data-testid="transcript-state-label"
          role={state === 'failed' || state === 'silent-fallback' ? 'alert' : 'status'}
          style={{
            fontSize: '0.82rem',
            color: state === 'failed' || state === 'silent-fallback' ? P.terra : P.light,
            fontWeight: state === 'failed' || state === 'silent-fallback' ? 600 : 500,
          }}
        >
          {stateLabel()}
        </div>
      )}

      <label
        htmlFor={`tr-draft-${entry?.id}`}
        style={{ fontSize: '0.78rem', color: P.light, marginBottom: -4 }}
      >
        {isAudio ? 'Transcript (type what you said)' : 'Note'}
      </label>
      <textarea
        id={`tr-draft-${entry?.id}`}
        data-testid="transcript-draft"
        value={draft}
        onChange={(e) => { setDraft(e.target.value); if (state === 'transcribed') setState('idle') }}
        placeholder={isAudio ? 'Type what you said…' : 'Edit your note…'}
        rows={3}
        disabled={isTranscribing}
        style={{
          width: '100%',
          padding: 8,
          fontSize: '0.92rem',
          color: P.dark,
          background: '#fff',
          border: `1px solid ${P.border}`,
          borderRadius: 6,
          resize: 'vertical',
          minHeight: 80,
        }}
      />

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {showSpeakNow && (
          <button
            type="button"
            data-testid="transcript-speak-now"
            onClick={handleSpeakItNow}
            disabled={isTranscribing}
            style={{
              padding: '8px 14px',
              fontSize: '0.88rem',
              fontWeight: 600,
              color: P.dark,
              background: '#fff',
              border: `1px solid ${P.terra}`,
              borderRadius: 6,
              cursor: 'pointer',
              minHeight: 44,
            }}
          >
            Speak it now
          </button>
        )}

        {showStopNow && (
          <button
            type="button"
            data-testid="transcript-stop"
            onClick={handleStop}
            style={{
              padding: '8px 14px',
              fontSize: '0.88rem',
              fontWeight: 600,
              color: '#fff',
              background: P.terra,
              border: `1px solid ${P.terra}`,
              borderRadius: 6,
              cursor: 'pointer',
              minHeight: 44,
            }}
          >
            Stop
          </button>
        )}

        <button
          type="button"
          data-testid="transcript-save"
          onClick={handleSave}
          disabled={saveDisabled}
          style={{
            padding: '8px 14px',
            fontSize: '0.88rem',
            fontWeight: 600,
            color: '#fff',
            background: saveDisabled ? P.light : P.terra,
            border: `1px solid ${saveDisabled ? P.light : P.terra}`,
            borderRadius: 6,
            cursor: saveDisabled ? 'not-allowed' : 'pointer',
            minHeight: 44,
            marginLeft: 'auto',
          }}
        >
          {state === 'transcribed' ? 'Saved' : 'Save transcript'}
        </button>
      </div>

      {feedback !== null && state !== 'silent-fallback' && state !== 'failed' && (
        <div
          data-testid="transcript-feedback"
          role="status"
          style={{ fontSize: '0.78rem', color: P.light }}
        >
          {feedback}
        </div>
      )}

      <div style={{ fontSize: '0.72rem', color: P.light }}>
        Attempts: {(entry?.transcribeAttempts || 0)}
        {entry?.transcribedAt ? ` · Last saved ${formatRelative(entry.transcribedAt)}` : null}
      </div>
    </div>
  )
}

function formatRelative(iso) {
  try {
    const ms = Date.now() - new Date(iso).getTime()
    if (ms < 60_000) return 'just now'
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
    if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
    return `${Math.floor(ms / 86_400_000)}d ago`
  } catch {
    return ''
  }
}
