import React, { useEffect, useMemo, useRef, useState } from 'react'
import { P } from '../lib/constants.js'
import {
  setTranscript,
  incrementTranscribeAttempt,
  markHandedOff,
  TRANSCRIPT_SOURCE,
} from '../lib/captureQueue.js'
import {
  isTranscriptionSupported,
  startLiveTranscription,
  START_TIMEOUT_MS,
  NO_SPEECH_TIMEOUT_MS,
} from '../lib/transcribe.js'
import { assembleFromEntry } from '../lib/helperPrompt.js'
import { deliverPrompt } from '../lib/sendCapture.js'

/**
 * src/components/TranscriptReview.jsx
 *
 * Bite 5: per-capture transcript review surface (audio playback, manual textarea,
 *   conditional "Speak it now" live Web Speech CTA, manual save via setTranscript).
 * Bite 6: "Send to Claude" CTA closes the loop — assembles a Rung-1 helper prompt
 *   from the entry (transcript or text) via helperPrompt.assembleFromEntry, then
 *   runs the navigator.share -> clipboard -> manual-copy fallback chain (reused
 *   byte-for-byte from Bite 1's GardenHelper.jsx). On success, captureQueue
 *   markHandedOff(id) is called so the entry transitions out of the unprocessed
 *   queue.
 *
 * State machine (6 color-INDEPENDENT values per V100 §7):
 *   - 'idle'              : not transcribing, textarea editable
 *   - 'transcribing'      : Web Speech live recognition active
 *   - 'transcribed'       : transcript saved to queue (just now)
 *   - 'silent-fallback'   : Web Speech .start() never fired any event
 *   - 'failed'            : Web Speech denied / no-device / no-speech / failed
 *   - 'handed-off'        : Bite 6 — prompt successfully shared or copied to clipboard
 *
 * Operational surface, not reward. No celebrations / badges / streaks.
 *
 * Props:
 *   entry             (required)  -- the queue record
 *   onTranscriptSaved (optional)  -- fired after a successful setTranscript
 *   onHandedOff       (optional)  -- fired after a successful markHandedOff (Bite 6)
 *   onError           (optional)  -- fired on captureQueue / share errors with the code
 *   isTranscriptionSupported (optional, test-only) -- inject for deterministic test
 */
export default function TranscriptReview({
  entry,
  onTranscriptSaved,
  onHandedOff,
  onError,
  isTranscriptionSupported: isSupportedInjected,
}) {
  const isAudio = entry?.kind === 'audio'
  const seedTranscript = entry?.transcript || (isAudio ? '' : (entry?.text || ''))
  const initialHandedOff = entry?.status === 'handed_off'

  const [draft,    setDraft]    = useState(seedTranscript)
  const [state,    setState]    = useState(
    initialHandedOff             ? 'handed-off'
  : entry?.status === 'transcribed' ? 'transcribed'
                                 : 'idle'
  )
  const [feedback,    setFeedback]    = useState(null)
  const [saving,      setSaving]      = useState(false)
  const [sending,     setSending]     = useState(false)
  const [sendStatus,  setSendStatus]  = useState(null)  // 'shared' | 'copied' | 'manual' | 'error'

  const liveHandleRef = useRef(null)
  const audioUrlRef   = useRef(null)

  const supported = useMemo(() => {
    if (typeof isSupportedInjected === 'function') return isSupportedInjected()
    return isTranscriptionSupported()
  }, [isSupportedInjected])

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
      case 'handed-off':      return 'Sent to Claude. Paste into Claude when you’re ready.'
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

  function handleSpeakItNow() {
    if (state === 'transcribing') return
    setFeedback(null)
    setState('transcribing')

    let accumulated = ''
    liveHandleRef.current = startLiveTranscription({
      languageCode:      'en-US',
      debugLabel:        'TranscriptReview:speak',   // BUG-VOICEDUPE-002 — names this surface in /admin/voice-debug
      startTimeoutMs:    START_TIMEOUT_MS,
      noSpeechTimeoutMs: NO_SPEECH_TIMEOUT_MS,
      onResult: ({ transcript, isFinal }) => {
        if (isFinal) {
          accumulated = (accumulated + ' ' + transcript).trim()
          setDraft(accumulated)
        } else {
          const preview = (accumulated + ' ' + transcript).trim()
          setDraft(preview)
        }
      },
      onError: (code) => {
        liveHandleRef.current = null
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

  /**
   * Bite 6: Send to Claude. Assembles a Helper Prompt from the entry (or the
   * current draft if the user is composing manually) and runs the share/clipboard
   * fallback chain from Bite 1. On success, marks the queue entry handed_off so
   * the field-capture queue depth drops by one.
   */
  async function handleSendToClaude() {
    if (sending) return
    setSendStatus(null)

    // Always use the textarea draft as source of truth. It's seeded from entry.transcript
    // (or entry.text) on mount, so the initial state captures whatever was saved. User edits
    // move the draft, and Send uses what's visible in the textarea -- no silent divergence.
    const text = (draft ?? '').toString().trim()
    if (text.length === 0) {
      setSendStatus('error')
      setFeedback('Add a transcript first, then send.')
      return
    }
    // Build the prompt from the latest content (use draft if user edited but hasn't saved).
    const sendEntry = { ...entry, transcript: text }
    const prompt = assembleFromEntry(sendEntry)
    if (!prompt) {
      setSendStatus('error')
      setFeedback('Nothing to send.')
      return
    }

    setSending(true)
    setFeedback(null)

    // Bite 7: the share -> clipboard chain lives in sendCapture.deliverPrompt
    // (shared with FieldCapture's tile-level Send-to-Claude — one copy, no drift).
    const { delivered, deliveredAs } = await deliverPrompt(prompt)

    // Manual-copy fallback — surface the prompt in feedback so user can long-press copy.
    //    Not "delivered" in the success sense but not "error" either — the user can act.
    if (!delivered) {
      setSendStatus('manual')
      setFeedback('Could not share or copy automatically. Long-press the textarea to copy your transcript and paste it into Claude.')
      setSending(false)
      return
    }

    // Mark handed_off so the queue depth drops + the entry transitions out of unprocessed.
    try {
      await markHandedOff(entry.id)
      setState('handed-off')
      setSendStatus(deliveredAs)
      if (typeof onHandedOff === 'function') onHandedOff(entry.id)
    } catch (e) {
      // Delivery succeeded but state-update failed. Surface as advisory; don't undo the share.
      const code = typeof e === 'string' ? e : 'failed'
      setSendStatus(deliveredAs)
      setFeedback(`Sent — but couldn’t update the queue (${code}). You may see this entry again until storage recovers.`)
      if (typeof onError === 'function') onError(code)
    } finally {
      setSending(false)
    }
  }

  const isTranscribing = state === 'transcribing'
  const isHandedOff = state === 'handed-off'
  const saveDisabled = saving || isTranscribing || isHandedOff || draft.trim().length === 0
  const showSpeakNow = isAudio && supported && state !== 'transcribing' && state !== 'transcribed' && !isHandedOff
  const showStopNow  = isTranscribing
  // Send-to-Claude visible whenever there is any content to send AND not currently handed-off.
  const hasContent = (draft ?? '').toString().trim().length > 0
  const showSendToClaude = hasContent && !isTranscribing && !isHandedOff
  const sendDisabled = sending || !hasContent

  const sendStatusLabel =
      sendStatus === 'shared' ? 'Shared — pick Claude to continue.'
    : sendStatus === 'copied' ? 'Copied — paste into Claude.'
    : sendStatus === 'manual' ? null  // feedback already explains the manual path
    : sendStatus === 'error'  ? null
    :                            null

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
        onChange={(e) => { setDraft(e.target.value); if (state === 'transcribed') setState('idle'); setSendStatus(null) }}
        placeholder={isAudio ? 'Type what you said…' : 'Edit your note…'}
        rows={3}
        disabled={isTranscribing || isHandedOff}
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
          }}
        >
          {state === 'transcribed' ? 'Saved' : 'Save transcript'}
        </button>

        {showSendToClaude && (
          <button
            type="button"
            data-testid="transcript-send-to-claude"
            onClick={handleSendToClaude}
            disabled={sendDisabled}
            aria-label="Send to Claude"
            style={{
              padding: '8px 14px',
              fontSize: '0.88rem',
              fontWeight: 700,
              color: '#fff',
              background: sendDisabled ? P.light : '#2d6a4f',
              border: `1px solid ${sendDisabled ? P.light : '#2d6a4f'}`,
              borderRadius: 6,
              cursor: sendDisabled ? 'not-allowed' : 'pointer',
              minHeight: 44,
              marginLeft: 'auto',
            }}
          >
            {sending ? 'Sending…' : 'Send to Claude'}
          </button>
        )}
      </div>

      {sendStatusLabel !== null && (
        <div
          data-testid="transcript-send-status"
          role="status"
          style={{ fontSize: '0.82rem', color: '#2d6a4f', fontWeight: 600 }}
        >
          {sendStatusLabel}
        </div>
      )}

      {feedback !== null
        && state !== 'silent-fallback'
        && state !== 'failed'
        && sendStatus !== 'manual'
        && (
        <div
          data-testid="transcript-feedback"
          role="status"
          style={{ fontSize: '0.78rem', color: P.light }}
        >
          {feedback}
        </div>
      )}

      {sendStatus === 'manual' && feedback !== null && (
        <div
          data-testid="transcript-manual-fallback"
          role="alert"
          style={{ fontSize: '0.82rem', color: P.terra, fontWeight: 600 }}
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
